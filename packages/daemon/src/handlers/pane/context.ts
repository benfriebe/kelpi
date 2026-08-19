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

import type { Profile } from '@nex/core/config';

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
    /** Directory holding the bundled `nex` CLI; prepended to `PATH` when present. */
    readonly helpersDir?: string | undefined;
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
    readonly spawn?: PaneSpawnDefaults | undefined;
}
