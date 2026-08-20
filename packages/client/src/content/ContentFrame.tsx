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
 *     is re-applied on every `ready`, so a watcher reload does not silently drop the marks.
 *   - **the whole-document copy commands** (§3.14). "Copy as Markdown" needs only the source
 *     text the daemon already sent; "Copy as Rich Text" needs the rendered DOM, which only the
 *     frame can see — so the host asks for it and writes what comes back.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import {
    CONTENT_HOST_SOURCE,
    openExternalLink,
    parseBridgeMessage,
    prepareContentDocument,
    writeClipboardText,
    type ClipboardWriter,
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
    readonly testID?: string | undefined;
}

/** §3.13: the overlay's "current / total" readout; 0 matches shows `0/0`, never `3/0`. */
export function findCountLabel(total: number, current: number): string {
    if (total <= 0) return '0/0';
    return `${String(current < 0 ? 0 : current + 1)}/${String(total)}`;
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
    const findInputRef = useRef<HTMLInputElement | null>(null);
    /** What the document is currently marked for, replayed after every reload. */
    const appliedNeedleRef = useRef('');

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
        setFindOpen(true);
        // The input mounts in the same commit, so the focus has to wait for it.
        queueMicrotask(() => findInputRef.current?.focus());
    }, [findToken, props.findEnabled]);

    // §3.13: no debounce — it is local JS, and a lagging highlight reads as a broken one.
    useEffect(() => {
        if (!findOpen) return;
        sendFind('search', needle);
    }, [findOpen, needle, sendFind]);

    // ── the copy commands (§3.14) ───────────────────────────────────────────────────
    const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
    /** Pending "Copy as Rich Text" requests: the frame answers asynchronously. */
    const richTokenRef = useRef<string | null>(null);

    const copyable = typeof props.copySource === 'string';

    // The frame only takes the browser's own context menu away while there is something to
    // replace it with, so it has to be told — on every `ready` (a reload resets the flag) and
    // whenever the document's copyability changes under a live frame.
    useEffect(() => {
        toFrame({ kind: 'copy-menu', enabled: copyable });
    }, [copyable, toFrame, srcDoc]);

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
                case 'find-open':
                    if (current.findEnabled === false) return;
                    setFindOpen(true);
                    queueMicrotask(() => findInputRef.current?.focus());
                    return;
                case 'find-result':
                    setMatches({ total: message.total, current: message.current });
                    return;
                case 'context-menu':
                    if (typeof current.copySource !== 'string') return;
                    current.onFocusRequest?.(paneID);
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
    }, [paneID, store]);

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

            {copyable && !findOpen ? (
                <button
                    type="button"
                    data-testid={`content-copy-${paneID}`}
                    aria-label="Copy document"
                    title="Copy document"
                    className="absolute rounded px-1.5 py-0.5 text-[10px] opacity-70 transition-opacity hover:opacity-100"
                    style={{ ...OVERLAY_STYLE, right: OVERLAY_INSET, top: 8 }}
                    onClick={(event) => {
                        event.stopPropagation();
                        const box = event.currentTarget.getBoundingClientRect();
                        const host = event.currentTarget.parentElement?.getBoundingClientRect();
                        setMenu({
                            x: box.left - (host?.left ?? 0),
                            y: box.bottom - (host?.top ?? 0) + 2
                        });
                    }}
                >
                    Copy
                </button>
            ) : null}

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
                        style={{ ...OVERLAY_STYLE, left: menu.x, top: menu.y }}
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
                    </div>
                </>
            )}

            {findOpen ? (
                <div
                    data-testid={`content-find-${paneID}`}
                    className="absolute flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px]"
                    style={{ ...OVERLAY_STYLE, right: OVERLAY_INSET, top: 8 }}
                    onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                            event.preventDefault();
                            event.stopPropagation();
                            closeFind();
                        }
                    }}
                >
                    <input
                        ref={findInputRef}
                        aria-label={`Find in ${title}`}
                        placeholder="Find"
                        data-testid={`content-find-input-${paneID}`}
                        className="w-32 bg-transparent outline-none"
                        value={needle}
                        onChange={(event) => setNeedle(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key !== 'Enter') return;
                            event.preventDefault();
                            sendFind(event.shiftKey ? 'prev' : 'next');
                        }}
                    />
                    <span
                        data-testid={`content-find-count-${paneID}`}
                        className="tabular-nums opacity-60"
                    >
                        {findCountLabel(matches.total, matches.current)}
                    </span>
                    <button
                        type="button"
                        aria-label="Previous match"
                        data-testid={`content-find-prev-${paneID}`}
                        onClick={() => sendFind('prev')}
                    >
                        ↑
                    </button>
                    <button
                        type="button"
                        aria-label="Next match"
                        data-testid={`content-find-next-${paneID}`}
                        onClick={() => sendFind('next')}
                    >
                        ↓
                    </button>
                    <button
                        type="button"
                        aria-label="Close find"
                        data-testid={`content-find-close-${paneID}`}
                        onClick={closeFind}
                    >
                        ✕
                    </button>
                </div>
            ) : null}
        </div>
    );
}

const EMPTY_MATCHES = { total: 0, current: -1 } as const;

/** The chrome the overlays sit in — deliberately opaque so text under them never shows through. */
const OVERLAY_STYLE = {
    background: 'var(--nex-surface-bg, #1B1B20)',
    border: '1px solid var(--nex-divider, #2A2A31)',
    color: 'var(--nex-fg-primary, #E6E6EA)',
    boxShadow: '0 6px 18px rgba(0,0,0,0.35)'
} as const;
