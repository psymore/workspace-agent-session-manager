import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  clampPct, remaining, toMs, parseJson, readJsonFile, mtime, listDir,
  scanBackward, readHead, grabString, inWorkspace, fallbackTitle, pidAlive, norm, appendJsonLine,
} from '../util';
import { Focus, Provider, Snapshot, SessionEntry, SessionScope } from '../api';
import { dataFile, dirOf, liveLimitsState } from './statusline';

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
export const LIVE_DIR = path.join(CLAUDE_DIR, 'sessions');
/** Ours, not Claude Code's: archived transcripts are moved here (same <project>/<id>.jsonl layout) and back. */
export const ARCHIVE_DIR = path.join(CLAUDE_DIR, 'archived-sessions');
/** Written by the "vscode-claude-status" extension (long-kudo) from Anthropic rate-limit headers. */
export const STATUS_CACHE_NAME = 'vscode-claude-status-cache.json';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Claude Code names project dirs by replacing every non-alphanumeric char of the cwd with '-'. */
const encodeCwd = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();

interface Live { sessionId: string; cwd?: string; busy: boolean; pid: number; at: number; source?: string }

/** `cli` is a plain terminal, which says nothing; the VS Code panel is worth showing, since we cannot reach it. */
const sourceOf = (entry?: unknown) =>
  entry === 'claude-vscode' ? 'Claude panel' : typeof entry === 'string' && entry !== 'cli' ? entry : undefined;

/** Sessions of currently running Claude Code processes (~/.claude/sessions/<pid>.json). */
function liveSessions(): Live[] {
  const out: Live[] = [];
  for (const f of listDir(LIVE_DIR)) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(LIVE_DIR, f);
    const j = readJsonFile(file);
    if (typeof j?.sessionId === 'string' && UUID.test(j.sessionId) && pidAlive(j.pid)) {
      const at = [j.updatedAt, j.startedAt, mtime(file)].find(n => typeof n === 'number') ?? Date.now();
      out.push({
        sessionId: j.sessionId, cwd: typeof j.cwd === 'string' ? j.cwd : undefined,
        busy: j.status === 'busy', pid: j.pid, at, source: sourceOf(j.entrypoint),
      });
    }
  }
  return out;
}

function findActiveTranscript(folders: string[], focus?: Focus): { file?: string; cwd?: string; id?: string } | undefined {
  const dirs = listDir(PROJECTS_DIR);
  const dirFor = (cwd: string) => dirs.find(d => d.toLowerCase() === encodeCwd(cwd));
  const cands: { file: string; cwd?: string; m: number; id?: string; pid?: number }[] = [];

  for (const s of liveSessions()) {
    const preferred = s.cwd ? dirFor(s.cwd) : undefined;
    for (const d of preferred ? [preferred, ...dirs] : dirs) {
      const file = path.join(PROJECTS_DIR, d, s.sessionId + '.jsonl');
      const m = mtime(file);
      if (m !== undefined) { cands.push({ file, cwd: s.cwd, m, id: s.sessionId, pid: s.pid }); break; }
    }
  }
  // Always collect the workspace's own transcripts too: a repo whose sessions are all closed should still
  // report its newest one, rather than falling silent because another repo happens to have a running session.
  {
    const seen = new Set(cands.map(c => c.file));
    for (const f of folders) {
      const d = dirFor(f);
      if (!d) continue;
      for (const name of listDir(path.join(PROJECTS_DIR, d))) {
        if (!name.endsWith('.jsonl')) continue;
        const file = path.join(PROJECTS_DIR, d, name);
        const m = mtime(file);
        if (m !== undefined && !seen.has(file)) cands.push({ file, cwd: f, m });
      }
    }
  }
  cands.sort((a, b) => b.m - a.m);
  const hit = focus && (cands.find(c => focus.sessionId && c.id === focus.sessionId)
    ?? cands.find(c => focus.pid !== undefined && c.pid === focus.pid)
    ?? cands.find(c => focus.cwd && c.cwd && norm(c.cwd) === norm(focus.cwd)));
  if (hit) return hit;
  // The focused session may have no transcript yet (Claude Code writes one on the first message). Reporting
  // another session's number under that terminal would be worse than reporting none, so claim it without data.
  const bare = focus && liveSessions().find(l => (focus.sessionId && l.sessionId === focus.sessionId)
    || (focus.pid !== undefined && l.pid === focus.pid));
  if (bare) return { cwd: bare.cwd, id: bare.sessionId };
  // A session from another repo is not the one you are looking at: better no number than someone else's.
  // With no folder open there is nothing to be relative to, so the newest session still wins.
  const ws = cands.filter(c => inWorkspace(c.cwd, folders));
  return folders.length ? ws[0] : cands[0];
}

