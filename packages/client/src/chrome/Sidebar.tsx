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
import type { KeyBindingMap, NexAction } from '@nex/core/config';
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
    type ReactNode
} from 'react';
import { createPortal } from 'react-dom';

import { ContextMenu, menuAnchorFromEvent, type MenuItemSpec } from './ContextMenu';
import { RepoPicker } from './RepoPicker';
import {
    ChromeIcon,
    CURATED_EMOJI,
    CURATED_SYMBOL_ICONS,
    avatarLetter,
    iconGlyph,
    iconIsTintable,
    normalizeEmojiInput
} from './icons';
import { shortcutForAction } from './keys';
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
    type SidebarCallbacks,
    type WorkspaceWorktreeRequest
} from './types';
import { worktreePreview } from './worktree';

const DRAG_THRESHOLD_PX = 5;
const DEFAULT_ROW_HEIGHT = 34;
const CONTENT_TOP_PADDING = 4;

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
 * workspace AND group rename), the filter field, and `NewEntryForm`'s name / worktree-name /
 * branch-name fields. Checkboxes and `<select>`s have no text to select and are left alone.
 * The emoji sheet and the confirm dialog are `createPortal`'d onto `document.body`, so they are
 * outside the container and never inherit the rule in the first place.
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
/** Each item's own outer vertical padding; two adjacent items are twice this apart. */
export const ROW_OUTER_GAP_PX = 2;
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

