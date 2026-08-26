/**
 * A web pane's body: the browser chrome, and the hole the page goes in (web-pane.md §16).
 *
 * The split this component embodies is the whole architecture of embedded web panes. The
 * **chrome** — URL bar, tab strip, back/forward/reload, dev tools — is ordinary DOM, drawn by
 * whichever client is looking, so it works in a browser on a phone exactly as it does on the
 * desktop. The **page** is not ours to draw at all: it lives in a native `WebContentsView` the
 * Electron shell owns, and the only thing this component can do about it is say where it is.
 *
 * So it measures its page area on every render and reports the rect (`./geometry.ts` throttles;
 * `daemon/src/webpane/HOST_PROTOCOL.md` §3.5 routes). In the shell window the shell moves the
 * real view there and the empty box is exactly covered; in any other client the same box holds
 * an honest "open in the Nex app" card, because nothing in a browser can render that page.
 *
 * Behaviour taken from §16.2 (the URL bar reconciliation, which is what makes the bar feel
 * right): the field shows the live URL, EXCEPT while the user is mid-edit — an incoming URL is
 * then parked and applied when editing ends, so a page that redirects under a half-typed
 * address does not eat the draft. Submitting sends the raw text; normalization is the daemon's
 * (§4.1), which is what keeps `example.com` working in the bar as it does on the CLI.
 */

import {
    memo,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type MouseEvent as ReactMouseEvent,
    type ReactElement
} from 'react';

import { overlayCovers, useOverlayRects } from '../chrome/modal-presence';
import { FOCUS_RING_WIDTH } from '../grid/FocusRing';
import { Icon } from '../grid/icons';
import { pill, tokens } from '../grid/tokens';
import { BatchPanel } from './BatchPanel';
import type { WebPaneCommands } from './commands';
import { BookmarksMenu, FavouriteStar } from './FavouritesMenu';
import type { GeometryRect, GeometryReport } from './geometry';
import { Glyph, GLYPH_STROKE_MEDIUM, GLYPH_STROKE_SEMIBOLD, type GlyphName } from './glyphs';
import { chromeTextIsFocused, WEB_CHROME_TEXT_ATTRIBUTE } from './priority';
import { useLoadProgress, type LoadProgressTimings } from './progress';
import type { BatchDestination, WebBatchSession, WebFavourite } from './state';
import { StoragePanel } from './StoragePanel';
import { WebFindBar } from './WebFindBar';

/** The tab fields the chrome renders; the daemon's `WebTab` satisfies it structurally. */
export interface WebPaneTab {
    readonly id: string;
    readonly url: string;
    readonly title?: string | null | undefined;
}

export interface WebPaneProps {
    readonly paneID: string;
    readonly tabs: readonly WebPaneTab[];
    readonly activeTabID: string | null;
    readonly isPrivate?: boolean | undefined;
    /** False when the grid is not showing this pane (zoom, workspace switch). */
    readonly visible?: boolean | undefined;
    readonly focused?: boolean | undefined;
    /**
     * True when this client is the page inside a Nex shell window, so a native view will cover
     * the page area. False (a plain browser) swaps in the "open in the app" card.
     */
    readonly embedded?: boolean | undefined;
    readonly commands: WebPaneCommands;
    /** Where the page area is; assembly throttles and puts it on the wire. */
    readonly onGeometry?: ((report: GeometryReport) => void) | undefined;
    /** The pane is no longer on screen: take the view back. */
    readonly onHidden?: ((paneID: string) => void) | undefined;
    readonly onFocusRequest?: ((paneID: string) => void) | undefined;
    /** Test seam: jsdom has no layout, so measurement is injectable. */
    readonly measure?: ((element: HTMLElement) => GeometryRect) | undefined;
    /** Test seam; production reads `window.devicePixelRatio`. */
    readonly devicePixelRatio?: number | undefined;

    // ── §10 find, §12 batch, §14 favourites ─────────────────────────────────
    /**
     * Bump to open the find bar from outside (the app's `toggle_search` binding), exactly like a
     * content pane's `findToken`. A repeat ⌘F re-focuses the field rather than toggling it shut.
     */
    readonly findToken?: number | undefined;
    /** Bump to move the caret into the URL bar (⌘L / `web_focus_url_bar`). */
    readonly focusURLToken?: number | undefined;
    /** The pane's live batch session, or null/absent when no batch is running. */
    readonly batch?: WebBatchSession | null | undefined;
    /** Other shell panes in this workspace, for the batch's destination picker (WEB-133). */
    readonly batchDestinations?: readonly BatchDestination[] | undefined;
    readonly favourites?: readonly WebFavourite[] | undefined;
    /** "Manage favourites…" — opens Settings on the Web tab (WEB-038). */
    readonly onManageFavourites?: (() => void) | undefined;

    // ── WEB-032/WEB-033: the active tab's live browser state ─────────────────
    /** The active tab is loading: the progress strip runs and the reload glyph becomes a stop. */
    readonly loading?: boolean | undefined;
    /** History availability, so Back/Forward dim when they would do nothing. */
    readonly canGoBack?: boolean | undefined;
    readonly canGoForward?: boolean | undefined;
    /** Test seam for WEB-033's 300 ms / 150 ms completion choreography. */
    readonly progressTimings?: LoadProgressTimings | undefined;
}

