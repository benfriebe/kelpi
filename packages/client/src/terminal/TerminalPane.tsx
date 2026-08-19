/**
 * One terminal pane: a renderer engine bound to one daemon PTY stream (WP3.2).
 *
 * Props-driven by construction — it takes the PTY API and the pane's UI state and never reads
 * the store, so the grid, a fixture test and the Electron shell all drive it the same way.
 *
 * Lifecycle (terminal-surface.md §4–§6):
 *
 *   mount        create the renderer, subscribe to the pane's stream, ingest the daemon's
 *                replay snapshot first and live bytes after (`ingest.ts`)
 *   input        engine `onData` → `handle.write` (bytes upstream; the daemon owns encoding
 *                for everything programmatic)
 *   resize       ResizeObserver → measure the body → cols/rows from the engine's cell metrics
 *                → **debounced 100 ms** → `handle.resize` (one SIGWINCH, not a storm), with a
 *                zero-size guard and an immediate "initial-size rescue" once the engine opens
 *   visible=false the renderer stays alive and idle: no measuring, no resize traffic, no focus
 *   visible=true  re-measure and repaint after layout settles (also on tab visibilitychange /
 *                window focus — the `resyncVisibleSurfaces()` equivalent)
 *   focus        `focused` drives engine focus, politely: never steal the caret from a text
 *                field that is mid-edit; a click anywhere in the pane raises `onFocusRequest`
 *   unmount      dispose the engine + detach the stream. Only pane close / mount-policy
 *                eviction unmounts; the daemon keeps the PTY and replays on re-attach.
 */

