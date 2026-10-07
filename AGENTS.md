# AGENTS.md — map of this repo

VS Code extension (`egeozel.workspace-agent-session-manager`) that shows context / 5h / weekly usage of local AI coding agents
(Claude Code, OpenAI Codex) in the status bar, and lets the user manage their sessions (list, details, resume,
close, archive, delete), grouped per repo. **Local only**: it reads the agents' files on disk and calls their own
CLIs; no network requests, no telemetry. User-facing docs: [README.md](README.md) (also the Marketplace page).

## Files

| Path | What lives there |
|---|---|
| `src/api.ts` | The `Provider` contract + data types (`Snapshot`, `SessionEntry`, `SessionScope`, `TerminalSpec`). Public: other extensions can register providers. Change it with care. |
| `src/extension.ts` | Everything VS Code-facing: provider registry, refresh loop, status bar items, quick picks, both tree views, commands. |
| `src/providers/claude.ts` | Claude Code: reads `~/.claude` (or `$CLAUDE_CONFIG_DIR`). |
| `src/providers/statusline.ts` | Live Claude limits: installs / removes our Claude Code status line script (no `vscode` import, so node-testable). |
| `src/providers/codex.ts` | Codex: reads `~/.codex` (or `$CODEX_HOME`); mutations go through the `codex` CLI. |
| `src/util.ts` | Small fs/JSON/path helpers (`scanBackward` reads JSONL files from the end, `norm` for path comparisons, `pidAlive`, ...). |
| `package.json` | `contributes`: commands, activity bar container + 2 views, menus (inline buttons via `when` clauses), settings. |
| `CHANGELOG.md` | Release notes, shown on the Marketplace "Changelog" tab. One entry per published version. |
| `images/` | `icon.svg` = source of `icon.png` (render at 256x256); `activity.svg` = the same gauge as a line icon, no `<mask>` (masks render grainy in the activity bar). |
| `out/`, `*.vsix` | Build output (git-ignored). |

## Architecture

```
providers (claude.ts, codex.ts, 3rd-party via Api.registerProvider)
   │  read(ctx) → Snapshot              listSessions(ctx, scope) → SessionEntry[]
   │  watch: WatchSpec[]                delete/archive/unarchiveSession, terminal(...)
   ▼
extension.ts: register(p) → Entry { p, status bar item, watchers, last Snapshot }
   │  fs.watch change → 1.5 s debounce → refresh(e) → render() + treeChanged
   │  fallback poll every `pollSeconds`
   ▼
UI surfaces
   • status bar item per provider (right side)  → click → menu()
   • menu() quick pick → showSessions() / deleteMany()
   • showSessions(): sessions quick pick ('open' ↔ 'all', Back button, per-row (i) / trash, ☑ → deleteMany)
   • deleteMany(): multi-select quick pick of closed sessions + one confirmation
   • "Usage" webview (workspaceAgentSessions.view): per agent, 5h / weekly / context bars; from two open sessions on,
     Context splits into one named row per session (click = its terminal, else details)
   • "Projects" tree (workspaceAgentSessions.projects): sessions of all providers grouped by repo
```

- **Provider isolation**: every provider call is wrapped; one failing provider must never affect another's item.
- **Capabilities are optional**: UI shows an action only if the provider implements it (`listSessions`,
  `deleteSession`, `archiveSession`/`unarchiveSession`, `terminal`). Keep new features capability-driven.
