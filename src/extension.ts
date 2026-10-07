import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Api, Focus, LaunchOptions, Provider, ProviderContext, SessionEntry, SessionScope, Snapshot, WatchSpec } from './api';
import { CLAUDE_DIR, Limits, claude, parseUsageText, savePastedLimits } from './providers/claude';
import { disableLiveLimits, enableLiveLimits, liveLimitsScript, liveLimitsState, refreshLiveLimitsScript } from './providers/statusline';
import { codex } from './providers/codex';
import { norm, processParents } from './util';

/** Built-in agents. To add one: create src/providers/<agent>.ts exporting a Provider and list it here. */
const BUILT_IN: Provider[] = [claude, codex];

interface Entry {
  p: Provider;
  item: vscode.StatusBarItem;
  disposables: vscode.Disposable[];
  watchers: vscode.Disposable[];
  timer?: NodeJS.Timeout;
  seq: number;
  last?: Snapshot;
  /** Open sessions, for the usage view's per-session rows. Filled by reloadOpen, not by refresh. */
  open?: SessionEntry[];
}

const entries = new Map<string, Entry>();
let slot = 0;
const treeChanged = new vscode.EventEmitter<void>();

const pctx: ProviderContext = {
  get folders() { return (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath); },
  setting: <T>(key: string) => vscode.workspace.getConfiguration('workspaceAgentSessions').get<T>(key),
  extensionPath: id => vscode.extensions.getExtension(id)?.extensionPath,
};

/**
 * The session in the active terminal: ours are known exactly (resumed id or agent pid), an agent run in a shell by
 * its process; for any other terminal, its folder. Another agent's terminal says nothing about this provider.
 */
function focusFor(id: string): Focus | undefined {
  const t = vscode.window.activeTerminal;
  if (!t) return undefined;
  const info = launched.get(t);
  const hosted = info ? undefined : openSessions().find(x => hostTerminal(x.s.pid) === t);
  const owner = info?.e ?? hosted?.e;
  if (owner && owner.p.id !== id) return undefined;
  const opt = (t.creationOptions as vscode.TerminalOptions).cwd;
  const cwd = t.shellIntegration?.cwd?.fsPath ?? info?.cwd ?? (typeof opt === 'string' ? opt : opt?.fsPath);
  return { sessionId: info?.sessionId ?? hosted?.s.id, pid: info?.pid ?? hosted?.s.pid, cwd, startedAt: info?.at };
}

const openSessions = () => [...entries.values()].flatMap(e => (e.open ?? []).map(s => ({ e, s })));

// Providers are isolated: one failing never touches another's item.
function refresh(e: Entry) {
  const seq = ++e.seq;
  const ctx: ProviderContext = Object.create(pctx, { focus: { value: focusFor(e.p.id) } });
  Promise.resolve()
    .then(() => e.p.read(ctx))
    .catch((): Snapshot => ({ available: true, note: 'Could not read local data' }))
    .then(s => {
      if (seq !== e.seq || entries.get(e.p.id) !== e) return;
      // settings.json is watched with Claude's files: the status line may have been changed by hand.
      if (e.p.id === 'claude') syncLiveLimitsContext();
      e.last = s;
      render(e.item, e.p.name, s);
      treeChanged.fire();
    });
}
const refreshAll = () => entries.forEach(refresh);

/**
 * A terminal started new carries no session id: the agent creates one, and for Codex nothing in its files points
 * back at the process. The provider can name it from the terminal's own focus, so ask once per terminal. Without
 * it the row's close and command buttons, the click target and the delete guard would all miss a session we are
 * running ourselves. /clear or /resume in the terminal moves its process on to another session: Claude's pid record
 * names the new one, else the old row would keep the terminal (and its close button) and the status bar its numbers.
 */
function resolveLaunched() {
  for (const [t, i] of launched) {
    const now = i.pid === undefined ? undefined : i.e.open?.find(s => s.pid === i.pid);
    if (now && now.id !== i.sessionId) { i.sessionId = now.id; refresh(i.e); continue; }
    if (i.sessionId) continue;
    const ctx: ProviderContext = Object.create(pctx, { focus: { value: { pid: i.pid, cwd: i.cwd, startedAt: i.at } } });
    Promise.resolve().then(() => i.e.p.read(ctx)).then(snap => {
      if (launched.get(t) !== i || i.sessionId || !snap.sessionId) return;
      i.sessionId = snap.sessionId;
      treeChanged.fire();
    }).catch(() => { /* not identifiable yet; the next reload tries again */ });
  }
}

/**
 * Open sessions for the usage view. Kept off refresh()'s 1.5 s path on purpose: listing reads the header of every
 * transcript, so it runs on the same coalesced reload as the Projects view.
 */
function reloadOpen() {
  for (const e of entries.values()) {
    Promise.resolve()
      .then(() => e.p.listSessions?.(pctx, 'open') ?? [])
      .catch((): SessionEntry[] => [])
      .then(list => {
        if (entries.get(e.p.id) !== e) return;
        e.open = list;
        usageView.render();
        resolveLaunched();
        adoptTerminals();
      });
  }
}

/**
 * Claude Code keeps its 5h / weekly numbers in memory and hands them only to its status line (see statusline.ts).
 * Asking the API ourselves would mean using the user's Claude login from a third-party tool, which Anthropic's terms
 * do not allow. Turning this on edits Claude Code's settings.json, so it always asks first and says what it replaces.
 */
async function toggleLiveLimits() {
  const state = liveLimitsState(CLAUDE_DIR);
  const settings = path.join(CLAUDE_DIR, 'settings.json');
  const script = liveLimitsScript(CLAUDE_DIR);
  const SHOW = 'Show Script', PASTE = 'Use /usage Instead...', KEEP = 'Keep Off';
  // What runs on every reply is spelled out, and readable before anything is written.
  const what = `Script: ${script.file}\nCommand in settings.json: ${script.command}`;
  let pick: string | undefined;
  try {
    if (state === 'on') {
      pick = await vscode.window.showInformationMessage('Turn off live Claude limits?', {
        modal: true,
        detail: `Claude Code's status line in ${settings} goes back to what it was before. 5h / weekly numbers then come only from other sources and may be outdated.\n\n${what}`,
      }, 'Turn Off', SHOW);
      if (pick === 'Turn Off') {
        // Before the write: a refresh in between must not take our own change for someone else's.
        void memento?.update(WAS_ON, false);
        disableLiveLimits(CLAUDE_DIR);
      }
    } else {
      pick = await vscode.window.showInformationMessage('Turn on live Claude limits?', {
        modal: true,
        detail: 'Claude Code hands its 5h / weekly limits to its status line on every reply. This sets the status line in '
          + `${settings} to a small script that saves them for Agent Sessions and shows "ctx · 5h · wk" under the prompt. Nothing leaves your machine.\n\n`
          + `${what}\n\n`
          + 'It works while Claude Code runs in a terminal (the VS Code panel runs no status line). Sessions already running may need a restart.'
          + (typeof state === 'object' ? `\n\nThis replaces your current status line:\n${state.other}\nIt comes back when you turn this off.` : '')
          + `\n\nNo script? "${PASTE}" takes the numbers from Claude Code's /usage instead, each time you copy them.`,
      }, 'Turn On', SHOW, PASTE, ...(memento?.get(DECIDED) ? [] : [KEEP]));
      if (pick === 'Turn On') enableLiveLimits(CLAUDE_DIR);
    }
  } catch (err: any) {
    void vscode.window.showErrorMessage("Could not change Claude Code's settings", { modal: true, detail: String(err?.message ?? err) });
    return;
  }
  if (pick === SHOW) return showLiveLimitsScript(state === 'on');
  // Any answer but "show me first" is a decision: the button stops asking for attention.
  if (pick) void memento?.update(DECIDED, true);
  if (pick === PASTE) { syncLiveLimitsContext(); return limitsFromUsage(); }
  if (pick === KEEP) return syncLiveLimitsContext();
  if (pick !== 'Turn On' && pick !== 'Turn Off') return;
  syncLiveLimitsContext();
  const e = entries.get('claude');
  // The script's folder may be new, and a watch only takes on a folder that exists.
  if (e) { watchProvider(e); refresh(e); }
  vscode.window.setStatusBarMessage(`Agent Sessions: live Claude limits ${state === 'on' ? 'off' : 'on'}`, 4000);
}

/**
 * For those who would rather not run our script: Claude Code's /usage dialog writes nothing to disk, so its text is
 * taken from the clipboard, shown back for a check, and saved as one more limits source.
 */