import { memo, useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import type { PtyStreamHandle, PtySubscription } from '../connection';
import { createTerminalIngest } from './ingest';
import {
    createTerminalRenderer,
    resolveTerminalTheme,
    type TerminalRenderer,
    type TerminalRendererFactory,
    type TerminalTheme
} from './renderer';

/** Coalescing window for interactive resizes (terminal-surface.md §5, §15.4). */
export const DEFAULT_RESIZE_DEBOUNCE_MS = 100;

export interface TerminalGeometry {
    readonly cols: number;
    readonly rows: number;
}

/**
 * The slice of `PtyClient` a pane needs — structural, so a fake is three lines in a test.
 *
 * Must be **identity-stable**: a new `ptyApi` (or a new `paneID`) tears the engine down and
 * re-attaches, which is the eviction path, not something a parent re-render should trigger.
 */
export interface TerminalPtyApi {
    subscribe(paneID: string, subscription: PtySubscription): PtyStreamHandle;
}

export interface TerminalPaneProps {
    readonly paneID: string;
    readonly ptyApi: TerminalPtyApi;
    /** This pane holds keyboard focus in the active workspace. */
    readonly focused: boolean;
    /** On screen. False keeps the renderer alive but idle (workspace switch, zoom, tab hidden). */
    readonly visible: boolean;
    /** Explicit palette; otherwise resolved from the `--nex-term-*` custom properties. */
    readonly theme?: TerminalTheme | undefined;
    /**
     * Fill painted behind the engine canvas. Defaults to the theme's background (an opaque
     * hex, which is what the engines require), but assembly passes the ghostty background at
     * the ghostty OPACITY — `rgba(r,g,b,a)` — so a sub-1.0 config composites through to the
     * window exactly as it does for markdown/diff panes (content-panes.md §3.8).
     */
    readonly background?: string | undefined;
    /** A click in the pane wants focus; assembly turns this into a daemon focus report. */
    readonly onFocusRequest?: ((paneID: string) => void) | undefined;
    readonly fontFamily?: string | undefined;
    readonly fontSize?: number | undefined;
    /** Engine override (tests inject a fake; the app uses `VITE_TERMINAL_ENGINE`). */
    readonly createRenderer?: TerminalRendererFactory | undefined;
    readonly resizeDebounceMs?: number | undefined;
    /** Measured grid, for the resize badge (`grid/types.ts` `PaneDimensions`). */
    readonly onDimensionsChange?: ((paneID: string, geometry: TerminalGeometry) => void) | undefined;
    readonly onExit?: ((paneID: string, exitCode: number | null, signal?: string) => void) | undefined;
    readonly onBell?: ((paneID: string) => void) | undefined;
    readonly onTitleChange?: ((paneID: string, title: string) => void) | undefined;
    /** Body measurement seam; defaults to `clientWidth`/`clientHeight`. */
    readonly measure?: ((element: HTMLElement) => { width: number; height: number }) | undefined;
    readonly className?: string | undefined;
}

/** Cols/rows from the body box and the engine's cell metrics; `null` for a zero-size pass. */
export function measureGeometry(
    element: HTMLElement,
    renderer: TerminalRenderer,
    measure?: ((element: HTMLElement) => { width: number; height: number }) | undefined
): TerminalGeometry | null {
    const box = measure?.(element) ?? { width: element.clientWidth, height: element.clientHeight };
    if (!Number.isFinite(box.width) || !Number.isFinite(box.height)) return null;
    if (box.width <= 0 || box.height <= 0) return null;
    const cell = renderer.cellSize();
    if (cell.width <= 0 || cell.height <= 0) return null;
    const cols = Math.max(1, Math.floor(box.width / cell.width));
    const rows = Math.max(1, Math.floor(box.height / cell.height));
    return { cols, rows };
}

/**
 * Polite focus (terminal-surface.md §6): a (re)mounting pane grabs the caret unless a text
 * editor outside it currently holds it — a sidebar rename or the command palette must survive
 * a grid re-render.
 */
export function shouldGrabFocus(host: HTMLElement | null): boolean {
    if (typeof document === 'undefined') return true;
    const active = document.activeElement;
    if (active === null || active === document.body) return true;
    if (host !== null && host.contains(active)) return true;
    const tag = active.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return false;
    return !(active instanceof HTMLElement && active.isContentEditable);
}

type PaneStatus = 'loading' | 'live' | 'error';

function TerminalPaneImpl(props: TerminalPaneProps): ReactElement {
    const { paneID, ptyApi, focused, visible, theme, className } = props;

    const latest = useRef(props);
    useEffect(() => {
        latest.current = props;
    });

    const hostRef = useRef<HTMLDivElement | null>(null);
    const rendererRef = useRef<TerminalRenderer | null>(null);
    const streamRef = useRef<PtyStreamHandle | null>(null);
    const geometryRef = useRef<TerminalGeometry | null>(null);
    const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [status, setStatus] = useState<PaneStatus>('loading');

    const clearResizeTimer = useCallback((): void => {
        if (resizeTimer.current === null) return;
        clearTimeout(resizeTimer.current);
        resizeTimer.current = null;
    }, []);

    /** Measure → engine → daemon. `force` bypasses the unchanged-geometry short circuit. */
    const syncGeometry = useCallback((force = false): void => {
        const renderer = rendererRef.current;
        const host = hostRef.current;
        if (renderer === null || host === null) return;
        const current = latest.current;
        if (!current.visible) return; // idle while hidden; the daemon keeps draining the PTY
        const next = measureGeometry(host, renderer, current.measure);
        if (next === null) return; // zero-size guard
        const previous = geometryRef.current;
        const unchanged = previous !== null && previous.cols === next.cols && previous.rows === next.rows;
        if (unchanged && !force) return;
        geometryRef.current = next;
        renderer.resize(next.cols, next.rows);
        streamRef.current?.resize(next.cols, next.rows);
        if (!unchanged || force) current.onDimensionsChange?.(current.paneID, next);
    }, []);

    const scheduleGeometrySync = useCallback((): void => {
        clearResizeTimer();
        const delay = latest.current.resizeDebounceMs ?? DEFAULT_RESIZE_DEBOUNCE_MS;
        resizeTimer.current = setTimeout(() => {
            resizeTimer.current = null;
            syncGeometry();
        }, delay);
    }, [clearResizeTimer, syncGeometry]);

    // ── engine + stream lifecycle ───────────────────────────────────────────────────
    useEffect(() => {
        const host = hostRef.current;
        if (host === null) return;
        const current = latest.current;
        const factory = current.createRenderer ?? createTerminalRenderer;
        const renderer = factory({
            ...(current.fontFamily !== undefined ? { fontFamily: current.fontFamily } : {}),
            ...(current.fontSize !== undefined ? { fontSize: current.fontSize } : {}),
            theme: current.theme ?? resolveTerminalTheme(host)
        });
        rendererRef.current = renderer;
        setStatus('loading');

        const ingest = createTerminalIngest(renderer);
        const initial = measureGeometry(host, renderer, current.measure);
        if (initial !== null) geometryRef.current = initial;

        const subscription: PtySubscription = {
            // The daemon replays the server-side VT snapshot before going live; ingest keeps
            // that ordering true across engine load, reconnect and flow-control resync.
            onReplay: (data) => ingest.replay(data),
            onData: (data) => ingest.live(data),
            onResync: () => ingest.expectReplay(),
            onExit: (exitCode, signal) => latest.current.onExit?.(paneID, exitCode, signal),
            ...(initial !== null ? { cols: initial.cols, rows: initial.rows } : {})
        };
        const stream = ptyApi.subscribe(paneID, subscription);
        streamRef.current = stream;

        const offData = renderer.onData((data) => stream.write(data));
        const offBell = renderer.onBell(() => latest.current.onBell?.(paneID));
        const offTitle = renderer.onTitleChange((title) => latest.current.onTitleChange?.(paneID, title));

        let cancelled = false;
        void renderer.open(host).then(
            () => {
                if (cancelled) return;
                setStatus('live');
                // Real cell metrics exist only now: first non-zero pass forces a size sync.
                syncGeometry(true);
                if (latest.current.focused && latest.current.visible && shouldGrabFocus(host)) renderer.focus();
            },
            () => {
                if (cancelled) return;
                setStatus('error');
            }
        );

        return () => {
            cancelled = true;
            clearResizeTimer();
            offData();
            offBell();
            offTitle();
            stream.unsubscribe();
            renderer.dispose();
            rendererRef.current = null;
            streamRef.current = null;
            geometryRef.current = null;
        };
        // `fontFamily` / `fontSize` are in the deps on purpose: the engines take a font at
        // construction and the adapter's xterm-compatible subset has no live setter, so a
        // ghostty-config font change rebuilds the engine. That is cheap and safe — the daemon
        // owns the VT, so re-attaching replays the screen (this is the same path a workspace
        // eviction takes). Settings arrive on `welcome`, BEFORE the first snapshot renders a
        // pane, so connecting never costs a rebuild.
    }, [paneID, ptyApi, clearResizeTimer, syncGeometry, props.fontFamily, props.fontSize]);

    // ── resize observation ──────────────────────────────────────────────────────────
    useEffect(() => {
        const host = hostRef.current;
        if (host === null) return;
        if (typeof ResizeObserver === 'undefined') {
            // jsdom / very old browsers: window resize is the only signal available.
            const onResize = (): void => scheduleGeometrySync();
            window.addEventListener('resize', onResize);
            return () => window.removeEventListener('resize', onResize);
        }
        const observer = new ResizeObserver(() => scheduleGeometrySync());
        observer.observe(host);
        return () => observer.disconnect();
    }, [scheduleGeometrySync]);

    // ── visibility ──────────────────────────────────────────────────────────────────
    useEffect(() => {
        if (!visible) {
            // Idle: drop any in-flight resize so a hidden pane never talks to the daemon.
            clearResizeTimer();
            return;
        }
        // Re-entering the visible hierarchy: re-assert size and repaint once layout settles.
        const timer = setTimeout(() => {
            syncGeometry(true);
            rendererRef.current?.repaint();
        }, 0);
        return () => clearTimeout(timer);
    }, [visible, clearResizeTimer, syncGeometry]);

    useEffect(() => {
        if (typeof document === 'undefined') return;
        const resync = (): void => {
            if (document.visibilityState === 'hidden') return;
            if (!latest.current.visible) return;
            syncGeometry(true);
            rendererRef.current?.repaint();
        };
        document.addEventListener('visibilitychange', resync);
        window.addEventListener('focus', resync);
        return () => {
            document.removeEventListener('visibilitychange', resync);
            window.removeEventListener('focus', resync);
        };
    }, [syncGeometry]);

    // ── focus ───────────────────────────────────────────────────────────────────────
    useEffect(() => {
        const renderer = rendererRef.current;
        if (renderer === null) return;
        if (focused && visible) {
            if (shouldGrabFocus(hostRef.current)) renderer.focus();
            return;
        }
        if (!focused) renderer.blur();
    }, [focused, visible, status]);

    // ── theme ───────────────────────────────────────────────────────────────────────
    useEffect(() => {
        if (theme === undefined) return;
        rendererRef.current?.setTheme(theme);
    }, [theme]);

    const requestFocus = useCallback((): void => {
        const current = latest.current;
        current.onFocusRequest?.(current.paneID);
    }, []);

    const background = props.background ?? theme?.background ?? 'var(--nex-term-bg, #0A0A0C)';

    return (
        <div
            data-pane-id={paneID}
            data-terminal-status={status}
            data-terminal-visible={visible ? 'true' : 'false'}
            className={`relative h-full w-full overflow-hidden ${className ?? ''}`}
            style={{ backgroundColor: background, visibility: visible ? 'visible' : 'hidden' }}
            onMouseDownCapture={requestFocus}
            onTouchStartCapture={requestFocus}
        >
            <div ref={hostRef} className="h-full w-full" data-terminal-host="" aria-label={`terminal ${paneID}`} />
            {status === 'error' ? (
                <div
                    role="status"
                    className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-center text-xs"
                    style={{ color: 'var(--nex-fg-secondary, #9A9AA0)' }}
                >
                    terminal renderer failed to start
                </div>
            ) : null}
        </div>
    );
}

/** Identity-stable: the grid re-renders constantly and a pane must not remount for it. */
export const TerminalPane = memo(TerminalPaneImpl);
TerminalPane.displayName = 'TerminalPane';
