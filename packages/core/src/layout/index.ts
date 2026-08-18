/**
 * Pane layout module — pure, dependency-free layout tree + geometry.
 * Spec: docs/current/pane-layout.md
 *
 * Consumed by the daemon (pane-* / layout-* wire commands), the client (frame
 * and divider geometry, drag-drop) and persistence. Frame math must be
 * identical everywhere it runs.
 */

export type {
    EmptyLayout,
    EnclosingSplit,
    LeafLayout,
    PaneID,
    PaneLayout,
    Point,
    Rect,
    SplitBounds,
    SplitDirection,
    SplitDividerInfo,
    SplitLayout
} from './types.js';
export {
    clampRatio,
    DIVIDER_HIT_INSET,
    DIVIDER_MIN_DRAG_DISTANCE,
    DIVIDER_THICKNESS,
    empty,
    EMPTY_LAYOUT,
    leaf,
    MAX_SPLIT_RATIO,
    maxX,
    maxY,
    midX,
    midY,
    MIN_SPLIT_RATIO,
    minX,
    minY,
    rectContains,
    ROOT_SPLIT_PATH,
    split
} from './types.js';

export type { SplittingResult } from './tree.js';
export {
    allPaneIDs,
    containsPane,
    isEmptyLayout,
    nextPaneID,
    previousPaneID,
    removing,
    replacing,
    splitting,
    swappingLeaves
} from './tree.js';

export type { DividerDragSnapshot } from './frames.js';
export {
    dividerDragDelta,
    dividerDragSnapshot,
    dividerHitRect,
    paneAtPoint,
    paneFrames,
    ratioFromDividerDrag,
    splitBounds,
    splitDividers
} from './frames.js';

export type { DropZone, WireMoveEdge } from './dropZone.js';
export {
    calculateDropZone,
    draggedPaneGoesFirst,
    DROP_ZONES,
    dropZoneForWireEdge,
    dropZoneOverlayRect,
    movingPane,
    splitDirectionOfZone
} from './dropZone.js';

export type { Direction } from './neighbor.js';
export { NEIGHBOR_BOUNDS, NEIGHBOR_TOLERANCE, neighborPaneID } from './neighbor.js';

export type { ResizeResult } from './ratio.js';
export {
    currentPaneShare,
    enclosingSplitPath,
    ratioAtPath,
    ratioForShare,
    RESIZE_STEP,
    resizePaneShare,
    shareForRatio,
    updatingSplitRatio
} from './ratio.js';

export type { PredefinedLayoutKind } from './predefined.js';
export {
    buildLayout,
    evenSplit,
    isPredefinedLayoutKind,
    nextLayoutIndex,
    orderIDsWithFocusedFirst,
    PREDEFINED_LAYOUT_DISPLAY_NAMES,
    PREDEFINED_LAYOUT_ORDER,
    predefinedLayoutAtIndex,
    predefinedLayoutIndex,
    rebuildLayout,
    tiledSplit
} from './predefined.js';

export {
    decodeLayoutJSON,
    encodeLayoutJSON,
    isUUIDString,
    layoutToJSONValue
} from './codec.js';

export type { AgentKind, EpochSeconds, NewPaneFields, Pane, PaneStatus, PaneType } from './pane.js';
export {
    AGENT_KINDS,
    DEFAULT_MARKDOWN_FONT_SIZE,
    isTerminalPane,
    isUsingExternalEditor,
    makePane,
    PANE_PERSISTED_COLUMNS,
    PANE_PERSISTED_FIELDS,
    PANE_STATUSES,
    PANE_TRANSIENT_FIELDS,
    PANE_TYPES,
    resetTransientPaneFields
} from './pane.js';
