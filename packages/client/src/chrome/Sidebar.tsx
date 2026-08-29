/**
 * The workspace sidebar (WP3.4) — shell-ui.md §5.
 *
 * Structure: filter field → list (or the flat filtered list) → footer, on
 * `theme.sidebarBackground`. Rows render in daemon order (`topLevelOrder` + each group's
 * `childOrder`, delivered as `entries`); ⌘1..9 badges index `visibleWorkspaceOrder`.
 *
 * Three things here are deliberate ports of a spec subtlety rather than obvious UI code:
 *
 *   1. **Collapse is client-local-first.** There is no `group-collapse` wire verb yet, so a
 *      click would otherwise do nothing until the daemon grows one. The row toggles a local
 *      override *and* raises `onToggleGroupCollapse`; when the verb lands, assembly wires it
 *      and the override is simply confirmed by the next delta.
 *   2. **Drag live-applies to a client-local shadow and commits ONCE** (§15). Every
 *      intermediate order lives in `shadow`; `mouseup` derives a single
 *      `{workspaceID, groupID, index}` (post-remove semantics) and calls `onMoveWorkspace`
 *      exactly once. `ontoGroupHeader` stays preview-only during the drag, exactly as the
 *      Swift app does, because the cursor transits headers constantly.
 *   3. **Menus are portals** (§15 "Menu stability"): an open menu/submenu must survive the
 *      1-second agent-status re-render of the row underneath it, which it does because its
 *      state lives on the sidebar and its DOM lives on `document.body`.
 *
 * Everything else is props/callbacks — the sidebar never reads the store or sends a command.
 */

import { firstGrapheme } from '@nex/core/codec';
import type { IconRef, WorkspaceColor } from '@nex/daemon/store';
import {
    memo,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type ReactElement,
    type RefObject
} from 'react';
import { createPortal } from 'react-dom';

import { ContextMenu, menuAnchorFromEvent, type MenuItemSpec } from './ContextMenu';
import { useModalPresence } from './modal-presence';
import { NewEntrySheet } from './NewWorkspaceSheet';
import {
    ChromeIcon,
    CURATED_EMOJI,
    CURATED_SYMBOL_ICONS,
    avatarLetter,
    iconGlyph,
    iconIsTintable,
    normalizeEmojiInput
} from './icons';
import {
    applyGroupDrop,
    applyWorkspaceDrop,
    buildDropZones,
    buildGroupSpans,
    defaultGroupName,
    filteredRows,
    groupCommit,
    isGroupCollapsed,
    locateWorkspace,
    nextCreateColor,
    orderModelFromEntries,
    projectEntries,
    renderedRows,
    resolveDropTarget,
    resolveGroupDropIndex,
    visibleOrderFromEntries,
    workspaceCommit,
    type CollapseState,
    type DropTarget,
    type RenderedRow,
    type SidebarOrderModel
} from './sidebar-model';
import { animateScrollTop, revealScrollTop } from './sidebar-scroll';
import {
    SPRING_DAMPING_FRACTION,
    SPRING_RESPONSE_S,
    createSpringDriver,
    type SpringDriver
} from './spring';
import {
    SIDEBAR_TINT_VARS,
    resolveLabelStyle,
    tintedColor,
    withAlpha,
    workspaceColorHex,
    type ChromeBucket
} from './theme';
import { tokens } from './tokens';
import {
    DEFAULT_PROFILE_NAME,
    WORKSPACE_COLORS,
    type ChromeGroup,
    type ChromeLabelPreset,
    type ChromeRepo,
    type ChromeSidebarEntry,
    type ChromeWorkspace,
    type SidebarCallbacks
} from './types';

const DRAG_THRESHOLD_PX = 5;
const DEFAULT_ROW_HEIGHT = 34;
const CONTENT_TOP_PADDING = 4;

/**
 * §WS-004's footer bar, in the Swift's own numbers (`WorkspaceListView.swift:400,437`):
 * `HStack(spacing: 6)` inside `.padding(12)`.
 */
const FOOTER_PADDING_PX = 12;
const FOOTER_GAP_PX = 6;

/**
 * SPACING-REVIEW S45 (OWNER-DIRECTED) — the multi-selection strip's Select All / Clear, hit box
 * only.
 *
 * `WorkspaceListView.swift:834-849` is `HStack(spacing: 8)` of two `.buttonStyle(.borderless)`
 * 11 pt buttons, and the port transcribed the stack exactly (§M6's 6/12 strip is correct and is
 * untouched here). What it could not transcribe is the CELL a borderless AppKit button brings
 * with it: measured, the two shipped as bare text runs — 49.34 × 15.40 and 27.52 × 15.40 at
 * `padding: 0px` — which is the whole trailing cluster reading as three accent words at one
 * uniform 8 px spacing rather than as two controls.
 *
 * The padding gives each one a box; the matching NEGATIVE margin hands every pixel of it back to
 * the layout, so both buttons' margin boxes are still exactly their text boxes and nothing in
 * the strip moves — Clear's right edge stays on x 208, which is §M6's own 12 px trailing inset,
 * and the header stays 27.4 px tall rather than growing on a 19.4 px child.
 *
 * **Deviation from the register's suggestion, on measurement.** It asked for `2px 6px` with a
 * `marginRight: -6` on Clear alone. Two things are wrong with that pair at this geometry: the
 * one-sided margin leaves Select All's TEXT 12 px left of where it is today (the `flex-1`
 * "N selected" span absorbs both new boxes), and 6 px of bleed on facing edges inside an 8 px
 * gap makes the two hit boxes OVERLAP by 4 px — where the later sibling wins, so the right edge
 * of "Select All" would quietly fire Clear. 4 px is the most the 8 px gap admits without that,
 * and it still buys the ~19.4 px target height the row is actually asking for.
 *
 * Measured live at a 220 px sidebar with two workspaces and one selected: Select All
 * 49.5 × 15.5 → 57.0 × 19.5 and Clear 27.5 × 15.5 → 35.5 × 19.5 hit boxes, both text runs
 * unmoved to the sub-pixel, and the 440 × 56 picture of the strip pixel-identical (0 of
 * 24 640 px differ).
 *
 * Owner-directed: do not re-report. The parity value is no padding on either.
 */
const SELECTION_ACTION_HIT_BOX = { padding: '2px 4px', margin: '-2px -4px' } as const;
/**
 * How tall the footer's two-row chevron menu is. `ContextMenu` is a portal positioned by its
 * TOP edge, and this menu drops UPWARD from a bar that sits against the bottom of the window,
 * so the height has to be supplied rather than read back.
 *
 * Derived rather than guessed, and then MEASURED — and it has to be RE-derived whenever the
 * shared `MenuRow` changes shape, because a stale estimate here does not look stale: it drops
 * the menu ONTO the bar it hangs off. That is exactly what happened when SPACING-REVIEW S1/S3
 * gave `MenuRow` the `px-2.5 py-1` its class list had always declared: the row went 16.8 → 24.8
 * px, the two-row panel went 43 → 60, and this constant still said 44, so the audit's own
 * "it drops UPWARD, clear of the bar it hangs off" turned red (docs/audit/density-sidebar-dialogs,
 * step 05). The panel's 1 px border and S54/S55's 2 px inter-row gap are counted for the same
 * reason.
 */
export const FOOTER_MENU_ROW_HEIGHT = 24.8;
const FOOTER_MENU_PANEL_PADDING = 4;
const FOOTER_MENU_PANEL_BORDER = 1;
/** `gap-0.5` on the panel — SPACING-REVIEW S54/S55's menu-row separation. */
const FOOTER_MENU_ROW_GAP = 2;
export const FOOTER_MENU_ESTIMATED_HEIGHT = Math.ceil(
    FOOTER_MENU_ROW_HEIGHT * 2 + FOOTER_MENU_ROW_GAP + (FOOTER_MENU_PANEL_PADDING + FOOTER_MENU_PANEL_BORDER) * 2
);
/** The gap the menu leaves above the chevron, matching `TopBar`'s 4px drop below its •••. */
const FOOTER_MENU_GAP = 4;

/**
 * THE SIDEBAR'S TEXT IS CHROME, NOT CONTENT (2026-08-23).
 *
 * The user's words: "dragging around on the sidebar selects the text, it shouldn't do that."
 * The parity statement is stronger than the bug report: an AppKit/SwiftUI `List` row's labels
 * are drawn `Text`, and drawn `Text` has no selection model at all — you cannot smear a
 * workspace name in the shipped app however hard you drag, and you cannot double-click one to
 * highlight a word either. The port renders real text nodes, so it inherits the browser's
 * default and every drag across a row leaves a blue smear trailing the cursor clone.
 *
 * `user-select: none` on the sidebar CONTAINER is both halves of the answer: it is the parity
 * behaviour, and it kills the drag-smear at the root rather than at the symptom — a `mousedown`
 * that lands on unselectable text never begins a selection, so there is nothing to grow as the
 * pointer moves and nothing to clear on release. Doing it at the container (one place) rather
 * than per row also covers the group headers, the label chips, the footer captions and every
 * row-shaped thing added later, which a per-component rule would not.
 *
 * Unprefixed, and deliberately only unprefixed: the shell is Electron/Chromium, which has
 * answered to plain `user-select` since Chrome 54, and a `-webkit-` twin would be a property
 * no test in this repo could see — jsdom's `cssstyle` drops vendor-prefixed declarations on
 * the floor, so it would be an unobservable claim sitting next to an observable one.
 */
const UNSELECTABLE_TEXT_STYLE = {
    userSelect: 'none'
} as const satisfies CSSProperties;

/**
 * …and the explicit opt-BACK-IN, for every editable inside that container.
 *
 * `user-select` INHERITS, and a text field under a `user-select: none` ancestor loses caret
 * dragging, double-click-to-word and shift-arrow selection in WebKit-derived engines — the UA
 * stylesheet does not re-assert it on `<input>`. So the rule above would quietly break typing
 * ergonomics in the rename editor, the filter field and the create form, which is exactly the
 * class of regression a "parity polish" is supposed not to introduce.
 *
 * Applied to every `<input type="text">` under `[data-testid="sidebar"]`: `InlineEditor` (the
 * workspace AND group rename) and the filter field. Checkboxes and `<select>`s have no text to
 * select and are left alone. The emoji sheet, the confirm dialog and the create sheet are
 * `createPortal`'d onto `document.body`, so they are outside the container and never inherit the
 * rule in the first place — the sheet still declares the opt-in beside its own fields, because
 * where a node happens to be parented is a weaker guarantee than a rule next to what it protects.
 */
const SELECTABLE_TEXT_STYLE = {
    userSelect: 'text'
} as const satisfies CSSProperties;

/**
 * A selection made ELSEWHERE — in a terminal pane, the inspector, or an earlier caret drag
 * inside the filter field — survives into a sidebar drag and smears as the pointer moves, and
 * `user-select: none` cannot help with it: the ranges already exist and the selection simply
 * EXTENDS through the unselectable region rather than starting in it.
 *
 * So the drag drops it, at the exact moment the press becomes a drag (5px + §WS-093's measure
 * gate) rather than on `mousedown` — a press that never moves must not destroy the user's
 * selection somewhere else on screen.
 */
function clearDocumentSelection(): void {
    const selection = globalThis.getSelection?.();
    if (selection === null || selection === undefined) return;
    selection.removeAllRanges();
}

/**
 * §5.5's drag timers, verbatim from the timer inventory (§15):
 *
 *   - hovering a COLLAPSED group for 650 ms transiently expands it for the rest of the drag
 *     (its persisted `isCollapsed` is untouched — leaving cancels, releasing collapses again);
 *   - within 40 px of the viewport's top/bottom edge the list scrolls 3 px every 15 ms, and
 *     each tick re-derives the content-space cursor and re-runs the whole target resolution,
 *     because a stationary pointer emits no further mousemove events.
 */
export const SPRING_LOAD_MS = 650;
/**
 * The nesting indent, in px — one number rather than three literals.
 *
 * It is the row's `margin-left` when it lives inside a group (§WS-089), the amount §WS-007's
 * guide rule is inset behind, and — since this pass — the width the cursor clone gives up when
 * the resolved drop target is inside a group and takes back when it leaves one.
 */
export const NEST_INDENT_PX = 24;

/**
 * §WS-027's RING GEOMETRY AND THE AIR AROUND IT, taken off the Swift (2026-08-23).
 *
 * The user's words: "the highlight touches the group" — the active row's accent ring running
 * into the group band above it. The Swift says, in a comment written for exactly this failure
 * (`Nex/Features/Workspace/WorkspaceRowView.swift:93-97`):
 *
 *     // Outer gap (outside the selection ring) matching the group bands'
 *     // 2pt, so the spacing between a row and an adjacent group/row is the
 *     // same everywhere — incl. the gap between a selected row's ring and
 *     // the group header above/below it.
 *     .padding(.vertical, 2)
 *
 * so the original SPACES THE ROWS rather than insetting the ring, and it spends the space twice:
 *
 *   - the list itself is `VStack(spacing: 0)` (`WorkspaceListView.swift:291`), so ALL vertical
 *     separation is the items' own outer padding — and SwiftUI padding does not collapse, so two
 *     adjacent items are `ROW_OUTER_GAP_PX + ROW_OUTER_GAP_PX` = 4pt apart. Group headers carry
 *     the same 2pt (`GroupHeaderRow.swift:110`), which is what makes the gap uniform;
 *   - the ring is `RoundedRectangle(cornerRadius: 7).stroke(…, lineWidth: 1.5)`
 *     (`WorkspaceRowView.swift:168`), and SwiftUI's `.stroke` is CENTRED on the path, so the
 *     accent paints half its width — 0.75pt — OUTSIDE the row's background box. The selection
 *     stroke (`:161`, `lineWidth: 1`) bleeds 0.5pt the same way.
 *
 * Net: 4 − 0.75 = 3.25pt of clear air between the active ring's painted outer edge and the group
 * band's painted edge. The port had 1.5px, from two divergences that compounded — the rows were
 * block siblings, so their `my-0.5` margins COLLAPSED to one 2px gap instead of two, and the
 * outline was `outline-offset: -1px` (drawn entirely inside the box) rather than centred. The
 * list is a flex column now, which is what stops the collapse; the offset below is what centres
 * the stroke.
 *
 * `ringOffsetPx` is the whole of the second half: a centred stroke of width `w` starts at `-w/2`
 * from the border edge, which is precisely what `outline-offset: -w/2` draws, since an outline
 * paints OUTWARD from its offset edge.
 *
 * ONE SUB-PIXEL DIVERGENCE, named because it is the engine's and not this file's: Blink rounds a
 * painted outline onto the device pixel grid, so the −0.75px specified here is painted at −0.5px
 * on a 2× display — 1px of bleed and 3.0px of air rather than 0.75 and 3.25, where CoreGraphics
 * antialiases the half-pixel instead. It errs in the direction that matters (less air) and still
 * leaves three times the 1px the contract demands. `docs/audit/sidebar-ring-clearance` probes that
 * rounding in the live document rather than assuming it, and asserts these SPECIFIED numbers
 * exactly — an assertion that demanded −0.75px back out of `getComputedStyle` would be asserting
 * Blink, and fails on every Retina display.
 */
export const ROW_CORNER_RADIUS_PX = 7;
export const GROUP_BAND_CORNER_RADIUS_PX = 8;
export const ROW_ACTIVE_RING_PX = 1.5;
export const ROW_SELECTION_RING_PX = 1;
/**
 * Each item's own outer vertical padding; two adjacent items are twice this apart.
 *
 * Worn by workspace rows and group bands, which is the Swift's own set — and, since S47, by the
 * empty-group placeholder too, which the Swift leaves without one. That is an OWNER-DIRECTED
 * divergence and is marked at the placeholder itself.
 */
export const ROW_OUTER_GAP_PX = 2;
/**
 * SPACING-REVIEW S18: what the name column owes the trailing ⌘N badge / collapse chevron.
 *
 * The Swift's floor is 9 (the `HStack` spacing) + 4 (`Spacer(minLength: 4)`) + 9 (the spacing
 * again, because the `Spacer` is a stack member) = **22 pt**. The port's row already carries the
 * outer 9 px as `gap-[9px]`, so this is the 13 the untranscribed `Spacer` was worth.
 */
export const NAME_TRAILING_RESERVE_PX = 13;
/**
 * M7: the 8pt a workspace row gives up on its TRAILING edge, which a group band does not.
 *
 * `WorkspaceListView.swift:798,1339` wrap every workspace row in `.padding(.horizontal, 8)`;
 * `GroupHeaderRow.swift:107` gives the band `.padding(.leading, 8)` and nothing on the trailing
 * side — with the comment saying why (the leading 8 "stands in for the workspace row's call-site
 * .padding(.horizontal, 8) … so the band edge + icon line up with the workspace ring + avatar").
 * So band and row share a left edge and the band is 8pt wider on the right. The scroller's own
 * `px-2` supplies the shared leading inset here; this is the trailing half, which the port had
 * dropped — both boxes were flush right.
 */
export const ROW_TRAILING_INSET_PX = 8;
/**
 * M3: `WorkspaceColor.displayName` (`WorkspaceColor.swift:36`) is `rawValue.capitalized`, so every
 * Color submenu row in the shipped app reads "Red" / "Gray". The port was rendering the raw wire
 * token, which is lowercase.
 */
export function workspaceColorDisplayName(color: string): string {
    return color.length === 0 ? color : `${color[0]?.toUpperCase() ?? ''}${color.slice(1)}`;
}
/**
 * M8: SwiftUI's `design: .rounded` — the face the workspace avatar's LETTER is drawn in
 * (`WorkspaceRowView.swift:145`). `ui-rounded` is the CSS generic for the platform's rounded UI
 * face (SF Rounded on macOS); the named family and the UI face behind it are the fallbacks.
 */
export const ROUNDED_FONT_STACK =
    'ui-rounded, "SF Pro Rounded", "SF Compact Rounded", system-ui, -apple-system, sans-serif';
/** A SwiftUI `.stroke` is centred on the path — half in, half out. */
export function ringOffsetPx(width: number): number {
    return -width / 2;
}
/** How far a ring of this width paints beyond the row's border box. */
export function ringBleedPx(width: number): number {
    return width + ringOffsetPx(width);
}

export const AUTO_SCROLL_EDGE_PX = 40;
export const AUTO_SCROLL_STEP_PX = 3;
export const AUTO_SCROLL_INTERVAL_MS = 15;

/**
 * §WS-008: the sidebar's rendered entry list animates on insert and on reorder.
 *
 * **The reorder half is a real spring now** (`chrome/spring.ts`), not a curve that looks like
 * one. The distinction is not cosmetic and it is not about the still frame: a CSS transition
 * restarted mid-flight begins again from the current position with ZERO velocity and a fresh
 * fixed duration, so a drag crossing three rows in 200 ms produced three stop-and-restart eases
 * where SwiftUI produces one continuous motion. Every displacement below is therefore integrated
 * per frame from `.spring(response: 0.35, dampingFraction: 0.8)`'s own constants and RETARGETED
 * (position and velocity both carried) whenever the layout changes under it.
 *
 * Three mechanisms share the response, and only the first is interruptible:
 *
 *   1. a row that CHANGED PLACE — including mid-drag, which is the motion the user reported as
 *      dead — is FLIPped: measured before/after (`offsetTop`/`offsetLeft`, which no transform
 *      can move) and the delta handed to the spring driver, which unwinds it to zero;
 *   2. a row that APPEARS plays `nex-sidebar-row-enter` once (styles.css). A one-shot entry is
 *      never retargeted, so live physics buys it nothing and it stays on the keyframes;
 *   3. a row that is REMOVED animates a ghost (`ROW_EXIT_MS`), for the reason recorded there —
 *      also a one-shot, also left on its transition.
 *
 * `SPRING_EASING` / `REORDER_MS` are what 2 and 3 still use, plus the row's own `transform`
 * transition, which after this change describes ONE thing: the drag lift's scale relaxing when
 * the gesture ends. The reorder no longer rides on it.
 */
export const ROW_ENTER_ANIMATION = 'nex-sidebar-row-enter';
export const SPRING_EASING = 'cubic-bezier(0.22, 1.2, 0.36, 1)';
export const REORDER_MS = 350;

/**
 * L15: a SPRING-LOADED group opens on a fast ease, not on the entry spring.
 *
 * `WorkspaceListView.swift:1989-1991` wraps the reveal in
 * `withAnimation(.easeInOut(duration: 0.1)) { springLoadedGroupID = target }` — an explicit,
 * deliberately quick curve, because the cursor is already holding a dragged row over the header
 * and the user is waiting on the children to appear underneath it. The port let the newly
 * rendered rows play the ordinary 350ms `nex-sidebar-row-enter`, so a spring-load took three and
 * a half times as long to finish as the shipped app's and the drop zones under the cursor kept
 * moving for most of it.
 *
 * Only the spring-load path is fast. A group opened by CLICKING its chevron still animates on
 * the entry keyframes, which is the Swift's own split: that route mutates through the list's
 * `.animation(.spring(response: 0.35, dampingFraction: 0.8), value: entries)` (`:360-368`).
 */
export const SPRING_LOAD_ENTER_MS = 100;
export const SPRING_LOAD_ENTER_EASING = 'ease-in-out';

/** The `animation` shorthand a row that has just appeared plays. */
export function rowEnterAnimation(fast: boolean): string {
    return fast
        ? `${ROW_ENTER_ANIMATION} ${String(SPRING_LOAD_ENTER_MS)}ms ${SPRING_LOAD_ENTER_EASING} both`
        : `${ROW_ENTER_ANIMATION} ${String(REORDER_MS)}ms ${SPRING_EASING} both`;
}

/**
 * The channel the spring writes, and the reason it is `translate` rather than `transform`.
 *
 * `translate` is an independent transform property: it composes with whatever `transform` the
 * row already carries without either one having to know about the other, and — the part that
 * matters — the row's inline `transform` transition cannot touch it. Writing a spring's
 * per-frame value into a property
 * that is ALSO transitioning is the §WS-001/§WS-002 mistake (an animation left attached to a
 * property a gesture writes every frame); keeping the two on separate properties makes that
 * impossible by construction rather than by discipline.
 *
 * It is also invisible to layout: `offsetTop` / `offsetLeft` — the FLIP's own baseline — are
 * transform-free by definition, so a spring can never feed its own output back into the
 * measurement that started it.
 */
export interface RowOffset {
    readonly x: number;
    readonly y: number;
}

/** Write a row's spring offset into its `translate`, or clear it when the row is home. */
export function writeRowTranslate(element: HTMLElement, offset: RowOffset | undefined): void {
    if (offset === undefined || (offset.x === 0 && offset.y === 0)) {
        element.style.translate = '';
        return;
    }
    const round = (value: number): string => (Math.round(value * 100) / 100).toFixed(2);
    element.style.translate = `${round(offset.x)}px ${round(offset.y)}px`;
}

/**
 * §WS-008's third mechanism: REMOVAL, on the same response as the other two.
 *
 * The constraint that kept this unimplemented is real and unchanged — holding a dead row alive
 * in the list would put a phantom into the drag geometry §WS-093's measure gate has to trust,
 * and `measuredHeights()` / `measuredOffsets()` walk exactly the rows that are alive. So the
 * data model removes the row INSTANTLY (React unmounts it, `registerRow` drops it out of
 * `rowElements`, and the rows below FLIP up on the spring curve) and what animates is a
 * *visual-only ghost*: a sanitised clone of the dead row, parked in an absolutely-positioned
 * layer that is out of flow, never registered, and therefore invisible to every measurement —
 * see `spawnRemovalGhosts`.
 *
 * Collapsing a group takes the same path: a collapse removes the group's child rows (or, for an
 * EMPTY group, its "No workspaces" row) from the rendered list, so each one ghosts out instead
 * of cutting.
 */
export const ROW_EXIT_MS = REORDER_MS;

/**
 * §WS-102's reveal: the Swift scrolls the minimum amount over 0.22s. `scrollIntoView` gives the
 * minimum for free but owns its own timing, so the measured path animates `scrollTop` itself
 * (`chrome/sidebar-scroll.ts`) and keeps the duration the spec names.
 */
export const REVEAL_MS = 220;
/**
 * §N34: how long past the animation the reveal keeps re-measuring the row it revealed.
 *
 * The Swift retries its reveal off the row's height-preference change; a browser has no such
 * signal, so the port watches instead — and it has to, because the layout a reveal is measured
 * against keeps moving after the measurement. The one that filed this row is the inline rename
 * field: `runCreateGroup` queues the scroll and the rename as two updates, so the group header
 * is measured at 36 px and mounts its field a commit later at 38, leaving the header's foot
 * past the fold with nothing to re-arm the reveal. The window is bounded and stops dead on the
 * first wheel or pointer-down, so it can never fight a person who has taken the list back.
 */
export const REVEAL_SETTLE_MS = 400;
/**
 * §WS-102's "wait until the newly inserted row has actually measured". The Swift retries off
 * the height preference change; a browser has no such signal, so the reveal re-checks on
 * animation frames and gives up after this many — ~0.5s at 60Hz, far longer than a row takes to
 * lay out, and bounded so a pathological target can never spin forever.
 */
export const REVEAL_MEASURE_ATTEMPTS = 30;

// ── small pieces ────────────────────────────────────────────────────────────────────

/**
 * The bounds of the row a context-menu event was raised on — what `menuAnchorFromEvent` needs
 * in order to keep the menu off it (run-B m7). Degrades to `null` where there is no layout
 * (jsdom has no box model), which puts the menu back at the pointer.
 */
function rowRect(event: React.MouseEvent): { top: number; bottom: number } | null {
    const element = event.currentTarget;
    const rect = element instanceof Element ? element.getBoundingClientRect() : undefined;
    if (rect === undefined || (rect.top === 0 && rect.bottom === 0)) return null;
    return { top: rect.top, bottom: rect.bottom };
}

interface AgentCounts {
    readonly running: number;
    readonly waiting: number;
}

function agentCounts(workspaces: readonly ChromeWorkspace[]): AgentCounts {
    let running = 0;
    let waiting = 0;
    for (const workspace of workspaces) {
        for (const pane of workspace.panes) {
            if (pane.status === 'running') running += 1;
            else if (pane.status === 'waitingForInput') waiting += 1;
        }
    }
    return { running, waiting };
}

/** §5.3: waiting wins over running; nothing when neither. */
function statusDotColor(counts: AgentCounts): string | null {
    if (counts.waiting > 0) return tokens.statusWaiting;
    if (counts.running > 0) return tokens.statusRunning;
    return null;
}

function StatusDot({
    counts,
    top
}: {
    readonly counts: AgentCounts;
    /**
     * L18: the two hosts offset the dot by DIFFERENT amounts. `.offset(x: 3, y: -3)` on a
     * workspace avatar (`WorkspaceRowView.swift:129`) and `.offset(x: 3, y: -2)` on a group
     * glyph (`GroupHeaderRow.swift:139`) — the group's icon has no filled box under it, so its
     * dot sits a point lower. The port drew one `-top-[3px]` for both.
     */
    readonly top: 2 | 3;
}): ReactElement | null {
    const color = statusDotColor(counts);
    if (color === null) return null;
    return (
        <span
            data-testid="status-dot"
            data-status={counts.waiting > 0 ? 'waiting' : 'running'}
            /*
             * §AGNT-103 / §AGNT-104 / §H24: the dot BREATHES — its own opacity fades 1 → 0.35
             * and back on a 1 s ease-in-out, which is `PulsingStatusDot`
             * (`WorkspaceRowView.swift:16-20`) exactly. There is no halo in the Swift and there
             * is none here any more; `--nex-dot-halo` went with the ring it drew.
             *
             * The animation lives in styles.css because it needs `@keyframes` and because it
             * drops out under `prefers-reduced-motion`. `--nex-dot-ring` — the Swift's
             * `borderColor` stroke, the sidebar's own background so the dot separates from the
             * avatar under it — is published here and PAINTED by the class rather than inline,
             * so the animated `opacity` carries the fill and the ring together, as one view's
             * opacity does in SwiftUI.
             */
            className="nex-agent-dot-pulse absolute -right-[3px] h-[9px] w-[9px] rounded-full"
            style={
                {
                    top: -top,
                    background: color,
                    '--nex-dot-ring': tokens.sidebarBackground
                } as CSSProperties
            }
        />
    );
}

interface AvatarProps {
    readonly name: string;
    readonly color: WorkspaceColor;
    readonly icon: ChromeWorkspace['icon'];
    readonly bucket: ChromeBucket;
    readonly counts: AgentCounts;
}

