/**
 * The sandboxed viewport a rendered document is shown in (markdown preview + diff).
 *
 * Isolation is the reason this component exists (content-panes.md port note 3). The daemon's
 * HTML contains whatever the user's note contains, raw HTML included, so it is loaded through
 * `srcdoc` into an iframe sandboxed to **`allow-scripts` only**: scripts run (the copy button
 * needs them), the document gets an opaque origin, and it can touch neither the app shell's DOM
 * nor its storage. `allow-scripts` + `allow-same-origin` together would hand a note the keys to
 * the app, so that pair is never emitted — see `bridge.ts`.
 *
 * Everything the frame needs to say therefore arrives as `postMessage`, and everything the host
 * knows about the document's scroll position comes from the same channel (§3.11):
 *
 *   - a **same-mount reload** (the watcher saw a write, the theme changed) restores the absolute
 *     offset captured just before the swap — the document is the same length, so pixels are the
 *     truthful unit;
 *   - a **fresh mount** (workspace switch, ⌘E back to preview) restores the 0..1 fraction from
 *     the shared store, because the new document's height is not the old one's.
 *
 * The pane is painted with the ghostty background behind the transparent document (§3.8), which
 * is what makes a content pane look like it belongs beside a terminal.
 *
 * Two more things ride the same channel because the sandbox leaves no other route:
 *
 *   - **find-in-page** (§3.13). The marks and the match count live inside the document (the
 *     injected `__nexFind`); the needle, the bar and the count display live here, PER CLIENT —
 *     two browsers searching the same pane never see each other's highlights. The stored needle
 *     is re-applied on every `ready`, so a watcher reload does not silently drop the marks. The
 *     bar itself is the grid's `PaneSearchOverlay` — the shipped app draws one find bar over
 *     every pane type, so this pane must not invent a second one.
 *   - **the whole-document copy commands** (§3.14). "Copy as Markdown" needs only the source
 *     text the daemon already sent; "Copy as Rich Text" needs the rendered DOM, which only the
 *     frame can see — so the host asks for it and writes what comes back.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import { PaneSearchOverlay } from '../grid/PaneSearchOverlay';
import {
    CONTENT_HOST_SOURCE,
    openExternalLink,
    parseBridgeMessage,
    prepareContentDocument,
    replayFrameChord,
    writeClipboardText,
    type ClipboardWriter,
    type ContentChordEvent,
    type FindOp,
    type FindPalette,
    type LinkOpener
} from './bridge';
import { stripFrontMatter, writeRichText, type RichClipboardWriter } from './copy';
import { contentScrollStore, type ScrollStore } from './scroll';

/** The pane fill behind the transparent document (`--nex-term-bg`, as terminal panes use). */
export const CONTENT_PANE_BACKGROUND = 'var(--nex-term-bg, #0A0A0C)';

/**
 * The opaque fill painted INSIDE the frame when assembly did not resolve one (`bridge.ts`'s
 * `frameBaseStyle` explains why the frame needs its own). These are the `--nex-term-bg` defaults
 * of the two chrome columns, so a standalone frame (a test, a storybook) is still theme-correct.
 */
export const FRAME_DOCUMENT_BACKGROUND = { dark: '#0A0A0C', light: '#FFFFFF' } as const;

/**
 * Content overlays clear the document's 8 px scrollbar gutter (`::-webkit-scrollbar { width: 8px }`
 * in the daemon's stylesheet, content-panes.md §3.9). At `right-2` the Copy chip's right edge
 * landed exactly on the scroller, so it read as clipped by the pane edge in every screenshot.
 */
const OVERLAY_INSET = 14;

/**
 * Where the Copy menu opens. A measured `{x, y}` is the in-frame chip's own anchor (its
 * bottom-left); `{anchor:'top-right'}` is the pane HEADER's button (§TERM-103), which is not in
 * this component's coordinate space at all — it sits one row above, so the menu is pinned to
 * the same top-right corner the chip occupies instead of a coordinate that would be a guess.
 */
type CopyMenuPosition = { readonly x: number; readonly y: number } | { readonly anchor: 'top-right' };