/** §17.2: the active tab always falls back to `tabs[0]` — every consumer shares the fallback. */
export function resolveActiveTab(
    tabs: readonly WebPaneTab[],
    activeTabID: string | null
): WebPaneTab | null {
    return tabs.find((tab) => tab.id === activeTabID) ?? tabs[0] ?? null;
}

/**
 * §5's `displayLabel`: title → **host** → url → "New Tab" (`WebPaneState.swift:18-23`).
 *
 * L70 — the host step was missing, so a tab that had not reported a title yet showed its whole
 * URL in a 180 px pill (`https://example.com/some/deep/path?q=1` truncated to nothing useful)
 * where the shipped app shows `example.com`. The daemon's `tabDisplayLabel`
 * (`daemon/src/store/reducers/web.ts`) has always had the host step — it is what the *pane
 * header* reads — so the pill and the header disagreed on the same tab. Same rule, same
 * capitalisation of the placeholder ("New Tab"), on both.
 */
export function tabLabel(tab: WebPaneTab): string {
    const title = tab.title ?? '';
    if (title.trim().length > 0) return title;
    const host = hostOf(tab.url);
    if (host !== '') return host;
    if (tab.url.length > 0) return tab.url;
    return 'New Tab';
}

function hostOf(url: string): string {
    if (url === '') return '';
    try {
        return new URL(url).hostname;
    } catch {
        return '';
    }
}

const EMPTY_FAVOURITES: readonly WebFavourite[] = [];
const EMPTY_DESTINATIONS: readonly BatchDestination[] = [];

function measureElement(element: HTMLElement): GeometryRect {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
}

/**
 * §N27 — reserve the focus ring's gutter on the three edges the page hole shares with it.
 *
 * `FocusRing` is `absolute inset-0` on the pane WRAPPER: a 2 px inner border around the whole
 * pane, header included (shell-ui.md §4.1). A web pane's page hole reaches that wrapper's left,
 * right and bottom edges exactly — measured live at ring `220,32 529×764` against hole
 * `220,91 529×705` — so on a focused LIVE web pane the ring's left, right and bottom strips are
 * underneath the native `WebContentsView` and only the top edge (beside the pane header) shows.
 *
 * Nothing in the DOM can cover a native view, so the ring cannot simply be drawn over it: the
 * hole has to shrink. This is the `BatchPanel` shape one step smaller — that panel already
 * shrinks the hole by being a sibling row rather than an overlay, for exactly this reason.
 *
 * **The inset is UNCONDITIONAL — the same rect focused or not (§N27a).** The first cut insetted
 * only while focused, which made every focus change a 4×2 px RESIZE of a live native view: the
 * owner clicks a web pane's header and watches the page visibly shrink and reflow. A resize is a
 * far louder defect than a 2 px margin, so the gutter is now reserved permanently: the ring
 * paints into it when the pane is focused, and the page hole's own `windowBackground` — the very
 * fill the pane chrome above it wears — paints there when it is not, reading as an ordinary
 * margin. **Focus therefore changes only what is PAINTED in the gutter, never any geometry.**
 *
 * The top is left alone because the header already holds it clear; moving `y` down would open a
 * band of pane background between the chrome and the page.
 *
 * **Stated divergence from Swift.** `WebPaneView`'s WKWebView is an AppKit subview in the same
 * window, so SwiftUI's border composites *over* it and the shipped app reserves nothing. A
 * DOM-under-native port has no such move — this 2 px gutter is the price of the architecture,
 * and paying it constantly is strictly cheaper than paying it on every focus change.
 */
export function insetHoleForFocusRing(rect: GeometryRect, ring: number = FOCUS_RING_WIDTH): GeometryRect {
    if (ring <= 0) return rect;
    // A hole too small to give up the strips keeps them: a zero- or negative-sized view would
    // be a worse defect than a clipped ring, and panes this small do not exist in practice.
    const horizontal = rect.w > ring * 2 ? ring : 0;
    const vertical = rect.h > ring ? ring : 0;
    if (horizontal === 0 && vertical === 0) return rect;
    return { x: rect.x + horizontal, y: rect.y, w: rect.w - horizontal * 2, h: rect.h - vertical };
}

// ── chrome glyphs ───────────────────────────────────────────────────────────────────

// The set moved to `./glyphs` so the pickup panel can draw the same `scope` crosshair its
// toolbar button does (§M37) without importing back through this module.

