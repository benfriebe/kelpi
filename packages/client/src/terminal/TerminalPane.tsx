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
import { loadTerminalFonts, onTerminalFontsReady, terminalFontsReady } from './fonts';
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

/**
 * The longest a CONTINUOUS resize may go without a sync — the debounce's ceiling.
 *
 * A pure trailing debounce starves under a gesture that never stops: dragging a divider fires a
 * `ResizeObserver` callback every frame, each one pushing the timer out again, so the engine,
 * the PTY and the grid's `cols × rows` overlay all kept the pre-drag numbers until the mouse
 * came to rest (run-B L5 — the one piece of feedback the overlay exists to give was wrong for
 * the whole gesture). With a ceiling the geometry is republished ~10×/s while the drag runs,
 * which is what a native terminal does, and a settled resize still coalesces exactly as before.
 */
export const RESIZE_MAX_WAIT_MS = 100;

/**
 * Horizontal breathing room between the pane edge and column 1, in CSS pixels.
 *
 * Two jobs: it keeps the focus ring off the first and last columns (see the pane root's style),
 * and it is the same `window-padding-x = 2` ghostty applies by default, so a terminal here is
 * spaced like a terminal in the Swift app. Applied to the pane root, NOT to the host the
 * geometry is measured from, so cols stay honest.
 */
