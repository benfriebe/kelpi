/**
 * The pane chrome composition surface: the shared model (phase A) and the selectable presenter
 * (phase B).
 *
 *   `contract.ts`        - what a pane's chrome IS: the vocabulary, the budgets, the height clamp
 *                          and the parking predicate. No React, no store, no socket.
 *   `model.ts`           - one pane folded into one closure-free descriptor, with the run targets
 *                          kept privately beside it. The display strings and the two width ladders
 *                          moved here from `grid/PaneHeader.tsx` unchanged.
 *   `surface.ts`         - the single write path for every action a header performs: ids in, no
 *                          closures out, and every call re-resolved against a fresh model.
 *   `height.ts`          - the per-pane band the host owns, and the parking enrolment a taller
 *                          band over a web pane earns.
 *   `projection.ts`      - the model as the one bounded frame a presenter receives.
 *   `registry.ts`        - where each header publishes its descriptor and its surface, so one
 *                          presenter can be handed every pane without a second model being built.
 *   `presenter.ts`       - what a selected presenter is told and what it may do about it: the
 *                          frame, the ten calls, the call budget and the window's failure latch.
 *   `presenter-slot.tsx` - where it is mounted, the geometry it is clipped to, the two watchdogs
 *                          and the all-or-nothing fallback.
 *
 * With nothing selected for `pane.chrome`, none of the last three does anything at all: no frame is
 * built, no store is subscribed to and `grid/PaneHeader.tsx` draws exactly the header it always
 * drew - which is what the PaneHeader, grid and terminal geometry suites are for.
 */

export {
    PANE_CHROME_ACTION_IDS,
    PANE_CHROME_LIMITS,
    PANE_CHROME_PLACEMENT,
    isPaneChromeActionID,
    paneChromeDragRegion,
    paneChromeHeight,
    paneChromeParks,
    paneChromeRow,
    type PaneChromeActionID,
    type PaneChromeAgent,
    type PaneChromeAgentTone,
    type PaneChromeBadgeFit,
    type PaneChromeChanges,
    type PaneChromeContributions,
    type PaneChromeControlDescriptor,
    type PaneChromeControlKind,
    type PaneChromeDescriptor,
    type PaneChromeDragRegion,
    type PaneChromeItemDescriptor,
    type PaneChromeItemTone,
    type PaneChromeKind,
    type PaneChromePlacement,
    type PaneChromeRow,
    type PaneChromeSize,
    type PaneChromeStatus,
    type PaneChromeSync,
    type PaneChromeTitleParts,
    type PaneChromeZoom
} from './contract';

export {
    BADGE_COST,
    HEADER_TAIL_MAX,
    PANE_CHROME_SPLITS,
    agentBadge,
    badgeFit,
    basename,
    headerChrome,
    headerOverflowCount,
    homeAbbreviated,
    paneChromeGlyph,
    paneChromeModel,
    paneDisplayTitle,
    splitHeaderTitle,
    type AgentBadgeModel,
    type AgentBadgeTone,
    type BadgeFit,
    type BadgeFitInput,
    type OverflowFitInput,
    type PaneChromeCommandInput,
    type PaneChromeInput,
    type PaneChromeModel,
    type PaneChromeTargets,
    type TruncatedTitle
} from './model';

export {
    createPaneChromeSurface,
    type PaneChromeActions,
    type PaneChromeControlOptions,
    type PaneChromeSurface,
    type PaneChromeSurfaceConfig
} from './surface';

export {
    clearPaneChromeDeclarations,
    clearPaneChromeHeights,
    paneChromeBand,
    paneChromeDragRegionsFor,
    retainPaneChromeHeights,
    setPaneChromeDragRegions,
    usePaneChromeDragRegions,
    paneChromeDeclaration,
    paneChromeDeclarationCount,
    setPaneChromeHeight,
    usePaneChromeDeclaration,
    usePaneChromeHeights,
    usePaneChromeParking,
    usePaneChromeScope,
    usePaneChromeWithdrawal,
    type PaneChromeHeights,
    type PaneChromeRegions
} from './height';

export {
    PANE_CHROME_FRAME_BUDGET,
    createPaneChromeRefs,
    paneChromeBytes,
    projectPaneChrome,
    type PaneChromeFrame,
    type PaneChromeFrameControl,
    type PaneChromeFrameItem,
    type PaneChromeFramePane,
    type PaneChromeFrameRect,
    type PaneChromeProjection,
    type PaneChromeProjectionInput,
    type PaneChromeRefMinter,
    type PaneChromeRefTable,
    type PaneChromeRefTarget
} from './projection';

export {
    paneChromeEntry,
    paneChromeEntryCount,
    paneChromeRegistryVersion,
    publishPaneChrome,
    resetPaneChromeRegistry,
    subscribePaneChrome,
    usePaneChromeRegistry,
    usePublishedPaneChrome,
    withdrawPaneChrome,
    type PaneChromeEntry
} from './registry';

export {
    PANE_CHROME_PLACEMENTS,
    PANE_CHROME_UI_METHODS,
    clearPaneChromePainted,
    clearPaneChromePresenterFailure,
    createPaneChromePresenterHost,
    notePaneChromePainted,
    notePaneChromePresenterFailure,
    paneChromePaintedGeneration,
    paneChromePresenterFailure,
    resetPaneChromePresenterFailures,
    subscribePaneChromePainted,
    subscribePaneChromePresenters,
    type PaneChromePresenterFailure,
    type PaneChromePresenterHost,
    type PaneChromePresenterHostOptions,
    type PaneChromePresenterSnapshot
} from './presenter';

export {
    NO_PANE_CHROME_CHORDS,
    PaneChromePresenterSlot,
    paneChromeClipPath,
    paneChromeFrameRect,
    paneChromeGripRect,
    usePaneChromePainted,
    usePaneChromeSelection,
    type PaneChromePresenterSlotProps,
    type PaneChromeSelection
} from './presenter-slot';
