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
    type ReactElement
} from 'react';

import { tokens } from '../grid/tokens';
import { BatchPanel } from './BatchPanel';
import type { WebPaneCommands } from './commands';
import { FavouritesMenu } from './FavouritesMenu';
import type { GeometryRect, GeometryReport } from './geometry';
import { WEB_CHROME_TEXT_ATTRIBUTE } from './priority';
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
}

/** §17.2: the active tab always falls back to `tabs[0]` — every consumer shares the fallback. */
export function resolveActiveTab(
    tabs: readonly WebPaneTab[],
    activeTabID: string | null
): WebPaneTab | null {
    return tabs.find((tab) => tab.id === activeTabID) ?? tabs[0] ?? null;
}

/** §5's `displayLabel`: the title if there is one, else the URL, else a placeholder. */
export function tabLabel(tab: WebPaneTab): string {
    const title = tab.title ?? '';
    if (title.trim().length > 0) return title;
    if (tab.url.length > 0) return tab.url;
    return 'New tab';
}

const EMPTY_FAVOURITES: readonly WebFavourite[] = [];
const EMPTY_DESTINATIONS: readonly BatchDestination[] = [];

function measureElement(element: HTMLElement): GeometryRect {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
}

// ── chrome glyphs ───────────────────────────────────────────────────────────────────

/**
 * Hand-rolled, like `grid/icons.tsx`: the client has no icon package and may not add one, and
 * these five shapes are specific to the browser chrome rather than to the pane header's set.
 */
const GLYPHS = {
    back: 'M7.5 2.5 4 6l3.5 3.5',
    forward: 'M4.5 2.5 8 6l-3.5 3.5',
    reload: 'M9.5 6a3.5 3.5 0 1 1-1.03-2.47M9.5 2v2.2H7.3',
    plus: 'M6 2.5v7M2.5 6h7',
    close: 'M3.5 3.5l5 5M8.5 3.5l-5 5',
    code: 'M4.2 3.5 1.7 6l2.5 2.5M7.8 3.5 10.3 6 7.8 8.5',
    /** §12's scope button: a crosshair, the cursor the armed picker puts on the page. */
    scope: 'M6 1.6v2M6 8.4v2M1.6 6h2M8.4 6h2M6 3.9A2.1 2.1 0 1 0 6 8.1a2.1 2.1 0 0 0 0-4.2',
    /** §13's storage panel: a cookie/database cylinder. */
    storage: 'M2.4 3.2c0-.9 1.6-1.6 3.6-1.6s3.6.7 3.6 1.6-1.6 1.6-3.6 1.6-3.6-.7-3.6-1.6ZM2.4 3.2v5.6c0 .9 1.6 1.6 3.6 1.6s3.6-.7 3.6-1.6V3.2M2.4 6c0 .9 1.6 1.6 3.6 1.6S9.6 6.9 9.6 6'
} as const;

type GlyphName = keyof typeof GLYPHS;

function Glyph({ name, size = 12 }: { readonly name: GlyphName; readonly size?: number }): ReactElement {
    return (
        <svg
            data-icon={name}
            aria-hidden="true"
            focusable="false"
            width={size}
            height={size}
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.1}
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d={GLYPHS[name]} />
        </svg>
    );
}

interface ChromeButtonProps {
    readonly testID: string;
    readonly label: string;
    readonly glyph: GlyphName;
    readonly disabled?: boolean | undefined;
    readonly active?: boolean | undefined;
    readonly onClick: () => void;
}

