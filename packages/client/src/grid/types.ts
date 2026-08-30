/**
 * Shared prop types for the pane grid.
 *
 * Every component here is props-driven: nothing in `grid/` reads the store, opens a socket
 * or sends a command. Assembly binds the callbacks to `CommandClient` / `KelpiRuntime`, which
 * keeps the grid renderable from a fixture in tests and reusable by the Electron shell.
 */

import type { DropZone, Pane, Rect, SplitDirection } from '@kelpi/core/layout';
import type { MouseEvent, ReactNode } from 'react';

import type { DividerRatioCommit } from './divider';

/**
 * The pane fields the grid and its header read. A full `Pane` (from the store mirror)
 * satisfies it structurally; tests can build the subset by hand.
 */
export type PaneModel = Pick<
    Pane,
    | 'id'
    | 'label'
    | 'type'
    | 'title'
    | 'workingDirectory'
    | 'gitBranch'
    | 'status'
    | 'filePath'
    | 'isEditing'
    | 'agentSessionID'
    | 'agentKind'
    | 'agentStartedAt'
    | 'backgroundTaskCount'
>;

/** Terminal geometry for the resize badge; supplied by the terminal layer (WP3.2). */
export interface PaneDimensions {
    readonly cols: number;
    readonly rows: number;
}

/** How the grid is currently presenting a pane; the 4th `renderPane` argument. */
export interface PaneRenderState {
    /**
     * False for a pane the layout doesn't place right now (the zoom case). Its DOM stays
     * mounted, so pass this straight to `TerminalPane`'s `visible` prop: the renderer then
     * idles instead of measuring a hidden box, and the daemon keeps draining the PTY.
     */
    readonly visible: boolean;
    readonly zoomed: boolean;
    /** This pane is the one being header-dragged (it renders at 50% opacity). */
    readonly dragging: boolean;
}

/**
 * Renders a pane's BODY (the header is the grid's own). `frame` is the body rect in
 * container coordinates — header height already subtracted — which is exactly what the
 * terminal layer measures cols/rows from. A renderer that only needs the first arguments
 * can ignore the rest.
 */
export type RenderPane = (
    paneID: string,
    frame: Rect,
    focused: boolean,
    state: PaneRenderState
) => ReactNode;

/** Per-pane commands the header raises. All optional: an unwired button is inert. */
export interface PaneActions {
    readonly onFocusPane?: ((paneID: string) => void) | undefined;
    readonly onClosePane?: ((paneID: string) => void) | undefined;
    /** Inline rename commit (Enter / blur). Empty string clears the label. */
    readonly onRenamePane?: ((paneID: string, name: string) => void) | undefined;
    readonly onSplitPane?: ((paneID: string, direction: SplitDirection) => void) | undefined;
    readonly onToggleZoom?: ((paneID: string) => void) | undefined;
    /** Markdown ⌘E view/edit toggle (M5 owns the body; the button lives here). */
    readonly onToggleMarkdownEdit?: ((paneID: string) => void) | undefined;
    /** Diff pane refresh token bump (M5 owns the body; the button lives here). */
    readonly onRefreshDiff?: ((paneID: string) => void) | undefined;
    /**
     * §TERM-103: the markdown pane's "Copy as Markdown / Copy as Rich Text" menu, opened from
     * the HEADER (where the Swift puts it) rather than only from the in-frame chip. The menu
     * itself belongs to the content frame — it needs the iframe conversation rich text takes —
     * so this is a request to open it, not the copy itself.
     */
    readonly onCopyDocument?: ((paneID: string) => void) | undefined;
    /**
     * §3.16 preview font size. Markdown panes in VIEW mode only — the built-in editor is a
     * fixed 13 px and diff panes have no bindings to change theirs.
     */
    readonly onSetFontSize?: ((paneID: string, step: 'increase' | 'decrease' | 'reset') => void) | undefined;
    /** Restart the pane's agent (kill + `claude --resume` / `codex resume`). */
    readonly onRestartAgent?: ((paneID: string) => void) | undefined;
    /** New web pane split off this one (shift-click splits down) — shell-ui.md §4.2 item 12. */
    readonly onNewWebPane?: ((paneID: string, direction: SplitDirection) => void) | undefined;
    /** Right-click on the header; assembly owns the context menu (shell-ui.md §4.2). */
    readonly onPaneContextMenu?: ((paneID: string, event: MouseEvent<HTMLElement>) => void) | undefined;
}

/** Layout mutations the grid raises from direct manipulation. */
export interface GridLayoutCallbacks {
    /**
     * Divider drag (pane-layout.md §7.3 path encoding). `splitPath` + `ratio` are the model
     * spelling; `commit` additionally carries the pane + share that `commands.setSplitRatio`
     * needs, because the wire has no split-path verb (see `divider.ts`).
     */
    readonly onSetRatio?:
        | ((splitPath: string, ratio: number, commit: DividerRatioCommit) => void)
        | undefined;
    /** Header drag-drop → `movePane(paneID, anchorID, zone)`. */
    readonly onMovePane?: ((paneID: string, anchorID: string, zone: DropZone) => void) | undefined;
    /**
     * The focus-dwell timer expired for a pane whose status is non-idle: the daemon-side
     * `clearPaneStatus` mutation happens upstream (agent-lifecycle.md §5.8).
     */
    readonly onDwellClear?: ((paneID: string) => void) | undefined;
    /** Empty-layout "New Pane" affordance. */
    readonly onCreatePane?: (() => void) | undefined;
}

export interface PaneGridSize {
    readonly width: number;
    readonly height: number;
}