/**
 * The title Claude Code writes into the transcript; several sessions in one repo are told apart by it. A name the
 * user gave (/rename, or ours) beats the generated one, even when Claude Code generates a new one later.
 */
function transcriptTitle(file: string): string | undefined {
  let custom: string | undefined, ai: string | undefined;
  scanBackward(file, line => {
    if (!line.includes('-title"')) return false;
    const j = parseJson(line);
    if (j?.type === 'custom-title' && typeof j.customTitle === 'string' && j.customTitle) custom = j.customTitle;
    else if (j?.type === 'ai-title' && typeof j.aiTitle === 'string' && j.aiTitle) ai ??= j.aiTitle;
    return !!custom;
  }, 512 * 1024);
  return custom ?? ai;
}

function contextWindowFor(model: string, windows: Record<string, number>, reported?: number): number | undefined {
  if (typeof reported === 'number' && reported > 0) return reported;
  if (/\[1m\]$/i.test(model)) return 1_000_000;
  let best: string | undefined;
  for (const k of Object.keys(windows)) {
    if (model.startsWith(k) && (!best || k.length > best.length)) best = k;
  }
  const w = best ? windows[best] : undefined;
  return typeof w === 'number' && w > 0 ? w : undefined;
}

export interface SessionContext { ctxUsed?: number; detail?: string; note?: string }

/** Context used by a transcript's main chain: last assistant usage ÷ the model's context window. */
function sessionContext(file: string, windows: Record<string, number>, reported: Record<string, number> = {}): SessionContext {
  let usage: any;
  let model = '';
  let compacted = false;
  scanBackward(file, line => {
    if (line.includes('"compact_boundary"')) {
      const j = parseJson(line);
      if (j?.type === 'system' && j.subtype === 'compact_boundary') return (compacted = true); // no new usage yet
    }
    if (!line.includes('"usage"')) return false;
    const j = parseJson(line);
    const u = j?.message?.usage;
    if (j?.type !== 'assistant' || j.isSidechain || !u || j.message.model === '<synthetic>') return false;
    usage = u;
    model = String(j.message.model ?? '');
    return true;
  });
  if (!usage) return { note: compacted ? 'Just compacted; waiting for the next reply' : undefined };
  const n = (v: unknown) => (typeof v === 'number' && v >= 0 ? v : 0);
  const tokens = n(usage.input_tokens) + n(usage.cache_creation_input_tokens) + n(usage.cache_read_input_tokens);
  const win = contextWindowFor(model, windows, reported[model]);
  if (!win) return { detail: `${tokens.toLocaleString()} tokens · ${model}`, note: `Context window unknown for ${model || 'model'} (set workspaceAgentSessions.claudeContextWindows)` };
  if (tokens <= 0 || tokens > win) return { detail: model };
  return { ctxUsed: (tokens / win) * 100, detail: `${tokens.toLocaleString()} / ${win.toLocaleString()} tokens · ${model}` };
}

export interface Limits { at: number; source: string; five?: number; fiveReset?: number; week?: number; weekReset?: number }

