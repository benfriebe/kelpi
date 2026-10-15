/**
 * An image pane: one image file, read-only (content-panes.md §12).
 *
 * The file is loaded by an `<img>` straight from the daemon's credentialed `/pane-assets/` route
 * (`paneFileURL`), so a 20 MB screenshot never crosses the WebSocket and the browser does the
 * decoding, caching and conditional requests. The daemon watches the file and broadcasts
 * `image-changed` when it is rewritten; the pane then loads it again under a new URL, and keeps
 * showing the old pixels until the new ones have decoded, so a regenerated screenshot swaps in
 * place without a blank frame.
 *
 * Two zooms, the way a browser shows an image on its own: **fit** (the default) scales a large
 * image down to the pane and never scales a small one up; a click on a scaled-down image shows
 * it at **actual size**, scrollable, and a second click fits it again.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement } from 'react';

import { IMAGE_CHANGED_MESSAGE } from '@kelpi/protocol';

import { PANE_SURFACE_ATTR, armCaretClaim, mayClaimPaneCaret } from '../app/pane-focus';
import { tokens } from '../chrome/tokens';
import type { KelpiRuntime } from '../state';
import { paneFileURL } from './asset-credential';
import { CONTENT_PANE_BACKGROUND, ContentStatus } from './ContentFrame';

export interface ImagePaneProps {
    readonly runtime: KelpiRuntime;
    readonly paneID: string;
    readonly filePath: string | null;
    readonly focused?: boolean | undefined;
    readonly visible?: boolean | undefined;
    readonly background?: string | undefined;
    readonly phone?: boolean | undefined;
    readonly onFocusRequest?: ((paneID: string) => void) | undefined;
}

type Zoom = 'fit' | 'actual';

interface Loaded {
    readonly src: string;
    readonly width: number;
    readonly height: number;
}

function basename(filePath: string): string {
    const trimmed = filePath.replace(/\/+$/, '');
    return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

/** `1920 × 1080`, and the scale when fit shrinks it (`1920 × 1080 · 42%`). */
export function imageCaption(width: number, height: number, scale: number | null): string {
    const size = `${width} × ${height}`;
    return scale === null || scale >= 1 ? size : `${size} · ${Math.max(1, Math.round(scale * 100))}%`;
}