function Avatar(props: AvatarProps): ReactElement {
    const hex = workspaceColorHex(props.color, props.bucket);
    const glyph = iconGlyph(props.icon);
    return (
        <span className="relative inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[5px]">
            <span
                aria-hidden
                className="absolute inset-0 rounded-[5px]"
                // SET-038: the fill and border opacities are user settings, published as CSS
                // variables by the theme container (`sidebarTintCssVars`) rather than threaded
                // down as props — see `tintedColor`. The literals are the shipped defaults and
                // the fallback for a fixture mounted outside a provider.
                style={{
                    background: tintedColor(hex, SIDEBAR_TINT_VARS.avatarFill, 0.2),
                    border: `1px solid ${tintedColor(hex, SIDEBAR_TINT_VARS.avatarStroke, 0.45)}`
                }}
            />
            {/*
             * M8: the avatar's three contents are THREE type recipes in the Swift
             * (`WorkspaceRowView.swift:134-148`), not one — an emoji at 12, a symbol at 12
             * semibold, and the LETTER at 11 bold in the ROUNDED face. The port had one
             * `text-[11px] font-semibold` on the container, so every glyph was a point small
             * and the letter was the UI face at the wrong weight.
             */}
            <span
                className={glyph === null ? 'relative text-[11px] font-bold' : 'relative text-[12px] font-semibold'}
                style={{
                    ...(iconIsTintable(props.icon) || glyph === null ? { color: hex } : {}),
                    // `design: .rounded` — SF Rounded, with the stack falling back to the UI face
                    // wherever it is not installed.
                    ...(glyph === null ? { fontFamily: ROUNDED_FONT_STACK } : {})
                }}
            >
                {glyph ?? avatarLetter(props.name)}
            </span>
            <StatusDot counts={props.counts} top={3} />
        </span>
    );
}

interface LabelChipsProps {
    readonly labels: readonly string[];
    readonly presets: readonly ChromeLabelPreset[];
    readonly bucket: ChromeBucket;
}

/** `maxInlineLabels` — `WorkspaceRowView.swift:66`. Three is the ceiling, never the promise. */
const MAX_INLINE_LABELS = 3;
/** `HStack(spacing: 4)` — `WorkspaceRowView.swift:65`. */
const LABEL_CHIP_GAP_PX = 4;
/** What the `+N` indicator needs beside the chips (measured: 10.45 px at 9 px medium). */
const LABEL_OVERFLOW_RESERVE_PX = 11;
/**
 * How much of a chip's own ink it may lose before it is dropped instead of clipped.
 *
 * At the 180 px sidebar minimum the three chips of a labelled row rendered at 27.09 / 16.41 /
 * 22.00 px against the 39 / 24 / 31 px they wanted — 69 %, 68 %, 71 % — i.e. one glyph and an
 * ellipsis each. A little clipping is the Swift's own behaviour (`.lineLimit(1)`); THIS is not.
 */
const LABEL_CHIP_MIN_INK = 0.8;

/**
 * SPACING-REVIEW S39 (owner-directed) — how many chips the row can show at their own width.
 *
 * A deliberate, owner-directed divergence from `WorkspaceRowView.swift:65-76`, which always
 * draws `min(3, labels.count)` chips and lets each one clip as far as it must. The count falls
 * to 2, 1 or 0 before a chip is squeezed under `LABEL_CHIP_MIN_INK` of its ink, and everything
 * dropped is folded into the `+N` the Swift already has — so a narrow sidebar shows fewer, whole
 * labels instead of three unreadable stubs. `maxInlineLabels = 3` is still the ceiling and
 * §L4's `flex-nowrap` / `truncate` / `min-w-0` recipe is untouched.
 *
 * Widths are intrinsic (the chips' unshrunk boxes); `available` is the chip row's own width.
 */
export function fitLabelChips(
    widths: readonly number[],
    available: number,
    options: { readonly gap?: number; readonly overflowReserve?: number; readonly minInk?: number } = {}
): number {
    const gap = options.gap ?? LABEL_CHIP_GAP_PX;
    const overflowReserve = options.overflowReserve ?? LABEL_OVERFLOW_RESERVE_PX;
    const minInk = options.minInk ?? LABEL_CHIP_MIN_INK;
    // No measurement (jsdom, a hidden row, a zero-width sidebar): keep the Swift's own answer.
    if (!Number.isFinite(available) || available <= 0 || widths.some((width) => width <= 0)) return widths.length;
    for (let count = widths.length; count > 0; count--) {
        let need = 0;
        for (let index = 0; index < count; index++) need += widths[index] ?? 0;
        need += gap * (count - 1);
        if (count < widths.length) need += gap + overflowReserve;
        /*
         * The allowance is written against the last chip, and it bounds ALL of them: flexbox
         * spreads a shortfall `S` in proportion to each item's own width, so chip `i` keeps
         * `1 − S/Σw` of its ink, and `S ≤ w_last × (1 − minInk) ≤ Σw × (1 − minInk)`. Measured:
         * at the 180 px sidebar the two surviving chips render at 91 % and 93 %.
         */
        const give = (widths[count - 1] ?? 0) * (1 - minInk);
        if (need - give <= available + 0.5) return count;
    }
    return 0;
}

/**
 * `fitLabelChips` over the live boxes.
 *
 * Two passes, because a shrunk chip cannot report the width it wanted: while the count is
 * `null` the row renders every capped chip UNSHRUNK (`flexShrink: 0`) and this reads their
 * intrinsic boxes into a per-label cache; from then on the cache answers, so a sidebar resize
 * re-decides without a second render. `useLayoutEffect` runs before paint, so the measuring
 * pass is never seen. Same shape as the footer's `useFooterGaugeBudget` (§N7).
 */
function useLabelChipFit(rowRef: RefObject<HTMLSpanElement | null>, labels: readonly string[]): number | null {
    const key = labels.join('\n');
    const [count, setCount] = useState<number | null>(null);
    const widths = useRef<Map<string, number>>(new Map());
    useLayoutEffect(() => {
        widths.current = new Map();
        setCount(null);
    }, [key]);
    useLayoutEffect(() => {
        const row = rowRef.current;
        if (row === null || labels.length === 0) return undefined;
        const measure = (): void => {
            const available = row.getBoundingClientRect().width;
            if (available <= 0) return;
            if (count === null) {
                const chips = [...row.querySelectorAll('[data-testid="label-chip"]')];
                if (chips.length < labels.length) return;
                labels.forEach((label, index) => {
                    const box = chips[index]?.getBoundingClientRect();
                    if (box !== undefined && box.width > 0) widths.current.set(label, box.width);
                });
            }
            const measured = labels.map((label) => widths.current.get(label) ?? 0);
            if (measured.some((width) => width <= 0)) return;
            const next = fitLabelChips(measured, available);
            setCount((current) => (current === next ? current : next));
        };
        measure();
        if (typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver(measure);
        observer.observe(row);
        return () => {
            observer.disconnect();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, count, rowRef]);
    return count;
}

/**
 * §5.3: up to 3 chips + a `+N` overflow indicator.
 *
 * L4 — three metrics off the Swift, all in `WorkspaceRowView.swift:54, 65-76`:
 *
 *   - the gap under the name is the row's `VStack(alignment: .leading, spacing: 3)`, so THREE
 *     px, not `mt-0.5`'s two;
 *   - the chip row is an `HStack`, which never wraps. A wrapping row is a row whose HEIGHT
 *     depends on its labels, and the sidebar's whole density argument (§H5) is that a row is
 *     one fixed height;
 *   - each chip is `.lineLimit(1)` (`WorkspaceLabelViews.swift:47`), so a long label CLIPS
 *     rather than pushing its neighbours out of the row. `truncate` needs a shrinkable box, so
 *     the chips carry `min-w-0` and the row is `min-w-0` inside the name column.
 *
 * The `+N` indicator is `.font(.system(size: 9, weight: .medium))` at `:72` — the weight was
 * the one thing the port's copy of it dropped.
 */
function LabelChips(props: LabelChipsProps): ReactElement | null {
    const rowRef = useRef<HTMLSpanElement | null>(null);
    const capped = props.labels.slice(0, MAX_INLINE_LABELS);
    const fitted = useLabelChipFit(rowRef, capped);
    if (props.labels.length === 0) return null;
    // S39: `null` is the measuring pass (and the un-measurable case) — show the capped set.
    const measuring = fitted === null;
    const shown = measuring ? capped : capped.slice(0, fitted);
    const overflow = props.labels.length - shown.length;
    return (
        <span
            ref={rowRef}
            data-chip-fit={measuring ? undefined : String(fitted)}
            className="mt-[3px] flex min-w-0 flex-nowrap items-center gap-1"
        >
            {shown.map((label) => {
                const style = resolveLabelStyle(label, props.presets, props.bucket);
                return (
                    <span
                        key={label}
                        data-testid="label-chip"
                        className="min-w-0 truncate rounded-full px-[5px] py-px text-[9px] font-medium"
                        style={{
                            background: style.background,
                            color: style.text,
                            // The measuring pass reads intrinsic widths, which a shrinking box
                            // cannot report. Pre-paint, so it is never on screen.
                            ...(measuring ? { flexShrink: 0 } : {})
                        }}
                    >
                        {label}
                    </span>
                );
            })}
            {overflow > 0 ? (
                <span
                    data-testid="label-overflow"
                    className="shrink-0 text-[9px] font-medium"
                    style={{ color: tokens.textTertiary }}
                >
                    +{overflow}
                </span>
            ) : null}
        </span>
    );
}

interface InlineEditorProps {
    readonly value: string;
    readonly onCommit: (value: string) => void;
    readonly onCancel: () => void;
    readonly label: string;
}

/**
 * §5.4: auto-focused, Enter commits a non-empty trimmed value, Esc cancels, blur commits
 * silently (empty/unchanged → cancel). Focus is assigned on mount, never stolen by a
 * re-render (§15 "inline editors are never robbed of focus").
 */
function InlineEditor(props: InlineEditorProps): ReactElement {
    const [value, setValue] = useState(props.value);
    const ref = useRef<HTMLInputElement | null>(null);
    useEffect(() => {
        ref.current?.focus();
        ref.current?.select();
    }, []);
    const commit = (): void => {
        const trimmed = value.trim();
        if (trimmed.length === 0 || trimmed === props.value) props.onCancel();
        else props.onCommit(trimmed);
    };
    return (
        <input
            ref={ref}
            aria-label={props.label}
            data-testid="inline-editor"
            className="w-full rounded border bg-transparent px-1 py-0.5 text-[13px] outline-none"
            // The rename field is INSIDE the unselectable sidebar, so it has to opt back in or
            // caret-dragging and double-click-to-word die with the smear.
            style={{ borderColor: tokens.accent, color: tokens.textPrimary, ...SELECTABLE_TEXT_STYLE }}
            value={value}
            onChange={(event) => {
                setValue(event.target.value);
            }}
            onClick={(event) => {
                event.stopPropagation();
            }}
            onMouseDown={(event) => {
                event.stopPropagation();
            }}
            onBlur={commit}
            onKeyDown={(event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    commit();
                    return;
                }
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    props.onCancel();
                }
            }}
        />
    );
}

// ── workspace row ───────────────────────────────────────────────────────────────────

interface WorkspaceRowProps {
    readonly workspace: ChromeWorkspace;
    readonly depth: 0 | 1;
    /** The group this row is inside, or `null` at top level — §WS-007's guide needs it, and it
     *  is what lets anything outside the component tell two groups' children apart. */
    readonly groupID?: string | null | undefined;
    readonly active: boolean;
    readonly selected: boolean;
    /** Index in `visibleWorkspaceOrder`; -1 suppresses the badge (filtered list). */
    readonly badgeIndex: number;
    readonly bucket: ChromeBucket;
    readonly presets: readonly ChromeLabelPreset[];
    readonly renaming: boolean;
    readonly dragging: boolean;
    /** §5.5 multi-drag: the other selected rows collapse to zero height for the drag. */
    readonly dragHidden?: boolean | undefined;
    /** §5.5 multi-drag: the `+N` capsule on the grabbed row (0 = no capsule). */
    readonly dragExtra?: number | undefined;
    /**
     * §WS-089: the row is hovering a group-header (append) target, so it previews the nested
     * indentation it is ABOUT to have — state still says it is in its old container.
     */
    readonly nestPreview?: boolean | undefined;
    /**
     * §WS-084, this pass: the gesture IS a drag, so this row's in-flow element is the VACATED
     * SLOT — the gap the drop lands in. Its box is untouched (so every measurement, §WS-093's
     * gate included, still answers exactly what it did) and nothing in it is painted; the
     * cursor clone is the single visible representation of the item being moved.
     *
     * Distinct from `dragging`, which is true from the `mousedown`: a press that never crosses
     * the 5px threshold must not blank the row it is resting on.
     */
    readonly gap?: boolean | undefined;
    /**
     * §WS-007's guide line: the colour of the 1.5px rule that joins an expanded group's
     * children, or absent for a top-level row. The three props are primitives rather than one
     * object so this `memo`'d row is not re-rendered by a fresh literal every frame.
     */
    readonly guideColor?: string | undefined;
    /** Bridge the 2px gap above / below so the rule reads as ONE line, not one dash per row. */
    readonly guideExtendUp?: boolean | undefined;
    readonly guideExtendDown?: boolean | undefined;
    /*
     * §WS-088's 2px accent insertion line USED TO BE A PROP HERE, and is deliberately gone —
     * see the note above `WorkspaceRow`. The GAP is the slot indicator; the group header's own
     * tint (`dropPreview`) is the `ontoGroupHeader` indicator. There is no third one.
     */
    /** §WS-008: the row is newly inserted, so it plays the entry animation once. */
    readonly entering?: boolean | undefined;
    /** L15: this insertion is a SPRING-LOAD reveal, so the entry runs on the 100ms ease. */
    readonly enterFast?: boolean | undefined;
    readonly groupCaption: string | null;
    readonly onActivate: (workspaceID: string, event: React.MouseEvent) => void;
    readonly onContextMenu: (workspaceID: string, event: React.MouseEvent) => void;
    readonly onDragStart: (workspaceID: string, event: React.MouseEvent) => void;
    readonly onCommitRename: (workspaceID: string, name: string) => void;
    readonly onCancelRename: () => void;
    readonly registerRow: (key: string, element: HTMLElement | null) => void;
}

/**
 * THE DROP INDICATOR, and why there is no line in it (2026-08-23).
 *
 * The user's words: "I don't want the highlighted line that appears at the drop zone." Reading
 * the Swift to size the divergence turned it into a PARITY FIX instead, and the finding is
 * worth stating precisely because §WS-088's own item text reads the other way.
 *
 * `dropIndicatorOverlay` (`WorkspaceListView.swift:1864-1901`) is gated on
 * `!shouldLiveApplyDropTarget(target)`, and `shouldLiveApplyDropTarget` (`:2248-2255`) is
 * `true` for `.topLevel` and `.intoGroup` and `false` only for `.ontoGroupHeader`. So the
 * overlay renders for `.ontoGroupHeader` and nothing else — and inside it, the ONE case that
 * would draw the 2pt accent `Rectangle` is `case .topLevel, .intoGroup`, which the gate has
 * already excluded. `dropIndicatorLineY` returns `nil` for `.ontoGroupHeader` by construction
 * (`:1904-1905`, and the explicit `case .ontoGroupHeader: return nil` at `:1948`). The line
 * branch is unreachable in the shipped app: **the original never draws an insertion line on
 * any drop.** Its comment says so in prose — "All targets that point at a specific slot are
 * live-reordered via the reducer, so the row movement itself is the indicator" — and the port
 * now says it in code.
 *
 * What indicates what, after this:
 *
 *   - a SLOT target (`topLevel:` / `intoGroup:`, including a specific position *inside* an
 *     expanded group) is live-applied, so the rows have already moved and the vacated GAP
 *     (§WS-084, d2a7a04) sits exactly where the drop will land. That is the indicator, and it
 *     is the same one the Swift has;
 *   - an `ontoGroupHeader` target is preview-only in both apps, so the header band's 18%
 *     accent tint (`dropPreview`, `GroupHeaderRow`) is the indicator, and it is untouched.
 *
 * No case is left without one: the two are disjoint by construction (`previewGroupID` is
 * non-null exactly when the resolved target is `ontoGroupHeader`), and the gap exists for the
 * whole gesture regardless of which target is live. The dead machinery went with the line —
 * the `insertLine` prop, the `data-insert-line` attribute, the child's `visibility: visible`
 * opt-out of the gap's inherited invisibility, and both ghost-sanitiser entries that existed
 * only to stop the rule riding the cursor.
 */
const WorkspaceRow = memo(function WorkspaceRow(props: WorkspaceRowProps): ReactElement {
    const { workspace } = props;
    // Feeds the avatar's status dot ONLY (§AGNT-103) — the row's git branch and pane count went
    // with §H5's invented metadata line, because `WorkspaceRowView.swift` renders neither.
    const counts = agentCounts([workspace]);

    /**
     * §WS-027: the two row states are a ZStack in the Swift, not a switch — a selected row that
     * is ALSO active draws both fills and both strokes, and reads brighter than either alone.
     * Here that is: the selection fill as the background COLOUR with the active tint layered
     * over it as a background image (two `rgba` fills cannot share one `background-color`), the
     * 1.5px accent as the `outline`, and the selection's 1px stroke at 0.7 opacity as an inset
     * ring — the same order the Swift paints them in, where the thicker accent lands last.
     */
    /*
     * §H6: the active fill is the NEUTRAL theme fill, not the workspace's own colour.
     * `WorkspaceRowView.swift:164` is `.fill(theme.selectionFill.opacity(0.7))` — the same
     * `selectionFill` a selected row uses at full strength one line above it (`:160`), just
     * dimmed. The port used to tint it with `workspaceColorHex(workspace.color, …)` at 16%, so
     * the active-row highlight changed hue on every workspace switch, which the shipped app
     * never does. `withAlpha` on a `var()` token mixes in CSS rather than resolving here, so the
     * 0.7 rides whatever `--nex-selection-fill` the live theme publishes.
     */
    const activeFill = withAlpha(tokens.selectionFill, 0.7);
    // `backgroundColor`, not the `background` shorthand — the paragraph above already says this
    // value IS the background colour, and the shorthand hides it from any measurement once the
    // layered `background-image` is present (jsdom's own shorthand parser drops the whole
    // declaration when a `color-mix()` rides inside the gradient, which is exactly the pair the
    // selected+active row paints). One-for-one: the shorthand only ever carried a colour here.
    const background = props.selected ? tokens.selectionFill : props.active ? activeFill : 'transparent';
    const backgroundImage =
        props.active && props.selected ? `linear-gradient(${activeFill}, ${activeFill})` : undefined;
    /*
     * The ring's WIDTH picks its OFFSET, because the Swift's stroke is centred on the row's
     * background rect rather than tucked inside it — see `ringOffsetPx`. A ring drawn entirely
     * inside the box (the port's old flat `-1px`) is a different, smaller ring, and the number
     * that decides whether it clears its neighbours is `ringBleedPx`, not the width.
     */
    const ringWidth = props.active ? ROW_ACTIVE_RING_PX : props.selected ? ROW_SELECTION_RING_PX : null;
    /*
     * §H22: the SELECTION stroke is `theme.selectionStroke.opacity(0.7)`
     * (`WorkspaceRowView.swift:161`), so it reads the live token exactly as the active stroke on
     * the line below already did. It used to be the literal `#5276B8` — the DARK preset's
     * `--nex-selection-stroke` frozen into the source, which put a dark-theme periwinkle on a
     * light sidebar whose own stroke is `#5e8ac4`.
     */
    const selectionStroke = withAlpha(tokens.selectionStroke, 0.7);
    // One expression for the width, so the painted stroke and the offset derived from it below
    // cannot drift apart — only the colour still asks which state this is.
    const outline =
        ringWidth === null
            ? 'none'
            : `${String(ringWidth)}px solid ${props.active ? tokens.selectionStroke : selectionStroke}`;
    /** The selection ring, kept when the accent outline takes the outer edge. */
    const selectionRing =
        props.active && props.selected
            ? `inset 0 0 0 ${String(ROW_SELECTION_RING_PX)}px ${selectionStroke}`
            : null;

    const hidden = props.dragHidden === true;
    const nested = props.depth === 1 || props.nestPreview === true;
    const gap = props.gap === true;
    const style: CSSProperties = {
        backgroundColor: background,
        ...(backgroundImage === undefined ? {} : { backgroundImage }),
        outline,
        outlineOffset: `${String(ringWidth === null ? 0 : ringOffsetPx(ringWidth))}px`,
        ...(selectionRing === null ? {} : { boxShadow: selectionRing }),
        /*
         * §WS-089: the indent previews the container the row is being dropped INTO while the
         * cursor holds a group header.
         *
         * The property itself is DISCRETE — it lands on 24px in the commit that decides the
         * nesting, which is what keeps `getComputedStyle(row).marginLeft` an exact answer for
         * anything asking whether the indent is really applied. What the eye sees slide is the
         * horizontal half of the FLIP spring: `offsetLeft` moved by 24, so the row is offset
         * back by −24 and springs to zero. Same motion, on a channel that cannot lie to a
         * measurement (and, unlike a `margin-left` transition, cannot lie to the FLIP itself —
         * `offsetLeft` mid-transition reports the *animating* value, which would have made the
         * next measurement read this animation's own frame as a layout change).
         */
        marginLeft: nested ? NEST_INDENT_PX : 0,
        /*
         * M7: the row's own TRAILING inset (`ROW_TRAILING_INSET_PX`), which the group band above
         * it does not get. It is a margin rather than padding for the same reason `marginLeft` is:
         * it has to sit OUTSIDE the background box and the ring, so the band reads 8px wider on
         * the right than the rows it heads — `WorkspaceRowView`'s call-site `.padding(.horizontal,
         * 8)` against `GroupHeaderRow.swift:107`'s leading-only 8.
         */
        marginRight: ROW_TRAILING_INSET_PX,
        /*
         * The Swift's OUTER vertical padding (`WorkspaceRowView.swift:97`), which lives outside
         * the ring and is the whole reason a ring never touches its neighbour. It is inline
         * rather than a `my-0.5` class so the number is the same constant the ring geometry
         * derives from — and so a test in a box-model-free jsdom can still read it.
         *
         * Two adjacent items are therefore `2 * ROW_OUTER_GAP_PX` apart, which is only true
         * because the list is a FLEX column: block siblings collapse their margins and this
         * would silently be one 2px gap, half the Swift's — the defect this pass fixed.
         */
        borderRadius: ROW_CORNER_RADIUS_PX,
        marginTop: ROW_OUTER_GAP_PX,
        marginBottom: ROW_OUTER_GAP_PX,
        transition: props.dragging === true
            ? // The lift is instant: a 350 ms transform transition would make grabbing a row
              // feel like it lagged the cursor.
              'none'
            : // The reorder is the SPRING (`data-reorder`); what is left on `transform` is the
              // lift's `scale(1.03)` relaxing once the gesture ends.
              `transform ${String(REORDER_MS)}ms ${SPRING_EASING}`,
        // §5.5: the OTHER rows of a multi-selection collapse to zero height so the grid closes
        // over them.
        opacity: hidden ? 0 : 1,
        /*
         * THE GAP (§WS-084, this pass).
         *
         * The row the user grabbed leaves an EMPTY SLOT behind it and the cursor clone is the
         * only picture of the item — which is what the shipped app does for free, because there
         * the grabbed row IS the thing under the cursor (`.offset(y: dragCurrentY …)`,
         * `WorkspaceListView.swift:1392`) and SwiftUI's `.offset` does not touch layout, so the
         * slot it came out of is visibly vacant for the whole gesture. The port draws the row in
         * flow (it is the live preview the drop zones are measured from), so the vacancy has to
         * be asked for.
         *
         * `visibility` is the property that asks for it, and the choice is load-bearing twice
         * over: the box is UNCHANGED, so `offsetTop`/`offsetLeft`/`getBoundingClientRect`
         * answer exactly what they answered before and §WS-093's measure gate cannot tell the
         * difference; and nothing in the subtree is painted, chrome included (fill, outline,
         * the §WS-027 ring, §WS-007's guide), which `opacity: 0` would also do but a
         * `height: 0` would not.
         *
         * (It used to be load-bearing a third time — `visibility` is the one hiding primitive a
         * CHILD can opt back out of, which is how §WS-088's insertion line stayed painted
         * inside an invisible row. The line is gone, so nothing opts out any more and the slot
         * is empty in the strong sense: no descendant of a gap paints anything.)
         */
        ...(gap ? { visibility: 'hidden' as const } : {}),
        ...(hidden
            ? {
                  height: 0,
                  minHeight: 0,
                  marginTop: 0,
                  marginBottom: 0,
                  paddingTop: 0,
                  paddingBottom: 0,
                  overflow: 'hidden',
                  pointerEvents: 'none' as const
              }
            : {}),
        // §WS-007's guide rule is absolutely positioned inside the row.
        position: 'relative',
        // §WS-008: a row that has just appeared plays its entry once — a ONE-SHOT, never
        // retargeted, so it stays on the keyframes while the reorder half went to real physics.
        ...(props.entering === true ? { animation: rowEnterAnimation(props.enterFast === true) } : {})
    };

    const row = (
        <div
            ref={(element) => {
                props.registerRow(`ws:${workspace.id}`, element);
            }}
            data-drag-hidden={hidden ? 'true' : undefined}
            data-guide={props.guideColor === undefined ? undefined : 'true'}
            data-entering={props.entering === true ? 'true' : undefined}
            /* §WS-008: the reorder channel this row is displaced on, so an audit can tell a
               spring-driven sidebar from a transition-driven one without reading the source. */
            data-reorder="spring"
            /* §WS-053/§SET-186: multi-selection was legible only as a fill colour, so nothing
               outside the component could assert it. */
            data-selected={props.selected ? 'true' : 'false'}
            data-nest-preview={props.nestPreview === true ? 'true' : undefined}
            /* The vacated slot, legible from outside the component — an audit can ask "is the
               drop landing in a gap?" without reading a computed style. */
            data-drag-gap={gap ? 'true' : undefined}
            role="option"
            tabIndex={-1}
            aria-selected={props.active}
            data-testid="workspace-row"
            data-workspace-id={workspace.id}
            {...(props.groupID === undefined || props.groupID === null ? {} : { 'data-group-id': props.groupID })}
            data-depth={props.depth}
            data-active={props.active ? 'true' : 'false'}
            /* The radius and the 2px outer margins are inline (see `style`), on the Swift's own
               constants — `rounded-[7px] my-0.5` said the same thing in a vocabulary no jsdom
               test and no derivation could read. */
            /* L3: `HStack(spacing: 9)` (`WorkspaceRowView.swift:51`) — avatar → name is NINE
               points, not Tailwind's nearest 8. */
            className="flex cursor-default items-center gap-[9px] px-2 py-1.5"
            style={style}
            onMouseDown={(event) => {
                props.onDragStart(workspace.id, event);
            }}
            onClick={(event) => {
                props.onActivate(workspace.id, event);
            }}
            onContextMenu={(event) => {
                props.onContextMenu(workspace.id, event);
            }}
        >
            {/*
             * §WS-007: children of an expanded group are joined by a CONTINUOUS 1.5px rule at
             * an 18px leading inset, tinted with the group's colour (or the theme divider when
             * it has none). The rows are a flat list, so each child draws its own segment and
             * bridges its OWN outer margin above and below it — which is what makes the run read
             * as one line rather than one dash per row. `left: -6` is the 18px inset measured
             * from the row's own left edge, which sits at the 24px nesting indent.
             *
             * The extension is `ROW_OUTER_GAP_PX` because that is exactly what each row owns of
             * the space between two boxes: neighbours each bridge their own half and the two
             * segments MEET. Before §WS-027's clearance fix those margins collapsed, so the two
             * halves bridged a gap that was only 2px wide and overlapped by 2px (the audit read
             * `[-2]`); they now abut at `[0]`, which is the seam the Swift's spacing-0 `VStack`
             * of per-row overlays produces.
             */}
            {props.guideColor === undefined ? null : (
                <span
                    aria-hidden
                    data-testid="group-guide"
                    style={{
                        position: 'absolute',
                        left: -6,
                        top: props.guideExtendUp === true ? -ROW_OUTER_GAP_PX : 0,
                        bottom: props.guideExtendDown === true ? -ROW_OUTER_GAP_PX : 0,
                        width: 1.5,
                        borderRadius: 1,
                        background: props.guideColor,
                        pointerEvents: 'none'
                    }}
                />
            )}
            <Avatar
                name={workspace.name}
                color={workspace.color}
                icon={workspace.icon}
                bucket={props.bucket}
                counts={counts}
            />
            {/*
             * SPACING-REVIEW S18 — `WorkspaceRowView.swift:51,79,84-88` is
             * `HStack(spacing: 9) { avatar; VStack; Spacer(minLength: 4); Text("⌘n") }`, and
             * SwiftUI spends an `HStack`'s spacing on EVERY adjacent pair, the `Spacer`
             * included: 9 + 4 + 9 = **22 pt** between a truncated name and the ⌘N badge (§L50's
             * arithmetic, used again in §L9). The reserved `Spacer` has no transcription here —
             * the name column IS the flex filler — so the only clearance left was the single
             * 9 px gap, on every row, ellipsis or not. The reserve comes out of the name column,
             * which is exactly what the Swift also spends.
             */}
            <span className="flex min-w-0 flex-1 flex-col" style={{ marginRight: NAME_TRAILING_RESERVE_PX }}>
                {props.renaming ? (
                    <InlineEditor
                        label={`Rename ${workspace.name}`}
                        value={workspace.name}
                        onCommit={(name) => {
                            props.onCommitRename(workspace.id, name);
                        }}
                        onCancel={props.onCancelRename}
                    />
                ) : (
                    <span
                        className="truncate text-[13px] font-semibold"
                        style={{ color: props.active ? tokens.textPrimary : tokens.textSecondary }}
                    >
                        {workspace.name}
                    </span>
                )}
                <LabelChips labels={workspace.labels} presets={props.presets} bucket={props.bucket} />
                {/*
                 * §H5: THERE IS NO THIRD LINE. `WorkspaceRowView.swift:54-77` is exactly
                 * `VStack(alignment: .leading, spacing: 3) { name; labels }` — no branch chip, no
                 * pane count, no running/waiting counters. The port used to carry all four in a
                 * `text-[10px]` metadata span, which added a whole text line to every row and cost
                 * the sidebar the shipped app's density.
                 *
                 * The agent state a row DOES report is the one the Swift reports: the pulsing dot
                 * on the avatar (`Avatar` ▸ `StatusDot`, §AGNT-103), which is unchanged — the
                 * `counts` this row computes still feed it, and waiting still beats running there.
                 * The branch and the pane count live in the inspector and the footer, as they do
                 * in the shipped app.
                 */}
                {/* L6: the "in <group>" caption is NOT part of the name column — see below. */}
            </span>
            {/*
             * L7: the multi-drag counter is a trailing OVERLAY, not a flex item.
             *
             * `WorkspaceListView.swift:1348-1358` hangs it on `.overlay(alignment: .trailing)`
             * over the already-padded row, in a `.monospaced` 10pt semibold on an accent
             * `Capsule`, inset `.padding(.trailing, 12)`. The port made it a sibling in the
             * row's `HStack`, so it PUSHED the name column narrower as the drag started and
             * sat to the LEFT of the ⌘N badge instead of covering it.
             *
             * The 12pt inset is measured from the outer padded frame, and this port keeps that
             * frame's trailing 8 as the row's own `marginRight` (M7) — so 12 from there is
             * `right: 4` from the row's border box. Same pixel, different origin.
             */}
            {props.dragExtra !== undefined && props.dragExtra > 0 ? (
                <span
                    data-testid="drag-count"
                    className="pointer-events-none absolute top-1/2 -translate-y-1/2 rounded-full px-1.5 py-[2px] font-mono text-[10px] font-semibold"
                    style={{ right: 4, background: tokens.accent, color: '#fff' }}
                >
                    +{props.dragExtra}
                </span>
            ) : null}
            {props.badgeIndex >= 0 && props.badgeIndex < 9 ? (
                <span
                    data-testid="cmd-badge"
                    className="shrink-0 font-mono text-[10px]"
                    style={{ color: tokens.textTertiary }}
                >
                    ⌘{props.badgeIndex + 1}
                </span>
            ) : null}
        </div>
    );

    if (props.groupCaption === null) return row;
    /*
     * L6: the filtered list's "in <group>" caption sits BELOW the whole row, not inside the
     * name column.
     *
     * `WorkspaceListView.swift:772-796` is a `VStack(alignment: .leading, spacing: 0)` holding
     * the row and then the caption — 9pt tertiary, `.padding(.leading, 20)`, `.padding(.bottom,
     * 2)`. The port put it in the row's own `VStack` at 10px, which lengthened the row (and, on
     * a row that also carries labels, gave the filtered list a taller row than the main list's).
     * The 20pt leading is measured from the row's own leading edge, which is where this padding
     * is measured from too.
     */
    return (
        <div className="flex flex-col">
            {row}
            <span
                data-testid="row-group-caption"
                className="text-[9px]"
                style={{ color: tokens.textTertiary, paddingLeft: 20, paddingBottom: 2 }}
            >
                in {props.groupCaption}
            </span>
        </div>
    );
});

