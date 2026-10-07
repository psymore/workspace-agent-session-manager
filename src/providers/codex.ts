import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  remaining, toMs, parseJson, readJsonFile, mtime, listDir, scanBackward, readHead, grabString, inWorkspace, fallbackTitle, norm, appendJsonLine,
} from '../util';
import { Focus, LaunchChoices, LaunchModel, Provider, ProviderContext, Snapshot, SessionEntry, SessionScope } from '../api';

export const CODEX_DIR = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
export const SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');
export const LOCKS_DIR = path.join(CODEX_DIR, 'thread-writer-locks');
/** Where `codex archive` moves rollouts (flat); `codex unarchive` moves them back. */
export const ARCHIVED_DIR = path.join(CODEX_DIR, 'archived_sessions');
/** Codex caches the model catalog its account may use, refreshed by Codex itself. */
export const MODELS_CACHE = path.join(CODEX_DIR, 'models_cache.json');

/**
 * A running Codex process holds a byte-range lock on thread-writer-locks/<id>.lock for every thread it has loaded,
 * and `codex delete` fails for those. Reading a locked range fails with EBUSY on Windows; elsewhere the lock is
 * advisory, so this returns false there.
 */
function threadLoaded(id: string): boolean {
  try {
    const fd = fs.openSync(path.join(LOCKS_DIR, id + '.lock'), 'r');
    try { fs.readSync(fd, Buffer.alloc(1), 0, 1, 0); } finally { fs.closeSync(fd); }
    return false;
  } catch (e: any) {
    return e?.code === 'EBUSY';
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

interface Rollout { file: string; id: string; m: number }
interface Meta { main: boolean; cwd?: string; origin?: string }

/** Header (session_meta) of a rollout never changes, so it is cached per file. */
const metaCache = new Map<string, Meta>();

function meta(file: string): Meta {
  let v = metaCache.get(file);
  if (v) return v;
  const head = readHead(file);
  const first = head.split('\n')[0];
  const p = parseJson(first)?.payload;
  if (p && typeof p === 'object') {
    v = {
      main: !p.parent_thread_id && !(p.source && typeof p.source === 'object' && 'subagent' in p.source),
      cwd: typeof p.cwd === 'string' ? p.cwd : undefined,
      origin: typeof p.originator === 'string' ? p.originator : undefined,
    };
  } else {
    // header longer than the read window: fall back to field extraction
    v = { main: !/"parent_thread_id"|"source":\{"subagent"/.test(first), cwd: grabString(first, 'cwd'), origin: grabString(first, 'originator') };
  }
  if (head) metaCache.set(file, v);
  return v;
}

const NAME_TS = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-/;

/** When the session started, from the rollout's name. It is local time, unlike the UTC stamp inside the file. */
function startedAt(file: string): number | undefined {
  const m = NAME_TS.exec(path.basename(file));
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : undefined;
}

/** Threads a running Codex currently holds a writer lock on, with the time the lock appeared. */
function loadedThreads(): { id: string; at: number }[] {
  const out: { id: string; at: number }[] = [];
  for (const name of listDir(LOCKS_DIR)) {
    if (!name.endsWith('.lock')) continue;
    const id = name.slice(0, -'.lock'.length);
    if (!UUID.test(id) || !threadLoaded(id)) continue;
    let at = 0;
    try { const st = fs.statSync(path.join(LOCKS_DIR, name)); at = st.birthtimeMs || st.mtimeMs; } catch { /* gone */ }
    if (at) out.push({ id, at });
  }
  return out;
}

/**
 * Which thread a terminal owns. Codex rollouts carry no process id, so two terminals in one repo are identical by
 * cwd alone; the thread a terminal owns is the first one that appeared after it started. Writer locks are included
 * because they exist before the first message: a session that has not written a rollout yet still claims its
 * terminal, instead of leaving the terminal to another session's number.
 *
 * `undefined` means no thread started after this terminal, i.e. nothing of ours to report.
 */
function ownedThread(start: number, cwd: string | undefined, mains: Rollout[]): Rollout | undefined {
  const at = new Map<string, number>();
  for (const r of mains) {
    const c = meta(r.file).cwd;
    if (cwd && !(c && norm(c) === norm(cwd))) continue;
    at.set(r.id, startedAt(r.file) ?? r.m);
  }
  for (const l of loadedThreads()) if (!at.has(l.id)) at.set(l.id, l.at);
  const first = [...at].filter(([, t]) => t >= start).sort((a, b) => a[1] - b[1])[0];
  return first && mains.find(r => r.id === first[0]);
}

/** Rollouts in day folders (sessions/YYYY/MM/DD), newest day first, limited to `days` folders. */
function rollouts(days = Infinity): Rollout[] {
  const out: Rollout[] = [];
  let seen = 0;
  const desc = (dir: string, re: RegExp) => listDir(dir).filter(n => re.test(n)).sort().reverse();
  outer: for (const y of desc(SESSIONS_DIR, /^\d{4}$/)) {
    for (const mo of desc(path.join(SESSIONS_DIR, y), /^\d{2}$/)) {
      for (const d of desc(path.join(SESSIONS_DIR, y, mo), /^\d{2}$/)) {
        if (seen++ >= days) break outer;
        const dir = path.join(SESSIONS_DIR, y, mo, d);
        for (const name of listDir(dir)) {
          const r = rolloutIn(dir, name);
          if (r) out.push(r);
        }
      }
    }
  }
  return out.sort((a, b) => b.m - a.m);
}

function rolloutIn(dir: string, name: string): Rollout | undefined {
  const id = /^rollout-.*\.jsonl$/.test(name) ? UUID.exec(name.slice(-42))?.[0] : undefined;
  const file = path.join(dir, name);
  const m = id ? mtime(file) : undefined;
  return id && m !== undefined ? { file, id, m } : undefined;
}

const archivedRollouts = () => listDir(ARCHIVED_DIR)
  .map(n => rolloutIn(ARCHIVED_DIR, n)).filter((r): r is Rollout => !!r).sort((a, b) => b.m - a.m);

/** Context used by a rollout: last token_count's tokens ÷ the model's context window. */
function sessionContext(file: string): { ctxUsed?: number; detail?: string } {
  const out: { ctxUsed?: number; detail?: string } = {};
  scanBackward(file, line => {
    if (!line.includes('"token_count"')) return false;
    const info = parseJson(line)?.payload?.info;
    const used = info?.last_token_usage?.total_tokens;
    const win = info?.model_context_window;
    if (typeof used !== 'number' || typeof win !== 'number' || win <= 0) return false;
    if (used <= win) out.ctxUsed = (used / win) * 100;
    out.detail = `${used.toLocaleString()} / ${win.toLocaleString()} tokens`;
    return true;
  });
  return out;
}

export function getCodex(folders: string[], focus?: Focus): Snapshot {
  if (!fs.existsSync(CODEX_DIR)) return { available: false };
  const snap: Snapshot = { available: true };
  const recent = rollouts(7);

  const mains = recent.filter(r => meta(r.file).main);
  const cwdOf = (r: Rollout) => meta(r.file).cwd;
  const byId = focus?.sessionId ? mains.find(r => r.id === focus.sessionId) : undefined;
  const owned = !byId && focus?.startedAt !== undefined;
  const focused = byId ?? (owned ? ownedThread(focus!.startedAt!, focus!.cwd, mains)
    : focus && mains.find(r => { const c = cwdOf(r); return !!(focus.cwd && c && norm(c) === norm(focus.cwd)); }));
  // Rollouts here also come from the ChatGPT desktop app, so an unrelated repo's thread can easily be the
  // newest one. With a workspace open, only its own sessions count; with none, the newest still wins.
  // A terminal of ours whose thread was not found keeps the empty answer: see ownedThread.
  const ws = mains.filter(r => inWorkspace(cwdOf(r), folders));
  const active = focused ?? (owned ? undefined : folders.length ? ws[0] : mains[0]);
  if (active) {
    const cwd = meta(active.file).cwd;
    snap.sessionId = active.id;
    snap.session = threadNames().get(active.id) || (cwd ? path.basename(cwd) : active.id.slice(0, 8));
    snap.ctxUsed = sessionContext(active.file).ctxUsed;
  }

  // Rate limits are account-wide: take the newest report from any thread.
  for (const r of recent.slice(0, 5)) {
    let found = false;
    scanBackward(r.file, line => {
      if (!line.includes('"rate_limits"')) return false;
      const j = parseJson(line);
      const rl = j?.payload?.type === 'token_count' ? j.payload.rate_limits : undefined;
      if (!rl || typeof rl !== 'object' || (rl.limit_id != null && rl.limit_id !== 'codex')) return false;
      const wins = [rl.primary, rl.secondary].filter(w => w && typeof w === 'object');
      const pick = (minutes: number, fallback: any) =>
        wins.find(w => w.window_minutes === minutes) ?? (fallback && fallback.window_minutes == null ? fallback : undefined);
      const five = pick(300, rl.primary);
      const week = pick(10080, rl.secondary);
      const now = Date.now();
      const fiveReset = toMs(five?.resets_at);
      const weekReset = toMs(week?.resets_at);
      if (five && (fiveReset === undefined || fiveReset > now)) { snap.fiveLeft = remaining(five.used_percent); snap.fiveReset = fiveReset; }
      else if (five) snap.fiveLeft = 100;
      if (week && (weekReset === undefined || weekReset > now)) { snap.weekLeft = remaining(week.used_percent); snap.weekReset = weekReset; }
      else if (week) snap.weekLeft = 100;
      snap.limitsAt = toMs(j.timestamp) ?? r.m;
      snap.limitsSource = 'Codex session log';
      return (found = true);
    }, 4 * 1024 * 1024);
    if (found) break;
  }
  return snap;
}

function threadNames(): Map<string, string> {
  const names = new Map<string, string>();
  let text = '';
  try { text = fs.readFileSync(path.join(CODEX_DIR, 'session_index.jsonl'), 'utf8'); } catch { /* none */ }
  for (const line of text.split('\n')) {
    const j = parseJson(line);
    if (typeof j?.id === 'string' && typeof j.thread_name === 'string') names.set(j.id, j.thread_name);
  }
  return names;
}

/** `codex-tui` is a plain terminal, which says nothing; anything else (the desktop app) is worth showing. */
const sourceOf = (origin?: string) => (!origin || origin === 'codex-tui' ? undefined : origin);

const OPEN_WINDOW_MS = 24 * 3600_000;

/** 'open': active within the last 24 hours, or still loaded in a running Codex process. */
export function listCodexSessions(scope: SessionScope): SessionEntry[] {
  const names = threadNames();
  const since = Date.now() - OPEN_WINDOW_MS;
  return (scope === 'archived' ? archivedRollouts() : rollouts())
    .filter(r => meta(r.file).main)
    .map(r => ({ r, live: threadLoaded(r.id) }))
    .filter(({ r, live }) => scope !== 'open' || live || r.m >= since)
    .map(({ r, live }) => {
      const c = sessionContext(r.file);
      return {
        id: r.id, title: names.get(r.id) || fallbackTitle(r.id, meta(r.file).cwd), cwd: meta(r.file).cwd,
        mtime: r.m, file: r.file, live, ctxUsed: c.ctxUsed, contextDetail: c.detail, source: sourceOf(meta(r.file).origin),
      };
    });
}

/** Codex CLI bundled with the OpenAI VS Code extension, else `codex` on PATH. */
export function findCodexExe(extensionPath?: string): string {
  if (extensionPath) {
    const os_ = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform as string];
    const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch as string];
    const p = path.join(extensionPath, 'bin', `${os_}-${arch}`, process.platform === 'win32' ? 'codex.exe' : 'codex');
    if (os_ && arch && fs.existsSync(p)) return p;
  }
  return 'codex';
}

/** Runs `codex delete|archive|unarchive <id>` so Codex's own session index stays consistent. */
export function runCodexOnSession(exe: string, action: 'delete' | 'archive' | 'unarchive', id: string): Promise<void> {
  if (!new RegExp(`^${UUID.source}$`, 'i').test(id)) return Promise.reject(new Error('Invalid session id'));
  if (threadLoaded(id)) return Promise.reject(new Error('Still loaded in a running Codex window; close Codex (or that window) first'));
  // --force: no TTY for codex's own prompt; the user already confirmed in our modal dialog
  const args = action === 'delete' ? ['delete', '--force', id] : [action, id];
  return new Promise((resolve, reject) => {
    // shell only for a bare `codex` (may be a .cmd shim on Windows); id is a validated UUID
    execFile(exe, args, { timeout: 60_000, windowsHide: true, shell: exe === 'codex' && process.platform === 'win32' },
      (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve()));
  });
}

/**
 * Codex has no CLI command for this. Its own /rename appends to session_index.jsonl and the newest line wins, so this
 * appends the same line, only while no Codex process has the thread loaded.
 */
export function renameCodexSession(s: SessionEntry, title: string): void {
  if (!new RegExp(`^${UUID.source}$`, 'i').test(s.id)) throw new Error('Invalid session id');
  if (threadLoaded(s.id)) throw new Error('Still loaded in a running Codex window; close Codex (or that window) first');
  appendJsonLine(path.join(CODEX_DIR, 'session_index.jsonl'), { id: s.id, thread_name: title, updated_at: new Date().toISOString() });
}

const exe = (ctx: ProviderContext) => findCodexExe(ctx.extensionPath('openai.chatgpt'));

/** Offered when the catalog is unreadable. Codex has no 'minimal' level, whatever its API accepts. */
const FALLBACK_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The models this account may start, newest first, each with the effort levels it actually accepts.
 * Models Codex hides (retired or internal) are left out, so the panel can only offer working combinations.
 */
function codexModels(): LaunchModel[] {
  const list = readJsonFile(MODELS_CACHE)?.models;
  if (!Array.isArray(list)) return [];
  return list
    .filter((m: any) => typeof m?.slug === 'string' && m.visibility !== 'hide')
    .sort((a: any, b: any) => (a.priority ?? Infinity) - (b.priority ?? Infinity))
    .map((m: any) => ({
      id: m.slug,
      label: typeof m.display_name === 'string' ? m.display_name : undefined,
      detail: typeof m.description === 'string' ? m.description : undefined,
      efforts: (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [])
        .map((l: any) => l?.effort).filter((e: any) => typeof e === 'string'),
    }));
}
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

export const codex: Provider = {
  id: 'codex',
  name: 'Codex',
  watch: [{ path: SESSIONS_DIR, recursive: true, filter: f => f.endsWith('.jsonl') }],
  read: ctx => getCodex(ctx.folders, ctx.focus),
  openSessionsLabel: 'Loaded in Codex or active in the last 24 hours',
  listSessions: (_ctx, scope) => listCodexSessions(scope),
  deleteSession: (s, ctx) => runCodexOnSession(exe(ctx), 'delete', s.id),
  terminal: (ctx, _cwd, resumeId, o = {}) => {
    // `resume` takes no --image; images go with a new session only, other files are named in the prompt.
    const images = resumeId ? [] : (o.files ?? []).filter(f => IMAGE.test(f));
    const others = (o.files ?? []).filter(f => !images.includes(f));
    const bin = exe(ctx);
    return {
      shellPath: bin,
      shellArgs: [
        // The copy bundled with the OpenAI extension carries no complete local package: started interactively it
        // exits 1 with "install a packaged Codex CLI". --no-daemon is the fallback it names, and must precede the
        // subcommand. A standalone `codex` on PATH is complete, so it is left on the daemon.
        ...(bin === 'codex' ? [] : ['--no-daemon']),
        ...(resumeId ? ['resume', resumeId] : []),
        ...(o.model ? ['-c', `model="${o.model}"`] : []),
        ...(o.effort ? ['-c', `model_reasoning_effort="${o.effort}"`] : []),
        ...images.flatMap(f => ['-i', f]),
        // `--` ends the variadic --image list so the prompt is not taken as an image.
        ...(others.length ? ['--', `Relevant files: ${others.join(', ')}`] : []),
      ],
    };
  },
  // Read per panel open, so a catalog Codex refreshes in the background is picked up without a reload.
  get launchChoices(): LaunchChoices { return { models: codexModels(), efforts: FALLBACK_EFFORTS }; },
  panelCommand: 'chatgpt.newCodexPanel',
  slashCommands: [
    { command: '/model', detail: 'Switch model and reasoning effort' },
    { command: '/status', detail: 'Session configuration and token usage' },
    { command: '/approvals', detail: 'What Codex may do without asking' },
    { command: '/compact', detail: 'Summarize the conversation to free context' },
    { command: '/new', detail: 'Start a new conversation' },
    { command: '/resume', detail: 'Switch to another past session' },
    { command: '/rename', detail: 'Rename this thread, so it is easier to find when resuming' },
    { command: '/review', detail: 'Review the working tree' },
    { command: '/diff', detail: 'Git diff including untracked files' },
    { command: '/mcp', detail: 'Configured MCP tools' },
    { command: '/init', detail: 'Create an AGENTS.md for this repo' },
  ],
  renameSession: (s, title) => renameCodexSession(s, title),
  archiveSession: (s, ctx) => runCodexOnSession(exe(ctx), 'archive', s.id),
  unarchiveSession: (s, ctx) => runCodexOnSession(exe(ctx), 'unarchive', s.id),
};
