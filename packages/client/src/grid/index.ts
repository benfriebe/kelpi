/**
 * The pane grid (WP3.3) — shell-ui.md §4, pane-layout.md §7.
 *
 *   `PaneGrid.tsx`  — the measured, absolutely-positioned grid: identity-stable pane
 *                     wrappers, divider drag, zoom, drop zones, resize badges
 *   `PaneHeader.tsx`— the per-pane header bar and its badges/buttons
 *   `FocusRing.tsx` — focus visuals + the 600 ms focus-dwell timer
 *   `divider.ts`    — divider-drag maths and the ratio-commit shape
 *   `elapsed.ts`    — one shared 1 s ticker for every agent elapsed clock
 *   `tokens.ts`     — `var(--nex-*)` chrome tokens with dark-preset fallbacks
 *
 * Everything is props-driven: the grid never reads the store and never sends a command.
 * Assembly supplies `renderPane` (the terminal / content-pane body) and binds the callbacks
 * to `CommandClient`. Two of those callbacks have no wire verb yet and are the assembly's
 * problem, not the grid's: `onToggleZoom` (no zoom command exists — the grid renders zoom
 * locally from the `zoomedPaneID` prop) and the split-path half of `onSetRatio` (see
 * `DividerRatioCommit`, which also carries the pane + share `commands.setSplitRatio` wants).
 */

export {
    PANE_MOVE_DRAG_THRESHOLD,
    PaneGrid,
    RATIO_COMMIT_INTERVAL_MS,
    RESIZE_BADGE_LINGER_MS,
    resizeBadgeText,
    type DropTarget,
    type PaneGridProps
} from './PaneGrid';

export {
    PANE_HEADER_HEIGHT,
    PaneHeader,
    agentBadge,
    basename,
    homeAbbreviated,
    paneDisplayTitle,
    type AgentBadgeModel,
    type AgentBadgeTone,
    type PaneHeaderProps
} from './PaneHeader';

export {
    FOCUS_DWELL_MS,
    FOCUS_RING_WIDTH,
    FocusRing,
    useFocusDwell,
    type FocusDwellOptions,
    type FocusRingProps
} from './FocusRing';

export {
    ROOT_DIVIDER_PATH,
    dividerCommit,
    dividerDragActivated,
    dividerPaneTarget,
    ratioForDividerDrag,
    splitNodeAtPath,
    throttleTrailing,
    type DividerPaneTarget,
    type DividerRatioCommit,
    type Throttled
} from './divider';

export { chromeElapsedLabel, tickerListenerCount, useSecondsTicker } from './elapsed';

export { Icon, type IconName, type IconProps } from './icons';

export { GRID_TOKEN_FALLBACKS, pill, token, tokens, type GridTokenName } from './tokens';

export type {
    GridLayoutCallbacks,
    PaneActions,
    PaneDimensions,
    PaneGridSize,
    PaneModel,
    PaneRenderState,
    RenderPane
} from './types';

export {
    expectedBox,
    firePointer,
    stubBoundingRect,
    styleBox,
    testPane,
    type PointerEventName,
    type PointerInit,
    type TestPaneOverrides
} from './testing';
