import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const clampPct = (n: unknown): number | undefined =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : undefined;

export const remaining = (usedPct: unknown): number | undefined => {
  const u = clampPct(usedPct);
  return u === undefined ? undefined : 100 - u;
};

/** Seconds or ms epoch, or ISO string → epoch ms. */
export function toMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

export function parseJson(s: string): any {
  try { return JSON.parse(s); } catch { return undefined; }
}

export function readJsonFile(file: string): any {
  try { return parseJson(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

export function mtime(file: string): number | undefined {
  try { return fs.statSync(file).mtimeMs; } catch { return undefined; }
}

export function listDir(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/**
 * Visit a file's lines from the end backwards, stopping when `visit` returns true
 * or after `maxBytes`. Only the tail of the file is read.
 */
export function scanBackward(file: string, visit: (line: string) => boolean, maxBytes = 8 * 1024 * 1024): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const CHUNK = 256 * 1024;
    let pos = fs.fstatSync(fd).size;
    let read = 0;
    let carry = Buffer.alloc(0);
    while (pos > 0 && read < maxBytes) {
      const len = Math.min(CHUNK, pos);
      pos -= len;
      read += len;
      const chunk = Buffer.alloc(len);
      fs.readSync(fd, chunk, 0, len, pos);
      const data = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      let end = data.length;
      let nl = data.lastIndexOf(0x0a, end - 1);
      while (nl >= 0) {
        if (end - nl > 1 && visit(data.toString('utf8', nl + 1, end))) return;
        end = nl;
        nl = end > 0 ? data.lastIndexOf(0x0a, end - 1) : -1;
      }
      carry = data.subarray(0, end);
    }
    if (pos === 0 && carry.length) visit(carry.toString('utf8'));
  } catch {
    // unreadable / vanished file: treat as no data
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** First `bytes` of a file as text (enough for a session header line). */
export function readHead(file: string, bytes = 64 * 1024): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf8', 0, n);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** Appends one JSONL line, starting a new line first if the file does not end with one. */
export function appendJsonLine(file: string, value: unknown): void {
  let sep = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const b = Buffer.alloc(1);
      if (size > 0 && fs.readSync(fd, b, 0, 1, size - 1) === 1 && b[0] !== 0x0a) sep = '\n';
    } finally { fs.closeSync(fd); }
  } catch { /* new file */ }
  fs.appendFileSync(file, sep + JSON.stringify(value) + '\n');
}

/** Extract a top-level-ish string field via regex (for header lines too large to parse). */
export function grabString(text: string, key: string): string | undefined {
  const m = new RegExp(`"${key}":("(?:[^"\\\\]|\\\\.)*")`).exec(text);
  return m ? parseJson(m[1]) : undefined;
}

/** Absolute path without trailing separators; lower-cased on Windows, for comparisons. */
export const norm = (p: string) => {
  const r = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/** True when `cwd` equals or is inside one of the workspace folders. */
export function inWorkspace(cwd: string | undefined, folders: string[]): boolean {
  if (!cwd) return false;
  const c = norm(cwd);
  return folders.some(f => {
    const w = norm(f);
    return c === w || c.startsWith(w + path.sep);
  });
}

export function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number') return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}

/** pid → parent pid of every process, from the OS's own tool (no native module). Empty when it cannot be read. */
export function processParents(): Promise<Map<number, number>> {
  const [cmd, args] = process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }']]
    : ['ps', ['-A', '-o', 'pid=,ppid=']];
  return new Promise(resolve => execFile(cmd, args as string[], { windowsHide: true, timeout: 15000 }, (err, out) => {
    const map = new Map<number, number>();
    if (!err) {
      for (const m of String(out).matchAll(/^\s*(\d+)\s+(\d+)\s*$/gm)) map.set(Number(m[1]), Number(m[2]));
    }
    resolve(map);
  }));
}

/** Title for an unnamed session: its folder name plus a short id. */
export const fallbackTitle = (id: string, cwd?: string) =>
  cwd ? `${path.basename(cwd)} (${id.slice(0, 8)})` : id;
