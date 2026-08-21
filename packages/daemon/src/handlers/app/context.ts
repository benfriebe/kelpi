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
import { createGraftService, type GraftService } from '../../graft/index.js';
import { createWebPaneService, type WebPaneService } from '../../webpane/service.js';

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
    /** M7 graft engine (`graft-*` verbs). Defaults to one bound to this table's git service. */
    readonly graft?: GraftService | undefined;
    /**
     * M6 web panes (`web-*` verbs). Must be the SAME instance the WS sync hub got, since that
     * is where the Electron host registers; the default is a host-less service, so every verb
     * that needs a real browser answers `no web pane host connected`.
     */
    readonly webPanes?: WebPaneService | undefined;
    /** Mints workspace / pane / group / association ids. Uppercase canonical UUIDs. */
    readonly uuid?: (() => string) | undefined;
    /** Epoch MILLISECONDS (actions convert to the persisted seconds themselves). */
    readonly now?: (() => number) | undefined;
    /** Injected for `nextRandomColor`; deterministic in tests. */
    readonly random?: (() => number) | undefined;
    /**
     * Settings `worktreeBasePath`; `<repo>` + `~` expand per app-state-core §4.2.2.
     *
     * A **function** is the useful form: this table is built once at boot, but the value is a
     * user setting (`worktree-base-path`) that can change at any moment via Settings or a
     * hand-edit. `resolveAppDeps` turns whichever form it is given into a getter, so every
     * `deps.worktreeBasePath` read below is a fresh read and no call site had to change.
     */
    readonly worktreeBasePath?: string | (() => string) | undefined;
    /** Settings `newWorkspacePlacement`. Same live-value reasoning as above. */
    readonly placement?: NewWorkspacePlacement | (() => NewWorkspacePlacement) | undefined;
    /**
     * SET-012's `expand-group-on-workspace-drop`, default true. Same live-getter reasoning as
     * the two above: a Settings write has to reach the very next `workspace-move` without a
     * daemon restart, which is what makes the toggle a behaviour rather than a stored string.
     */
    readonly expandGroupOnDrop?: boolean | (() => boolean) | undefined;
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
    readonly graft: GraftService;
    readonly webPanes: WebPaneService;
    readonly uuid: () => string;
    readonly now: () => number;
    readonly random: () => number;
    readonly worktreeBasePath: string;
    readonly placement: NewWorkspacePlacement;
    readonly expandGroupOnDrop: boolean;
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
    const git = options.git ?? createGitService();
    return {
        git,
        // Nothing spawns or watches until a `graft-start` actually runs, so the default is
        // free for the handler families that never touch it.
        graft: options.graft ?? createGraftService({ git }),
        // Same idea: a host-less web-pane service is inert (no timers, no sockets) and answers
        // every browser-bound verb honestly.
        webPanes: options.webPanes ?? createWebPaneService(),
        uuid: options.uuid ?? (() => newUUID()),
        now: options.now ?? (() => Date.now()),
        random: options.random ?? (() => Math.random()),
        // Getters, so a settings change is visible to the very next command without rebuilding
        // the handler table. A plain string/enum still works — it is just a constant getter.
        get worktreeBasePath(): string {
            const value = options.worktreeBasePath;
            if (typeof value === 'function') return value();
            return value ?? DEFAULT_WORKTREE_BASE_PATH;
        },
        get placement(): NewWorkspacePlacement {
            const value = options.placement;
            if (typeof value === 'function') return value();
            return value ?? 'end-of-list';
        },
        get expandGroupOnDrop(): boolean {
            const value = options.expandGroupOnDrop;
            if (typeof value === 'function') return value();
            // Absent = the Swift default and the behaviour this verb had before the setting
            // existed, so a daemon composed without the option is unchanged.
            return value ?? true;
        },
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