async function limitsFromUsage(from?: vscode.Terminal) {
  const fmt = (l: Limits) => [
    `5h: ${pct(l.five)} used${l.fiveReset ? `, resets ${when(l.fiveReset)}` : ''}`,
    `Week: ${pct(l.week)} used${l.weekReset ? `, resets ${when(l.weekReset)}` : ''}`,
  ].join('\n');
  const save = async (l: Limits) => {
    const ok = await vscode.window.showInformationMessage('Save these Claude limits?', {
      modal: true, detail: `${fmt(l)}\n\nThey age like any reading: after an hour they are shown faded, with a "~".`,
    }, 'Save');
    if (ok !== 'Save') return;
    savePastedLimits(l);
    const e = entries.get('claude');
    // Our folder may be new, and a watch only takes on a folder that exists.
    if (e) { watchProvider(e); refresh(e); }
  };
  const fromClipboard = async () => parseUsageText(await vscode.env.clipboard.readText());
  // Copied already: no need to ask for anything else. Not from the toolbar's /usage, which asks for a fresh dialog.
  const ready = from ? undefined : await fromClipboard();
  if (ready) return save(ready);

  const t = from ?? (vscode.window.activeTerminal && launched.get(vscode.window.activeTerminal)?.e.p.id === 'claude'
    ? vscode.window.activeTerminal : [...launched].find(([, i]) => i.e.p.id === 'claude')?.[0]);
  if (t) { t.show(); t.sendText('/usage'); }
  const READ = 'Read Clipboard';
  for (;;) {
    // Not modal: the terminal has to stay usable to select and copy the dialog's text.
    const pick = await vscode.window.showInformationMessage(
      (t ? `/usage is open in "${t.name}".` : 'Run /usage in Claude Code.')
        + ' Select its text with the mouse, copy it (Ctrl+C), then Read Clipboard.', READ);
    if (pick !== READ) return;
    const l = await fromClipboard();
    if (l) return save(l);
    const again = await vscode.window.showWarningMessage(
      'The clipboard holds no /usage text (looked for "Current session" / "Current week" and "% used").', 'Try Again');
    if (again !== 'Try Again') return;
  }
}

/** The installed file when on; before that, the exact text that would be written, in an unsaved editor. */
async function showLiveLimitsScript(on: boolean) {
  const s = liveLimitsScript(CLAUDE_DIR);
  const doc = on && fs.existsSync(s.file)
    ? await vscode.workspace.openTextDocument(s.file)
    : await vscode.workspace.openTextDocument({ content: s.text, language: s.language });
  await vscode.window.showTextDocument(doc, { preview: true });
  const again = await vscode.window.showInformationMessage(
    on ? `This is the status line script Claude Code runs on every reply (${s.file}).`
      : `This is the script "Live Claude limits" would install at ${s.file}. Nothing has been written yet.`,
    on ? 'Turn Off...' : 'Turn On...');
  if (again) await toggleLiveLimits();
}

/** Global state: set in activate. DECIDED = the user answered the on/off question once; WAS_ON = ours was in place. */
let memento: vscode.Memento | undefined;
const DECIDED = 'liveLimitsDecided', WAS_ON = 'liveLimitsWasOn';

/**
 * Drives the Usage view's button. Colour only asks for attention while there is something to decide: yellow until
 * the user has answered once, then green when on and a dimmed grey when off. Staleness is the Usage view's dot's job.
 */
const syncLiveLimitsContext = () => {
  const on = liveLimitsState(CLAUDE_DIR) === 'on';
  if (on) {
    if (!memento?.get(WAS_ON)) void memento?.update(WAS_ON, true);
    if (!memento?.get(DECIDED)) void memento?.update(DECIDED, true);
  } else if (memento?.get(WAS_ON)) {
    // Ours was replaced from outside (another tool, a hand edit): said once, not on every refresh.
    void memento.update(WAS_ON, false);
    void vscode.window.showInformationMessage(
      "Claude Code's status line was changed outside Agent Sessions, so live Claude limits are now off.", 'Turn On Again...')
      .then(p => { if (p) void toggleLiveLimits(); });
  }
  void vscode.commands.executeCommand('setContext', 'workspaceAgentSessions.liveLimits',
    on ? 'on' : memento?.get(DECIDED) ? 'off' : 'unset');
};

function watch(spec: WatchSpec, onChange: () => void): vscode.Disposable {
  try {
    const w = fs.watch(spec.path, { recursive: !!spec.recursive, persistent: false }, (_e, f) => {
      if (!spec.filter || (f && spec.filter(String(f)))) onChange();
    });
    w.on('error', () => w.close());
    return { dispose: () => w.close() };
  } catch {
    return { dispose() { /* missing dir or unsupported: polling covers it */ } };
  }
}

/** (Re)starts a provider's file watchers. */
function watchProvider(e: Entry) {
  e.watchers.forEach(d => d.dispose());
  const schedule = () => {
    clearTimeout(e.timer);
    e.timer = setTimeout(() => refresh(e), 1500);
  };
  e.watchers = (e.p.watch ?? []).map(w => watch(w, schedule));
}

function register(p: Provider): vscode.Disposable {
  if (!p || typeof p.id !== 'string' || typeof p.name !== 'string' || typeof p.read !== 'function') {
    throw new Error('Agent Sessions: invalid provider (needs id, name, read)');
  }
  if (entries.has(p.id)) throw new Error(`Agent Sessions: provider "${p.id}" is already registered`);

  const item = vscode.window.createStatusBarItem(`workspaceAgentSessions.${p.id}`, vscode.StatusBarAlignment.Right, 100 - slot++);
  item.name = `${p.name} Usage`;
  item.command = { command: 'workspaceAgentSessions.menu', title: 'Agent Sessions', arguments: [p.id] };
  const e: Entry = { p, item, disposables: [item], watchers: [], seq: 0 };
  watchProvider(e);
  entries.set(p.id, e);
  refresh(e);

  return {
    dispose: () => {
      clearTimeout(e.timer);
      e.disposables.forEach(d => d.dispose());
      e.watchers.forEach(d => d.dispose());
      if (entries.get(p.id) === e) entries.delete(p.id);
      treeChanged.fire();
    },
  };
}

export function activate(ctx: vscode.ExtensionContext): Api {
  try { refreshLiveLimitsScript(CLAUDE_DIR); } catch { /* the script from the last version keeps working */ }
  memento = ctx.globalState;
  syncLiveLimitsContext();
  for (const p of BUILT_IN) ctx.subscriptions.push(register(p));

  let poll: NodeJS.Timeout | undefined;
  const startPoll = () => {
    clearInterval(poll);
    const s = Math.max(10, vscode.workspace.getConfiguration('workspaceAgentSessions').get<number>('pollSeconds') ?? 60);
    poll = setInterval(refreshAll, s * 1000);
  };
  startPoll();

  ctx.subscriptions.push(
    { dispose: () => clearInterval(poll) },
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('workspaceAgentSessions')) { startPoll(); refreshAll(); }
    }),
    // A folder added or removed is a user action: redraw now, not on the coalesced reload.
    vscode.workspace.onDidChangeWorkspaceFolders(() => { refreshAll(); reloadProjectsNow(); }),
    // The numbers follow the session of the active terminal (see focusFor).
    vscode.window.onDidChangeActiveTerminal(refreshAll),
    vscode.window.onDidCloseTerminal(refreshAll),
    vscode.window.onDidChangeTerminalShellIntegration(({ terminal }) => {
      if (terminal === vscode.window.activeTerminal) refreshAll();
    }),
    treeChanged,
    treeChanged.event(() => usageView.render()),
    vscode.window.registerWebviewViewProvider('workspaceAgentSessions.view', usageView),
    vscode.commands.registerCommand('workspaceAgentSessions.refresh', refreshAll),
    // Three ids, one action: the view shows the one matching the state, so its icon and tooltip say on or off.
    ...['claudeLiveLimits', 'claudeLiveLimitsIsOn', 'claudeLiveLimitsIsUnset', 'claudeLiveLimitsIsOff']
      .map(id => vscode.commands.registerCommand(`workspaceAgentSessions.${id}`, toggleLiveLimits)),
    vscode.commands.registerCommand('workspaceAgentSessions.claudeLimitsFromUsage', limitsFromUsage),
    vscode.commands.registerCommand('workspaceAgentSessions.showSessions',
      (id?: string, scope?: SessionScope) => showSessions(id, undefined, scope)),
    vscode.commands.registerCommand('workspaceAgentSessions.menu', menu),
    vscode.commands.registerCommand('workspaceAgentSessions.openPanel', openPanel),
    vscode.commands.registerCommand('workspaceAgentSessions.deleteSessions', async (arg?: string | Node) => {
      const e = await pickProvider(typeof arg === 'string' ? arg : arg?.e.p.id, true);
      if (e) await deleteMany(e);
    }),
    vscode.commands.registerCommand('workspaceAgentSessions.sessionDetails', (n: Node) => n.kind === 'session' && showDetails(n.s, n.e)),
    vscode.commands.registerCommand('workspaceAgentSessions.deleteSession', async (n: Node) => {
      if (n.kind !== 'session' || !await confirmDelete(n.e.p, n.s)) return;
      refresh(n.e);
      reloadProjectsNow();
    }),
    ...registerProjects(),
  );
  // Terminals that outlived a window reload, and their sessions, before any view asks.
  vscode.window.terminals.forEach(trackTerminal);
  reloadOpen();

  return {
    registerProvider: p => {
      const d = register(p);
      ctx.subscriptions.push(d);
      return d;
    },
  };
}

export function deactivate() { /* disposables handle cleanup */ }

const openPanel = () => void vscode.commands.executeCommand('workbench.view.extension.workspaceAgentSessions');