function limitsFromCacheFile(name: string, source: string): Limits | undefined {
  const file = path.join(CLAUDE_DIR, name);
  const j = readJsonFile(file);
  const u = j?.usageData;
  if (!u || typeof u !== 'object') return undefined;
  // utilization values are fractions (0..1) of the allowance consumed
  const frac = (v: unknown) => (typeof v === 'number' && v >= 0 && v <= 1.5 ? v * 100 : undefined);
  const at = toMs(j.updatedAt) ?? mtime(file);
  if (at === undefined) return undefined;
  return {
    at, source,
    five: frac(u.utilization5h), fiveReset: toMs(u.reset5hAt),
    week: frac(u.utilization7d), weekReset: toMs(u.reset7dAt),
  };
}

/** Claude Code's status line input, saved by our script (see statusline.ts). Percentages 0-100, resets in epoch s. */
function limitsFromStatusLine(j: any, at: number | undefined): Limits | undefined {
  const rl = j?.rate_limits;
  if (!rl || typeof rl !== 'object' || at === undefined) return undefined;
  return {
    at, source: 'Claude Code status line',
    five: clampPct(rl.five_hour?.used_percentage), fiveReset: toMs(rl.five_hour?.resets_at),
    week: clampPct(rl.seven_day?.used_percentage), weekReset: toMs(rl.seven_day?.resets_at),
  };
}

function limitsFromUsageReport(j: any): Limits | undefined {
  const arr = j?.usageReport?.rate_limits?.limits;
  const at = toMs(j?.timestamp);
  if (!Array.isArray(arr) || at === undefined) return undefined;
  const five = arr.find((l: any) => l?.kind === 'session');
  const week = arr.find((l: any) => l?.kind === 'weekly_all');
  return {
    at, source: '/usage report',
    five: clampPct(five?.percent), fiveReset: toMs(five?.resets_at),
    week: clampPct(week?.percent), weekReset: toMs(week?.resets_at),
  };
}

/** Limits the user copied from /usage, for those who would rather not run our status line script. */
const PASTED_NAME = 'usage-pasted.json';
const pastedFile = () => path.join(dirOf(CLAUDE_DIR), PASTED_NAME);

export function savePastedLimits(l: Limits) {
  fs.mkdirSync(dirOf(CLAUDE_DIR), { recursive: true });
  fs.writeFileSync(pastedFile(), JSON.stringify(l, null, 2));
}

