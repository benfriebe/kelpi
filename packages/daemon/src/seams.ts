// Interface contracts between the daemon's modules. Wave-2 agents implement AGAINST these
// seams; the boot module composes them. Widening a seam is fine (add members), changing a
// signature needs orchestrator sign-off because another agent may already be coding to it.

import type { WireMessage } from '@nex/protocol';

// ---------------------------------------------------------------------------
// Control transport (wire-protocol.md)
// ---------------------------------------------------------------------------

/** One reply-capable connection. send() writes a single compact JSON line + \n. */
export interface ReplyHandle {
  /** Serialize + write one JSON line. No-op after close/disconnect. */
  send(payload: Record<string, unknown>): void;
  /** Close the connection (EOF = end-of-reply for the CLI). Idempotent. */
  close(): void;
  /** True once closed or the peer disconnected. */
  readonly closed: boolean;
  /** Fires on peer disconnect (drives web-console --follow subscriber cleanup). */
  onDisconnect(cb: () => void): void;
  /** For follow streams: send without closing. Same as send(); close() is what ends it. */
}

/** Dispatch decoded wire messages. reply is null for fire-and-forget commands. */
export type ControlDispatcher = (msg: WireMessage, reply: ReplyHandle | null) => void;

// ---------------------------------------------------------------------------
// PTY layer (terminal-surface.md)
// ---------------------------------------------------------------------------

export interface PtySpawnOptions {
  readonly paneID: string;
  readonly cwd: string;
  readonly env: ReadonlyArray<readonly [string, string]>;
  readonly cols: number;
  readonly rows: number;
  /** Login shell resolved by the caller; undefined = user's default shell. */
  readonly shell?: string | undefined;
}

export interface PtyManager {
  /** Idempotent per paneID: first caller wins, racing creators are by design. */
  spawn(opts: PtySpawnOptions): void;
  has(paneID: string): boolean;
  /** Raw bytes to the PTY. Sync-group mirroring happens INSIDE the manager. */
  write(paneID: string, data: Uint8Array | string): void;
  /** Write bypassing sync-group mirroring (replay, resume typing). */
  writeDirect(paneID: string, data: Uint8Array | string): void;
  resize(paneID: string, cols: number, rows: number): void;
  /** SIGHUP -> short grace -> SIGKILL; never blocks, never serializes teardowns. */
  kill(paneID: string): void;
  killAll(): Promise<void>;
  /** Wholesale-replace the sync group for a workspace; empty set deletes it. */
  setSyncGroup(workspaceID: string, paneIDs: ReadonlySet<string>): void;
  onData(cb: (paneID: string, data: Uint8Array) => void): () => void;
  onExit(cb: (paneID: string, exitCode: number) => void): () => void;
}

// ---------------------------------------------------------------------------
// Terminal state (server-side VT; terminal-surface.md, @xterm/headless + ring buffer)
// ---------------------------------------------------------------------------

export interface VtModes {
  readonly applicationCursorKeys: boolean; // DECCKM
  readonly bracketedPaste: boolean;
}

export interface TerminalStateService {
  attach(paneID: string, cols: number, rows: number): void;
  feed(paneID: string, data: Uint8Array): void;
  resize(paneID: string, cols: number, rows: number): void;
  /** Plain-text read; viewport only, or including scrollback. */
  capture(paneID: string, opts: { scrollback: boolean }): string;
  /** Serialized state a fresh client renderer replays to reconstruct the screen. */
  snapshot(paneID: string): { data: Uint8Array; cols: number; rows: number };
  modes(paneID: string): VtModes;
  dispose(paneID: string): void;
}

/** Encodes pane-send / pane-send-key semantics on top of PtyManager + VT modes. */
export interface TerminalInput {
  /** Paste pipeline (bracketed-paste wrap when the app requested it, control-byte
   *  filtering), then Enter as a separate keystroke unless bare. */
  sendText(paneID: string, text: string, opts: { bare: boolean }): void;
  /** Named keys per wire-protocol.md §5.6; arrows consult live DECCKM state. */
  sendNamedKey(paneID: string, key: string): void;
}

// ---------------------------------------------------------------------------
// Domain store (workspace-feature.md, app-state-core.md; shapes owned by store/types.ts)
// ---------------------------------------------------------------------------

export interface DomainStore<State, Action, Event> {
  getState(): State;
  /** Actions are applied synchronously; per-workspace ordering is the store's job. */
  dispatch(action: Action): void;
  /** Batched mutation events, in order, after each dispatch. */
  subscribe(listener: (events: readonly Event[]) => void): () => void;
}

// ---------------------------------------------------------------------------
// Persistence (persistence.md)
// ---------------------------------------------------------------------------

export interface Persistence<Snapshot> {
  /** null = fresh install (including unreadable DB, which must NOT be deleted). */
  load(): Snapshot | null;
  /** Debounced (500ms) coalescing save. */
  scheduleSave(snapshot: Snapshot): void;
  /** Synchronous flush of any pending save (SIGTERM path). */
  flush(): void;
  close(): void;
}

// ---------------------------------------------------------------------------
// Command handlers (socket-handlers.md)
// ---------------------------------------------------------------------------

/** Everything a handler may touch. Boot composes the concrete instance. */
export interface HandlerContext<State, Action, Event> {
  readonly store: DomainStore<State, Action, Event>;
  readonly pty: PtyManager;
  readonly term: TerminalStateService;
  readonly input: TerminalInput;
  /** Version info for ping. */
  readonly version: { version: string; build: string; protocol: number };
  /** Broadcast a daemon-level event to attached WS clients (notifications etc). */
  readonly broadcast: (event: Record<string, unknown>) => void;
}

export type CommandHandler<Ctx> = (msg: WireMessage, ctx: Ctx, reply: ReplyHandle | null) => void;

/** Each handler family exports one of these; boot merges them into the dispatcher. */
export type HandlerTable<Ctx> = ReadonlyMap<string, CommandHandler<Ctx>>;