function StatusDot({ counts }: { readonly counts: AgentCounts }): ReactElement | null {
    const color = statusDotColor(counts);
    if (color === null) return null;
    return (
        <span
            data-testid="status-dot"
            data-status={counts.waiting > 0 ? 'waiting' : 'running'}
            // §AGNT-103 / §AGNT-104: the dot PULSES (the Swift's repeating halo). The animation
            // lives in styles.css — it needs `@keyframes`, and it drops out under
            // `prefers-reduced-motion`; the two custom properties are what it interpolates, so
            // the halo is the status colour and the ring stays the sidebar's own background.
            className="nex-agent-dot-pulse absolute -right-[3px] -top-[3px] h-[9px] w-[9px] rounded-full"
            style={
                {
                    background: color,
                    boxShadow: `0 0 0 1.5px ${tokens.sidebarBackground}`,
                    '--nex-dot-ring': tokens.sidebarBackground,
                    '--nex-dot-halo': withAlpha(color, 0.55)
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
        <span className="relative inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[5px] text-[11px] font-semibold">
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
            <span
                className="relative"
                style={iconIsTintable(props.icon) || glyph === null ? { color: hex } : undefined}
            >
                {glyph ?? avatarLetter(props.name)}
            </span>
            <StatusDot counts={props.counts} />
        </span>
    );
}

interface LabelChipsProps {
    readonly labels: readonly string[];
    readonly presets: readonly ChromeLabelPreset[];
    readonly bucket: ChromeBucket;
}

/** §5.3: up to 3 chips + a `+N` overflow indicator. */
function LabelChips(props: LabelChipsProps): ReactElement | null {
    if (props.labels.length === 0) return null;
    const shown = props.labels.slice(0, 3);
    const overflow = props.labels.length - shown.length;
    return (
        <span className="mt-0.5 flex flex-wrap items-center gap-1">
            {shown.map((label) => {
                const style = resolveLabelStyle(label, props.presets, props.bucket);
                return (
                    <span
                        key={label}
                        data-testid="label-chip"
                        className="rounded-full px-[5px] py-px text-[9px] font-medium"
                        style={{ background: style.background, color: style.text }}
                    >
                        {label}
                    </span>
                );
            })}
            {overflow > 0 ? (
                <span className="text-[9px]" style={{ color: tokens.textTertiary }}>
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
    const counts = agentCounts([workspace]);
    const branch = workspace.panes.find((pane) => pane.gitBranch !== null)?.gitBranch ?? null;
    const paneCount = workspace.panes.length;

    /**
     * §WS-027: the two row states are a ZStack in the Swift, not a switch — a selected row that
     * is ALSO active draws both fills and both strokes, and reads brighter than either alone.
     * Here that is: the selection fill as the background COLOUR with the active tint layered
     * over it as a background image (two `rgba` fills cannot share one `background-color`), the
     * 1.5px accent as the `outline`, and the selection's 1px stroke at 0.7 opacity as an inset
     * ring — the same order the Swift paints them in, where the thicker accent lands last.
     */
    const activeFill = withAlpha(workspaceColorHex(workspace.color, props.bucket), 0.16);
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
    // One expression for the width, so the painted stroke and the offset derived from it below
    // cannot drift apart — only the colour still asks which state this is.
    const outline =
        ringWidth === null
            ? 'none'
            : `${String(ringWidth)}px solid ${props.active ? tokens.selectionStroke : withAlpha('#5276B8', 0.7)}`;
    /** The selection ring, kept when the accent outline takes the outer edge. */
    const selectionRing =
        props.active && props.selected
            ? `inset 0 0 0 ${String(ROW_SELECTION_RING_PX)}px ${withAlpha('#5276B8', 0.7)}`
            : null;

    const hidden = props.dragHidden === true;
    const nested = props.depth === 1 || props.nestPreview === true;
    const gap = props.gap === true;
    const style: CSSProperties = {
        background,
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
        ...(props.entering === true ? { animation: `${ROW_ENTER_ANIMATION} 350ms ${SPRING_EASING} both` } : {})
    };

    return (
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
            className="flex cursor-default items-center gap-2 px-2 py-1.5"
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
            <span className="flex min-w-0 flex-1 flex-col">
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
                <span
                    className="mt-0.5 flex items-center gap-1.5 text-[10px]"
                    style={{ color: tokens.textTertiary }}
                >
                    {branch === null ? null : (
                        <span className="flex min-w-0 items-center gap-0.5" data-testid="row-branch">
                            <ChromeIcon name="branch" size={9} />
                            <span className="truncate">{branch}</span>
                        </span>
                    )}
                    <span data-testid="row-pane-count">
                        {paneCount} {paneCount === 1 ? 'pane' : 'panes'}
                    </span>
                    {counts.running > 0 ? (
                        <span data-testid="row-running" style={{ color: tokens.statusRunning }}>
                            ● {counts.running}
                        </span>
                    ) : null}
                    {counts.waiting > 0 ? (
                        <span data-testid="row-waiting" style={{ color: tokens.statusWaiting }}>
                            ● {counts.waiting}
                        </span>
                    ) : null}
                </span>
                {props.groupCaption === null ? null : (
                    <span className="text-[10px]" style={{ color: tokens.textTertiary }}>
                        in {props.groupCaption}
                    </span>
                )}
            </span>
            {props.dragExtra !== undefined && props.dragExtra > 0 ? (
                <span
                    data-testid="drag-count"
                    className="shrink-0 rounded-full px-1.5 py-px text-[10px] font-semibold"
                    style={{ background: tokens.accent, color: '#fff' }}
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
            className="flex cursor-default items-center gap-2 px-2 py-1.5"
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
                background: props.dropPreview
                    ? withAlpha('#6F9BD8', 0.18)
                    : group.color === null
                      ? withAlpha('#8A8A92', 0.16)
                      // SET-038's "Group band fill". The stored `-1` sentinel is resolved to the
                      // appearance preset's band opacity before it reaches the variable, so the
                      // default here is the preset value the band has always used.
                      : tintedColor(hex, SIDEBAR_TINT_VARS.groupFill, 0.22),
                border: props.dropPreview
                    ? `1px solid ${tokens.accent}`
                    : `1px solid ${tintedColor(hex, SIDEBAR_TINT_VARS.groupStroke, 0)}`,
                // §WS-008: a header reorders (a whole group block moving) exactly like a row —
                // on the same FLIP spring, written to `translate`. What is left on `transform`
                // is the lift, as on a workspace row.
                transition: `transform ${String(REORDER_MS)}ms ${SPRING_EASING}`,
                ...(props.entering === true
                    ? { animation: `${ROW_ENTER_ANIMATION} 350ms ${SPRING_EASING} both` }
                    : {})
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
            <span className="relative inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center text-[12px]">
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
                        <ChromeIcon name="folder" size={13} filled={folderIcon === 'filled'} />
                    </span>
                )}
                <StatusDot counts={props.counts} />
            </span>
            <span className="min-w-0 flex-1">
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
                    <span className="truncate text-[13px] font-bold" style={{ color: tokens.textPrimary }}>
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
                    style={{ color: tokens.textSecondary }}
                    onClick={(event) => {
                        event.stopPropagation();
                        props.onToggle(group.id);
                    }}
                    onMouseDown={(event) => {
                        event.stopPropagation();
                    }}
                >
                    <ChromeIcon name={props.collapsed ? 'chevron-right' : 'chevron-down'} />
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
    /** Shortcut hints on the menu rows that have one; absent = no hints. */
    readonly keyBindings?: KeyBindingMap | undefined;
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
    | { readonly kind: 'background'; readonly x: number; readonly y: number };

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
    const rowElements = useRef(new Map<string, HTMLElement>());
    const dragRef = useRef<DragState | null>(null);
    /** A finished drag is followed by a `click` on the row; that click must not activate it. */
    const suppressClickRef = useRef(false);
    /** Removes the one-shot window listener that retires the flag above, if one is armed. */
    const retireSuppressRef = useRef<(() => void) | null>(null);
    const shadowRef = useRef<SidebarOrderModel | null>(null);
    /** Read by `onUp`, which runs from a window listener and cannot close over the render. */
    const springLoadedRef = useRef<string | null>(null);
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

        const fresh = rows.map((row) => row.key).filter((key) => !previous.keys.has(key));
        if (fresh.length > 0) {
            setEntering(new Set(fresh));
            if (enterTimerRef.current !== null) clearTimeout(enterTimerRef.current);
            enterTimerRef.current = setTimeout(() => {
                enterTimerRef.current = null;
                setEntering(EMPTY_SELECTION);
            }, REORDER_MS + 60);
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
        const to = revealScrollTop({
            scrollTop: list.scrollTop,
            viewportHeight: list.clientHeight,
            rowTop: element.offsetTop,
            rowHeight: element.offsetHeight,
            topInset: CONTENT_TOP_PADDING
        });
        if (to !== null) {
            cancelRevealRef.current?.();
            cancelRevealRef.current = animateScrollTop(list, to, { durationMs: revealMs });
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
     * ⌘N pressed twice re-opens the form the second time rather than being swallowed as a
     * no-change prop, and a re-render after the user cancels cannot bring it back. The form's
     * own autofocus does the rest: `NewEntryForm` focuses its name field on mount, so the
     * gesture lands the caret exactly where the shipped sheet does.
     */
    const createRequest = props.createRequest ?? null;
    const onCreateRequestHandled = props.onCreateRequestHandled;
    useEffect(() => {
        if (createRequest === null) return;
        setNewForm({ kind: createRequest.kind, groupID: createRequest.groupID ?? null });
        onCreateRequestHandled?.();
    }, [createRequest, onCreateRequestHandled]);

    // ── menus ───────────────────────────────────────────────────────────────────
    const closeMenu = useCallback((): void => {
        setMenu(null);
    }, []);

    const shortcut = useCallback(
        (action: NexAction): string | undefined =>
            props.keyBindings === undefined ? undefined : shortcutForAction(props.keyBindings, action),
        [props.keyBindings]
    );

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
                    label: color,
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
                    ...(shortcut('rename_workspace') === undefined
                        ? {}
                        : { shortcut: shortcut('rename_workspace') }),
                    onSelect: () => {
                        setRename({ kind: 'workspace', id: workspaceID });
                    }
                },
                {
                    id: 'icon',
                    label: 'Change Icon',
                    submenu: iconSubmenu('workspace', workspaceID, workspace.icon)
                },
                {
                    id: 'color',
                    label: 'Color',
                    submenu: WORKSPACE_COLORS.map((color) => ({
                        id: `color:${color}`,
                        label: color,
                        checked: workspace.color === color,
                        swatch: workspaceColorHex(color, bucket),
                        onSelect: () => {
                            props.onSetWorkspaceColor?.(workspaceID, color);
                        }
                    }))
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
            shortcut,
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
                    ...(shortcut('new_workspace') === undefined ? {} : { shortcut: shortcut('new_workspace') }),
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
                {
                    id: 'icon',
                    label: 'Change Icon',
                    submenu: iconSubmenu('group', groupID, group.icon)
                },
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
                                          label: color,
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
        [bucket, collapseOverrides, groups, iconSubmenu, props, shortcut, toggleCollapse]
    );

    const backgroundMenuItems = useCallback(
        (): MenuItemSpec[] => [
            {
                id: 'new-workspace',
                label: 'New Workspace',
                ...(shortcut('new_workspace') === undefined ? {} : { shortcut: shortcut('new_workspace') }),
                onSelect: () => {
                    setNewForm({ kind: 'workspace', groupID: null });
                }
            },
            {
                id: 'new-group',
                label: 'New Group',
                ...(shortcut('new_group') === undefined ? {} : { shortcut: shortcut('new_group') }),
                onSelect: () => {
                    setNewForm({ kind: 'group', groupID: null });
                }
            }
        ],
        [shortcut]
    );

    const menuItems = useMemo((): readonly MenuItemSpec[] => {
        if (menu === null) return [];
        // §WS-055: a right-click ON a row that belongs to a ≥2 selection is a BULK gesture.
        if (menu.kind === 'workspace' && selection.size > 1 && selection.has(menu.id)) return bulkMenuItems();
        if (menu.kind === 'workspace') return workspaceMenuItems(menu.id);
        if (menu.kind === 'group') return groupMenuItems(menu.id);
        return backgroundMenuItems();
    }, [backgroundMenuItems, bulkMenuItems, groupMenuItems, menu, selection, workspaceMenuItems]);

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
                    <div className="px-3 py-6 text-center text-[12px]" style={{ color: tokens.textTertiary }}>
                        <div style={{ color: tokens.textSecondary }}>No matches</div>
                        <div>Try a different filter or clear the field.</div>
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
                            />
                        );
                    }
                    if (row.kind === 'group-empty') {
                        return (
                            <div
                                key={row.key}
                                data-testid="group-empty"
                                data-reorder="spring"
                                className="ml-6 py-1.5 pl-2 text-[12px]"
                                style={{ color: tokens.textTertiary }}
                                onContextMenu={(event) => {
                                    onGroupContextMenu(row.groupID, event);
                                }}
                                ref={(element) => {
                                    registerRow(row.key, element);
                                }}
                            >
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
            <div className="p-2">
                <div
                    className="flex items-center gap-1.5 rounded-[10px] px-2 py-1"
                    style={{
                        background: withAlpha('#E6E6EA', 0.05),
                        border: `1px solid ${withAlpha('#E6E6EA', 0.08)}`
                    }}
                >
                    <span style={{ color: tokens.textTertiary }}>
                        <ChromeIcon name="search" />
                    </span>
                    <input
                        aria-label="Filter workspaces or labels"
                        placeholder="Filter workspaces or labels"
                        data-testid="sidebar-filter"
                        className="min-w-0 flex-1 bg-transparent text-[12px] outline-none"
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
                            style={{ color: tokens.textTertiary }}
                            onClick={() => {
                                props.onFilterChange('');
                            }}
                        >
                            <ChromeIcon name="clear" />
                        </button>
                    ) : null}
                </div>
            </div>

            {selection.size > 0 ? (
                <div
                    data-testid="selection-header"
                    className="flex items-center gap-2 px-3 py-1 text-[11px]"
                    style={{ background: withAlpha('#6F9BD8', 0.12), color: tokens.textSecondary }}
                >
                    <span className="flex-1">{selection.size} selected</span>
                    {/* §WS-043: "Select All" disappears once everything already IS selected —
                        a button whose only effect would be to do nothing. */}
                    {visibleOrder.every((id) => selection.has(id)) ? null : (
                        <button
                            type="button"
                            onClick={() => {
                                setSelection(new Set(visibleOrder));
                            }}
                        >
                            Select All
                        </button>
                    )}
                    <button
                        type="button"
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
                className="relative min-h-0 flex-1 overflow-y-auto px-2 pr-3"
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
                {body}
                <div className="h-8" data-testid="sidebar-spacer" />
            </div>

            <div
                /* The footer grows into the create form (§WS-075's swatches, pickers, repo rows
                   and worktree section), so it is capped at half the sidebar and scrolls rather
                   than pushing its own Create button off the bottom of the window. */
                className="flex max-h-[50%] shrink-0 flex-col gap-1 overflow-y-auto border-t p-2"
                style={{ borderColor: tokens.divider, background: tokens.sidebarBackground }}
            >
                {newForm === null ? (
                    <div className="flex items-center gap-2">
                        {/*
                          * ⌘N is New Workspace's shortcut, so it rides INSIDE that button. It
                          * used to sit `ml-auto` after "New Group", which reads as New Group's
                          * shortcut — the audit's nit list opened with it (run-B).
                          */}
                        <button
                            type="button"
                            data-testid="sidebar-new-workspace"
                            aria-label="New Workspace"
                            title="New Workspace (⌘N)"
                            className="flex items-center gap-1 text-[12px]"
                            style={{ color: tokens.textSecondary }}
                            onClick={() => {
                                setNewForm({ kind: 'workspace', groupID: null });
                            }}
                        >
                            <ChromeIcon name="plus" /> New Workspace
                            <span className="font-mono text-[10px]" style={{ color: tokens.textTertiary }}>
                                ⌘N
                            </span>
                        </button>
                        <button
                            type="button"
                            className="text-[12px]"
                            style={{ color: tokens.textSecondary }}
                            onClick={() => {
                                setNewForm({ kind: 'group', groupID: null });
                            }}
                        >
                            New Group
                        </button>
                        {props.onOpenSettings === undefined ? null : (
                            <button
                                type="button"
                                data-testid="sidebar-settings"
                                aria-label="Settings"
                                title="Settings (⌘,)"
                                className="ml-auto flex items-center"
                                style={{ color: tokens.textSecondary }}
                                onClick={() => {
                                    props.onOpenSettings?.();
                                }}
                            >
                                <ChromeIcon name="gear" />
                            </button>
                        )}
                    </div>
                ) : (
                    <NewEntryForm
                        kind={newForm.kind}
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
                            // §WS-079: a failed worktree create keeps the form open, inline.
                            if (typeof result === 'string') return result;
                            setNewForm(null);
                            return null;
                        }}
                    />
                )}
            </div>

            {menu === null ? null : (
                <ContextMenu
                    x={menu.x}
                    y={menu.y}
                    items={menuItems}
                    onClose={closeMenu}
                    label={menu.kind === 'group' ? 'Group menu' : 'Workspace menu'}
                />
            )}

            {emojiSheet === null ? null : (
                <CustomEmojiSheet
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

/** Everything the New Workspace / New Group form collects, in one submit (§WS-075/§WS-082). */
export interface NewEntryDraft {
    readonly name: string;
    /** `null` = the group form's "None" swatch; a workspace always carries a colour. */
    readonly color: WorkspaceColor | null;
    readonly groupID: string | null;
    /** `null` = the built-in `default` baseline, which the daemon normalizes to "unassigned". */
    readonly profile: string | null;
    /** Repo PATHS to associate once the workspace exists (§WS-075's Repositories section). */
    readonly repoPaths: readonly string[];
    readonly worktree?: WorkspaceWorktreeRequest | undefined;
}

interface NewEntryFormProps {
    readonly kind: 'workspace' | 'group';
    /** The registry: the Repositories section and the worktree section both read it. */
    readonly repos?: readonly ChromeRepo[] | undefined;
    /** Groups for the picker; empty hides it, exactly as the shipped sheet does. */
    readonly groups?: readonly ChromeGroup[] | undefined;
    /** Config-defined profile names. `default` leads the list and is never expected in it. */
    readonly profiles?: readonly string[] | undefined;
    /** The group the picker opens on: the menu's explicit one, else SET-011's inherited one. */
    readonly defaultGroupID?: string | null | undefined;
    /** The swatch the row opens on — `nextCreateColor`, which avoids the neighbour's colour. */
    readonly defaultColor?: WorkspaceColor | undefined;
    /** The group form's pre-filled unique default name ("New Group 2", §WS-083). */
    readonly defaultName?: string | undefined;
    /** Set when the bulk menu raised this form: "Group N selected workspace(s)." */
    readonly workspaceCount?: number | undefined;
    readonly onSubmit: (draft: NewEntryDraft) => Promise<string | null>;
    readonly onCancel: () => void;
}

/**
 * The footer's New Workspace / New Group form — `NewWorkspaceSheet.swift` and
 * `NewGroupSheet.swift`, in the shape this port gives them.
 *
 * Everything the two sheets collect is here: the name, the ten-colour swatch row opening on a
 * random colour that avoids the trailing workspace's (§WS-075), the Group picker (shown only
 * when groups exist, preselected by §WS-076's rule), the Profile picker leading with the
 * built-in `default` (§SET-214), the Repositories section that associates repos at create
 * (§WS-075) with §GIT-073's multi-select picker behind its Add button, and §WS-078's inline
 * **Create git worktree** section. The group form adds the bulk flow's "Group N selected
 * workspace(s)." line, a colour row with a "None" option, and a pre-filled unique default name
 * (§WS-082/§WS-083).
 *
 * §WS-077's Tab loop is driven by hand, for the reason the sheet drives its own: the colour row
 * is ONE stop (←/→ move within it) rather than ten, and a disabled Create is skipped rather
 * than landed on. §WS-080's rule is here too — removing a repo row moves focus to the next row
 * (or to Add Repository) BEFORE the array shrinks, so the loop is never stranded on a control
 * that no longer exists.
 *
 * Divergence from the shipped app, stated: this is an expanding inline form anchored to the
 * sidebar footer, not a modal sheet — the same divergence §WS-081's rename editor already
 * carries. Every field, rule and default is the sheet's.
 */
function NewEntryForm(props: NewEntryFormProps): ReactElement {
    const repos = props.repos ?? EMPTY_REPOS;
    const groups = props.groups ?? EMPTY_GROUPS;
    const profiles = props.profiles ?? EMPTY_PROFILES;
    const isWorkspace = props.kind === 'workspace';

    const [value, setValue] = useState(props.defaultName ?? '');
    const [color, setColor] = useState<WorkspaceColor | null>(
        // The group sheet opens on "None"; the workspace sheet opens on the random colour.
        isWorkspace ? (props.defaultColor ?? 'blue') : null
    );
    const [groupID, setGroupID] = useState<string | null>(props.defaultGroupID ?? null);
    const [profile, setProfile] = useState<string>(DEFAULT_PROFILE_NAME);
    const [chosenRepoIDs, setChosenRepoIDs] = useState<readonly string[]>(EMPTY_REPO_IDS);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [worktree, setWorktree] = useState(false);
    const [repoID, setRepoID] = useState<string>(repos[0]?.id ?? '');
    const [worktreeName, setWorktreeName] = useState('');
    const [branch, setBranch] = useState('');
    const [branchEdited, setBranchEdited] = useState(false);
    const [updateMain, setUpdateMain] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const ref = useRef<HTMLInputElement | null>(null);
    /** Every focusable stop, by field id — the Tab loop's address book (§WS-077). */
    const stops = useRef(new Map<string, HTMLElement>());
    const registerStop = (id: string, element: HTMLElement | null): void => {
        if (element === null) stops.current.delete(id);
        else stops.current.set(id, element);
    };

    useEffect(() => {
        ref.current?.focus();
        ref.current?.select();
    }, []);

    const chosenRepos = chosenRepoIDs.flatMap((id) => {
        const repo = repos.find((candidate) => candidate.id === id);
        return repo === undefined ? [] : [repo];
    });

    // §WS-078: the worktree is cut from the ONE selected repo when the Repositories section
    // named exactly one; otherwise the section offers the registry to choose from.
    const soleChosen = chosenRepos.length === 1 ? chosenRepos[0] : null;
    const repo = soleChosen ?? repos.find((candidate) => candidate.id === repoID) ?? repos[0] ?? null;
    const preview = worktreePreview({
        name: worktreeName,
        branch,
        base: repo?.worktreeBase ?? ''
    });
    const worktreeOn = isWorkspace && worktree && repo !== null;
    const canSubmit = value.trim() !== '' && !busy && (!worktreeOn || preview.valid);

    const submit = async (): Promise<void> => {
        if (!canSubmit) return;
        setBusy(true);
        setError(null);
        const failure = await props.onSubmit({
            name: value.trim(),
            color,
            groupID,
            profile: profile === DEFAULT_PROFILE_NAME ? null : profile,
            repoPaths: chosenRepos.map((entry) => entry.path),
            ...(worktreeOn && repo !== null
                ? { worktree: { repoID: repo.id, name: worktreeName, branch, updateMain } }
                : {})
        });
        setBusy(false);
        if (failure !== null) setError(failure);
    };

    /** Visible stops in reading order. A disabled Create is omitted, never landed on. */
    const fieldOrder = (): string[] => {
        const order = ['name', 'colors'];
        if (isWorkspace) {
            if (groups.length > 0) order.push('group');
            order.push('profile');
            if (repos.length > 0) {
                for (const entry of chosenRepos) order.push(`repo:${entry.id}`);
                order.push('add-repo');
                order.push('worktree-toggle');
                if (worktreeOn) order.push('worktree-name', 'worktree-branch', 'update-main');
            }
        }
        if (canSubmit) order.push('submit');
        return order;
    };

    const onFormKeyDown = (event: React.KeyboardEvent): void => {
        if (event.key !== 'Tab') return;
        const order = fieldOrder();
        const active = globalThis.document?.activeElement ?? null;
        const currentIndex = order.findIndex((id) => stops.current.get(id) === active);
        if (currentIndex < 0) return;
        event.preventDefault();
        const nextID = order[(currentIndex + (event.shiftKey ? -1 : 1) + order.length) % order.length];
        if (nextID !== undefined) stops.current.get(nextID)?.focus();
    };

    /**
     * §WS-080: focus the row that will take this one's place BEFORE the array shrinks, so the
     * Tab loop never points at a control that has just been unmounted.
     */
    const removeRepo = (id: string): void => {
        const index = chosenRepoIDs.indexOf(id);
        const next = chosenRepoIDs.filter((candidate) => candidate !== id);
        if (stops.current.get(`repo:${id}`) === globalThis.document?.activeElement) {
            const successor = next[index] ?? null;
            stops.current.get(successor === null ? 'add-repo' : `repo:${successor}`)?.focus();
        }
        setChosenRepoIDs(next);
    };

    const swatchRow = (
        <div
            ref={(element) => {
                registerStop('colors', element);
            }}
            role="radiogroup"
            aria-label={isWorkspace ? 'Workspace color' : 'Group color'}
            tabIndex={0}
            data-testid={`new-${props.kind}-colors`}
            className="flex items-center gap-1 rounded outline-none"
            onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                // The row is a single Tab stop with the arrows cycling inside it (§WS-077).
                const options: (WorkspaceColor | null)[] = isWorkspace
                    ? [...WORKSPACE_COLORS]
                    : [null, ...WORKSPACE_COLORS];
                const index = options.indexOf(color);
                const delta = event.key === 'ArrowRight' ? 1 : -1;
                const next = options[(index + delta + options.length) % options.length];
                setColor(next ?? null);
            }}
        >
            {isWorkspace ? null : (
                <button
                    type="button"
                    role="radio"
                    aria-checked={color === null}
                    aria-label="No color"
                    tabIndex={-1}
                    data-testid="new-group-color-none"
                    className="h-4 w-4 shrink-0 rounded-full text-[8px] leading-none"
                    style={{
                        border: `1px solid ${tokens.textTertiary}`,
                        color: tokens.textSecondary
                    }}
                    onClick={() => {
                        setColor(null);
                    }}
                >
                    {color === null ? '✓' : ''}
                </button>
            )}
            {WORKSPACE_COLORS.map((candidate) => (
                <button
                    key={candidate}
                    type="button"
                    role="radio"
                    aria-checked={color === candidate}
                    aria-label={candidate}
                    tabIndex={-1}
                    data-testid={`new-${props.kind}-color-${candidate}`}
                    data-selected={color === candidate ? 'true' : 'false'}
                    className="h-4 w-4 shrink-0 rounded-full"
                    style={{
                        background: workspaceColorHex(candidate, 'dark'),
                        outline: color === candidate ? `2px solid ${tokens.textPrimary}` : 'none',
                        outlineOffset: '1px'
                    }}
                    onClick={() => {
                        setColor(candidate);
                    }}
                />
            ))}
        </div>
    );

    return (
        <form
            data-testid={`new-${props.kind}-form`}
            className="flex flex-col gap-1"
            onKeyDown={onFormKeyDown}
            onSubmit={(event) => {
                event.preventDefault();
                void submit();
            }}
        >
            {props.workspaceCount === undefined ? null : (
                <div data-testid="new-group-count" className="text-[11px]" style={{ color: tokens.textSecondary }}>
                    Group {props.workspaceCount} selected workspace
                    {props.workspaceCount === 1 ? '' : 's'}.
                </div>
            )}
            <div className="flex items-center gap-1">
                <input
                    ref={(element) => {
                        ref.current = element;
                        registerStop('name', element);
                    }}
                    aria-label={isWorkspace ? 'New workspace name' : 'New group name'}
                    placeholder={isWorkspace ? 'Workspace name' : 'Group name'}
                    className="min-w-0 flex-1 rounded border bg-transparent px-1.5 py-1 text-[12px] outline-none"
                    style={{ borderColor: tokens.divider, color: tokens.textPrimary, ...SELECTABLE_TEXT_STYLE }}
                    value={value}
                    onChange={(event) => {
                        setValue(event.target.value);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                            event.stopPropagation();
                            props.onCancel();
                        }
                    }}
                />
                <button
                    ref={(element) => {
                        registerStop('submit', element);
                    }}
                    type="submit"
                    data-testid={`new-${props.kind}-submit`}
                    disabled={!canSubmit}
                    className="text-[12px]"
                    style={{ color: canSubmit ? tokens.accent : tokens.textTertiary }}
                >
                    {busy ? 'Creating…' : 'Create'}
                </button>
            </div>

            {swatchRow}

            {isWorkspace && groups.length > 0 ? (
                <select
                    ref={(element) => {
                        registerStop('group', element);
                    }}
                    aria-label="Group"
                    data-testid="new-workspace-group"
                    className="w-full rounded border bg-transparent px-1 py-[2px] text-[11px]"
                    style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                    value={groupID ?? ''}
                    onChange={(event) => {
                        setGroupID(event.target.value === '' ? null : event.target.value);
                    }}
                >
                    <option value="" style={{ color: '#000' }}>
                        No group
                    </option>
                    {groups.map((group) => (
                        <option key={group.id} value={group.id} style={{ color: '#000' }}>
                            {group.name}
                        </option>
                    ))}
                </select>
            ) : null}

            {isWorkspace ? (
                <select
                    ref={(element) => {
                        registerStop('profile', element);
                    }}
                    aria-label="Profile"
                    data-testid="new-workspace-profile"
                    className="w-full rounded border bg-transparent px-1 py-[2px] text-[11px]"
                    style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                    value={profile}
                    onChange={(event) => {
                        setProfile(event.target.value);
                    }}
                >
                    {/* The built-in baseline leads, then the config's own (§SET-214). */}
                    {[DEFAULT_PROFILE_NAME, ...profiles.filter((name) => name !== DEFAULT_PROFILE_NAME)].map(
                        (name) => (
                            <option key={name} value={name} style={{ color: '#000' }}>
                                {name}
                            </option>
                        )
                    )}
                </select>
            ) : null}

            {isWorkspace && repos.length > 0 ? (
                <div className="flex flex-col gap-1" data-testid="new-workspace-repos">
                    {chosenRepos.map((entry) => (
                        <div key={entry.id} className="flex items-center gap-1 text-[11px]">
                            <ChromeIcon name="folder" size={10} />
                            <span className="min-w-0 flex-1 truncate" style={{ color: tokens.textSecondary }}>
                                {entry.name}
                            </span>
                            <button
                                ref={(element) => {
                                    registerStop(`repo:${entry.id}`, element);
                                }}
                                type="button"
                                aria-label={`Remove ${entry.name}`}
                                data-testid={`new-workspace-repo-remove-${entry.id}`}
                                style={{ color: tokens.textTertiary }}
                                onClick={() => {
                                    removeRepo(entry.id);
                                }}
                            >
                                ✕
                            </button>
                        </div>
                    ))}
                    <button
                        ref={(element) => {
                            registerStop('add-repo', element);
                        }}
                        type="button"
                        data-testid="new-workspace-add-repo"
                        className="self-start text-[11px]"
                        style={{ color: tokens.accent }}
                        onClick={() => {
                            setPickerOpen(true);
                        }}
                    >
                        + Add Repository
                    </button>
                </div>
            ) : null}

            {isWorkspace && repos.length > 0 ? (
                <label className="flex cursor-pointer items-center gap-1.5 text-[11px]" style={{ color: tokens.textSecondary }}>
                    <input
                        ref={(element) => {
                            registerStop('worktree-toggle', element);
                        }}
                        type="checkbox"
                        data-testid="new-workspace-worktree-toggle"
                        checked={worktree}
                        onChange={(event) => {
                            setWorktree(event.target.checked);
                        }}
                    />
                    Create git worktree
                </label>
            ) : null}

            {worktreeOn && repo !== null ? (
                <div className="flex flex-col gap-1 pl-4" data-testid="new-workspace-worktree">
                    {soleChosen === null && repos.length > 1 ? (
                        <select
                            aria-label="Worktree repository"
                            data-testid="new-workspace-worktree-repo"
                            className="w-full rounded border bg-transparent px-1 py-[2px] text-[11px]"
                            style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                            value={repo.id}
                            onChange={(event) => {
                                setRepoID(event.target.value);
                            }}
                        >
                            {repos.map((candidate) => (
                                <option key={candidate.id} value={candidate.id} style={{ color: '#000' }}>
                                    {candidate.name}
                                </option>
                            ))}
                        </select>
                    ) : null}
                    <input
                        ref={(element) => {
                            registerStop('worktree-name', element);
                        }}
                        aria-label="Worktree name"
                        data-testid="new-workspace-worktree-name"
                        placeholder="Worktree name"
                        className="w-full rounded border bg-transparent px-1.5 py-1 text-[11px] outline-none"
                        style={{ borderColor: tokens.divider, color: tokens.textPrimary, ...SELECTABLE_TEXT_STYLE }}
                        value={worktreeName}
                        onChange={(event) => {
                            const next = event.target.value;
                            setWorktreeName(next);
                            if (!branchEdited) setBranch(next);
                        }}
                        onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                                event.stopPropagation();
                                props.onCancel();
                            }
                        }}
                    />
                    <input
                        ref={(element) => {
                            registerStop('worktree-branch', element);
                        }}
                        aria-label="Branch name"
                        data-testid="new-workspace-worktree-branch"
                        placeholder="Branch name"
                        className="w-full rounded border bg-transparent px-1.5 py-1 text-[11px] outline-none"
                        style={{ borderColor: tokens.divider, color: tokens.textPrimary, ...SELECTABLE_TEXT_STYLE }}
                        value={branch}
                        onChange={(event) => {
                            setBranch(event.target.value);
                            setBranchEdited(event.target.value !== worktreeName);
                        }}
                        onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                                event.stopPropagation();
                                props.onCancel();
                            }
                        }}
                    />
                    <label className="flex cursor-pointer items-center gap-1.5 text-[11px]" style={{ color: tokens.textSecondary }}>
                        <input
                            ref={(element) => {
                                registerStop('update-main', element);
                            }}
                            type="checkbox"
                            data-testid="new-workspace-worktree-update-main"
                            checked={updateMain}
                            onChange={(event) => {
                                setUpdateMain(event.target.checked);
                            }}
                        />
                        Update main first (fetch + branch off origin)
                    </label>
                    <div data-testid="new-workspace-worktree-preview" className="text-[10px]" style={{ color: tokens.textTertiary }}>
                        <div className="truncate">{preview.path}</div>
                        <div>{preview.branchLine}</div>
                    </div>
                </div>
            ) : null}

            {error === null ? null : (
                <div data-testid="new-workspace-error" className="text-[11px]" style={{ color: '#E0655C' }}>
                    {error}
                </div>
            )}

            {pickerOpen ? (
                <SheetOverlay testID="new-workspace-repo-picker" label="Add repositories">
                    <div className="mb-2 text-[13px] font-semibold">Add Repositories</div>
                    <RepoPicker
                        repos={repos}
                        mode="multiple"
                        disabledRepoIDs={new Set(chosenRepoIDs)}
                        onConfirm={(picked) => {
                            setChosenRepoIDs([...chosenRepoIDs, ...picked.map((entry) => entry.id)]);
                            setPickerOpen(false);
                        }}
                        onCancel={() => {
                            setPickerOpen(false);
                        }}
                    />
                </SheetOverlay>
            ) : null}
        </form>
    );
}