interface ChromeButtonProps {
    readonly testID: string;
    readonly label: string;
    readonly glyph: GlyphName;
    readonly disabled?: boolean | undefined;
    readonly active?: boolean | undefined;
    /**
     * WEB-039: a small count pinned to the button's corner. The scope button uses it for the
     * batch's pending items, panel open or shut (§M35) — the count is running feedback while
     * you pick, and it is what keeps a hidden batch from looking like no batch at all.
     */
    readonly badge?: number | undefined;
    /**
     * The click event is handed on, not swallowed: §M34's reload reads `altKey` off it to send
     * a cache-bypassing reload. Every other call site ignores the argument.
     */
    readonly onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

function ChromeButton(props: ChromeButtonProps): ReactElement {
    const disabled = props.disabled === true;
    const badge = props.badge ?? 0;
    return (
        <button
            type="button"
            data-testid={props.testID}
            aria-label={props.label}
            title={props.label}
            disabled={disabled}
            // The accent is a colour, and a colour is not a readable STATE from outside this
            // component. WEB-039 and WEB-040 both turn on "is this button lit?", so the flag is
            // published the way the tab pills publish theirs.
            data-active={props.active === true ? 'true' : 'false'}
            className="relative flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded"
            style={{
                color: props.active === true ? tokens.accent : tokens.textSecondary,
                // §16.1: an unavailable control is dimmed, not hidden — the row must not reflow.
                opacity: disabled ? 0.3 : 1,
                cursor: disabled ? 'default' : 'pointer'
            }}
            onClick={props.onClick}
        >
            {/*
             * L78 — an armed / open control is a HEAVIER glyph, not only an accent-coloured one.
             * `WebPaneChrome.swift:226,246` swap `.medium` for `.semibold` on the scope and the
             * padlock while they are lit; every port glyph was pinned at the medium stroke.
             */}
            <Glyph
                name={props.glyph}
                strokeWidth={props.active === true ? GLYPH_STROKE_SEMIBOLD : GLYPH_STROKE_MEDIUM}
            />
            {badge > 0 ? (
                <span
                    data-testid={`${props.testID}-badge`}
                    className="pointer-events-none absolute -right-[3px] -top-[2px] flex h-[11px] min-w-[11px] items-center justify-center rounded-full px-[2px] text-[8px] font-semibold leading-none"
                    style={{ background: tokens.accent, color: tokens.windowBackground }}
                >
                    {badge}
                </span>
            ) : null}
        </button>
    );
}

// ── the tab strip (WEB-016 / WEB-018) ───────────────────────────────────────────────

/**
 * WEB-018's gradient text mask.
 *
 * The close ✕ is revealed on hover (and always on the active pill), and it is drawn OVER the
 * label rather than beside it — a button that appears in the flow would widen the pill and
 * shove every tab beside it sideways on hover, which is the shuffle the Swift mask exists to
 * prevent. The label instead fades to nothing under the button's footprint, so the pill's own
 * width never changes.
 */
const TAB_LABEL_MASK = 'linear-gradient(to right, #000 0%, #000 82%, transparent 100%)';

interface TabPillProps {
    readonly tab: WebPaneTab;
    readonly active: boolean;
    readonly onSelect: () => void;
    readonly onClose: () => void;
}

function TabPill(props: TabPillProps): ReactElement {
    const { tab, active } = props;
    const [hovered, setHovered] = useState(false);
    // The Swift rule exactly: hover OR active. An inactive pill shows only its label.
    const showsClose = hovered || active;
    return (
        <div
            data-testid={`web-tab-${tab.id}`}
            data-active={active ? 'true' : 'false'}
            data-close-visible={showsClose ? 'true' : 'false'}
            className="relative flex max-w-[180px] shrink-0 items-center rounded"
            /*
             * L67 — the pill's two states, `WebPaneChrome.swift:331-341` exactly.
             *
             * An INACTIVE pill is `Color.secondary.opacity(0.08)` under a `Color.clear`
             * strokeBorder: a faint tint with no outline at all. The port gave it the opaque
             * `surfaceBackground` and a full `divider` rule, which drew every idle tab as a
             * bordered box and made the strip read as a row of buttons rather than one active
             * tab among quiet ones. The ACTIVE pill's border is `accent.opacity(0.4)`, not the
             * flat accent — the 18 % fill is what carries the state, and the outline only
             * outlines it.
             */
            style={{
                background: active ? pill(tokens.accent, 18) : pill(tokens.textSecondary, 8),
                border: `1px solid ${active ? pill(tokens.accent, 40) : 'transparent'}`
            }}
            onPointerEnter={() => setHovered(true)}
            onPointerLeave={() => setHovered(false)}
        >
            <button
                type="button"
                data-testid={`web-tab-select-${tab.id}`}
                title={tab.url}
                className="min-w-0 truncate px-2 py-[2px] font-mono text-[11px]"
                style={{
                    color: active ? tokens.textPrimary : tokens.textSecondary,
                    // The mask only exists while the ✕ is over the label; without it the last
                    // characters would sit under the button.
                    ...(showsClose
                        ? { maskImage: TAB_LABEL_MASK, WebkitMaskImage: TAB_LABEL_MASK }
                        : {})
                }}
                onClick={props.onSelect}
            >
                {tabLabel(tab)}
            </button>
            {showsClose ? (
                <button
                    type="button"
                    data-testid={`web-tab-close-${tab.id}`}
                    aria-label="Close tab (⌘W)"
                    title="Close tab (⌘W)"
                    className="absolute right-[3px] top-1/2 flex h-[14px] w-[14px] shrink-0 -translate-y-1/2 items-center justify-center rounded-full"
                    style={{ color: tokens.textPrimary, background: tokens.headerBackground }}
                    onClick={props.onClose}
                >
                    <Glyph name="close" size={9} />
                </button>
            ) : null}
        </div>
    );
}

// ── the pane ────────────────────────────────────────────────────────────────────────

export const WebPane = memo(function WebPane(props: WebPaneProps): ReactElement {
    const { paneID, tabs, activeTabID, commands } = props;
    const visible = props.visible !== false;
    const embedded = props.embedded === true;
    const measure = props.measure ?? measureElement;

    const active = useMemo(() => resolveActiveTab(tabs, activeTabID), [tabs, activeTabID]);
    const liveURL = active?.url ?? '';
    const batch = props.batch ?? null;
    const favourites = props.favourites ?? EMPTY_FAVOURITES;

    // §16.2: `lastWritten` is what WE put in the field; a difference from it means the user has
    // been typing, and an incoming URL must wait rather than overwrite the draft.
    const [draft, setDraft] = useState(liveURL);
    const [editing, setEditing] = useState(false);
    const lastWritten = useRef(liveURL);
    const pending = useRef<string | null>(null);

    useEffect(() => {
        if (editing && draft !== lastWritten.current) {
            // Mid-edit: park it. Applied on blur, so an abandoned draft does not stick around.
            pending.current = liveURL;
            return;
        }
        pending.current = null;
        lastWritten.current = liveURL;
        setDraft(liveURL);
    }, [liveURL, editing, draft]);

    const onBlur = useCallback(() => {
        setEditing(false);
        const parked = pending.current;
        pending.current = null;
        if (parked === null) return;
        lastWritten.current = parked;
        setDraft(parked);
    }, []);

    const submit = useCallback(() => {
        const value = draft.trim();
        if (value.length === 0) return;
        // Raw text: normalization is the daemon's (§4.1), the same code path the CLI uses.
        void commands.navigate(paneID, value);
        pending.current = null;
    }, [commands, draft, paneID]);

    // ── find, storage panel, ⌘L ─────────────────────────────────────────────────────

    const [findOpen, setFindOpen] = useState(false);
    const [storageOpen, setStorageOpen] = useState(false);
    const [batchDestination, setBatchDestination] = useState<string | null>(null);
    const urlRef = useRef<HTMLInputElement | null>(null);

    // §3.13's token pattern: a bump opens the bar and claims the caret; a repeat re-focuses it.
    const findToken = props.findToken ?? 0;
    const lastFindToken = useRef(findToken);
    useEffect(() => {
        if (findToken === lastFindToken.current) return;
        lastFindToken.current = findToken;
        setFindOpen(true);
    }, [findToken]);

    /**
     * ⌘L, and the bindable `web_focus_url_bar`: select the whole address, as a browser does.
     *
     * **Select-all belongs to the TOKEN, never to focus itself** (`WebPaneChrome.swift:469-503`):
     * the Swift runs `makeFirstResponder` + `selectAll` only inside `if coord.lastSeenToken !=
     * focusRequestToken`, so a ⌘L (or a blank tab's automatic focus) takes the whole address
     * while a plain click just places the caret where it landed. Selecting on every focus meant
     * clicking mid-URL to fix one character wiped the field.
     */
    const focusURLToken = props.focusURLToken ?? 0;
    const lastFocusToken = useRef(focusURLToken);
    useEffect(() => {
        if (focusURLToken === lastFocusToken.current) return;
        lastFocusToken.current = focusURLToken;
        const input = urlRef.current;
        if (input === null) return;
        // `focus()` fires `onFocus` (which only marks the field as editing); the selection is
        // applied here, after it, so the token is the one thing that can cause it.
        input.focus();
        input.select();
    }, [focusURLToken]);

    // ── WEB-033: the loading strip, and WEB-043's focus handoff ─────────────────────

    const loading = props.loading === true;
    const progress = useLoadProgress(loading, active?.id ?? null, props.progressTimings);

    /**
     * WEB-043: when the pane takes focus, the page takes the keyboard.
     *
     * The page is a separate renderer, so focus does not follow the client's own focus ring —
     * without this a pane focused by ⌘]/⌘[ or from the sidebar keeps typing into the client
     * until it is clicked. The URL-bar exemption is the whole subtlety and it is checked HERE
     * (never in the host): if a chrome text field has the caret, the page must not steal it,
     * which is exactly what the Swift `claimFirstResponder` guard's `firstResponder is NSText`
     * test did. Only the transition into focus fires — a re-render while focused must not
     * yank the caret back out of the URL bar mid-type.
     */
    const focused = props.focused === true;
    const wasFocused = useRef(focused);
    const liveTabID = active?.id ?? null;
    useEffect(() => {
        const gained = focused && !wasFocused.current;
        wasFocused.current = focused;
        if (!gained || !embedded || liveTabID === null) return;
        if (chromeTextIsFocused(typeof document === 'undefined' ? null : document.activeElement)) return;
        void commands.focusView(paneID, liveTabID);
    }, [focused, embedded, liveTabID, commands, paneID]);

    // ── geometry ────────────────────────────────────────────────────────────────────

    const pageRef = useRef<HTMLDivElement | null>(null);
    const onGeometry = props.onGeometry;
    const onHidden = props.onHidden;
    const dpr = props.devicePixelRatio;

    /**
     * §N26 — the floating surfaces that are over THIS pane's page area right now.
     *
     * `App.tsx`'s `modalOpen` is the whole-window half of the same rule (H1): a dialog owns the
     * window, so every page parks for it. A menu or a popover does not — it covers a box — so it
     * registers that box (`chrome/modal-presence.ts`) and only the panes it actually intersects
     * park. A rect that could not be measured covers everything, which is exactly H1's answer;
     * the precision can only remove a park it can prove is unnecessary.
     */
    const overlays = useOverlayRects();
    const [coveredByOverlay, setCoveredByOverlay] = useState(false);

    const publish = useCallback(() => {
        const element = pageRef.current;
        // Measured (and answered) BEFORE the `embedded` gate: "is this page covered" is a fact
        // about this document, and `data-visible` — what the audit and the unit tests read —
        // must state it whether or not this particular client has a native view to place.
        const rect = element === null ? null : measure(element);
        const covered = overlayCovers(rect, overlays);
        setCoveredByOverlay(covered);
        // A browser client has nothing to place: reporting from it would only be noise the
        // host has to reject (and it does, on `ownWindow`).
        if (!embedded) return;
        if (element === null || rect === null) return;
        if (!visible || covered) {
            onHidden?.(paneID);
            return;
        }
        onGeometry?.({
            paneID,
            tabID: active?.id ?? null,
            // §N27: the REPORTED rect shrinks for the focus ring; the DOM box does not move.
            // The hole element still fills the pane, so nothing in this document reflows — only
            // the native view is placed 2 px inside on the three edges it shares with the ring.
            // The inset does NOT read `focused` (§N27a): the gutter is reserved permanently, so
            // a focus change re-publishes a BYTE-IDENTICAL rect and never resizes the view.
            rect: insetHoleForFocusRing(rect),
            visible: true,
            devicePixelRatio:
                dpr ?? (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1
        });
        // `focused` is deliberately NOT a dependency (§N27a): nothing in the report depends on
        // it any more, so a focus change must not even re-identify this callback.
    }, [embedded, visible, paneID, active?.id, measure, onGeometry, onHidden, dpr, overlays]);

    // Layout effect, and deliberately with no dependency list: the grid re-renders a pane
    // whenever anything about the layout moves, so "after every render" IS the change signal.
    // Re-measuring is cheap and identical reports are dropped upstream.
    useLayoutEffect(() => {
        publish();
    });

    useEffect(() => {
        if (!embedded) return;
        const element = pageRef.current;
        const view = globalThis as {
            ResizeObserver?: new (callback: () => void) => { observe(target: Element): void; disconnect(): void };
            addEventListener?: (type: string, listener: () => void, options?: unknown) => void;
            removeEventListener?: (type: string, listener: () => void, options?: unknown) => void;
        };
        const observer =
            element !== null && view.ResizeObserver !== undefined ? new view.ResizeObserver(() => publish()) : null;
        observer?.observe(element as Element);
        const onWindowChange = (): void => publish();
        // A window resize or a scroll moves the hole without re-rendering this component.
        view.addEventListener?.('resize', onWindowChange);
        view.addEventListener?.('scroll', onWindowChange, true);
        return () => {
            observer?.disconnect();
            view.removeEventListener?.('resize', onWindowChange);
            view.removeEventListener?.('scroll', onWindowChange, true);
        };
    }, [embedded, publish]);

    // Unmount: the pane is gone from this client, so the view must go back to the holder. It is
    // its own effect (no deps) so React runs it exactly once, at teardown.
    useEffect(
        () => () => {
            onHidden?.(paneID);
        },
        [onHidden, paneID]
    );

    // ── render ──────────────────────────────────────────────────────────────────────

    /*
     * L77 — there is no drag-to-reorder gesture, because the shipped app has none.
     *
     * `WebPaneChrome.swift:311-377` gives a pill exactly one gesture, `.onTapGesture(perform:
     * onSelect)`, and `WorkspaceFeature.swift:1050-1062`'s `webPaneTabReorder` action has **no
     * call site anywhere in the app** — no view, no menu, no socket command reaches it. So the
     * port's pointer-drag (a 4 px threshold, a live preview order, a pill ghosted to 0.45 under
     * a `grabbing` cursor) was an affordance invented here, and it is gone.
     *
     * What stays is the wire: `web-tab-reorder` is still a daemon command with its
     * not-a-permutation guard, and `commands.reorderTabs` still binds it, so a client that wants
     * to move tabs can — the strip simply is not one.
     */
    const showTabs = tabs.length > 1;

    return (
        <div
            data-testid={`web-pane-${paneID}`}
            data-embedded={embedded ? 'true' : 'false'}
            className="flex h-full w-full flex-col overflow-hidden"
            style={{ background: tokens.windowBackground }}
            onPointerDown={() => props.onFocusRequest?.(paneID)}
        >
            {/*
             * The chrome BLOCK: the nav/URL row plus the tab strip, exactly as the Swift's
             * `VStack { navAndURLBar; tabStrip }` — because WEB-033's progress strip is an
             * overlay on the *bottom edge of the whole block*, and a strip drawn at the bottom
             * of the URL row alone would sit between the row and the tabs, reading as a divider.
             */}
            <div
                data-testid={`web-chrome-${paneID}`}
                className="relative shrink-0"
                /*
                 * M31: exactly ONE divider, and it belongs to the whole block rather than to
                 * either row inside it. `WebPaneChrome.swift:61-75` is
                 * `VStack { navAndURLBar; tabStrip }.background(headerBackground)
                 * .overlay(alignment: .bottom) { ZStack { Divider(); progressStrip } }` — one
                 * unbroken header fill with a single rule under it. Drawing the rule on the nav
                 * row instead put a seam between the URL bar and the tab strip that the shipped
                 * app never has, and only on multi-tab panes.
                 *
                 * (The progress strip above sits just *above* this border rather than over it:
                 * a CSS border is outside the absolutely-positioned box's containing block,
                 * where the Swift's ZStack draws the 2 pt bar on top of the 1 pt divider.)
                 */
                style={{ borderBottom: `1px solid ${tokens.divider}` }}
            >
                {progress.visible ? (
                    /*
                     * Out of the flow on purpose: a 2 px bar that appeared and disappeared IN
                     * the layout would move the page hole on every load, and the shell would
                     * re-place a native view for each frame of it.
                     */
                    <div
                        data-testid={`web-progress-${paneID}`}
                        data-phase={progress.phase}
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-[2px] overflow-hidden"
                        style={{ opacity: progress.phase === 'fading' ? 0 : 1, transition: 'opacity 300ms ease-in-out' }}
                    >
                        <div
                            data-testid={`web-progress-bar-${paneID}`}
                            className={progress.indeterminate ? 'nex-web-progress' : ''}
                            style={{
                                height: '100%',
                                background: tokens.accent,
                                // Determinate is only ever "done": the host has no fraction to
                                // report, so the completed state is the one real width there is.
                                width: progress.indeterminate ? '40%' : '100%'
                            }}
                        />
                    </div>
                ) : null}
                <div
                    /*
                     * L69 — `navAndURLBar` is `HStack(spacing: 6) { … }.padding(.horizontal, 8)
                     * .padding(.vertical, 4)` (`WebPaneChrome.swift:149, 219-220`). The port had
                     * it at 4 px / 6 px, which pulled the whole toolbar 2 px tighter than the
                     * shipped app on every gap and 2 px in at each end.
                     */
                    className="flex shrink-0 items-center gap-1.5 px-2 py-1"
                    // No border here — M31: the block's own bottom rule is the only one.
                    style={{ background: tokens.headerBackground }}
                >
                    <ChromeButton
                        testID={`web-back-${paneID}`}
                        label="Back (⌘←)"
                        glyph="back"
                        // WEB-032: dimmed, never hidden, and now driven by the host's real history
                        // report rather than by "does this pane have a tab at all".
                        disabled={active === null || props.canGoBack === false}
                        onClick={() => void commands.back(paneID)}
                    />
                    <ChromeButton
                        testID={`web-forward-${paneID}`}
                        label="Forward (⌘→)"
                        glyph="forward"
                        disabled={active === null || props.canGoForward === false}
                        onClick={() => void commands.forward(paneID)}
                    />
                    <ChromeButton
                        testID={`web-reload-${paneID}`}
                        // WEB-032: mid-load the button IS the stop button, and says so.
                        label={loading ? 'Stop loading (⌘R reloads)' : 'Reload (⌘R, ⌥-click bypasses the cache)'}
                        glyph={loading ? 'close' : 'reload'}
                        // L75: reload is NEVER disabled. `WebPaneChrome.swift:172-180` gives it a
                        // flat `.opacity(0.8)` and no `.disabled(…)` at all, where back/forward
                        // each carry one — so a tab-less pane dimmed a control the shipped app
                        // leaves live.
                        // M34: the tooltip has always promised the ⌥-click, and the verb has
                        // always taken `hard` — the handler simply never read the modifier, so
                        // the advertised gesture did nothing. It reads it now.
                        onClick={(event) =>
                            void (loading
                                ? commands.stop(paneID, active?.id ?? null)
                                : commands.reload(paneID, event.altKey))
                        }
                    />
                    <form
                        className="min-w-0 flex-1"
                        onSubmit={(event) => {
                            event.preventDefault();
                            submit();
                        }}
                    >
                        <div
                            className="flex w-full items-center gap-1 rounded pr-1"
                            /*
                             * The star sits INSIDE the field's border (§16.1), so the border is on
                             * this row rather than on the input itself.
                             *
                             * L66 — and it is ONE border in every mode. `WebPaneChrome.swift:
                             * 426-433` strokes the field with `Color.secondary.opacity(0.35)`
                             * unconditionally; a private pane is signalled by the padlock glyph
                             * alone. The port repainted it `#9B6BD6`, a hard-coded purple outside
                             * the token set that no theme or appearance swap could reach.
                             */
                            style={{
                                background: tokens.surfaceBackground,
                                border: `1px solid ${tokens.divider}`
                            }}
                        >
                            <input
                                ref={urlRef}
                                data-testid={`web-url-${paneID}`}
                                aria-label="URL"
                                placeholder="Enter URL"
                                spellCheck={false}
                                autoComplete="off"
                                // SET-190: while this has the caret, the priority layer defers
                                // ⌘←/⌘→ and ⌘⇧[ / ⌘⇧] so they move the cursor instead.
                                {...{ [WEB_CHROME_TEXT_ATTRIBUTE]: 'true' }}
                                className="min-w-0 flex-1 bg-transparent px-2 py-[3px] font-mono text-[11px] outline-none"
                                style={{ color: tokens.textPrimary }}
                                value={draft}
                                onChange={(event) => setDraft(event.target.value)}
                                // No `select()` here: a pointer-initiated focus leaves the caret
                                // where the click landed (H17 / `WebPaneChrome.swift:469-503`).
                                // The ⌘L / blank-tab token selects, in the effect above.
                                onFocus={() => setEditing(true)}
                                onBlur={onBlur}
                            />
                            <FavouriteStar
                                paneID={paneID}
                                url={liveURL}
                                title={active?.title ?? ''}
                                favourites={favourites}
                                onToggle={(url, title) => void commands.favouriteToggle(url, title)}
                            />
                        </div>
                    </form>
                    {/*
                     * L63 — bookmarks is a TOOLBAR BUTTON, outside the address field.
                     *
                     * `WebPaneChrome.swift:193` puts `bookmarksMenuButton` between the URL bar and
                     * "New tab" as a 22×22 `book` labelled "Bookmarks" — the same footprint as
                     * every other control in the row. The port had folded it into the field as a
                     * 16×20 `▾` caret beside the star, which both renamed it ("Favourites") and
                     * ate ~36 px of the address the field exists to show.
                     */}
                    <BookmarksMenu
                        paneID={paneID}
                        favourites={favourites}
                        onOpen={(url) => void commands.navigate(paneID, url)}
                        onManage={() => props.onManageFavourites?.()}
                    />
                    <ChromeButton
                        testID={`web-new-tab-${paneID}`}
                        label="New tab (⌘T)"
                        glyph="plus"
                        onClick={() => void commands.newTab(paneID)}
                    />
                    <ChromeButton
                        testID={`web-batch-toggle-${paneID}`}
                        // WEB-126's three-way, said out loud so the button explains itself; WEB-039's
                        // third state names the count, because "hidden batch with items" and "no
                        // batch" are otherwise the same button.
                        label={
                            batch === null
                                ? 'Start element pickup'
                                : batch.visible
                                  ? 'Hide element pickup'
                                  : batch.items.length === 0
                                    ? 'Show element pickup'
                                    : `Show element pickup (${String(batch.items.length)} item${batch.items.length === 1 ? '' : 's'} waiting)`
                        }
                        glyph="scope"
                        active={batch !== null && batch.visible}
                        // M35: badge whenever items exist, open panel or not.
                        // `WebPaneView.swift:114` passes `pendingItemCount: batchInspect?.items
                        // .count ?? 0` unconditionally, and `WebPaneChrome.swift:254-266` draws
                        // the capsule on `pendingItemCount > 0` alone — so picking gives running
                        // toolbar feedback while you pick. Suppressing it while the panel was
                        // visible meant the count only ever appeared after you hid the panel.
                        badge={batch?.items.length ?? 0}
                        disabled={active === null}
                        onClick={() => void commands.batchToggle(paneID)}
                    />
                    <ChromeButton
                        testID={`web-storage-toggle-${paneID}`}
                        // WEB-040: the glyph and the tooltip both distinguish the two modes — a
                        // private pane is a locked one, and the accent alone said too little.
                        label={
                            props.isPrivate === true
                                ? 'Private mode — cookies and site data are in-memory'
                                : 'Cookies and site data'
                        }
                        glyph={props.isPrivate === true ? 'lock' : 'lock-open'}
                        active={storageOpen || props.isPrivate === true}
                        onClick={() => setStorageOpen((current) => !current)}
                    />
                    <ChromeButton
                        testID={`web-devtools-${paneID}`}
                        label="Toggle developer tools"
                        glyph="code"
                        // Only the shell can open dev tools; in a browser the button would lie.
                        disabled={!embedded || active === null}
                        onClick={() => void commands.toggleDevTools(paneID, active?.id ?? null)}
                    />
                </div>

                {showTabs ? (
                    <div
                        data-testid={`web-tabs-${paneID}`}
                        /*
                         * L68 — `ScrollView(.horizontal, showsIndicators: false)` over an
                         * `HStack(spacing: 4).padding(.horizontal, 8).padding(.bottom, 4)`
                         * (`WebPaneChrome.swift:282-297`). Two things came across wrong: the
                         * global `*::-webkit-scrollbar` rule painted a 9 px bar under a strip the
                         * shipped app scrolls invisibly, and the padding was 6 px on the sides
                         * with 4 px on BOTH edges where the Swift has 8 px on the sides and 4 px
                         * on the bottom only (the nav row's own 4 pt supplies the gap above).
                         * `data-nex-web-tabstrip` hides the bar for this one element in
                         * `styles.css`; the global rule is untouched.
                         */
                        data-nex-web-tabstrip=""
                        className="flex shrink-0 items-center gap-1 overflow-x-auto px-2 pb-1"
                        // Same fill as the nav row, no rule between them (M31).
                        style={{ background: tokens.headerBackground }}
                    >
                        {tabs.map((tab) => (
                            <TabPill
                                key={tab.id}
                                tab={tab}
                                active={tab.id === active?.id}
                                onSelect={() => void commands.selectTab(paneID, tab.id)}
                                onClose={() => void commands.closeTab(paneID, tab.id)}
                            />
                        ))}
                    </div>
                ) : null}
            </div>

            {findOpen ? (
                <WebFindBar
                    paneID={paneID}
                    activeTabID={active?.id ?? null}
                    commands={commands}
                    onClose={() => setFindOpen(false)}
                />
            ) : null}

            {!storageOpen ? null : (
                <StoragePanel
                    paneID={paneID}
                    isPrivate={props.isPrivate === true}
                    commands={commands}
                    onClose={() => setStorageOpen(false)}
                />
            )}

            <div
                ref={pageRef}
                data-testid={`web-page-${paneID}`}
                // The pane's EFFECTIVE placement, so one attribute answers "is the page on
                // screen": `visible` is the assembly's (a modal, a hidden workspace) and
                // `coveredByOverlay` is §N26's per-pane half.
                data-visible={visible && !coveredByOverlay ? 'true' : 'false'}
                data-overlay-covered={coveredByOverlay ? 'true' : 'false'}
                className="relative min-h-0 flex-1 overflow-hidden"
                // Nothing is drawn here when embedded: the shell's native view covers this box
                // exactly, and anything underneath would only be visible while it catches up.
                style={{ background: tokens.windowBackground }}
            >
                {tabs.length === 0 ? (
                    <EmptyPaneNote paneID={paneID} />
                ) : embedded ? null : (
                    <PageNote
                        testID={`web-external-${paneID}`}
                        title="Open in the Nex app"
                        detail={`${liveURL || 'This page'} renders in the desktop app; this browser shows its chrome only.`}
                    />
                )}

            </div>

            {/*
             * The pickup panel is a ROW under the page area, not an overlay over it.
             *
             * The page is a native `WebContentsView` the shell composites on top of this
             * document — the same reason a modal has to park the view rather than draw over it
             * (see `modalOpen` in App.tsx). An absolutely-positioned panel inside the page hole
             * is therefore invisible: the audit run that found this shows two numbered badges in
             * the page and no panel anywhere. As a sibling it simply shrinks the hole, and the
             * next geometry report moves the view for us.
             */}
            {batch === null || !batch.visible ? null : (
                <BatchPanel
                    paneID={paneID}
                    session={batch}
                    activeTabID={active?.id ?? null}
                    destinations={props.batchDestinations ?? EMPTY_DESTINATIONS}
                    commands={commands}
                    destination={batchDestination}
                    onDestinationChange={setBatchDestination}
                />
            )}
        </div>
    );
});

/**
 * A pane with no tabs (M33 / WEB-042).
 *
 * `WebPaneView.swift:226-239` is a **bare centred stack** filling the pane —
 * `VStack(spacing: 8) { Image("globe").font(.system(size: 32)).foregroundStyle(.tertiary);
 * Text("New web pane").font(.callout).foregroundStyle(.secondary); Text("Type a URL above and
 * press Return").font(.caption).foregroundStyle(.tertiary) }`. No card, no border, no fill: the
 * port had it wearing `PageNote`'s bordered surface and had dropped the 32 pt globe entirely,
 * which turned the quietest screen in the app into a floating panel.
 *
 * The two type sizes are macOS's: `.callout` = 12 pt, `.caption` = 10 pt.
 *
 * `PageNote` stays a card for the "open in the Nex app" note below, which has no Swift
 * counterpart at all — it exists because a plain browser cannot draw the page, and a card is
 * what says "this box is not the page".
 */
function EmptyPaneNote({ paneID }: { readonly paneID: string }): ReactElement {
    return (
        <div className="flex h-full w-full items-center justify-center p-4">
            <div
                data-testid={`web-empty-${paneID}`}
                className="flex flex-col items-center gap-2 text-center"
                // The glyph is `.tertiary` and inherits it; only the title steps up.
                style={{ color: tokens.textTertiary }}
            >
                <Icon name="globe" size={32} />
                <span className="text-[12px]" style={{ color: tokens.textSecondary }}>
                    New web pane
                </span>
                <span className="text-[10px]" style={{ color: tokens.textTertiary }}>
                    Type a URL above and press Return
                </span>
            </div>
        </div>
    );
}

function PageNote(props: {
    readonly testID: string;
    readonly title: string;
    readonly detail: string;
}): ReactElement {
    return (
        <div className="flex h-full w-full items-center justify-center p-4">
            <div
                data-testid={props.testID}
                className="flex max-w-full flex-col items-center gap-1 rounded-lg px-5 py-4 text-center"
                style={{
                    background: tokens.surfaceBackground,
                    border: `1px solid ${tokens.divider}`,
                    color: tokens.textSecondary
                }}
            >
                <span className="text-[13px] font-medium" style={{ color: tokens.textPrimary }}>
                    {props.title}
                </span>
                <span className="max-w-[46ch] text-[11px]" style={{ color: tokens.textTertiary }}>
                    {props.detail}
                </span>
            </div>
        </div>
    );
}
