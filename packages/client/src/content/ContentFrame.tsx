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
 */

import { useEffect, useMemo, useRef, type ReactElement } from 'react';

import {
    CONTENT_HOST_SOURCE,
    openExternalLink,
    parseBridgeMessage,
    prepareContentDocument,
    writeClipboardText,
    type ClipboardWriter,
    type LinkOpener
} from './bridge';
import { contentScrollStore, type ScrollStore } from './scroll';

/** The pane fill behind the transparent document (`--nex-term-bg`, as terminal panes use). */
export const CONTENT_PANE_BACKGROUND = 'var(--nex-term-bg, #0A0A0C)';

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
    readonly background?: string | undefined;
    readonly onFocusRequest?: ((paneID: string) => void) | undefined;
    /** ⌘E inside the preview — the host's key interceptor cannot see through the iframe. */
    readonly onToggleEdit?: ((paneID: string) => void) | undefined;
    readonly scrollStore?: ScrollStore | undefined;
    /** Seams for tests; the defaults are `navigator.clipboard` and `window.open`. */
    readonly writeClipboard?: ClipboardWriter | undefined;
    readonly openLink?: LinkOpener | undefined;
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

    const srcDoc = useMemo(
        () => prepareContentDocument(html, { paneID, assetBase: props.assetBase ?? null }),
        [html, paneID, props.assetBase]
    );

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
            className="h-full w-full overflow-hidden"
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
        </div>
    );
}
