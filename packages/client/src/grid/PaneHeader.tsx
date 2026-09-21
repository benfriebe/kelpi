/**
 * The per-pane header bar (shell-ui.md §4.2).
 *
 * Left → right: type glyph / status dot, label chip, path or title, ZOOM badge, SYNC
 * badges, spacer, agent badge, git branch badge, per-type buttons, split buttons, close.
 * Focus is drawn by the pane's ring, never by the header itself.
 *
 * The component is `memo`ised and purely props-driven: agent activity mutates pane fields
 * every second (shell-ui.md §4.2 "Menu-stability requirement"), so nothing here may own
 * state that a tick would blow away — the only local state is the inline-rename draft, and
 * a tick cannot touch it because the header re-renders in place rather than remounting.
 *
 * ── What this file is, since the shared model (pane chrome phase A) ─────────────────
 *
 * It is the PAINTER, and only the painter. Every fact it draws comes out of one closure-free
 * `PaneChromeDescriptor` (`../pane-chrome/model.ts`) and every action it performs goes through one
 * `PaneChromeSurface` (`../pane-chrome/surface.ts`): the strings, the middle-truncation split, the
 * badge ladder, the overflow fold and the trailing control row are all model, and the props below
 * are the model's INPUT rather than eleven callbacks read straight out of the JSX. That is what
 * makes the header replaceable without making it different: the DOM, the class names and every
 * `data-testid` are unchanged, which the PaneHeader and grid suites assert unmodified.
 *
 * Three things stay host-drawn here by decision, and none of them is a fact a projection could
 * carry: the inline rename FIELD (the caret is the host's, `app/pane-focus.ts`), the `•••` and
 * context menus (portals with their own overlay registration), and the box another plugin's
 * `pane.header` items are rendered into as text (`plugins/contributions-ui.tsx`).
 *
 * The display functions this file used to own (`homeAbbreviated`, `basename`,
 * `splitHeaderTitle`, `paneDisplayTitle`, `agentBadge`, `headerChrome`, `badgeFit`,
 * `headerOverflowCount`) moved to `../pane-chrome/model.ts` unchanged and are re-exported below,
 * so every existing import of them still resolves here.
 */

import {
    memo,
    useEffect,
    useRef,
    useState,
    type KeyboardEvent,
    type MouseEvent,
    type PointerEvent,
    type ReactElement,
    type RefObject
} from 'react';

import { ContextMenu, type MenuItemSpec } from '../chrome/ContextMenu';
import {
    createPaneChromeSurface,
    paneChromeGlyph,
    paneChromeModel,
    paneChromeRow,
    usePaneChromeParking,
    usePaneChromeWithdrawal,
    usePublishedPaneChrome,
    type PaneChromeActions,
    type PaneChromeChanges,
    type PaneChromeControlDescriptor,
    type PaneChromeDescriptor,
    type PaneChromeItemDescriptor,
    type PaneChromeModel,
    type PaneChromeSurface
} from '../pane-chrome';

import { useSecondsTicker } from './elapsed';
import { Icon, type IconName, type IconWeight } from './icons';
import { pill, tokens } from './tokens';
import type { PaneActions, PaneModel } from './types';

export {
    BADGE_COST,
    HEADER_TAIL_MAX,
    agentBadge,
    badgeFit,
    basename,
    headerChrome,
    headerOverflowCount,
    homeAbbreviated,
    paneDisplayTitle,
    splitHeaderTitle,
    type AgentBadgeModel,
    type AgentBadgeTone,
    type BadgeFit,
    type BadgeFitInput,
    type OverflowFitInput,
    type TruncatedTitle
} from '../pane-chrome';

/**
 * Header content 20px + 2px vertical padding each side (shell-ui.md §4.2).
 *
 * The same number as `PANE_CHROME_LIMITS.nativeHeight`, which is where it is CLAMPED; this is
 * where it is painted. `pane-chrome/contract.test.ts` asserts the two never drift apart.
 */
export const PANE_HEADER_HEIGHT = 24;

/**
 * The path/title's flex-shrink weight (TERM-102/104).
 *
 * The Swift header was an `HStack` of fixed-size badges and buttons around one flexible
 * middle-truncating `Text`, so narrowing a pane ate the PATH and nothing else until there was
 * no path left. Flexbox has no notion of "shrink this one first", but it does share negative
 * space in proportion to `flex-shrink × flex-basis` — so a large weight here reproduces the
 * order: the title gives ground, then the user-data badges (label, agent, branch), and the
 * buttons never do.
 */
export const TITLE_SHRINK = 100;

/**
 * §S8 — the floor under a shrinkable badge's text, so a squeezed chip draws an ELLIPSIS and
 * never a colour stub.
 *
 * `2.5ch` is ~15 px at the badges' 10 px monospace: one glyph plus the ellipsis `truncate`
 * draws. Without it the inner `min-w-0 truncate` span is free to reach 0, and it does — at a
 * 130.75 px pane the label chip, the agent badge and the branch chip each measured **8.00 px
 * wide with 0.00 px of text**: three bare colour rectangles carrying no glyph and not even an
 * ellipsis, a state `PaneHeaderView.swift:80-92` cannot produce (SwiftUI overflows the header
 * and lets `PaneGridView.swift:354-355`'s `.clipped()` cut it, rather than compressing a chip).
 */
export const BADGE_TEXT_FLOOR = '2.5ch';

function statusDotColor(status: PaneModel['status']): string {
    switch (status) {
        case 'running':
            return tokens.statusRunning;
        case 'waitingForInput':
            return tokens.statusWaiting;
        case 'idle':
            return tokens.textTertiary;
    }
}

// ── pieces ──────────────────────────────────────────────────────────────────────────