export interface ContentFrameProps {
    readonly paneID: string;
    /** The daemon's rendered document. An empty string renders an empty (but live) frame. */
    readonly html: string;
    /** `/pane-assets/<paneID>/`; injected as `<base href>` when the document has none. */
    readonly assetBase?: string | null | undefined;
    /** Accessible name for the frame ("markdown preview", "diff"). */
    readonly title: string;
    /** False keeps the frame mounted (and its scroll position) while hiding it. */
    readonly visible?: boolean | undefined;
    /** The pane container's fill; may carry the ghostty background opacity. */
    readonly background?: string | undefined;
    /**
     * The OPAQUE color the document itself is painted with (`bridge.ts` → `frameBaseStyle`).
     * Assembly flattens the container fill over the window background so the frame matches the
     * composite it cannot join; omitted, the frame falls back to the `isDark` default.
     */
    readonly documentBackground?: string | undefined;
    /** The daemon's light/dark verdict for this document — drives the frame's `color-scheme`. */
    readonly isDark?: boolean | undefined;
    readonly onFocusRequest?: ((paneID: string) => void) | undefined;
    /** ⌘E inside the preview — the host's key interceptor cannot see through the iframe. */
    readonly onToggleEdit?: ((paneID: string) => void) | undefined;
    readonly scrollStore?: ScrollStore | undefined;
    /** Seams for tests; the defaults are `navigator.clipboard` and `window.open`. */
    readonly writeClipboard?: ClipboardWriter | undefined;
    readonly writeRichClipboard?: RichClipboardWriter | undefined;
    readonly openLink?: LinkOpener | undefined;
    /**
     * §3.14: the pane's raw markdown. A string enables both copy commands (the button and the
     * preview's context menu); `null`/absent disables them — which is how a failed load is
     * refused, since you cannot copy the synthetic error blockquote.
     */
    readonly copySource?: string | null | undefined;
    /** §3.13: set false for a surface with no find bar. */
    readonly findEnabled?: boolean | undefined;
    /**
     * SET-219's overridable find-highlight colours, straight off the settings snapshot. Absent
     * = the Swift `NexGhosttyDefaults` pair (#F2D027 / #FF7A00 on black), which is what a user
     * who has never touched the keys sees.
     */
    readonly findPalette?: Partial<FindPalette> | undefined;
    /** Bump to open the find bar from outside (the app's `toggle_search` binding). */
    readonly findToken?: number | undefined;
    /**
     * §TERM-103: bump to open the Copy menu from the PANE HEADER's copy button.
     *
     * The Swift pops a native `NSMenu` at the header button; here the menu is the frame's own
     * (it owns the iframe conversation "Copy as Rich Text" needs), so the header asks for it
     * with a token the same way ⌘F asks for the find bar. It opens where the in-frame chip
     * would put it — top-right of the document, directly under the header button that asked.
     */
    readonly copyToken?: number | undefined;
    /**
     * H9 — the chords the app's binding map claims (`bridge.ts`'s `chordKeysForBindings`).
     *
     * The frame is cross-origin, so its keydowns never reach the host `window` and the app's
     * dispatcher never sees them: with a preview focused, ⌘W, ⌘D/⇧⌘D, ⌘[/⌘], ⇧⌘Space, the
     * markdown font trio and zoom were all dead. The Swift has no such boundary — its
     * `NSEvent` monitor fires for whatever holds first responder, `WKWebView` included — so
     * the frame is told which chords to hand back, relays exactly those, and leaves every
     * other key to the document (⌘C still copies a selection).
     *
     * Absent = relay nothing, which is the old behaviour and what a standalone frame wants.
     */
    readonly claimedChords?: readonly string[] | undefined;
    /** Test seam: where a relayed chord is re-dispatched. Defaults to `window`. */
    readonly replayTarget?: EventTarget | undefined;
    readonly testID?: string | undefined;
}

export interface ContentStatusProps {
    readonly paneID: string;
    readonly text: string;
    readonly tone?: 'quiet' | 'error' | undefined;
    readonly testID?: string | undefined;
}

/**
 * The pane body before the first snapshot lands, and after a content command fails. A load
 * failure of the FILE is not shown here — the daemon renders that as a markdown blockquote
 * inside the document itself (§3.11), so the reader sees it in place.
 */