function ChromeButton(props: ChromeButtonProps): ReactElement {
    const disabled = props.disabled === true;
    return (
        <button
            type="button"
            data-testid={props.testID}
            aria-label={props.label}
            title={props.label}
            disabled={disabled}
            className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded"
            style={{
                color: props.active === true ? tokens.accent : tokens.textSecondary,
                // §16.1: an unavailable control is dimmed, not hidden — the row must not reflow.
                opacity: disabled ? 0.3 : 1,
                cursor: disabled ? 'default' : 'pointer'
            }}
            onClick={props.onClick}
        >
            <Glyph name={props.glyph} />
        </button>
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

    // ⌘L, and the bindable `web_focus_url_bar`: select the whole address, as a browser does.
    const focusURLToken = props.focusURLToken ?? 0;
    const lastFocusToken = useRef(focusURLToken);
    useEffect(() => {
        if (focusURLToken === lastFocusToken.current) return;
        lastFocusToken.current = focusURLToken;
        const input = urlRef.current;
        if (input === null) return;
        input.focus();
        input.select();
    }, [focusURLToken]);

    // ── geometry ────────────────────────────────────────────────────────────────────

    const pageRef = useRef<HTMLDivElement | null>(null);
    const onGeometry = props.onGeometry;
    const onHidden = props.onHidden;
    const dpr = props.devicePixelRatio;

    const publish = useCallback(() => {
        // A browser client has nothing to place: reporting from it would only be noise the
        // host has to reject (and it does, on `ownWindow`).
        if (!embedded) return;
        const element = pageRef.current;
        if (element === null) return;
        if (!visible) {
            onHidden?.(paneID);
            return;
        }
        onGeometry?.({
            paneID,
            tabID: active?.id ?? null,
            rect: measure(element),
            visible: true,
            devicePixelRatio:
                dpr ?? (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1
        });
    }, [embedded, visible, paneID, active?.id, measure, onGeometry, onHidden, dpr]);

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

    const showTabs = tabs.length > 1;

    return (
        <div
            data-testid={`web-pane-${paneID}`}
            data-embedded={embedded ? 'true' : 'false'}
            className="flex h-full w-full flex-col overflow-hidden"
            style={{ background: tokens.windowBackground }}
            onPointerDown={() => props.onFocusRequest?.(paneID)}
        >
            <div
                className="flex shrink-0 items-center gap-1 px-1.5 py-1"
                style={{ background: tokens.headerBackground, borderBottom: `1px solid ${tokens.divider}` }}
            >
                <ChromeButton
                    testID={`web-back-${paneID}`}
                    label="Back (⌘←)"
                    glyph="back"
                    disabled={active === null}
                    onClick={() => void commands.back(paneID)}
                />
                <ChromeButton
                    testID={`web-forward-${paneID}`}
                    label="Forward (⌘→)"
                    glyph="forward"
                    disabled={active === null}
                    onClick={() => void commands.forward(paneID)}
                />
                <ChromeButton
                    testID={`web-reload-${paneID}`}
                    label="Reload (⌘R, ⌥-click bypasses the cache)"
                    glyph="reload"
                    disabled={active === null}
                    onClick={() => void commands.reload(paneID)}
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
                        // The star sits INSIDE the field's border (§16.1), so the border is on
                        // this row rather than on the input itself.
                        style={{
                            background: tokens.surfaceBackground,
                            border: `1px solid ${props.isPrivate === true ? '#9B6BD6' : tokens.divider}`
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
                            onFocus={(event) => {
                                setEditing(true);
                                event.target.select();
                            }}
                            onBlur={onBlur}
                        />
                        <FavouritesMenu
                            paneID={paneID}
                            url={liveURL}
                            title={active?.title ?? ''}
                            favourites={favourites}
                            onToggle={(url, title) => void commands.favouriteToggle(url, title)}
                            onOpen={(url) => void commands.navigate(paneID, url)}
                            onManage={() => props.onManageFavourites?.()}
                        />
                    </div>
                </form>
                <ChromeButton
                    testID={`web-new-tab-${paneID}`}
                    label="New tab (⌘T)"
                    glyph="plus"
                    onClick={() => void commands.newTab(paneID)}
                />
                <ChromeButton
                    testID={`web-batch-toggle-${paneID}`}
                    // WEB-126's three-way, said out loud so the button explains itself.
                    label={
                        batch === null
                            ? 'Start element pickup'
                            : batch.visible
                              ? 'Hide element pickup'
                              : 'Show element pickup'
                    }
                    glyph="scope"
                    active={batch !== null && batch.visible}
                    disabled={active === null}
                    onClick={() => void commands.batchToggle(paneID)}
                />
                <ChromeButton
                    testID={`web-storage-toggle-${paneID}`}
                    label="Cookies and site data"
                    glyph="storage"
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

            {showTabs ? (
                <div
                    data-testid={`web-tabs-${paneID}`}
                    className="flex shrink-0 items-center gap-1 overflow-x-auto px-1.5 py-1"
                    style={{ background: tokens.headerBackground, borderBottom: `1px solid ${tokens.divider}` }}
                >
                    {tabs.map((tab) => {
                        const isActive = tab.id === active?.id;
                        return (
                            <div
                                key={tab.id}
                                data-testid={`web-tab-${tab.id}`}
                                data-active={isActive ? 'true' : 'false'}
                                className="flex max-w-[180px] shrink-0 items-center gap-1 rounded px-2 py-[2px]"
                                style={{
                                    background: isActive
                                        ? `color-mix(in srgb, ${tokens.accent} 18%, transparent)`
                                        : tokens.surfaceBackground,
                                    border: `1px solid ${isActive ? tokens.accent : tokens.divider}`
                                }}
                            >
                                <button
                                    type="button"
                                    data-testid={`web-tab-select-${tab.id}`}
                                    title={tab.url}
                                    className="min-w-0 truncate font-mono text-[11px]"
                                    style={{ color: isActive ? tokens.textPrimary : tokens.textSecondary }}
                                    onClick={() => void commands.selectTab(paneID, tab.id)}
                                >
                                    {tabLabel(tab)}
                                </button>
                                <button
                                    type="button"
                                    data-testid={`web-tab-close-${tab.id}`}
                                    aria-label="Close tab (⌘W)"
                                    title="Close tab (⌘W)"
                                    className="shrink-0"
                                    style={{ color: tokens.textTertiary }}
                                    onClick={() => void commands.closeTab(paneID, tab.id)}
                                >
                                    <Glyph name="close" size={9} />
                                </button>
                            </div>
                        );
                    })}
                </div>
            ) : null}

            <div
                ref={pageRef}
                data-testid={`web-page-${paneID}`}
                data-visible={visible ? 'true' : 'false'}
                className="relative min-h-0 flex-1 overflow-hidden"
                // Nothing is drawn here when embedded: the shell's native view covers this box
                // exactly, and anything underneath would only be visible while it catches up.
                style={{ background: tokens.windowBackground }}
            >
                {tabs.length === 0 ? (
                    <PageNote
                        testID={`web-empty-${paneID}`}
                        title="New web pane"
                        detail="Type a URL above and press Return"
                    />
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
