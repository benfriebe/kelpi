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
 *   start fails  dispose the half-built engine, seal the byte stream and start over on a FRESH
 *                one after a short backoff (run-F N1); only an exhausted budget paints the
 *                placeholder, and the placeholder carries a Retry button onto the same path.
 */

import { memo, useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import { PANE_SURFACE_ATTR, releasePaneCaret, shouldGrabFocus, undoSurfaceAutoFocus } from '../app/pane-focus';
import type { PtyStreamHandle, PtySubscription } from '../connection';
import { loadTerminalFonts, onTerminalFontsReady, terminalFontsReady } from './fonts';
import { createTerminalIngest } from './ingest';
import { createKittyKeyboard, sanitizeKittyFlags, type KittyKeyboard } from './kitty-keyboard';
import {
    IDLE_PANE_MODES,
    createMouseReporter,
    type MouseGridMetrics,
    type MouseReporter,
    type PaneVtModes
} from './mouse';
import {
    createTerminalRenderer,
    resolveTerminalTheme,
    type TerminalMatchLocation,
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

/**
 * How many times a pane will build an engine before it gives up and shows the placeholder
 * (run-F N1).
 *
 * ghostty-web 0.4 shares one WASM instance across every terminal in the tab, and a pane that
 * starts while another engine is mid-instantiation can have its first write land outside the
 * heap it was measured against — `RangeError: offset is out of bounds`, thrown from inside
 * `Uint8Array.set`. Two occurrences in four full audit runs, and it never recovered: one
 * rejected `open()` was terminal for the pane, so a user got a sentence where their shell
 * should be until they closed it.
 *
 * The failure is a *race*, so the same pane on a fresh engine almost always comes straight up.
 * The budget is per MOUNT, not per failure — deliberately: an engine that keeps dying after it
 * goes live would otherwise restart forever, and a placeholder with a Retry button is a better
 * answer to that than a pane that flickers. Retry resets the budget, because a person asking
 * again is new information.
 */
export const TERMINAL_START_ATTEMPTS = 3;

/** Backoff before rebuilding a failed engine; doubles per attempt (150 ms, then 300 ms). */
export const TERMINAL_START_RETRY_MS = 150;

/**
 * §N35 — how long after `open()` the pane keeps answering its ENGINE's own focus grabs.
 *
 * `Terminal.focus()` focuses the textarea and schedules the same focus again on a
 * `setTimeout(0)` backup (`vendor/ghostty-web-patched/source/lib/terminal.ts:844-860`), and
 * `open()` calls it unconditionally — so an unfocused pane grabs the caret at least twice, the
 * second time after any one-shot undo has run. The window is short and bounded: once the pane is
 * live every claim goes through the focus effect like any other.
 */
export const ENGINE_AUTOFOCUS_WINDOW_MS = 250;

/**
 * §TERM-036 — the surface's accessibility identity.
 *
 * `SurfaceView.swift:703-715` makes the terminal an accessibility ELEMENT with role
 * `.textArea` and `accessibilityHelp` "Terminal content area". The three clauses port one for
 * one, and the mapping is the only interesting part:
 *
 *   - **element**: an `NSView` opts in with `isAccessibilityElement`; a `<div>` opts in by
 *     carrying a `role`, which is what promotes it out of the generic-container bucket.
 *   - **role `.textArea`**: the ARIA spelling of `AXTextArea` is `role="textbox"` +
 *     `aria-multiline="true"` — Blink maps exactly that pair onto `NSAccessibilityTextAreaRole`
 *     on macOS, so a screen reader on the platform the Swift app targets hears the same word.
 *     `role="textbox"` alone is `AXTextField`, a single-line control, which a terminal is not.
 *   - **help text**: `accessibilityHelp` becomes the AX *description*. It is attached through
 *     `aria-describedby` → a visually-hidden span rather than `aria-description` (patchier
 *     support) or `title` (which would hang a tooltip over the whole grid).
 *
 * The NAME is the fourth clause, and the one that was wrong rather than missing: the surface
 * used to be labelled `terminal <uuid>`, which reads a 36-character id aloud and names nothing
 * a person can recognise. It now carries the pane's own header title.
 *
 * All four go on the pane ROOT, not on `[data-terminal-host]` — see the render, where the
 * reason (the engine owns the host's ARIA attributes) is spelled out.
 */
export const TERMINAL_ACCESSIBILITY_HELP = 'Terminal content area';

/**
 * The surface's accessible name: `Terminal — <what the pane header shows>`.
 *
 * Falls back to the bare word when assembly has no title yet (a pane that has not reported a
 * cwd, and every fixture test) — never to the pane id, which is the defect this replaces.
 */
export function terminalAccessibilityName(displayName?: string | undefined): string {
    const trimmed = (displayName ?? '').trim();
    return trimmed === '' ? 'Terminal' : `Terminal — ${trimmed}`;
}

/** Off-screen but readable by assistive tech — the `aria-describedby` target's style. */
const VISUALLY_HIDDEN = {
    position: 'absolute',
    width: '1px',
    height: '1px',
    margin: '-1px',
    padding: 0,
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
    border: 0
} as const;

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
    /**
     * §N17 — the `background` above is TRANSLUCENT, so the canvas must let it through.
     *
     * `background` has always been handed the ghostty colour at the ghostty opacity, and it has
     * always been painted for nothing under a terminal: the engine fills its canvas with an
     * opaque default background, so a 0.85 pane came out solid however transparent the window
     * and the fill behind it were. Passing this on tells the engine to CLEAR the default
     * background instead of filling it (`ghostty-web` `RendererOptions.allowTransparency`),
     * which leaves this element's `rgba()` as the single translucent layer over the desktop —
     * the composite `SurfaceView`'s libghostty surface produces natively in the shipped app.
     *
     * Assembly passes `backgroundOpacity < 1`, so at the default opacity the engine takes
     * exactly the code path it always did. Read at engine CONSTRUCTION, which is sound because
     * crossing 1.0 already needs a relaunch (the window's `transparent` flag is fixed at
     * creation — `shell/src/appearance.ts`); changes that stay below 1 only move the `rgba()`
     * alpha, which is a repaint of this element and needs no engine rebuild.
     */
    readonly allowTransparency?: boolean | undefined;
    /** A click in the pane wants focus; assembly turns this into a daemon focus report. */
    readonly onFocusRequest?: ((paneID: string) => void) | undefined;
    readonly fontFamily?: string | undefined;
    readonly fontSize?: number | undefined;
    /** Engine override (tests inject a fake; the app uses `VITE_TERMINAL_ENGINE`). */
    readonly createRenderer?: TerminalRendererFactory | undefined;
    readonly resizeDebounceMs?: number | undefined;
    /** Ceiling on the debounce during a continuous gesture; defaults to `RESIZE_MAX_WAIT_MS`. */
    readonly resizeMaxWaitMs?: number | undefined;
    /**
     * A terminal-search hit to scroll to and select (`grid/PaneSearchOverlay.tsx`).
     *
     * `seq` is what makes it fire: pressing Return on the SAME match must scroll back to it
     * after the user has scrolled away, and a value-equal object alone would not re-run the
     * effect. The daemon owns the search (`daemon/src/ws/search.ts`); this only shows the answer.
     */
    readonly reveal?: (TerminalMatchLocation & { readonly seq: number }) | null | undefined;
    /** Measured grid, for the resize badge (`grid/types.ts` `PaneDimensions`). */
    readonly onDimensionsChange?: ((paneID: string, geometry: TerminalGeometry) => void) | undefined;
    readonly onExit?: ((paneID: string, exitCode: number | null, signal?: string) => void) | undefined;
    readonly onBell?: ((paneID: string) => void) | undefined;
    readonly onTitleChange?: ((paneID: string, title: string) => void) | undefined;
    /**
     * The engine's selection changed (§TERM-034). Optional and unused by assembly today — the
     * capability is the READ; a browser has no system text service to report it to.
     */
    readonly onSelectionChange?: ((paneID: string, selection: string) => void) | undefined;
    /**
     * §TERM-036 — what a screen reader should call this pane, normally the same string the
     * pane header shows (`paneDisplayTitle`). Omitted ⇒ the bare word "Terminal".
     */
    readonly accessibilityName?: string | undefined;
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
 * The pane's grid as the mouse reporter needs it: cell metrics, the surface box, and where the
 * surface's top-left sits in client coordinates.
 *
 * The origin comes from the engine's own canvas when there is one (both engines draw into a
 * child of the host), so a renderer that insets itself does not shift every reported cell by
 * one. The box prefers the `measure` seam — the same one the column arithmetic uses, which is
 * what makes this measurable under jsdom, where `getBoundingClientRect()` is all zeros.
 */
export function measureMouseSurface(
    host: HTMLElement,
    renderer: TerminalRenderer,
    geometry: TerminalGeometry | null,
    measure?: ((element: HTMLElement) => { width: number; height: number }) | undefined
): (MouseGridMetrics & { originX: number; originY: number }) | null {
    const cell = renderer.cellSize();
    if (!(cell.width > 0) || !(cell.height > 0)) return null;
    const canvas = host.querySelector('canvas');
    const target: HTMLElement = canvas ?? host;
    const rect = target.getBoundingClientRect();
    const box = measure?.(host) ?? { width: rect.width, height: rect.height };
    if (!(box.width > 0) || !(box.height > 0)) return null;
    return {
        cols: geometry?.cols ?? Math.max(1, Math.floor(box.width / cell.width)),
        rows: geometry?.rows ?? Math.max(1, Math.floor(box.height / cell.height)),
        cellWidth: cell.width,
        cellHeight: cell.height,
        width: box.width,
        height: box.height,
        originX: rect.left,
        originY: rect.top
    };
}

/**
 * Polite focus (terminal-surface.md §6) — shared with the editor surfaces since N19, because
 * `SurfaceContainerView`'s `firstResponder is NSText` guard and the editors'
 * `releaseFirstResponderIfHeld` are two halves of one rule. See `app/pane-focus.ts`.
 */
export { shouldGrabFocus };

type PaneStatus = 'loading' | 'live' | 'error';

function TerminalPaneImpl(props: TerminalPaneProps): ReactElement {
    const { paneID, ptyApi, focused, visible, theme, className } = props;

    const latest = useRef(props);
    useEffect(() => {
        latest.current = props;
    });

    const hostRef = useRef<HTMLDivElement | null>(null);
    /**
     * §N24 — the pane's root node, so the resize→replay paint hold can be published without a
     * React render. A drag opens one window per debounce fire; re-rendering the pane twice per
     * fire to move a `data-` attribute would be a cost the defect does not justify.
     */
    const rootRef = useRef<HTMLDivElement | null>(null);
    const rendererRef = useRef<TerminalRenderer | null>(null);
    const streamRef = useRef<PtyStreamHandle | null>(null);
    const geometryRef = useRef<TerminalGeometry | null>(null);
    const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** When the current run of coalesced resizes started (null = nothing pending). */
    const pendingResizeSince = useRef<number | null>(null);
    const [status, setStatus] = useState<PaneStatus>('loading');
    /** Engine builds so far in this mount — surfaced on the root for the audit harness. */
    const [attempts, setAttempts] = useState(0);
    /**
     * §N17 — the `allowTransparency` the LIVE engine was actually built with.
     *
     * Not the prop: the option is read once, when the engine is constructed, so the prop and
     * the engine can disagree for the lifetime of a pane that was built before the daemon's
     * settings snapshot arrived. Recording what was passed is what makes
     * `data-terminal-transparent` an honest report rather than a restatement of the input.
     */
    const [engineTransparent, setEngineTransparent] = useState(false);
    /** Set by the mount effect; the placeholder's Retry button is the only other caller. */
    const restartRef = useRef<(() => void) | null>(null);

    // ── mouse reporting (§TERM-037…§TERM-039) ───────────────────────────────────────
    //
    // The daemon streams this pane's DEC mouse modes (`pane-modes`, off the same
    // `@xterm/headless` instance that owns the VT) and this layer turns pointer events into
    // reports — because NEITHER renderer does. `ghostty-web@0.4.0` parses 9/1000/1002/1003/1006
    // and ignores them, so a mouse-mode TUI had no mouse at all; xterm.js implements its own,
    // which would double-report, and is suppressed the same way the ghostty selection is: the
    // handlers run in the CAPTURE phase on the host and stop the event before the engine's
    // canvas listeners see it.
    const modesRef = useRef<PaneVtModes>(IDLE_PANE_MODES);
    /** Mirrors `modesRef` into the DOM so the audit can read the live mode off the pane. */
    const [trackingMode, setTrackingMode] = useState<PaneVtModes['mouseTracking']>('none');
    /** Characters currently selected in the engine (§TERM-034); mirrored to the DOM. */
    const [selectionLength, setSelectionLength] = useState(0);
    /**
     * `WxH` at 2 dp — the same `cellSize()` the reporter measures with, published so the audit
     * can compute the cell a pixel lands in and assert a mouse report byte for byte instead of
     * pattern-matching it. Written by `syncGeometry`, so it follows a late font too.
     */
    const [cellHint, setCellHint] = useState('');
    const mouseRef = useRef<MouseReporter | null>(null);
    if (mouseRef.current === null) {
        mouseRef.current = createMouseReporter({
            modes: () => modesRef.current,
            metrics: () => {
                const renderer = rendererRef.current;
                const host = hostRef.current;
                if (renderer === null || host === null) return null;
                return measureMouseSurface(host, renderer, geometryRef.current, latest.current.measure);
            },
            // Straight to the PTY, exactly as the engine's own `onData` goes: a mouse report is
            // input, and the daemon owns nothing about it.
            write: (data) => streamRef.current?.write(data)
        });
    }

    // ── kitty keyboard protocol (§TERM-030) ─────────────────────────────────────────
    //
    // Same shape, same reason, one wave later: the daemon negotiates the flags off the VT
    // stream (`daemon/src/term/kitty-keyboard.ts`, including the `CSI ? u` reply a real
    // terminal owes the PTY) and this layer encodes the key events — because the engine cannot.
    // It registers ONE `keydown` listener and ZERO `keyup` listeners, and never calls its own
    // `setKittyFlags`, so press/repeat/release is not something it could be made to do from
    // here. `encodeKittyKey` returns null for every key whose legacy encoding is already
    // correct, so with the protocol off (and for plain typing with it on) nothing below runs.
    /** Mirrors the live flags into the DOM so the audit can read them off the pane. */
    const [kittyFlags, setKittyFlags] = useState(0);
    /**
     * True between `compositionstart` and `compositionend`.
     *
     * `event.isComposing` is the primary guard, but it is false for the keydown that ARRIVES
     * first on some IMEs and for the one that terminates a composition on others, so the window
     * is tracked as well. A composed string is committed by `compositionend`, never by a key
     * event: encoding the keydowns that drive an IME would both double-write the text and hand
     * the application key codes for keystrokes that were never keys. This is §TERM-030's
     * "suppressed entirely while marked text exists", in the browser's vocabulary.
     */
    const composingRef = useRef(false);
    const kittyRef = useRef<KittyKeyboard | null>(null);
    if (kittyRef.current === null) {
        kittyRef.current = createKittyKeyboard({
            flags: () => modesRef.current.kittyKeyboardFlags ?? 0,
            write: (data) => streamRef.current?.write(data)
        });
    }

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
        const cell = renderer.cellSize();
        setCellHint(
            cell.width > 0 && cell.height > 0 ? `${cell.width.toFixed(2)}x${cell.height.toFixed(2)}` : ''
        );
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
        /** Engine builds so far in this mount — the retry budget (run-F N1). */
        let attempt = 0;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;

        const stop = (): void => {
            if (retryTimer !== null) {
                clearTimeout(retryTimer);
                retryTimer = null;
            }
            teardown?.();
            teardown = null;
        };

        /**
         * A start attempt failed. Tear the half-built engine down and go again on a fresh one;
         * only an exhausted budget flips the pane to the placeholder.
         *
         * A retried attempt is logged at `info`, not `error`: the pane recovered, and the audit
         * counts a renderer console error as a defect. The give-up is still an `error`, because
         * by then a person is looking at a sentence instead of their shell.
         */
        const failed = (error: unknown, phase: 'open' | 'engine'): void => {
            stop();
            if (cancelled) return;
            if (attempt < TERMINAL_START_ATTEMPTS) {
                console.info(
                    `[nex] terminal renderer ${phase === 'open' ? 'failed to start' : 'died'} for pane ${paneID} ` +
                        `(attempt ${String(attempt)}/${String(TERMINAL_START_ATTEMPTS)}) — rebuilding on a fresh engine`,
                    error
                );
                setStatus('loading');
                const backoff = TERMINAL_START_RETRY_MS * 2 ** (attempt - 1);
                retryTimer = setTimeout(() => {
                    retryTimer = null;
                    start();
                }, backoff);
                return;
            }
            // Say WHY. The placeholder ("terminal renderer failed to start") is all a person
            // gets, and this rejection used to be swallowed — which is why the audit's first
            // occurrence of it (run-F step 14, a pane revealed by `nex workspace create`)
            // arrived with zero renderer console output and no cause to chase.
            console.error(
                `[nex] terminal renderer failed to start for pane ${paneID} after ` +
                    `${String(attempt)} attempt(s)`,
                error
            );
            setStatus('error');
        };

        const start = (): void => {
            if (cancelled || hostRef.current === null) return;
            attempt += 1;
            setAttempts(attempt);
            const current = latest.current;
            const factory = current.createRenderer ?? createTerminalRenderer;
            const renderer = factory({
                ...(current.fontFamily !== undefined ? { fontFamily: current.fontFamily } : {}),
                ...(current.fontSize !== undefined ? { fontSize: current.fontSize } : {}),
                // §N17: only when assembly says the pane fill is translucent. Absent (a test
                // harness, a standalone mount) the engine keeps its opaque default background,
                // which is what every caller before this got.
                ...(current.allowTransparency === undefined
                    ? {}
                    : { allowTransparency: current.allowTransparency }),
                theme: current.theme ?? resolveTerminalTheme(host)
            });
            // §N17: report what the engine was BUILT with, not what the prop says now.
            setEngineTransparent(current.allowTransparency === true);
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
                // The daemon's VT modes for this pane: sent once behind the replay, then on
                // every DECSET/DECRST. Kept in a ref (the handlers are installed once and must
                // not go stale) and mirrored into state only for the `data-` attribute.
                onModes: (modes) => {
                    modesRef.current = modes;
                    setTrackingMode(modes.mouseTracking);
                    setKittyFlags(sanitizeKittyFlags(modes.kittyKeyboardFlags));
                    // An application that turns reporting off mid-gesture leaves us holding a
                    // button that will never be released as far as this layer is concerned.
                    if (modes.mouseTracking === 'none') mouseRef.current?.reset();
                },
                onExit: (exitCode, signal) => latest.current.onExit?.(paneID, exitCode, signal),
                ...(initial !== null ? { cols: initial.cols, rows: initial.rows } : {})
            };
            const stream = ptyApi.subscribe(paneID, subscription);
            streamRef.current = stream;

            const offData = renderer.onData((data) => stream.write(data));
            const offBell = renderer.onBell(() => latest.current.onBell?.(paneID));
            const offTitle = renderer.onTitleChange((title) => latest.current.onTitleChange?.(paneID, title));
            // §TERM-034: the engine's selection, surfaced. There is no `NSTextInputClient` in a
            // browser to hand it to, so what it buys is observability — and the invariant it
            // observes is §TERM-037's: while an application is being sent mouse reports the
            // engine must make NO selection, and the two can now be told apart.
            const offSelection = renderer.onSelectionChange((selection) => {
                setSelectionLength(selection.length);
                latest.current.onSelectionChange?.(paneID, selection);
            });
            // The engine threw from inside WASM after it was already live. It is poisoned and
            // takes no more bytes, so seal the stream off it and rebuild — an engine that dies
            // under a running shell is the same defect as one that dies while starting.
            const offFailure = renderer.onEngineFailure((error: unknown) => {
                if (cancelled) return;
                ingest.pause();
                failed(error, 'engine');
            });
            /**
             * §N24 — publish the resize→replay paint hold onto the root node.
             *
             * The invariant it makes observable is a pixel one, and it is the audit's whole
             * assertion: while this reads `true` the engine is suspended, so the canvas must
             * not change. `paint-hold-timeouts` rides along because a hold that ended on the
             * timeout instead of on a replay is the one case where the guarantee lapses.
             */
            const publishHold = (held: boolean): void => {
                const root = rootRef.current;
                if (root === null) return;
                root.setAttribute('data-terminal-paint-held', held ? 'true' : 'false');
                root.setAttribute('data-terminal-paint-hold-timeouts', String(renderer.paintHoldTimeouts));
            };
            publishHold(false);
            const offHold = renderer.onPaintHoldChange(publishHold);

            /**
             * §N35 — the engine focuses ITSELF, and the port has to be able to say no.
             *
             * `Terminal.open()` ends with `this.focus()` ("auto-focus so user can start typing
             * immediately", `vendor/ghostty-web-patched/source/lib/terminal.ts:636`), which is
             * a reasonable default for a page that hosts one terminal and wrong for a window
             * that hosts several. The Swift has no equivalent: a `ghostty_surface_t` does not
             * claim anything, `SurfaceContainerView` decides (`:146-156`). So the port lets the
             * grab happen and then undoes it unless THIS pane was entitled to it — and puts the
             * caret back where the engine took it from, which is the whole point: the element
             * it takes it from is the sidebar rename, the palette, or the pane the user is
             * actually in.
             *
             * Reachable without a reload (any pane opening beside a focused one) but a reload
             * is where it shows: every pane remounts at once, so the LAST engine to finish
             * loading its wasm ends up holding the keyboard, whichever pane wears the ring.
             *
             * It grabs TWICE, which is why the undo is a window and not a line. `Terminal.focus()`
             * focuses the textarea and then schedules the same focus again on a `setTimeout(0)`
             * — "a delayed focus as backup to ensure it sticks" (`terminal.ts:844-860`). A
             * one-shot undo catches the first and the backup lands after it, which is exactly
             * the shape the PACKAGED stack produced while the dev one stayed green: the same
             * code, a different engine-load order, and the caret ended on `<body>` with the ring
             * drawn elsewhere. So the undo stays armed for a short bounded window and answers
             * every grab in it.
             */
            const hostDocument = host.ownerDocument;
            let engineTookFrom: Element | null = hostDocument.activeElement;
            /*
             * Who holds the caret while this engine is loading. `focusin`'s own `relatedTarget`
             * would be the obvious source and is not portable enough to rest a caret on (jsdom
             * leaves it null), so the owner is tracked instead: the last element to take focus
             * from OUTSIDE this host, starting from whoever had it when the pane mounted. A
             * wasm load is long enough that a person can start a sidebar rename inside it.
             */
            const noteEngineGrab = (event: FocusEvent): void => {
                const target = event.target;
                if (target instanceof Element && !host.contains(target)) engineTookFrom = target;
            };
            hostDocument.addEventListener('focusin', noteEngineGrab, true);
            /** Every grab this engine makes while the window is open, answered the same way. */
            const answerEngineGrab = (): void => {
                if (cancelled) return;
                // Entitled after all (the pane gained focus while its engine was loading):
                // `shouldGrabFocus` passes trivially for a caret already inside this host.
                if (latest.current.focused && latest.current.visible && shouldGrabFocus(host)) return;
                undoSurfaceAutoFocus(host, engineTookFrom);
            };
            let closeUndoWindow: (() => void) | null = null;
            void renderer.open(host).then(
                () => {
                    if (cancelled) {
                        hostDocument.removeEventListener('focusin', noteEngineGrab, true);
                        return;
                    }
                    setStatus('live');
                    // The engine's real metrics exist only now; a disagreement with the
                    // estimate is corrected here, before anything else can measure.
                    syncGeometry(true);
                    if (latest.current.focused && latest.current.visible && shouldGrabFocus(host)) renderer.focus();
                    else undoSurfaceAutoFocus(host, engineTookFrom);
                    // …and the engine's own delayed backup, and anything else it does while it
                    // finishes coming up. Bounded: after this the pane is live and every claim
                    // goes through the focus effect like any other.
                    host.addEventListener('focusin', answerEngineGrab);
                    const timer = setTimeout(() => {
                        closeUndoWindow?.();
                    }, ENGINE_AUTOFOCUS_WINDOW_MS);
                    closeUndoWindow = () => {
                        closeUndoWindow = null;
                        clearTimeout(timer);
                        host.removeEventListener('focusin', answerEngineGrab);
                        hostDocument.removeEventListener('focusin', noteEngineGrab, true);
                    };
                },
                (error: unknown) => {
                    hostDocument.removeEventListener('focusin', noteEngineGrab, true);
                    if (cancelled) return;
                    // Seal the stream BEFORE the teardown: the daemon keeps sending, and a
                    // chunk that arrives between the rejection and the unsubscribe must not be
                    // handed to the engine that just failed.
                    ingest.pause();
                    failed(error, 'open');
                }
            );

            teardown = () => {
                // Idempotent: an engine still loading when the pane unmounts would otherwise
                // leave these attached until its promise settles.
                hostDocument.removeEventListener('focusin', noteEngineGrab, true);
                closeUndoWindow?.();
                clearResizeTimer();
                // A rebuilt engine re-attaches and is told its modes again; until then this
                // pane reports nothing rather than reporting against a dead stream.
                modesRef.current = IDLE_PANE_MODES;
                setTrackingMode('none');
                setKittyFlags(0);
                composingRef.current = false;
                setSelectionLength(0);
                mouseRef.current?.reset();
                ingest.pause();
                offData();
                offBell();
                offTitle();
                offSelection();
                offFailure();
                offHold();
                stream.unsubscribe();
                renderer.dispose();
                rendererRef.current = null;
                streamRef.current = null;
                geometryRef.current = null;
            };
        };

        // The placeholder's Retry button: a person asking again is new information, so the
        // budget starts over and the rebuild is immediate rather than backed off.
        restartRef.current = () => {
            if (cancelled) return;
            stop();
            attempt = 0;
            setStatus('loading');
            start();
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
            restartRef.current = null;
            stop();
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

    // ── mouse reporting: capture-phase interception ─────────────────────────────────
    //
    // Two sets of listeners, and the split is the whole trick:
    //
    //   host, capture   every event INSIDE the pane. Capture on the host means React's own
    //                   root-level dispatch has already run (so the wrapper's
    //                   `onMouseDownCapture` still reports focus, and `PaneGrid`'s still
    //                   focuses the pane), while the engine's canvas listeners — which sit
    //                   BELOW the host — never see the event at all once it is consumed.
    //   window, capture the rest of a drag that left the pane. Gated on `dragging` AND on the
    //                   event being outside the host, so an inside event is never handled
    //                   twice (window capture fires FIRST, and would swallow it).
    //
    // Nothing is intercepted while no application has asked for the mouse: with tracking
    // `none` every handler returns immediately and selection, link-clicks and the engine's own
    // wheel-scrolls behave exactly as they did.
    useEffect(() => {
        const host = hostRef.current;
        if (host === null || typeof window === 'undefined') return;
        const reporter = mouseRef.current;
        if (reporter === null) return;

        const consume = (event: Event): void => {
            event.preventDefault();
            event.stopPropagation();
        };
        const inside = (event: Event): boolean =>
            event.target instanceof Node && host.contains(event.target);

        const onDown = (event: MouseEvent): void => {
            if (!reporter.active || !inside(event)) return;
            if (!reporter.down(event)) return;
            consume(event);
            // Ghostty's rule (`Surface.zig:3850-3852`): once the application is being sent the
            // gesture, a selection left over from before it asked for the mouse must go — it
            // would otherwise sit highlighted over a TUI that is handling the same drag.
            rendererRef.current?.clearSelection();
            setSelectionLength(0);
        };
        const onMove = (event: MouseEvent): void => {
            if (!reporter.active || !inside(event)) return;
            if (reporter.move(event)) consume(event);
        };
        const onUp = (event: MouseEvent): void => {
            if (!reporter.active || !inside(event)) return;
            if (reporter.up(event)) consume(event);
        };
        const onWheel = (event: WheelEvent): void => {
            if (!reporter.active || !inside(event)) return;
            if (reporter.wheel(event)) consume(event);
        };
        // Outside the pane, mid-drag: a TUI that saw the press must see the motion and the
        // release wherever they happen, which is what makes drag-select inside `vim` work when
        // the pointer wanders over the sidebar.
        const onWindowMove = (event: MouseEvent): void => {
            if (!reporter.active || !reporter.dragging || inside(event)) return;
            if (reporter.move(event)) consume(event);
        };
        const onWindowUp = (event: MouseEvent): void => {
            if (!reporter.active || !reporter.dragging || inside(event)) return;
            if (reporter.up(event)) consume(event);
        };

        host.addEventListener('mousedown', onDown, true);
        host.addEventListener('mousemove', onMove, true);
        host.addEventListener('mouseup', onUp, true);
        // `passive: false` or `preventDefault()` is ignored and the page scrolls underneath.
        host.addEventListener('wheel', onWheel, { capture: true, passive: false });
        window.addEventListener('mousemove', onWindowMove, true);
        window.addEventListener('mouseup', onWindowUp, true);
        return () => {
            host.removeEventListener('mousedown', onDown, true);
            host.removeEventListener('mousemove', onMove, true);
            host.removeEventListener('mouseup', onUp, true);
            host.removeEventListener('wheel', onWheel, { capture: true });
            window.removeEventListener('mousemove', onWindowMove, true);
            window.removeEventListener('mouseup', onWindowUp, true);
            reporter.reset();
        };
    }, []);

    // ── kitty keyboard: capture-phase interception (§TERM-030) ──────────────────────
    //
    // Where these sit is the whole trick, and it is the same trick the mouse uses. The engine's
    // key listener lives on (or under) the hidden `<textarea>` it focuses, which is a DESCENDANT
    // of the host; a capture-phase listener on the HOST therefore runs first, and
    // `stopImmediatePropagation()` there means the event never reaches the target at all — the
    // engine loses. `preventDefault()` is the second half: without it the textarea would still
    // receive the character through `beforeinput`, and the key would be written twice.
    //
    // Above us, unaffected: the app's own key dispatcher is a WINDOW capture listener
    // (`chrome/keys.ts` `installKeyDispatcher`), so it has already run and already consumed
    // anything that is a Nex binding. A bound ⌘ chord can never reach this encoder.
    //
    // Nothing is intercepted while no application has negotiated the protocol: `keyboard.key()`
    // returns false for every event when the flags are zero, and for every key whose legacy
    // encoding is already correct even when they are not.
    useEffect(() => {
        const host = hostRef.current;
        if (host === null) return;
        const keyboard = kittyRef.current;
        if (keyboard === null) return;

        const composing = (event: KeyboardEvent): boolean =>
            composingRef.current || event.isComposing || event.keyCode === 229;

        const handle = (event: KeyboardEvent, type: 'keydown' | 'keyup'): void => {
            if (!keyboard.active) return;
            if (composing(event)) return;
            const consumed = keyboard.key({
                type,
                key: event.key,
                code: event.code,
                location: event.location,
                repeat: event.repeat,
                shiftKey: event.shiftKey,
                altKey: event.altKey,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey
            });
            if (!consumed) return;
            event.preventDefault();
            // Not `stopPropagation`: the engine may attach more than one listener to the same
            // node, and only the immediate form guarantees none of them runs.
            event.stopImmediatePropagation();
        };

        const onKeyDown = (event: KeyboardEvent): void => handle(event, 'keydown');
        const onKeyUp = (event: KeyboardEvent): void => handle(event, 'keyup');
        const onCompositionStart = (): void => {
            composingRef.current = true;
        };
        const onCompositionEnd = (): void => {
            composingRef.current = false;
        };

        host.addEventListener('keydown', onKeyDown, true);
        host.addEventListener('keyup', onKeyUp, true);
        host.addEventListener('compositionstart', onCompositionStart, true);
        host.addEventListener('compositionend', onCompositionEnd, true);
        return () => {
            host.removeEventListener('keydown', onKeyDown, true);
            host.removeEventListener('keyup', onKeyUp, true);
            host.removeEventListener('compositionstart', onCompositionStart, true);
            host.removeEventListener('compositionend', onCompositionEnd, true);
            composingRef.current = false;
        };
    }, []);

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
            /*
             * N15 — the caret comes back with the window.
             *
             * A window that has just taken focus (a Dock click, ⌘Tab, a window REBUILT after a
             * close) has a live DOM but nothing holding the caret, and the focus effect below
             * only runs when `focused`/`visible`/`status` change — none of which they do when
             * the OS hands the window back. The result is a window that renders and takes no
             * keystrokes at all, which is the half of N15 that lives in the page.
             *
             * `shouldGrabFocus` is the same politeness the mount path uses: a sidebar rename,
             * the palette or any other chrome field that holds the caret keeps it.
             */
            if (latest.current.focused === true && shouldGrabFocus(hostRef.current)) {
                rendererRef.current?.focus();
            }
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
        if (!focused) {
            renderer.blur();
            /*
             * N19 — and let the caret GO, which `renderer.blur()` does not do.
             *
             * ghostty-web's `blur()` blurs the CONTAINER (`terminal.ts:808-812`), while its
             * `focus()` focuses the hidden `<textarea>` inside it, so a pane that lost focus
             * went on holding the DOM caret indefinitely. Everything downstream then read the
             * window as "a text field is focused": the next surface's `shouldGrabFocus` said
             * no, and a scratchpad created with ⇧⌘N got the focus ring and no caret.
             *
             * This is the port of `ScratchpadEditorView.swift:113-115` /
             * `MarkdownEditorView.swift:107-111` `releaseFirstResponderIfHeld`, which exists in
             * the Swift for exactly this reason ("so the next pane's focus claim isn't
             * blocked"). It only ever blurs a node inside THIS host, so a claim that already
             * landed elsewhere in the same commit is never undone — which is what makes the
             * two panes' effects order-independent.
             */
            releasePaneCaret(hostRef.current);
        }
    }, [focused, visible, status]);

    // ── surface focus, i.e. the CURSOR's focus (§N20) ───────────────────────────────
    //
    // The port of `ghostty_surface_set_focus`, and deliberately not folded into the effect
    // above: that one moves the DOM caret and is POLITE about it (a rename field mid-edit keeps
    // it), while this one is a statement of fact — "this pane is/isn't the focused surface" —
    // that has to reach the engine whether or not the caret moved. libghostty draws the
    // difference: the focused surface's cursor is the one the terminal asked for, blinking if
    // it asked for that, and every other surface's is a steady hollow block
    // (`src/renderer/cursor.zig:59-60`). Without this every pane on screen blinked a filled
    // block, which is what the owner reported.
    //
    // The WINDOW is part of the answer, which is the half a browser makes easy to miss. AppKit
    // does not resign a view's first-responder status when its window stops being key, so
    // ghostty computes surface focus as `window.isKeyWindow && … && isFirstResponder`
    // (`BaseTerminalController.syncFocusToSurfaceTree`) — a Nex window sent to the background
    // has NO blinking cursor in it. `window` focus/blur is the browser's `isKeyWindow`, and
    // `document.hasFocus()` seeds it for a pane that mounts into an already-background window.
    //
    // One deliberate simplification, recorded so it reads as a decision: ghostty's third term is
    // `isFirstResponder`, so in the Swift app a sidebar rename or the palette taking the caret
    // ALSO hollows the pane's cursor. Here the pane's own focus is used instead — the same input
    // the focus RING is drawn from — so an overlay that borrows the caret leaves the ring and the
    // cursor agreeing with each other. Following the DOM's `activeElement` instead would mean
    // re-deciding on every focusin/focusout, including the transient blurs the engine's own copy
    // path performs, for a difference visible only while a chrome field is mid-edit.
    const [windowFocused, setWindowFocused] = useState<boolean>(() =>
        typeof document === 'undefined' ? true : document.hasFocus()
    );
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const gained = (): void => setWindowFocused(true);
        const lost = (): void => setWindowFocused(false);
        window.addEventListener('focus', gained);
        window.addEventListener('blur', lost);
        // Re-seed on mount: the window may have lost focus between the initial state and here.
        setWindowFocused(document.hasFocus());
        return () => {
            window.removeEventListener('focus', gained);
            window.removeEventListener('blur', lost);
        };
    }, []);

    const surfaceFocused = focused && visible && windowFocused;
    useEffect(() => {
        // `status` is in the deps for the same reason the focus effect has it: a restart builds
        // a FRESH engine (which defaults to focused), and it has to be told again.
        rendererRef.current?.setSurfaceFocus(surfaceFocused);
    }, [surfaceFocused, status]);

    // ── theme ───────────────────────────────────────────────────────────────────────
    useEffect(() => {
        if (theme === undefined) return;
        rendererRef.current?.setTheme(theme);
    }, [theme]);

    // ── search reveal ───────────────────────────────────────────────────────────────
    //
    // Keyed on `seq`, not on the coordinates: pressing Return on the same match again has to
    // scroll back to it, and the engine may not be up yet on the first hit (a pane that just
    // mounted), so the effect also re-runs when the renderer goes live.
    const revealSeq = props.reveal?.seq ?? 0;
    useEffect(() => {
        const match = latest.current.reveal;
        if (match === null || match === undefined || match.seq === 0) return;
        if (status !== 'live') return;
        rendererRef.current?.revealMatch({
            linesFromBottom: match.linesFromBottom,
            col: match.col,
            length: match.length
        });
    }, [revealSeq, status]);

    const requestFocus = useCallback((): void => {
        const current = latest.current;
        current.onFocusRequest?.(current.paneID);
    }, []);

    const retryStart = useCallback((): void => {
        restartRef.current?.();
    }, []);

    const background = props.background ?? theme?.background ?? 'var(--nex-term-bg, #0A0A0C)';


    return (
        <div
            ref={rootRef}
            data-pane-id={paneID}
            data-terminal-status={status}
            data-terminal-attempts={String(attempts)}
            data-terminal-visible={visible ? 'true' : 'false'}
            /* The live DEC mouse-tracking mode (§TERM-037). Read by the audit so "reporting is
               on" is an observable fact about the pane rather than an inference from bytes. */
            data-terminal-mouse={trackingMode}
            /* The live kitty keyboard flags (§TERM-030), as a decimal number. `0` means the
               protocol is off and every key takes the legacy path. Published for the same reason
               as the mouse mode: "the negotiation reached the client" has to be an observable
               fact about the pane, not an inference from the bytes that came out the other end. */
            data-terminal-kitty={String(kittyFlags)}
            /* Selected characters (§TERM-034). Length, never the text: the audit needs to know
               a selection HAPPENED, and a pane's contents do not belong in an attribute. */
            data-terminal-selection={String(selectionLength)}
            /* Cell metrics in CSS pixels, so the audit can compute the cell a pixel lands in
               and assert a mouse report byte for byte instead of pattern-matching it. */
            data-terminal-cell={cellHint}
            /* §N17 — whether this pane's ENGINE was built to let the fill behind it through.
               Published for exactly the reason the mouse mode and the kitty flags are: a
               screenshot cannot see through a window, so "the opacity reached the renderer"
               has to be an observable fact about the pane rather than an inference from a CSS
               variable set somewhere else. It is read at engine construction (see the prop's
               doc comment), so this reports the value that is actually in force, not the
               current prop. */
            data-terminal-transparent={engineTransparent ? 'true' : 'false'}
            /* §N20 — what this pane last told its ENGINE about surface focus, which is the
               cursor's whole story: `true` draws the terminal's own cursor (blinking if it
               asked), `false` draws ghostty's steady hollow block. Published rather than
               inferred from `data-focused` because the window's focus is half of it, and
               because a pixel readback needs to know which treatment it is looking for. */
            data-terminal-cursor-focus={surfaceFocused ? 'true' : 'false'}
            /* §APP-014 — the background and foreground this pane last handed its ENGINE.
               Published for the same reason as the mouse mode and the kitty flags above: "the
               resolved theme reached the renderer" has to be an observable fact about the pane
               rather than an inference from a CSS variable assigned somewhere else entirely. */
            data-terminal-theme-bg={theme?.background ?? ''}
            data-terminal-theme-fg={theme?.foreground ?? ''}
            /*
             * §TERM-036 — the pane IS the accessibility element (`SurfaceView.swift:703-715`).
             *
             * On the ROOT, not on `[data-terminal-host]`, and that is load-bearing rather than
             * stylistic: ghostty-web's `open(parent)` imperatively sets `role`, `aria-label`
             * ("Terminal input") and `aria-multiline` on the host it is given, and `dispose()`
             * REMOVES all three — so anything React renders there is overwritten on mount and
             * stripped on teardown. Measured, not assumed: the first run of the audit's
             * `terminal-host-edges` read the host's AX name back as the engine's static
             * "Terminal input" instead of the pane's own title. The root is the element this
             * component owns outright, it survives an engine rebuild, and it is the honest
             * analogue of the single `NSView` the Swift app makes accessible — libghostty's
             * internals are not separate AX elements there either.
             */
            role="textbox"
            aria-multiline="true"
            aria-label={terminalAccessibilityName(props.accessibilityName)}
            aria-describedby={`terminal-help-${paneID}`}
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
            {/* §TERM-036's help text, off-screen: `accessibilityHelp`'s only faithful home. */}
            <span id={`terminal-help-${paneID}`} style={VISUALLY_HIDDEN}>
                {TERMINAL_ACCESSIBILITY_HELP}
            </span>
            {/* N19: `data-pane-surface` marks the subtree that legitimately owns this pane's
                caret — the engine's hidden `<textarea>` lives in here. It is what tells the
                politeness rule in `app/pane-focus.ts` that a focused terminal is a SURFACE and
                not a chrome text field, and it is what `focusPaneSurface` hands the caret to. */}
            <div ref={hostRef} className="h-full w-full" data-terminal-host="" {...{ [PANE_SURFACE_ATTR]: '' }} />
            {status === 'error' ? (
                // Interactive on purpose (it used to be `pointer-events-none`): the placeholder
                // is now the last stop on the retry path, not a dead end. The pane root still
                // sees the click through the capture-phase handler above, so asking for focus
                // keeps working.
                <div
                    role="status"
                    className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-xs"
                    style={{ color: 'var(--nex-fg-secondary, #9A9AA0)' }}
                >
                    <span>terminal renderer failed to start</span>
                    <button
                        type="button"
                        data-testid={`terminal-retry-${paneID}`}
                        onClick={retryStart}
                        title="Build a fresh terminal engine for this pane"
                        className="cursor-pointer rounded text-xs font-medium whitespace-nowrap"
                        style={{
                            // Padding inline rather than as a `px-3 py-*` pair. It had to be,
                            // before S1/S17 moved `button { padding: 0 }` into `@layer base` —
                            // unlayered, it beat every Tailwind utility and the chip hugged its
                            // own text. It stays inline because 5/12 is this chip's stated value,
                            // not a utility step, and inline is where the value is asserted.
                            padding: '5px 12px',
                            border: '1px solid var(--nex-border, #24242B)',
                            color: 'var(--nex-accent, #6F9BD8)',
                            backgroundColor: 'var(--nex-header-bg, #13131A)'
                        }}
                    >
                        Retry
                    </button>
                </div>
            ) : null}
        </div>
    );
}

/** Identity-stable: the grid re-renders constantly and a pane must not remount for it. */
export const TerminalPane = memo(TerminalPaneImpl);
TerminalPane.displayName = 'TerminalPane';
