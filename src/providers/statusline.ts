import * as fs from 'fs';
import * as path from 'path';
import { readJsonFile } from '../util';

/**
 * Live Claude limits. Claude Code keeps its 5h / weekly numbers in memory only, but hands them to the user's status
 * line command on every reply (`rate_limits` in its stdin JSON, documented). Opting in points that command at a small
 * script of ours that saves the JSON for claude.ts and prints a summary. Terminal sessions only: the VS Code panel
 * runs no status line.
 */
export const dirOf = (claudeDir: string) => path.join(claudeDir, 'agent-sessions');
/** What the script saves: Claude Code's status line input, as is. */
export const dataFile = (claudeDir: string) => path.join(dirOf(claudeDir), 'statusline.json');
const prevFile = (claudeDir: string) => path.join(dirOf(claudeDir), 'previous-statusline.json');
const settingsFile = (claudeDir: string) => path.join(claudeDir, 'settings.json');
const MARK = 'agent-sessions/statusline.';

const SH = `#!/bin/sh
# Claude Code status line, set up by the Workspace Agent Session Manager VS Code extension ("Live Claude limits").
# Saves what Claude Code passes in, so the extension can show the 5h / weekly limits, then prints a summary.
d=$(dirname "$0")
cat > "$d/statusline.json.$$" && mv -f "$d/statusline.json.$$" "$d/statusline.json"
j=$(tr -d '\\n' < "$d/statusline.json")
pick() { printf '%s' "$j" | sed -n "s/$1/\\\\1/p"; }
n='[[:space:]]*:[[:space:]]*\\([0-9.]*\\)'
ctx=$(pick ".*\\"used_percentage\\"$n[[:space:]]*,[[:space:]]*\\"remaining_percentage\\".*")
five=$(pick ".*\\"five_hour\\"[^}]*\\"used_percentage\\"$n.*")
week=$(pick ".*\\"seven_day\\"[^}]*\\"used_percentage\\"$n.*")
out=''
for p in "ctx:$ctx" "5h:$five" "wk:$week"; do
  v=\${p#*:}; [ -n "$v" ] && out="$out\${out:+ · }\${p%%:*} \${v%%.*}%"
done
printf '%s' "$out"
`;

const PS1 = `# Claude Code status line, set up by the Workspace Agent Session Manager VS Code extension ("Live Claude limits").
# Saves what Claude Code passes in, so the extension can show the 5h / weekly limits, then prints a summary.
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$raw = [Console]::In.ReadToEnd()
$tmp = "$PSScriptRoot\\statusline.json.$PID"
try {
  [IO.File]::WriteAllText($tmp, $raw, (New-Object Text.UTF8Encoding $false))
  Move-Item -Force $tmp "$PSScriptRoot\\statusline.json"
} catch {} finally {
  # The move fails while the file is being read; the next reply writes it again, so just leave no copy behind.
  Remove-Item -Force -ErrorAction SilentlyContinue $tmp
}
try { $j = $raw | ConvertFrom-Json } catch { return }
$out = @()
if ($j.context_window.used_percentage -ne $null) { $out += 'ctx ' + [math]::Floor($j.context_window.used_percentage) + '%' }
if ($j.rate_limits.five_hour) { $out += '5h ' + [math]::Floor($j.rate_limits.five_hour.used_percentage) + '%' }
if ($j.rate_limits.seven_day) { $out += 'wk ' + [math]::Floor($j.rate_limits.seven_day.used_percentage) + '%' }
[Console]::Out.Write($out -join " $([char]0xB7) ")
`;

/** Before the rename to Workspace Agent Session Manager (0.30.3) our folder was `ai-usage-remaining`. */
const LEGACY_DIR = 'ai-usage-remaining';
const ours = (s: any) => typeof s?.command === 'string'
  && (s.command.includes(MARK) || s.command.includes(`${LEGACY_DIR}/statusline.`));

