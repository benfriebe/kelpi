/**
 * Shared plumbing for the app-level command handlers (socket-handlers.md §5–§11).
 *
 * `HandlerContext` (seams.ts) carries the store + terminal layers every handler family needs.
 * The app family additionally needs a few *injected* collaborators the seam deliberately does
 * not name — git, id minting, the clock, the worktree base-path setting, persistence triggers
 * and client presence. They are constructor options on `createAppHandlers`, so the handler
 * signature stays `CommandHandler<AppContext>` and boot composes the rest.
 *
 * Defaults are honest and headless: a real git service, `crypto.randomUUID` (uppercased, per
 * the wire's Foundation casing), `Date.now`, PTY spawn/kill straight through `ctx.pty`, and
 * "no client is attached" for presence — which per agent-lifecycle.md means notifications DO
 * fire (nobody is watching the pane).
 */

import { newUUID } from '@nex/core/codec';
import type { SidebarID } from '@nex/core/codec';

import type { CommandHandler, HandlerContext, HandlerTable, ReplyHandle } from '../../seams.js';
import type {
    DaemonState,
    DomainAction,
    DomainEvent,
    NewWorkspacePlacement
} from '../../store/index.js';
import { createGitService, DEFAULT_WORKTREE_BASE_PATH, type GitService } from '../../git/index.js';

export type AppContext = HandlerContext<DaemonState, DomainAction, DomainEvent>;
export type AppHandler = CommandHandler<AppContext>;
export type AppHandlerTable = HandlerTable<AppContext>;

/** What boot must do when a handler creates a pane that needs a live PTY. */
export interface SpawnPaneRequest {
    readonly paneID: string;
    readonly workspaceID: string;
    readonly cwd: string;
    /** The workspace's stored assignment; null = the built-in `default` profile. */
    readonly profileName: string | null;
}

export interface AppHandlerOptions {
    readonly git?: GitService | undefined;
    /** Mints workspace / pane / group / association ids. Uppercase canonical UUIDs. */
    readonly uuid?: (() => string) | undefined;
    /** Epoch MILLISECONDS (actions convert to the persisted seconds themselves). */
    readonly now?: (() => number) | undefined;
    /** Injected for `nextRandomColor`; deterministic in tests. */
    readonly random?: (() => number) | undefined;
    /** Settings `worktreeBasePath`; `<repo>` + `~` expand per app-state-core §4.2.2. */
    readonly worktreeBasePath?: string | undefined;
    /** Settings `newWorkspacePlacement`. */
    readonly placement?: NewWorkspacePlacement | undefined;
    /** Debounced full-state save (§5 persistState). */
    readonly persist?: (() => void) | undefined;
    /** Immediate save — `session-end` only (issue #178). Defaults to `persist`. */
    readonly persistNow?: (() => void) | undefined;
    /** Spawn a freshly created pane's PTY. Defaults to `ctx.pty.spawn`. */
    readonly spawnPane?: ((request: SpawnPaneRequest, ctx: AppContext) => void) | undefined;
    /** Tear a pane's PTY + VT state down. Defaults to `ctx.pty.kill` + `ctx.term.dispose`. */
    readonly killPane?: ((paneID: string, ctx: AppContext) => void) | undefined;
    /** Sidebar scroll signal for a newly created workspace/group (issue #187). */
    readonly scrollTarget?: ((target: SidebarID) => void) | undefined;
    /** "Any attached client has window focus." Headless default: false ⇒ notify. */
    readonly isAppActive?: (() => boolean) | undefined;
    /**
     * Override the focus half of the suppression matrix. The default derives it from the
     * daemon-canonical focus (`lastActiveWorkspaceID` + the workspace's `focusedPaneID`).
     */
    readonly isPaneFocused?: ((paneID: string, workspaceID: string) => boolean) | undefined;
    /** Default columns/rows for a PTY spawned without a client-reported size. */
    readonly defaultCols?: number | undefined;
    readonly defaultRows?: number | undefined;
}

export interface AppDeps {
    readonly git: GitService;
    readonly uuid: () => string;
    readonly now: () => number;
    readonly random: () => number;
    readonly worktreeBasePath: string;
    readonly placement: NewWorkspacePlacement;
    readonly persist: () => void;
    readonly persistNow: () => void;
    readonly spawnPane: (request: SpawnPaneRequest, ctx: AppContext) => void;
    readonly killPane: (paneID: string, ctx: AppContext) => void;
    readonly scrollTarget: (target: SidebarID) => void;
    readonly isAppActive: () => boolean;
    readonly isPaneFocused: ((paneID: string, workspaceID: string) => boolean) | null;
}

const noop = (): void => {};

export function resolveAppDeps(options: AppHandlerOptions = {}): AppDeps {
    const persist = options.persist ?? noop;
    const cols = options.defaultCols ?? 80;
    const rows = options.defaultRows ?? 24;
    return {
        git: options.git ?? createGitService(),
        uuid: options.uuid ?? (() => newUUID()),
        now: options.now ?? (() => Date.now()),
        random: options.random ?? (() => Math.random()),
        worktreeBasePath: options.worktreeBasePath ?? DEFAULT_WORKTREE_BASE_PATH,
        placement: options.placement ?? 'end-of-list',
        persist,
        persistNow: options.persistNow ?? persist,
        spawnPane:
            options.spawnPane ??
            ((request, ctx) => {
                ctx.pty.spawn({
                    paneID: request.paneID,
                    cwd: request.cwd,
                    env: [],
                    cols,
                    rows
                });
            }),
        killPane:
            options.killPane ??
            ((paneID, ctx) => {
                ctx.pty.kill(paneID);
                ctx.term.dispose(paneID);
            }),
        scrollTarget: options.scrollTarget ?? noop,
        isAppActive: options.isAppActive ?? (() => false),
        isPaneFocused: options.isPaneFocused ?? null
    };
}

// ---------------------------------------------------------------------------
// Reply helpers
// ---------------------------------------------------------------------------

/**
 * Success: one `{"ok":true,…}` line, then EOF. A null handle is the legacy fire-and-forget
 * path — the guards and the effect still ran, there is just nobody to tell (§1).
 */
export function ok(reply: ReplyHandle | null, payload: Record<string, unknown> = {}): void {
    if (reply === null) return;
    reply.send({ ok: true, ...payload });
    reply.close();
}

/** Failure: `{"ok":false,"error":…}` plus any typed extras scripts branch on. */
export function fail(
    reply: ReplyHandle | null,
    error: string,
    extra: Record<string, unknown> = {}
): void {
    if (reply === null) return;
    reply.send({ ok: false, error, ...extra });
    reply.close();
}

/** Build a table from `[command, handler]` pairs, rejecting an accidental duplicate. */
export function handlerTable(entries: readonly (readonly [string, AppHandler])[]): AppHandlerTable {
    const table = new Map<string, AppHandler>();
    for (const [command, handler] of entries) {
        if (table.has(command)) throw new Error(`duplicate handler for '${command}'`);
        table.set(command, handler);
    }
    return table;
}