// ── group header row ────────────────────────────────────────────────────────────────

interface GroupHeaderRowProps {
    readonly group: ChromeGroup;
    readonly collapsed: boolean;
    readonly counts: AgentCounts;
    readonly bucket: ChromeBucket;
    readonly renaming: boolean;
    readonly dropPreview: boolean;
    readonly onToggle: (groupID: string) => void;
    readonly onContextMenu: (groupID: string, event: React.MouseEvent) => void;
    readonly onDragStart: (groupID: string, event: React.MouseEvent) => void;
    readonly onCommitRename: (groupID: string, name: string) => void;
    readonly onCancelRename: () => void;
    readonly registerRow: (key: string, element: HTMLElement | null) => void;
    /** §WS-008: the entry animation, as for a workspace row. The reorder is the FLIP spring. */
    readonly entering?: boolean | undefined;
    /** L15: this insertion is a SPRING-LOAD reveal, so the entry runs on the 100ms ease. */
    readonly enterFast?: boolean | undefined;
}

const GroupHeaderRow = memo(function GroupHeaderRow(props: GroupHeaderRowProps): ReactElement {
    const { group } = props;
    const hex = group.color === null ? tokens.textTertiary : workspaceColorHex(group.color, props.bucket);
    const glyph = iconGlyph(group.icon);
    // §WS-036: `null` = draw whatever glyph the icon names; otherwise the folder, outlined or
    // filled. A group with no icon at all is a folder, and so is one that explicitly picked the
    // `folder` symbol — both take the fill upgrade from the group's colour.
    const folderIcon: 'outlined' | 'filled' | null =
        group.icon === null || (group.icon.kind === 'system' && group.icon.name.startsWith('folder'))
            ? group.color === null && group.icon?.name !== 'folder.fill'
                ? 'outlined'
                : 'filled'
            : null;
    return (
        <div
            ref={(element) => {
                props.registerRow(`header:${group.id}`, element);
            }}
            data-testid="group-header"
            data-group-id={group.id}
            data-collapsed={props.collapsed ? 'true' : 'false'}
            data-drop-preview={props.dropPreview ? 'true' : 'false'}
            data-entering={props.entering === true ? 'true' : undefined}
            data-reorder="spring"
            /* L3: `HStack(spacing: 9)` (`GroupHeaderRow.swift:38`), the workspace row's own. */
            className="flex cursor-default items-center gap-[9px] px-2 py-1.5"
            style={{
                /*
                 * `GroupHeaderRow.swift:98` — an 8pt band, one point rounder than a row's 7pt
                 * ring — and `:110`'s outer 2pt, the same padding a workspace row carries so the
                 * spacing either side of a band is uniform. Inline for the same reason the row's
                 * are: these are the numbers §WS-027's clearance is derived from.
                 */
                borderRadius: GROUP_BAND_CORNER_RADIUS_PX,
                marginTop: ROW_OUTER_GAP_PX,
                marginBottom: ROW_OUTER_GAP_PX,
                /*
                 * §H22: both non-coloured cases read the THEME rather than a dark-preset hex.
                 *
                 *   - the drop preview is `Color.accentColor.opacity(0.18)`
                 *     (`WorkspaceListView.swift:1894`) → `tokens.accent`, not the literal
                 *     `#6F9BD8` the dark palette happens to publish for it;
                 *   - a COLOURLESS group is `(color?.color ?? theme.textTertiary)` at the very
                 *     same band opacity a coloured one gets (`GroupHeaderRow.swift:27-30` — one
                 *     `headerTint` expression, the `??` is the only branch). `hex` already IS
                 *     that `??`, so the colourless case simply stops being a branch here and
                 *     goes through `tintedColor` like every other band: SET-037/038's intensity
                 *     and band-fill knobs reach it, and light mode gets
                 *     `--nex-group-band-opacity: 0.3` instead of a frozen 0.16 of the dark
                 *     preset's `#8A8A92`.
                 */
                // SET-038's "Group band fill". The stored `-1` sentinel is resolved to the
                // appearance preset's band opacity before it reaches the variable, so the
                // default here is the preset value the band has always used.
                background: tintedColor(hex, SIDEBAR_TINT_VARS.groupFill, 0.22),
                /*
                 * L10: the `ontoGroupHeader` preview is an accent rectangle drawn ON TOP of the
                 * band, not a replacement for it.
                 *
                 * `WorkspaceListView.swift:1891-1898` overlays `Color.accentColor.opacity(0.18)`
                 * across the header's y-range in the drop-indicator layer — the band underneath
                 * keeps painting, so the group's own colour still reads through the tint and the
                 * user can see WHICH group is about to take the drop. The port swapped the fill
                 * out (so a red group and a blue one previewed identically) and added a 1px
                 * accent border the Swift never draws. `background-image` layers the wash over
                 * the fill without a second node, exactly as the row's selected+active pair does.
                 */
                ...(props.dropPreview
                    ? {
                          backgroundImage: `linear-gradient(${withAlpha(tokens.accent, 0.18)}, ${withAlpha(
                              tokens.accent,
                              0.18
                          )})`
                      }
                    : {}),
                border: `1px solid ${tintedColor(hex, SIDEBAR_TINT_VARS.groupStroke, 0)}`,
                // §WS-008: a header reorders (a whole group block moving) exactly like a row —
                // on the same FLIP spring, written to `translate`. What is left on `transform`
                // is the lift, as on a workspace row.
                transition: `transform ${String(REORDER_MS)}ms ${SPRING_EASING}`,
                ...(props.entering === true ? { animation: rowEnterAnimation(props.enterFast === true) } : {})
            }}
            onMouseDown={(event) => {
                props.onDragStart(group.id, event);
            }}
            onClick={() => {
                if (!props.renaming) props.onToggle(group.id);
            }}
            onContextMenu={(event) => {
                props.onContextMenu(group.id, event);
            }}
        >
            {/*
             * M8: the band's glyph slot is one step LARGER than a row's avatar in the Swift —
             * `GroupHeaderRow.swift:145-167` draws the folder at 14 and an emoji at 13, where the
             * port had 13 and 12. (A CUSTOM SF Symbol is 14 there and shares this 13px slot here,
             * because the port draws it as a text glyph rather than as an image; M8 names the
             * folder and the emoji, and that one-point residue is left where it was found.)
             */}
            <span className="relative inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center text-[13px]">
                {/*
                 * §WS-036: the folder is OUTLINED for a colourless group and FILLED once the
                 * group has a colour — the Swift's `folder` → `folder.fill` switch, in the
                 * only vocabulary this renderer has. A `system:folder` token chosen from the
                 * Symbol palette takes the same upgrade instead of falling through to the
                 * generic glyph table, so the two paths agree.
                 */}
                {folderIcon === null ? (
                    <span style={iconIsTintable(group.icon) ? { color: hex } : undefined}>{glyph}</span>
                ) : (
                    <span style={{ color: hex }}>
                        <ChromeIcon name="folder" size={14} filled={folderIcon === 'filled'} />
                    </span>
                )}
                <StatusDot counts={props.counts} top={2} />
            </span>
            {/*
              * §H23: `flex` on the WRAPPER, not just `min-w-0 flex-1`.
              *
              * `GroupHeaderRow.swift:76-81` is `.lineLimit(1).truncationMode(.tail)`, so a long
              * group name ellipsizes. The port's inner span already carried `truncate`, and it
              * did nothing: the wrapper was a flex ITEM (so blockified) but not a flex
              * CONTAINER, which leaves the inner span an inline box — and `overflow: hidden` /
              * `text-overflow: ellipsis` have no effect on an inline box, so the name ran out
              * past the chevron. Making the wrapper a flex container gives the inner span a
              * block-level box to clip inside. It is the workspace row's exact wrapper
              * (`flex min-w-0 flex-1 flex-col`, §H23's "Contrast") rather than a bare `flex`,
              * because COLUMN also keeps the rename `<input className="w-full">` stretched to
              * the wrapper instead of being sized against its intrinsic `size` in a row axis.
              */}
            {/* S18 again: `GroupHeaderRow.swift:38,83,85-89` is the same
                `HStack(spacing: 9) … Spacer(minLength: 4) … chevron` chain, so the band owes the
                truncated group name the same 22 pt before its collapse chevron. */}
            <span className="flex min-w-0 flex-1 flex-col" style={{ marginRight: NAME_TRAILING_RESERVE_PX }}>
                {props.renaming ? (
                    <InlineEditor
                        label={`Rename ${group.name}`}
                        value={group.name}
                        onCommit={(name) => {
                            props.onCommitRename(group.id, name);
                        }}
                        onCancel={props.onCancelRename}
                    />
                ) : (
                    <span
                        data-testid="group-name"
                        className="truncate text-[13px] font-bold"
                        style={{ color: tokens.textPrimary }}
                    >
                        {group.name}
                    </span>
                )}
            </span>
            {/*
             * §WS-041: the chevron is HIDDEN while the header is being renamed. The field wants
             * the whole row — a click-drag inside it selects text — and a collapse control
             * sitting beside a live editor is a way to lose the edit by half a pixel.
             */}
            {props.renaming ? null : (
                <button
                    type="button"
                    aria-label={props.collapsed ? `Expand ${group.name}` : `Collapse ${group.name}`}
                    data-testid="group-chevron"
                    className="shrink-0"
                    /* L8: `.font(.system(size: 11, weight: .semibold))` +
                       `.foregroundStyle(theme.textTertiary)` (`GroupHeaderRow.swift:85-89`) —
                       the port drew it a point large, in the secondary colour, at the regular
                       stroke. Both apps SWAP the glyph rather than rotate it. */
                    style={{
                        color: tokens.textTertiary,
                        /*
                         * SPACING-REVIEW S46 (OWNER-DIRECTED) — the hit box only.
                         *
                         * `GroupHeaderRow.swift:85-89` has no button here AT ALL: the chevron is
                         * a plain `Image(systemName:)` and the toggle target is the whole band
                         * (`:111-120`'s `.contentShape(Rectangle()).onTapGesture`). The port
                         * draws a real `<button>` with `stopPropagation` instead, and that
                         * button measured 11.00 × 11.00 with its right edge on x 203 — the
                         * band's own content-box edge, i.e. ZERO clearance inside the padding
                         * box. So the target size here is the port's own to choose; there is no
                         * Swift number to depart from, only a Swift construction.
                         *
                         * `padding: 5` → a 21 × 21 target. `margin: -5` on all four sides rather
                         * than the register's `marginRight: -5` alone, and both halves are
                         * measured: with only the right margin the button's margin box grows to
                         * 16 and the `flex-1` name span beside it LOSES 5 px, so a long group
                         * name would ellipsise 5 px earlier — a visible change on exactly the
                         * rows this row is not about. All four sides keep the margin box at
                         * 11 × 11, so the name column, the 22 px glyph slot and the band's
                         * 8/6 padding are all untouched.
                         *
                         * The 5 px of leftward bleed lands inside `NAME_TRAILING_RESERVE_PX`
                         * (§S18's 22 px reserve), so it never reaches the name's own box.
                         * Measured live: hit box 10.5 × 10.5 → 20.5 × 20.5, glyph unmoved at
                         * [192.04, 144.79, 11.01, 11.01], and the 408 × 72 picture of the band
                         * pixel-identical. The band-wide tap target is untouched — clicking
                         * anywhere on the band still toggles, exactly as before.
                         *
                         * Owner-directed: do not re-report. The parity value is no padding.
                         */
                        padding: 5,
                        margin: -5
                    }}
                    onClick={(event) => {
                        event.stopPropagation();
                        props.onToggle(group.id);
                    }}
                    onMouseDown={(event) => {
                        event.stopPropagation();
                    }}
                >
                    <ChromeIcon name={props.collapsed ? 'chevron-right' : 'chevron-down'} size={11} strokeWidth={1.6} />
                </button>
            )}
        </div>
    );
});

// ── the sidebar ─────────────────────────────────────────────────────────────────────

/**
 * §WS-151's two menu-only selection verbs, published imperatively (`SidebarProps.selectionCommandsRef`).
 *
 * Each returns whether it CHANGED anything, so a caller can treat "nothing to do" the way every
 * other conditional gesture in this client does — as a decline, not as a silent success.
 */
export interface SidebarSelectionCommands {
    /** Select every workspace, members of collapsed groups included (§WS-045). */
    selectAll(): boolean;
    /** Clear the multi-selection; false when there was none. */
    deselectAll(): boolean;
}

export interface SidebarProps extends SidebarCallbacks {
    /** Daemon order: `selectSidebarEntries(store)`. */
    readonly entries: readonly ChromeSidebarEntry[];
    readonly activeWorkspaceID: string | null;
    readonly filter: string;
    readonly onFilterChange: (filter: string) => void;
    readonly labelPresets?: readonly ChromeLabelPreset[] | undefined;
    readonly bucket?: ChromeBucket | undefined;
    /** Uniform fallback height used for drag geometry before rows are measured. */
    readonly rowHeight?: number | undefined;
    readonly selectedWorkspaceIDs?: ReadonlySet<string> | undefined;
    readonly onSelectionChange?: ((ids: ReadonlySet<string>) => void) | undefined;
    /**
     * §SET-186 / §APP-109: Escape clears a workspace multi-selection *before* any keybinding
     * lookup, so it beats the default `escape=close_search`.
     *
     * The handle is imperative rather than a `selectionCount` prop because the decision needs
     * three facts the sidebar owns and assembly does not: whether a selection exists, whether
     * one of the sidebar's own overlays (a context menu, a confirmation, the icon sheet, an
     * inline rename, the create form) is up and should eat the key itself, and how to clear
     * the selection. The sidebar publishes ONE predicate — "did I consume this Escape?" — and
     * the dispatcher asks it. Assembly holds the ref; the sidebar fills it while mounted and
     * nulls it on unmount, so a torn-down sidebar can never consume a key.
     */
    readonly escapeRef?: { current: (() => boolean) | null } | undefined;
    /**
     * §WS-151: File ▸ Select All Workspaces / Deselect All Workspaces, published the same way
     * §SET-186's Escape predicate above is.
     *
     * The two rows are menu-only in the shipped app (plain `Button`s outside the binding map,
     * `NexCommands.swift:49-57`), and both need something assembly does not have: the set of
     * every workspace id INCLUDING the members of collapsed groups (§WS-045), and the setter
     * that moves §WS-044's selection anchor with it. Assembly holds the ref; the sidebar fills
     * it while mounted and nulls it on unmount, so a torn-down sidebar can never be driven.
     */
    readonly selectionCommandsRef?: { current: SidebarSelectionCommands | null } | undefined;
    /**
     * §15's one-shot "scroll the new entry into view". Assembly sets it when THIS client's own
     * create lands, and the sidebar clears it through `onScrollHandled` — a delta caused by
     * another client must not yank this one's viewport.
     */
    readonly scrollToWorkspaceID?: string | null | undefined;
    /**
     * §WS-100's other half: the GROUP a create just landed, revealed the same way (its header
     * is the row a group HAS). Shares `onScrollHandled` — there is one queued reveal, and
     * assembly clears both fields with it.
     */
    readonly scrollToGroupID?: string | null | undefined;
    readonly onScrollHandled?: (() => void) | undefined;
    /** §WS-102's 0.22s reveal; overridable so a test does not have to wait it out. */
    readonly revealMs?: number | undefined;
    /**
     * §SET-153 / §SET-144: "begin inline rename of this row", asked for from outside the
     * sidebar — the `rename_workspace` keybinding on the active workspace, and `new_group`,
     * which mints a group and drops straight into its name field. Shaped like
     * `scrollToWorkspaceID`: assembly sets it, the sidebar consumes it once and clears it
     * through `onRenameRequestHandled`, so a re-render cannot re-open a field the user just
     * dismissed. An id with no row (a group another client deleted) is dropped, not retried.
     */
    readonly renameRequest?: { readonly kind: 'workspace' | 'group'; readonly id: string } | null | undefined;
    readonly onRenameRequestHandled?: (() => void) | undefined;
    /**
     * §APP-018 / §WS-151 / §WS-156: "open the New Workspace form", asked for from OUTSIDE the
     * sidebar — ⌘N, the Electron File ▸ New Workspace row, the command palette, and the
     * no-workspace empty state's Create button. The shipped app's `showNewWorkspaceSheet()`.
     *
     * Same shape as `renameRequest`, for the same reason: assembly sets it, the sidebar consumes
     * it once and clears it through `onCreateRequestHandled`, so a re-render cannot re-open a
     * form the user just dismissed. `groupID` preselects the form's group picker (§WS-076); a
     * missing/null one lets §SET-011's inheritance choose, exactly as the footer button does.
     */
    readonly createRequest?:
        | { readonly kind: 'workspace' | 'group'; readonly groupID?: string | null | undefined }
        | null
        | undefined;
    readonly onCreateRequestHandled?: (() => void) | undefined;
    /**
     * "The create SHEET is up" — published because a modal is a whole-window fact, not a sidebar
     * one. Assembly folds it into the same `modalOpen` the Settings window and the palette feed:
     * the key dispatcher stops handing chords to panes behind it (a ⌘D must not split under the
     * sheet), and the Electron shell parks a web pane's native `WebContentsView`, which no
     * z-index in this document can otherwise get above.
     */
    readonly onCreateSheetOpenChange?: ((open: boolean) => void) | undefined;
    /** Timer overrides so drag tests do not have to wait 650 ms in real time. */
    readonly springLoadMs?: number | undefined;
    readonly autoScrollIntervalMs?: number | undefined;
    /**
     * The footer's gear and the Labels submenu's "Manage Labels…" deep link (M8 Settings,
     * shell-ui.md §5.7). Absent = neither is rendered, which keeps every existing fixture and
     * the Electron shell exactly as before. `'labels'` is the only section the sidebar names —
     * the tab vocabulary lives in `settings/`, not here.
     */
    readonly onOpenSettings?: ((section?: 'labels' | undefined) => void) | undefined;
    /**
     * The repo registry: the New Workspace form's Repositories section (§WS-075) and its
     * "Create git worktree" section (§WS-078) both read it. Empty (the default) hides both.
     */
    readonly repos?: readonly ChromeRepo[] | undefined;
    /** Config-defined profile names for the form's Profile picker (§SET-214); `default` leads. */
    readonly profiles?: readonly string[] | undefined;
    /**
     * SET-011's answer for THIS client: the group a new workspace should join when the form is
     * opened without an explicit one (the active workspace's group, when the setting is on).
     * Assembly resolves it because the setting and the active workspace both live there.
     */
    readonly inheritGroupID?: string | null | undefined;
    /**
     * How many agents a workspace still has running (`activeAgentCount` — visible AND parked
     * panes). It turns the delete confirmation into `WorkspaceDeleteGate`'s alert: the count in
     * the message, and a "Don't ask again" that writes `confirm-workspace-delete` (WS-108).
     * Absent = every delete shows the plain confirmation, which is what it did before.
     */
    readonly activeAgentCount?: ((workspaceID: string) => number) | undefined;
    /** The daemon's `confirm-workspace-delete` setting; default true, as the config's is. */
    readonly confirmDeleteWhenActive?: boolean | undefined;
    /** The alert's suppression button — honoured whichever button ended the dialog. */
    readonly onSuppressDeleteConfirm?: (() => void) | undefined;
    /**
     * §WS-052: "Move to Group ▸ New Group…" for a single row.
     *
     * Assembly owns it because the flow needs the CREATED group's id, and that only exists in
     * the command reply: it mints the placeholder name, sends the workspace along with the
     * create, and opens inline rename on the header the reply names. Absent = the entry is not
     * offered (the submenu is then exactly what it was before).
     */
    readonly onCreateGroupWithWorkspace?: ((workspaceID: string) => void) | undefined;
    /**
     * §WS-004 / §WS-123: the footer chevron menu's "New Group", which is `⌘⇧G`'s own gesture
     * — `createGroup(name:autoRename:)` in `WorkspaceListView.swift:414-417`, i.e. mint the
     * placeholder name, drop into inline rename, reveal the header. Assembly owns it for the
     * reason §WS-052's does: both halves need the CREATED group's id and that only exists in
     * the command reply, which this component never sees.
     *
     * Absent (every fixture that predates the chevron) falls back to the footer's New Group
     * FORM, so the menu row is never inert.
     */
    readonly onNewGroupWithRename?: (() => void) | undefined;
}

interface DragState {
    readonly kind: 'workspace' | 'group';
    readonly id: string;
    readonly startY: number;
    readonly originModel: SidebarOrderModel;
    /** Every row this drag moves — the grabbed one, or the whole selection it belongs to. */
    readonly ids: readonly string[];
    active: boolean;
    preview: DropTarget | null;
    /** The last cursor position, so an auto-scroll tick can re-resolve without a new event. */
    clientY: number;
    /**
     * §WS-084's ghost: the row key to clone, and where inside the row the cursor grabbed it, so
     * the ghost holds the same point under the pointer for the whole gesture instead of
     * snapping its corner to the cursor. `clientX` is tracked for the ghost only — the drop
     * math is one-dimensional.
     */
    clientX: number;
    readonly ghostKey: string;
    readonly grabDX: number;
    readonly grabDY: number;
    /** The collapsed group the cursor is dwelling over, and when the dwell started. */
    springCandidate: string | null;
    springTimer: ReturnType<typeof setTimeout> | null;
}

/** The group ids in a sidebar entry list — §WS-095 asks "is this dragged id a group?". */
function groupsInEntries(entries: readonly ChromeSidebarEntry[]): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const entry of entries) if (entry.kind === 'group') ids.add(entry.group.id);
    return ids;
}

/**
 * Attributes a CLONE must never carry.
 *
 * Both ghosts in this file (§WS-008's removal ghost and §WS-084's drag ghost) are made with
 * `cloneNode(true)`, so without this they would duplicate `data-testid="workspace-row"`,
 * `data-workspace-id`, `role="option"` and the rest — and every query that addresses a row by
 * one of those (the audit's, the tests', the app's own) would suddenly match two elements, one
 * of which is a corpse. A ghost is a picture; it answers to nothing.
 */
const GHOST_STRIPPED_ATTRIBUTES = [
    'data-testid',
    'data-workspace-id',
    'data-group-id',
    'data-active',
    'data-depth',
    'data-selected',
    'data-entering',
    'data-guide',
    'data-nest-preview',
    'data-drag-gap',
    'data-drag-hidden',
    'data-collapsed',
    'data-drop-preview',
    'role',
    'id',
    'tabindex',
    'aria-selected',
    'aria-label',
    'aria-hidden'
];

function sanitizeGhost(element: Element): void {
    for (const name of GHOST_STRIPPED_ATTRIBUTES) element.removeAttribute(name);
    for (const child of Array.from(element.children)) sanitizeGhost(child);
}

/**
 * The attribute naming §WS-007's guide rail ON THE CURSOR CLONE.
 *
 * Deliberately not `data-testid="group-guide"`: the rail on the clone is a picture that answers
 * to nothing (the same rule the rest of `sanitizeGhost` enforces), and a query for the guide
 * rule must never find one floating over the pane grid. Its presence or absence is also the
 * cheapest statement of "is the drop resolving inside a group?", which is what the audit reads.
 */
const GHOST_GUIDE_ATTR = 'data-ghost-guide';

/** What the cursor clone needs to know in order to re-dress itself for a new container. */
interface DragGhostChrome {
    /** False for a dragged GROUP header: groups are top level and never take an indent. */
    readonly nestable: boolean;
    /** The clone's width at depth 0 — a member row gives up `NEST_INDENT_PX` of it. */
    readonly baseWidth: number;
    /** The container last applied: a group id, `null` for top level, `undefined` for never. */
    groupID: string | null | undefined;
}

/**
 * `prefers-reduced-motion` in a form that survives jsdom (no `matchMedia`) and the Electron
 * shell alike. Both ghosts consult it: the removal ghost is pure decoration and is skipped
 * outright, and the drag ghost keeps FOLLOWING (that is information, not motion) without its
 * lift transform.
 */
function prefersReducedMotion(): boolean {
    const query = globalThis.matchMedia;
    if (typeof query !== 'function') return false;
    try {
        return query.call(globalThis, '(prefers-reduced-motion: reduce)').matches === true;
    } catch {
        return false;
    }
}