/** A centred portal panel — the emoji sheet's chrome, reused by the form's repo picker. */
function SheetOverlay(props: {
    readonly testID: string;
    readonly label: string;
    readonly children: ReactNode;
}): ReactElement | null {
    const container = globalThis.document?.body;
    if (container === undefined || container === null) return null;
    return createPortal(
        <div
            data-testid={props.testID}
            role="dialog"
            aria-label={props.label}
            className="fixed left-1/2 top-1/4 z-50 w-[320px] -translate-x-1/2 rounded-lg p-4 text-[12px]"
            style={{
                background: tokens.surfaceBackground,
                border: `1px solid ${tokens.divider}`,
                color: tokens.textPrimary,
                boxShadow: '0 16px 48px rgba(0,0,0,0.45)'
            }}
        >
            {props.children}
        </div>,
        container
    );
}

interface CustomEmojiSheetProps {
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
 */
function CustomEmojiSheet(props: CustomEmojiSheetProps): ReactElement | null {
    const [value, setValue] = useState('');
    const container = globalThis.document?.body;
    const normalized = normalizeEmojiInput(value);
    const setTruncated = (next: string): void => {
        setValue(firstGrapheme(next) ?? '');
    };
    if (container === undefined || container === null) return null;

    return createPortal(
        <div
            data-testid="emoji-sheet"
            role="dialog"
            aria-label="Custom emoji"
            className="fixed left-1/2 top-1/3 z-50 w-[280px] -translate-x-1/2 rounded-lg p-4 text-[12px]"
            style={{
                background: tokens.surfaceBackground,
                border: `1px solid ${tokens.divider}`,
                color: tokens.textPrimary,
                boxShadow: '0 16px 48px rgba(0,0,0,0.45)'
            }}
        >
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    if (normalized !== null) props.onSubmit(normalized);
                }}
            >
                <label className="mb-2 block" htmlFor="nex-custom-emoji">
                    Paste or type one emoji
                </label>
                <input
                    id="nex-custom-emoji"
                    autoFocus
                    aria-label="Custom emoji"
                    data-testid="emoji-input"
                    className="mb-1 w-full rounded border bg-transparent px-2 py-1 text-center text-[20px] outline-none"
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
                    className="mb-2 h-4 text-[10px]"
                    style={{ color: value.length > 0 && normalized === null ? '#E0655C' : tokens.textTertiary }}
                >
                    {value.length > 0 && normalized === null
                        ? 'Letters, digits and punctuation are not icons'
                        : ''}
                </div>
                {/* The OS character palette's stand-in: one click fills the field (§WS-072). */}
                <div
                    data-testid="emoji-browse"
                    className="mb-3 grid grid-cols-6 gap-1"
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

function ConfirmDialog(props: ConfirmDialogProps): ReactElement | null {
    // Hooks before the container guard: a conditional early return above `useState` would make
    // the hook order depend on the DOM being present.
    const [suppress, setSuppress] = useState(false);
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
                {props.confirm.kind === 'group'
                    ? `Delete the group “${props.confirm.name}”?`
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
            <div className="flex justify-end gap-2">
                <button
                    type="button"
                    data-testid="confirm-cancel"
                    style={{ color: tokens.textSecondary }}
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
                        style={{ color: '#E0655C' }}
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
                    style={{ color: '#E0655C' }}
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
const EMPTY_GROUPS: readonly ChromeGroup[] = [];
const EMPTY_PROFILES: readonly string[] = [];
const EMPTY_REPO_IDS: readonly string[] = [];
const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>();
const EMPTY_OVERRIDES: ReadonlyMap<string, boolean> = new Map<string, boolean>();