async function menu(id?: string) {
  const listable = [...entries.values()].filter(e => e.p.listSessions)
    .sort((a, b) => Number(b.p.id === id) - Number(a.p.id === id));
  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(layout-sidebar-left) Open Agent Sessions panel', run: openPanel },
      { label: '$(refresh) Re-read local data', description: 'no network', run: refreshAll },
      ...(entries.get('claude')?.last?.available
        ? [
          { label: '$(pulse) Live Claude limits', description: liveLimitsState(CLAUDE_DIR) === 'on' ? 'on' : 'off', run: () => void toggleLiveLimits() },
          { label: '$(clippy) Claude limits from /usage...', run: () => void limitsFromUsage() },
        ] : []),
      ...(launched.size ? [{ label: '$(terminal) Agent commands...', run: () => void agentCommands() }] : []),
      ...listable.map(e => ({ label: `$(list-unordered) ${e.p.name} sessions...`, run: () => showSessions(e.p.id, () => menu(id)) })),
      ...listable.filter(e => e.p.deleteSession)
        .map(e => ({ label: `$(checklist) Delete ${e.p.name} sessions...`, run: () => deleteMany(e, () => menu(id)) })),
    ],
    { placeHolder: 'Workspace Agent Session Manager' });
  pick?.run();
}

/** Carries a session to the commands shared by the usage quick picks and the Projects view. */
type Node = { kind: 'session'; e: Entry; s: SessionEntry };

/**
 * Activity bar view: one block per agent with its 5h / weekly / context meters. A webview rather than a tree
 * because a tree row can only hold text, and these numbers read far better as bars.
 */
class UsageView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((m: { id?: string; session?: string }) => {
      if (m.id && m.session) openSessionRow(m.id, m.session);
      else if (m.id) void showSessions(m.id);
    });
    view.onDidDispose(() => { if (this.view === view) this.view = undefined; });
    reloadOpen();
    this.render();
  }

  render() {
    if (this.view) this.view.webview.html = usageHtml();
  }
}

const usageView = new UsageView();

/** A session row in the usage view: jump to its terminal when we started it, else show its details. */
function openSessionRow(id: string, sessionId: string) {
  const e = entries.get(id);
  const s = e?.open?.find(x => x.id === sessionId);
  if (!e || !s) return;
  const t = windowTerminalFor(s);
  if (t) t.show();
  else void showDetails(s, e);
}

const BAR = (used: number | undefined, stale: boolean) => {
  if (used === undefined) return '<div class="bar"><i style="width:0"></i></div>';
  const tone = used >= 95 ? 'err' : used >= 80 ? 'warn' : 'ok';
  return `<div class="bar${stale ? ' stale' : ''}"><i class="${tone}" style="width:${Math.min(100, Math.max(0, used))}%"></i></div>`;
};

/** One row of the usage view: label, bar, percentage, and whatever note belongs on the right. */
function meter(label: string, used: number | undefined, note: string, stale = false): string {
  return `<div class="m${stale ? ' stale' : ''}"><span class="l">${esc(label)}</span>${BAR(used, stale)}`
    + `<span class="p">${esc((stale && used !== undefined ? '~' : '') + pct(used))}</span></div>`
    + (note ? `<div class="n">${esc(note)}</div>` : '');
}

/**
 * One row per open session, with its own name and context bar. Only from two sessions on: with a single one the
 * Context meter above already names it, and a duplicate row would be noise.
 */
function sessionRows(e: Entry): string {
  const list = (e.open ?? []).slice().sort((a, b) => b.mtime - a.mtime);
  if (list.length < 2) return '';
  // Repos only matter once the rows span more than one; otherwise the title alone is clearer.
  const repos = new Set(list.map(s => s.cwd && norm(s.cwd)).filter(Boolean));
  return list.map(s => {
    const cur = e.last?.sessionId ? e.last.sessionId === s.id : e.last?.session === s.title;
    const t = windowTerminalFor(s);
    const act = !!t && t === vscode.window.activeTerminal;
    const repo = repos.size > 1 && s.cwd ? ` · ${path.basename(s.cwd)}` : '';
    const tip = [s.contextDetail, s.cwd, t && `Terminal: ${t.name}${act ? ' (active)' : ''}`].filter(Boolean).join('\n');
    return `<div class="s${cur ? ' cur' : ''}${act ? ' act' : ''}" data-s="${esc(s.id)}" title="${esc(tip)}">`
      + `<span class="sl">${esc(s.title)}${esc(repo)}</span>${BAR(s.ctxUsed, false)}`
      + `<span class="p">${esc(pct(s.ctxUsed))}</span></div>`;
  }).join('');
}