/** How far the released row is from its slot at `mouseup` — the drop settle's starting offset. */
interface DropSettleSeed {
    readonly key: string;
    readonly offset: number;
}

/** The box a row occupied, in the scroller's content space — what a removal ghost inherits. */
interface RowBox {
    readonly top: number;
    readonly left: number;
    readonly width: number;
    readonly height: number;
}

/** A drop target as one short string, for the `data-drag-target` diagnostic (defect N4b). */
function describeTarget(target: DropTarget): string {
    if (target.kind === 'ontoGroupHeader') return `ontoGroupHeader:${target.groupID}`;
    if (target.kind === 'intoGroup') return `intoGroup:${target.groupID}:${String(target.index)}`;
    return `topLevel:${String(target.index)}`;
}

type MenuState =
    | { readonly kind: 'workspace'; readonly id: string; readonly x: number; readonly y: number }
    | { readonly kind: 'group'; readonly id: string; readonly x: number; readonly y: number }
    | { readonly kind: 'background'; readonly x: number; readonly y: number }
    /**
     * §WS-004's footer chevron. It shares `menu` with the three context menus rather than
     * carrying its own state, so opening it closes a row menu and vice versa — one menu at a
     * time, which is what a native menu bar does and what `closeMenu` already guarantees.
     */
    | { readonly kind: 'footer'; readonly x: number; readonly y: number };

type RenameState = { readonly kind: 'workspace' | 'group'; readonly id: string };
type ConfirmState =
    | {
          readonly kind: 'workspace';
          readonly id: string;
          readonly name: string;
          /**
           * Agents this workspace would terminate. > 0 turns the plain confirmation into
           * `WorkspaceDeleteGate`'s alert — the count in the message plus a "Don't ask again"
           * (WS-108) — and 0 leaves it exactly as it was.
           */
          readonly activeAgents?: number | undefined;
      }
    | {
          readonly kind: 'group';
          readonly id: string;
          readonly name: string;
          /**
           * §WS-068: how many workspaces the group held when the prompt was RAISED. The Swift
           * snapshots it for the same reason (`AppReducer.swift:1978-1986`) — the dialog's
           * shape, its message and one of its button labels are all derived from it, and a
           * count that moved under the dialog would relabel a destructive button mid-read.
           */
          readonly memberCount: number;
      }
    /** §WS-060: one confirmation for the whole selection, never N prompts. */
    | { readonly kind: 'workspaces'; readonly ids: readonly string[] };