export const TERMINAL_EDGE_PADDING = 2;

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
    /** Ceiling on the debounce during a continuous gesture; defaults to `RESIZE_MAX_WAIT_MS`. */
    readonly resizeMaxWaitMs?: number | undefined;
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
    /** When the current run of coalesced resizes started (null = nothing pending). */
    const pendingResizeSince = useRef<number | null>(null);
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

    /**
     * Trailing debounce with a ceiling: a burst coalesces, but a gesture that never stops still
     * publishes its geometry every `RESIZE_MAX_WAIT_MS` (see the constant — run-B L5).
     */
    const scheduleGeometrySync = useCallback((): void => {
        const delay = latest.current.resizeDebounceMs ?? DEFAULT_RESIZE_DEBOUNCE_MS;
        const maxWait = latest.current.resizeMaxWaitMs ?? Math.max(delay, RESIZE_MAX_WAIT_MS);
        const now = Date.now();
        if (pendingResizeSince.current === null) pendingResizeSince.current = now;
        if (now - pendingResizeSince.current >= maxWait) {
            clearResizeTimer();
            pendingResizeSince.current = null;
            syncGeometry();
            return;
        }
        clearResizeTimer();
        resizeTimer.current = setTimeout(() => {
            resizeTimer.current = null;
            pendingResizeSince.current = null;
            syncGeometry();
        }, delay);
    }, [clearResizeTimer, syncGeometry]);

    // ── engine + stream lifecycle ───────────────────────────────────────────────────
    //
    // Mount is one ordered chain, and the FONT is its first link (`fonts.ts`):
    //
    //   font ready → measure the box → construct the engine AT that grid → attach at the same
    //   grid → the daemon sizes the PTY + its VT, snapshots, and replays → paint.
    //
    // Two links used to be missing, and both are visible defects. Measuring before the bundled
    // face has loaded measures the FALLBACK metrics, so the pane attaches with columns the
    // engine cannot draw (the p10k filler runs past the right edge, the timestamp is clipped).
    // Constructing the engine without the measured grid leaves it at its 80×24 default, so the
    // replay is parsed at 80 columns and then REFLOWED by the first resize — the stack of
    // half-width prompt copies a re-attach used to paint.
    useEffect(() => {
        const host = hostRef.current;
        if (host === null) return;
        let cancelled = false;
        let teardown: (() => void) | null = null;

        const start = (): void => {
            if (cancelled || hostRef.current === null) return;
            const current = latest.current;
            const factory = current.createRenderer ?? createTerminalRenderer;
            const renderer = factory({
                ...(current.fontFamily !== undefined ? { fontFamily: current.fontFamily } : {}),
                ...(current.fontSize !== undefined ? { fontSize: current.fontSize } : {}),
                theme: current.theme ?? resolveTerminalTheme(host)
            });
            // Measured through the renderer's own cell metrics, which before `open()` are the
            // font-derived estimate — now accurate, because the face has loaded.
            const initial = measureGeometry(host, renderer, current.measure);
            if (initial !== null) renderer.resize(initial.cols, initial.rows);
            rendererRef.current = renderer;
            setStatus('loading');

            const ingest = createTerminalIngest(renderer);
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

            void renderer.open(host).then(
                () => {
                    if (cancelled) return;
                    setStatus('live');
                    // The engine's real metrics exist only now; a disagreement with the
                    // estimate is corrected here, before anything else can measure.
                    syncGeometry(true);
                    if (latest.current.focused && latest.current.visible && shouldGrabFocus(host)) renderer.focus();
                },
                (error: unknown) => {
                    if (cancelled) return;
                    // Say WHY. The placeholder ("terminal renderer failed to start") is all a
                    // person gets, and this rejection used to be swallowed — which is why the
                    // audit's one intermittent occurrence of it (run-F step 14, a pane revealed
                    // by `nex workspace create`) arrived with zero renderer console output and
                    // no cause to chase. The next one names itself.
                    console.error(`[nex] terminal renderer failed to start for pane ${paneID}`, error);
                    setStatus('error');
                }
            );

            teardown = () => {
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
        };

        // Kick the load (idempotent), THEN ask whether it settled synchronously — it does
        // wherever there is no FontFaceSet to wait on (jsdom, an old browser), and it does for
        // every pane after the first. Only a genuinely pending fetch costs a microtask hop, so
        // mounting stays synchronous everywhere it can be.
        const fonts = loadTerminalFonts(latest.current.fontSize);
        if (terminalFontsReady()) start();
        else void fonts.then(start, start);

        return () => {
            cancelled = true;
            teardown?.();
            teardown = null;
        };
        // `fontFamily` / `fontSize` are in the deps on purpose: the engines take a font at
        // construction and the adapter's xterm-compatible subset has no live setter, so a
        // ghostty-config font change rebuilds the engine. That is cheap and safe — the daemon
        // owns the VT, so re-attaching replays the screen (this is the same path a workspace
        // eviction takes). Settings arrive on `welcome`, BEFORE the first snapshot renders a
        // pane, so connecting never costs a rebuild.
    }, [paneID, ptyApi, clearResizeTimer, syncGeometry, props.fontFamily, props.fontSize]);

    // ── late font arrival ───────────────────────────────────────────────────────────
    //
    // A pane that had to open before the bundled face arrived (a slow link — the wait is
    // bounded, `fonts.ts`) measured its cell against the FALLBACK, so its columns are wrong by
    // however much the two fonts' advances differ. When the real face settles, the engine
    // re-measures and the grid is recomputed, rather than staying wrong for the pane's life.
    useEffect(() => {
        return onTerminalFontsReady(() => {
            const renderer = rendererRef.current;
            if (renderer === null) return;
            renderer.remeasure?.();
            syncGeometry(true);
            renderer.repaint();
        });
    }, [syncGeometry]);

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
            style={{
                backgroundColor: background,
                visibility: visible ? 'visible' : 'hidden',
                // The focused pane's 2px ring (`grid/FocusRing.tsx`) is an `inset-0` overlay
                // drawn ON TOP of this element, so without an inset of its own the grid's first
                // and last columns are painted underneath it — at 6× zoom the `s` of `sh-3.2$`
                // is visibly missing its left stroke. Padding here (never on the host, whose
                // `clientWidth` IS the column arithmetic) shrinks the measured box first, so the
                // cols the PTY is told about stay exactly the cols the canvas can paint. It also
                // restores ghostty's own `window-padding-x = 2` default, which is the spacing
                // the Swift app had.
                paddingLeft: TERMINAL_EDGE_PADDING,
                paddingRight: TERMINAL_EDGE_PADDING
            }}
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
