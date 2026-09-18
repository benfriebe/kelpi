/**
 * The shared pane chrome model (phase A of pane chrome composition).
 *
 *   `contract.ts`   - what a pane's chrome IS: the vocabulary, the budgets, the height clamp and
 *                     the parking predicate. No React, no store, no socket.
 *   `model.ts`      - one pane folded into one closure-free descriptor, with the run targets kept
 *                     privately beside it. The display strings and the two width ladders moved
 *                     here from `grid/PaneHeader.tsx` unchanged.
 *   `surface.ts`    - the single write path for every action a header performs: ids in, no
 *                     closures out, and every call re-resolved against a fresh model.
 *   `height.ts`     - the per-pane band the host owns, and the parking enrolment a taller band
 *                     over a web pane earns.
 *   `projection.ts` - the model as the one bounded frame a presenter will receive in phase B.
 *
 * Nothing here mounts a presenter, publishes a frame or declares a height. `grid/PaneHeader.tsx`
 * draws from the descriptor and acts through the surface, `grid/PaneGrid.tsx` lays every pane body
 * out under the band this module clamps, and the result on screen is the header that was there
 * before - which is what the PaneHeader and grid suites, and an onscreen scenario run, are for.
 */

export {
    PANE_CHROME_ACTION_IDS,
    PANE_CHROME_LIMITS,
    PANE_CHROME_PLACEMENT,
    isPaneChromeActionID,
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
    clearPaneChromeHeights,
    paneChromeBand,
    paneChromeDeclaration,
    paneChromeDeclarationCount,
    setPaneChromeHeight,
    usePaneChromeDeclaration,
    usePaneChromeHeights,
    usePaneChromeParking,
    type PaneChromeHeights
} from './height';

export {
    PANE_CHROME_FRAME_BUDGET,
    paneChromeBytes,
    projectPaneChrome,
    type PaneChromeFrame,
    type PaneChromeFrameControl,
    type PaneChromeFramePane,
    type PaneChromeProjectionInput
} from './projection';
