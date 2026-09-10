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
 * an honest "open in the Kelpi app" card, because nothing in a browser can render that page.
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

import { pill, tokens } from '../grid/tokens';
import { BatchPanel } from './BatchPanel';
import type { WebPaneCommands } from './commands';
import { BookmarksMenu, FavouriteStar } from './FavouritesMenu';
import type { GeometryRect, GeometryReport } from './geometry';
import { Glyph, GLYPH_STROKE_MEDIUM, GLYPH_STROKE_SEMIBOLD, type GlyphName } from './glyphs';
import { WebPageSurface } from './WebPageSurface';
export { insetHoleForFocusRing } from './WebPageSurface';
import { chromeTextIsFocused, releaseWebChromeCaret, WEB_CHROME_TEXT_ATTRIBUTE } from './priority';
import { useLoadProgress, type LoadProgressTimings } from './progress';
import type { BatchDestination, WebBatchSession, WebFavourite } from './state';
import { StoragePanel } from './StoragePanel';
import { WebFindBar } from './WebFindBar';

/** The tab fields the chrome renders; the daemon's `WebTab` satisfies it structurally. */
export interface WebPaneTab {
    readonly id: string;
    readonly url: string;
    readonly title?: string | null | undefined;
    /**
     * §5.2 / issue #76: `false` when the tab's renderer died and the host has no view for it.
     * **Absent means live**: the daemon only ever writes the flag to turn it off, so nothing
     * that has not crashed carries it.
     */
    readonly live?: boolean | null | undefined;
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
     * True when this client is the page inside a Kelpi shell window, so a native view will cover
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

// ── chrome glyphs ───────────────────────────────────────────────────────────────────

// The set moved to `./glyphs` so the pickup panel can draw the same `scope` crosshair its
// toolbar button does (§M37) without importing back through this module.

// ── §S43: the nav row's fit ─────────────────────────────────────────────────────────

/** `h-[22px] w-[22px]` on every `ChromeButton` (`WebPaneChrome.swift:149-218`'s fixed frames). */
export const WEB_CHROME_BUTTON_PX = 22;
/** `gap-1.5` on the nav row — the Swift's `HStack(spacing: 6)`. */
export const WEB_CHROME_GAP_PX = 6;
/** §S43's floor for the address, so it stops being a stub while the row still has room. */
export const WEB_URL_MIN_WIDTH_PX = 60;
/** The three the row never sheds: back / forward / reload. */
const WEB_CHROME_FIXED_BUTTONS = 3;
/** Bookmarks, new-tab, storage, scope, dev tools — the row's other five. */
const WEB_CHROME_SHEDDABLE = 5;

export interface WebChromeFit {
    /** Draw the dev-tools button. */
    readonly devtools: boolean;
    /** Draw the element-pickup (scope) button. */
    readonly scope: boolean;
    /** The URL form's `min-width`, in px — 60 while the row can seat it, 0 once it cannot. */
    readonly urlMinWidth: number;
}

/**
 * §S43 — what a nav row this wide can carry (OWNER-DIRECTED divergence from
 * `WebPaneChrome.swift:149-218`, taken 2026-08-29).
 *
 * The Swift's row is an `HStack(spacing: 6)` of fixed-frame 22 × 22 buttons around a
 * `WebURLBar().frame(maxWidth: .infinity)`, with **no minimum on the bar and no overflow
 * affordance either**; the port transcribed it exactly (`min-w-0 flex-1` on the form, `shrink-0`
 * on every button), so the row is parity rather than drift. What that produces in a split is an
 * address that starves long before the row runs out of room, and then a row that overruns the
 * pane anyway: measured, a 529 px pane gave the URL input 259 px, **a 339 px pane gave it 69,
 * and a 239 px pane gave it 16 while the row ALREADY overflowed its content box by 1 px**; at
 * 169 px the overflow was 71 — the scope button sliced in half, storage and dev tools entirely
 * outside a pane that is `overflow-hidden`.
 *
 * Two rules, in this order:
 *
 *  1. **The address keeps 60 px** — enough to read a host — instead of collapsing to a stub.
 *  2. **Dev tools, then element pickup, are SHED** to pay for it: removed from the row, not
 *     folded into an overflow. They are the two the register names, and they are the two whose
 *     verbs are pane-addressed and stateless, so both keep a route in the pane header's context
 *     menu (`App.tsx` ▸ `paneMenuItems` adds them for every web pane, at every width) and
 *     neither can become silently unreachable.
 *
 * …and one release, which measurement forced and the register did not anticipate: **once both
 * have been shed and the row STILL cannot seat a 60 px address, the floor goes back to 0.** A
 * hard 60 px minimum is a net regression at the narrow end — at the register's own 169 px pane
 * it would take the row's overflow from 71 px to 75, because the floor adds 60 px where the
 * form used to give up everything while the two sheds return only 56. With the release the row
 * overflows by 15 px at 169 and not at all at 239, where the address is 55 px.
 *
 * The ladder deliberately stops at those two. Storage, bookmarks and new-tab are NOT shed: the
 * storage panel's open state lives inside this component, so a menu route for it would mean
 * hoisting that state out of the pane, and shedding a control with no route is the one thing
 * this row forbids. Below ~184 px of pane the row therefore still overflows — less than a
 * quarter as far as it did, and strictly less at every width measured.
 *
 * Owner-directed: do not re-report. The parity values are no minimum on the URL bar, and every
 * button drawn unconditionally.
 *
 * @param contentWidth the row's own content box (its `px-2` already subtracted), or null when
 *                     nothing has measured it yet — which draws everything, the pre-S43 row.
 */
export function webChromeFit(contentWidth: number | null): WebChromeFit {
    if (contentWidth === null || !Number.isFinite(contentWidth)) {
        return { devtools: true, scope: true, urlMinWidth: WEB_URL_MIN_WIDTH_PX };
    }
    /*
     * What a row keeping `kept` of the five shed-able buttons needs, with the address at its
     * floor: one 22 px box per button, and one 6 px gap between every adjacent pair of the
     * (buttons + form) children — which is `buttons` gaps, since the form is the extra child.
     */
    const needs = (kept: number): number => {
        const buttons = WEB_CHROME_FIXED_BUTTONS + kept;
        return buttons * WEB_CHROME_BUTTON_PX + buttons * WEB_CHROME_GAP_PX + WEB_URL_MIN_WIDTH_PX;
    };
    // Shed order: dev tools first, then element pickup — the register's own order.
    if (needs(WEB_CHROME_SHEDDABLE) <= contentWidth) {
        return { devtools: true, scope: true, urlMinWidth: WEB_URL_MIN_WIDTH_PX };
    }
    if (needs(WEB_CHROME_SHEDDABLE - 1) <= contentWidth) {
        return { devtools: false, scope: true, urlMinWidth: WEB_URL_MIN_WIDTH_PX };
    }
    if (needs(WEB_CHROME_SHEDDABLE - 2) <= contentWidth) {
        return { devtools: false, scope: false, urlMinWidth: WEB_URL_MIN_WIDTH_PX };
    }
    // Exhausted: the form yields rather than pushing the surviving controls off the pane.
    return { devtools: false, scope: false, urlMinWidth: 0 };
}

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
        /*
         * Return ENDS the edit, and the caret goes to the page - what every browser does, and
         * what the claim effect below cannot do for us.
         *
         * That effect refuses whenever a chrome text field holds the caret ("the user is typing
         * an address, and the page must not take it back when that URL lands"), which is right
         * for every keystroke up to this one and wrong for this one. Submitting is the moment
         * the address stops being edited, so it is the moment the refusal has to be lifted, and
         * only the submit itself knows that.
         *
         * Both halves are needed and they do different jobs. The blur is what this DOCUMENT
         * thinks: while the URL bar holds `document.activeElement`, `isChromeTextEditing()` is
         * true and the priority layer declines ⌘⇧[ / ⌘⇧] / ⌘← by design (config-keybindings.md
         * 7.3's URL-bar exception), so leaving it focused jams the pane's own shortcuts. The
         * `focusView` is what the WINDOW thinks: the page is a native view, and only the host
         * can hand it the keyboard.
         *
         * `focusView` is also what keeps §N30 from undoing this. The nav guard preserves
         * whoever held the keyboard when a navigation started and hands it back on commit, and
         * that owner is the URL bar - but a deliberate claim in flight cancels the restore
         * (`shell/webhost/nav-focus.ts`), and this is exactly that claim.
         */
        const caret = typeof document === 'undefined' ? null : document.activeElement;
        if (caret instanceof HTMLElement && chromeTextIsFocused(caret)) caret.blur();
        const tabID = active?.id ?? null;
        // Not for a browser client: it has no native view to hand anything to, and its
        // placeholder card is not somewhere a caret can live.
        if (embedded && tabID !== null) void commands.focusView(paneID, tabID);
    }, [commands, draft, paneID, active, embedded]);

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
        /*
         * Issue #33 - and the address bar has to be able to RECEIVE what is typed next.
         *
         * `focus()` is a statement about this document. The page is a native view that holds the
         * WINDOW's keyboard, and no DOM call can take it: ⌘L selected the whole address, showed
         * a caret, and every keystroke after it went into the page. The mirror image of the
         * submit path, which has to push the keyboard the other way.
         *
         * `blurView` is the inverse of `focus-view`, and only the host can do it. Requested
         * after the DOM focus rather than before purely for readability - it is a round trip
         * through the daemon, so it lands later either way, and the selection is already in
         * place when the keyboard arrives.
         *
         * Not for a browser client: nothing there is holding the keyboard hostage.
         */
        if (embedded) void commands.blurView(paneID);
    }, [focusURLToken, embedded, commands, paneID]);

    /** The pane's subtree: every chrome text field it can put a caret in is a descendant. */
    const paneRef = useRef<HTMLDivElement | null>(null);

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
    /**
     * **Seeded `false`, so a pane that is BORN focused counts as having gained focus** (§N30).
     *
     * Swift claims first responder in `makeNSView` — `if let activeTab, isFocused { … }`
     * (`WebPaneView.swift:335-340`) — so a web pane created focused has the keyboard in its page
     * from the first frame, with nobody clicking anything. Seeding this ref from the mount value
     * made `gained` false in exactly that case, and the port only *looked* right because the
     * page's own load then stole the keyboard for itself (§N30's steal). With that steal handed
     * back, the miss became visible: `kelpi web open` left the ring on the new pane and the
     * keyboard in this renderer — §N19/§N20's divergence, one pane type further on.
     */
    const wasFocused = useRef(false);
    const liveTabID = active?.id ?? null;
    /**
     * WEB-002's half of the rule, and the reason a mount is not simply "always claim": a pane
     * (or tab) that arrives BLANK hands the caret to the URL bar so the user can type an
     * address, and `useBlankWebPaneURLFocus` is what does that. Claiming the page view for a
     * blank pane would put the window's keyboard in an `about:blank` page while the URL field
     * showed a caret that could never receive a keystroke — they are different processes, so
     * DOM focus alone cannot win that argument.
     */
    const blankTab = liveURL.trim() === '';
    /**
     * §N30's second residual (`run-AD`), and where its anchor actually lives.
     *
     * The gain used to be consumed BEFORE the blank-tab and chrome-text guards, so a pane born
     * focused whose active tab arrived blank and gained a URL a moment later ate its own claim
     * and never made another — a tab filling in is not a focus change, so nothing re-armed it.
     * `kelpi web open` is measured to deliver the tab with its URL in one update, which is why the
     * row could only call it latent; the ordering is not a contract, and a client that reloads
     * over a running daemon reaches it with no daemon change at all. Measured live in that state
     * (`docs/audit/n29-verify/`): ring on the web pane, its page holding a freshly landed URL,
     * and the keyboard still in this renderer — §N19/§N20's divergence, one pane type further on.
     *
     * So the gain is spent only when the claim is actually MADE, or on a guard that stands.
     *
     * The anchor that keeps "armed until it can act" from becoming "fired at some unrelated later
     * moment" is the CARET, read when the claim would be made — not a count of focus events since
     * the gain. That distinction is measured, not stylistic: a client reload fires three `focusin`
     * events in its first 50 ms (`pane-grid-new-pane`, then WEB-002's URL bar, then the terminal's
     * hidden `<textarea>`), and the caret settles on `<body>`. None of them is the user moving on,
     * so an event anchor drops every deferred claim for reasons that have nothing to do with the
     * person at the keyboard — and it is also the wrong QUESTION: what may not be stolen is a
     * caret that is in use, which is a fact about the present, not about history. It is the same
     * test Swift makes at the same moment (`firstResponder is NSText`, WEB-043), and §N33's
     * event-shaped anchor is right there for the opposite reason: those events are user gestures.
     *
     * Focus leaving the pane resets the gain outright, so a claim can never outlive its ring.
     */
    useEffect(() => {
        if (!focused) {
            wasFocused.current = false;
            return;
        }
        // The gain has already been spent — on a claim, or on a guard that stands.
        if (wasFocused.current) return;
        // Not claimable YET — a browser client with no native view, no tab, or a tab that is
        // still blank (WEB-002 owns that caret). Stay armed and re-decide when that changes.
        if (!embedded || liveTabID === null || blankTab) return;
        // WEB-043's `firstResponder is NSText` guard, and the anchor: a chrome text field holding
        // the caret is a caret in use, so the page does not take it. The gain is spent refusing —
        // the user is typing an address, and the page must not take it back when that URL lands.
        if (chromeTextIsFocused(typeof document === 'undefined' ? null : document.activeElement)) {
            wasFocused.current = true;
            return;
        }
        wasFocused.current = true;
        void commands.focusView(paneID, liveTabID);
    }, [focused, embedded, liveTabID, blankTab, commands, paneID]);

    /**
     * Issue #32 - and the pane that LOSES focus lets go of its chrome caret.
     *
     * The effect above is the claim; this is its opposite number, and the port only had the claim.
     * Pane surfaces already resign on `true -> false` (`releasePaneCaret`, `PlainTextEditor`'s
     * `area.blur()`), because the next pane's `shouldGrabFocus` may not take a caret held by
     * chrome. The URL bar is chrome, so the ring moved and the caret did not.
     *
     * Two things that must NOT release, and both look the same from in here:
     *
     *   - the PAGE in this pane taking focus, or a URL landing under a draft: the ring stays here,
     *     `focused` never changes, and WEB-043's exemption keeps the edit alive;
     *   - a BACKGROUND pane's bar being filled by WEB-002 (`useBlankWebPaneURLFocus` grants the
     *     caret to a blank pane whether or not it wears the ring). Hence the true -> false
     *     transition rather than `!focused`, which would re-fire on that pane's next tab change.
     *
     * Releasing ends the edit, the way a browser's address bar reverts when it loses focus.
     */
    const heldPaneFocus = useRef(false);
    useEffect(() => {
        const lost = heldPaneFocus.current && !focused;
        heldPaneFocus.current = focused;
        if (!lost) return;
        // Subtree-scoped, so the find bar, pickup panel and storage panel are covered by the same
        // rule and a caret that landed elsewhere in this commit is not undone.
        releaseWebChromeCaret(paneRef.current);
    }, [focused]);

    // ── §S43: the nav row's own width ───────────────────────────────────────────────

    /*
     * The row is measured rather than told, because what decides the fit is the row's content
     * box and nothing upstream has it: the grid knows the pane's frame, but the chrome's `px-2`
     * and (on a browser client) a scrollbar are between the two. `null` until something has
     * measured — a jsdom render, or the first frame — which draws the pre-S43 row.
     */
    const navRowRef = useRef<HTMLDivElement | null>(null);
    const [navRowWidth, setNavRowWidth] = useState<number | null>(null);
    useLayoutEffect(() => {
        const element = navRowRef.current;
        if (element === null) return;
        const read = (): void => {
            const style = globalThis.getComputedStyle?.(element);
            const pad =
                style === undefined
                    ? 0
                    : (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
            const width = element.clientWidth - pad;
            // jsdom reports 0 for everything; a 0-width row is "unmeasured", not "shed it all".
            setNavRowWidth(width > 0 ? width : null);
        };
        read();
        const view = globalThis as {
            ResizeObserver?: new (callback: () => void) => { observe(target: Element): void; disconnect(): void };
        };
        if (view.ResizeObserver === undefined) return;
        const observer = new view.ResizeObserver(() => read());
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    const chromeFit = useMemo(() => webChromeFit(navRowWidth), [navRowWidth]);

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
            ref={paneRef}
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
                            className={progress.indeterminate ? 'kelpi-web-progress' : ''}
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
                    // §S43: the row measures ITSELF rather than being told the pane's width.
                    // Its own width is set by the pane above it and never by its children, so
                    // shedding a button cannot change what was measured — no feedback loop.
                    ref={navRowRef}
                    data-testid={`web-nav-row-${paneID}`}
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
                        // §S43 (owner-directed): the address's floor, and the release under it.
                        // See `webChromeFit`.
                        style={{ minWidth: chromeFit.urlMinWidth }}
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
                    {/* §S43 (owner-directed): shed second, below ~244 px of pane. The pane
                        header's context menu carries "Element Pickup" at every width. */}
                    {!chromeFit.scope ? null : (
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
                    )}
                    <ChromeButton
                        testID={`web-storage-toggle-${paneID}`}
                        // WEB-040: the glyph and the tooltip both distinguish the two modes — a
                        // private pane is a locked one, and the accent alone said too little.
                        label={
                            props.isPrivate === true
                                ? 'Private mode - cookies and site data are in-memory'
                                : 'Cookies and site data'
                        }
                        glyph={props.isPrivate === true ? 'lock' : 'lock-open'}
                        active={storageOpen || props.isPrivate === true}
                        onClick={() => setStorageOpen((current) => !current)}
                    />
                    {/* §S43 (owner-directed): shed first, below ~272 px of pane. The pane
                        header's context menu carries "Toggle Developer Tools" at every width. */}
                    {!chromeFit.devtools ? null : (
                        <ChromeButton
                            testID={`web-devtools-${paneID}`}
                            label="Toggle developer tools"
                            glyph="code"
                            // Only the shell can open dev tools; in a browser the button would lie.
                            disabled={!embedded || active === null}
                            onClick={() => void commands.toggleDevTools(paneID, active?.id ?? null)}
                        />
                    )}
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
                         * `data-kelpi-web-tabstrip` hides the bar for this one element in
                         * `styles.css`; the global rule is untouched.
                         */
                        data-kelpi-web-tabstrip=""
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

            <WebPageSurface {...props} />

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