interface BadgeProps {
    readonly testID: string;
    readonly color: string;
    /**
     * M14 — the pill fill, in percent. `PaneHeaderView.swift` draws **three** tones, not one:
     * the label chip / ZOOM / SYNC at 12 (`:91`, `:112`, `:137`), SYNC OFF and the branch chip
     * at 10 (`:153`, `:174`), the agent badge at 14 (`:329`, `:336`). The port had flattened all
     * six to `pill()`'s single 14%, which read the branch and SYNC OFF ~40% stronger than the
     * shipped app draws them. Required rather than defaulted, so a new badge has to state its
     * tone instead of silently inheriting the loudest one.
     */
    readonly fill: number;
    /**
     * M15 — `.medium` weight. The Swift gives it to the **fixed-word** badges only (ZOOM `:106`,
     * SYNC `:131`, SYNC OFF `:147`); the label, branch and agent badges carry user data and stay
     * at the regular weight (`:85`, `:168`, `:325`).
     */
    readonly strong?: boolean | undefined;
    /**
     * M15 — SYNC OFF's deliberate 9 pt (`:147`), one point below every other badge's 10. It is
     * how the dimmed "sync is on but this pane opted out" state reads as secondary rather than
     * as another live badge.
     */
    readonly small?: boolean | undefined;
    readonly icon?: IconName | undefined;
    /**
     * L28 — the glyph's point size. `PaneHeaderView.swift` draws the label chip's `tag.fill`,
     * ZOOM's arrows and both SYNC glyphs at **8** (`:83`, `:104`, `:129`, `:145`) and only the
     * branch's `arrow.triangle.branch` at 9 (`:166`). The port had flattened all five to 9.
     */
    readonly iconSize?: number | undefined;
    readonly text: string;
    readonly title?: string | undefined;
    /**
     * TERM-102/104's truncation priority: a badge whose text is USER data (a pane label, a
     * branch name, an agent line) may give ground as the header narrows, after the path has;
     * a fixed-word badge (ZOOM, SYNC) may not, because there is nothing to truncate.
     *
     * The order is enforced with flex-shrink *weights* rather than by hiding anything: the
     * title carries a shrink factor two orders of magnitude larger (see `TITLE_SHRINK`), so it
     * absorbs essentially all of the first squeeze and these only start to give when it has
     * run out. The buttons never shrink at all — a header that drops its close ✕ before its
     * path is the wrong trade.
     */
    readonly shrinkable?: boolean | undefined;
    readonly onClick?: (() => void) | undefined;
}

function Badge({
    testID,
    color,
    fill,
    strong,
    small,
    icon,
    iconSize = 8,
    text,
    title,
    shrinkable,
    onClick
}: BadgeProps): ReactElement {
    const content = (
        <>
            {/* §S8: `shrink-0`. Under the squeeze the glyph went to 0 px too, so what was left
                of a "chip" was its 4 px of side padding and nothing else. */}
            {icon === undefined ? null : <Icon name={icon} size={iconSize} className="shrink-0" />}
            <span
                className={shrinkable === true ? 'min-w-0 truncate' : undefined}
                // §S8: the floor. A shrinkable badge stops at one glyph plus the ellipsis
                // instead of collapsing to a colour stub; `badgeFit` decides whether it is
                // drawn at all, so the floor never costs the header a button.
                {...(shrinkable === true ? { style: { minWidth: BADGE_TEXT_FLOOR } } : {})}
            >
                {text}
            </span>
        </>
    );
    const style = {
        color,
        background: pill(color, fill),
        // M14: every badge in `PaneHeaderView.swift` is `RoundedRectangle(cornerRadius: 3)`.
        borderRadius: 3,
        ...(shrinkable === true ? { minWidth: 0, maxWidth: '40%' } : {})
    };
    // Both size classes are spelled out as literals: Tailwind scans SOURCE TEXT, so a class name
    // assembled from an interpolated number would never be generated.
    const sizeClass = small === true ? 'text-[9px]' : 'text-[10px]';
    const weightClass = strong === true ? ' font-medium' : '';
    // L28: `HStack(spacing: 2)` inside every badge (`PaneHeaderView.swift:81`, `:102`, `:127`,
    // `:143`, `:164`) — `gap-1` was 4 px, double the gap, which pushed each glyph off its text
    // far enough that the pill read as two things rather than one chip.
    // §S20: `leading-[1.2]`, not `leading-none`.
    //
    // `PaneHeaderView.swift:89-91` puts its 1 pt of vertical padding around a `Text` whose line
    // box already carries the ascender AND the descender, so the padding sits OUTSIDE the glyph
    // box. `leading-none` collapsed the line box to exactly the font size, which put the 1 px
    // inside it: the pill measured **12.00 px**, and on a real branch string (`gypsy/pg`) the
    // inner `truncate` span clipped the last pixel of the descender (`scrollHeight` 11 in a
    // 10 px content box). The register asks for `leading-none` to simply go, on the reading
    // that `normal` is ~12 px at 10 px — measured on the running app it is **14 px** for this
    // face, which would make the pill 16. `1.2` is the smallest line box that clears the
    // measured ink (ascent 7.29 + descent 2.15 = 9.44 px at 10 px) and it lands the pill on the
    // 14 px the row asks for, with SYNC OFF's deliberate 9 pt still a point shorter (12.8).
    const className = `flex ${shrinkable === true ? 'shrink' : 'shrink-0'} items-center gap-[2px] px-1 py-px font-mono ${sizeClass}${weightClass} leading-[1.2]`;
    if (onClick === undefined) {
        return (
            <span data-testid={testID} className={className} style={style} {...(title === undefined ? {} : { title })}>
                {content}
            </span>
        );
    }
    return (
        <button
            type="button"
            data-testid={testID}
            className={className}
            style={style}
            {...(title === undefined ? {} : { title })}
            // L33: the ZOOM badge is a `Button` in the Swift too (`PaneHeaderView.swift:101`), so
            // it consumes its own press — clicking it neither moves focus nor starts a pane drag.
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
                event.stopPropagation();
                onClick();
            }}
            // A SwiftUI `Button` consumes the whole tap, double taps included, so the header's
            // `.onTapGesture(count: 2)` never sees one that landed on the ZOOM badge. `dblclick`
            // is a separate native event from `click`, so stopping `click` is not enough here.
            onDoubleClick={(event) => event.stopPropagation()}
        >
            {content}
        </button>
    );
}