- **Projects view**: repos = workspace folders (or each session's cwd if no folder is open); a session belongs to
  the deepest folder containing its `cwd`. Reloads are coalesced (`reloadProjects`, 3 s) because listing reads every
  transcript. Tree item `contextValue` is a dot-joined flag list (`psession.resume.archive.delete.`) matched by
  regexes in `package.json` menus.
- **Terminals**: "new" / "resume" run the agent CLI directly as the terminal process (`shellPath` = exe, no shell
  quoting) with `cwd` = repo. `launched` maps our terminals to sessions (resumed id, or Claude's pid) so "close"
  can only ever close terminals this extension started. `/clear` / `/resume` move a terminal's process to another
  session: `resolveLaunched` re-reads Claude's id from its pid record; Codex terminals keep their first thread.
- **Other terminals** (`termPids`, `hostTerminal`, `adoptTerminals`): `launched` is in memory, but terminals survive
  a window reload (the pty host keeps the process). A terminal whose own process id equals a live session's pid is
  one of ours (users run agents in a shell), so it is put back into `launched`. An agent typed into a shell is found
  by walking parent pids (`processParents` in util.ts: PowerShell CIM on Windows, `ps` elsewhere; ~0.5 s, so once per
  new pid). Those can be shown (`windowTerminalFor`) but never closed or typed into. Codex has no pid: not covered.
- **Active terminal highlight**: Projects row label `highlights` + `reveal` (needs `getParent`, so the view is a
  `createTreeView`), Usage row `.act`, sessions quick pick `activeItems`. `reveal` only when the active session
  changes, not on every reload (a busy session reloads the tree every few seconds).
- **Focus**: `refresh()` passes `ctx.focus` = the active terminal's session (`focusFor`: our terminals by id/pid/
  start time, any terminal by its shell-integration cwd). Providers pick it first, then fall back to the workspace
  rule. Claude matches by pid; Codex has none, so it matches by `startedAt` (`ownedThread`, see below).
  Refreshes on active-terminal change. Needs VS Code ≥ 1.93 (`Terminal.shellIntegration`).

## Agent data on disk (the non-obvious part)

**Claude Code** (`~/.claude`)
- Transcripts: `projects/<encoded cwd>/<uuid>.jsonl` + optional sibling folder `<uuid>/` (subagents, tool results).
  Encoded cwd = every non-alphanumeric char → `-`.
- Open sessions: `sessions/<pid>.json` = `{ pid, sessionId, cwd, status: 'idle' | 'busy', ... }`, valid while the
  pid is alive. "Open" = a Claude Code process (usually a panel tab) has it loaded. Not time-based.
- 5h / weekly limits are kept in memory only. Claude Code passes them (`rate_limits.five_hour|seven_day`:
  `used_percentage` 0-100, `resets_at` epoch s) to the `statusLine` command's stdin after each reply, documented at
  code.claude.com/docs/en/statusline. Only the terminal UI runs the status line, not the VS Code panel. On Windows the
  command runs via Git Bash, else PowerShell, so ours is a `powershell -File` (works in both); elsewhere `sh`.
  `/usage` in a terminal is an Ink dialog and writes nothing; the text variant that writes `usageReport` to the
  transcript is gated (`isEnabled`, apparently a feature flag; never seen in a transcript as of 2.1.291).
- The no-script alternative (`limitsFromUsage` / `parseUsageText`): the user copies the `/usage` dialog and we read the
  clipboard. Its text, from the 2.1.291 binary: blocks titled "Current session", "Current week (all models)",
  "Current week (<model>)", each with "N% used" and "Resets <time>" ("9pm (Europe/Istanbul)", "Oct 11, 3pm").
  Saved to `agent-sessions/usage-pasted.json`, one more source in `getClaude`. If Claude Code rewords the dialog,
  the parser finds no match and says so (manual entry was tried and dropped: the user found it pointless).
- Rename = append `{ type: "custom-title", customTitle, sessionId }` (what /rename writes). A custom title beats any
  `ai-title`, even a newer one (`transcriptTitle`).
- Archive is **ours**, not Claude's: `archived-sessions/<encoded cwd>/<uuid>.jsonl` (moved, same layout).
- CLI: `~/.local/bin/claude(.exe)`, else the VS Code extension's `resources/native-binary/`. Resume: `--resume <id>`.

**Codex** (`~/.codex`)
- Rollouts: `sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`; first line `session_meta` (cwd, subagent markers).
  Titles: `session_index.jsonl`.
- Open sessions: a running Codex process holds a byte-range lock on `thread-writer-locks/<uuid>.lock` for every
  thread it has loaded; `codex delete/archive` fail while it is held. Detected by a 1-byte read → `EBUSY`
  (Windows only; on macOS/Linux the lock is advisory, so 'open' falls back to "active in the last 24 h").
- Archive: `codex archive|unarchive <id>` moves rollouts to/from `archived_sessions/` (flat).
- Nothing in a rollout identifies the process, so two terminals in one repo cannot be told apart by cwd. `ownedThread`
  uses time instead: a terminal owns the first thread that appeared after it started. Rollout start time comes from
  the file name (**local** time; the stamp inside the file is UTC), and writer locks are counted in because they
  exist before the first message. No thread after the terminal's start = no number, never another session's.
- CLI: bundled with the OpenAI extension (`bin/<os>-<arch>/codex(.exe)`), else `codex` on PATH.
  Always mutate through the CLI so Codex's index stays consistent. Exception: rename. The CLI has none, and Codex's
  own /rename appends `{ id, thread_name, updated_at }` to `session_index.jsonl` (newest line wins), so we do the same.

**Claude Code VS Code panel limitation** (why the Projects view exists): the panel starts sessions in, and lists
sessions of, the **first** workspace folder only, and its commands take no folder argument. Other repos can only
be served via terminal sessions or by opening the repo in its own window (`openInWindow`).

## Rules

- Never delete, archive or move a session that is open (`live`). Providers re-check right before acting.
- Destructive actions always go through a modal confirmation; archive/unarchive are reversible and don't.
- Validate paths before touching files (`closedTranscript` in claude.ts; UUID check in codex.ts).
- Network: none, and no new runtime dependencies. In particular, never call the Claude API with the user's Claude Code
  login (`.credentials.json`): Anthropic's terms forbid third-party tools from using Free/Pro/Max credentials. Claude's
  limits come from our status line script ("Live Claude limits", opt-in), `/usage` reports, and the
  vscode-claude-status cache. `settings.json` is the user's: only touch `statusLine`, only after a modal, and restore
  what was there.
- Match the existing style: terse, small functions, comments only for non-obvious "why".

## Build, install, verify

```
npm install
npx tsc -p .                                   # must be clean
npm run package                                # clean + compile, → workspace-agent-session-manager-<version>.vsix
code --install-extension workspace-agent-session-manager-<version>.vsix --force
```
Then in VS Code: *Developer: Reload Window*. Bump `version` in `package.json` for each install.

Faster while developing: **F5** ("Run Extension", `.vscode/launch.json`) starts `tsc --watch` and opens an Extension
Development Host window running `out/` directly, with breakpoints and `console.log` in the Debug Console. In that
window, Ctrl+R reloads the latest build. It overrides the installed copy there only; other windows keep the `.vsix`.
Package + install only for a release check (the `.vsix` is what users get).

There are no automated tests. Verify provider logic with node against `out/` using a **copy** of the agent's
data: set `CLAUDE_CONFIG_DIR` / `CODEX_HOME` to a temp folder before `require('./out/providers/...')`.
Never experiment on the real `~/.claude` / `~/.codex`.

## Release (Marketplace)

1. Bump `version` in `package.json`, add the entry to `CHANGELOG.md`, make sure README matches the behaviour.
2. `npm run package` and install the `.vsix` once (see above) for a smoke test.
3. Push to GitHub first: vsce rewrites README's relative links to `repository` (`blob/HEAD/...`), so the repo must
   be public or the Marketplace page links 404.
4. `npx vsce publish` (after `npx vsce login egeozel` with an Azure DevOps PAT, scope *Marketplace → Manage*), or
   upload the `.vsix` at https://marketplace.visualstudio.com/manage. Open VSX (Cursor, Windsurf, VSCodium):
   `npx ovsx publish <file>.vsix -p <token>`.

## Open items (as of 0.6.0, 2026-10-05)

Not yet verified inside VS Code (only `tsc` + node checks on copied data were run):
- [ ] Projects view renders per workspace folder; inline buttons appear per the table in README.
- [ ] **+** starts Claude / Codex in a terminal in the right repo; **▶** resumes the right session there.
- [ ] **✕** appears for a session started from the view and closes its terminal (Claude matched by pid:
      assumes `sessions/<pid>.json` pid == terminal `processId`, i.e. `claude.exe` is not a launcher).
- [ ] Archive / unarchive / delete from the view on real (closed) sessions, both agents.

Known limits, candidates for later:
- Listing reads every transcript on each reload; with hundreds of sessions, cache per file by mtime.
- Codex "open" detection is Windows-only (lock read → `EBUSY`); macOS/Linux fall back to "last 24 h".
- Sessions open in the Claude Code panel / Codex app can't be closed from here (by design: only our terminals).
- No automated tests.
- Live Claude limits: verified on Windows in real Claude Code terminal sessions (2026-10-06: "ctx · 5h · wk" under
  the prompt, Usage view source "Claude Code status line · just now"). macOS / Linux (`sh`) only run by hand.
- No `vscode:uninstall` hook: uninstalling with live limits on leaves our status line in place (README says so).
- Terminal matching after a reload: confirmed that our Claude terminals' `claude.exe` is a direct child of the pty
  host (terminal pid == agent pid). The shell case (`claude` typed into pwsh) is untested inside VS Code.

## Gotchas

- Windows PowerShell 5.1 `Get-Content`/`Set-Content` re-encode files (BOM, mangled `—`); edit `package.json`
  with an editor or node, not PowerShell.
- `@types/vscode` is pinned to `~1.93.0`, the same as `engines.vscode`: newer types let `tsc` accept APIs that 1.93
  lacks, and vsce refuses types newer than the engine. Raise both together.
- `when` clause regexes in `package.json` need `\\.` (JSON escape) for a literal dot.
- Never use `agentSessions` as an id: VS Code reserves that view container for its own chat sessions and drops ours
  ("View container 'agentSessions' requires enabledApiProposals: chatSessionsProvider", renderer log). Hence the
  long `workspaceAgentSessions` prefix (0.30.4). Check the renderer log for such warnings after renaming any id.
- Renamed in 0.30.3 (before any release) from "AI Usage Remaining" (`ai-usage-remaining`, prefix `aiUsageRemaining`).
  The public repo `workspace-agent-session-manager` starts at 0.30.9; the earlier history stays in the private
  `ai-usage-remaining` repo. A status line from then points at `~/.claude/ai-usage-remaining/`;
  `refreshLiveLimitsScript` moves it to `agent-sessions/` on activation (`LEGACY_DIR` in statusline.ts).
- A view title button can't change its icon, colour or tooltip at runtime. State shows by swapping commands on a
  context key: `claudeLiveLimitsIsOn` / `IsUnset` / `IsOff` (key `workspaceAgentSessions.liveLimits` = on / unset / off; icons
  `images/pulse-{on,unset,off}-{dark,light}.svg`; "unset" until the user answers once, kept in globalState), all running the same toggle. Codicons can't be coloured in
  menus, so that needs SVGs. Native modal dialogs show plain text only: no icons or colours there.
- Editor "Cannot find name 'fs'/'NodeJS'" errors when the folder isn't opened as the workspace: `tsconfig.json`
  pins `"types": ["node", "vscode"]`; restart the TS server. `tsc` is the source of truth.
