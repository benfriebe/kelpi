/**
 * The pane search composition surface: the selectable find bar.
 *
 *   `contract.ts`        - what a pane search IS: the placement, the budgets, the size clamp, where
 *                          the box sits and the clip that keeps it there. No React, no store, no
 *                          socket.
 *   `box.ts`             - the one thing a presenter declares that the host has to act on, as a
 *                          per-pane store with every withdrawal path in it.
 *   `projection.ts`      - the daemon's open session as the one bounded frame a presenter receives.
 *   `presenter.ts`       - what a selected presenter is told and what it may do about it: the frame,
 *                          the six calls, the call budget, and the window's failure and painted
 *                          latches.
 *   `presenter-slot.tsx` - where it is mounted, the geometry it is clipped to, the chord relay, the
 *                          caret, the two watchdogs and the fallback to the native bar.
 *
 * With nothing selected for `pane.search`, none of it does anything at all: no frame is built, no
 * store is subscribed to and `grid/PaneSearchOverlay.tsx` draws exactly the bar it always drew -
 * which is what the grid and terminal suites are for.
 */

export {
    PANE_SEARCH_LIMITS,
    PANE_SEARCH_PLACEMENT,
    isPaneSearchKind,
    paneSearchBox,
    paneSearchClipPath,
    paneSearchNeedle,
    paneSearchRect,
    type PaneSearchKind,
    type PaneSearchPlacement,
    type PaneSearchRect,
    type PaneSearchSize
} from './contract';

export {
    clearPaneSearchBoxes,
    paneSearchBoxFor,
    paneSearchDeclaration,
    paneSearchDeclarationCount,
    retainPaneSearchBox,
    setPaneSearchBox,
    usePaneSearchBoxScope,
    usePaneSearchBoxes,
    usePaneSearchDeclaration,
    type PaneSearchBoxes
} from './box';

export {
    PANE_SEARCH_FRAME_BUDGET,
    paneSearchBytes,
    projectPaneSearch,
    type PaneSearchFrame,
    type PaneSearchMatch,
    type PaneSearchProjection,
    type PaneSearchProjectionInput,
    type PaneSearchSession
} from './projection';

export {
    PANE_SEARCH_PLACEMENTS,
    PANE_SEARCH_UI_METHODS,
    clearPaneSearchPainted,
    clearPaneSearchPresenterFailure,
    createPaneSearchPresenterHost,
    notePaneSearchPainted,
    notePaneSearchPresenterFailure,
    paneSearchPaintedGeneration,
    paneSearchPresenterFailure,
    resetPaneSearchPresenterFailures,
    subscribePaneSearchPainted,
    subscribePaneSearchPresenters,
    type PaneSearchActions,
    type PaneSearchPresenterFailure,
    type PaneSearchPresenterHost,
    type PaneSearchPresenterHostOptions,
    type PaneSearchPresenterSnapshot
} from './presenter';

export {
    PANE_SEARCH_NEXT_CHORD,
    PANE_SEARCH_PREVIOUS_CHORD,
    PaneSearchPresenterSlot,
    paneSearchPresenterChords,
    usePaneSearchPainted,
    usePaneSearchSelection,
    type PaneSearchPresenterSlotProps,
    type PaneSearchSelection
} from './presenter-slot';
