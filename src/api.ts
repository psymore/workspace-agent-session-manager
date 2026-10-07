/**
 * Public provider API. Each AI agent (Claude, Codex, ...) is one Provider.
 *
 * Built-in providers live in src/providers/. Other extensions can add agents at runtime:
 *
 *   const api = await vscode.extensions.getExtension('egeozel.workspace-agent-session-manager')?.activate();
 *   context.subscriptions.push(api.registerProvider({ id: 'gemini', name: 'Gemini', read: () => ({ ... }) }));
 */

/** What a provider reports. Undefined fields render as "—". */
export interface Snapshot {
  /** False when the agent is not installed on this machine (item is hidden). */
  available: boolean;
  ctxUsed?: number;      // % of context window USED
  fiveLeft?: number;     // % of 5h allowance REMAINING
  weekLeft?: number;     // % of weekly allowance REMAINING
  fiveReset?: number;    // epoch ms
  weekReset?: number;    // epoch ms
  session?: string;      // short label of the active session
  /** Id of that session, when the provider could identify it. Lets the UI bind a terminal to a session it started. */
  sessionId?: string;
  limitsAt?: number;     // epoch ms the limit data was observed
  limitsSource?: string;
  /** The limit reading is older than the provider's freshness threshold: shown, but marked as possibly outdated. */
  limitsStale?: boolean;
  note?: string;
}

export interface SessionEntry {
  id: string;
  title: string;
  cwd?: string;
  mtime: number;
  file: string;
  /** Open in a running agent process (e.g. its tab is open). Live sessions are not offered for deletion. */
  live?: boolean;
  /** Live and currently working on a reply (vs. waiting for input). */
  busy?: boolean;
  /** Process id of the agent running this session, when known. */
  pid?: number;
  /** % of this session's context window used. */
  ctxUsed?: number;
  /** One line shown in the details dialog, e.g. "118,994 / 1,000,000 tokens · claude-opus-5-5". */
  contextDetail?: string;
  /** Where the session was started, when it is worth saying: the agent's own app or panel, not a plain terminal. */
  source?: string;
}

/**
 * 'open': sessions currently in use (or recently active, if the agent has no such marker);
 * 'all': every session that is not archived; 'archived': archived sessions only.
 */
export type SessionScope = 'open' | 'all' | 'archived';

/** A process to run in a VS Code terminal (run directly, no shell). */
export interface TerminalSpec {
  shellPath: string;
  shellArgs: string[];
}

/** Choices for a new session. Models are suggestions: the user may type another one. */
/** A model the agent can be started on. Providers may read these from the agent's own catalog. */
export interface LaunchModel {
  id: string;
  /** Shown on the chip instead of `id`. */
  label?: string;
  /** One line about the model, shown while it is selected. */
  detail?: string;
  /** Effort levels this model accepts; when absent or empty, `LaunchChoices.efforts` is offered instead. */
  efforts?: string[];
}

export interface LaunchChoices {
  /** Plain ids, or models carrying their own label and effort levels. */
  models: (string | LaunchModel)[];
  /** Offered for a model that names no efforts of its own. */
  efforts: string[];
}

/** What the user picked for a new session; providers without the matching choice ignore the field. */
export interface LaunchOptions {
  model?: string;
  effort?: string;
  /** Absolute paths. Each provider attaches them as it can (images, `@` mentions, or plain paths in the prompt). */
  files?: string[];
}

/** A slash command of the agent's CLI, offered in the "Commands" menu of its terminal sessions. */
export interface SlashCommand {
  /** e.g. '/compact'. */
  command: string;
  detail: string;
  /** When set, a second pick chooses the argument, e.g. '/effort' + 'high'. */
  options?: string[];
  /** When set, the argument is typed in an input box with this prompt, e.g. '/rename' + a name. */
  argument?: string;
}

/** The session the user is looking at (the active terminal). Any field may be missing. */
export interface Focus {
  sessionId?: string;
  /** Process id of the agent, when the terminal runs it directly. */
  pid?: number;
  /** The terminal's current folder. */
  cwd?: string;
  /** Epoch ms the terminal was started, for agents whose sessions carry no process id (see codex.ts). */
  startedAt?: number;
}

export interface ProviderContext {
  /** Open workspace folders; providers should prefer the session belonging to this window. */
  readonly folders: string[];
  /** When set, providers should report this session if they can find it, before the folders rule. */
  readonly focus?: Focus;
  /** Reads the `workspaceAgentSessions.<key>` setting. */
  setting<T>(key: string): T | undefined;
  /** Install path of another VS Code extension, if installed. */
  extensionPath(extensionId: string): string | undefined;
}

export interface WatchSpec {
  path: string;
  recursive?: boolean;
  /** Receives the changed file name (relative to `path`); return true to refresh. */
  filter?: (fileName: string) => boolean;
}

export interface Provider {
  /** Unique id, e.g. 'claude'. */
  id: string;
  /** Status bar label, e.g. 'Claude'. */
  name: string;
  /** Files/folders whose changes trigger a refresh (a slow poll runs regardless). */
  watch?: WatchSpec[];
  read(ctx: ProviderContext): Snapshot | Promise<Snapshot>;
  /** Enables the sessions list (with per-session context). */
  listSessions?(ctx: ProviderContext, scope: SessionScope): SessionEntry[] | Promise<SessionEntry[]>;
  /** Heading for the 'open' scope, e.g. 'Running' or 'Last 24 hours'. */
  openSessionsLabel?: string;
  /** Enables the delete button in the sessions list. */
  deleteSession?(session: SessionEntry, ctx: ProviderContext): void | Promise<void>;
  /** Enables "new session" and "resume" in a terminal: a new session when `resumeId` is undefined. */
  terminal?(ctx: ProviderContext, cwd: string, resumeId?: string, options?: LaunchOptions): TerminalSpec;
  /** Enables the "New agent session" panel: the models and efforts offered for this agent. */
  launchChoices?: LaunchChoices;
  /** VS Code command that starts a new conversation in the agent's own panel (it uses the first workspace folder). */
  panelCommand?: string;
  /** Enables the "Commands" menu for terminal sessions of this agent. */
  slashCommands?: SlashCommand[];
  /**
   * Enables "Rename" for sessions no process holds (an open one in our terminal is renamed with its slash command).
   * Write the name the way the agent itself does, so the agent shows it too.
   */
  renameSession?(session: SessionEntry, title: string, ctx: ProviderContext): void | Promise<void>;
  /** Enables archiving; archived sessions are listed with the 'archived' scope. */
  archiveSession?(session: SessionEntry, ctx: ProviderContext): void | Promise<void>;
  unarchiveSession?(session: SessionEntry, ctx: ProviderContext): void | Promise<void>;
}

export interface Api {
  registerProvider(provider: Provider): { dispose(): void };
}