function usageHtml(): string {
  const blocks = [...entries.values()].filter(e => e.last?.available).map(e => {
    const s = e.last!;
    const rows = sessionRows(e);
    if (!hasData(s) && !rows) return `<section><h2>${esc(e.p.name)}<span class="src">not running</span></h2></section>`;
    const stale = !!s.limitsStale;
    const src = s.limitsAt ? `${s.limitsSource ?? ''} · ${ago(s.limitsAt)}` : 'no limit data';
    // How fresh the 5h / weekly numbers are, at a glance: green within the hour, yellow older, red none.
    const age = !s.limitsAt ? 'none' : stale ? 'old' : 'fresh';
    const tip = { fresh: 'Updated in the last hour', old: 'Older than an hour: may be outdated', none: 'No 5h / weekly reading yet' }[age];
    return `<section data-id="${esc(e.p.id)}"><h2>${esc(e.p.name)}`
      + `<span class="src" title="${tip}"><i class="dot ${age}"></i>${esc(src)}</span></h2>`
      + meter('5h', usedOf(s.fiveLeft), until(s.fiveReset), stale)
      + meter('Week', usedOf(s.weekLeft), until(s.weekReset), stale)
      + (rows ? `<div class="ss"><span class="l">Context</span><div class="rows">${rows}</div></div>`
        : meter('Context', s.ctxUsed, s.session ?? ''))
      + (s.note ? `<div class="n note">${esc(s.note).replace(/\n/g, '<br>')}</div>` : '')
      + '</section>';
  });
  const nonce = Math.random().toString(36).slice(2);
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
 body { font: var(--vscode-font-weight) var(--vscode-font-size)/1.4 var(--vscode-font-family); color: var(--vscode-foreground); padding: 6px 12px 10px; }
 section { padding: 6px 0 2px; cursor: pointer; }
 section + section { border-top: 1px solid var(--vscode-widget-border, transparent); margin-top: 4px; }
 h2 { font-size: 1em; font-weight: 600; margin: 0 0 6px; display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
 .src { font-weight: 400; font-size: .85em; opacity: .6; text-align: right; }
 .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; vertical-align: 1px; }
 .dot.fresh { background: var(--vscode-testing-iconPassed, #73c991); }
 .dot.old { background: var(--vscode-editorWarning-foreground, #cca700); }
 .dot.none { background: var(--vscode-editorError-foreground, #f14c4c); }
 .m { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
 .l { flex: 0 0 52px; opacity: .8; }
 .p { flex: 0 0 42px; text-align: right; font-variant-numeric: tabular-nums; }
 /* No opacity on .bar: a child can never exceed its parent's opacity, so it would dim the fill too. */
 .bar { flex: 1; height: 6px; border-radius: 3px; overflow: hidden; background: var(--vscode-scrollbarSlider-background, rgba(128,128,128,.25)); }
 .bar i { display: block; height: 100%; border-radius: 3px; }
 .bar.stale i { opacity: .3; }
 .ok { background: var(--vscode-progressBar-background); }
 .warn { background: var(--vscode-editorWarning-foreground); }
 .err { background: var(--vscode-editorError-foreground); }
 .ss { display: flex; align-items: baseline; gap: 8px; margin-top: 4px; }
 .rows { flex: 1; min-width: 0; }
 .s { display: flex; align-items: center; gap: 8px; margin: 0 -4px 1px; padding: 1px 4px; border-radius: 3px; cursor: pointer; }
 .s:last-child { margin-bottom: 0; }
 /* The session of the active terminal, like the Projects view's highlighted row. */
 .s.act { background: var(--vscode-list-inactiveSelectionBackground, rgba(128,128,128,.2)); }
 .s.act .sl { opacity: 1; }
 .sl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .9em; opacity: .7; }
 .s.cur .sl { opacity: 1; font-weight: 600; }
 .s:hover .sl { opacity: 1; text-decoration: underline; }
 .s .bar { flex: 0 0 64px; }
 .s .p { flex: 0 0 34px; font-size: .9em; }
 .n { margin: 1px 0 0 60px; font-size: .85em; opacity: .55; }
 .note { opacity: .8; }
 .m.stale .p { opacity: .5; }
 .empty { opacity: .6; padding: 8px 0; }
</style></head><body>
${blocks.join('\n') || '<div class="empty">No agent data yet.</div>'}
<script nonce="${nonce}">
 const vs = acquireVsCodeApi();
 for (const el of document.querySelectorAll('section[data-id]')) {
   el.addEventListener('click', () => vs.postMessage({ id: el.dataset.id }));
   // A row has its own target, so it must not also open the agent's session list.
   for (const row of el.querySelectorAll('.s[data-s]')) {
     row.addEventListener('click', ev => {
       ev.stopPropagation();
       vs.postMessage({ id: el.dataset.id, session: row.dataset.s });
     });
   }
 }
</script></body></html>`;
}


/**
 * Projects view: every agent's sessions grouped by repo (the workspace folders, or each session's folder when no
 * workspace is open), so a multi-root workspace is not limited to its first folder. New sessions and resumes run
 * the agent's CLI in a terminal started in that repo.
 */
type PSession = { kind: 'session'; e: Entry; s: SessionEntry; archived?: boolean };
type PNode =
  | { kind: 'repo'; folder: string; sessions: PSession[]; archived: PSession[] }
  /** Repos of sessions started outside every workspace folder; they would otherwise be in no group at all. */
  | { kind: 'other'; repos: PNode[] }
  | { kind: 'archived'; sessions: PSession[] }
  | PSession;

/** No argument: reload every session. A node: redraw just that row (the active terminal's highlight). */
const projectsChanged = new vscode.EventEmitter<PNode | void>();
let projectsView: vscode.TreeView<PNode> | undefined;
/** Session rows of the last load and each node's parent, for `reveal`. */
let shownSessions: PSession[] = [];
let parentOf = new Map<PNode, PNode>();
let highlightKey: string | undefined;
const keyOf = (x: PSession) => `${x.e.p.id}:${x.s.id}`;

/** Follows the active terminal: its session's row is highlighted, and selected and scrolled to when it changes. */
function syncHighlight() {
  const t = vscode.window.activeTerminal;
  const hit = t && shownSessions.find(x => !x.archived && windowTerminalFor(x.s) === t);
  const key = hit ? keyOf(hit) : undefined;
  if (key === highlightKey) return;
  const prev = shownSessions.find(x => keyOf(x) === highlightKey);
  highlightKey = key;
  for (const n of [prev, hit]) if (n) projectsChanged.fire(n);
  if (hit && projectsView?.visible) {
    projectsView.reveal(hit, { select: true, focus: false }).then(undefined, () => { /* reloaded meanwhile */ });
  }
}
let projectsTimer: NodeJS.Timeout | undefined;
// Listing every session reads every transcript, so reloads are coalesced.
const reloadProjects = () => {
  clearTimeout(projectsTimer);
  projectsTimer = setTimeout(() => projectsChanged.fire(), 3000);
};
/** The coalescing above is for file-watcher storms; an action the user just clicked must show at once. */
const reloadProjectsNow = () => {
  clearTimeout(projectsTimer);
  projectsChanged.fire();
};

/** Terminals this extension started, matched to sessions by resumed id or by the agent's process id. */
/** `at`: when we started it. Codex sessions carry no process id, so the start time is what tells two apart. */
type Launched = { e: Entry; sessionId?: string; pid?: number; cwd?: string; at: number };
const launched = new Map<vscode.Terminal, Launched>();
const terminalFor = (s: SessionEntry) =>
  [...launched].find(([, i]) => i.sessionId === s.id || (s.pid !== undefined && i.pid === s.pid))?.[0];

/**
 * Every terminal's process id. `launched` is lost on a window reload while its terminals live on, and an agent
 * the user typed into a shell runs under that shell: both are found by process id instead.
 */
const termPids = new Map<vscode.Terminal, number>();
/** pid → parent pid. Read once per new agent process: the OS query takes about half a second on Windows. */
let parents = new Map<number, number>();
const asked = new Set<number>();

const trackTerminal = (t: vscode.Terminal) => void t.processId.then(pid => {
  if (pid === undefined || t.exitStatus) return;
  termPids.set(t, pid);
  adoptTerminals();
});

/** The terminal of this window running the agent process `pid`, as its process or under a shell. */
function hostTerminal(pid: number | undefined): vscode.Terminal | undefined {
  for (let x = pid, hops = 0; x !== undefined && hops < 6; x = parents.get(x), hops++) {
    for (const [t, p] of termPids) if (p === x) return t;
  }
  return undefined;
}

/** Ours, or another terminal of this window: those can be shown, but never closed or typed into. */
const windowTerminalFor = (s: SessionEntry) => terminalFor(s) ?? hostTerminal(s.pid);

/**
 * A terminal whose own process is the agent was started by us (users run agents in a shell), so after a reload
 * it is taken back with its buttons. Agents still not placed may run in a shell: their parents are looked up.
 * Codex reports no process id, so its terminals from before a reload stay unknown.
 */
function adoptTerminals() {
  const live = openSessions().filter(x => x.s.pid !== undefined);
  let changed = false;
  for (const { e, s } of live) {
    const t = terminalFor(s) ? undefined : [...termPids].find(([, p]) => p === s.pid)?.[0];
    if (t && !launched.has(t)) {
      launched.set(t, { e, sessionId: s.id, pid: s.pid, cwd: s.cwd, at: s.mtime });
      changed = true;
    }
  }
  const pids = new Set(live.map(x => x.s.pid!));
  for (const p of asked) if (!pids.has(p)) asked.delete(p);
  // `source` is set for agents started outside a terminal (the Claude panel): no shell to find.
  const unplaced = live.filter(x => !x.s.source && !asked.has(x.s.pid!) && !windowTerminalFor(x.s));
  if (unplaced.length) {
    unplaced.forEach(x => asked.add(x.s.pid!));
    void processParents().then(map => {
      parents = map;
      if (unplaced.some(x => hostTerminal(x.s.pid))) { refreshAll(); treeChanged.fire(); }
    });
  }
  if (changed) { syncAgentContext(); refreshAll(); }
}

/** Two sessions of one agent in one repo would get the same name; number the later ones so they can be told apart. */
function terminalName(base: string): string {
  const taken = new Set([...launched.keys()].map(t => t.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} #${n}`)) return `${base} #${n}`;
}

function launch(e: Entry, cwd: string | undefined, s?: SessionEntry, options?: LaunchOptions) {
  // Claude Code writes a transcript only once the first message is sent. Resuming a session without one makes the
  // CLI exit at once ("terminated with exit code 1"), so say why instead.
  if (s?.file && !fs.existsSync(s.file)) {
    void vscode.window.showInformationMessage(`"${s.title}" has no messages yet, so there is nothing to resume.`
      + (s.live ? ` It is open in ${s.source ?? 'another process'}; continue it there.` : ''));
    return;
  }
  const spec = e.p.terminal!(pctx, cwd ?? '', s?.id, options);
  const t = vscode.window.createTerminal({
    name: terminalName(`${e.p.name} · ${s ? s.title : path.basename(cwd ?? '')}`),
    cwd: cwd && fs.existsSync(cwd) ? cwd : undefined,
    shellPath: spec.shellPath,
    shellArgs: spec.shellArgs,
    iconPath: new vscode.ThemeIcon('hubot'),
  });
  const info: Launched = { e, sessionId: s?.id, cwd, at: Date.now() };
  launched.set(t, info);
  void t.processId.then(pid => { info.pid = pid; refresh(e); });
  t.show();
  syncAgentContext();
  reloadProjects();
}

/** Files picked in a step stay with the flow; the button is on every step so it is not hidden behind one. */
const ATTACH: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('new-file'), tooltip: 'Attach files to the first message' };

type Step<T> = (vscode.QuickPickItem & T)[];

/** One quick pick of the chain. Resolves to the pick, 'back', or undefined when the user cancelled. */
function pickStep<T>(items: Step<T>, title: () => string, placeholder: string, back: boolean, files: string[]) {
  return new Promise<(vscode.QuickPickItem & T) | 'back' | undefined>(resolve => {
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & T>();
    qp.items = items;
    qp.title = title();
    qp.placeholder = placeholder;
    // The file dialog takes focus; without this the chain would close behind it.
    qp.ignoreFocusOut = true;
    qp.buttons = back ? [vscode.QuickInputButtons.Back, ATTACH] : [ATTACH];
    let out: (vscode.QuickPickItem & T) | 'back' | undefined;
    qp.onDidTriggerButton(async b => {
      if (b === vscode.QuickInputButtons.Back) { out = 'back'; return qp.hide(); }
      const uris = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Attach' });
      for (const u of uris ?? []) if (!files.includes(u.fsPath)) files.push(u.fsPath);
      qp.title = title();
    });
    qp.onDidAccept(() => { out = qp.selectedItems[0]; qp.hide(); });
    qp.onDidHide(() => { resolve(out); qp.dispose(); });
    qp.show();
  });
}

/**
 * New session as a chain of quick picks: agent, folder, model, effort. A four-question form does not deserve an
 * editor tab, and a chain can be answered from the keyboard without leaving the menu. Steps with a single possible
 * answer are skipped in both directions, so Back always lands on a question that was actually asked.
 */
async function newSessionFlow(folder?: string) {
  const starters = [...entries.values()].filter(e => e.p.terminal);
  if (!starters.length) return;
  const known = new Set(await vscode.commands.getCommands());
  const folders = folder ? [folder] : pctx.folders;
  const files: string[] = [];
  const title = () => 'New agent session' + (files.length ? ` · ${files.length} file${files.length > 1 ? 's' : ''}` : '');

  let agent = starters.length === 1 ? starters[0] : undefined;
  let dir = folders.length === 1 ? folders[0] : undefined;
  let model = '', effort = '';
  const models = () => (agent?.p.launchChoices?.models ?? []).map(m => (typeof m === 'string' ? { id: m } : m));
  const efforts = () => {
    const m = models().find(x => x.id === model);
    return m?.efforts?.length ? m.efforts : agent?.p.launchChoices?.efforts ?? [];
  };
  const DEFAULT = { label: 'Default', description: "the agent's own setting" };

  for (let i = 0, step = 1; i >= 0 && i < 4;) {
    let r: unknown;
    if (i === 0) {
      if (starters.length === 1 && !folder) { i += step; continue; }
      const panels = folder ? starters.filter(e => e.p.panelCommand && known.has(e.p.panelCommand!)) : [];
      r = await pickStep([
        ...starters.map(e => ({ label: `$(terminal) ${e.p.name}`, description: folder ? 'in a terminal' : undefined, e })),
        ...panels.map(e => ({ label: `$(layout-sidebar-right) ${e.p.name} in panel`, panel: e })),
      ], title, 'Which agent?', false, files);
      if (r && r !== 'back') {
        const hit = r as { e?: Entry; panel?: Entry };
        if (hit.panel) return runPanel(hit.panel, folder!);
        agent = hit.e;
      }
    } else if (i === 1) {
      if (folders.length <= 1) { dir = folders[0]; i += step; continue; }
      r = await pickStep(folders.map(f => ({ label: `$(folder) ${path.basename(f)}`, description: f, f })), title, 'In which repo?', true, files);
      if (r && r !== 'back') dir = (r as { f: string }).f;
    } else if (i === 2) {
      if (!models().length) { i += step; continue; }
      r = await pickStep([
        DEFAULT,
        ...models().map(m => ({ label: m.label ?? m.id, description: m.id === m.label ? undefined : m.id, detail: m.detail, id: m.id })),
        { label: '$(edit) Type a model name...', typed: true },
      ] as Step<{ id?: string; typed?: boolean }>, title, `Model for ${agent!.p.name}`, true, files);
      if (r && r !== 'back') {
        const hit = r as { id?: string; typed?: boolean };
        model = hit.typed ? (await vscode.window.showInputBox({ prompt: `Model for ${agent!.p.name}`, value: model }))?.trim() ?? '' : hit.id ?? '';
        if (hit.typed && !model) continue;
        if (!efforts().includes(effort)) effort = '';
      }
    } else {
      if (!efforts().length) { i += step; continue; }
      r = await pickStep([DEFAULT, ...efforts().map(x => ({ label: x, id: x }))] as Step<{ id?: string }>,
        title, 'Reasoning effort', true, files);
      if (r && r !== 'back') effort = (r as { id?: string }).id ?? '';
    }
    if (!r) return;
    step = r === 'back' ? -1 : 1;
    i += step;
  }
  if (!agent) return;
  launch(agent, dir, undefined, { model: model || undefined, effort: effort || undefined, files });
}

/** The agent's own panel: it only serves the first workspace folder, so another repo needs its own window. */
function runPanel(e: Entry, folder: string) {
  if (norm(pctx.folders[0] ?? '') === norm(folder)) void vscode.commands.executeCommand(e.p.panelCommand!);
  else void openWindow(e.p.name, folder);
}

/** The deepest folder containing `cwd`. */
function owner(cwd: string | undefined, folders: string[]): string | undefined {
  if (!cwd) return undefined;
  const c = norm(cwd);
  return folders.filter(f => c === norm(f) || c.startsWith(norm(f) + path.sep)).sort((a, b) => b.length - a.length)[0];
}

async function loadSessions(scope: SessionScope): Promise<PSession[]> {
  const list = [...entries.values()].filter(e => e.p.listSessions && (scope !== 'archived' || e.p.unarchiveSession));
  const per = await Promise.all(list.map(async e => {
    try { return (await e.p.listSessions!(pctx, scope)).map(s => ({ kind: 'session' as const, e, s, archived: scope === 'archived' })); }
    catch { return []; }
  }));
  return per.flat().sort((a, b) => b.s.mtime - a.s.mtime);
}

const SESSION_URI = 'ai-usage-session';

/**
 * A tree row's text carries no colour of its own; a file decoration is the only way to tint one. Used for the
 * sessions open where we cannot reach them (the agent's own app or panel): neither resume nor the command
 * buttons apply to those, so they should not look like the rows that do.
 */
const sessionDecorations: vscode.FileDecorationProvider = {
  provideFileDecoration(uri) {
    if (uri.scheme !== SESSION_URI) return undefined;
    const src = new URLSearchParams(uri.query).get('src');
    return src ? { color: new vscode.ThemeColor('list.warningForeground'), tooltip: `Open in ${src}` } : undefined;
  },
};

const projects: vscode.TreeDataProvider<PNode> = {
  onDidChangeTreeData: projectsChanged.event,
  async getChildren(n?: PNode): Promise<PNode[]> {
    if (n?.kind === 'repo') {
      if (!n.archived.length) return n.sessions;
      const arch = { kind: 'archived' as const, sessions: n.archived };
      parentOf.set(arch, n);
      n.archived.forEach(x => parentOf.set(x, arch));
      return [...n.sessions, arch];
    }
    if (n?.kind === 'other') return n.repos;
    if (n?.kind === 'archived') return n.sessions;
    if (n) return [];
    const [active, archived] = await Promise.all([loadSessions('all'), loadSessions('archived')]);
    let folders = pctx.folders;
    if (!folders.length) {
      const seen = new Map<string, string>();
      for (const { s } of active) if (s.cwd && fs.existsSync(s.cwd)) seen.set(norm(s.cwd), s.cwd);
      folders = [...seen.values()];
    }
    const repos = (list: string[], from: PSession[], arch: PSession[]) => list.map(folder => ({
      kind: 'repo' as const, folder,
      sessions: from.filter(x => owner(x.s.cwd, list) === folder),
      archived: arch.filter(x => owner(x.s.cwd, list) === folder),
    }));
    // A session started elsewhere -- another repo's terminal, the home folder, the agent's own app -- belongs to no
    // workspace folder. Hiding it made it unreachable from here, so it gets its own group, grouped by its own folder.
    const out = (x: PSession) => !!x.s.cwd && owner(x.s.cwd, folders) === undefined;
    const strays = [...active.filter(out), ...archived.filter(out)];
    const elsewhere = [...new Map(strays.map(x => [norm(x.s.cwd!), x.s.cwd!])).values()];
    const top = repos(folders, active, archived);
    const other = elsewhere.length
      ? { kind: 'other' as const, repos: repos(elsewhere, active.filter(out), archived.filter(out)) } : undefined;
    parentOf = new Map();
    shownSessions = [];
    for (const r of [...top, ...(other?.repos ?? [])]) {
      if (other && !top.includes(r)) parentOf.set(r, other);
      for (const x of [...r.sessions, ...r.archived]) parentOf.set(x, r);
      shownSessions.push(...r.sessions);
    }
    // Same key as before the reload = no reveal: a session busy writing reloads the view every few seconds,
    // and pulling the view back to it each time would fight the user's scrolling.
    setTimeout(syncHighlight, 200);
    return [...top, ...(other ? [other] : [])];
  },
  getParent: (n: PNode) => parentOf.get(n),
  getTreeItem(n: PNode): vscode.TreeItem {
    if (n.kind === 'repo') {
      const live = n.sessions.filter(x => x.s.live).length;
      const it = new vscode.TreeItem(path.basename(n.folder),
        live ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      it.description = `${n.sessions.length} session(s)${live ? ` · ${live} open` : ''}`;
      it.tooltip = n.folder;
      it.iconPath = new vscode.ThemeIcon('repo');
      it.contextValue = 'repo';
      return it;
    }
    if (n.kind === 'other') {
      const it = new vscode.TreeItem('Other folders', vscode.TreeItemCollapsibleState.Collapsed);
      it.description = `${n.repos.length} folder(s) outside this workspace`;
      it.iconPath = new vscode.ThemeIcon('folder-library');
      return it;
    }
    if (n.kind === 'archived') {
      const it = new vscode.TreeItem(`Archived (${n.sessions.length})`, vscode.TreeItemCollapsibleState.Collapsed);
      it.iconPath = new vscode.ThemeIcon('archive');
      return it;
    }
    const { e: { p }, s, archived } = n;
    const t = terminalFor(s);
    const w = archived ? undefined : t ?? hostTerminal(s.pid);
    const here = !!w && w === vscode.window.activeTerminal;
    const it = new vscode.TreeItem(here ? { label: s.title, highlights: [[0, s.title.length]] } : s.title);
    it.description = `${p.name} · ${sessionDesc(s)}`;
    it.tooltip = [s.cwd, w && `Terminal: ${w.name}${here ? ' (active)' : ''}`].filter(Boolean).join('\n');
    // Our own terminal is proof enough: Codex reports a thread as closed whenever it is not writing to it.
    const open = s.live || !!t;
    it.iconPath = new vscode.ThemeIcon(s.busy ? 'loading~spin' : open ? 'debug-start' : archived ? 'archive' : 'comment-discussion');
    // Flags matched by the inline menus in package.json, e.g. viewItem =~ /\.resume\./
    const f = ['psession'];
    if (!open) {
      if (p.terminal && !archived) f.push('resume');
      if (archived ? p.unarchiveSession : p.archiveSession) f.push(archived ? 'unarchive' : 'archive');
      if (p.deleteSession) f.push('delete');
      if (p.renameSession) f.push('rename');
    } else if (t) {
      f.push(...slashCommandsOf(s).map(q => q.flag!), 'close');
    }
    it.contextValue = f.join('.') + '.';
    // Tinted while a process outside this window holds it; the uri carries the reason, so the decoration needs no
    // lookup. An agent in one of this window's shells is reachable, if only to show it.
    if (open && !w) {
      it.resourceUri = vscode.Uri.parse(
        `${SESSION_URI}:/${encodeURIComponent(s.id)}?src=${encodeURIComponent(s.source ?? 'another process')}`);
    }
    // Clicking a row means "take me to this conversation": its terminal in this window if it has one, else open it
    // in a new one. A session live somewhere we cannot reach (the agent's own panel) must not be opened twice, so
    // it falls back to the details dialog.
    const click = w ? 'workspaceAgentSessions.focusSession'
      : !open && p.terminal && !archived ? 'workspaceAgentSessions.resumeSession'
      : 'workspaceAgentSessions.sessionDetails';
    it.command = { command: click, title: 'Open session', arguments: [n] };
    return it;
  },
};

/** Every way to start a session in one repo: each agent in a terminal, and in its own panel where it has one. */

const openFolder = (folder: string) =>
  void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), { forceNewWindow: true });

/** The agent's panel only serves the first workspace folder, so any other repo needs its own window. */
async function openWindow(agent: string, folder: string) {
  const ok = await vscode.window.showInformationMessage(
    `The ${agent} panel works on the first workspace folder only. Open ${path.basename(folder)} in its own window, then start the panel there.`,
    'Open Window');
  if (ok) openFolder(folder);
}

/** Terminal to send commands to: the node's, the active one, or a pick among the ones we started. */
async function pickTerminal(n?: PNode) {
  if (n?.kind === 'session') {
    const t = terminalFor(n.s);
    if (t) return t;
  }
  const active = vscode.window.activeTerminal;
  if (active && launched.has(active)) return active;
  const all = [...launched.keys()];
  if (all.length <= 1) return all[0];
  return (await vscode.window.showQuickPick(all.map(t => ({ label: t.name, t })), { placeHolder: 'Which terminal?' }))?.t;
}

/**
 * The slash commands that get their own button in the terminal toolbar, keyed by the context key
 * `package.json` matches. A button shows only if the active terminal's provider offers that command,
 * so agents without it (Codex has no /context, /usage) simply don't get one.
 */
interface QuickCommand {
  /** Toolbar command id, acting on the active terminal. */
  id: string;
  /** Context key `package.json` matches to show the toolbar button. */
  key: string;
  command: string;
  /** Session rows get the same command, acting on that row's terminal; `flag` names it in `contextValue`. */
  row?: string;
  flag?: string;
  /** Asked first, for a command whose effect on the conversation cannot be undone. */
  confirm?: { message: string; detail: string; action: string };
}
const QUICK_COMMANDS: QuickCommand[] = [
  { id: 'workspaceAgentSessions.quickContext', key: 'workspaceAgentSessions.cmdContext', command: '/context', row: 'workspaceAgentSessions.rowContext', flag: 'ctx' },
  // /usage is account-wide, the same for every session: it belongs in the usage view, not on a row.
  { id: 'workspaceAgentSessions.quickUsage', key: 'workspaceAgentSessions.cmdUsage', command: '/usage' },
  {
    id: 'workspaceAgentSessions.quickCompact', key: 'workspaceAgentSessions.cmdCompact', command: '/compact',
    row: 'workspaceAgentSessions.rowCompact', flag: 'compact',
    confirm: {
      message: 'Compact this conversation?',
      detail: 'The agent replaces the conversation with a summary to free context. Anything the summary leaves out is gone from the session, and there is no way back. It also costs a request.',
      action: 'Compact',
    },
  },
  { id: 'workspaceAgentSessions.quickModel', key: 'workspaceAgentSessions.cmdModel', command: '/model', row: 'workspaceAgentSessions.rowModel', flag: 'model' },
  // No toolbar button for this one: renaming is occasional, and a sixth icon costs more than it is worth. It is
  // offered on the session's right-click menu, where a name change is looked for (renameRow, closed sessions too).
  { id: 'workspaceAgentSessions.quickRename', key: 'workspaceAgentSessions.cmdRename', command: '/rename', flag: 'rename' },
];

/** Shows the terminal-toolbar buttons only while an agent terminal we started is active. */
const syncAgentContext = () => {
  const t = vscode.window.activeTerminal;
  const info = t && launched.get(t);
  void vscode.commands.executeCommand('setContext', 'workspaceAgentSessions.agentTerminal', !!info);
  const cmds = info ? info.e.p.slashCommands : undefined;
  for (const q of QUICK_COMMANDS) {
    void vscode.commands.executeCommand('setContext', q.key, !!cmds?.some(c => c.command === q.command));
  }
};

/** Types a slash command into an agent terminal of ours, asking for its argument first when it takes one. */
async function sendSlash(t: vscode.Terminal | undefined, cmd: string) {
  const c = t && launched.get(t)?.e.p.slashCommands?.find(x => x.command === cmd);
  if (!t || !c) return;
  // A button is one click, so a command that cannot be undone asks first (same for the toolbar and the rows).
  const ask = QUICK_COMMANDS.find(q => q.command === cmd)?.confirm;
  if (ask && await vscode.window.showWarningMessage(ask.message, { modal: true, detail: ask.detail }, ask.action) !== ask.action) return;
  const arg = c.options ? await vscode.window.showQuickPick(c.options, { placeHolder: c.command })
    : c.argument ? (await vscode.window.showInputBox({ prompt: `${c.command}: ${c.argument}` }))?.trim() : undefined;
  if ((c.options || c.argument) && !arg) return;
  t.show();
  t.sendText(arg ? `${c.command} ${arg}` : c.command);
}

/** A session row's slash buttons act on that row's terminal, not on whichever one happens to be active. */
const slashCommandsOf = (s: SessionEntry) => {
  const t = terminalFor(s);
  const cmds = t && launched.get(t)?.e.p.slashCommands;
  return QUICK_COMMANDS.filter(q => q.flag && cmds?.some(c => c.command === q.command));
};

/**
 * Rename from a session row: an open session in our terminal through the agent's own /rename (it holds the
 * transcript), any other one by the provider writing the name where the agent keeps it.
 */
async function renameRow(n: PNode) {
  if (n?.kind !== 'session') return;
  const t = terminalFor(n.s);
  if (t) return sendSlash(t, '/rename');
  const { e: { p }, s } = n;
  if (!p.renameSession) return;
  const title = (await vscode.window.showInputBox({ prompt: `Rename ${p.name} session`, value: s.title }))?.trim();
  if (!title || title === s.title) return;
  try { await p.renameSession(s, title, pctx); }
  catch (err: any) { void vscode.window.showErrorMessage(`Could not rename ${p.name} session`, { modal: true, detail: String(err?.message ?? err) }); }
  refresh(n.e);
  reloadProjectsNow();
}

/** Shift+Tab is the agents' own mode switch (default → accept edits → plan → auto). */
const cycleMode = () => {
  const t = vscode.window.activeTerminal;
  if (t && launched.has(t)) { t.show(); t.sendText('\x1b[Z', false); }
};

/** Quick pick of the agent's slash commands, typed into one of its terminals. */
async function agentCommands(n?: PNode) {
  const t = await pickTerminal(n);
  const cmds = t && launched.get(t)?.e.p.slashCommands;
  if (!t || !cmds) {
    if (!t) void vscode.window.showInformationMessage('No agent terminal started from here. Use + or ▶ in the Projects view first.');
    return;
  }
  const c = await vscode.window.showQuickPick(
    cmds.map(c => ({ label: c.command, description: c.options ? 'choose a value…' : undefined, detail: c.detail, c })),
    { placeHolder: `Commands for ${t.name}`, matchOnDetail: true });
  if (!c) return;
  // Sent through sendSlash so the menu, the toolbar and the rows share one path, confirmation included.
  await sendSlash(t, c.c.command);
}

/** Set when a terminal of ours closes: the agent is still exiting, so its session is re-read a moment later. */
let closedTimer: NodeJS.Timeout | undefined;

/**
 * `defaultAgent` decides what + starts without asking. It is an agent id, which is a poor thing to look for in
 * Settings, so the same choice is offered as a list from the view's menu.
 */
async function setDefaultAgent() {
  const cfg = vscode.workspace.getConfiguration('workspaceAgentSessions');
  const now = cfg.get<string>('defaultAgent') ?? '';
  const mark = (id: string) => (id === now ? 'current' : undefined);
  const pick = await vscode.window.showQuickPick([
    ...[...entries.values()].filter(e => e.p.terminal)
      .map(e => ({ label: `$(hubot) ${e.p.name}`, description: mark(e.p.id), detail: `+ starts ${e.p.name} at once, on its own default model and effort`, id: e.p.id })),
    { label: '$(list-selection) Ask every time', description: mark(''), detail: '+ opens the agent menu', id: '' },
  ], { placeHolder: 'What should + on a repo start?' });
  if (!pick) return;
  await cfg.update('defaultAgent', pick.id, vscode.ConfigurationTarget.Global);
  const e = entries.get(pick.id);
  vscode.window.setStatusBarMessage(`Agent Sessions: + ${e ? `starts ${e.p.name}` : 'asks which agent'}`, 4000);
}

function registerProjects(): vscode.Disposable[] {
  const act = (fn: (n: PSession) => void | Promise<void>) => async (n: PNode) => {
    if (n?.kind !== 'session') return;
    try { await fn(n); } catch (err: any) {
      vscode.window.showErrorMessage(`${n.e.p.name}: ${err?.message ?? err}`, { modal: true, detail: n.s.title });
    }
    refresh(n.e);
    reloadProjectsNow();
  };
  return [
    projectsChanged,
    projectsChanged.event(n => { if (!n) reloadOpen(); }),
    { dispose: () => clearTimeout(projectsTimer) },
    treeChanged.event(reloadProjects),
    projectsView = vscode.window.createTreeView('workspaceAgentSessions.projects', { treeDataProvider: projects }),
    projectsView.onDidChangeVisibility(({ visible }) => { if (visible) { highlightKey = undefined; syncHighlight(); } }),
    vscode.window.onDidChangeActiveTerminal(syncHighlight),
    vscode.window.onDidOpenTerminal(trackTerminal),
    vscode.window.registerFileDecorationProvider(sessionDecorations),
    vscode.window.onDidCloseTerminal(t => {
      termPids.delete(t);
      if (!launched.delete(t)) return;
      // Killing a terminal is a user action: it must show at once, not on the watcher's coalesced reload.
      reloadProjectsNow();
      // The agent process outlives its terminal by a moment, so this first read can still find it alive
      // (Claude's sessions/<pid>.json, Codex's writer lock). Look again once it is really gone.
      clearTimeout(closedTimer);
      closedTimer = setTimeout(() => { refreshAll(); reloadProjectsNow(); }, 1200);
    }),
    { dispose: () => clearTimeout(closedTimer) },
    vscode.window.onDidChangeActiveTerminal(syncAgentContext),
    vscode.commands.registerCommand('workspaceAgentSessions.cycleMode', cycleMode),
    // /usage writes nothing to disk, so the toolbar's /usage goes on to the copy flow: otherwise the numbers it
    // shows would never reach the Usage view.
    ...QUICK_COMMANDS.map(q => vscode.commands.registerCommand(q.id, () => {
      const t = vscode.window.activeTerminal;
      return q.command === '/usage' && t && launched.get(t)?.e.p.id === 'claude' ? limitsFromUsage(t) : sendSlash(t, q.command);
    })),
    ...QUICK_COMMANDS.filter(q => q.row).map(q => vscode.commands.registerCommand(q.row!,
      (n: PNode) => { if (n?.kind === 'session') void sendSlash(terminalFor(n.s), q.command); })),
    vscode.commands.registerCommand('workspaceAgentSessions.rowRename', renameRow),
    vscode.commands.registerCommand('workspaceAgentSessions.focusSession', (n: PNode) => {
      if (n?.kind === 'session') windowTerminalFor(n.s)?.show();
    }),
    vscode.commands.registerCommand('workspaceAgentSessions.refreshProjects', () => projectsChanged.fire()),
    vscode.commands.registerCommand('workspaceAgentSessions.newSession', async (n: PNode) => {
      if (n?.kind !== 'repo') return;
      // One click to a working session: no model or effort is passed, so the agent's own defaults apply.
      // Without a default agent there is nothing to guess, so the menu opens instead.
      const fast = entries.get(pctx.setting<string>('defaultAgent') ?? '');
      if (fast?.p.terminal) launch(fast, n.folder);
      else await newSessionFlow(n.folder);
    }),
    vscode.commands.registerCommand('workspaceAgentSessions.setDefaultAgent', setDefaultAgent),
    vscode.commands.registerCommand('workspaceAgentSessions.newSessionMenu', (n: PNode) => {
      if (n?.kind === 'repo') void newSessionFlow(n.folder);
    }),
    vscode.commands.registerCommand('workspaceAgentSessions.agentCommands', agentCommands),
    vscode.commands.registerCommand('workspaceAgentSessions.startSession', () => newSessionFlow()),
    vscode.commands.registerCommand('workspaceAgentSessions.openInWindow', (n: PNode) => {
      if (n?.kind === 'repo') openFolder(n.folder);
    }),
    vscode.commands.registerCommand('workspaceAgentSessions.resumeSession', act(n => launch(n.e, n.s.cwd, n.s))),
    vscode.commands.registerCommand('workspaceAgentSessions.closeSession', act(n => terminalFor(n.s)?.dispose())),
    vscode.commands.registerCommand('workspaceAgentSessions.archiveSession', act(n => n.e.p.archiveSession!(n.s, pctx))),
    vscode.commands.registerCommand('workspaceAgentSessions.unarchiveSession', act(n => n.e.p.unarchiveSession!(n.s, pctx))),
  ];
}

const pct = (n?: number) => (n === undefined ? '—' : `${Math.round(n)}%`);
/** Providers report limits as remaining; the UI shows what is used, like the context number. */
const usedOf = (left?: number) => (left === undefined ? undefined : 100 - left);
/** Limits older than the provider's threshold get a '~' prefix: the number may be outdated. */
const used = (left: number | undefined, s: Snapshot) => (s.limitsStale && left !== undefined ? '~' : '') + pct(usedOf(left));
// Bars read better than dots between the numbers in the status bar's small font.
const summary = (s: Snapshot) => `ctx ${pct(s.ctxUsed)}  |  5h ${used(s.fiveLeft, s)}  |  wk ${used(s.weekLeft, s)}`;

function when(ms?: number): string {
  if (ms === undefined) return '—';
  const d = new Date(ms);
  const mins = Math.max(0, Math.round((ms - Date.now()) / 60000));
  const rel = mins >= 1440 ? `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`
    : `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} (in ${rel})`;
}

const esc = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** "resets in 1h 20m" for the usage view; empty when the provider reported no reset time. */
function until(ms?: number): string {
  if (ms === undefined) return '';
  const mins = Math.max(0, Math.round((ms - Date.now()) / 60000));
  return 'resets in ' + (mins >= 1440 ? `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`
    : mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`);
}

function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

const sessionDesc = (s: SessionEntry) =>
  [`Ctx ${pct(s.ctxUsed)}`, ago(s.mtime), s.busy ? 'working' : s.live || terminalFor(s) ? 'open' : '', s.source]
    .filter(Boolean).join(' · ');

const hasData = (s: Snapshot) => s.ctxUsed !== undefined || s.fiveLeft !== undefined || s.weekLeft !== undefined;

function render(item: vscode.StatusBarItem, name: string, s: Snapshot) {
  if (!s.available || !hasData(s)) { item.hide(); return; }
  item.text = `${name}  ${summary(s)}`;
  item.tooltip = tooltip(s);
  // Status bar items can only take the theme's warning/error backgrounds, and only for the whole item.
  const peak = Math.max(s.ctxUsed ?? 0, usedOf(s.fiveLeft) ?? 0, usedOf(s.weekLeft) ?? 0);
  item.backgroundColor = peak >= 95 ? new vscode.ThemeColor('statusBarItem.errorBackground')
    : peak >= 80 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  item.show();
}

/** Markdown-escapes text from outside (session titles, notes), which could otherwise break the table or format. */
const mdEsc = (t: string) => esc(t).replace(/[\\`*_{}[\]()#+\-.!|]/g, c => '\\' + c);

/**
 * A bar like the Usage view's, for the hover. Hovers allow no CSS beyond a span's colour, but that colour may be a
 * theme variable, so a run of full blocks in the progress bar's colour (faded ones grey) on the scrollbar's track.
 */
function hoverBar(usedPct: number | undefined, stale: boolean): string {
  const CELLS = 20;
  const n = usedPct === undefined ? 0 : Math.round(Math.min(100, Math.max(0, usedPct)) / 100 * CELLS);
  const fill = stale ? 'disabledForeground' : (usedPct ?? 0) >= 95 ? 'editorError-foreground'
    : (usedPct ?? 0) >= 80 ? 'editorWarning-foreground' : 'progressBar-background';
  const span = (k: string, cells: number) => (cells ? `<span style="color:var(--vscode-${k});">${'█'.repeat(cells)}</span>` : '');
  return span(fill, n) + span('scrollbarSlider-background', CELLS - n);
}

function tooltip(s: Snapshot): vscode.MarkdownString {
  const stale = !!s.limitsStale;
  const row = (label: string, usedPct: number | undefined, value: string, note: string) =>
    `| ${label} | ${hoverBar(usedPct, stale && label !== 'Context')} | ${value} | ${note} |`;
  const lines = [
    '| | | | |', '|:--|:--|--:|:--|',
    row('Context', s.ctxUsed, pct(s.ctxUsed), s.session ? mdEsc(s.session) : ''),
    row('5h', usedOf(s.fiveLeft), used(s.fiveLeft, s), until(s.fiveReset)),
    row('Week', usedOf(s.weekLeft), used(s.weekLeft, s), until(s.weekReset)),
    '',
  ];
  if (s.limitsAt) lines.push(`Limits: ${mdEsc(s.limitsSource ?? '')}, ${ago(s.limitsAt)}${stale ? ' (may be outdated)' : ''}`, '');
  if (s.note) lines.push(s.note.split('\n').map(l => `*${mdEsc(l)}*`).join('  \n'));
  const md = new vscode.MarkdownString(lines.join('\n'));
  md.supportHtml = true;
  return md;
}

type SessionItem = vscode.QuickPickItem & { s?: SessionEntry; showAll?: boolean };

const INFO: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('info'), tooltip: 'Context details' };
const TRASH: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Delete session' };
const DELETE_MANY: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('checklist'), tooltip: 'Delete several sessions...' };

async function pickProvider(id?: string, deletable = false): Promise<Entry | undefined> {
  const list = [...entries.values()].filter(e => e.p.listSessions && (!deletable || e.p.deleteSession));
  const hit = list.find(e => e.p.id === id) ?? (list.length === 1 ? list[0] : undefined);
  if (hit) return hit;
  return (await vscode.window.showQuickPick(list.map(e => ({ label: e.p.name, e })), { placeHolder: 'Sessions of which agent?' }))?.e;
}

/**
 * Open (or recent) sessions with their context; "Show all" expands; per-row details and delete buttons.
 * The title-bar Back button returns from "all" to "open", then to `back` (the menu) when given.
 */
async function showSessions(id?: string, back?: () => void, initial: SessionScope = 'open') {
  const e = await pickProvider(id);
  if (!e) return;
  const { p } = e;
  const qp = vscode.window.createQuickPick<SessionItem>();
  qp.title = `${p.name} sessions`;
  qp.matchOnDescription = qp.matchOnDetail = true;
  // Clicking outside closes the list (Esc would also reach the agent's panel). Kept open only behind our own dialogs.
  const keepOpen = async <T>(dialog: Promise<T>): Promise<T> => {
    qp.ignoreFocusOut = true;
    try { return await dialog; } finally { qp.ignoreFocusOut = false; }
  };
  let scope = initial;

  const load = async () => {
    qp.busy = true;
    let list: SessionEntry[] = [];
    try { list = await p.listSessions!(pctx, scope); } catch { /* shown as empty */ }
    const items: SessionItem[] = list.map(s => ({
      label: (windowTerminalFor(s) ? '$(terminal) ' : '') + s.title,
      description: sessionDesc(s),
      detail: s.cwd,
      buttons: p.deleteSession && !s.live ? [INFO, TRASH] : [INFO],
      s,
    }));
    const t = vscode.window.activeTerminal;
    const here = t && items.find(i => i.s && windowTerminalFor(i.s) === t);
    if (scope === 'open') {
      items.unshift({ label: p.openSessionsLabel ?? 'Open', kind: vscode.QuickPickItemKind.Separator });
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, { label: '$(history) Show all sessions', showAll: true });
    }
    qp.items = items;
    // Starts on the session of the active terminal, the one you are most likely asking about.
    if (here) qp.activeItems = [here];
    qp.buttons = [
      ...(scope === 'all' || back ? [vscode.QuickInputButtons.Back] : []),
      ...(p.deleteSession ? [DELETE_MANY] : []),
    ];
    qp.placeholder = scope === 'open'
      ? `${list.length} session(s). Enter: its terminal, else details. (i): details${p.deleteSession ? ', trash: delete' : ''}`
      : `All ${p.name} sessions (${list.length})`;
    qp.busy = false;
  };

  qp.onDidAccept(() => {
    const it = qp.selectedItems[0];
    if (it?.showAll) { scope = 'all'; void load(); return; }
    if (!it?.s) return;
    // Already running in this window: go there rather than offer to start it a second time.
    const t = windowTerminalFor(it.s);
    if (t) { qp.hide(); t.show(); } else void keepOpen(showDetails(it.s, e));
  });
  qp.onDidTriggerButton(b => {
    if (b === DELETE_MANY) { qp.hide(); void deleteMany(e, () => showSessions(p.id, back, scope)); return; }
    if (b !== vscode.QuickInputButtons.Back) return;
    if (scope === 'all') { scope = 'open'; void load(); } else if (back) { qp.hide(); back(); }
  });
  qp.onDidTriggerItemButton(async ({ item, button }) => {
    if (!item.s) return;
    if (button === INFO) await keepOpen(showDetails(item.s, e));
    else if (button === TRASH && await keepOpen(confirmDelete(p, item.s))) { await load(); refresh(e); }
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
  await load();
}

/** Checkbox list of every deletable (not open) session, newest first; one confirmation for the whole selection. */
async function deleteMany(e: Entry, back?: () => void) {
  const { p } = e;
  if (!p.deleteSession || !p.listSessions) return;
  type Item = vscode.QuickPickItem & { s: SessionEntry };
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = `Delete ${p.name} sessions`;
  qp.canSelectMany = true;
  qp.matchOnDescription = qp.matchOnDetail = true;
  qp.buttons = back ? [vscode.QuickInputButtons.Back] : [];
  qp.busy = true;
  qp.onDidHide(() => qp.dispose());
  qp.onDidTriggerButton(b => { if (b === vscode.QuickInputButtons.Back) { qp.hide(); back?.(); } });
  qp.onDidAccept(async () => {
    const picked = qp.selectedItems.map(i => i.s);
    if (!picked.length) return;
    qp.ignoreFocusOut = true;
    const ok = await vscode.window.showWarningMessage(
      `Delete ${picked.length} ${p.name} session(s)?`,
      { modal: true, detail: picked.slice(0, 15).map(s => `• ${s.title}`).join('\n')
          + (picked.length > 15 ? `\n… and ${picked.length - 15} more` : '')
          + '\n\nThis permanently deletes them and cannot be undone.' },
      'Delete');
    qp.ignoreFocusOut = false;
    if (ok !== 'Delete') return;
    qp.hide();
    const failed: string[] = [];
    for (const s of picked) {
      try { await p.deleteSession!(s, pctx); } catch (err: any) { failed.push(`${s.title}: ${err?.message ?? err}`); }
    }
    refresh(e);
    treeChanged.fire();
    reloadProjectsNow();
    if (failed.length) {
      vscode.window.showErrorMessage(`Could not delete ${failed.length} of ${picked.length} session(s)`, { modal: true, detail: failed.join('\n') });
    } else {
      vscode.window.setStatusBarMessage(`Agent Sessions: deleted ${picked.length} ${p.name} session(s)`, 4000);
    }
    back?.();
  });
  qp.show();

  let list: SessionEntry[] = [];
  try { list = await p.listSessions(pctx, 'all'); } catch { /* shown as empty */ }
  // A session we are running in a terminal is open whatever the agent reports: see confirmDelete.
  const deletable = list.filter(s => !s.live && !terminalFor(s));
  qp.items = deletable.map(s => ({ label: s.title, description: sessionDesc(s), detail: s.cwd, s }));
  qp.placeholder = `${deletable.length} closed session(s). Tick the ones to delete, then Enter`
    + (list.length > deletable.length ? ` (${list.length - deletable.length} open session(s) not listed)` : '');
  qp.busy = false;
}

async function showDetails(s: SessionEntry, e?: Entry) {
  const t = windowTerminalFor(s);
  const lines = [
    `Context used: ${pct(s.ctxUsed)}`,
    s.contextDetail,
    `Last activity: ${new Date(s.mtime).toLocaleString()} (${ago(s.mtime)})`,
    s.live ? 'Status: running' : undefined,
    s.source ? `Started from: ${s.source}` : undefined,
    s.cwd ? `Folder: ${s.cwd}` : undefined,
    t ? `Terminal: ${t.name}` : undefined,
    `Session id: ${s.id}`,
  ];
  // Open in the agent's own app or panel: we cannot reach that one, but the user may still want it here, so the
  // dialog says where it is and lets them decide rather than silently offering nothing. One of this window's
  // terminals is reachable, so that one is offered instead.
  const elsewhere = s.live && !t && !!e?.p.terminal;
  const detail = lines.filter(Boolean).join('\n')
    + (elsewhere ? `\n\nThis conversation is already open in ${s.source ?? 'another process'}. Resuming it here starts a`
      + ' second process on the same conversation, which the agent may refuse while the other one holds it.' : '');
  // A modal's text cannot be selected with the mouse, so what is worth taking away gets a button instead.
  const OPEN = 'Open folder', PATH = 'Copy path', ID = 'Copy id', RESUME = 'Resume here anyway', GO = 'Go to terminal';
  const pick = await vscode.window.showInformationMessage(s.title, { modal: true, detail },
    ...(t ? [GO] : []), ...(elsewhere ? [RESUME] : []), ...(s.cwd ? [OPEN, PATH] : []), ID);
  if (!pick) return;
  if (pick === GO) return t!.show();
  if (pick === RESUME) return launch(e!, s.cwd, s);
  if (pick === OPEN) return void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(s.cwd!));
  await vscode.env.clipboard.writeText(pick === PATH ? s.cwd! : s.id);
  vscode.window.setStatusBarMessage(`Agent Sessions: ${pick === PATH ? 'folder path' : 'session id'} copied`, 3000);
}


async function confirmDelete(p: Provider, s: SessionEntry): Promise<boolean> {
  // The agent's own "is it open" signal can lag behind -- Codex holds its writer lock only while it writes -- so
  // a running session can look closed. Whether we started a terminal for it is the one thing we know for certain.
  const t = terminalFor(s);
  const ok = await vscode.window.showWarningMessage(
    t ? `This ${p.name} session is open in a terminal. Close it and delete?`
      : `Are you sure you want to delete this ${p.name} session?`,
    {
      modal: true,
      detail: `${s.title}${s.cwd ? '\n' + s.cwd : ''}\n\n`
        + (t ? `"${t.name}" is closed first, which ends the session.\n\n` : '')
        + 'This permanently deletes it and cannot be undone.',
    },
    t ? 'Close and delete' : 'Delete');
  if (!ok) return false;
  if (t) {
    t.dispose();
    // The agent lets go of its files as it exits; deleting while it is still up fails (Codex refuses a locked thread).
    await new Promise(r => setTimeout(r, 1500));
  }
  try {
    await p.deleteSession!(s, pctx);
    vscode.window.setStatusBarMessage(`Agent Sessions: deleted ${p.name} session`, 4000);
    return true;
  } catch (err: any) {
    vscode.window.showErrorMessage(`Could not delete ${p.name} session`, { modal: true, detail: `${s.title}: ${err?.message ?? err}` });
    return false;
  }
}