export function Sidebar(props: SidebarProps): ReactElement {
    const bucket = props.bucket ?? 'dark';
    const presets = props.labelPresets ?? EMPTY_PRESETS;
    const rowHeight = props.rowHeight ?? DEFAULT_ROW_HEIGHT;
    const springLoadMs = props.springLoadMs ?? SPRING_LOAD_MS;
    const autoScrollIntervalMs = props.autoScrollIntervalMs ?? AUTO_SCROLL_INTERVAL_MS;

    const [collapseOverrides, setCollapseOverrides] = useState<ReadonlyMap<string, boolean>>(EMPTY_OVERRIDES);
    const [shadow, setShadow] = useState<SidebarOrderModel | null>(null);
    const [menu, setMenu] = useState<MenuState | null>(null);
    const [rename, setRename] = useState<RenameState | null>(null);
    const [confirm, setConfirm] = useState<ConfirmState | null>(null);
    const [newForm, setNewForm] = useState<{
        kind: 'workspace' | 'group';
        groupID: string | null;
        /** Present for the bulk "Group N Workspaces…" flow: the members to create it around. */
        workspaceIDs?: readonly string[];
    } | null>(null);
    const [internalSelection, setInternalSelection] = useState<ReadonlySet<string>>(EMPTY_SELECTION);
    const [dragID, setDragID] = useState<string | null>(null);
    /**
     * The gesture has passed the 5px threshold AND §WS-093's measure gate — i.e. it is a drag
     * rather than a press. Rendered state (not just the mutable `DragState`) because the GAP
     * must not blank a row the user is merely resting on: a press that never moved leaves the
     * list exactly as it found it.
     */
    const [dragActive, setDragActive] = useState(false);
    /** The group a preview-only `ontoGroupHeader` target is tinting (§5.5). */
    const [previewGroupID, setPreviewGroupID] = useState<string | null>(null);
    /** §5.5 spring-loading: a collapsed group held open for the rest of THIS drag. */
    const [springLoadedGroupID, setSpringLoadedGroupID] = useState<string | null>(null);
    /** The workspace whose icon is being picked in the custom-emoji sheet. */
    const [emojiSheet, setEmojiSheet] = useState<{ kind: 'workspace' | 'group'; id: string } | null>(null);
    /**
     * §WS-075's default swatch, drawn ONCE per opening of the form (the dep is the form state's
     * identity, and every `setNewForm` mints a new object). Re-rolling it on each keystroke
     * would make the colour flicker as the user types the name.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open-edge only: the roll belongs
    // to the OPENING of the form, not to the entries it read on the way past.
    const newFormColor = useMemo(() => nextCreateColor(props.entries), [newForm]);

    const selection = props.selectedWorkspaceIDs ?? internalSelection;
    /**
     * §WS-095: a group being dragged renders **as if collapsed**, so the block the user is
     * moving is one row rather than a header trailed by its children. Its persisted
     * `isCollapsed` is untouched — this is a render-time override that lives exactly as long
     * as the gesture, the same shape as §5.5's spring-load in the other direction.
     *
     * Workspace and group ids are distinct UUIDs, so "is the dragged id a group?" is a lookup
     * rather than another piece of drag state.
     */
    const draggingGroupID = useMemo(
        () =>
            dragActive && dragID !== null && groupsInEntries(props.entries).has(dragID) ? dragID : null,
        [dragActive, dragID, props.entries]
    );
    const collapse: CollapseState = useMemo(() => {
        if (draggingGroupID === null) return { overrides: collapseOverrides, springLoadedGroupID };
        const overrides = new Map(collapseOverrides);
        overrides.set(draggingGroupID, true);
        return { overrides, springLoadedGroupID };
    }, [collapseOverrides, draggingGroupID, springLoadedGroupID]);

    const baseModel = useMemo(() => orderModelFromEntries(props.entries), [props.entries]);
    const effectiveEntries = useMemo(
        () => (shadow === null ? props.entries : projectEntries(props.entries, shadow)),
        [props.entries, shadow]
    );
    const rows = useMemo(() => renderedRows(effectiveEntries, collapse), [effectiveEntries, collapse]);
    const visibleOrder = useMemo(
        () => visibleOrderFromEntries(effectiveEntries, collapse),
        [effectiveEntries, collapse]
    );

    const listRef = useRef<HTMLDivElement | null>(null);
    /** L13: the filter field, so its clear button can drop first responder the way Escape does. */
    const filterInputRef = useRef<HTMLInputElement | null>(null);
    /**
     * §WS-004's footer chevron. The menu is a portal, so opening it needs the button's VIEWPORT
     * rect (the same reason `TopBar`'s ••• menu keeps a ref), and closing it needs the button
     * back so Escape returns focus to where the keyboard user left it.
     */
    const footerMenuButtonRef = useRef<HTMLButtonElement | null>(null);
    const rowElements = useRef(new Map<string, HTMLElement>());
    const dragRef = useRef<DragState | null>(null);
    /** A finished drag is followed by a `click` on the row; that click must not activate it. */
    const suppressClickRef = useRef(false);
    /** Removes the one-shot window listener that retires the flag above, if one is armed. */
    const retireSuppressRef = useRef<(() => void) | null>(null);
    const shadowRef = useRef<SidebarOrderModel | null>(null);
    /** Read by `onUp`, which runs from a window listener and cannot close over the render. */
    const springLoadedRef = useRef<string | null>(null);
    /**
     * L15: armed by the spring-load timer immediately before it flips the group open, read (and
     * cleared) by the layout pass that spots the rows that flip revealed. A ref rather than
     * state because the two live one commit apart and the flag must not itself cause a render.
     */
    const springLoadEnterRef = useRef(false);
    const entriesRef = useRef(props.entries);
    const collapseRef = useRef(collapse);
    const rowsRef = useRef(rows);
    shadowRef.current = shadow;
    springLoadedRef.current = springLoadedGroupID;
    entriesRef.current = props.entries;
    collapseRef.current = collapse;
    rowsRef.current = rows;

    // A fresh order from the daemon supersedes the local shadow (but never mid-drag).
    useEffect(() => {
        if (dragRef.current !== null) return;
        setShadow(null);
    }, [props.entries]);

    /**
     * §WS-008's removal half, in two refs.
     *
     * `rowBoxes` is where each row WAS at the last rendered-list change (content space), and
     * `dyingRows` collects the elements React detached during the commit that is about to run
     * its layout effect. Both exist because a removal is only observable *after* the node is
     * gone: by the time the effect can diff the row list, the row it needs to animate has no
     * geometry and no parent left. Neither map is ever consulted by the drag math — that walks
     * `rowElements`, which holds the LIVE rows only.
     */
    const rowBoxes = useRef(new Map<string, RowBox>());
    const dyingRows = useRef(new Map<string, HTMLElement>());
    const ghostLayerRef = useRef<HTMLDivElement | null>(null);
    /** §WS-084's cursor-following drag ghost: a detached clone parked on `document.body`. */
    const dragGhostRef = useRef<HTMLElement | null>(null);
    /** …and the container it is currently dressed for (`styleDragGhost`). */
    const ghostChromeRef = useRef<DragGhostChrome | null>(null);

    const registerRow = useCallback((key: string, element: HTMLElement | null): void => {
        if (element === null) {
            // React detaches the ref during the mutation phase, while the node still has its
            // last layout; keep it so the layout effect below can decide whether it deserves a
            // ghost. It is REMOVED from `rowElements` in the same breath, so nothing that
            // measures the list can see it from here on.
            const dying = rowElements.current.get(key);
            if (dying !== undefined) dyingRows.current.set(key, dying);
            rowElements.current.delete(key);
            return;
        }
        rowElements.current.set(key, element);
        dyingRows.current.delete(key);
        // A row that re-mounted under a key whose spring is still unwinding gets its offset put
        // back on the new node, or the motion would vanish at the seam.
        const offset = rowOffsets.current.get(key);
        if (offset !== undefined) writeRowTranslate(element, offset);
    }, []);

    /**
     * §WS-008's spring, and the two structures that keep it out of every measurement.
     *
     * `springs` is the physics (`chrome/spring.ts`): one channel per row per axis, keyed
     * `y:<rowKey>` / `x:<rowKey>`. `rowOffsets` is the mirror of what has actually been written
     * to the DOM, and it exists for one reason beyond bookkeeping — `measuredOffsets()` reads
     * client rects, which a `translate` DOES move, so the drag geometry subtracts the live spring
     * offset back out and resolves drop zones against the SETTLED layout. Without that the zones
     * would follow the animation that the zones themselves caused, which is a feedback loop, not
     * a sidebar.
     *
     * The Swift has this for free (`.offset` is applied after the animation modifiers, so the
     * spring never covers the cursor-tracking offset — `WorkspaceListView.swift:1380`). Here the
     * subtraction IS that ordering.
     */
    const springs = useRef<SpringDriver | null>(null);
    springs.current ??= createSpringDriver({
        response: SPRING_RESPONSE_S,
        dampingFraction: SPRING_DAMPING_FRACTION
    });
    const rowOffsets = useRef(new Map<string, RowOffset>());

    /** Write one axis of a row's spring offset, and drop the entry once the row is home. */
    const setRowOffset = useCallback((key: string, axis: 'x' | 'y', value: number): void => {
        const current = rowOffsets.current.get(key) ?? { x: 0, y: 0 };
        const next: RowOffset = axis === 'x' ? { x: value, y: current.y } : { x: current.x, y: value };
        if (next.x === 0 && next.y === 0) rowOffsets.current.delete(key);
        else rowOffsets.current.set(key, next);
        const element = rowElements.current.get(key);
        if (element !== undefined) writeRowTranslate(element, rowOffsets.current.get(key));
    }, []);

    /** Hand a row's layout delta to the spring — the FLIP retarget, one axis at a time. */
    const displaceRow = useCallback(
        (key: string, axis: 'x' | 'y', delta: number): void => {
            const driver = springs.current;
            if (driver === null) return;
            if (prefersReducedMotion()) {
                driver.cancel(`${axis}:${key}`);
                setRowOffset(key, axis, 0);
                return;
            }
            driver.displace(`${axis}:${key}`, delta, (value) => {
                setRowOffset(key, axis, value);
            });
        },
        [setRowOffset]
    );

    /** Forget every channel and offset for a row that has left the list. */
    const forgetRowSprings = useCallback((key: string): void => {
        springs.current?.cancel(`y:${key}`);
        springs.current?.cancel(`x:${key}`);
        rowOffsets.current.delete(key);
    }, []);

    // A spring still integrating when the sidebar unmounts must not keep calling back into it.
    useEffect(
        () => () => {
            springs.current?.cancelAll();
            rowOffsets.current.clear();
        },
        []
    );

    const workspaceByID = useMemo(() => {
        const map = new Map<string, ChromeWorkspace>();
        for (const entry of props.entries) {
            if (entry.kind === 'workspace') map.set(entry.workspace.id, entry.workspace);
            else for (const workspace of entry.workspaces) map.set(workspace.id, workspace);
        }
        return map;
    }, [props.entries]);

    const groups = useMemo(
        () =>
            props.entries
                .filter((entry): entry is ChromeSidebarEntry & { kind: 'group' } => entry.kind === 'group')
                .map((entry) => entry.group),
        [props.entries]
    );

    // The drag loop reads groups from a ref: it runs from window listeners and timers whose
    // closures must not pin a stale render's entry list.
    const groupsRef = useRef(groups);
    groupsRef.current = groups;

    const groupIDForWorkspace = useCallback(
        (workspaceID: string): string | null => locateWorkspace(baseModel, workspaceID)?.groupID ?? null,
        [baseModel]
    );

    /**
     * §WS-007's guide colour: the group's own, or the theme's divider when the group has none.
     * `undefined` for a top-level row, which draws no rule at all.
     */
    const guideColorFor = useCallback(
        (groupID: string | null): string | undefined => {
            if (groupID === null) return undefined;
            const group = groups.find((candidate) => candidate.id === groupID);
            if (group === undefined) return undefined;
            return group.color === null
                ? tokens.divider
                : withAlpha(workspaceColorHex(group.color, bucket), 0.55);
        },
        [bucket, groups]
    );

    // ── selection ───────────────────────────────────────────────────────────────
    /**
     * §WS-044 / §WS-046's `lastSelectionAnchor`, explicit rather than inferred.
     *
     * It used to be read off the selection `Set`'s insertion order, which is right for an ADD
     * and wrong for a REMOVE: ⌘-clicking a row *off* left the anchor on whatever happened to
     * remain last, so the next shift-click ranged from a row the user had not touched. The
     * Swift keeps the field and the rule is simple — a toggle (either direction) moves the
     * anchor to the row that was toggled, and clearing the selection clears it.
     */
    const anchorRef = useRef<string | null>(null);

    const setSelection = useCallback(
        (ids: ReadonlySet<string>, anchor?: string | null): void => {
            setInternalSelection(ids);
            if (anchor !== undefined) anchorRef.current = anchor;
            if (ids.size === 0) anchorRef.current = null;
            props.onSelectionChange?.(ids);
        },
        [props]
    );

    /**
     * §SET-186 / §APP-109's predicate, published to assembly's key dispatcher.
     *
     * Precedence, in the order the checks run: an open overlay owns the key (a macOS menu eats
     * Escape and the selection behind it survives — and the ContextMenu's own handler is what
     * closes it); with nothing open and nothing selected the sidebar declines, so Escape falls
     * through to whatever the user's map binds it to (`close_search` by default); only a real
     * selection with no overlay above it is consumed.
     */
    const escapeRefProp = props.escapeRef;
    const overlayOpen =
        menu !== null || rename !== null || confirm !== null || newForm !== null || emojiSheet !== null;
    const selectionSize = selection.size;
    useEffect(() => {
        if (escapeRefProp === undefined) return;
        escapeRefProp.current = (): boolean => {
            if (overlayOpen) return false;
            if (selectionSize === 0) return false;
            setSelection(EMPTY_SELECTION);
            return true;
        };
        return () => {
            escapeRefProp.current = null;
        };
    }, [escapeRefProp, overlayOpen, selectionSize, setSelection]);

    /**
     * §WS-151's File ▸ Select All / Deselect All Workspaces, published to assembly.
     *
     * The SAME two closures the row context menu's own rows run (§WS-053) — `workspaceByID`'s
     * key set and `EMPTY_SELECTION` — so the menu bar and the context menu cannot select two
     * different things. No overlay check: unlike Escape, these are not a key that something
     * above the sidebar might want; they are an explicit menu choice.
     */
    const selectionCommandsRefProp = props.selectionCommandsRef;
    useEffect(() => {
        if (selectionCommandsRefProp === undefined) return;
        selectionCommandsRefProp.current = {
            selectAll: (): boolean => {
                if (workspaceByID.size === 0) return false;
                setSelection(new Set(workspaceByID.keys()));
                return true;
            },
            deselectAll: (): boolean => {
                if (selectionSize === 0) return false;
                setSelection(EMPTY_SELECTION);
                return true;
            }
        };
        return () => {
            selectionCommandsRefProp.current = null;
        };
    }, [selectionCommandsRefProp, selectionSize, setSelection, workspaceByID]);

    /**
     * §WS-151: an unmounting sidebar has no selection any more, and says so ONCE.
     *
     * The selection lives in this component's own state, so hiding the sidebar (§WS-001's
     * toggle) really does discard it — and a listener that only ever hears about changes made
     * through `setSelection` would be left believing in a selection that no longer exists. The
     * callback is read through a ref so the effect can carry an empty dep list: it must fire on
     * UNMOUNT, not every time assembly hands down a new closure.
     */
    const selectionListenerRef = useRef(props.onSelectionChange);
    selectionListenerRef.current = props.onSelectionChange;
    useEffect(
        () => () => {
            selectionListenerRef.current?.(EMPTY_SELECTION);
        },
        []
    );

    // ── activation ──────────────────────────────────────────────────────────────
    /**
     * Arm the "the click that follows this drag is not an activation" flag, and arrange for it
     * to be retired whether or not a row consumes it.
     *
     * It used to be retired by the row itself, and that worked only while the dragged row was
     * still painted in flow: it was under the cursor at `mouseup`, so the browser's click landed
     * on it, `onActivate` ran, and the flag was cleared on the way past. The row is now the GAP
     * — `visibility: hidden`, and a hidden box is not hit-testable — so `mouseup` lands on the
     * scroller instead and no row handler ever sees the click. Left as it was, the flag would
     * survive the gesture and swallow the user's NEXT genuine click on a row.
     *
     * One window-level listener retires it instead. Bubble phase, deliberately: React attaches
     * its own handlers at the root container, which is below `window`, so a row's `onClick`
     * still runs FIRST and still gets the suppression it is owed — this only cleans up after it.
     */
    const suppressNextClick = useCallback((): void => {
        suppressClickRef.current = true;
        retireSuppressRef.current?.();
        const target = globalThis.window;
        const clear = (): void => {
            suppressClickRef.current = false;
            retireSuppressRef.current = null;
        };
        target.addEventListener('click', clear, { once: true });
        retireSuppressRef.current = (): void => {
            target.removeEventListener('click', clear);
            retireSuppressRef.current = null;
        };
    }, []);
    useEffect(
        () => () => {
            retireSuppressRef.current?.();
        },
        []
    );

    const onActivate = useCallback(
        (workspaceID: string, event: React.MouseEvent): void => {
            if (dragRef.current?.active === true) return;
            if (suppressClickRef.current) {
                suppressClickRef.current = false;
                return;
            }
            if (event.metaKey || event.ctrlKey) {
                const next = new Set(selection);
                if (next.has(workspaceID)) next.delete(workspaceID);
                else next.add(workspaceID);
                // §WS-046: a toggle in EITHER direction moves the anchor to the row toggled.
                setSelection(next, workspaceID);
                return;
            }
            if (event.shiftKey) {
                // §WS-044's fallback chain: last anchor → first selected → active workspace →
                // the clicked row. The last term makes a shift-click with nothing selected
                // select just that row rather than silently behaving like a plain click.
                const anchor =
                    anchorRef.current ?? [...selection][0] ?? props.activeWorkspaceID ?? workspaceID;
                const from = visibleOrder.indexOf(anchor);
                const to = visibleOrder.indexOf(workspaceID);
                if (from >= 0 && to >= 0) {
                    const [lo, hi] = from <= to ? [from, to] : [to, from];
                    // The anchor is NOT moved by a range extension — that is what makes
                    // shift-clicking twice re-range from the same origin instead of walking.
                    setSelection(new Set(visibleOrder.slice(lo, hi + 1)), anchor);
                    return;
                }
            }
            setSelection(EMPTY_SELECTION);
            props.onActivateWorkspace?.(workspaceID);
        },
        [props, selection, setSelection, visibleOrder]
    );

    // ── collapse ────────────────────────────────────────────────────────────────
    const toggleCollapse = useCallback(
        (groupID: string): void => {
            const group = groups.find((candidate) => candidate.id === groupID);
            if (group === undefined) return;
            const current = isGroupCollapsed(group, { overrides: collapseOverrides });
            const next = new Map(collapseOverrides);
            next.set(groupID, !current);
            setCollapseOverrides(next);
            props.onToggleGroupCollapse?.(groupID, !current);
        },
        [collapseOverrides, groups, props]
    );

    /**
     * §WS-112 — an optimistic override lasts until the daemon agrees, and not one render longer.
     *
     * `collapseOverrides` exists so a header click flips NOW rather than after the round trip,
     * and `isGroupCollapsed` lets it win over the mirror's `isCollapsed`. Nothing retired it,
     * though, so the local answer outlived the gesture that made it: once the daemon expands a
     * group on its own — which is exactly what `set-active-workspace` does when the destination
     * is hidden inside a collapsed one (§WS-112's step 3, `reducers/workspaces.ts`) — the
     * broadcast landed in state and the sidebar went on drawing the collapsed group the user
     * had clicked minutes earlier. The daemon's expand was invisible, and the workspace the
     * user had just jumped to stayed hidden behind a closed header.
     *
     * So: drop an override the moment the mirror CONFIRMS it (the round trip is over, it has
     * nothing left to hide) or the group it belongs to disappears. A disagreement is kept —
     * that is a gesture still in flight.
     */
    useEffect(() => {
        setCollapseOverrides((current) => {
            if (current.size === 0) return current;
            let next: Map<string, boolean> | null = null;
            for (const [groupID, value] of current) {
                const group = groups.find((candidate) => candidate.id === groupID);
                if (group !== undefined && group.isCollapsed !== value) continue;
                next ??= new Map(current);
                next.delete(groupID);
            }
            return next ?? current;
        });
    }, [groups]);

    // ── drag ────────────────────────────────────────────────────────────────────
    const contentY = useCallback((clientY: number): number => {
        const list = listRef.current;
        if (list === null) return clientY;
        const rect = list.getBoundingClientRect();
        return clientY - rect.top + list.scrollTop;
    }, []);

    const measuredHeights = useCallback((): ReadonlyMap<string, number> => {
        const heights = new Map<string, number>();
        for (const [key, element] of rowElements.current) {
            const height = element.getBoundingClientRect().height;
            if (height > 0) heights.set(key, height);
        }
        return heights;
    }, []);

    /**
     * Where each row actually STARTS, in the same content space `contentY` resolves a cursor
     * into. Defect N4b: the drag model used to walk the list adding border-box heights, which
     * silently dropped every row's outer margin — `ROW_OUTER_GAP_PX` on each edge, and since
     * §WS-027's clearance fix those no longer collapse, so the dropped error is 4px per row
     * rather than the 2px a block container used to leave — an error that accumulates, so
     * a crowded sidebar resolved the cursor against bands ~10px above the rows the user can
     * see and a drop three quarters of the way down a group header hit no band at all. The
     * measurement is one pass over the already-registered row elements, taken per resolve so
     * it survives a mid-drag reflow.
     *
     * **§WS-093, extended to spring-driven motion.** A client rect includes every transform on
     * the box, so a row that is mid-flight on the reorder spring would report where it is being
     * DRAWN rather than where it belongs — and the drop zones built from that would chase the
     * animation they just caused. The live spring offset is therefore subtracted back out, which
     * makes this function answer the settled layout and nothing else. It is the same exclusion
     * the removal ghost and §WS-084's cursor clone get by never being registered at all; a row
     * that is animating cannot use that trick, because it is a real row the whole time.
     */
    const measuredOffsets = useCallback((): ReadonlyMap<string, number> => {
        const list = listRef.current;
        if (list === null) return new Map<string, number>();
        const origin = list.getBoundingClientRect().top - list.scrollTop;
        const offsets = new Map<string, number>();
        for (const [key, element] of rowElements.current) {
            const rect = element.getBoundingClientRect();
            if (rect.height <= 0) continue;
            offsets.set(key, rect.top - origin - (rowOffsets.current.get(key)?.y ?? 0));
        }
        return offsets;
    }, []);

    /**
     * §WS-093: drag math must never run on stale geometry, so a drag does not START until every
     * rendered row has been measured.
     *
     * The one degradation, stated: an environment with NO box model at all (jsdom, a sidebar
     * that has never laid out) measures nothing, and there is nothing to be stale about — the
     * uniform `rowHeight` fallback IS the geometry there. A PARTIAL measurement is the
     * dangerous case the Swift guard exists for, and that is the case this blocks.
     */
    const geometryReady = useCallback((): boolean => {
        const heights = measuredHeights();
        if (heights.size === 0) return true;
        return rowsRef.current.every((row) => heights.has(row.key));
    }, [measuredHeights]);

    const onDragStart = useCallback(
        (kind: 'workspace' | 'group', id: string, event: React.MouseEvent): void => {
            if (event.button !== 0) return;
            if (rename !== null) return;
            const target = event.target as HTMLElement | null;
            if (target !== null && target.closest('input, button') !== null) return;
            // §5.5 multi-drag: grabbing a row that belongs to a ≥2 selection drags the whole
            // selection. Only the grabbed row live-applies (a single-row gap keeps the target
            // legible); the rest are hidden and land together on release.
            const multi = kind === 'workspace' && selection.size >= 2 && selection.has(id);
            const ids = multi ? visibleOrder.filter((candidate) => selection.has(candidate)) : [id];
            // §WS-084: where inside the row the cursor grabbed it. Measured on the press, from
            // the row's own box, so the ghost keeps that point under the pointer instead of
            // jumping its corner there when the gesture crosses the 5px threshold.
            const grabbed = event.currentTarget as HTMLElement | null;
            const box = grabbed === null ? null : grabbed.getBoundingClientRect();
            dragRef.current = {
                kind,
                id,
                startY: event.clientY,
                originModel: shadowRef.current ?? baseModel,
                ids,
                active: false,
                preview: null,
                clientY: event.clientY,
                clientX: event.clientX,
                ghostKey: kind === 'group' ? `header:${id}` : `ws:${id}`,
                grabDX: box === null ? 0 : event.clientX - box.left,
                grabDY: box === null ? 0 : event.clientY - box.top,
                springCandidate: null,
                springTimer: null
            };
            setDragID(id);
        },
        [baseModel, rename, selection, visibleOrder]
    );

    /**
     * §WS-084's drag ghost: the row, lifted off the list and following the cursor.
     *
     * The shadow-commit model (file header, point 2) means the *real* row cannot leave the flow
     * — it is the live preview of the order the drop will commit, and it is what the drop zones
     * are built from. So the thing that follows the cursor is a sanitised clone parked on
     * `document.body`: fixed-position, `pointer-events: none`, addressable by nothing
     * (`sanitizeGhost`), and — the point — never registered as a row, so `measuredHeights()`,
     * `measuredOffsets()` and §WS-093's `geometryReady()` cannot see it. Since the row it came
     * off is now the GAP, this clone carries §WS-084's whole lift on its own: 1.03 scale, 0.8
     * opacity and a real drop shadow, and it is the SINGLE visible representation of the item
     * for the length of the gesture.
     *
     * Position is written straight onto the node from the mousemove handler rather than through
     * state: a React commit per pointer sample would re-render every row in the sidebar 60
     * times a second, and the FLIP pass would then have to be taught to ignore its own frames.
     */
    const endDragGhost = useCallback((): void => {
        dragGhostRef.current?.remove();
        dragGhostRef.current = null;
        ghostChromeRef.current = null;
    }, []);

    /**
     * Re-dress the clone for the container the drop has RESOLVED to (this pass).
     *
     * The clone is a photograph of the row at the instant it was grabbed, and it used to stay
     * that photograph: drag a workspace out of a group and the thing under the cursor still wore
     * that group's left guide rail and its member width all the way to a top-level drop. The
     * in-flow rows already restyle — §WS-089's depth spring moves them on the x axis the moment
     * the shadow (or the nest preview) says the container changed — so the clone was the last
     * surface still describing where the row came FROM rather than where it is going.
     *
     * It is a RESTYLE, never a rebuild: rebuilding would drop the node the cursor offset is
     * written to and flash one frame of the old picture at the new one's position. Two things
     * change and nothing else — the guide rail (removed outright at top level, minted fresh in
     * the destination group's colour inside one) and the width (a member row is
     * `NEST_INDENT_PX` narrower). The left edge is untouched, because §WS-084's cursor tracking
     * is raw and is not something a restyle is allowed to move.
     *
     * `undefined` means "the cursor resolved to no zone at all", which is not a container change
     * and must leave the clone exactly as it is.
     */
    const styleDragGhost = useCallback(
        (groupID: string | null | undefined, guideColor: string | undefined): void => {
            const ghost = dragGhostRef.current;
            const chrome = ghostChromeRef.current;
            if (ghost === null || chrome === null || groupID === undefined) return;
            if (!chrome.nestable) return;
            if (chrome.groupID === groupID) return;
            chrome.groupID = groupID;
            const nested = groupID !== null;
            ghost.style.width = `${String(Math.max(0, chrome.baseWidth - (nested ? NEST_INDENT_PX : 0)))}px`;
            ghost.dataset['ghostDepth'] = nested ? '1' : '0';
            if (groupID === null) delete ghost.dataset['ghostGroup'];
            else ghost.dataset['ghostGroup'] = groupID;
            ghost.querySelector(`[${GHOST_GUIDE_ATTR}]`)?.remove();
            if (!nested || guideColor === undefined) return;
            // §WS-007's rule, rebuilt rather than borrowed: the cloned one was thrown away at
            // mint precisely so this never has to reason about what the photograph contained.
            const rail = ghost.ownerDocument.createElement('span');
            rail.setAttribute(GHOST_GUIDE_ATTR, 'true');
            rail.setAttribute('aria-hidden', 'true');
            rail.style.position = 'absolute';
            rail.style.left = '-6px';
            rail.style.top = '0px';
            rail.style.bottom = '0px';
            rail.style.width = '1.5px';
            rail.style.borderRadius = '1px';
            rail.style.background = guideColor;
            rail.style.pointerEvents = 'none';
            ghost.append(rail);
        },
        []
    );

    const moveDragGhost = useCallback((drag: DragState): void => {
        const ghost = dragGhostRef.current;
        if (ghost === null) return;
        const x = drag.clientX - drag.grabDX;
        const y = drag.clientY - drag.grabDY;
        ghost.style.transform = `translate3d(${String(Math.round(x))}px, ${String(Math.round(y))}px, 0) scale(1.03)`;
        ghost.dataset['ghostX'] = String(Math.round(x));
        ghost.dataset['ghostY'] = String(Math.round(y));
    }, []);

    const startDragGhost = useCallback(
        (drag: DragState): void => {
            endDragGhost();
            const source = rowElements.current.get(drag.ghostKey);
            const body = globalThis.document?.body;
            if (source === undefined || body === undefined || body === null) return;
            const ghost = source.cloneNode(true) as HTMLElement;
            /*
             * The one thing the photograph must NOT bring with it, taken out before the
             * sanitiser strips the `data-testid` that names it: §WS-007's guide rail, because
             * `styleDragGhost` owns the rail from here on and re-mints it per resolved
             * container rather than inheriting one.
             *
             * (§WS-088's insertion line used to need a second line here for the same reason —
             * it marks a slot in the LIST and would have ridden the cursor as a stray accent
             * rule. The line no longer exists, so neither does the guard.)
             */
            for (const part of ghost.querySelectorAll('[data-testid="group-guide"]')) part.remove();
            sanitizeGhost(ghost);
            ghost.setAttribute('data-testid', 'sidebar-drag-ghost');
            ghost.setAttribute('aria-hidden', 'true');
            ghost.style.position = 'fixed';
            ghost.style.left = '0px';
            ghost.style.top = '0px';
            ghost.style.width = `${String(source.offsetWidth)}px`;
            ghost.style.height = `${String(source.offsetHeight)}px`;
            ghost.style.margin = '0';
            ghost.style.zIndex = '2147483000';
            ghost.style.pointerEvents = 'none';
            ghost.style.animation = 'none';
            ghost.style.transition = 'none';
            // The clone inherits whatever the row's reorder spring had written; the ghost is
            // positioned by `transform` from the raw pointer, so a leftover `translate` would
            // add the row's animation on top of the cursor. The ghost NEVER springs (§WS-084).
            ghost.style.translate = 'none';
            // The row it was lifted off is a `visibility: hidden` gap by the very next commit;
            // the clone must never inherit that, and saying so is cheaper than depending on the
            // commit order.
            ghost.style.visibility = 'visible';
            // §WS-084's lift, whole, because the clone is now the only picture of the item:
            // `WorkspaceListView.swift:1361` puts the dragged row at 0.8.
            ghost.style.opacity = '0.8';
            // The row itself is usually transparent (its fill comes from the list behind it), so
            // an unpainted clone over the pane grid would be a floating column of text.
            ghost.style.background = tokens.sidebarBackground;
            ghost.style.borderRadius = `${String(ROW_CORNER_RADIUS_PX)}px`;
            // The clone's own hairline, and deliberately NOT the row's accent ring: this thing
            // floats over the pane grid with no neighbour to clear, so its 1px border is tucked
            // fully INSIDE the box (offset −1px) where a row's is centred on it (§WS-027).
            ghost.style.outline = `1px solid ${tokens.selectionStroke}`;
            ghost.style.outlineOffset = '-1px';
            ghost.style.boxShadow = '0 12px 32px rgba(0,0,0,0.55)';
            ghost.style.transformOrigin = 'top left';
            /*
             * §N26, deliberately NOT enrolled in `chrome/modal-presence`.
             *
             * This clone can be dragged out over the grid, and over a web pane's page it is
             * invisible like every other DOM surface there. It is left that way on purpose: its
             * box is rewritten from the raw pointer on every mousemove (that is the whole design
             * two comments up), so registering it would attach and detach a real OS-level view
             * dozens of times per gesture — a page flickering in and out for the length of a
             * drag, to keep a decoration visible in the one place the drop can never land, since
             * every drop target for this gesture is inside the sidebar. The surfaces that ARE
             * enrolled are the ones a user reads and clicks: menus, popovers, dialogs, and the
             * drop highlight the pane drag actually aims at (`grid/PaneGrid.tsx`).
             */
            body.appendChild(ghost);
            dragGhostRef.current = ghost;
            /*
             * The clone's own container, tracked from the row it was lifted off.
             *
             * `baseWidth` is the TOP-LEVEL width — a member row is measured `NEST_INDENT_PX`
             * narrower, so the indent is added back here and taken off again per resolved
             * target. `groupID` starts deliberately `undefined` so the seeding call below always
             * runs and the clone opens dressed exactly like the row it replaced (no flicker at
             * the threshold). Groups are top level by construction and never restyle, which is
             * what `nestable` says.
             */
            const nestable = drag.kind === 'workspace';
            const sourceGroupID = nestable ? (source.dataset['groupId'] ?? null) : null;
            ghostChromeRef.current = {
                nestable,
                baseWidth: source.offsetWidth + (source.dataset['depth'] === '1' ? NEST_INDENT_PX : 0),
                groupID: undefined
            };
            styleDragGhost(sourceGroupID, guideColorFor(sourceGroupID));
            moveDragGhost(drag);
        },
        [endDragGhost, guideColorFor, moveDragGhost, styleDragGhost]
    );

    /**
     * The drop settle, in two halves because the ghost dies before the drop is decided.
     *
     * `measureDropSettle` runs while the ghost is still on screen and answers "how far above or
     * below its slot did the user let go?"; `applyDropSettle` turns that into the row's spring
     * offset. The row's own live offset is taken back out of both, so the seed is measured
     * against where the row is SETTLING rather than where it happens to be drawn this frame.
     *
     * This seam is the whole of the drop now. There used to be a scripted 400 ms fall on top of
     * it for one case (§WS-092), and running both is what the user saw as a double animation.
     */
    const measureDropSettle = useCallback((drag: DragState | null): DropSettleSeed | null => {
        if (drag === null || !drag.active || prefersReducedMotion()) return null;
        const ghost = dragGhostRef.current;
        const element = rowElements.current.get(drag.ghostKey);
        if (ghost === null || element === undefined) return null;
        const ghostTop = ghost.getBoundingClientRect().top;
        const rowTop = element.getBoundingClientRect().top;
        if (!Number.isFinite(ghostTop) || !Number.isFinite(rowTop)) return null;
        const settledTop = rowTop - (rowOffsets.current.get(drag.ghostKey)?.y ?? 0);
        const offset = ghostTop - settledTop;
        // A release within a pixel of the slot has nothing to settle, and seeding it would only
        // put a channel on screen for one frame.
        if (Math.abs(offset) < 1) return null;
        return { key: drag.ghostKey, offset };
    }, []);

    const applyDropSettle = useCallback(
        (seed: DropSettleSeed | null): void => {
            if (seed === null) return;
            const current = rowOffsets.current.get(seed.key)?.y ?? 0;
            displaceRow(seed.key, 'y', seed.offset - current);
        },
        [displaceRow]
    );

    useEffect(() => {
        if (dragID === null) return;

        const cancelSpring = (drag: DragState): void => {
            if (drag.springTimer !== null) clearTimeout(drag.springTimer);
            drag.springTimer = null;
            drag.springCandidate = null;
        };

        /**
         * The group the cursor is currently over, whether it is hovering the header or the band
         * where its children would be — that second case is what makes a spring-load feel like
         * "I am trying to get in here" rather than "I touched a header".
         */
        const groupUnder = (target: DropTarget | null): string | null => {
            if (target === null) return null;
            if (target.kind === 'ontoGroupHeader') return target.groupID;
            if (target.kind === 'intoGroup') return target.groupID;
            return null;
        };

        const updateSpring = (drag: DragState, target: DropTarget | null): void => {
            const groupID = groupUnder(target);
            if (groupID === null) {
                // Left the group: cancel the dwell AND collapse it again (§5.5).
                cancelSpring(drag);
                setSpringLoadedGroupID((current) => (current === null ? current : null));
                return;
            }
            if (drag.springCandidate === groupID) return;
            cancelSpring(drag);
            const group = groupsRef.current.find((candidate) => candidate.id === groupID);
            // Only a COLLAPSED group springs; an expanded one is already open.
            if (group === undefined || !isGroupCollapsed(group, { overrides: collapseRef.current.overrides })) {
                setSpringLoadedGroupID((current) => (current === groupID ? current : null));
                return;
            }
            drag.springCandidate = groupID;
            drag.springTimer = setTimeout(() => {
                drag.springTimer = null;
                if (dragRef.current !== drag || drag.springCandidate !== groupID) return;
                // L15: the reveal this flip is about to cause runs on the Swift's 100ms ease
                // (`WorkspaceListView.swift:1989-1991`), not the ordinary entry spring. The
                // layout effect that spots the new rows reads and clears the flag.
                springLoadEnterRef.current = true;
                setSpringLoadedGroupID(groupID);
            }, springLoadMs);
        };

        /**
         * Publish what the drag loop just decided onto the scroller as `data-drag-*`.
         *
         * A drag that resolves to nothing looks exactly like a drag that never started — that
         * ambiguity is what kept defect N4b open through a whole burn-down, with the harness
         * able to say only "the header did not tint". These three attributes separate the two
         * cases without a debugger: `data-drag-active` says the gesture passed the 5px
         * threshold and §WS-093's measure gate, `data-drag-y` is the content-space cursor the
         * zones were walked with, and `data-drag-target` is the zone it landed in (`none` when
         * the walk found no band at all).
         */
        const diagnose = (drag: DragState, target: string | null): void => {
            const list = listRef.current;
            if (list === null) return;
            list.dataset['dragActive'] = drag.active ? 'true' : 'false';
            list.dataset['dragY'] = String(Math.round(contentY(drag.clientY)));
            list.dataset['dragTarget'] = target ?? 'none';
        };

        /** Resolve the cursor against the current geometry and apply/preview the result. */
        const resolve = (drag: DragState): void => {
            const current = shadowRef.current ?? drag.originModel;
            const y = contentY(drag.clientY);
            const heights = measuredHeights();
            const offsets = measuredOffsets();
            if (drag.kind === 'group') {
                const spans = buildGroupSpans(current, rowsRef.current, {
                    heights,
                    offsets,
                    rowHeight,
                    contentTop: CONTENT_TOP_PADDING
                });
                const index = resolveGroupDropIndex(spans, y, drag.id);
                diagnose(drag, index === null ? null : `group:${String(index)}`);
                if (index === null) return;
                setShadow(applyGroupDrop(current, drag.id, index));
                return;
            }
            const layout = buildDropZones(current, rowsRef.current, {
                heights,
                offsets,
                rowHeight,
                contentTop: CONTENT_TOP_PADDING,
                // Every dragged row is omitted as a target and excluded from the post-remove
                // indices, so a multi-drag's arithmetic already describes the bulk landing.
                dragging: new Set(drag.ids)
            });
            const target = resolveDropTarget(layout, y);
            diagnose(drag, target === null ? null : describeTarget(target));
            updateSpring(drag, target);
            /*
             * The clone follows the CONTAINER as well as the cursor.
             *
             * All three targets name one: `topLevel` is "out of every group", and both
             * `intoGroup` and `ontoGroupHeader` name the group the row is going into — including
             * a group that is not the one it came from. `null` (the walk found no band) is not a
             * container change and leaves the clone as it is. Done before the early return
             * below, so a preview-only header target — the case that never touches the shadow,
             * and therefore the one where the in-flow row's own depth spring cannot speak for
             * the clone — restyles like every other.
             */
            const destination = target === null ? undefined : target.kind === 'topLevel' ? null : target.groupID;
            styleDragGhost(destination, destination == null ? undefined : guideColorFor(destination));
            if (target === null) return;
            if (target.kind === 'ontoGroupHeader') {
                // Preview-only: the cursor transits headers constantly (§5.5), so the order
                // is NOT live-applied — the header is tinted and the move waits for release.
                drag.preview = target;
                setPreviewGroupID(target.groupID);
                return;
            }
            drag.preview = null;
            setPreviewGroupID(null);
            setShadow(applyWorkspaceDrop(current, drag.id, target));
        };

        /**
         * §5.5 auto-scroll. The OS emits no mousemove while the pointer is stationary, so each
         * tick re-derives the content-space cursor from the STORED client position and re-runs
         * the whole resolution — otherwise the list would scroll under a frozen drop target.
         */
        let autoScrollTimer: ReturnType<typeof setInterval> | null = null;
        const stopAutoScroll = (): void => {
            if (autoScrollTimer === null) return;
            clearInterval(autoScrollTimer);
            autoScrollTimer = null;
        };
        const autoScrollDelta = (clientY: number): number => {
            const list = listRef.current;
            if (list === null) return 0;
            const rect = list.getBoundingClientRect();
            if (rect.height <= 0) return 0;
            if (clientY < rect.top + AUTO_SCROLL_EDGE_PX) return -AUTO_SCROLL_STEP_PX;
            if (clientY > rect.bottom - AUTO_SCROLL_EDGE_PX) return AUTO_SCROLL_STEP_PX;
            return 0;
        };
        const syncAutoScroll = (drag: DragState): void => {
            const delta = autoScrollDelta(drag.clientY);
            if (delta === 0) {
                stopAutoScroll();
                return;
            }
            if (autoScrollTimer !== null) return;
            autoScrollTimer = setInterval(() => {
                const live = dragRef.current;
                const list = listRef.current;
                if (live === null || list === null) {
                    stopAutoScroll();
                    return;
                }
                const step = autoScrollDelta(live.clientY);
                if (step === 0) {
                    stopAutoScroll();
                    return;
                }
                const before = list.scrollTop;
                list.scrollTop = before + step;
                if (list.scrollTop === before) {
                    // Hit an end: nothing more to scroll, so stop burning a timer on it.
                    stopAutoScroll();
                    return;
                }
                resolve(live);
            }, autoScrollIntervalMs);
        };

        const onMove = (event: MouseEvent): void => {
            const drag = dragRef.current;
            if (drag === null) return;
            drag.clientY = event.clientY;
            drag.clientX = event.clientX;
            if (!drag.active) {
                if (Math.abs(event.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
                // §WS-093: ignore the gesture entirely until the geometry it would be resolved
                // against is real. The mousedown is kept, so the drag begins the moment the
                // measurement lands rather than needing a fresh press.
                if (!geometryReady()) return;
                drag.active = true;
                setDragActive(true);
                // A selection the user made SOMEWHERE ELSE would otherwise extend through the
                // sidebar as the pointer travels — `user-select: none` stops one starting here,
                // not one growing into here. Dropped at the threshold, not at the `mousedown`,
                // so a press that never becomes a drag leaves it alone.
                clearDocumentSelection();
                // §WS-084: the ghost is minted only once the gesture IS a drag — a press that
                // never moves must leave no floating row behind it.
                startDragGhost(drag);
            }
            moveDragGhost(drag);
            syncAutoScroll(drag);
            resolve(drag);
        };

        const onUp = (): void => {
            const drag = dragRef.current;
            dragRef.current = null;
            stopAutoScroll();
            /*
             * §WS-008's drop settle, and the Swift's `withAnimation(.spring(…)) { dragCurrentY = 0 }`
             * (`WorkspaceListView.swift:1538`).
             *
             * There the grabbed row IS the thing under the cursor, so releasing simply springs
             * its own offset back to zero. Here the cursor carries a clone and the real row
             * never left the flow, so the same motion has to be handed over: measure the gap
             * between where the ghost died and where the row is, seed that as the row's spring
             * offset, and let it spring home. Without this the ghost vanishes at the pointer and
             * the row is simply already there — the one moment in the whole gesture where
             * nothing moves.
             *
             * Taken BEFORE `endDragGhost()`, for the obvious reason. It is the ONLY drop
             * animation now: the §WS-092 script that used to run on top of it for one case is
             * gone, and with it the double motion the user reported.
             */
            const settleSeed = measureDropSettle(drag);
            /*
             * THE HANDOVER, and why it cannot show two copies or none.
             *
             * The clone is removed here and the gap is un-gapped by the `setDragID(null)` /
             * `setDragActive(false)` immediately below — one synchronous handler, so the browser
             * cannot paint between them, and React 18 flushes the pair in a microtask before the
             * next frame. The painted sequence is therefore exactly `gap + clone` → `row`, with
             * no frame carrying both pictures and none carrying neither.
             */
            endDragGhost();
            const list = listRef.current;
            if (list !== null) list.dataset['dragActive'] = 'false';
            if (drag !== null) cancelSpring(drag);
            setDragID(null);
            setDragActive(false);
            setPreviewGroupID(null);
            // §5.5: the spring-loaded group stays open through the drop, then collapses.
            setSpringLoadedGroupID(null);
            if (drag === null || !drag.active) return;
            suppressNextClick();

            /*
             * §WS-092's landing is DELIBERATELY not here, and the reason belongs in the code
             * rather than only in a note.
             *
             * The Swift plays it — a row released onto a collapsed header is pinned, shrunk to
             * `scale(0.2)` at 0.15 opacity and committed ~400 ms later
             * (`WorkspaceListView.swift:1509-1537`) — but the predicate that reaches it ends in
             * `!store.settings.expandGroupOnWorkspaceDrop`, and that setting SHIPS TRUE
             * (`SettingsFeature.swift:41`). On a default install the shipped app therefore takes
             * the ordinary branch at `:1539`, which is one `withAnimation(.spring)` bringing the
             * row's own offset home — precisely the settle seeded above. The port had the
             * landing unconditionally, so it played a second, scripted animation on top of the
             * settle in a case where the app plays none; that is the double motion the user
             * asked to remove, and removing it moves the DEFAULT configuration onto parity.
             *
             * What is knowingly given up is the same app with `expand-group-on-workspace-drop =
             * false`, where the Swift does play the fall. That is a divergence, and it is named
             * here so the next reader does not have to re-derive it from two files.
             */
            const commitDrop = (): void => {
                let final = shadowRef.current ?? drag.originModel;
                if (drag.preview !== null) final = applyWorkspaceDrop(final, drag.id, drag.preview);
                if (final !== shadowRef.current) setShadow(final);

                if (drag.kind === 'group') {
                    const index = groupCommit(drag.originModel, final, drag.id);
                    if (index !== null) props.onMoveGroup?.({ groupID: drag.id, index });
                    return;
                }
                const commit = workspaceCommit(drag.originModel, final, drag.id);
                if (commit === null) return;
                if (drag.ids.length > 1 && props.onMoveWorkspaces !== undefined) {
                    // The grabbed row's landing spot IS the selection's landing spot: the zones
                    // it was resolved against already had every dragged row detached.
                    props.onMoveWorkspaces({
                        workspaceIDs: drag.ids,
                        groupID: commit.groupID,
                        index: commit.index
                    });
                    return;
                }
                props.onMoveWorkspace?.({
                    workspaceID: drag.id,
                    groupID: commit.groupID,
                    index: commit.index
                });
            };

            // The released row springs home from where the ghost left it — seeded BEFORE the
            // commit, so the layout delta the commit produces is added on top of the seed by the
            // FLIP pass rather than replacing it.
            applyDropSettle(settleSeed);
            commitDrop();
        };

        const target = globalThis.window;
        target.addEventListener('mousemove', onMove);
        target.addEventListener('mouseup', onUp);
        return () => {
            target.removeEventListener('mousemove', onMove);
            target.removeEventListener('mouseup', onUp);
            stopAutoScroll();
            /*
             * A RE-RUN is not the end of the gesture, and this cleanup used to treat it as one.
             *
             * `props` is in this effect's dependency list, and React hands down a fresh props
             * object on every parent render — including the 1-second agent-status tick (§15). So
             * every second of a live drag tore down §WS-084's ghost and cancelled §5.5's 650 ms
             * spring-load dwell, while the drag itself carried on in `dragRef`: a drag longer
             * than a second lost the row that was following the cursor, and a group held for
             * 650 ms across a tick never opened. Found by `sidebar-spring`, whose drop settle is
             * measured from where the ghost died and came back zero for exactly this reason.
             *
             * The gesture's own state lives in `dragRef` and outlives the closure, so the fix is
             * to tear those two down only when there IS no gesture. `onUp` ends the ghost itself,
             * and the unmount case is handled by its own effect below — the one place where
             * "this component is going away" is actually true.
             */
            const drag = dragRef.current;
            if (drag !== null) return;
            endDragGhost();
        };
    }, [
        applyDropSettle,
        autoScrollIntervalMs,
        contentY,
        dragID,
        endDragGhost,
        geometryReady,
        guideColorFor,
        measureDropSettle,
        measuredHeights,
        measuredOffsets,
        moveDragGhost,
        props,
        rowHeight,
        springLoadMs,
        startDragGhost,
        styleDragGhost,
        suppressNextClick
    ]);

    /**
     * §WS-084's ghost lives on `document.body`, so it is the one thing here that React will not
     * collect for us. This runs on UNMOUNT only (`endDragGhost` is stable), which is the single
     * moment "the sidebar is going away" is true — the drag effect above deliberately no longer
     * treats its own re-runs as that moment.
     */
    useEffect(
        () => () => {
            endDragGhost();
        },
        [endDragGhost]
    );

    // ── §WS-008: insert and reorder animations ──────────────────────────────────
    //
    // Keyed on the RENDERED entry list, as the Swift's `.animation(...,​ value:)` is: a row
    // that appears plays the entry keyframes once, and a row that merely changed place is
    // FLIPped — measured before and after, offset back to where it was, then sprung to where it
    // now is. A live drag runs the pass too: it is the whole point of the spring wave, and the
    // gap slot springs between resolved positions exactly as its neighbours do.
    //
    // The baseline is `offsetTop`, not `getBoundingClientRect().top`: a FLIP applies a
    // `translateY` that DOES move the client rect, so measuring the next commit against a rect
    // would read the animation's own offset back as a layout change and re-FLIP forever.
    // `offsetTop` is transform-free by definition. jsdom reports 0 for all of them, which is
    // exactly the right degradation — no layout, no movement to animate.
    /**
     * §WS-008's removal animation, in the one place it can live without lying to the drag.
     *
     * Each dead row is cloned, sanitised (`sanitizeGhost` — a ghost answers to no selector),
     * pinned at the box it occupied and collapsed to nothing on the spring curve. The layer it
     * goes into is `position: absolute` inside the scroller, so:
     *
     *   - it is OUT OF FLOW — no live row's `offsetTop` moves because a ghost is fading, which
     *     is what would have poisoned §WS-093's measure gate had the row itself been held alive;
     *   - it is never handed to `registerRow`, so `measuredHeights()` / `measuredOffsets()` /
     *     `geometryReady()` cannot see it even by accident;
     *   - it is `pointer-events: none`, so it cannot swallow the click that follows a delete.
     *
     * Reduced motion removes the ghost entirely rather than fading it more slowly: the row is
     * already gone from the model, and the ghost's only job is to explain the change.
     */
    const spawnRemovalGhosts = useCallback(
        (dead: readonly { key: string; node: HTMLElement | undefined; box: RowBox | undefined }[]): void => {
            const layer = ghostLayerRef.current;
            if (layer === null || prefersReducedMotion()) return;
            for (const { node, box } of dead) {
                if (node === undefined || box === undefined) continue;
                const ghost = node.cloneNode(true) as HTMLElement;
                sanitizeGhost(ghost);
                ghost.setAttribute('data-testid', 'sidebar-row-ghost');
                ghost.setAttribute('aria-hidden', 'true');
                ghost.style.position = 'absolute';
                ghost.style.top = `${String(box.top)}px`;
                ghost.style.left = `${String(box.left)}px`;
                ghost.style.width = `${String(box.width)}px`;
                ghost.style.height = `${String(box.height)}px`;
                ghost.style.margin = '0';
                ghost.style.overflow = 'hidden';
                ghost.style.pointerEvents = 'none';
                ghost.style.animation = 'none';
                // Pinned at the box the row occupied, which came from `offsetTop` — a
                // transform-free number — so an inherited spring `translate` would move the
                // ghost off it. (The removal ghost is a one-shot that is never retargeted, so it
                // stays on its transition; the spring's job is the interruptible motion.)
                ghost.style.translate = 'none';
                ghost.style.transformOrigin = 'top center';
                ghost.style.opacity = '1';
                ghost.style.transition =
                    `opacity ${String(ROW_EXIT_MS)}ms ease, ` +
                    `height ${String(ROW_EXIT_MS)}ms ${SPRING_EASING}, ` +
                    `transform ${String(ROW_EXIT_MS)}ms ${SPRING_EASING}`;
                layer.appendChild(ghost);
                const collapse = (): void => {
                    ghost.style.opacity = '0';
                    ghost.style.height = '0px';
                    ghost.style.transform = 'scale(0.96)';
                };
                // One frame at the starting box, so the transition has something to run FROM.
                const frame = globalThis.requestAnimationFrame;
                if (typeof frame === 'function') frame(collapse);
                else collapse();
                setTimeout(() => {
                    ghost.remove();
                }, ROW_EXIT_MS + 80);
            }
        },
        []
    );

    const previousLayoutRef = useRef<{
        keys: ReadonlySet<string>;
        tops: ReadonlyMap<string, number>;
        lefts: ReadonlyMap<string, number>;
    } | null>(null);
    const [entering, setEntering] = useState<ReadonlySet<string>>(EMPTY_SELECTION);
    /** L15: the current entry batch came from a spring-load, so it plays the 100ms ease. */
    const [enteringFast, setEnteringFast] = useState(false);
    const enterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useLayoutEffect(() => {
        // Everything React detached during THIS commit, taken once and dropped: a pending clone
        // that no longer corresponds to a removed row (the filter swapping the whole list out,
        // say) is a picture of nothing and must not survive to the next change.
        const dying = new Map(dyingRows.current);
        dyingRows.current.clear();

        const tops = new Map<string, number>();
        const lefts = new Map<string, number>();
        const boxes = new Map<string, RowBox>();
        for (const row of rows) {
            const element = rowElements.current.get(row.key);
            if (element === undefined) continue;
            tops.set(row.key, element.offsetTop);
            lefts.set(row.key, element.offsetLeft);
            boxes.set(row.key, {
                top: element.offsetTop,
                left: element.offsetLeft,
                width: element.offsetWidth,
                height: element.offsetHeight
            });
        }
        const previous = previousLayoutRef.current;
        const previousBoxes = rowBoxes.current;
        previousLayoutRef.current = { keys: new Set(rows.map((row) => row.key)), tops, lefts };
        rowBoxes.current = boxes;

        // First commit: everything is "new", and a sidebar that animates its whole contents in
        // on mount is a worse sidebar than one that is simply there.
        if (previous === null) return;
        /*
         * Nothing is excluded from the pass any more.
         *
         * It used to bail out for a live DRAG, which is why the rows a cursor crossed snapped
         * into their new places with no motion at all while every other reorder in the app
         * animated — fixed in the spring wave. It then bailed out for §WS-092's scripted landing,
         * on the reasoning that springing a row's slot underneath a 400 ms fall would fight it.
         * That fall is gone (see `onUp`), so the exclusion has nothing left to protect and the
         * drop is the settle seam and the FLIP, in that order, with nothing scripted on top.
         *
         * The drag geometry is safe from what happens below because `measuredOffsets()`
         * subtracts these offsets back out (§WS-093).
         */

        // §WS-008's removals. The rows below have already been FLIPped up by the pass below;
        // this is the dead row itself, collapsing where it stood.
        const live = new Set(rows.map((row) => row.key));
        const gone = [...previous.keys].filter((key) => !live.has(key));
        if (gone.length > 0 && live.size > 0) {
            spawnRemovalGhosts(
                gone.map((key) => ({ key, node: dying.get(key), box: previousBoxes.get(key) }))
            );
        }
        // A key that has left the list keeps no channel: the callback would write into a node
        // nothing can see, and the offset would be re-applied if the key ever came back.
        for (const key of gone) forgetRowSprings(key);

        /*
         * L15: read-and-clear, unconditionally, so a spring-load that revealed nothing (a group
         * whose children were already rendered) cannot leave the flag armed for the next
         * insertion — an ordinary create would then flash past at 100ms.
         */
        const fast = springLoadEnterRef.current;
        springLoadEnterRef.current = false;
        const fresh = rows.map((row) => row.key).filter((key) => !previous.keys.has(key));
        if (fresh.length > 0) {
            setEntering(new Set(fresh));
            setEnteringFast(fast);
            if (enterTimerRef.current !== null) clearTimeout(enterTimerRef.current);
            enterTimerRef.current = setTimeout(
                () => {
                    enterTimerRef.current = null;
                    setEntering(EMPTY_SELECTION);
                },
                (fast ? SPRING_LOAD_ENTER_MS : REORDER_MS) + 60
            );
        }

        /*
         * §WS-008's FLIP, on both axes, handed to the spring.
         *
         * The baseline is `offsetTop` / `offsetLeft`, not `getBoundingClientRect()`: the spring's
         * output is a `translate`, which DOES move a client rect, so measuring against one would
         * read the animation's own frame back as a layout change and re-FLIP forever. The offset
         * pair is transform-free by definition, which is what makes the loop closed.
         *
         * `displace` is a RETARGET, not a restart. A row that is crossed again before its last
         * displacement has unwound keeps both its current offset and its current velocity, and
         * the new delta is added on top — so a drag over three rows in 200 ms is one motion. That
         * is the whole difference from the transition this replaces, and the reason the `x` axis
         * (§WS-089's nest indent) rides here too instead of on a `margin-left` transition.
         *
         * jsdom reports 0 for every offset, which is exactly the right degradation: no layout, no
         * deltas, no springs, and the spring driver would fall back to instant anyway.
         */
        for (const row of rows) {
            const beforeTop = previous.tops.get(row.key);
            const afterTop = tops.get(row.key);
            if (beforeTop !== undefined && afterTop !== undefined) {
                const delta = beforeTop - afterTop;
                if (Math.abs(delta) >= 1) displaceRow(row.key, 'y', delta);
            }
            const beforeLeft = previous.lefts.get(row.key);
            const afterLeft = lefts.get(row.key);
            if (beforeLeft !== undefined && afterLeft !== undefined) {
                const delta = beforeLeft - afterLeft;
                if (Math.abs(delta) >= 1) displaceRow(row.key, 'x', delta);
            }
        }
    }, [displaceRow, forgetRowSprings, rows, spawnRemovalGhosts]);

    useEffect(
        () => () => {
            if (enterTimerRef.current !== null) clearTimeout(enterTimerRef.current);
        },
        []
    );

    /**
     * §15: scroll the entry THIS client just created — or just activated — into view, once.
     *
     * §WS-101's resolution, verbatim: a workspace with a visible row is scrolled to directly;
     * one hidden inside a COLLAPSED group resolves to that group's header instead (the
     * `workspace-create --group` path can land a workspace in a collapsed group); and a target
     * this client cannot see AT ALL is DROPPED rather than retried on every `rows` change. A
     * row that simply has not rendered yet keeps the target pending — that is the one case
     * worth waiting for, and it resolves on the next commit.
     *
     * §WS-020: while the FILTER is active the request is consumed and DROPPED. The filtered
     * body is a different list of rows registered under the same `ws:<id>` keys, so without
     * this the queued target yanks the filtered view instead — and the row it wanted is not the
     * row it would reach.
     *
     * §WS-102: with a real box model the reveal WAITS for the row to measure, then moves the
     * minimum amount over `REVEAL_MS` (`chrome/sidebar-scroll.ts`). Without one — jsdom, or a
     * sidebar that has never laid out — there is nothing to measure and nothing to animate, so
     * it falls back to `scrollIntoView({ block: 'nearest' })`, which is the same *decision*
     * taken by the platform.
     */
    const scrollTarget = props.scrollToWorkspaceID ?? null;
    const scrollGroupTarget = props.scrollToGroupID ?? null;
    const onScrollHandled = props.onScrollHandled;
    const filterActive = props.filter.trim().length > 0;
    const revealMs = props.revealMs ?? REVEAL_MS;
    /** Bumped by a measure retry, so the effect re-runs without `rows` having changed. */
    const [revealTick, setRevealTick] = useState(0);
    const revealAttemptsRef = useRef<{ target: string; attempts: number }>({ target: '', attempts: 0 });
    const cancelRevealRef = useRef<(() => void) | null>(null);
    useEffect(() => {
        const target = scrollGroupTarget ?? scrollTarget;
        if (target === null) return undefined;
        if (filterActive) {
            onScrollHandled?.();
            return undefined;
        }
        // A group target resolves to its header; a workspace target to its own row, or to the
        // header of the collapsed group hiding it (§WS-101).
        let key: string | null;
        if (scrollGroupTarget !== null) {
            key = groups.some((group) => group.id === scrollGroupTarget) ? `header:${scrollGroupTarget}` : null;
        } else {
            const located = scrollTarget === null ? null : locateWorkspace(baseModel, scrollTarget);
            key =
                located === null
                    ? null
                    : rowElements.current.has(`ws:${String(scrollTarget)}`) || located.groupID === null
                      ? `ws:${String(scrollTarget)}`
                      : `header:${located.groupID}`;
        }
        if (key === null) {
            onScrollHandled?.();
            return undefined;
        }
        const element = rowElements.current.get(key);
        if (element === undefined) return undefined;

        const list = listRef.current;
        const hasLayout = list !== null && list.getBoundingClientRect().height > 0;
        const handOff = (): void => {
            element.scrollIntoView?.({ block: 'nearest' });
            onScrollHandled?.();
        };
        if (!hasLayout) {
            handOff();
            return undefined;
        }
        // §WS-102's wait: a row that exists but has not measured yet would be scrolled to at
        // its unmeasured height, which is the Swift's "retry from the height preference
        // change" case. Re-check on the next frame instead, bounded.
        if (element.getBoundingClientRect().height <= 0) {
            const seen = revealAttemptsRef.current;
            const attempts = seen.target === target ? seen.attempts + 1 : 1;
            revealAttemptsRef.current = { target, attempts };
            const frame = globalThis.requestAnimationFrame;
            if (attempts <= REVEAL_MEASURE_ATTEMPTS && typeof frame === 'function') {
                const id = frame(() => {
                    setRevealTick((tick) => tick + 1);
                });
                return () => {
                    globalThis.cancelAnimationFrame?.(id);
                };
            }
            // Waited as long as this is worth waiting: reveal it anyway rather than leaving a
            // one-shot pending forever.
            handOff();
            return undefined;
        }
        revealAttemptsRef.current = { target: '', attempts: 0 };
        /**
         * §N34: the destination is re-measured, and the ORIGIN is not.
         *
         * `revealScrollTop` decides two things at once — which way to move (a row above the
         * fold scrolls up, one below scrolls down) and how far. The direction has to be decided
         * from where the list was when the reveal was asked for, or a mid-flight re-measure
         * would keep re-deciding it against a `scrollTop` this animation is itself moving. So
         * the origin is frozen here and everything else is read live: the row's own `offsetTop`
         * and `offsetHeight`, and the viewport's height.
         *
         * What that buys is the row actually being revealed. Measured on this list
         * (`docs/audit/n34-n35-reveal-focus/`): the reveal is computed against a 36 px group
         * header and the inline rename field mounts a commit later at 38, so the one-shot
         * landed 2 px short with the header's foot past the fold — and nothing ever looked
         * again, because a row that moves after a reveal is not a focus change and nothing
         * re-arms it. Re-aiming makes the promise hold at the END of the reveal rather than at
         * the instant it was measured, whatever moved in between.
         */
        const origin = list.scrollTop;
        const aim = (): number | null =>
            revealScrollTop({
                scrollTop: origin,
                viewportHeight: list.clientHeight,
                rowTop: element.offsetTop,
                rowHeight: element.offsetHeight,
                topInset: CONTENT_TOP_PADDING
            });
        const to = aim();
        if (to !== null) {
            cancelRevealRef.current?.();
            const stopAnimation = animateScrollTop(list, to, {
                durationMs: revealMs,
                retarget: aim,
                settleMs: REVEAL_SETTLE_MS
            });
            /*
             * The settle window is short, but it is still a window in which this code writes
             * `scrollTop` — so a person who reaches for the list inside it wins outright. The
             * gestures listened for are the ones that BEGIN a manual scroll (a wheel, a
             * pointer going down on the scroller); the `scroll` event cannot be used, because
             * the animation's own writes raise it.
             */
            let stopped = false;
            let expiry: ReturnType<typeof setTimeout> | undefined;
            const stop = (): void => {
                if (stopped) return;
                stopped = true;
                stopAnimation();
                list.removeEventListener('wheel', stop);
                list.removeEventListener('pointerdown', stop);
                if (expiry !== undefined) clearTimeout(expiry);
            };
            list.addEventListener('wheel', stop, { passive: true });
            list.addEventListener('pointerdown', stop);
            expiry = setTimeout(stop, revealMs + REVEAL_SETTLE_MS + 50);
            cancelRevealRef.current = stop;
        }
        onScrollHandled?.();
        return undefined;
    }, [
        baseModel,
        filterActive,
        groups,
        onScrollHandled,
        revealMs,
        revealTick,
        rows,
        scrollGroupTarget,
        scrollTarget
    ]);

    // A reveal still animating when the sidebar goes away must not keep writing `scrollTop`.
    useEffect(
        () => () => {
            cancelRevealRef.current?.();
            cancelRevealRef.current = null;
        },
        []
    );

    /**
     * §SET-153 / §SET-144's one-shot "start renaming this row", same shape as the scroll target
     * above: consumed once, then cleared through `onRenameRequestHandled`. A target that does
     * not exist here is dropped (cleared without opening a field) rather than retried.
     */
    const renameRequest = props.renameRequest ?? null;
    const onRenameRequestHandled = props.onRenameRequestHandled;
    useEffect(() => {
        if (renameRequest === null) return;
        const exists =
            renameRequest.kind === 'workspace'
                ? locateWorkspace(baseModel, renameRequest.id) !== null
                : groups.some((group) => group.id === renameRequest.id);
        if (exists) setRename({ kind: renameRequest.kind, id: renameRequest.id });
        onRenameRequestHandled?.();
    }, [baseModel, groups, renameRequest, onRenameRequestHandled]);

    /**
     * §APP-018's other half: "open the New Workspace form", asked for from outside.
     *
     * The same one-shot contract as the rename above — consumed once, cleared immediately — so
     * ⌘N pressed twice re-opens the sheet the second time rather than being swallowed as a
     * no-change prop, and a re-render after the user cancels cannot bring it back. The sheet's
     * own autofocus does the rest: `NewEntrySheet` focuses its name field on mount, so the
     * gesture lands the caret exactly where the shipped sheet does.
     */
    const createRequest = props.createRequest ?? null;
    const onCreateRequestHandled = props.onCreateRequestHandled;
    useEffect(() => {
        if (createRequest === null) return;
        setNewForm({ kind: createRequest.kind, groupID: createRequest.groupID ?? null });
        onCreateRequestHandled?.();
    }, [createRequest, onCreateRequestHandled]);

    /**
     * …and the sheet's open state, published upward: a modal is a whole-window fact (see
     * `onCreateSheetOpenChange`). The cleanup matters as much as the call — a sidebar unmounted
     * with the sheet up (the panel sliding away under it) must not leave assembly believing a
     * modal is still on screen.
     */
    const createSheetOpen = newForm !== null;
    const onCreateSheetOpenChange = props.onCreateSheetOpenChange;
    useEffect(() => {
        if (onCreateSheetOpenChange === undefined) return;
        onCreateSheetOpenChange(createSheetOpen);
        return () => {
            if (createSheetOpen) onCreateSheetOpenChange(false);
        };
    }, [createSheetOpen, onCreateSheetOpenChange]);

    // ── menus ───────────────────────────────────────────────────────────────────
    const closeMenu = useCallback((): void => {
        setMenu(null);
    }, []);

    /*
     * L12: no `shortcut` helper, because no menu row carries a hint any more. Every sidebar
     * menu in the shipped app is a plain `Button` inside a `.contextMenu`
     * (`WorkspaceListView.swift:897`, `:1183`, `:344-350`) with no `.keyboardShortcut`, so
     * `NSMenu` draws no key-equivalent column. `keyBindings` went with the helper — it reached
     * the sidebar for this and nothing else.
     */

    /**
     * §5.6's "Change Icon ▸" submenu, shared by the workspace and group menus (they differ only
     * in which callback the choice lands on). Tokens pass through verbatim, so this client never
     * has to be able to DRAW a symbol in order to set one.
     *
     * The doc nests a further level ("Symbol ▸", "Emoji ▸"); `ContextMenu` is deliberately one
     * level deep (§5.6/§5.7 are the only menus and nothing else needs two), so the two groups
     * become caption-separated sections of one list instead — same choices, one fewer hover.
     */
    const iconSubmenu = useCallback(
        (kind: 'workspace' | 'group', id: string, current: IconRef | null): MenuItemSpec[] => {
            const apply = (icon: string | null): void => {
                if (kind === 'workspace') props.onSetWorkspaceIcon?.(id, icon);
                else props.onSetGroupIcon?.(id, icon);
            };
            return [
                { id: 'icon:symbols', label: 'Symbol', kind: 'caption' },
                ...CURATED_SYMBOL_ICONS.map(
                    (choice): MenuItemSpec => ({
                        id: `icon:symbol:${choice.name}`,
                        label: `${iconGlyph({ kind: 'system', name: choice.name }) ?? ''}  ${choice.label}`,
                        checked: current?.kind === 'system' && current.name === choice.name,
                        onSelect: () => apply(`system:${choice.name}`)
                    })
                ),
                { id: 'icon:emojis', label: 'Emoji', kind: 'caption' },
                ...CURATED_EMOJI.map(
                    (grapheme): MenuItemSpec => ({
                        id: `icon:emoji:${grapheme}`,
                        label: grapheme,
                        checked: current?.kind === 'emoji' && current.grapheme === grapheme,
                        onSelect: () => apply(`emoji:${grapheme}`)
                    })
                ),
                { id: 'icon:sep', label: '', kind: 'separator' },
                {
                    id: 'icon:custom',
                    label: 'Custom Emoji…',
                    onSelect: () => {
                        setEmojiSheet({ kind, id });
                    }
                },
                {
                    id: 'icon:reset',
                    // §WS-066: a workspace resets to its LETTER avatar; a group has no letter
                    // — its default is the folder glyph, so the item has to say so.
                    label: kind === 'group' ? 'Reset to Folder' : 'Reset to Letter',
                    disabled: current === null,
                    onSelect: () => apply(null)
                }
            ];
        },
        [props]
    );

    /**
     * Selected workspaces in SIDEBAR order, with any selected member the sidebar cannot show
     * (a collapsed group's child) appended. §WS-057: the bulk menu's counts must cover the whole
     * live selection, not just the rows on screen, or the tri-state would lie the moment a group
     * is collapsed.
     */
    const orderedSelection = useCallback((): string[] => {
        const visible = visibleOrder.filter((id) => selection.has(id));
        const hidden = [...selection]
            .filter((id) => !visible.includes(id) && workspaceByID.has(id))
            .sort();
        return [...visible, ...hidden];
    }, [selection, visibleOrder, workspaceByID]);

    /**
     * §5.6's bulk menu variant (§WS-055…§WS-060): right-clicking a row that is part of a ≥2
     * selection swaps the whole menu, headed by an inert "N workspaces selected" caption. Every
     * action here goes out as ONE command for the whole selection.
     */
    const bulkMenuItems = useCallback((): MenuItemSpec[] => {
        const ids = orderedSelection();
        const count = ids.length;
        const total = workspaceByID.size;
        const inAnyGroup = ids.some((id) => groupIDForWorkspace(id) !== null);

        // §WS-057's tri-state: a preset applied to every selected workspace shows a checkmark
        // and clicking REMOVES it; applied to some shows the dash; clicking anything not
        // universally applied applies it to all.
        const labelCount = (label: string): number =>
            ids.reduce((sum, id) => sum + ((workspaceByID.get(id)?.labels.includes(label) ?? false) ? 1 : 0), 0);
        const labelRow = (label: string, swatch: string | undefined): MenuItemSpec => {
            const applied = labelCount(label);
            const all = count > 0 && applied === count;
            const state: boolean | 'mixed' = all ? true : applied > 0 ? 'mixed' : false;
            return {
                id: `bulk-label:${label}`,
                label,
                checked: state,
                ...(swatch === undefined ? {} : { swatch }),
                onSelect: () => {
                    props.onSetBulkLabel?.(ids, label, !all);
                }
            };
        };
        // Free-form labels present on ANY selected workspace, deduped in selection order.
        const presetNames = new Set(presets.map((preset) => preset.name));
        const freeform: string[] = [];
        for (const id of ids) {
            for (const label of workspaceByID.get(id)?.labels ?? []) {
                if (!presetNames.has(label) && !freeform.includes(label)) freeform.push(label);
            }
        }

        return [
            { id: 'bulk-caption', label: `${String(count)} workspaces selected`, kind: 'caption' },
            {
                id: 'bulk-color',
                label: `Color ${String(count)} Workspaces`,
                submenu: WORKSPACE_COLORS.map((color) => ({
                    id: `bulk-color:${color}`,
                    // M3: `WorkspaceColor.displayName` — the bulk list is the same `ForEach` over
                    // `WorkspaceColor.allCases` as the single-row one (`:876-880`).
                    label: workspaceColorDisplayName(color),
                    swatch: workspaceColorHex(color, bucket),
                    onSelect: () => {
                        props.onSetBulkColor?.(ids, color);
                    }
                }))
            },
            {
                id: 'bulk-labels',
                label: `Label ${String(count)} Workspaces`,
                submenu: [
                    ...(presets.length === 0 && freeform.length === 0
                        ? [{ id: 'bulk-no-labels', label: 'No presets', kind: 'caption' } satisfies MenuItemSpec]
                        : []),
                    ...presets.map((preset) =>
                        labelRow(preset.name, resolveLabelStyle(preset.name, presets, bucket).background)
                    ),
                    ...(freeform.length === 0
                        ? []
                        : [
                              { id: 'bulk-label-sep', label: '', kind: 'separator' } satisfies MenuItemSpec,
                              ...freeform.map((label) => labelRow(label, undefined))
                          ]),
                    ...(props.onOpenSettings === undefined
                        ? []
                        : [
                              { id: 'bulk-label-sep2', label: '', kind: 'separator' } satisfies MenuItemSpec,
                              {
                                  id: 'bulk-manage-labels',
                                  label: 'Manage Labels…',
                                  onSelect: () => {
                                      props.onOpenSettings?.('labels');
                                  }
                              } satisfies MenuItemSpec
                          ])
                ]
            },
            {
                id: 'bulk-group',
                label: `Group ${String(count)} Workspaces…`,
                disabled: props.onCreateGroupForWorkspaces === undefined,
                onSelect: () => {
                    setNewForm({ kind: 'group', groupID: null, workspaceIDs: ids });
                }
            },
            ...(groups.length === 0 && !inAnyGroup
                ? []
                : [
                      {
                          id: 'bulk-move',
                          label: `Move ${String(count)} Workspaces to Group`,
                          submenu: [
                              ...(inAnyGroup
                                  ? [
                                        {
                                            id: 'bulk-move:top',
                                            label: 'Remove from Group',
                                            onSelect: () => {
                                                props.onMoveWorkspaces?.({
                                                    workspaceIDs: ids,
                                                    groupID: null,
                                                    index: baseModel.topLevel.length
                                                });
                                            }
                                        } satisfies MenuItemSpec,
                                        { id: 'bulk-move:sep', label: '', kind: 'separator' } satisfies MenuItemSpec
                                    ]
                                  : []),
                              ...groups.map(
                                  (group): MenuItemSpec => ({
                                      id: `bulk-move:${group.id}`,
                                      label: group.name,
                                      // Disabled only when EVERY selected workspace already lives there.
                                      disabled: ids.every((id) => groupIDForWorkspace(id) === group.id),
                                      onSelect: () => {
                                          props.onMoveWorkspaces?.({
                                              workspaceIDs: ids,
                                              groupID: group.id,
                                              index: (baseModel.children.get(group.id) ?? []).length
                                          });
                                      }
                                  })
                              )
                          ]
                      } satisfies MenuItemSpec
                  ]),
            { id: 'bulk-sep', label: '', kind: 'separator' },
            {
                id: 'bulk-select-all',
                label: 'Select All Workspaces',
                disabled: count >= total,
                onSelect: () => {
                    setSelection(new Set(workspaceByID.keys()));
                }
            },
            {
                id: 'bulk-deselect',
                label: 'Deselect All',
                onSelect: () => {
                    setSelection(EMPTY_SELECTION);
                }
            },
            { id: 'bulk-sep2', label: '', kind: 'separator' },
            {
                id: 'bulk-delete',
                label: `Delete ${String(count)} Workspaces…`,
                danger: true,
                // §WS-060: deleting the entire list is refused, not merely discouraged.
                disabled: count >= total,
                onSelect: () => {
                    setConfirm({ kind: 'workspaces', ids });
                }
            }
        ];
    }, [baseModel, bucket, groupIDForWorkspace, groups, orderedSelection, presets, props, setSelection, workspaceByID]);

    const workspaceMenuItems = useCallback(
        (workspaceID: string): MenuItemSpec[] => {
            const workspace = workspaceByID.get(workspaceID);
            if (workspace === undefined) return [];
            const currentGroup = groupIDForWorkspace(workspaceID);
            const applied = new Set(workspace.labels);
            // §WS-049's list, assembled at right-click time: the built-in `default` baseline
            // first, then whatever the config defines now, then — only if it is not already
            // there — the name this workspace is assigned to. That last clause is the whole
            // point of appending: a profile deleted from the config would otherwise take the
            // workspace's tick with it and the menu would look unassigned.
            const assignedProfile = workspace.profileName ?? null;
            const profileNames = [
                DEFAULT_PROFILE_NAME,
                ...(props.profiles ?? []).filter((name) => name !== DEFAULT_PROFILE_NAME)
            ];
            if (assignedProfile !== null && assignedProfile.trim() !== '' && !profileNames.includes(assignedProfile)) {
                profileNames.push(assignedProfile);
            }
            const presetItems: MenuItemSpec[] = presets.map((preset) => ({
                id: `label:${preset.name}`,
                label: preset.name,
                checked: applied.has(preset.name),
                swatch: resolveLabelStyle(preset.name, presets, bucket).background,
                onSelect: () => {
                    props.onToggleWorkspaceLabel?.(workspaceID, preset.name, !applied.has(preset.name));
                }
            }));
            const freeform: MenuItemSpec[] = workspace.labels
                .filter((label) => !presets.some((preset) => preset.name === label))
                .map((label) => ({
                    id: `freelabel:${label}`,
                    label,
                    checked: true,
                    onSelect: () => {
                        props.onToggleWorkspaceLabel?.(workspaceID, label, false);
                    }
                }));

            return [
                {
                    id: 'rename',
                    label: 'Rename…',
                    onSelect: () => {
                        setRename({ kind: 'workspace', id: workspaceID });
                    }
                },
                // M2: the Swift's row menu is Rename / Color / Profile / Change Icon / Labels /
                // Move (`WorkspaceListView.swift:896-910`). The port had Change Icon second and
                // Profile fifth; the two are swapped back here.
                {
                    id: 'color',
                    label: 'Color',
                    submenu: WORKSPACE_COLORS.map((color) => ({
                        id: `color:${color}`,
                        // M3: `WorkspaceColor.displayName` — "Red", not the wire token.
                        label: workspaceColorDisplayName(color),
                        checked: workspace.color === color,
                        swatch: workspaceColorHex(color, bucket),
                        onSelect: () => {
                            props.onSetWorkspaceColor?.(workspaceID, color);
                        }
                    }))
                },
                // §WS-049: built at right-click time from whatever the config holds NOW — the
                // profiles prop is re-read per snapshot, so there is no watcher to go stale.
                // `default` leads (it is the daemon's built-in baseline, not a config entry),
                // and a profile the workspace is assigned to but the config no longer defines
                // is appended so the tick never disappears off the end of the list.
                ...(props.onSetWorkspaceProfile === undefined
                    ? []
                    : [
                          {
                              id: 'profile',
                              label: 'Profile',
                              submenu: profileNames.map(
                                  (name): MenuItemSpec => ({
                                      id: `profile:${name}`,
                                      label: name,
                                      checked: (assignedProfile ?? DEFAULT_PROFILE_NAME) === name,
                                      onSelect: () => {
                                          // The daemon normalizes "default" to "no assignment",
                                          // so the menu sends `null` for the baseline rather
                                          // than storing the word.
                                          props.onSetWorkspaceProfile?.(
                                              workspaceID,
                                              name === DEFAULT_PROFILE_NAME ? null : name
                                          );
                                      }
                                  })
                              )
                          } satisfies MenuItemSpec
                      ]),
                {
                    id: 'icon',
                    label: 'Change Icon',
                    submenu: iconSubmenu('workspace', workspaceID, workspace.icon)
                },
                {
                    id: 'labels',
                    label: 'Labels',
                    submenu: [
                        ...(presetItems.length + freeform.length === 0
                            ? [{ id: 'no-labels', label: 'No presets', kind: 'caption' } satisfies MenuItemSpec]
                            : [...presetItems, ...freeform]),
                        // shell-ui.md §5.7: the submenu offers existing presets only, so this is
                        // the way to CREATE or recolor one.
                        ...(props.onOpenSettings === undefined
                            ? []
                            : [
                                  {
                                      id: 'manage-labels',
                                      label: 'Manage Labels…',
                                      onSelect: () => {
                                          props.onOpenSettings?.('labels');
                                      }
                                  } satisfies MenuItemSpec
                              ])
                    ]
                },
                {
                    id: 'move',
                    label: 'Move to Group',
                    submenu: [
                        ...(currentGroup === null
                            ? []
                            : [
                                  {
                                      id: 'move:top',
                                      label: 'Remove from Group',
                                      onSelect: () => {
                                          props.onMoveWorkspace?.({
                                              workspaceID,
                                              groupID: null,
                                              index: baseModel.topLevel.length
                                          });
                                      }
                                  } satisfies MenuItemSpec,
                                  // The Swift's own divider after the un-group verb, so the
                                  // destinations below read as a list rather than a fourth item.
                                  { id: 'move:sep-top', label: '', kind: 'separator' } satisfies MenuItemSpec
                              ]),
                        ...groups.map(
                            (group): MenuItemSpec => ({
                                id: `move:${group.id}`,
                                label: group.name,
                                disabled: group.id === currentGroup,
                                onSelect: () => {
                                    props.onMoveWorkspace?.({
                                        workspaceID,
                                        groupID: group.id,
                                        index: (baseModel.children.get(group.id) ?? []).length
                                    });
                                }
                            })
                        ),
                        // §WS-052: the one-gesture "put this workspace in a NEW group". The
                        // create carries the workspace (one atomic change, not a create then a
                        // move) and the reply's id opens the header's inline rename — which is
                        // why the callback lives in assembly and not here.
                        ...(props.onCreateGroupWithWorkspace === undefined
                            ? []
                            : [
                                  ...(groups.length === 0
                                      ? []
                                      : [
                                            {
                                                id: 'move:sep-new',
                                                label: '',
                                                kind: 'separator'
                                            } satisfies MenuItemSpec
                                        ]),
                                  {
                                      id: 'move:new',
                                      label: 'New Group…',
                                      onSelect: () => {
                                          props.onCreateGroupWithWorkspace?.(workspaceID);
                                      }
                                  } satisfies MenuItemSpec
                              ])
                    ]
                },
                { id: 'sep', label: '', kind: 'separator' },
                // §WS-053: the single-row menu carries the selection verbs too — "Select All"
                // dimmed once everything is selected, "Deselect All" only while a selection
                // exists. Select All covers members hidden inside collapsed groups (§WS-045).
                {
                    id: 'select-all',
                    label: 'Select All Workspaces',
                    disabled: selection.size >= workspaceByID.size,
                    onSelect: () => {
                        setSelection(new Set(workspaceByID.keys()));
                    }
                },
                ...(selection.size === 0
                    ? []
                    : [
                          {
                              id: 'deselect-all',
                              label: 'Deselect All',
                              onSelect: () => {
                                  setSelection(EMPTY_SELECTION);
                              }
                          } satisfies MenuItemSpec
                      ]),
                { id: 'sep2', label: '', kind: 'separator' },
                {
                    id: 'delete',
                    label: 'Delete',
                    danger: true,
                    disabled: workspaceByID.size <= 1,
                    onSelect: () => {
                        // WS-108: the count only enters the dialog while the daemon's
                        // `confirm-workspace-delete` is on — with it off, the delete is the
                        // plain confirmation it has always been, and the alert never fires.
                        const active =
                            props.confirmDeleteWhenActive === false
                                ? 0
                                : (props.activeAgentCount?.(workspaceID) ?? 0);
                        setConfirm({
                            kind: 'workspace',
                            id: workspaceID,
                            name: workspace.name,
                            ...(active > 0 ? { activeAgents: active } : {})
                        });
                    }
                }
            ];
        },
        [
            baseModel,
            bucket,
            groupIDForWorkspace,
            groups,
            iconSubmenu,
            presets,
            props,
            selection,
            setSelection,
            workspaceByID
        ]
    );

    const groupMenuItems = useCallback(
        (groupID: string): MenuItemSpec[] => {
            const group = groups.find((candidate) => candidate.id === groupID);
            if (group === undefined) return [];
            const collapsed = isGroupCollapsed(group, { overrides: collapseOverrides });
            return [
                {
                    id: 'new-workspace',
                    label: 'New Workspace',
                    onSelect: () => {
                        setNewForm({ kind: 'workspace', groupID });
                    }
                },
                { id: 'sep1', label: '', kind: 'separator' },
                {
                    id: 'rename',
                    label: 'Rename…',
                    onSelect: () => {
                        setRename({ kind: 'group', id: groupID });
                    }
                },
                // M2: the Swift's group menu is New Workspace / — / Rename / Color / Change Icon /
                // Expand|Collapse / — / Delete (`WorkspaceListView.swift:1183-1207`). Change Icon
                // followed Rename here; it belongs after Color, as in the row menu.
                // §WS-065: a group's colour is OPTIONAL, unlike a workspace's, so this list
                // leads with "None" and the ten palette colours follow. Without it the colour
                // could only ever be chosen at `group create --color` time.
                ...(props.onSetGroupColor === undefined
                    ? []
                    : [
                          {
                              id: 'color',
                              label: 'Color',
                              submenu: [
                                  {
                                      id: 'color:none',
                                      label: 'None',
                                      checked: group.color === null,
                                      onSelect: () => {
                                          props.onSetGroupColor?.(groupID, null);
                                      }
                                  } satisfies MenuItemSpec,
                                  ...WORKSPACE_COLORS.map(
                                      (color): MenuItemSpec => ({
                                          id: `color:${color}`,
                                          // M3: `WorkspaceColor.displayName`.
                                          label: workspaceColorDisplayName(color),
                                          checked: group.color === color,
                                          swatch: workspaceColorHex(color, bucket),
                                          onSelect: () => {
                                              props.onSetGroupColor?.(groupID, color);
                                          }
                                      })
                                  )
                              ]
                          } satisfies MenuItemSpec
                      ]),
                {
                    id: 'icon',
                    label: 'Change Icon',
                    submenu: iconSubmenu('group', groupID, group.icon)
                },
                {
                    id: 'collapse',
                    label: collapsed ? 'Expand' : 'Collapse',
                    onSelect: () => {
                        toggleCollapse(groupID);
                    }
                },
                { id: 'sep2', label: '', kind: 'separator' },
                {
                    id: 'delete',
                    label: 'Delete Group…',
                    danger: true,
                    onSelect: () => {
                        const entry = props.entries.find(
                            (candidate) => candidate.kind === 'group' && candidate.group.id === groupID
                        );
                        setConfirm({
                            kind: 'group',
                            id: groupID,
                            name: group.name,
                            memberCount: entry?.kind === 'group' ? entry.workspaces.length : 0
                        });
                    }
                }
            ];
        },
        [bucket, collapseOverrides, groups, iconSubmenu, props, toggleCollapse]
    );

    /**
     * The background context menu — `WorkspaceListView.swift:343-350`, the two rows the trailing
     * spacer absorbs a right-click into.
     *
     * Its New Group is the SAME one-shot the chevron's is: `createGroup(name: placeholder,
     * autoRename: true)`, byte for byte the call at `:414-417`. It was the last route in this
     * client still opening a form for a group, which 776a776 recorded as a follow-up and this
     * change closes — leaving group creation with exactly two shapes, both the Swift's: a mint
     * that drops into inline rename (⌘⇧G, File ▸ New Group, the chevron, here), and the New
     * Group SHEET, which `NewGroupSheet.swift`'s own comment says is the bulk "Group Selected
     * Workspaces…" flow's (§WS-082) — the one place a group is created around a selection and so
     * the one place a name and a colour are worth asking for up front.
     */
    const onNewGroupWithRename = props.onNewGroupWithRename;
    const backgroundMenuItems = useCallback(
        (): MenuItemSpec[] => [
            {
                id: 'new-workspace',
                label: 'New Workspace',
                onSelect: () => {
                    setNewForm({ kind: 'workspace', groupID: null });
                }
            },
            {
                id: 'new-group',
                label: 'New Group',
                onSelect: () => {
                    // Assembly supplies the one-shot; without it the row falls back to the sheet
                    // rather than doing nothing.
                    if (onNewGroupWithRename !== undefined) {
                        onNewGroupWithRename();
                        return;
                    }
                    setNewForm({ kind: 'group', groupID: null });
                }
            }
        ],
        [onNewGroupWithRename]
    );

    /**
     * §WS-004's chevron menu: exactly the two rows `WorkspaceListView.swift:412-422` puts
     * behind it — New Workspace (the sheet) and New Group.
     *
     * New Group is NOT the sheet: the shipped menu runs `createGroup(name:autoRename:)`, the
     * same one-shot ⌘⇧G / File ▸ New Group run (§WS-123), so all four routes mint the
     * placeholder and drop into inline rename. Assembly supplies it; without it the row falls
     * back to the sheet rather than doing nothing.
     */
    const footerMenuItems = useCallback(
        (): MenuItemSpec[] => [
            {
                id: 'new-workspace',
                label: 'New Workspace',
                onSelect: () => {
                    setNewForm({ kind: 'workspace', groupID: null });
                }
            },
            {
                id: 'new-group',
                label: 'New Group',
                onSelect: () => {
                    if (onNewGroupWithRename !== undefined) {
                        onNewGroupWithRename();
                        return;
                    }
                    setNewForm({ kind: 'group', groupID: null });
                }
            }
        ],
        [onNewGroupWithRename]
    );

    const menuItems = useMemo((): readonly MenuItemSpec[] => {
        if (menu === null) return [];
        // §WS-055: a right-click ON a row that belongs to a ≥2 selection is a BULK gesture.
        if (menu.kind === 'workspace' && selection.size > 1 && selection.has(menu.id)) return bulkMenuItems();
        if (menu.kind === 'workspace') return workspaceMenuItems(menu.id);
        if (menu.kind === 'group') return groupMenuItems(menu.id);
        if (menu.kind === 'footer') return footerMenuItems();
        return backgroundMenuItems();
    }, [
        backgroundMenuItems,
        bulkMenuItems,
        footerMenuItems,
        groupMenuItems,
        menu,
        selection,
        workspaceMenuItems
    ]);

    /**
     * The row itself is what the menu must not cover (run-B m7): `currentTarget` is the row
     * element the handler is bound to, so its rect is the thing to dodge.
     */
    const onWorkspaceContextMenu = useCallback((workspaceID: string, event: React.MouseEvent): void => {
        event.preventDefault();
        event.stopPropagation();
        const anchor = menuAnchorFromEvent(event, rowRect(event));
        setMenu({ kind: 'workspace', id: workspaceID, x: anchor.x, y: anchor.y });
    }, []);

    const onGroupContextMenu = useCallback((groupID: string, event: React.MouseEvent): void => {
        event.preventDefault();
        event.stopPropagation();
        const anchor = menuAnchorFromEvent(event, rowRect(event));
        setMenu({ kind: 'group', id: groupID, x: anchor.x, y: anchor.y });
    }, []);

    const onBackgroundContextMenu = useCallback((event: React.MouseEvent): void => {
        event.preventDefault();
        const anchor = menuAnchorFromEvent(event);
        setMenu({ kind: 'background', x: anchor.x, y: anchor.y });
    }, []);

    /**
     * The footer chevron toggles its own menu — click to open, click again to dismiss, the way
     * `TopBar`'s ••• toggle behaves. `ContextMenu` positions by its TOP-LEFT corner, and this
     * one drops UPWARD (the footer is the last thing before the window edge), so the height has
     * to be supplied rather than measured: `FOOTER_MENU_ESTIMATED_HEIGHT`. The clamp is what
     * keeps it on screen in a short window.
     */
    const toggleFooterMenu = useCallback((): void => {
        setMenu((current) => {
            if (current !== null && current.kind === 'footer') return null;
            const box = footerMenuButtonRef.current?.getBoundingClientRect();
            if (box === undefined) return { kind: 'footer', x: 8, y: 8 };
            return {
                kind: 'footer',
                x: Math.round(box.left),
                y: Math.round(Math.max(8, box.top - FOOTER_MENU_ESTIMATED_HEIGHT - FOOTER_MENU_GAP))
            };
        });
    }, []);

    /**
     * Escape / an outside click hands the keyboard back to the chevron, so a keyboard user is
     * not dropped on `<body>`. When a row was CHOSEN the button is about to be replaced by the
     * create form, whose own mount effect focuses the name field after this call — so the form
     * still wins, and the only case this focus survives is the dismissal it is for.
     */
    const closeFooterMenu = useCallback((): void => {
        setMenu(null);
        footerMenuButtonRef.current?.focus();
    }, []);

    // ── rename commits ──────────────────────────────────────────────────────────
    const cancelRename = useCallback((): void => {
        setRename(null);
    }, []);
    const commitWorkspaceRename = useCallback(
        (workspaceID: string, name: string): void => {
            setRename(null);
            props.onRenameWorkspace?.(workspaceID, name);
        },
        [props]
    );
    const commitGroupRename = useCallback(
        (groupID: string, name: string): void => {
            setRename(null);
            props.onRenameGroup?.(groupID, name);
        },
        [props]
    );

    /**
     * §5.5 multi-drag: the selected rows that are NOT the grabbed one. They collapse to zero
     * height for the duration so the list shows a single moving row and one gap, and the
     * grabbed row wears a `+N` capsule for the rest.
     */
    const dragCompanions = useMemo((): ReadonlySet<string> => {
        if (dragID === null) return EMPTY_SELECTION;
        if (!selection.has(dragID) || selection.size < 2) return EMPTY_SELECTION;
        const companions = new Set(selection);
        companions.delete(dragID);
        return companions;
    }, [dragID, selection]);

    // ── filtered list ───────────────────────────────────────────────────────────
    const needle = props.filter.trim();
    const filtered = useMemo(
        () => (needle.length === 0 ? [] : filteredRows(props.entries, needle)),
        [needle, props.entries]
    );

    const dragStartWorkspace = useCallback(
        (workspaceID: string, event: React.MouseEvent) => {
            if (needle.length > 0) return; // §5.1: no drag & drop in the filtered list.
            onDragStart('workspace', workspaceID, event);
        },
        [needle.length, onDragStart]
    );
    const dragStartGroup = useCallback(
        (groupID: string, event: React.MouseEvent) => {
            onDragStart('group', groupID, event);
        },
        [onDragStart]
    );

    const body =
        needle.length > 0 ? (
            /* Flex for the same reason the main list is: the filtered list draws the same rows
               with the same ring, so it needs the same uncollapsed 2 + 2 between them. */
            <div data-testid="sidebar-filtered" className="flex flex-col">
                {filtered.length === 0 ? (
                    /*
                     * L5: `VStack(spacing: 4) { Text("No matches").font(.system(size: 12, weight:
                     * .medium)).foregroundStyle(.secondary); Text("Try a different filter…")
                     * .font(.system(size: 10)).foregroundStyle(.tertiary) }.padding(.vertical, 24)`
                     * (`WorkspaceListView.swift:730-741`). The port had no line spacing, no
                     * medium weight on the headline, and drew the sub-line at the headline's own
                     * 12px — three notes of emphasis flattened into one.
                     */
                    <div
                        data-testid="sidebar-filter-empty"
                        className="flex flex-col items-center gap-1 px-3 py-6 text-center"
                        style={{ color: tokens.textTertiary }}
                    >
                        <div className="text-[12px] font-medium" style={{ color: tokens.textSecondary }}>
                            No matches
                        </div>
                        <div className="text-[10px]">Try a different filter or clear the field.</div>
                    </div>
                ) : (
                    filtered.map((row) => (
                        <WorkspaceRow
                            key={row.workspace.id}
                            workspace={row.workspace}
                            depth={0}
                            active={row.workspace.id === props.activeWorkspaceID}
                            selected={selection.has(row.workspace.id)}
                            badgeIndex={-1}
                            bucket={bucket}
                            presets={presets}
                            renaming={rename?.kind === 'workspace' && rename.id === row.workspace.id}
                            dragging={false}
                            groupCaption={row.groupName}
                            onActivate={(id, event) => {
                                if (event.metaKey || event.ctrlKey || event.shiftKey) {
                                    const next = new Set(selection);
                                    if (next.has(id)) next.delete(id);
                                    else next.add(id);
                                    setSelection(next);
                                    return;
                                }
                                // §WS-018: find-then-go. A plain click on a filtered row clears
                                // the selection as well — the same rule the main list's
                                // `onActivate` follows, and the reason the filter is a way to
                                // REACH a workspace rather than a view to work inside.
                                if (selection.size > 0) setSelection(EMPTY_SELECTION);
                                props.onActivateWorkspace?.(id);
                                props.onFilterChange('');
                            }}
                            onContextMenu={onWorkspaceContextMenu}
                            onDragStart={dragStartWorkspace}
                            onCommitRename={commitWorkspaceRename}
                            onCancelRename={cancelRename}
                            registerRow={registerRow}
                        />
                    ))
                )}
            </div>
        ) : (
            /*
             * A FLEX COLUMN, and that is the whole of §WS-027's clearance fix.
             *
             * Adjacent BLOCK siblings collapse their vertical margins, so every row's 2px top
             * margin and its neighbour's 2px bottom margin used to become one 2px gap — half the
             * Swift's, which spends 2pt on each item and never collapses because SwiftUI padding
             * cannot (`VStack(spacing: 0)` + `.padding(.vertical, 2)` per item,
             * `WorkspaceListView.swift:291`, `WorkspaceRowView.swift:97`,
             * `GroupHeaderRow.swift:110`). With 1.5px of accent ring bleeding 0.75px past the
             * border box, 2px of gap left 1.25px of air and the highlight read as touching the
             * band above it. Flex items keep both margins: 4px apart, 3.25px of air, the Swift's
             * number.
             *
             * Nothing else about the box changes — no height, no width, no padding — so every
             * measurement §WS-093's gate and §WS-008's FLIP take answers what it always did,
             * one row pitch larger.
             */
            <div data-testid="sidebar-list" className="flex flex-col">
                {rows.map((row, index) => {
                    if (row.kind === 'group-header') {
                        const entry = effectiveEntries.find(
                            (candidate) => candidate.kind === 'group' && candidate.group.id === row.groupID
                        );
                        if (entry === undefined || entry.kind !== 'group') return null;
                        return (
                            <GroupHeaderRow
                                key={row.key}
                                group={entry.group}
                                collapsed={isGroupCollapsed(entry.group, collapse)}
                                counts={agentCounts(entry.workspaces)}
                                bucket={bucket}
                                renaming={rename?.kind === 'group' && rename.id === entry.group.id}
                                dropPreview={previewGroupID === entry.group.id}
                                onToggle={toggleCollapse}
                                onContextMenu={onGroupContextMenu}
                                onDragStart={dragStartGroup}
                                onCommitRename={commitGroupRename}
                                onCancelRename={cancelRename}
                                registerRow={registerRow}
                                entering={entering.has(row.key)}
                                enterFast={enteringFast}
                            />
                        );
                    }
                    if (row.kind === 'group-empty') {
                        /*
                         * M1 / §WS-007: the guide rule does NOT stop at an empty group.
                         * `groupChildGuideColor` (`WorkspaceListView.swift:465-479`) returns a
                         * colour for `.groupEmpty` exactly as it does for a child row, and the
                         * overlay is hung on every entry alike (`:311-328`) — so the "No
                         * workspaces" placeholder carries its own segment of the rule.
                         *
                         * Same 18px inset as a child row's: the placeholder's `ml-6` puts its own
                         * left edge on the 24px nesting indent, so `left: -6` lands on 18. No
                         * bridging either way — the placeholder is the group's only child, so
                         * there is no sibling segment to meet.
                         *
                         * S47 puts the segment where a one-member group's is, too: measured, the
                         * rule used to start 2.00px under the band and now starts 4.00px under
                         * it, which is exactly where the rule on a group's only WORKSPACE row
                         * starts. `top`/`bottom` stay 0 — the outer margin is the row's, not the
                         * overlay's, and an unbridged segment spans its own box.
                         */
                        const emptyGuideColor = guideColorFor(row.groupID);
                        return (
                            <div
                                key={row.key}
                                data-testid="group-empty"
                                data-reorder="spring"
                                data-guide={emptyGuideColor === undefined ? undefined : 'true'}
                                /*
                                 * L9: `GroupEmptyRow` (`GroupHeaderRow.swift:174-194`) is
                                 * `HStack(spacing: 8) { Spacer().frame(width: 16); Color.clear
                                 * .frame(width: 4); Text }` inside `.padding(.horizontal, 16)`,
                                 * so "No workspaces" starts 16 + 16 + 8 + 4 + 8 = 52pt from the
                                 * list's leading edge — an `HStack` spends its spacing on EVERY
                                 * adjacent pair, the fixed-width `Spacer` included.
                                 *
                                 * Stated divergence from the register's L9, which reads that
                                 * chain as 44pt: the arithmetic above is where the 52 comes from,
                                 * and the port lands on it — the scroller's own `px-2` (8) plus
                                 * `ml-6` (24) plus `pl-5` (20). The finding's substance is
                                 * unchanged either way: the placeholder used to start at 40 and
                                 * carried no trailing padding at all, where the Swift's structure
                                 * is 16pt on both sides.
                                 */
                                className="relative ml-6 py-1.5 pl-5 pr-4 text-[12px]"
                                /*
                                 * SPACING-REVIEW S47 — OWNER-DIRECTED divergence from
                                 * `GroupHeaderRow.swift:174-193`, where `GroupEmptyRow` is
                                 * `.padding(.vertical, 6)` and carries NO outer 2pt, unlike the
                                 * rows and bands around it. Parity value: no vertical margin.
                                 *
                                 * `WorkspaceListView.swift:291` is a `VStack(spacing: 0)`, so
                                 * every gap in this list is the items' own outer padding and
                                 * two neighbours that both carry it sit `2 * ROW_OUTER_GAP_PX`
                                 * apart. The placeholder carried none, so it was the one row in
                                 * the list on a different pitch: measured live, band →
                                 * placeholder 2.00 and placeholder → next row 2.00, against
                                 * 4.00 for row→row, row→band and band→row alike. The two
                                 * margins here put it on the list's uniform 4px pitch; nothing
                                 * inside the box moves (the 6/20/6/16 padding and §L9's 52px
                                 * text origin are untouched).
                                 */
                                style={{
                                    color: tokens.textTertiary,
                                    marginTop: ROW_OUTER_GAP_PX,
                                    marginBottom: ROW_OUTER_GAP_PX
                                }}
                                onContextMenu={(event) => {
                                    onGroupContextMenu(row.groupID, event);
                                }}
                                ref={(element) => {
                                    registerRow(row.key, element);
                                }}
                            >
                                {emptyGuideColor === undefined ? null : (
                                    <span
                                        aria-hidden
                                        data-testid="group-guide"
                                        style={{
                                            position: 'absolute',
                                            left: -6,
                                            top: 0,
                                            bottom: 0,
                                            width: 1.5,
                                            borderRadius: 1,
                                            background: emptyGuideColor,
                                            pointerEvents: 'none'
                                        }}
                                    />
                                )}
                                No workspaces
                            </div>
                        );
                    }
                    const workspace = workspaceByID.get(row.workspaceID);
                    if (workspace === undefined) return null;
                    // §WS-007: the guide is drawn per row, so each child has to know whether it
                    // has a sibling above and below to bridge to.
                    const above = rows[index - 1];
                    const below = rows[index + 1];
                    const sibling = (candidate: RenderedRow | undefined): boolean =>
                        candidate !== undefined && candidate.kind === 'workspace' && candidate.groupID === row.groupID;
                    return (
                        <WorkspaceRow
                            key={row.key}
                            workspace={workspace}
                            depth={row.depth}
                            groupID={row.groupID}
                            active={workspace.id === props.activeWorkspaceID}
                            selected={selection.has(workspace.id)}
                            badgeIndex={visibleOrder.indexOf(workspace.id)}
                            bucket={bucket}
                            presets={presets}
                            renaming={rename?.kind === 'workspace' && rename.id === workspace.id}
                            dragging={dragID === workspace.id}
                            dragHidden={dragCompanions.has(workspace.id)}
                            dragExtra={dragID === workspace.id ? dragCompanions.size : 0}
                            // §WS-089: the dragged row previews the nesting it is about to get.
                            nestPreview={dragID === workspace.id && previewGroupID !== null}
                            // …and, once the gesture IS a drag, its slot is the empty space the
                            // drop lands in. `dragActive` rather than `dragging`: a press that
                            // never moved must not blank the row under the cursor.
                            gap={dragID === workspace.id && dragActive}
                            groupCaption={null}
                            // §WS-007: the guide rule, tinted with the group's own colour (or
                            // the theme divider when it has none), bridging the gaps to its
                            // siblings so the run of children reads as ONE line.
                            guideColor={guideColorFor(row.groupID)}
                            guideExtendUp={sibling(above)}
                            guideExtendDown={sibling(below)}
                            // §WS-088's insertion line was passed here and is gone: a SLOT
                            // target's indicator is the vacated gap the rows have already moved
                            // around, and an `ontoGroupHeader` target's is the header band's own
                            // tint. Both are the Swift's — see the note above `WorkspaceRow`.
                            entering={entering.has(row.key)}
                            enterFast={enteringFast}
                            onActivate={onActivate}
                            onContextMenu={onWorkspaceContextMenu}
                            onDragStart={dragStartWorkspace}
                            onCommitRename={commitWorkspaceRename}
                            onCancelRename={cancelRename}
                            registerRow={registerRow}
                        />
                    );
                })}
            </div>
        );

    return (
        <div
            data-testid="sidebar"
            className="flex h-full min-h-0 flex-col"
            style={{
                background: tokens.sidebarBackground,
                color: tokens.textPrimary,
                // The sidebar's labels are chrome, not content — and an unselectable row is
                // also a row a drag cannot smear. See `UNSELECTABLE_TEXT_STYLE`.
                ...UNSELECTABLE_TEXT_STYLE
            }}
        >
            {/*
              * §H21 + §H22 — the filter pill, at the shipped app's metrics and on the theme.
              *
              * `WorkspaceListView.swift:627-684`: `HStack(spacing: 8)` with a 13pt glyph and a
              * 13pt field, `.padding(.horizontal, 12).padding(.vertical, 10)` for the pill and
              * `.padding(.horizontal, 10).padding(.vertical, 8)` for the margin around it. The
              * port shipped 8×4 inner / 8 outer / 12px text / 6px gap — roughly HALF the
              * height, on the first control in the sidebar.
              *
              * The fill and border are `chromeTheme.textPrimary.opacity(0.05 / 0.08)` (`:676`,
              * `:679`), NOT a hex: the port's frozen `#E6E6EA` is the dark preset's `--nex-fg`,
              * which at 5% over the LIGHT sidebar's `#efeee9` is very nearly the sidebar
              * itself, so the pill and its border effectively vanished in light mode.
              */}
            <div className="px-2.5 py-2">
                <div
                    className="flex items-center gap-2 rounded-[10px] px-3 py-2.5"
                    style={{
                        background: withAlpha(tokens.textPrimary, 0.05),
                        border: `1px solid ${withAlpha(tokens.textPrimary, 0.08)}`
                    }}
                >
                    <span style={{ color: tokens.textTertiary }}>
                        <ChromeIcon name="search" size={13} />
                    </span>
                    <input
                        ref={filterInputRef}
                        aria-label="Filter workspaces or labels"
                        placeholder="Filter workspaces or labels"
                        data-testid="sidebar-filter"
                        className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
                        style={{ color: tokens.textPrimary, ...SELECTABLE_TEXT_STYLE }}
                        value={props.filter}
                        onChange={(event) => {
                            props.onFilterChange(event.target.value);
                        }}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                                const first = filtered[0];
                                // §WS-011: activate, clear the SELECTION, clear the field,
                                // yield focus — in that order. A selection made while filtering
                                // must not survive the jump, or the next bulk gesture acts on
                                // rows the user can no longer see.
                                if (first !== undefined) props.onActivateWorkspace?.(first.workspace.id);
                                if (selection.size > 0) setSelection(EMPTY_SELECTION);
                                props.onFilterChange('');
                                event.currentTarget.blur();
                                return;
                            }
                            if (event.key === 'Escape') {
                                event.stopPropagation();
                                props.onFilterChange('');
                                event.currentTarget.blur();
                            }
                        }}
                    />
                    {props.filter.length > 0 ? (
                        <button
                            type="button"
                            aria-label="Clear filter"
                            className="shrink-0"
                            style={{ color: tokens.textTertiary }}
                            onClick={(event) => {
                                /*
                                 * L13: the clear button drops FIRST RESPONDER as well as the
                                 * text. `WorkspaceListView.swift:657-668` is `filterText = "";
                                 * isFilterFieldFocused = false` — the same pair the field's own
                                 * Escape handler runs (`:649-655`), and the port implemented it
                                 * on Escape only. Without the blur the next keystroke goes back
                                 * into the field the user has just emptied instead of to the
                                 * focused pane.
                                 */
                                props.onFilterChange('');
                                filterInputRef.current?.blur();
                                event.currentTarget.blur();
                            }}
                        >
                            {/* `WorkspaceListView.swift:663` — the `xmark.circle.fill` is 13pt,
                                the same size as the magnifier that opens the pill. */}
                            <ChromeIcon name="clear" size={13} />
                        </button>
                    ) : null}
                </div>
            </div>

            {selection.size > 0 ? (
                <div
                    data-testid="selection-header"
                    /* M6: `.padding(.vertical, 6)` (`WorkspaceListView.swift:848`), not 4px. */
                    className="flex items-center gap-2 px-3 py-1.5 text-[11px]"
                    /* §H22: `Color.accentColor.opacity(0.12)` (`WorkspaceListView.swift:850`) —
                       the live accent, not the dark preset's `#6F9BD8` frozen into the source. */
                    style={{ background: withAlpha(tokens.accent, 0.12), color: tokens.textSecondary }}
                >
                    <span className="flex-1">{selection.size} selected</span>
                    {/*
                      * §WS-043: "Select All" disappears once everything already IS selected — a
                      * button whose only effect would be to do nothing.
                      *
                      * M6: the comparison is against the WHOLE workspace set, which is what
                      * `if count < store.workspaces.count` (`WorkspaceListView.swift:838`) reads
                      * and what `.selectAllWorkspaces` acts on. `visibleOrder` skips the members
                      * of a collapsed group, so the port used to hide the button while rows the
                      * user could reveal were still unselected — and to select fewer than the
                      * menu's own "Select All Workspaces" does (§WS-045). Both now agree.
                      */}
                    {selection.size >= workspaceByID.size ? null : (
                        <button
                            type="button"
                            /* M6: `.buttonStyle(.borderless)` at `:840-846` — an accent text
                               button, not the strip's own secondary body colour. */
                            style={{ color: tokens.accent, ...SELECTION_ACTION_HIT_BOX }}
                            onClick={() => {
                                setSelection(new Set(workspaceByID.keys()));
                            }}
                        >
                            Select All
                        </button>
                    )}
                    <button
                        type="button"
                        style={{ color: tokens.accent, ...SELECTION_ACTION_HIT_BOX }}
                        onClick={() => {
                            setSelection(EMPTY_SELECTION);
                        }}
                    >
                        Clear
                    </button>
                </div>
            ) : null}

            <div
                ref={listRef}
                /* `relative` is load-bearing twice over: it makes the scroller the offset parent
                   every row's `offsetTop` is measured against (§WS-008's FLIP and §WS-102's
                   reveal both read that number), and it is the containing block the removal
                   ghosts are pinned inside. */
                /*
                 * L19: the trailing inset is 8, not 12 — and the row's own `marginRight` (M7)
                 * is the OTHER 8. `WorkspaceListView.swift:358` pads the list `.trailing, 8` to
                 * clear the overlay scroller and `:1339` pads each row `.horizontal, 8`, so a
                 * row's background stops 16pt short of the sidebar's right edge and 8pt short of
                 * its left. `pr-3` made that 20 on the right the moment M7 landed the row half.
                 *
                 * `flex flex-col` is L14's other half: the trailing right-click target below is
                 * a FLEXIBLE spacer in the Swift, and only a flex column can grow it.
                 */
                className="relative flex min-h-0 flex-1 flex-col overflow-y-auto px-2"
                style={{ paddingTop: CONTENT_TOP_PADDING }}
                onContextMenu={onBackgroundContextMenu}
                role="listbox"
                aria-label="Workspaces"
            >
                {/*
                 * §WS-008's removal ghosts live here and nowhere else. Zero height, out of flow,
                 * `pointer-events: none`: the rows around it cannot be moved by what it holds,
                 * which is the whole reason a dying row can be animated at all (see
                 * `spawnRemovalGhosts`). React owns this node and never its children.
                 */}
                <div
                    ref={ghostLayerRef}
                    data-testid="sidebar-ghost-layer"
                    aria-hidden
                    className="pointer-events-none absolute left-0 top-0 z-10 h-0 w-full"
                />
                {/* The list itself never shrinks; the spacer below takes the slack. */}
                <div className="shrink-0">{body}</div>
                {/*
                 * L14: `Color.clear.frame(minHeight: 40, maxHeight: .infinity)`
                 * (`WorkspaceListView.swift:335-336`) — the right-click target under the last row
                 * is at LEAST 40pt and then fills whatever viewport is left, which is why "New
                 * Workspace / New Group" is reachable by right-clicking anywhere in the empty
                 * half of a short list. The port's fixed `h-8` was both a third too short and
                 * inert past its 32px, so most of an empty sidebar answered no right-click.
                 */}
                <div className="min-h-10 flex-1 shrink-0" data-testid="sidebar-spacer" />
            </div>

            <div
                /* §WS-004's bar is the whole footer now: the create form it used to expand into
                   is a modal sheet over the window (`NewWorkspaceSheet.tsx`), the way
                   `ContentView.swift:289-294` presents it, so the bar never has to grow, scroll
                   or push its own controls off the bottom of the window. */
                className="flex shrink-0 flex-col gap-1 border-t"
                style={{
                    borderColor: tokens.divider,
                    background: tokens.sidebarBackground,
                    padding: FOOTER_PADDING_PX
                }}
            >
                {/*
                  * §WS-004, in `WorkspaceListView.swift:394-446`'s own composition: a plain
                  * "+ New Workspace" button, a small chevron MENU beside it carrying New
                  * Workspace / New Group, a spacer, and the ⌘N hint at the trailing edge.
                  *
                  * The user's words on the shipped version of this row: "this is meant to be
                  * a dropdown toggle like the swift version". What was here instead were
                  * three sibling controls — a second "New Group" text button and a settings
                  * gear the Swift footer has neither of.
                  *
                  * The ⌘N hint is back at the trailing edge, where the Swift puts it. It had
                  * been moved INSIDE the button because trailing it after a "New Group"
                  * button read as New Group's shortcut (the run-B nit) — that button is gone,
                  * so the hint now trails the only labelled action in the row, which is the
                  * reading the Swift relies on too.
                  */}
                <div className="flex items-center" style={{ gap: FOOTER_GAP_PX }}>
                    <button
                        type="button"
                        data-testid="sidebar-new-workspace"
                        aria-label="New Workspace"
                        title="New Workspace (⌘N)"
                        /*
                         * L20: the Swift's Button label sets no font at all
                         * (`WorkspaceListView.swift:400-436`), so it inherits the footer's — the
                         * system BODY face, 13pt — and `Image(systemName: "plus")` inherits it
                         * too, drawing the glyph at body size rather than at the 12px this
                         * port's chrome SVG defaults to. Both go up a point; the glyph stays
                         * this file's hand-rolled SVG (there are no SF Symbols in a browser),
                         * now sized to the text beside it.
                         */
                        className="flex items-center text-[13px]"
                        style={{ color: tokens.textSecondary, gap: FOOTER_GAP_PX }}
                        onClick={() => {
                            setNewForm({ kind: 'workspace', groupID: null });
                        }}
                    >
                        <ChromeIcon name="plus" size={13} /> New Workspace
                    </button>
                    {/*
                      * `Menu { … } label: Image("chevron.down").font(.system(size: 9,
                      * weight: .semibold))` — a single-glyph borderless menu in the
                      * secondary text colour, which is why the Swift composes the row from
                      * a Button PLUS a Menu rather than one Menu with a custom label.
                      */}
                    <button
                        ref={footerMenuButtonRef}
                        type="button"
                        data-testid="sidebar-new-menu-toggle"
                        aria-label="New Workspace options"
                        aria-haspopup="menu"
                        aria-expanded={menu !== null && menu.kind === 'footer'}
                        title="New Workspace options"
                        className="flex items-center"
                        style={{
                            color: tokens.textSecondary,
                            /*
                             * SPACING-REVIEW S44 (OWNER-DIRECTED) — the hit box only.
                             *
                             * The 9 px glyph above is Swift-exact and stays; what the port has
                             * no equivalent for is `.menuStyle(.borderlessButton)`, which on the
                             * Swift side wraps that glyph in an AppKit menu CELL with its own
                             * inset. A bare `<button>` is the glyph and nothing else, so this
                             * footer's only route to New Group shipped as a 9.00 × 9.00 target —
                             * measured, and the smallest control anywhere in the sidebar.
                             *
                             * `padding: 6` gives the cell back (21 × 21); `margin: -6` on ALL
                             * four sides — not the register's `-6px 0` — hands the 12 px straight
                             * back to the layout, so the button's MARGIN box is still 9 × 9 and
                             * nothing around it moves. Horizontal matters as much as vertical
                             * here: `-6px 0` would have pushed the glyph 6 px right of "New
                             * Workspace" across the row's own `FOOTER_GAP_PX`, and the vertical
                             * half keeps the 43.2 px footer from growing on a 21 px child.
                             * Measured live at a 220 px sidebar: hit box 8.5 × 8.5 → 20.5 × 20.5,
                             * glyph unmoved at [134.8, 770.4, 9, 9], and the 440 × 88 picture of
                             * the whole footer row pixel-identical (0 of 38 720 px differ).
                             *
                             * The 6 px of leftward bleed lands exactly on `FOOTER_GAP_PX`, so
                             * the two controls' hit boxes abut and neither overlaps the other.
                             *
                             * Owner-directed: do not re-report. The parity value is no padding.
                             */
                            padding: 6,
                            margin: -6
                        }}
                        onClick={toggleFooterMenu}
                    >
                        <ChromeIcon name="chevron-down" size={9} />
                    </button>
                    <span
                        data-testid="sidebar-new-workspace-hint"
                        className="ml-auto font-mono text-[11px]"
                        style={{ color: tokens.textTertiary }}
                    >
                        ⌘N
                    </span>
                </div>
            </div>

            {/*
             * §WS-075's sheet, presented the way the shipped app presents it: a MODAL over the
             * window (`ContentView.swift:289-294`), not a form the footer expands into. Every
             * route that raises it — the bar's + button, the chevron's first row, a group
             * header's "New Workspace" (which preselects that group, the `pendingSheetGroupID`
             * contract), and assembly's `createRequest` (⌘N, File ▸ New Workspace, the palette,
             * the empty state's Create button) — lands here.
             */}
            {newForm === null ? null : (
                <NewEntrySheet
                    kind={newForm.kind}
                    // §H22: the swatch row used to resolve every workspace colour against a
                    // pinned `'dark'` bucket, so the sheet showed the dark palette's hues on a
                    // light theme — and then the row it created rendered a different colour.
                    bucket={bucket}
                    repos={props.repos ?? EMPTY_REPOS}
                    groups={groups}
                    profiles={props.profiles ?? EMPTY_PROFILES}
                    defaultColor={newFormColor}
                    // §WS-076: an explicitly scoped group (the group menu's "New Workspace")
                    // wins; otherwise SET-011's inherited group, which assembly resolves.
                    defaultGroupID={newForm.groupID ?? props.inheritGroupID ?? null}
                    {...(newForm.kind === 'group'
                        ? { defaultName: defaultGroupName(groups.map((group) => group.name)) }
                        : {})}
                    {...(newForm.workspaceIDs === undefined
                        ? {}
                        : { workspaceCount: newForm.workspaceIDs.length })}
                    onCancel={() => {
                        setNewForm(null);
                    }}
                    onSubmit={async (draft) => {
                        const members = newForm.workspaceIDs;
                        if (newForm.kind === 'group') {
                            // §WS-058: a group raised from the bulk menu is created AROUND
                            // the selection, in one command, and the selection is released.
                            if (members !== undefined && props.onCreateGroupForWorkspaces !== undefined) {
                                props.onCreateGroupForWorkspaces(draft.name, members, draft.color);
                                setSelection(EMPTY_SELECTION);
                            } else props.onCreateGroup?.(draft.name, draft.color);
                            setNewForm(null);
                            return null;
                        }
                        const result = await props.onCreateWorkspace?.(
                            draft.name,
                            draft.groupID,
                            draft.worktree,
                            {
                                ...(draft.color === null ? {} : { color: draft.color }),
                                profile: draft.profile,
                                repoPaths: draft.repoPaths
                            }
                        );
                        // §WS-079: a failed worktree create keeps the SHEET open, with the
                        // daemon's message inline under the fields.
                        if (typeof result === 'string') return result;
                        setNewForm(null);
                        return null;
                    }}
                />
            )}

            {menu === null ? null : (
                <ContextMenu
                    x={menu.x}
                    y={menu.y}
                    items={menuItems}
                    /* §WS-004's menu is opened by a CLICK, not a right-click, so it takes the
                       keyboard the way a dropdown does — first row focused, Escape back to the
                       chevron. The three context menus keep the pointer-driven behaviour they
                       have always had. */
                    {...(menu.kind === 'footer' ? { autoFocus: true } : {})}
                    onClose={menu.kind === 'footer' ? closeFooterMenu : closeMenu}
                    label={
                        menu.kind === 'footer'
                            ? 'New'
                            : menu.kind === 'group'
                              ? 'Group menu'
                              : 'Workspace menu'
                    }
                />
            )}

            {emojiSheet === null ? null : (
                <CustomEmojiSheet
                    /* M5: the sheet names its subject — `Custom Emoji for "<name>"`
                       (`GroupCustomEmojiSheet.swift:24-25`). Resolved here rather than carried on
                       `emojiSheet` so the title follows a rename that lands while it is open. */
                    subjectName={
                        emojiSheet.kind === 'workspace'
                            ? (workspaceByID.get(emojiSheet.id)?.name ?? '')
                            : (groups.find((candidate) => candidate.id === emojiSheet.id)?.name ?? '')
                    }
                    onCancel={() => {
                        setEmojiSheet(null);
                    }}
                    onSubmit={(grapheme) => {
                        if (emojiSheet.kind === 'workspace') {
                            props.onSetWorkspaceIcon?.(emojiSheet.id, `emoji:${grapheme}`);
                        } else {
                            props.onSetGroupIcon?.(emojiSheet.id, `emoji:${grapheme}`);
                        }
                        setEmojiSheet(null);
                    }}
                />
            )}

            {confirm === null ? null : (
                <ConfirmDialog
                    confirm={confirm}
                    onCancel={(suppress) => {
                        // macOS HIG (`WorkspaceDeleteGate.swift:78`): the suppression box is
                        // honoured whichever button ended the dialog, Cancel included.
                        if (suppress) props.onSuppressDeleteConfirm?.();
                        setConfirm(null);
                    }}
                    onConfirm={(cascade, suppress) => {
                        if (suppress) props.onSuppressDeleteConfirm?.();
                        if (confirm.kind === 'workspace') props.onDeleteWorkspace?.(confirm.id);
                        else if (confirm.kind === 'group') props.onDeleteGroup?.(confirm.id, cascade);
                        else if (props.onDeleteWorkspaces !== undefined) props.onDeleteWorkspaces(confirm.ids);
                        // No bulk callback wired: N single deletes still beat doing nothing.
                        else for (const id of confirm.ids) props.onDeleteWorkspace?.(id);
                        if (confirm.kind === 'workspaces') setSelection(EMPTY_SELECTION);
                        setConfirm(null);
                    }}
                />
            )}
        </div>
    );
}