export function ImagePane(props: ImagePaneProps): ReactElement {
    const { runtime, paneID, filePath } = props;
    const name = filePath === null ? '' : basename(filePath);

    // Bumped by the daemon's `image-changed` for this pane, and by a reconnect (a change may have
    // gone out while this client was away). Only ever grows, so every bump is a URL the browser
    // has not cached.
    const [generation, setGeneration] = useState(0);
    useEffect(() => {
        const bump = (): void => setGeneration((value) => value + 1);
        const offMessage = runtime.connection.on('message', (message) => {
            if (message['type'] === IMAGE_CHANGED_MESSAGE && message['paneID'] === paneID) bump();
        });
        // A pane mounted on a live connection has had its welcome: the next one is a reconnect.
        let welcomed = (runtime.connection as { readonly isConnected?: boolean }).isConnected === true;
        const offWelcome = runtime.connection.on('welcome', () => {
            if (welcomed) bump();
            welcomed = true;
        });
        return () => {
            offMessage();
            offWelcome();
        };
    }, [runtime, paneID]);

    const target = (runtime.connection as { readonly target?: string }).target;
    const base = useMemo(
        () => (name === '' || target === undefined ? null : paneFileURL(target, paneID, name)),
        [target, paneID, name]
    );
    const src = base === null ? null : generation === 0 ? base : `${base}?v=${generation}`;

    // What is on screen. A new `src` decodes off screen first and replaces it only once it has,
    // so a reload never flashes the pane empty; a failed reload keeps the last good pixels.
    const [shown, setShown] = useState<Loaded | null>(null);
    const [failed, setFailed] = useState<string | null>(null);
    useEffect(() => {
        if (src === null) return;
        let cancelled = false;
        const probe = new Image();
        probe.decoding = 'async';
        probe.onload = () => {
            if (cancelled) return;
            setShown({ src, width: probe.naturalWidth, height: probe.naturalHeight });
            setFailed(null);
        };
        probe.onerror = () => {
            if (cancelled) return;
            setFailed(src);
        };
        probe.src = src;
        return () => {
            cancelled = true;
            probe.onload = null;
            probe.onerror = null;
        };
    }, [src]);

    const [zoom, setZoom] = useState<Zoom>('fit');

    // A different file is a different image: never show the last one's pixels under its name.
    const lastFile = useRef(filePath);
    useEffect(() => {
        if (lastFile.current === filePath) return;
        lastFile.current = filePath;
        setShown(null);
        setFailed(null);
        setZoom('fit');
    }, [filePath]);

    const viewportRef = useRef<HTMLDivElement | null>(null);
    const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);
    useLayoutEffect(() => {
        const element = viewportRef.current;
        if (element === null || typeof ResizeObserver === 'undefined') return;
        const measure = (): void => setViewport({ width: element.clientWidth, height: element.clientHeight });
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [shown !== null]);

    // How much fit shrinks the image; null when it is not known or nothing is shrunk.
    const fitScale =
        shown === null || viewport === null || shown.width === 0 || shown.height === 0
            ? null
            : Math.min(1, viewport.width / shown.width, viewport.height / shown.height);
    const shrunk = fitScale !== null && fitScale < 1;

    // The pane's keyboard home, so ⌘W and friends reach the app rather than the last terminal.
    const claimable = props.focused === true && props.visible !== false && props.phone !== true && mayClaimPaneCaret();
    useEffect(() => {
        if (!claimable) return;
        const element = viewportRef.current;
        return armCaretClaim(element, () => element?.focus({ preventScroll: true }));
    }, [claimable, shown !== null]);

    const onMouseDown = (event: MouseEvent<HTMLDivElement>): void => {
        if (event.button !== 0) return;
        props.onFocusRequest?.(paneID);
        if (props.phone !== true && mayClaimPaneCaret()) viewportRef.current?.focus({ preventScroll: true });
    };

    const onClick = (event: MouseEvent<HTMLDivElement>): void => {
        if (event.button !== 0 || shown === null) return;
        if (zoom === 'actual') {
            setZoom('fit');
            return;
        }
        if (!shrunk) return;
        // Keep the clicked point under the pointer as the image grows to actual size.
        const element = viewportRef.current;
        const image = element?.querySelector('img');
        const box = image?.getBoundingClientRect();
        setZoom('actual');
        if (element === null || box === undefined || fitScale === null) return;
        const x = (event.clientX - box.left) / fitScale;
        const y = (event.clientY - box.top) / fitScale;
        const frame = element.getBoundingClientRect();
        requestAnimationFrame(() => {
            element.scrollLeft = x - (event.clientX - frame.left);
            element.scrollTop = y - (event.clientY - frame.top);
        });
    };

    if (filePath === null || name === '') {
        return <ContentStatus paneID={paneID} text="This image pane has no file." tone="error" />;
    }
    if (shown === null) {
        return failed === null ? (
            <ContentStatus paneID={paneID} text="" />
        ) : (
            <ContentStatus
                paneID={paneID}
                text={`Can't show ${name}: the file is missing, or it is not an image Kelpi can draw.`}
                tone="error"
            />
        );
    }

    const actual = zoom === 'actual';
    return (
        <div
            data-testid={`image-pane-${paneID}`}
            data-zoom={zoom}
            className="relative h-full w-full"
            style={{ background: props.background ?? CONTENT_PANE_BACKGROUND }}
        >
            <div
                ref={viewportRef}
                tabIndex={-1}
                role="img"
                aria-label={name}
                {...{ [PANE_SURFACE_ATTR]: '' }}
                onMouseDown={onMouseDown}
                onClick={onClick}
                className={`h-full w-full outline-none ${actual ? 'overflow-auto' : 'overflow-hidden'}`}
                style={{ cursor: actual ? 'zoom-out' : shrunk ? 'zoom-in' : 'default' }}
            >
                <div
                    className="flex items-center justify-center"
                    style={actual ? { minWidth: '100%', minHeight: '100%', width: 'max-content' } : { width: '100%', height: '100%' }}
                >
                    <img
                        data-testid={`image-pane-img-${paneID}`}
                        src={shown.src}
                        alt=""
                        draggable={false}
                        className="block select-none"
                        style={
                            actual
                                ? { width: shown.width, height: shown.height, maxWidth: 'none' }
                                : { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }
                        }
                    />
                </div>
            </div>
            <div
                data-testid={`image-pane-caption-${paneID}`}
                className="pointer-events-none absolute bottom-1.5 right-2 rounded px-1.5 py-0.5 text-[10px] tabular-nums"
                style={{ color: tokens.textSecondary, background: tokens.headerBackground, border: `1px solid ${tokens.divider}`, opacity: 0.9 }}
            >
                {failed !== null ? `${name} could not be reloaded` : imageCaption(shown.width, shown.height, actual ? null : fitScale)}
            </div>
        </div>
    );
}