interface HeaderButtonProps {
    readonly testID: string;
    readonly label: string;
    readonly icon: IconName;
    /**
     * L25 — the glyph's point size. Every button in `PaneHeaderView.swift:177-273` is
     * `.font(.system(size: 10))` **except** close, which is deliberately
     * `.font(.system(size: 9, weight: .semibold))` (`:265`): smaller and bolder than the split
     * icons it sits beside, which is how a row of five same-sized glyphs still ends in a ✕ that
     * reads as the one destructive control.
     */
    readonly iconSize?: number | undefined;
    readonly iconWeight?: IconWeight | undefined;
    /** Dimmed and inert, but still in the row: a control that vanishes reflows the header. */
    readonly disabled?: boolean | undefined;
    /** §S40 — the `•••` needs its own box to anchor its menu under. */
    readonly buttonRef?: RefObject<HTMLButtonElement | null> | undefined;
    readonly expanded?: boolean | undefined;
    readonly onClick?: ((event: MouseEvent<HTMLButtonElement>) => void) | undefined;
}

function HeaderButton({
    testID,
    label,
    icon,
    iconSize = 10,
    iconWeight = 'regular',
    disabled,
    buttonRef,
    expanded,
    onClick
}: HeaderButtonProps): ReactElement {
    const off = disabled === true;
    return (
        <button
            type="button"
            {...(buttonRef === undefined ? {} : { ref: buttonRef })}
            data-testid={testID}
            aria-label={label}
            title={label}
            disabled={off}
            {...(expanded === undefined ? {} : { 'aria-haspopup': 'menu' as const, 'aria-expanded': expanded })}
            // L24: `.opacity(0.6)` and nothing else (`PaneHeaderView.swift:192`, `:205`, `:218`,
            // `:230`, `:241`, `:259`, `:271`) — the shipped header buttons carry no `.onHover`,
            // so they never brighten under the cursor. The port's `hover:opacity-100` was
            // invented chrome, and it is gone.
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded ${
                off ? 'opacity-25' : 'opacity-60'
            }`}
            style={{ color: tokens.textSecondary, cursor: off ? 'default' : 'pointer' }}
            onPointerDown={(event) => {
                // Never let a button press start a pane-move drag.
                event.stopPropagation();
            }}
            onClick={(event) => {
                event.stopPropagation();
                onClick?.(event);
            }}
            // The Swift header hangs `.onTapGesture(count: 2) { onToggleZoom }` off the HStack,
            // and every control inside it is a SwiftUI `Button`, which swallows its own taps —
            // so a double-click on Split Right there is two splits and NOTHING else. In the DOM
            // `dblclick` is a separate native event from `click`: stopping `click` leaves it
            // bubbling to the header's `onDoubleClick`, which is two splits *and* a zoom toggle.
            onDoubleClick={(event) => event.stopPropagation()}
        >
            <Icon name={icon} size={iconSize} weight={iconWeight} />
        </button>
    );
}

/**
 * The controls whose DRAWING is a fidelity metric rather than a default.
 *
 * `settings/FieldRenderer.tsx`'s `TEXT_PRESENTATION` keeps the same kind of table for the same
 * reason: "9 pt semibold" is not something a control MEANS, it is how this row draws it, so it
 * belongs beside the painting and not in a descriptor a presenter reads.
 *
 *   L25 - every button in `PaneHeaderView.swift:177-273` is `.font(.system(size: 10))` **except**
 *   close, which is deliberately `.font(.system(size: 9, weight: .semibold))` (`:265`): smaller
 *   and bolder than the split icons it sits beside, which is how a row of five same-sized glyphs
 *   still ends in a ✕ that reads as the one destructive control.
 *
 *   The globe is the one control with an alternate gesture: ⇧-click splits down instead of right.
 *   The `•••` row it becomes when it folds has no modifier to read, which is why the flag is on
 *   the CALL rather than on the control.
 */
const CONTROL_PRESENTATION: Readonly<
    Record<string, { readonly iconSize?: number; readonly iconWeight?: IconWeight; readonly alternate?: true }>
> = {
    close: { iconSize: 9, iconWeight: 'semibold' },
    'new-web': { alternate: true }
};

/** One control descriptor, drawn as one `HeaderButton` and run through the surface. */
function ControlButton({
    control,
    surface,
    paneID
}: {
    readonly control: PaneChromeControlDescriptor;
    readonly surface: PaneChromeSurface;
    readonly paneID: string;
}): ReactElement {
    const presentation = CONTROL_PRESENTATION[control.key] ?? {};
    return (
        <HeaderButton
            testID={control.testID}
            label={control.label}
            icon={control.icon}
            {...(presentation.iconSize === undefined ? {} : { iconSize: presentation.iconSize })}
            {...(presentation.iconWeight === undefined ? {} : { iconWeight: presentation.iconWeight })}
            disabled={!control.enabled}
            onClick={(event) =>
                surface.runControl(
                    paneID,
                    control.key,
                    presentation.alternate === true ? { alternate: event.shiftKey } : undefined
                )
            }
        />
    );
}

// ── the header ──────────────────────────────────────────────────────────────────────

export interface PaneHeaderProps extends PaneActions {
    readonly pane: PaneModel;
    readonly focused: boolean;
    /** Return the caret after keyboard completion removes the host's inline rename field. */
    readonly onReleaseChromeCaret?: ((paneID: string) => void) | undefined;
    /** This pane is the workspace's zoomed pane. */
    readonly zoomed?: boolean | undefined;
    /** The workspace has more than one pane, so the ZOOM badge is meaningful. */
    readonly zoomAvailable?: boolean | undefined;
    readonly syncActive?: boolean | undefined;
    readonly syncExcluded?: boolean | undefined;
    readonly homeDirectory?: string | undefined;
    /** Pins the elapsed clock (tests); omit to subscribe to the shared 1 s ticker. */
    readonly nowSeconds?: number | undefined;
    readonly height?: number | undefined;
    /**
     * §S8 — the pane's own width, which is the header's width (`w-full`). The grid already has
     * it as the pane's frame, so the header reads it rather than measuring itself: it is what
     * `badgeFit` uses to decide whether a user-data badge has room to be drawn at all. Omitted
     * (a standalone render) means "no ladder".
     */
    readonly paneWidth?: number | undefined;
    /**
     * Bumped to open the inline rename field from OUTSIDE the header — the context menu's
     * "Rename…" (TERM-106), which in the Swift app raised a sheet and here reuses the field
     * that is already the port's rename affordance (TERM-112's accepted divergence).
     *
     * A counter rather than a boolean, so asking twice in a row re-opens the field after the
     * first edit was committed.
     */
    readonly renameToken?: number | undefined;
    /**
     * Is this pane's chrome actually on screen?
     *
     * `PaneGrid` never unmounts a pane to hide it: a zoomed-out pane, and every pane of a
     * workspace the window is not showing, keeps its DOM at its last known rect under
     * `visibility: hidden`. That box is still what `getBoundingClientRect` reports, so a band that
     * enrolled itself in the overlay registry while invisible would park a web pane it cannot
     * possibly be covering. Nothing else in this component reads it, and it defaults to true, so a
     * standalone render behaves exactly as it always has.
     */
    readonly visible?: boolean | undefined;
    /**
     * Another plugin's `pane.header` ITEMS, as descriptors (ratified decision 7).
     *
     * The host still draws them itself, through `headerExtras`, and this changes nothing on
     * screen: the descriptors go into the model so the projection carries a pane's contributed
     * items rather than only the count of them, which is what lets a pane chrome presenter render
     * another plugin's extension point instead of deleting it. Omitted (every standalone render,
     * and every host that has not wired it) means an empty list.
     */
    readonly headerItems?: readonly PaneChromeItemDescriptor[] | undefined;
    /**
     * The working tree's change counts for this pane, as the status footer computes them
     * (`chrome/StatusFooter.tsx` ▸ `footerGitStats`, matched by working directory).
     *
     * It goes into the MODEL and therefore into a presenter's frame; the bundled header draws a
     * branch chip and no counts, exactly as it always has, so nothing on screen moves. Omitted
     * (every standalone render, and a host with no repository associations) means null.
     */
    readonly changes?: PaneChromeChanges | null | undefined;
    /**
     * A selected `pane.chrome` presenter is drawing this pane's header (phase B).
     *
     * The band itself is still the HOST's - it is the row `PaneGrid` lays the body out under, and
     * the fill, the hairline, the overlay enrolment and the pane-move drag all live on it - so what
     * stands down is the CONTENT: the glyph, the badges, the title, the contributions box and the
     * whole trailing control row, which the presenter is drawing over this band instead.
     *
     * The model is still built and still published (`pane-chrome/registry.ts`), because it is what
     * the presenter's frame is projected FROM: the frame a presenter receives is provably the
     * header that would otherwise have been drawn, rather than a second computation of it.
     *
     * The inline rename field is the exception and is drawn whoever is presenting - `PaneGrid`
     * stands the presenter's clip off a renaming pane, because the caret is the host's (decision 6).
     */
    readonly presented?: boolean | undefined;
    /** The grid's pane-move drag hook (shell-ui.md §4.3). */
    readonly onHeaderPointerDown?: ((paneID: string, event: PointerEvent<HTMLElement>) => void) | undefined;
}

function PaneHeaderImpl(props: PaneHeaderProps): ReactElement {
    /*
     * The props are the MODEL's input now, not a bag of verbs read from the JSX.
     *
     * Only the ones the model folds in, plus the three host-owned gestures, are destructured
     * here; every callback the controls used to close over goes to the surface through `latest`
     * below, untouched and un-renamed, so assembly binds exactly what it always bound.
     */
    const {
        pane,
        focused,
        zoomed = false,
        zoomAvailable = false,
        syncActive = false,
        syncExcluded = false,
        homeDirectory = '',
        nowSeconds,
        height = PANE_HEADER_HEIGHT,
        paneWidth,
        renameToken = 0,
        visible = true,
        presented = false,
        onHeaderPointerDown,
        onCopyDocument,
        onPaneContextMenu
    } = props;

    const running = pane.type === 'shell' && pane.agentSessionID !== null && pane.status === 'running';
    // Only a running agent with a known start time needs the clock; everything else is static.
    const wantsTick = running && pane.agentStartedAt !== null && nowSeconds === undefined;
    const ticked = useSecondsTicker(wantsTick);
    const now = nowSeconds ?? ticked;

    /*
     * §N26 / ratified decision 5 - a band taller than the native one over a web pane parks the page.
     *
     * At the native 24 px this registers nothing at all: `paneChromeParks` is false, the hook is
     * inert, and no web pane's geometry changes. It earns its keep only once something declares a
     * taller band, which nothing does in phase A. See `../pane-chrome/height.ts`.
     *
     * `visible` is the third argument and not an optimisation: a hidden pane keeps its DOM at its
     * last rect, so without it the band of a zoomed-out web pane sits inside the zoomed one's page
     * hole and parks it for the length of the zoom.
     */
    const headerRef = useRef<HTMLDivElement | null>(null);
    usePaneChromeParking(headerRef, pane.type, height, visible);
    // A declaration belongs to the view that made it, and this pane's chrome is going away.
    usePaneChromeWithdrawal(pane.id);

    // `null` = not renaming; a string is the live draft. Commit is idempotent, so the
    // blur that follows an Enter (or an unmount) can never fire the callback twice.
    const [renameDraft, setRenameDraft] = useState<string | null>(null);
    const renaming = renameDraft !== null;
    const returnRenameCaret = useRef(false);
    useEffect(() => {
        if (renaming || !returnRenameCaret.current) return;
        returnRenameCaret.current = false;
        // Enter/Escape remove the active input without a blur. Wait for that removal, then
        // use the host's existing handback (including native web focus and phone policy).
        // A blur commit never requests this, and a new owner or a lost pane focus wins.
        if (!focused || !visible || document.activeElement !== document.body) return;
        props.onReleaseChromeCaret?.(pane.id);
    }, [renaming, focused, visible, pane.id, props.onReleaseChromeCaret]);

    /*
     * §S40 — where the `•••` menu is open, if it is.
     *
     * State in this component is exactly what the file's own menu-stability rule allows: the
     * header re-renders IN PLACE on the per-second agent tick rather than remounting, so an
     * open menu survives it — and the menu itself is a `ContextMenu` portal, whose whole
     * reason for existing is that lifetime (shell-ui.md §15, macOS #124/#227).
     */
    const [overflowAt, setOverflowAt] = useState<{ x: number; y: number } | null>(null);
    const overflowRef = useRef<HTMLButtonElement | null>(null);

    // The context menu's "Rename…" is now the ONLY way in (M30 dropped the header's own pencil,
    // which the Swift never had): it reaches the field through a bumped token, and the effect
    // runs only on a CHANGE, so a re-render caused by an agent tick can never re-open it.
    const lastRenameToken = useRef(renameToken);
    useEffect(() => {
        if (renameToken === lastRenameToken.current) return;
        lastRenameToken.current = renameToken;
        if (renameToken > 0) setRenameDraft(pane.label ?? '');
    }, [renameToken, pane.label]);

    const commitRename = (): void => {
        if (renameDraft === null) return;
        setRenameDraft(null);
        // The surface owns the trim, and the field owns nothing but the draft (decision 6).
        surface.renamePane(pane.id, renameDraft);
    };

    const cancelRename = (): void => setRenameDraft(null);

    const onRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
        if (event.key === 'Enter' || event.key === 'Escape') {
            returnRenameCaret.current = document.activeElement === event.currentTarget;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            commitRename();
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            cancelRename();
        }
    };

    /*
     * The model. Everything below draws from `chrome` and acts through `surface`.
     *
     * `headerItems` is the single source for the contributions box: it decides whether there is
     * one, how many chips it reports, and therefore the four button-widths the width ladders are
     * charged for (`PaneHeader.tsx`'s original `headerExtras ? 4 : 0`) because the host cannot
     * measure what a plugin draws. `headerExtras` is the host's RENDERING of that same list, read
     * once here and drawn inside the box the descriptor names. A host that resolves the items
     * twice, or publishes one list and draws another, was the shape this replaced.
     */
    const headerExtras = props.headerExtras?.(pane.id);
    const model = paneChromeModel({
        pane,
        focused,
        zoomed,
        zoomAvailable,
        syncActive,
        syncExcluded,
        homeDirectory,
        nowSeconds: now,
        height,
        paneWidth,
        renaming,
        ...(props.headerCommands === undefined ? {} : { commands: props.headerCommands }),
        ...(props.headerItems === undefined ? {} : { items: props.headerItems }),
        ...(props.changes === undefined ? {} : { changes: props.changes }),
        canCopyDocument: onCopyDocument !== undefined
    });
    const chrome: PaneChromeDescriptor = model.descriptor;
    const { inline, overflow, pinned } = paneChromeRow(chrome);
    const glyph = paneChromeGlyph(chrome.kind);

    /*
     * The surface, created once and reading the latest render through a ref.
     *
     * The ref is `settings/surface.ts`'s indirection in miniature and exists for the same reason:
     * a surface rebuilt whenever a callback changed identity would hand every control a new
     * closure on every render, which is the shape this refactor exists to remove. The re-resolve
     * inside every call is what makes a click on a stale row refuse instead of running.
     *
     * Assigned during RENDER rather than from an effect, and deliberately: the model a call
     * re-resolves against has to be the model that is on screen, and an effect-written ref is one
     * commit behind on the frame that matters most - the first one. The last assignment is always
     * the render React kept, because an abandoned render is followed by the one that replaces it,
     * and every value in here is derived from props, so there is no state to lose either way.
     */
    const latest = useRef({ actions: props as PaneChromeActions, model, paneID: pane.id });
    latest.current = { actions: props as PaneChromeActions, model, paneID: pane.id };
    const surfaceRef = useRef<PaneChromeSurface | null>(null);
    if (surfaceRef.current === null) {
        surfaceRef.current = createPaneChromeSurface({
            actions: () => latest.current.actions,
            model: (paneID) => (paneID === latest.current.paneID ? latest.current.model : null)
        });
    }
    const surface = surfaceRef.current;

    /*
     * The model, published for whoever is drawing the bands.
     *
     * Unconditional, and deliberately: a header that published only while a presenter was selected
     * would leave the store empty on the commit the selection landed in, and every pane would spend
     * that commit with no header at all. `pane-chrome/registry.ts` compares by content and
     * `PaneGrid` subscribes only while a presenter is up, so the cost of publishing into an empty
     * room is one `JSON.stringify` of a few hundred bytes per header render.
     */
    usePublishedPaneChrome(chrome.paneID, { descriptor: chrome, surface });

    const fit = chrome.size.badges;
    const badge = chrome.agent;
    const titleParts = chrome.titleParts;

    const overflowItems: readonly MenuItemSpec[] = overflow.map((entry) => ({
        id: entry.key,
        // A `•••` row is the button it replaced: same label, same enablement, same call.
        disabled: entry.enabled ? undefined : true,
        label: entry.label,
        onSelect: () => surface.runControl(pane.id, entry.key)
    }));
    // §S40: widening the pane un-folds the row, and a menu anchored to a `•••` that is no longer
    // drawn would be a menu floating under nothing. `useDismissable` cannot see this — it
    // watches for clicks and Escape, not for the button disappearing out from under it.
    const overflowOpen = overflowAt !== null;
    useEffect(() => {
        if (overflowOpen && overflowItems.length === 0) setOverflowAt(null);
    }, [overflowOpen, overflowItems.length]);

    /*
     * §4.2 / phase B - the band stands down, and the band STAYS.
     *
     * A presenter draws over this row; it does not replace it. `PaneGrid` lays the body out under a
     * fixed-height header row, so removing the row would hand the body the whole pane and put the
     * presenter's own pixels over the terminal. What goes is everything the header PAINTS - the
     * glyph, the chips, the title, the spacer, the contributions box and the entire trailing
     * control row, each of which the presenter is drawing instead - and what stays is the box, its
     * fill, its hairline, its overlay enrolment, the pane-move drag and the focus-on-press.
     *
     * The test id is unchanged on purpose. `scripts/ui-audit/audit.mjs` counts panes and extracts
     * pane ids with `[data-testid^="pane-header-"]` in eleven places, so a band that renamed itself
     * while a presenter was selected would read as a window with no panes. `data-presented` is what
     * says who is painting, and the absence of `pane-title-…`, `pane-close-…` and the rest is what
     * says the native header is not.
     */
    if (presented && !chrome.renaming) {
        return (
            <div
                ref={headerRef}
                data-testid={`pane-header-${chrome.paneID}`}
                data-presented="true"
                data-focused={chrome.focused ? 'true' : 'false'}
                className="flex w-full shrink-0 select-none items-center"
                style={{
                    height: chrome.height,
                    background: tokens.headerBackground,
                    boxShadow: `inset 0 -1px 0 ${tokens.divider}`
                }}
                onPointerDown={(event) => {
                    // The presenter's frame covers all of this band but the focus ring's gutter and
                    // the hairline, so this fires for a press in those slivers - and for every band
                    // the presenter's clip does not reach. shell-ui.md §4.1 either way: clicking
                    // anywhere in a pane focuses it.
                    surface.focusPane(chrome.paneID);
                    onHeaderPointerDown?.(chrome.paneID, event);
                }}
                onContextMenu={(event) => {
                    if (onPaneContextMenu === undefined) return;
                    event.preventDefault();
                    surface.openPaneMenu(chrome.paneID, event);
                }}
            />
        );
    }

    return (
        <div
            ref={headerRef}
            data-testid={`pane-header-${chrome.paneID}`}
            data-presented="false"
            data-focused={chrome.focused ? 'true' : 'false'}
            // M17: `HStack(spacing: 4)` + `.padding(.horizontal, 8)` (`PaneHeaderView.swift:52,274`).
            // The port's `gap-1.5` was 6 px — 50% wider, across a button tail plus three or four
            // badges, which is why this header ran out of room sooner than the shipped one.
            className="flex w-full shrink-0 select-none items-center gap-1 px-2"
            style={{
                height: chrome.height,
                background: tokens.headerBackground,
                /*
                 * §S30 — the hairline is PAINTED, not laid out.
                 *
                 * `PaneHeaderView.swift:274-275` is `.padding(.vertical, 2)` → a 24 pt box, and
                 * `:297-299` draws the rule as an `.overlay(alignment: .bottom)`, which consumes
                 * no layout height. A `borderBottom` on a `border-box` element of `height: 24`
                 * does: the content band measured **23 px**, so the 20 px buttons sat 1.5 px
                 * above centre and 2.5 px below where the Swift's sit on 2 pt either side. An
                 * inset shadow paints the same 1 px on the same edge and costs the band nothing
                 * — measured 24.00 / 24.00 after, with the buttons at 2.0 / 2.0.
                 */
                boxShadow: `inset 0 -1px 0 ${tokens.divider}`,
                cursor: chrome.renaming ? 'text' : 'default'
            }}
            onPointerDown={(event) => {
                // shell-ui.md §4.1: clicking anywhere in a pane focuses it.
                surface.focusPane(chrome.paneID);
                if (chrome.renaming) return;
                // The pane-move drag is the GRID's gesture, raised from the header; it is not a
                // pane action and does not belong on the surface (see `surface.ts`'s header).
                onHeaderPointerDown?.(chrome.paneID, event);
            }}
            onDoubleClick={(event) => {
                if (chrome.renaming) return;
                event.preventDefault();
                surface.toggleZoom(chrome.paneID);
            }}
            onContextMenu={(event) => {
                if (onPaneContextMenu === undefined) return;
                event.preventDefault();
                surface.openPaneMenu(chrome.paneID, event);
            }}
        >
            {/* 1 — type glyph / status dot */}
            {glyph === null ? (
                <span
                    data-testid={`pane-status-dot-${chrome.paneID}`}
                    data-status={chrome.status}
                    className="h-2.5 w-2.5 shrink-0 rounded-full transition-colors duration-300"
                    style={{
                        background: statusDotColor(chrome.status),
                        opacity: chrome.status === 'idle' && !chrome.focused ? 0.5 : 1
                    }}
                />
            ) : (
                <span className="shrink-0" style={{ color: tokens.textSecondary }}>
                    <Icon name={glyph} size={10} />
                </span>
            )}

            {/* 2 — label chip (§S8: last of the three to go) */}
            {fit.label && chrome.label !== null ? (
                <Badge
                    testID={`pane-label-${chrome.paneID}`}
                    // M13: `PaneHeaderView.swift:88,91` is `Color.accentColor` — the macOS system
                    // accent, not the chrome theme's `accent`. See `tokens.ts` for the seam and
                    // the standing divergence.
                    color={tokens.systemAccent}
                    fill={12}
                    icon="tag"
                    text={chrome.label}
                    shrinkable
                />
            ) : null}

            {/* 3 — path / title, or the inline rename field */}
            {chrome.renaming ? (
                <input
                    data-testid={`pane-rename-input-${chrome.paneID}`}
                    aria-label="Pane name"
                    autoFocus
                    // `chrome.renaming` IS `renameDraft !== null` (the model was built from it),
                    // so the fallback is unreachable; it is here because the condition is now the
                    // descriptor's and the compiler can no longer see the two are the same fact.
                    value={renameDraft ?? ''}
                    className="min-w-0 flex-1 rounded px-1 font-mono text-[11px] leading-none outline-none"
                    style={{ background: tokens.surfaceBackground, color: tokens.textPrimary }}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onKeyDown={onRenameKeyDown}
                    onBlur={commitRename}
                    onPointerDown={(event) => event.stopPropagation()}
                />
            ) : (
                <span
                    data-testid={`pane-title-${chrome.paneID}`}
                    // M11 — no `flex-1`. The Swift's `Text(displayPath)` sizes to its content and
                    // the free space belongs to the `Spacer()` at `PaneHeaderView.swift:157`,
                    // AFTER the ZOOM and SYNC badges; a `flex-1` title absorbed every pixel of
                    // slack instead, which pushed ZOOM and SYNC out of the left cluster (where
                    // they hug the path) and over to the right one. Grow 0, shrink `TITLE_SHRINK`.
                    className="flex min-w-0 font-mono text-[11px] leading-none"
                    // TERM-102/104's truncation priority, expressed the only way flexbox can:
                    // negative space is shared out in proportion to (shrink factor × base size),
                    // so a title weighted `TITLE_SHRINK` against the badges' 1 takes effectively
                    // the whole squeeze first, and the badges only give when it has nothing left.
                    // The spacer below carries `flex-basis: 0`, so it contributes nothing to that
                    // share-out and cannot steal the squeeze from the title.
                    // L32: no `title=`. `PaneHeaderView.swift:94-98` is a bare `Text(displayPath)`
                    // with `.truncationMode(.middle)` and no `.help()`, so hovering a truncated
                    // path in the shipped app shows nothing at all. The native tooltip was a port
                    // invention — and a misleading one, since it was the ONLY header element that
                    // answered a hover, which implied the truncation was recoverable here and
                    // nowhere else. The full path is still in the status footer and the
                    // inspector, which is where the shipped app puts it.
                    style={{ color: chrome.focused ? tokens.textPrimary : tokens.textSecondary, flexShrink: TITLE_SHRINK }}
                >
                    <span className="min-w-0 truncate">{titleParts.head}</span>
                    {titleParts.tail === '' ? null : <span className="shrink-0">{titleParts.tail}</span>}
                </span>
            )}

            {/* 4 — ZOOM badge */}
            {chrome.zoom.zoomed && chrome.zoom.available ? (
                <Badge
                    testID={`pane-zoom-badge-${chrome.paneID}`}
                    // L27: `.orange` (`PaneHeaderView.swift:109,112`), as a token — the hex that
                    // was here was the only colour in the grid outside `--kelpi-*`, so it ignored
                    // the light/dark swap.
                    color={tokens.orange}
                    fill={12}
                    strong
                    icon="zoom"
                    text="ZOOM"
                    title="Toggle zoom"
                    onClick={() => surface.toggleZoom(chrome.paneID)}
                />
            ) : null}

            {/* 5 — SYNC badges */}
            {chrome.sync.active && !chrome.sync.excluded ? (
                <Badge
                    testID={`pane-sync-badge-${chrome.paneID}`}
                    // L27: `.orange` too (`PaneHeaderView.swift:134,137`) — the SAME orange as
                    // ZOOM. Painted with `--kelpi-agent` it was the agent amber, so a synced pane
                    // read as a pane with an agent running in it.
                    color={tokens.orange}
                    fill={12}
                    strong
                    icon="broadcast"
                    text="SYNC"
                    title="Synchronise input is on - keystrokes mirror to peer panes"
                />
            ) : null}
            {chrome.sync.active && chrome.sync.excluded ? (
                <Badge
                    testID={`pane-sync-off-badge-${chrome.paneID}`}
                    color={tokens.textTertiary}
                    fill={10}
                    strong
                    small
                    icon="broadcast-off"
                    text="SYNC OFF"
                    title="Excluded from the workspace sync group"
                />
            ) : null}

            {/* 6 — spacer.
                M11: `Spacer()` at `PaneHeaderView.swift:157`, and it is the reason ZOOM and SYNC
                belong to the LEFT cluster. `flex-1` here (basis 0) takes the slack the title no
                longer does, and contributes nothing to the negative-space share-out that decides
                the truncation order. It is skipped while the inline rename field is up: that
                field is `flex-1` too, and Swift has no counterpart to split the slack with, so
                the field keeps the whole run of the header exactly as it did before.

                The test id is deliberately NOT `pane-header-spacer-…`: the audit harness counts
                panes and extracts pane ids with `[data-testid^="pane-header-"]` in eleven places
                (`scripts/ui-audit/audit.mjs:530,533`), so a second element under that prefix would
                read as a second pane in every one of them. */}
            {chrome.renaming ? null : <div data-testid={`pane-spacer-${chrome.paneID}`} aria-hidden="true" className="flex-1" />}

            {/* 7 — agent badge (§S8: dropped before the label; the status dot keeps the state) */}
            {badge === null || !fit.agent ? null : (
                <Badge
                    testID={`pane-agent-badge-${chrome.paneID}`}
                    color={badge.tone === 'running' ? tokens.activeAgent : tokens.statusWaiting}
                    fill={14}
                    text={badge.text}
                    shrinkable
                />
            )}

            {/* 8 — git branch (§S8: first to go; the footer and the inspector both show it) */}
            {!fit.branch || chrome.branch === null ? null : (
                <Badge
                    testID={`pane-branch-${chrome.paneID}`}
                    color={tokens.textSecondary}
                    fill={10}
                    icon="branch"
                    // L28: the one badge glyph the Swift draws at 9 (`PaneHeaderView.swift:166`);
                    // the other four are 8.
                    iconSize={9}
                    text={chrome.branch}
                    shrinkable
                />
            )}

            {/* 9–13 — the trailing button row.
                The buttons themselves are declared as `tail` above (§S40 needs them as data so
                the fold has one list to read); what follows is the record of what is NOT in it
                and why, kept here where the row is drawn.

                M30: no `A−` / `A+` pair. `PaneHeaderView.swift:177-273` is the complete per-type
                block — markdown-copy, markdown-edit, diff-refresh — and the shipped app exposes
                preview font size ONLY through ⌘= / ⌘- / ⌘0. The pair existed here partly because
                a focused preview could not receive those chords (§H9); that reason expired when
                H9's chord relay landed — `content/bridge.ts` now posts a `focus` on any press
                inside the frame and replays every chord the binding map claims, and
                `increase/decrease/reset_markdown_font_size` are bound by default
                (`core/config/bindings.ts:68-70` → `App.tsx:2565-2567`). The capability itself is
                untouched: `PaneActions.onSetFontSize` and the `set-font-size` path stay, exactly
                as `onRestartAgent` does below. */}
            {/* §TERM-103: the Swift's header copy menu — markdown, preview mode only (there is
                no rendered document to copy while the editor is up). The menu is drawn by the
                content frame; this asks it to open. */}
            {/* No `.shell` branch, deliberately. `PaneHeaderView.swift:177-272`'s per-type block
                is markdown-copy / markdown-edit / diff-refresh and then the shared tail; the
                shipped app has no restart control anywhere (`grep -rn restartAgent Kelpi/` is
                empty), and a one-click restart of a live agent sitting between Split Down and
                Close is a mis-click nobody asked for. The capability itself stays: the
                `restart-pane-agent` verb, its daemon channel and `PaneActions.onRestartAgent`
                are untouched, so any client — or a later context-menu item — can still reach it. */}

            {/* M30: no rename button. `PaneHeaderView.swift:222-272` is split-right, split-down,
                globe, close and nothing else; the shipped app's rename lives in the header's
                CONTEXT menu (`:354-356`, "Rename…"), which the port already offers and drives
                through `renameToken`. The pencil also sat immediately beside the markdown
                edit-toggle's near-identical pencil, so the two glyphs read as one control
                repeated. The inline field itself is unchanged — it is still the port's rename
                affordance (TERM-112), just reached the way the Swift reaches it.

                §S40 (owner-directed): the row above the ✕ is `tail`, drawn from its prefix. At
                every width where the whole row fits this is the same JSX it always was, in the
                same order; below it the trailing entries become the `•••` menu instead, so the
                ✕ is the last control the pane loses rather than the first. */}
            {chrome.contributions === null ? null : <div className="flex min-w-0 max-w-[96px] shrink items-center overflow-hidden" data-testid={chrome.contributions.testID}>{headerExtras}</div>}
            {inline.map((entry) => (
                <ControlButton key={entry.key} control={entry} surface={surface} paneID={chrome.paneID} />
            ))}
            {overflowItems.length === 0 ? null : (
                <HeaderButton
                    buttonRef={overflowRef}
                    testID={`pane-overflow-${chrome.paneID}`}
                    label="More pane actions"
                    icon="ellipsis"
                    expanded={overflowAt !== null}
                    onClick={() => {
                        if (overflowAt !== null) {
                            setOverflowAt(null);
                            return;
                        }
                        // Anchored under the button the way a native menu drops. `ContextMenu`
                        // is a portal, so it needs viewport coordinates rather than a position
                        // inside this header — the same anchoring `chrome/TopBar.tsx`'s own
                        // ••• uses, and the same `ContextMenu` recipe, which means §N26's
                        // overlay registration (a web pane's native page parks while the menu
                        // is up) comes with it rather than being re-invented here.
                        const box = overflowRef.current?.getBoundingClientRect();
                        setOverflowAt(
                            box === undefined
                                ? { x: 8, y: 32 }
                                : { x: Math.round(box.left), y: Math.round(box.bottom + 4) }
                        );
                    }}
                />
            )}
            {/* The pinned tail: the ✕, and by construction only the ✕ (§S40). It is drawn from
                the same row the fold reads, so a control can never be pinned in the model and
                foldable on screen. L25 is in `CONTROL_PRESENTATION`: 9 pt semibold, the one
                button in the row that is not 10 pt regular. */}
            {pinned.map((entry) => (
                <ControlButton key={entry.key} control={entry} surface={surface} paneID={chrome.paneID} />
            ))}
            {overflowAt === null || overflowItems.length === 0 ? null : (
                <ContextMenu
                    x={overflowAt.x}
                    y={overflowAt.y}
                    items={overflowItems}
                    label="More pane actions"
                    onClose={() => setOverflowAt(null)}
                />
            )}
        </div>
    );
}

export const PaneHeader = memo(PaneHeaderImpl);
PaneHeader.displayName = 'PaneHeader';