// ── inline forms & dialogs ──────────────────────────────────────────────────────────

interface CustomEmojiSheetProps {
    /** M5: the group or workspace the icon is being set on — the sheet's title names it. */
    readonly subjectName?: string | undefined;
    readonly onSubmit: (grapheme: string) => void;
    readonly onCancel: () => void;
}

/**
 * §5.6's "Custom Emoji…" sheet (`GroupCustomEmojiSheet.swift`).
 *
 * Three rules, all of them the shipped sheet's:
 *
 *   - the field TRUNCATES to the first grapheme cluster as you type (§WS-072), so a ZWJ family
 *     or a flag survives whole and a pasted sentence collapses to its first character rather
 *     than sitting there refused;
 *   - that cluster still has to pass §WS-073's emoji heuristic — letters, digits and
 *     punctuation are rejected, and the same check runs again daemon-side (§WS-074);
 *   - the OS character palette has no browser equivalent, so the "Browse All Emoji…" button
 *     becomes the curated quick-pick grid below the field — one click fills it.
 *
 * M5 restored the three things the port had dropped: the sheet NAMES its subject
 * (`Custom Emoji for "<name>"`, `GroupCustomEmojiSheet.swift:24-25`), it carries the explanatory
 * caption under the title (`:27-31` — reworded only where it names a macOS-only gesture, since
 * ⌃⌘Space opens a palette this client cannot route into its field, and the grid below IS the
 * stand-in the sentence points at), and it is the Swift's 340pt wide rather than 280px.
 */
