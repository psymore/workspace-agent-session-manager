# Changelog

## 0.30.9

First Marketplace release.

- Status bar: context, 5-hour and weekly usage of Claude Code and OpenAI Codex, following the session in the active terminal; hover for the same bars as the Usage view.
- Usage view: the same numbers as bars, with one context row per open session.
- Projects view: every agent's sessions grouped by repo, with new (agent, model, effort, attached files), resume, close, rename, archive, unarchive and delete. Sessions outside the workspace are listed under *Other folders*.
- Rename any closed session from the Projects view (✎ on the row); open ones in a terminal through the agent's `/rename`.
- The active terminal's session is highlighted in the Projects and Usage views. Sessions already running in one of the window's terminals (also after a window reload, or Claude Code typed into a shell) open that terminal instead of offering to resume them again.
- Sessions list with details and bulk delete.
- Agent terminal toolbar: `/context`, `/usage`, `/compact`, `/model`, mode switch and the agent's slash-command menu.
- Provider API for other extensions to add agents.
- Live Claude limits (opt-in): Claude Code's status line saves its 5h / weekly numbers on every reply, and gives the context window of new models too. Its button is yellow until you choose, then green (on) or dimmed (off), and the script can be read (Show Script) before it is installed.
- A green / yellow / red dot next to each agent in the Usage view: how fresh its 5h / weekly numbers are.
- Claude limits from /usage: no script needed. Copy Claude Code's `/usage` dialog, check what was read, save. The terminal toolbar's `/usage` button leads straight into it.
- Outdated limit readings are drawn fainter, with a `~`.
- Local only: reads the agents' own files and runs their own CLIs. No network requests, no telemetry, never the agents' logins.