function limitsFromPasted(): Limits | undefined {
  const j = readJsonFile(pastedFile());
  // Only copied dialogs: "/usage (typed)" readings from the dropped manual entry (0.30.2-0.30.5) are ignored.
  if (typeof j?.at !== 'number' || j.source !== '/usage (pasted)') return undefined;
  return { at: j.at, source: j.source, five: clampPct(j.five), fiveReset: toMs(j.fiveReset), week: clampPct(j.week), weekReset: toMs(j.weekReset) };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "9pm (Europe/Istanbul)", "9:30pm", "Oct 11, 3pm", "Oct 11 at 3pm" → epoch ms, the next such moment. Local time. */
function resetTime(s: string, now: number): number | undefined {
  const t = /(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)/i.exec(s);
  if (!t) return undefined;
  const d = new Date(now);
  if (t[1]) {
    const mon = MONTHS.indexOf(t[1].toLowerCase());
    if (mon < 0) return undefined;
    d.setMonth(mon, Number(t[2]));
  }
  d.setHours(Number(t[3]) % 12 + (t[5].toLowerCase() === 'pm' ? 12 : 0), Number(t[4] ?? 0), 0, 0);
  // Without a date it is the next such time. With one, only a date far behind is next year's (Dec → Jan); a
  // recent one means old text, whose window has rolled over since, and getClaude treats it as such.
  if (!t[1] && d.getTime() < now - 60_000) d.setDate(d.getDate() + 1);
  if (t[1] && d.getTime() < now - 180 * 86_400_000) d.setFullYear(d.getFullYear() + 1);
  return d.getTime();
}

/**
 * Claude Code's /usage dialog copied from the terminal: a "Current session" and a "Current week (all models)" block,
 * each with "N% used" and "Resets <time>". Newlines may be lost on the way, so blocks are cut at the next heading,
 * not at a line.
 */
export function parseUsageText(text: string, now = Date.now()): Limits | undefined {
  const block = (title: RegExp) => {
    const m = title.exec(text);
    if (!m) return undefined;
    const rest = text.slice(m.index + m[0].length);
    const end = rest.search(/Current (session|week)/i);
    const part = end >= 0 ? rest.slice(0, end) : rest;
    const used = /(\d+(?:\.\d+)?)\s*%\s*used/i.exec(part);
    const reset = /Resets\s+([^\r\n]+)/i.exec(part);
    return { used: used ? clampPct(Number(used[1])) : undefined, reset: reset ? resetTime(reset[1], now) : undefined };
  };
  const s = block(/Current session/i), w = block(/Current week \(all models\)/i);
  if (s?.used === undefined && w?.used === undefined) return undefined;
  return { at: now, source: '/usage (pasted)', five: s?.used, fiveReset: s?.reset, week: w?.used, weekReset: w?.reset };
}

export function getClaude(folders: string[], windows: Record<string, number>, maxAgeMin = 60, focus?: Focus): Snapshot {
  if (!fs.existsSync(CLAUDE_DIR)) return { available: false };
  const snap: Snapshot = { available: true };

  const active = findActiveTranscript(folders, focus);
  let report: Limits | undefined;
  let reportedWindows: Record<string, number> = {};
  const line = readJsonFile(dataFile(CLAUDE_DIR));
  // The status line also names the window of the model it ran on, which spares a settings entry for new models.
  const lineModel = line?.model?.id, lineWin = line?.context_window?.context_window_size;
  if (typeof lineModel === 'string' && typeof lineWin === 'number') reportedWindows[lineModel] = lineWin;
  // Named even without a transcript, so the panel says which session the (missing) number belongs to.
  if (active) {
    const id = active.id ?? (active.file ? path.basename(active.file, '.jsonl') : '');
    snap.sessionId = id || undefined;
    snap.session = (active.file ? transcriptTitle(active.file) : undefined) ?? fallbackTitle(id, active.cwd);
  }
  if (active?.file) {
    // Opportunistic: a recent /usage report has first-party limits and context-window sizes.
    scanBackward(active.file, line => {
      if (!line.includes('"usageReport"')) return false;
      const j = parseJson(line);
      if (!j?.usageReport) return false;
      report = limitsFromUsageReport(j);
      const mu = j.usageReport.session?.model_usage;
      if (mu && typeof mu === 'object') {
        for (const [k, v] of Object.entries<any>(mu)) if (typeof v?.contextWindow === 'number') reportedWindows[k] ??= v.contextWindow;
      }
      return true;
    }, 2 * 1024 * 1024);

    const c = sessionContext(active.file, windows, reportedWindows);
    snap.ctxUsed = c.ctxUsed;
    snap.note = c.note;
  }

  // Old readings understate usage (it only grows within a window), so they are shown but marked stale, never hidden.
  const sources = [
    limitsFromStatusLine(line, mtime(dataFile(CLAUDE_DIR))),
    limitsFromCacheFile(STATUS_CACHE_NAME, 'vscode-claude-status cache'),
    limitsFromPasted(),
    report,
  ].filter((l): l is Limits => !!l).sort((a, b) => b.at - a.at);
  const lim = sources[0];
  if (!lim || Date.now() - lim.at > maxAgeMin * 60_000) {
    const hint = liveLimitsState(CLAUDE_DIR) === 'on'
      ? 'Live limits update while Claude Code runs in a terminal (the VS Code panel runs no status line)'
      : 'For live 5h / weekly numbers, turn on "Live Claude limits" in the Agent Sessions menu, or paste /usage there';
    snap.note = snap.note ? `${snap.note}\n${hint}` : hint;
  }
  if (lim) {
    const now = Date.now();
    snap.limitsAt = lim.at;
    snap.limitsSource = lim.source;
    snap.limitsStale = now - lim.at > maxAgeMin * 60_000;
    // A window whose reset time has passed has rolled over: nothing used in it yet that we know of.
    if (lim.fiveReset === undefined || lim.fiveReset > now) { snap.fiveLeft = remaining(lim.five); snap.fiveReset = lim.fiveReset; }
    else if (lim.five !== undefined) snap.fiveLeft = 100;
    if (lim.weekReset === undefined || lim.weekReset > now) { snap.weekLeft = remaining(lim.week); snap.weekReset = lim.weekReset; }
    else if (lim.week !== undefined) snap.weekLeft = 100;
  }
  return snap;
}

export function listClaudeSessions(scope: SessionScope, windows: Record<string, number>): SessionEntry[] {
  const live = new Map(liveSessions().map(s => [s.sessionId, s]));
  const base = scope === 'archived' ? ARCHIVE_DIR : PROJECTS_DIR;
  const out: SessionEntry[] = [];
  const seen = new Set<string>();
  for (const d of listDir(base)) {
    const dir = path.join(base, d);
    for (const name of listDir(dir)) {
      const id = name.slice(0, -'.jsonl'.length);
      if (!name.endsWith('.jsonl') || !UUID.test(id) || (scope === 'open' && !live.has(id))) continue;
      seen.add(id);
      const file = path.join(dir, name);
      const m = mtime(file);
      if (m === undefined) continue;
      const title = transcriptTitle(file);
      const c = sessionContext(file, windows);
      const cwd = grabString(readHead(file, 16 * 1024), 'cwd') ?? d;
      out.push({
        id, title: title || fallbackTitle(id, cwd), cwd, mtime: m, file, live: live.has(id), busy: live.get(id)?.busy, pid: live.get(id)?.pid,
        ctxUsed: c.ctxUsed, contextDetail: c.detail ?? c.note, source: live.get(id)?.source,
      });
    }
  }
  // Claude Code writes the transcript only once a session has a first message, so a just-opened
  // session has none. List it anyway, or the view's "open" count disagrees with the running processes.
  if (scope !== 'archived') {
    const dirs = listDir(PROJECTS_DIR);
    for (const s of live.values()) {
      if (seen.has(s.sessionId)) continue;
      const enc = s.cwd ? encodeCwd(s.cwd) : undefined;
      const dir = enc ? dirs.find(d => d.toLowerCase() === enc) ?? enc : '';
      out.push({
        id: s.sessionId, title: fallbackTitle(s.sessionId, s.cwd), cwd: s.cwd, mtime: s.at,
        file: path.join(PROJECTS_DIR, dir, s.sessionId + '.jsonl'), live: true, busy: s.busy, pid: s.pid, source: s.source,
      });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** The transcript path of a closed session, validated to be <base>/<project>/<id>.jsonl. */
function closedTranscript(s: SessionEntry, base: string): string {
  const file = path.resolve(s.file);
  if (!UUID.test(s.id) || path.basename(file) !== s.id + '.jsonl' || path.dirname(path.dirname(file)) !== path.resolve(base)) {
    throw new Error('Refusing to touch unexpected path: ' + file);
  }
  if (liveSessions().some(l => l.sessionId === s.id)) throw new Error('Session is open in Claude Code; close it first');
  return file;
}

const inArchive = (s: SessionEntry) => path.dirname(path.dirname(path.resolve(s.file))) === path.resolve(ARCHIVE_DIR);

/** Deletes a transcript and its sibling folder (subagent transcripts, tool results). */
export function deleteClaudeSession(s: SessionEntry): void {
  const file = closedTranscript(s, inArchive(s) ? ARCHIVE_DIR : PROJECTS_DIR);
  fs.rmSync(file, { force: true });
  fs.rmSync(file.slice(0, -'.jsonl'.length), { recursive: true, force: true });
}

/** Appends the same line Claude Code's own /rename does; the newest custom title wins. */
export function renameClaudeSession(s: SessionEntry, title: string): void {
  const file = closedTranscript(s, inArchive(s) ? ARCHIVE_DIR : PROJECTS_DIR);
  if (!fs.existsSync(file)) throw new Error('No transcript yet: send a first message, then rename');
  appendJsonLine(file, { type: 'custom-title', customTitle: title, sessionId: s.id });
}

/** Moves a transcript and its sibling folder between projects/ and archived-sessions/. */
function moveClaudeSession(s: SessionEntry, from: string, to: string): void {
  const file = closedTranscript(s, from);
  const dest = path.join(to, path.basename(path.dirname(file)));
  fs.mkdirSync(dest, { recursive: true });
  fs.renameSync(file, path.join(dest, s.id + '.jsonl'));
  const sib = file.slice(0, -'.jsonl'.length);
  if (fs.existsSync(sib)) fs.renameSync(sib, path.join(dest, s.id));
}

/** Claude Code's installer puts the CLI in ~/.local/bin; the VS Code extension bundles its own copy. */
function claudeExe(extensionPath?: string): string {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const cands = [path.join(os.homedir(), '.local', 'bin', exe)];
  if (extensionPath) cands.push(path.join(extensionPath, 'resources', 'native-binary', exe));
  return cands.find(p => fs.existsSync(p)) ?? 'claude';
}

export const claude: Provider = {
  id: 'claude',
  name: 'Claude',
  watch: [
    { path: PROJECTS_DIR, recursive: true, filter: f => f.endsWith('.jsonl') },
    { path: LIVE_DIR },
    { path: CLAUDE_DIR, filter: f => f === STATUS_CACHE_NAME || f === 'settings.json' },
    { path: dirOf(CLAUDE_DIR), filter: f => f === 'statusline.json' || f === PASTED_NAME },
  ],
  read: ctx => getClaude(ctx.folders, ctx.setting<Record<string, number>>('claudeContextWindows') ?? {}, ctx.setting<number>('claudeLimitsMaxAgeMinutes'), ctx.focus),
  openSessionsLabel: 'Open in Claude Code',
  listSessions: (ctx, scope) => listClaudeSessions(scope, ctx.setting<Record<string, number>>('claudeContextWindows') ?? {}),
  deleteSession: s => deleteClaudeSession(s),
  terminal: (ctx, _cwd, resumeId, o = {}) => ({
    shellPath: claudeExe(ctx.extensionPath('anthropic.claude-code')),
    // Files go in the prompt as @mentions, which Claude Code reads itself.
    shellArgs: [
      ...(resumeId ? ['--resume', resumeId] : []),
      ...(o.model ? ['--model', o.model] : []),
      ...(o.effort ? ['--effort', o.effort] : []),
      ...(o.files?.length ? [o.files.map(f => `@${f}`).join(' ')] : []),
    ],
  }),
  launchChoices: { models: ['opus', 'sonnet', 'haiku'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  panelCommand: 'claude-vscode.editor.open',
  slashCommands: [
    { command: '/effort', detail: 'Set the reasoning effort', options: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { command: '/model', detail: 'Switch model' },
    { command: '/status', detail: 'Version, account, connection' },
    { command: '/usage', detail: 'Plan usage and limits' },
    { command: '/context', detail: 'What fills the context window' },
    { command: '/compact', detail: 'Summarize the conversation to free context' },
    { command: '/clear', detail: 'Start over with an empty context' },
    { command: '/resume', detail: 'Switch to another past session' },
    { command: '/rewind', detail: 'Roll back to an earlier point' },
    { command: '/plan', detail: 'Plan mode: no edits until you approve' },
    { command: '/mcp', detail: 'MCP servers: status and sign-in' },
    { command: '/permissions', detail: 'Allow / deny rules for tools' },
    { command: '/memory', detail: 'Edit CLAUDE.md memory files' },
    { command: '/agents', detail: 'Manage subagents' },
    { command: '/todos', detail: 'Current todo list' },
    { command: '/diff', detail: 'Uncommitted changes' },
    { command: '/init', detail: 'Create a CLAUDE.md for this repo' },
    { command: '/rename', detail: 'Rename this session', argument: 'New session name' },
    { command: '/doctor', detail: 'Check the installation' },
    { command: '/help', detail: 'All commands' },
  ],
  renameSession: (s, title) => renameClaudeSession(s, title),
  archiveSession: s => moveClaudeSession(s, PROJECTS_DIR, ARCHIVE_DIR),
  unarchiveSession: s => moveClaudeSession(s, ARCHIVE_DIR, PROJECTS_DIR),
};