function CustomEmojiSheet(props: CustomEmojiSheetProps): ReactElement | null {
    const [value, setValue] = useState('');
    // §N26: a sheet, so the whole-window park — the same enrolment its sibling dialog takes.
    useModalPresence();
    const container = globalThis.document?.body;
    const normalized = normalizeEmojiInput(value);
    const subject = (props.subjectName ?? '').trim();
    const title = subject === '' ? 'Custom Emoji' : `Custom Emoji for “${subject}”`;
    const setTruncated = (next: string): void => {
        setValue(firstGrapheme(next) ?? '');
    };
    if (container === undefined || container === null) return null;

    return createPortal(
        <div
            data-testid="emoji-sheet"
            role="dialog"
            aria-label={title}
            /* SPACING-REVIEW S38: `.padding(20)` and `.frame(width: 340)`
               (`GroupCustomEmojiSheet.swift:75-76`) — `p-4` was 16, and the sibling New Workspace
               sheet in the same session already measures the correct 20. */
            className="fixed left-1/2 top-1/3 z-50 w-[340px] -translate-x-1/2 rounded-lg p-5 text-[12px]"
            style={{
                background: tokens.surfaceBackground,
                border: `1px solid ${tokens.divider}`,
                color: tokens.textPrimary,
                boxShadow: '0 16px 48px rgba(0,0,0,0.45)'
            }}
        >
            {/* S38: `VStack(alignment: .leading, spacing: 12)` (`GroupCustomEmojiSheet.swift:24`)
                — ONE spacing between every row. The port carried five different `mb-*` values
                (8 / 8 / 4 / 8 / 12), so the field sat closer to its hint than the hint to the
                grid, and nothing in the sheet shared a rhythm with anything else. */}
            <form
                className="flex flex-col gap-3"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (normalized !== null) props.onSubmit(normalized);
                }}
            >
                {/* `Text("Custom Emoji for \"…\"").font(.headline)` — the sheet's first row. */}
                <div data-testid="emoji-sheet-title" className="text-[13px] font-semibold">
                    {title}
                </div>
                {/*
                 * The Swift's caption (`GroupCustomEmojiSheet.swift:27-31`), which the port had
                 * dropped entirely — so the rejection message under the field was the only place
                 * the rules were ever stated, and only after the user had broken one. The ⌃⌘Space
                 * clause is the one divergence: that chord opens an OS palette whose selection
                 * this client cannot route into the field, and the grid below is the stand-in the
                 * Swift's own "or the button below" points at.
                 */}
                <div
                    data-testid="emoji-sheet-caption"
                    className="text-[11px]"
                    style={{ color: tokens.textSecondary }}
                >
                    Type or paste a single emoji or symbol. Use the grid below to browse. Letters,
                    digits, and punctuation are rejected.
                </div>
                {/* The port's own "Paste or type one emoji" label is gone with M5: it was the
                    stand-in for the missing title, and the caption above now says what it said,
                    in the Swift's own words. The field keeps its `aria-label`, which was always
                    its accessible name — the label was visual only. */}
                <input
                    id="nex-custom-emoji"
                    autoFocus
                    aria-label="Custom emoji"
                    data-testid="emoji-input"
                    placeholder="🔥"
                    className="w-full rounded border bg-transparent px-2 py-1 text-center text-[20px] outline-none"
                    style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                    value={value}
                    onChange={(event) => {
                        setTruncated(event.target.value);
                    }}
                    onKeyDown={(event) => {
                        if (event.key !== 'Escape') return;
                        event.stopPropagation();
                        props.onCancel();
                    }}
                />
                <div
                    data-testid="emoji-hint"
                    className="h-4 text-[10px]"
                    style={{ color: value.length > 0 && normalized === null ? '#E0655C' : tokens.textTertiary }}
                >
                    {value.length > 0 && normalized === null
                        ? 'Letters, digits and punctuation are not icons'
                        : ''}
                </div>
                {/* The OS character palette's stand-in: one click fills the field (§WS-072). */}
                <div
                    data-testid="emoji-browse"
                    /* S61: `gap-1.5` — two rows of 26.4 px cells only 4 px apart read as two
                       squashed strips; 6 px is the same step the sheet's own 12 px rhythm implies. */
                    className="grid grid-cols-6 gap-1.5"
                    role="group"
                    aria-label="Browse emoji"
                >
                    {CURATED_EMOJI.map((grapheme) => (
                        <button
                            key={grapheme}
                            type="button"
                            aria-label={`Use ${grapheme}`}
                            data-testid={`emoji-browse-${grapheme}`}
                            className="rounded py-0.5 text-[16px]"
                            style={{ background: value === grapheme ? tokens.selectionFill : 'transparent' }}
                            onClick={() => {
                                setTruncated(grapheme);
                            }}
                        >
                            {grapheme}
                        </button>
                    ))}
                </div>
                <div className="flex justify-end gap-2">
                    <button type="button" style={{ color: tokens.textSecondary }} onClick={props.onCancel}>
                        Cancel
                    </button>
                    <button
                        type="submit"
                        data-testid="emoji-submit"
                        disabled={normalized === null}
                        style={{ color: normalized === null ? tokens.textTertiary : tokens.accent }}
                    >
                        Set Icon
                    </button>
                </div>
            </form>
        </div>,
        container
    );
}

