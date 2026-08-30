/**
 * The pane handlers' view of the daemon (WP2.5a).
 *
 * `PaneHandlerContext` is the concrete instantiation of `HandlerContext` from `../../seams.ts`
 * for the `pane-*` family, widened (never narrowed) with the few extra seams these handlers
 * need and that boot supplies:
 *
 *  - `profiles()`: the parsed `~/.config/nex/config` profile list, re-read per call so
 *    definitions stay fresh without a watcher (workspace-feature.md §3.4); used to build the
 *    spawn env of every shell pane these handlers create.
 *  - `spawn`: the process-level spawn defaults (helpers dir for `PATH`, login shell, the
 *    grid a PTY starts at before a client reports a real size).
 *  - `clock` / `mintPaneID` / `mintWorkspaceID` / `random`: injectable so tests get
 *    deterministic ids and timestamps. Production leaves them unset.
 *  - `term`: the seam plus the optional async reads the real `TerminalStateService`
 *    implementation adds (`captureAsync` flushes pending writes first, which is what
 *    `pane capture` wants: bytes written moments ago must be visible).
 *
 * Everything else (PTY data → terminal feed, persistence, notification fan-out) is boot's
 * composition; handlers only call seam methods.
 */

import type { Profile } from '@kelpi/core/config';

import type { HandlerContext, TerminalStateService } from '../../seams.js';
import type { DaemonState, DomainAction, DomainEvent } from '../../store/index.js';

/** Additive reads `TerminalStateServiceImpl` provides on top of the seam. */
export interface AsyncTerminalReads {
    /** `capture()` after flushing pending writes; what read handlers should use. */
    captureAsync(paneID: string, opts: { scrollback: boolean }): Promise<string>;
    /** True when the pane still has terminal state (capture-race detection). */
    has(paneID: string): boolean;
}

/** Process-level defaults every PTY spawn inherits (terminal-surface.md §2). */
export interface PaneSpawnDefaults {
    /** Directory holding the bundled `kelpi` CLI; prepended to `PATH` when present. */
    readonly helpersDir?: string | undefined;
    /**
     * The `NEX_SOCKET` value routing this pane's `kelpi` CLI back at THIS daemon
     * (`tcp:127.0.0.1:<port>`), read at env-build time so it reflects the live listener.
     * Without it a hook firing inside the pane resolves the shared `/tmp/nex.sock` — which on
     * a machine also running the Swift app is somebody else's daemon. Null = no injection.
     */
    readonly controlRoute?: (() => string | null) | undefined;
    /** `PATH` inherited by the daemon; defaults to `process.env.PATH`. */
    readonly inheritedPath?: string | null | undefined;
    /** Login shell; undefined = the user's default. */
    readonly shell?: string | undefined;
    readonly cols?: number | undefined;
    readonly rows?: number | undefined;
    /**
     * Last-known grid for a pane (`pty/geometry.ts`), consulted before `cols`/`rows`.
     *
     * A shell that starts at 80×24 and is only resized once a client attaches leaves its
     * first, wrongly-wrapped prompt in the scrollback forever — `@xterm/headless` does not
     * reflow. Spawning at the size the pane was last rendered at is what keeps a reattached
     * workspace looking like one clean prompt history instead of a stack of half-width copies.
     */
    readonly sizeFor?: ((paneID: string) => { cols: number; rows: number } | null | undefined) | undefined;
    /**
     * Offer this pane's FIRST spawn to the deferral gate (`pty/spawn-gate.ts`).
     *
     * `sizeFor` has nothing to say about a pane nobody has ever rendered — a fresh install's
     * first pane, a split's child, a markdown pane on its first ⌘E — and the fallback grid is
     * exactly the wrong-width prompt this whole mechanism exists to prevent. When a client is
     * attached (or one is expected, at boot), the gate holds the spawn for the few hundred
     * milliseconds it takes that client to measure the pane and report a real grid.
     *
     * Returns `true` when the gate took ownership: the caller must NOT spawn, and the callback
     * it handed over will run later — with the reported size, or with `null` meaning "you were
     * right, use your fallback" when the wait timed out or something demanded the PTY first.
     * Returns `false` (and boot leaves it undefined entirely, as does every test) when the
     * caller should spawn immediately, exactly as it did before the gate existed.
     */
    readonly deferSpawn?:
        | ((
              paneID: string,
              spawn: (size: { cols: number; rows: number } | null) => void
          ) => boolean)
        | undefined;
    /**
     * Run a pending deferred spawn NOW, because this call needs the pane's terminal state.
     *
     * The PTY-shaped demands (a keystroke, `pane send`, a resume command) flush the gate inside
     * the `PtyManager` wrapper and never reach here. Reads of the SERVER-SIDE VT do not touch
     * the PTY at all, so `pane capture` is the one caller that has to say so itself.
     */
    readonly flushSpawn?: ((paneID: string) => void) | undefined;
}

export interface PaneHandlerContext
    extends HandlerContext<DaemonState, DomainAction, DomainEvent> {
    readonly term: TerminalStateService & Partial<AsyncTerminalReads>;
    /** Unix MILLISECONDS (`Date.now` by default); actions carry epoch millis. */
    readonly clock?: (() => number) | undefined;
    /** Pre-minted pane UUIDs (uppercase canonical); defaults to `newUUID`. */
    readonly mintPaneID?: (() => string) | undefined;
    /** Pre-minted workspace UUIDs (`pane-move-to-workspace --create`). */
    readonly mintWorkspaceID?: (() => string) | undefined;
    /** Color picker entropy for an implicitly created workspace. */
    readonly random?: (() => number) | undefined;
    /** Profile definitions, re-read per spawn. */
    readonly profiles?: (() => readonly Profile[]) | undefined;
    /**
     * Diagnostics sink for the spawn path (§SET-209).
     *
     * `WorkspaceProfilesClient.resolveEnv` warns when a workspace resolves a NON-`default`
     * profile that the config file does not define — the marker is still injected, but nothing
     * else is, and without the warning a typo in `kelpi workspace profile` looks exactly like a
     * working assignment. The daemon has no `os_log`, so the warning goes where every other
     * daemon diagnostic goes: `createDaemon`'s `onLog`, i.e. the `kelpid` log. Unset in tests
     * that do not care, which is why it is optional.
     */
    readonly onLog?: ((message: string) => void) | undefined;
    readonly spawn?: PaneSpawnDefaults | undefined;
}