/** 'on', 'off', or the status line command of someone else's that turning on would replace. */
export function liveLimitsState(claudeDir: string): 'on' | 'off' | { other: string } {
  const s = readJsonFile(settingsFile(claudeDir))?.statusLine;
  if (ours(s)) return 'on';
  return typeof s?.command === 'string' ? { other: s.command } : 'off';
}

/** settings.json as an object; throws rather than risk overwriting a file we could not parse. */
function readSettings(claudeDir: string): Record<string, any> {
  let text: string;
  try { text = fs.readFileSync(settingsFile(claudeDir), 'utf8'); } catch { return {}; }
  const j = JSON.parse(text);
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('settings.json is not a JSON object');
  return j;
}

function writeSettings(claudeDir: string, j: Record<string, any>) {
  const file = settingsFile(claudeDir);
  fs.writeFileSync(file + '.tmp', JSON.stringify(j, null, 2) + '\n');
  fs.renameSync(file + '.tmp', file);
}

/**
 * The script for this platform, where it goes and the command settings.json gets, so the user can read all three
 * before turning it on. Claude Code runs the command through Git Bash or PowerShell on Windows; a PowerShell -File
 * works under both.
 */
export function liveLimitsScript(claudeDir: string): { file: string; text: string; command: string; language: string } {
  const win = process.platform === 'win32';
  const file = path.join(dirOf(claudeDir), win ? 'statusline.ps1' : 'statusline.sh');
  // Forward slashes: Git Bash would eat backslashes as escapes.
  const p = file.replace(/\\/g, '/');
  return win
    ? { file, text: PS1, command: `powershell -NoProfile -ExecutionPolicy Bypass -File "${p}"`, language: 'powershell' }
    : { file, text: SH, command: `sh "${p}"`, language: 'shellscript' };
}

function writeScript(claudeDir: string): string {
  const s = liveLimitsScript(claudeDir);
  fs.mkdirSync(dirOf(claudeDir), { recursive: true });
  fs.writeFileSync(s.file, s.text);
  return s.command;
}

/** Points Claude Code's status line at our script; a status line it replaces is kept for disableLiveLimits. */
export function enableLiveLimits(claudeDir: string) {
  const j = readSettings(claudeDir);
  const command = writeScript(claudeDir);
  if (j.statusLine && !ours(j.statusLine)) fs.writeFileSync(prevFile(claudeDir), JSON.stringify(j.statusLine, null, 2));
  j.statusLine = { type: 'command', command, padding: 0 };
  writeSettings(claudeDir, j);
}

export function disableLiveLimits(claudeDir: string) {
  const j = readSettings(claudeDir);
  if (!ours(j.statusLine)) return;
  const prev = readJsonFile(prevFile(claudeDir));
  if (prev && typeof prev === 'object') j.statusLine = prev; else delete j.statusLine;
  writeSettings(claudeDir, j);
  fs.rmSync(prevFile(claudeDir), { force: true });
}

/**
 * Keeps the script current after an extension update. The command in settings.json changes only when it still
 * points at the pre-rename folder: it is ours either way, already agreed to, so it moves without asking. The old
 * folder is ours alone and goes once ours is on, whichever version turned it on; a previous status line saved
 * there is kept unless a newer one exists.
 */
export function refreshLiveLimitsScript(claudeDir: string) {
  if (liveLimitsState(claudeDir) !== 'on') return;
  const command = writeScript(claudeDir);
  const legacy = path.join(claudeDir, LEGACY_DIR);
  const prev = path.join(legacy, path.basename(prevFile(claudeDir)));
  if (fs.existsSync(prev) && !fs.existsSync(prevFile(claudeDir))) fs.copyFileSync(prev, prevFile(claudeDir));
  const j = readSettings(claudeDir);
  if (j.statusLine?.command !== command) {
    j.statusLine = { ...j.statusLine, command };
    writeSettings(claudeDir, j);
  }
  fs.rmSync(legacy, { recursive: true, force: true });
}