interface ConfirmDialogProps {
    readonly confirm: ConfirmState;
    readonly onCancel: (suppress: boolean) => void;
    readonly onConfirm: (cascade: boolean, suppress: boolean) => void;
}

/**
 * SPACING-REVIEW S52/S53 — the destructive-alert button recipe, shared with the quit dialog
 * (`QuitConfirmDialog.tsx:315`) and the graft swap prompt: AppKit's ~10 pt side gutter and its
 * ~68 pt minimum push-button width. Each caller supplies the border (a ring for the default,
 * `transparent` for the rest) and the label colour.
 */
const CONFIRM_ACTION_CLASS = 'min-w-[68px] rounded px-3 py-1';

function ConfirmDialog(props: ConfirmDialogProps): ReactElement | null {
    // Hooks before the container guard: a conditional early return above `useState` would make
    // the hook order depend on the DOM being present.
    const [suppress, setSuppress] = useState(false);
    /*
     * §N26 — the surface the owner photographed. This is the destructive confirmation the
     * workspace/group row menu raises, and it is the one modal H1's registry never enrolled:
     * `docs/audit/n26-popup-layering` caught it painted UNDER a live page, sliced at the pane's
     * edge exactly as run-O/53 caught the quit dialog. It is an app-modal alert (the Swift's
     * `WorkspaceDeleteGate` is `runModal()`), so it takes the whole-window park rather than the
     * per-rect one — the window behind it is not to be read while it is up.
     */
    useModalPresence();
    const container = globalThis.document?.body;
    if (container === undefined || container === null) return null;
    const isGroup = props.confirm.kind === 'group';
    const isBulk = props.confirm.kind === 'workspaces';
    const count = props.confirm.kind === 'workspaces' ? props.confirm.ids.length : 0;
    /**
     * §WS-068: the group prompt has TWO shapes, and which one it is depends on the membership
     * snapshotted when it was raised. An empty group is a one-button removal; a populated one
     * is a choice between two destructive outcomes, with the safer of them named in the message
     * — never a bare "Delete the group?" that hides what happens to the workspaces inside it.
     */
    const members = props.confirm.kind === 'group' ? props.confirm.memberCount : 0;
    const workspaceNoun = `workspace${members === 1 ? '' : 's'}`;
    /**
     * WS-108: a workspace with running agents gets `WorkspaceDeleteGate`'s alert instead of the
     * plain confirmation — the count in the message and a "Don't ask again" that writes the
     * daemon's `confirm-workspace-delete`. The caller has already applied the setting (0 when
     * it is off), so this only renders what it was handed.
     */
    const activeAgents = props.confirm.kind === 'workspace' ? (props.confirm.activeAgents ?? 0) : 0;
    const noun = activeAgents === 1 ? 'agent' : 'agents';
    const them = activeAgents === 1 ? 'it' : 'them';
    return createPortal(
        <div
            data-testid="confirm-dialog"
            data-active-agents={String(activeAgents)}
            role="dialog"
            aria-label={isGroup ? 'Delete group' : isBulk ? 'Delete workspaces' : 'Delete workspace'}
            className="fixed left-1/2 top-1/3 z-50 w-[320px] -translate-x-1/2 rounded-lg p-4 text-[12px]"
            style={{
                background: tokens.surfaceBackground,
                border: `1px solid ${tokens.divider}`,
                color: tokens.textPrimary,
                boxShadow: '0 16px 48px rgba(0,0,0,0.45)'
            }}
        >
            <div className="mb-3">
                {/* M10: `groupDeleteTitle` is `Delete "<name>"?` (`WorkspaceListView.swift:
                    859-863`) — the same shape as the workspace prompt below it, not a longer
                    sentence of its own. What the group prompt says EXTRA is the detail line, which
                    is where the membership consequence belongs. */}
                {props.confirm.kind === 'group'
                    ? `Delete “${props.confirm.name}”?`
                    : props.confirm.kind === 'workspace'
                      ? `Delete “${props.confirm.name}”?`
                      : `Delete ${String(count)} workspace${count === 1 ? '' : 's'}?`}
                {isGroup ? (
                    <div
                        data-testid="confirm-group-detail"
                        data-members={String(members)}
                        className="mt-1 text-[11px]"
                        style={{ color: tokens.textSecondary }}
                    >
                        {members === 0
                            ? 'This group is empty and will be removed.'
                            : `Choose whether to also delete the ${String(members)} ${workspaceNoun} inside this group. Moving them to the top level is the safer option.`}
                    </div>
                ) : null}
                {isBulk ? (
                    <div className="mt-1 text-[11px]" style={{ color: tokens.textSecondary }}>
                        This cannot be undone. Panes and surfaces in these workspaces will be closed.
                    </div>
                ) : null}
                {activeAgents > 0 ? (
                    <div
                        data-testid="confirm-active-agents"
                        className="mt-1 text-[11px]"
                        style={{ color: tokens.textSecondary }}
                    >
                        {`This workspace has ${String(activeAgents)} active ${noun}. Deleting it will terminate ${them}.`}
                    </div>
                ) : null}
            </div>
            {activeAgents > 0 ? (
                <label className="mb-3 flex items-center gap-2 text-[11px]" style={{ color: tokens.textSecondary }}>
                    <input
                        type="checkbox"
                        data-testid="confirm-suppress"
                        checked={suppress}
                        onChange={(event) => setSuppress(event.target.checked)}
                    />
                    Don&apos;t ask again
                </label>
            ) : null}
            {/*
             * SPACING-REVIEW S52 — three bare `<button>`s whose only styling was a colour read as
             * one paragraph of red text, not as two mutually exclusive destructive choices: all
             * three measured `padding: 0px`, both destructive labels wrapped to two lines, and
             * `WorkspaceListView.swift:170-195` puts them in a `.confirmationDialog`, i.e. AppKit
             * push buttons in an alert panel. `CONFIRM_ACTION_CLASS` is the quit dialog's own
             * recipe (S53), so the app's two destructive alerts are one family.
             *
             * `flex-col-reverse` when all three are up: at 320 px neither long label fits on a
             * shared row, and stacking is exactly what an `NSAlert` does with labels this long —
             * default at the top, Cancel at the bottom, which reversing the DOM order gives while
             * leaving the tab order (Cancel first) alone.
             */}
            <div
                data-testid="confirm-actions"
                className={
                    isGroup && members > 0
                        ? 'flex flex-col-reverse gap-3'
                        : 'flex flex-wrap justify-end gap-3'
                }
            >
                <button
                    type="button"
                    data-testid="confirm-cancel"
                    className={CONFIRM_ACTION_CLASS}
                    style={{ color: tokens.textSecondary, border: '1px solid transparent' }}
                    onClick={() => props.onCancel(suppress)}
                >
                    Cancel
                </button>
                {/*
                  * §WS-068: an EMPTY group offers one button, "Delete Group". A populated one
                  * offers both outcomes, both destructive: promote (the safer one the message
                  * recommends) and cascade, whose label carries the count so the button says
                  * what it is about to take with it.
                  */}
                {isGroup && members > 0 ? (
                    <button
                        type="button"
                        data-testid="confirm-delete-cascade"
                        className={CONFIRM_ACTION_CLASS}
                        style={{ color: '#E0655C', border: `1px solid ${tokens.divider}` }}
                        onClick={() => {
                            props.onConfirm(true, suppress);
                        }}
                    >
                        {`Delete Group and ${String(members)} ${workspaceNoun[0]?.toUpperCase() ?? ''}${workspaceNoun.slice(1)}`}
                    </button>
                ) : null}
                <button
                    type="button"
                    data-testid="confirm-delete"
                    className={CONFIRM_ACTION_CLASS}
                    style={{ color: '#E0655C', border: `1px solid ${tokens.divider}` }}
                    onClick={() => {
                        props.onConfirm(false, suppress);
                    }}
                >
                    {isGroup ? (members > 0 ? 'Move Workspaces to Top Level' : 'Delete Group') : 'Delete'}
                </button>
            </div>
        </div>,
        container
    );
}

const EMPTY_PRESETS: readonly ChromeLabelPreset[] = [];
const EMPTY_REPOS: readonly ChromeRepo[] = [];
const EMPTY_PROFILES: readonly string[] = [];
const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>();
const EMPTY_OVERRIDES: ReadonlyMap<string, boolean> = new Map<string, boolean>();