export function ContentStatus(props: ContentStatusProps): ReactElement {
    const error = props.tone === 'error';
    return (
        <div
            data-testid={props.testID ?? `content-status-${props.paneID}`}
            data-tone={error ? 'error' : 'quiet'}
            className="flex h-full w-full items-center justify-center p-4 text-center text-[11px]"
            style={{
                background: CONTENT_PANE_BACKGROUND,
                color: error ? '#E0655C' : 'var(--nex-fg-tertiary, #6A6A72)'
            }}
        >
            {props.text}
        </div>
    );
}

export function ContentFrame(props: ContentFrameProps): ReactElement {
    const { paneID, html, title } = props;
    const store = props.scrollStore ?? contentScrollStore;

    const latest = useRef(props);
    useEffect(() => {
        latest.current = props;
    });

    const frameRef = useRef<HTMLIFrameElement | null>(null);
    /** The last position the document reported, for the same-mount reload restore. */
    const lastTopRef = useRef(0);
    /** False until this mount has restored once — the first restore uses the shared fraction. */
    const restoredRef = useRef(false);

    const colorScheme = props.isDark === false ? 'light' : 'dark';
    const documentBackground = props.documentBackground ?? FRAME_DOCUMENT_BACKGROUND[colorScheme];

    const srcDoc = useMemo(
        () =>
            prepareContentDocument(html, {
                paneID,
                assetBase: props.assetBase ?? null,
                background: documentBackground,
                colorScheme,
                findPalette: props.findPalette
            }),
        [html, paneID, props.assetBase, documentBackground, colorScheme, props.findPalette]
    );

    // ── find-in-page (§3.13), per client ────────────────────────────────────────────
    const [findOpen, setFindOpen] = useState(false);
    const [needle, setNeedle] = useState('');
    const [matches, setMatches] = useState<{ total: number; current: number }>(EMPTY_MATCHES);
    /**
     * Bumped on every request to open the bar, and used as the overlay's `key`.
     *
     * `PaneSearchOverlay` claims the caret on mount (as the Swift bar does on `.onAppear`), so
     * re-keying is how a second ⌘F *while the bar is already open* pulls focus back into the
     * field — the behaviour the hand-rolled bar got from an explicit `inputRef.focus()`. It
     * focuses and leaves the caret at the end of the needle (L29), so coming back to the bar
     * does not put the existing needle one keystroke from being erased.
     */
    const [findSeq, setFindSeq] = useState(0);
    /** What the document is currently marked for, replayed after every reload. */
    const appliedNeedleRef = useRef('');

    const openFind = useCallback((): void => {
        setFindOpen(true);
        setFindSeq((seq) => seq + 1);
    }, []);

    const toFrame = useCallback((message: Record<string, unknown>): void => {
        frameRef.current?.contentWindow?.postMessage({ source: CONTENT_HOST_SOURCE, ...message }, '*');
    }, []);

    const sendFind = useCallback(
        (op: FindOp, value?: string): void => {
            appliedNeedleRef.current = op === 'clear' ? '' : (value ?? appliedNeedleRef.current);
            toFrame({ kind: 'find', op, ...(value === undefined ? {} : { needle: value }) });
        },
        [toFrame]
    );

    const closeFind = useCallback((): void => {
        setFindOpen(false);
        setMatches(EMPTY_MATCHES);
        sendFind('clear');
    }, [sendFind]);

    // The app's `toggle_search` binding: a token bump opens the bar and claims the caret.
    const findToken = props.findToken ?? 0;
    const lastFindToken = useRef(findToken);
    useEffect(() => {
        if (findToken === lastFindToken.current) return;
        lastFindToken.current = findToken;
        if (props.findEnabled === false) return;
        openFind();
    }, [findToken, props.findEnabled, openFind]);

    // §3.13: no debounce — it is local JS, and a lagging highlight reads as a broken one.
    useEffect(() => {
        if (!findOpen) return;
        sendFind('search', needle);
    }, [findOpen, needle, sendFind]);

    // ── the copy commands (§3.14) ───────────────────────────────────────────────────
    const [menu, setMenu] = useState<CopyMenuPosition | null>(null);
    /**
     * H10: what was selected in the document when the menu was raised, so the menu can APPEND
     * WebKit's Copy row rather than replacing the browser's menu with two items. Empty for the
     * header-button route, which has no click and therefore no selection under it.
     */
    const [menuSelection, setMenuSelection] = useState('');
    /** Pending "Copy as Rich Text" requests: the frame answers asynchronously. */
    const richTokenRef = useRef<string | null>(null);

    const copyable = typeof props.copySource === 'string';

    /**
     * §TERM-103: the PANE HEADER's copy button, arriving as a bumped token (see `copyToken`).
     * It opens the same menu the in-frame chip opens, pinned under the header rather than at a
     * measured chip — the button that asked for it is in the header, one row above.
     */
    const copyToken = props.copyToken ?? 0;
    const lastCopyToken = useRef(copyToken);
    useEffect(() => {
        if (copyToken === lastCopyToken.current) return;
        lastCopyToken.current = copyToken;
        if (!copyable) return;
        setMenuSelection('');
        setMenu({ anchor: 'top-right' });
    }, [copyToken, copyable]);

    // The frame only takes the browser's own context menu away while there is something to
    // replace it with, so it has to be told — on every `ready` (a reload resets the flag) and
    // whenever the document's copyability changes under a live frame.
    useEffect(() => {
        toFrame({ kind: 'copy-menu', enabled: copyable });
    }, [copyable, toFrame, srcDoc]);

    /**
     * H9: the claimed chord set, on the same schedule as the copy-menu flag — a re-injected
     * document has an empty set until it is told, and a re-recorded keybinding has to reach a
     * frame that is already open.
     */
    const claimedChords = props.claimedChords ?? EMPTY_CHORDS;
    useEffect(() => {
        toFrame({ kind: 'chords', chords: claimedChords });
    }, [claimedChords, toFrame, srcDoc]);

    const copyMarkdown = useCallback((): void => {
        setMenu(null);
        const source = latest.current.copySource;
        if (typeof source !== 'string') return;
        writeClipboardText(stripFrontMatter(source), latest.current.writeClipboard);
    }, []);

    const copyRichText = useCallback((): void => {
        setMenu(null);
        if (typeof latest.current.copySource !== 'string') return;
        const token = `rich-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
        richTokenRef.current = token;
        toFrame({ kind: 'collect-rich-text', token });
    }, [toFrame]);

    /**
     * H10: WebKit's own Copy row, appended under the two nex commands.
     *
     * The Swift menu *inserts* its commands into the WebKit menu, so Copy, Look Up, Speech and
     * Services all survive a right-click in a preview. Of those four only Copy is something a
     * DOM menu can honestly perform — and it is the one a reader reaches for — so it is carried
     * here, with the selection the frame sent (a cross-origin host can read it no other way).
     * The remaining three are `NSMenu` services and stay with the native menu the shell now
     * builds for every frame that has no host menu (`shell/src/context-menu.ts`).
     */
    const copySelection = useCallback((): void => {
        setMenu(null);
        writeClipboardText(menuSelection, latest.current.writeClipboard);
    }, [menuSelection]);

    useEffect(() => {
        const handler = (event: MessageEvent): void => {
            const frame = frameRef.current;
            // Cross-origin frames always identify themselves; a message with no source can only
            // have been dispatched by same-origin code (a test), which already has full access.
            if (frame !== null && event.source !== null && event.source !== frame.contentWindow) return;
            const message = parseBridgeMessage(event.data, paneID);
            if (message === null) return;
            const current = latest.current;

            switch (message.kind) {
                case 'ready': {
                    // A fresh document starts with the native menu intact; re-arm it here so a
                    // reload does not silently lose the copy menu.
                    frame?.contentWindow?.postMessage(
                        {
                            source: CONTENT_HOST_SOURCE,
                            kind: 'copy-menu',
                            enabled: typeof current.copySource === 'string'
                        },
                        '*'
                    );
                    // …and the same for the chord set (H9), for the same reason: a document
                    // that has just been re-injected claims nothing until it is told.
                    frame?.contentWindow?.postMessage(
                        {
                            source: CONTENT_HOST_SOURCE,
                            kind: 'chords',
                            chords: current.claimedChords ?? EMPTY_CHORDS
                        },
                        '*'
                    );
                    // §3.13: the document was replaced (watcher write, font change, theme swap)
                    // and its marks went with it — re-apply the stored needle before anything
                    // else, or the overlay would keep showing a count for highlights that
                    // no longer exist.
                    const stored = appliedNeedleRef.current;
                    if (stored.length > 0) {
                        frame?.contentWindow?.postMessage(
                            { source: CONTENT_HOST_SOURCE, kind: 'find', op: 'search', needle: stored },
                            '*'
                        );
                    }
                    // A reload of a mount that has already scrolled restores pixels; a fresh
                    // mount restores the shared fraction (§3.11 precedence).
                    const reload = restoredRef.current && lastTopRef.current > 0;
                    restoredRef.current = true;
                    const top = reload ? lastTopRef.current : 0;
                    const fraction = reload ? 0 : (store.get(paneID)?.fraction ?? 0);
                    if (top <= 0 && fraction <= 0) return;
                    frame?.contentWindow?.postMessage(
                        { source: CONTENT_HOST_SOURCE, kind: 'scroll-to', top, fraction },
                        '*'
                    );
                    return;
                }
                case 'scroll':
                    lastTopRef.current = message.top;
                    store.set(paneID, { top: message.top, fraction: message.fraction });
                    return;
                case 'copy':
                    writeClipboardText(message.text, current.writeClipboard);
                    return;
                case 'link':
                    openExternalLink(message.href, current.openLink);
                    return;
                case 'focus':
                    current.onFocusRequest?.(paneID);
                    return;
                case 'toggle-edit':
                    current.onToggleEdit?.(paneID);
                    return;
                /**
                 * H9: a chord the app claims, pressed inside the frame. Replaying it on the
                 * host window is the whole fix — the app's capture-phase dispatcher then runs
                 * it exactly as it would for a chord pressed over a terminal, so the focused
                 * pane (this one, because the press focused it) is the one it acts on.
                 */
                case 'key': {
                    const chord: ContentChordEvent = {
                        code: message.code,
                        key: message.key,
                        ctrlKey: message.ctrlKey,
                        altKey: message.altKey,
                        shiftKey: message.shiftKey,
                        metaKey: message.metaKey
                    };
                    replayFrameChord(chord, current.replayTarget);
                    return;
                }
                case 'find-open':
                    if (current.findEnabled === false) return;
                    openFind();
                    return;
                case 'find-result':
                    setMatches({ total: message.total, current: message.current });
                    return;
                case 'context-menu':
                    if (typeof current.copySource !== 'string') return;
                    current.onFocusRequest?.(paneID);
                    // H10: the selection under the click, so the menu can append Copy.
                    setMenuSelection(message.selection);
                    setMenu({ x: message.x, y: message.y });
                    return;
                case 'rich-text': {
                    // Only the request still outstanding may write the clipboard: a stale reply
                    // (a second click, a reloaded document) must not overwrite a newer copy.
                    if (richTokenRef.current !== message.token) return;
                    richTokenRef.current = null;
                    writeRichText({ html: message.html, text: message.text }, current.writeRichClipboard);
                    return;
                }
            }
        };

        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [paneID, store, openFind]);

    const visible = props.visible !== false;

    return (
        <div
            data-testid={props.testID ?? `content-frame-${paneID}`}
            data-pane-id={paneID}
            className="relative h-full w-full overflow-hidden"
            style={{
                background: props.background ?? CONTENT_PANE_BACKGROUND,
                visibility: visible ? 'visible' : 'hidden'
            }}
            onMouseDownCapture={() => latest.current.onFocusRequest?.(paneID)}
        >
            <iframe
                ref={frameRef}
                data-testid={`content-iframe-${paneID}`}
                title={title}
                srcDoc={srcDoc}
                // NEVER add `allow-same-origin` here: with `allow-scripts` it would give an
                // untrusted note scripting access to the app shell (port note 3).
                sandbox="allow-scripts"
                className="h-full w-full border-0"
                style={{ background: 'transparent', display: 'block' }}
            />

            {/*
              * §M28 — there is no floating in-document Copy chip.
              *
              * `PaneHeaderView.swift:177-194` gives a markdown pane exactly ONE copy
              * affordance: a `doc.on.doc` button in the pane header. The port drew that one AND
              * a "Copy" chip parked over the first line of the document, in the same top-right
              * slot the find bar uses — two controls for one command, one of them sitting on the
              * reader's text (`docs/audit/run-P/19-markdown-pane.png`). The chip is gone; the
              * header button reaches this same menu through `copyToken` (the `{anchor:
              * 'top-right'}` branch below), and a right-click still opens it in place.
              */}

            {menu === null ? null : (
                <>
                    {/* A click anywhere else dismisses; the frame's own clicks cannot reach us. */}
                    <div
                        data-testid={`content-copy-scrim-${paneID}`}
                        className="absolute inset-0"
                        onClick={() => setMenu(null)}
                    />
                    <div
                        role="menu"
                        aria-label="Copy document"
                        data-testid={`content-copy-menu-${paneID}`}
                        className="absolute z-10 min-w-[160px] rounded-md p-1 text-[12px]"
                        style={{
                            ...OVERLAY_STYLE,
                            ...('anchor' in menu
                                ? { right: OVERLAY_INSET, top: 8 }
                                : { left: menu.x, top: menu.y })
                        }}
                    >
                        <button
                            type="button"
                            role="menuitem"
                            data-testid={`content-copy-markdown-${paneID}`}
                            className="block w-full rounded px-2 py-1 text-left"
                            onClick={copyMarkdown}
                        >
                            Copy as Markdown
                        </button>
                        <button
                            type="button"
                            role="menuitem"
                            data-testid={`content-copy-rich-${paneID}`}
                            className="block w-full rounded px-2 py-1 text-left"
                            onClick={copyRichText}
                        >
                            Copy as Rich Text
                        </button>
                        {/*
                         * H10 — WebKit's own Copy, APPENDED rather than replaced away. The
                         * Swift splices its two commands in at indices 0-2 of the WebKit menu
                         * (`MarkdownPaneView.swift:457-494`), so Copy sits directly under them
                         * behind a separator; the row is absent with nothing selected, the way
                         * a disabled WebKit row reads.
                         */}
                        {menuSelection.trim() === '' ? null : (
                            <>
                                <div
                                    role="separator"
                                    data-testid={`content-copy-separator-${paneID}`}
                                    className="my-1 h-px"
                                    style={{ background: 'var(--nex-divider, #2A2A31)' }}
                                />
                                <button
                                    type="button"
                                    role="menuitem"
                                    data-testid={`content-copy-selection-${paneID}`}
                                    className="block w-full rounded px-2 py-1 text-left"
                                    onClick={copySelection}
                                >
                                    Copy
                                </button>
                            </>
                        )}
                    </div>
                </>
            )}

            {/*
              * §3.13's bar IS the terminal's bar. `PaneGridView.swift:356-370` mounts one
              * `PaneSearchOverlay` over every pane type with no type test, so a preview's find
              * is the same 160 pt monospace field, the same 22×22 chevrons dimmed and inert
              * while the needle is empty, the same ✕ and the same counter rule (nothing at all
              * until something is typed — never a standing `0/0`) as a terminal's. What differs
              * is only what it drives: the daemon counts a terminal's scrollback, and here the
              * sandboxed frame's own `__nexFind` counts, because nothing else can see inside it.
              */}
            {findOpen ? (
                <PaneSearchOverlay
                    key={findSeq}
                    paneID={paneID}
                    testIDPrefix="content-find"
                    // §L46: the frame's own accessible name, which no longer carries a raw pane
                    // UUID — "Find in markdown preview NOTES.md 0002", not the 36-character hex
                    // string this expression used to have to strip back out.
                    label={`Find in ${title}`}
                    needle={needle}
                    total={matches.total}
                    // The same guard the daemon applies to a terminal's counts (§TERM-118): a
                    // total of 0 drops any selection, so the bar can never read `3/0`.
                    selected={matches.total > 0 && matches.current >= 0 ? matches.current : null}
                    onNeedleChange={setNeedle}
                    onNext={() => sendFind('next')}
                    onPrevious={() => sendFind('prev')}
                    onClose={closeFind}
                />
            ) : null}
        </div>
    );
}

const EMPTY_MATCHES = { total: 0, current: -1 } as const;

/** A stable identity, so the chord effect does not re-post on every render (H9). */
const EMPTY_CHORDS: readonly string[] = [];

/** The chrome the overlays sit in — deliberately opaque so text under them never shows through. */
const OVERLAY_STYLE = {
    background: 'var(--nex-surface-bg, #1B1B20)',
    border: '1px solid var(--nex-divider, #2A2A31)',
    color: 'var(--nex-fg-primary, #E6E6EA)',
    boxShadow: '0 6px 18px rgba(0,0,0,0.35)'
} as const;
