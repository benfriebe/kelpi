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

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';

import { isPlatformChord } from '@kelpi/core/config';

import {
    PANE_SURFACE_ATTR,
    armCaretClaim,
    isPaneSurfaceCaret,
    mayClaimPaneCaret,
    openEngineFocusWindow,
    releasePaneCaret,
    shouldGrabFocus,
    undoSurfaceAutoFocus
} from '../app/pane-focus';
import { restartUI } from '../app/reload';
import { defaultFormFactorWindow, useFormFactor, type FormFactorWindow } from '../chrome/form-factor';
import { readKeyboardViewportMode } from '../chrome/keyboard-viewport';
import type { PtyStreamHandle, PtySubscription } from '../connection';
import { offerSelection } from '../state/clipboard';
import { dispatchPaste } from './KeyBar';
import { loadTerminalFonts, onTerminalFontsReady, terminalFontsReady } from './fonts';
import { createTerminalIngest } from './ingest';
import {
    PHONE_KEYBOARD_SETTLE_MS,
    PHONE_TEXT_INPUT_ATTRIBUTES,
    PHONE_TEXT_INPUT_ATTRIBUTES_CLEARED,
    clearPhoneTerminalState,
    publishKeyboardInset,
    publishPhoneTerminalState,
    watchSoftKeyboardMotion
} from './keyboard-inset';
import { createKittyKeyboard, sanitizeKittyFlags, type KittyKeyboard } from './kitty-keyboard';
import { notifyTerminalPanes, registerTerminalPane } from './pane-registry';
import {
    IDLE_PANE_MODES,
    createMouseReporter,
    type MouseGridMetrics,
    type MouseReporter,
    type PaneVtModes
} from './mouse';
import {
    createTerminalRenderer,
    engineKeyTarget,
    resolveTerminalTheme,
    type TerminalKeyInit,
    type TerminalMatchLocation,
    type TerminalRenderer,
    type TerminalRendererFactory,
    type TerminalTheme
} from './renderer';
import { clearTouchScrollOffset, createTouchScroll, publishTouchScrollOffset } from './touch-scroll';

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
 * Horizontal breathing room between the pane edge and column 1, in CSS pixels — the DEFAULT,
 * used when the ghostty config sets no `window-padding-x` (Settings ▸ Appearance ▸ Terminal
 * padding writes that key; the `paddingX` prop carries the configured value here).
 *
 * Two jobs: it keeps the focus ring off the first and last columns (see the pane root's style),
 * and it gives the grid breathing room from the pane edge — 4, a step roomier than ghostty's
 * own `window-padding-x = 2` default, chosen deliberately. Applied to the pane root, NOT to
 * the host the geometry is measured from, so cols stay honest.
 */
export const TERMINAL_EDGE_PADDING = 4;

/**
 * Vertical breathing room between the pane's top edge and row 1, in CSS pixels — the DEFAULT
 * behind ghostty's `window-padding-y` (the `paddingY` prop), same arrangement as
 * {@link TERMINAL_EDGE_PADDING}.
 *
 * Same two jobs, rotated 90°: it keeps the first row's ascenders off the pane edge (and out
 * from under the focus ring) — 4, matching {@link TERMINAL_EDGE_PADDING} rather than the top
 * half of ghostty's `window-padding-y = 2` default. Top only — the bottom edge already
 * collects the sub-cell remainder of `floor(height / cellHeight)`, so padding there would
 * double up. Applied to the pane root, NOT to the host the geometry is measured from, so rows
 * stay honest and the bottom row is never clipped.
 */
export const TERMINAL_EDGE_PADDING_TOP = 4;

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
 * Why a pane is on the placeholder, when the reason changes what a person should do about it.
 *
 * `wasm-address-space`: V8 refused to reserve address space for another WebAssembly memory
 * (`RangeError: WebAssembly.Instance(): Out of memory: Cannot allocate Wasm memory for new
 * instance`). That is the whole renderer process, not this pane — every engine built from now
 * on fails the same way, a retry is three more of the same failure, and nothing in the page can
 * force the reclamation. The only way out is a restart of the UI (the daemon keeps every pane
 * and session), so the placeholder says that and offers it. Seen on 2026-09-10 across a whole
 * window at once: disposed terminals were being retained by a document listener
 * (ghostty-web `0.4.0-nex.12`), and each carried its own instance since `-nex.10`.
 */
export type TerminalFailure = 'wasm-address-space';

/** Does this start failure mean the renderer process is out of WebAssembly address space? */
export function isWasmAddressSpaceExhausted(error: unknown): boolean {
    const text =
        error instanceof Error
            ? `${error.message}\n${error.cause instanceof Error ? error.cause.message : String(error.cause ?? '')}`
            : String(error);
    return /Cannot allocate Wasm memory/i.test(text);
}

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
    return trimmed === '' ? 'Terminal' : `Terminal - ${trimmed}`;
}

/**
 * `<cols>x<rows>` while this pane is MIRRORING another client's grid (#166); absent otherwise.
 *
 * The one attribute that tells the truth about what is on the screen when the pane's own box is
 * not what the engine is drawing. Its neighbours describe the pane's MEASUREMENT and keep doing
 * so: `data-terminal-rows` is "the rows this pane last told the daemon" (`keyboard-inset.ts`),
 * which under a mirror is still exactly what it says and no longer what the canvas shows, and
 * `data-terminal-cell` is the cell those numbers were computed with. Published imperatively
 * beside the paint-hold attributes, for the same reason they are: a mirror is established by a
 * replay, and a React render per replay would be a cost #166 does not justify.
 *
 * Absent on every pane that sizes its own PTY, which is every pane in a single-window session —
 * so a desktop window on its own has the DOM it had before #166, attribute for attribute.
 */
export const TERMINAL_MIRROR_ATTRIBUTE = 'data-terminal-mirror';

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
    /** Explicit palette; otherwise resolved from the `--kelpi-term-*` custom properties. */
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
    /**
     * Edge padding in CSS pixels, from the ghostty config's `window-padding-x` /
     * `window-padding-y` (Settings ▸ Appearance ▸ Terminal padding). Undefined = the shipped
     * 4px defaults. x pads left/right, y pads the top; the bottom edge stays the sub-cell
     * remainder — see {@link TERMINAL_EDGE_PADDING_TOP}. A change re-styles the pane root, the
     * host's ResizeObserver sees the shrunken/grown box, and the grid re-measures — live, no
     * engine rebuild.
     */
    readonly paddingX?: number | undefined;
    readonly paddingY?: number | undefined;
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
     * §TERM-036 — what a screen reader should call this pane, normally the same string the
     * pane header shows (`paneDisplayTitle`). Omitted ⇒ the bare word "Terminal".
     */
    readonly accessibilityName?: string | undefined;
    /**
     * Does this client's window OWN the PTY's geometry? Default (omitted) is yes.
     *
     * #166. PTY geometry follows exactly one client (`sizeOwnerID`, `daemon/src/ws/sync.ts:1320`;
     * the claim rules are terminal-surface.md §5.1 and the top bar's `take-size-control` chip is
     * the user's side of them). A non-owner's measured grid is CACHED and never applied, so the
     * bytes arriving on its stream were composed for somebody else's screen: the daemon's
     * emulator wrapped them at the owner's column count, and the replay that re-seeds this engine
     * was serialised at that count with no newline between a soft-wrapped row and its
     * continuation (`@xterm/addon-serialize`; `daemon/src/term/service.ts` §NO_REFLOW has the
     * rest). An engine at any other width glues those halves side by side — the fixed-stride
     * garble of #166 — and re-glues them on every later replay.
     *
     * So a non-owner does not render its own grid: it MIRRORS the owner's. The engine is resized
     * to the grid each replay states (`adoptReplayGrid`) and the canvas, which the engine sizes
     * from cols×rows (`vendor/ghostty-web-patched` renderer: `cssWidth = dims.cols *
     * metrics.width`), sits top-left inside the pane — letterboxed where the box is bigger,
     * clipped by the pane's own `overflow-hidden` where it is smaller. What the user sees is the
     * owner's screen, exactly, instead of a scramble of it.
     *
     * That holds because NOTHING IN THIS CLIENT ARMS THE ENGINE'S OWN FIT: the vendored bundle
     * ships `observeResize()` / `fit()`, which measure the container and resize the terminal to
     * it, and this port never calls either — the pane measures and the pane decides
     * (`syncGeometry`). Arming the engine's fit would destroy the mirror: the engine would pull
     * itself back to the box the moment it was resized away from it.
     *
     * What this does NOT change: the pane keeps MEASURING its own box and keeps reporting it
     * (`syncGeometry`), because that report is what the daemon caches for an instant takeover
     * (`applyCachedSizes`, `sync.ts:1435`) and what asks for the viewer's own fresh snapshot
     * (`requestReplay`, `sync.ts:1541`). It reports a measurement, never the mirrored grid — a
     * pane that echoed the grid back would be telling the daemon the owner's window is its own.
     *
     * `false` only ever arrives from assembly, which reads it off the runtime's own store
     * (`features/TerminalFeaturePane.tsx`), so a remote host's panes answer with that daemon's
     * owner rather than the local one's. Omitted means "nobody has told me otherwise", which is
     * deliberately the same answer the chip gives: no chip, no mirror.
     */
    readonly ownsSize?: boolean | undefined;
    /** Body measurement seam; defaults to `clientWidth`/`clientHeight`. */
    readonly measure?: ((element: HTMLElement) => { width: number; height: number }) | undefined;
    /**
     * C2 - the window the form-factor signal and the software-keyboard inset are read from.
     *
     * Defaults to the page's own window, which is what assembly passes (nothing). It exists so a
     * jsdom test can hand in a fake `visualViewport` and drive a keyboard, which is the only way
     * to test a keyboard at all off a device: jsdom has no layout and no software keyboard.
     */
    readonly formFactorWindow?: FormFactorWindow | undefined;
    /** C2 - how long the visual viewport must hold still; defaults to `PHONE_KEYBOARD_SETTLE_MS`. */
    readonly keyboardSettleMs?: number | undefined;
    readonly className?: string | undefined;
}

/**
 * Cols/rows from the body box and the engine's cell metrics; `null` for a zero-size pass.
 *
 * No keyboard arithmetic, and that is C6's whole point: on a phone the pane shrinks its own box
 * by the live inset (`keyboard-inset.ts`), so the height measured here is already the height the
 * terminal has. C2's `bottomInset` parameter is gone with it - a second number describing the
 * same keyboard is a second number that can disagree with the first, which is exactly what
 * happened on Android when the layout viewport caught up at the end of the animation.
 */
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
    measure?: ((element: HTMLElement) => { width: number; height: number }) | undefined,
    /**
     * #166 — the SURFACE's extent, when it is not the host box.
     *
     * `width`/`height` are what `positionOutOfViewport` reads (`mouse.ts`: "the pointer having
     * LEFT the terminal"), and a mirrored engine's canvas is not the size of the box it sits in:
     * narrower and the background beside it is not the terminal at all, wider and it is clipped.
     * Without this a click in that background was inside the box, so it was not out of viewport,
     * so it was CLAMPED to the last column and reported as a click the application never
     * received — a dead zone that types. Passed only while mirroring, so an ordinary pane keeps
     * the box (including its sub-cell remainder) exactly as it always had it.
     */
    extent?: { width: number; height: number } | undefined
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
        width: extent?.width ?? box.width,
        height: extent?.height ?? box.height,
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

    /**
     * The props every imperative path reads — and it is written in a LAYOUT effect on purpose
     * (§N35 residual (b)).
     *
     * A passive effect runs after paint, so between the commit that gives this pane the ring and
     * the effect that records it there is one frame in which the DOM says `data-focused="true"`
     * and `latest.current.focused` still says `false`. Everything imperative reads the ref:
     * `answerEngineGrab` is the one that costs something, because in that window it decides this
     * pane is not entitled to its own caret and hands it to the arbiter's previous owner — the
     * grid draws the ring on a pane the keyboard has just left. The window is real either way
     * (the engine's `setTimeout(0)` backup grab lands inside it, and so does any sibling's
     * hand-off), so the ref is written where the DOM is written: in the same commit, before
     * anything can observe the two disagreeing.
     *
     * No dependency array: every commit republishes, which is what a "latest props" ref means.
     */
    const latest = useRef(props);
    useLayoutEffect(() => {
        latest.current = props;
    });

    /**
     * C5 - THE PANE'S ONE CLAIM ON THE CARET, and the only place it decides it may make one.
     *
     * Every path that used to call `renderer.focus()` because the pane is entitled to the caret
     * calls this instead: the mount's post-`open` claim, the window/visibility resync (N15) and
     * the focus effect's armed claim (issue #35). What they had in common was already "the pane
     * is focused, so take the caret"; what they were missing is that on a phone taking the caret
     * is not a focus change but a software keyboard over half the screen.
     *
     * `mayClaimPaneCaret` (`app/pane-focus.ts`) holds the rule and the measurement behind it; it
     * answers yes for every desktop window, so each of the three sites is byte for byte what it
     * was. On a phone the keyboard has exactly two ways up, and neither is a claim: a direct tap
     * on the terminal, which the engine's own `touchend` answers, and the key bar's key when it
     * reads Show (`showKeyboard` below). **Owner-directed divergence from the shipped Swift app**,
     * like every phone rule - `chrome/form-factor.ts` says that once for the whole program.
     *
     * The window comes off `latest` rather than being closed over, for the same reason
     * `rendererRef` is read at call time: a claim can be made from a closure that outlived the
     * render that created it.
     */
    const claimCaret = useCallback((): void => {
        if (!mayClaimPaneCaret(latest.current.formFactorWindow)) return;
        rendererRef.current?.focus();
    }, []);

    // ── what the WINDOW's key bar does to this pane (C9) ────────────────────────────
    //
    // These four were C1's props on a `<KeyBar>` this component rendered. The bar is one per
    // WINDOW now (`terminal/PhoneKeyBar.tsx`), so they are published on the pane's registry handle
    // instead and the bar calls them on whichever pane holds the caret. What each one does is
    // unchanged, down to the node it resolves; see the comments on each.
    //
    // Declared here, above the mount effect, because that effect is what registers them.

    /** A bar key, raised at the engine exactly as a physical one arrives (C1's routing decision). */
    const sendKey = useCallback((init: TerminalKeyInit): boolean => rendererRef.current?.dispatchKey(init) ?? false, []);
    /**
     * Dismiss the software keyboard by letting the caret go, which is what `releasePaneCaret` does
     * and what `renderer.blur()` does NOT: ghostty-web's `blur()` blurs the CONTAINER
     * (`vendor/ghostty-web-patched/source/lib/terminal.ts:866-870`) while the caret sits in the
     * hidden textarea inside it, so the keyboard would stay up. The way back is the engine's own:
     * its canvas has a `touchend` listener that focuses the textarea (`terminal.ts:490-493`), so
     * tapping the terminal raises the keyboard again with nothing here involved.
     */
    const hideKeyboard = useCallback((): void => releasePaneCaret(hostRef.current), []);
    /**
     * …and the way back, for the bar's toggle only (device round 3, 2026-09-04).
     *
     * The same node `dispatchKey` and `pasteText` resolve, focused directly rather than through
     * `renderer.focus()`: the engine's `focus()` focuses this textarea too
     * (`vendor/ghostty-web-patched/source/lib/terminal.ts:844-860`) and then schedules a second,
     * delayed focus as a backup, which is a reasonable thing for an engine opening to do and a
     * strange thing to trigger from a button. This is the ONLY focus the phone key bar can cause,
     * and it happens only when the person taps a key that says Show.
     */
    const showKeyboard = useCallback((): void => engineKeyTarget(hostRef.current)?.focus(), []);
    /**
     * C4 - text into the terminal through the ENGINE's own paste path, which is where the
     * bracketed-paste envelope is decided (`KeyBar.tsx` `dispatchPaste`). The pane owns the host,
     * so the pane is what resolves the engine's input node.
     */
    const pasteText = useCallback(
        (text: string): boolean => dispatchPaste(engineKeyTarget(hostRef.current), text),
        []
    );

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
    /**
     * #166 — the grid this engine is MIRRORING, or null when it renders this pane's own box.
     *
     * Set by a replay that arrived with a grid while this client did not own PTY sizing, cleared
     * the moment it does. While it holds a value it, and not the measured box, is what the engine
     * is at: `syncGeometry` keeps measuring and keeps reporting, and stops resizing the engine.
     *
     * A ref rather than state because it is written from a stream callback during a replay and
     * read by the measurement path; a re-render per replay would cost a paint for a number only
     * the engine and one `data-` attribute care about.
     */
    const mirrorRef = useRef<TerminalGeometry | null>(null);
    /**
     * #166 — the grid the LAST replay stated, whoever owned sizing when it arrived.
     *
     * Recorded even while this client owns the PTY, and that is the point: the `size-control`
     * broadcast reaches the store immediately but reaches THIS component's props one React render
     * later, and a multi-megabyte replay is applied in chunks across several tasks
     * (`ingest.ts`) — so the snapshot taken at the new owner's grid can be on screen before
     * `ownsSize` has turned false, with nothing left to trigger a correction: the box has not
     * moved, and the daemon only replays a non-owner whose grid CHANGED. Comparing this against
     * the engine's grid at the moment ownership flips is how that race is detected, and one
     * forced `resize-pane` is how it is repaired (`force`, `protocol/src/ws/messages.ts`).
     */
    const replayGridRef = useRef<TerminalGeometry | null>(null);
    const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** When the current run of coalesced resizes started (null = nothing pending). */
    const pendingResizeSince = useRef<number | null>(null);
    const [status, setStatus] = useState<PaneStatus>('loading');
    /** The reason behind an `error` status when it is not the generic one (`TerminalFailure`). */
    const [failure, setFailure] = useState<TerminalFailure | null>(null);
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

    // ── the software keyboard (C2, C6, C9, docs/MOBILE-PLAN.md §4) ──────────────────
    //
    // §7's "Keyboard inset ownership" as C9 re-homed it: the inset is applied ONCE per window, by
    // `terminal/PhoneKeyBar.tsx`, to the content area the pane grid and the window's one key bar
    // both sit in. A pane does not apply it (it did until C9, because the bar was inside the pane),
    // `PhoneShell` (B2) does not subtract it for panes, and the overlays (B5) apply it to
    // themselves. What a pane still owns is the settle rule - one `resize` per transition - and
    // the attributes the audit reads. The reasons are in `keyboard-inset.ts`.
    //
    // Nothing here does anything on a desktop: `useFormFactor` answers `desktop` for every window
    // with a fine pointer, and on a desktop pane the effect below subscribes to nothing, publishes
    // no attribute and leaves `keyboardInsetRef` at the 0 every path treats as "no keyboard".
    const formFactorWindow = props.formFactorWindow ?? defaultFormFactorWindow();
    const phone = useFormFactor(formFactorWindow) === 'phone';
    const keyboardSettleMs = props.keyboardSettleMs ?? PHONE_KEYBOARD_SETTLE_MS;
    /** The inset the pane's BOX is shrunk by right now; the DOM's own copy of it is the padding. */
    const keyboardInsetRef = useRef(0);
    /**
     * True between the first frame of a keyboard transition and its settle.
     *
     * The gate on `scheduleGeometrySync`: a keyboard animation drives the host's ResizeObserver at
     * frame rate now that the box follows it, and the observer's debounce has a CEILING
     * (`RESIZE_MAX_WAIT_MS`) that exists to keep a divider drag republishing ~10x/s. Without the
     * gate that ceiling would put two or three intermediate grids on the PTY per transition.
     */
    const keyboardMovingRef = useRef(false);
    /** Whether the published phone attributes are in force; refs, so `syncGeometry` can read it. */
    const phoneRef = useRef(false);
    /** `resize` messages this pane has put on its stream. The settle rule's whole point is this. */
    const resizeMessages = useRef(0);

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
                // #166: the grid the ENGINE holds, which under a mirror is the owner's and not
                // this box's. A mouse report carries cell coordinates the APPLICATION will read
                // against its own screen, and the application's screen is the PTY's grid — and
                // the surface those pixels are measured against is the engine's canvas, which
                // under a mirror is not the size of this box (see `measureMouseSurface`).
                const mirror = mirrorRef.current;
                if (mirror === null) return measureMouseSurface(host, renderer, geometryRef.current, latest.current.measure);
                // The extent is NOT passed on the un-mirrored path above, deliberately: a pane's box
                // has a sub-cell remainder (80 columns of a 10px cell in an 805px box leaves 5px), a
                // press there has always been clamped to the last column, and passing the extent
                // everywhere would silently change that. The mirror suite measures 805 for it.
                const cell = renderer.cellSize();
                return measureMouseSurface(host, renderer, mirror, latest.current.measure, {
                    width: mirror.cols * cell.width,
                    height: mirror.rows * cell.height
                });
            },
            // Straight to the PTY, but on the UN-mirrored frame: a report carries cell
            // coordinates measured against THIS pane's grid, and terminal-surface.md §8.2 / §11
            // keep mouse input out of the sync-group fan-out (a sibling in another mouse mode,
            // or none, would take the bytes as typed text). Issue #51.
            write: (data) => streamRef.current?.writeDirect(data)
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
            // §8.2 mirrors only the press that carries the input; a kitty release (`:3u`) is the
            // keyUp the legacy path never produced, so it takes the un-mirrored frame (#51).
            write: (data, release) =>
                release ? streamRef.current?.writeDirect(data) : streamRef.current?.write(data)
        });
    }

    const clearResizeTimer = useCallback((): void => {
        if (resizeTimer.current === null) return;
        clearTimeout(resizeTimer.current);
        resizeTimer.current = null;
    }, []);

    /**
     * Publish (or clear) the mirrored-grid attribute on the pane root (#166).
     *
     * Imperative, like the paint-hold pair beside it: a mirror is established by a replay, and a
     * React render per replay is a cost this does not justify.
     */
    const publishMirror = useCallback((grid: TerminalGeometry | null): void => {
        const root = rootRef.current;
        if (root === null) return;
        if (grid === null) root.removeAttribute(TERMINAL_MIRROR_ATTRIBUTE);
        else root.setAttribute(TERMINAL_MIRROR_ATTRIBUTE, `${String(grid.cols)}x${String(grid.rows)}`);
    }, []);

    /**
     * Measure → engine → daemon. `force` bypasses the unchanged-geometry short circuit.
     *
     * `republish` sends the measurement even when the daemon has already been told these exact
     * numbers (#166): a hand-off of size control is a claim, not a measurement, and the pane that
     * makes it has usually been reporting the same grid all along as a cached non-owner, so
     * `PtyClient.resize`'s unchanged short circuit would swallow it.
     *
     * ON THE LOSING SIDE that flag is the only way to ask for a screen, and it is the reason it
     * exists (see the ownership effect). ON THE TAKING SIDE it is belt and braces and nothing more,
     * stated plainly because an earlier draft of this comment justified it with something untrue:
     * the daemon's cache is NOT normally missing this pane. `take-size-control` applies this
     * client's whole cached layout (`applyCachedSizes`, `ws/sync.ts`) and so does the successor
     * path on an owner's disconnect, and the cache has an entry for every pane this client ever
     * attached — `PtyClient.attach` sends `attach-pane` with a geometry always, falling back to
     * 80x24 when the subscription had none (`connection/pty.ts`), and a re-attach carries one too.
     * So the PTY has the claim before this message lands and the message costs one more no-op
     * ioctl per pane. It is kept because the claim is then stated by the client that made it
     * rather than inferred from a cache, which is one less thing to be wrong about; it buys no
     * correctness on this side.
     *
     * Used by the ownership effect and nothing else; every other caller reports only what changed,
     * which is what keeps a drag storm to one message per settled gesture.
     */
    const syncGeometry = useCallback((force = false, republish = false): void => {
        const renderer = rendererRef.current;
        const host = hostRef.current;
        if (renderer === null || host === null) return;
        const current = latest.current;
        if (!current.visible) return; // idle while hidden; the daemon keeps draining the PTY
        const next = measureGeometry(host, renderer, current.measure);
        if (next === null) return; // zero-size guard
        /*
         * #166 — OWNING THE PTY MEANS THE ENGINE FOLLOWS THIS BOX AGAIN, and this is the path for
         * the pane the ownership effect could not move: one that had no measurement at all when
         * the hand-off happened (a transient 0x0 layout pass, a pane that has only ever been
         * zero-boxed). Its mirror is left ARMED there on purpose — the replays still arriving were
         * serialised at the ex-owner's grid and must still be parsed at it — and the first real
         * measurement is where it ends. Before the unchanged-geometry short circuit below, because
         * a mirror that outlived its ownership must not survive on "nothing moved".
         */
        let engineMoved = false;
        if (current.ownsSize !== false && mirrorRef.current !== null) {
            mirrorRef.current = null;
            publishMirror(null);
            renderer.resize(next.cols, next.rows);
            engineMoved = true;
        }
        const previous = geometryRef.current;
        const unchanged = previous !== null && previous.cols === next.cols && previous.rows === next.rows;
        if (unchanged && !force) return;
        geometryRef.current = next;
        const cell = renderer.cellSize();
        setCellHint(
            cell.width > 0 && cell.height > 0 ? `${cell.width.toFixed(2)}x${cell.height.toFixed(2)}` : ''
        );
        /*
         * #166 — THE ENGINE FOLLOWS THE BOX ONLY WHILE THIS CLIENT SIZES THE PTY.
         *
         * With a mirror in force the engine is at the grid the daemon's emulator holds, and the
         * bytes on this stream were composed for THAT grid: resizing to this box would re-wrap
         * the owner's rows and glue the next replay's soft-wrapped pairs, which is the defect.
         * The box still gets measured and still gets reported one line down, because that report
         * is the daemon's takeover cache and the request for this viewer's own fresh snapshot —
         * and that snapshot is what re-states the grid and keeps the mirror true.
         *
         * With no mirror (an owner, or a non-owner talking to a daemon that predates #166 and
         * sends no grid) this is the behaviour it always had.
         */
        if (!engineMoved && mirrorRef.current === null) renderer.resize(next.cols, next.rows);
        streamRef.current?.resize(next.cols, next.rows, republish);
        // C2 - counted on the line that sends it, so the attribute reports what the DAEMON was
        // told rather than what the pane looks like afterwards. Published only under the phone
        // form factor, so a desktop pane's DOM is byte-identical to what it was before C2.
        resizeMessages.current += 1;
        if (phoneRef.current) {
            publishPhoneTerminalState(rootRef.current, {
                inset: keyboardInsetRef.current,
                rows: next.rows,
                resizes: resizeMessages.current
            });
        }
        if (!unchanged || force) current.onDimensionsChange?.(current.paneID, next);
        // `publishMirror` is the only dependency this callback has ever had; it is identity-stable
        // (`useCallback(..., [])`), so the list is a formality rather than a re-creation risk.
    }, [publishMirror]);

    /**
     * Trailing debounce with a ceiling: a burst coalesces, but a gesture that never stops still
     * publishes its geometry every `RESIZE_MAX_WAIT_MS` (see the constant — run-B L5).
     */
    const scheduleGeometrySync = useCallback((): void => {
        // C6 - a keyboard in flight owns the box, and its settle owns the measurement that follows
        // (`keyboard-inset.ts`). Dropping the observer's work rather than deferring it is the
        // point: whatever the box ends up being, the settle measures THAT, once. Always false on
        // a desktop pane, which never subscribes to a viewport at all.
        if (keyboardMovingRef.current) {
            clearResizeTimer();
            pendingResizeSince.current = null;
            return;
        }
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
            if (isWasmAddressSpaceExhausted(error)) {
                // Not a race, so not a retry: every engine in this process fails the same way
                // until the UI restarts. Say so once, at `error` — a person is about to see it.
                console.error(
                    `[kelpi] terminal renderer cannot start for pane ${paneID}: the renderer is out of ` +
                        'WebAssembly address space; every new engine fails until the UI restarts ' +
                        '(View ▸ Recover Interface, or the placeholder\'s Restart UI)',
                    error
                );
                setFailure('wasm-address-space');
                setStatus('error');
                return;
            }
            if (attempt < TERMINAL_START_ATTEMPTS) {
                console.info(
                    `[kelpi] terminal renderer ${phase === 'open' ? 'failed to start' : 'died'} for pane ${paneID} ` +
                        `(attempt ${String(attempt)}/${String(TERMINAL_START_ATTEMPTS)}) - rebuilding on a fresh engine`,
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
            // occurrence of it (run-F step 14, a pane revealed by `kelpi workspace create`)
            // arrived with zero renderer console output and no cause to chase.
            console.error(
                `[kelpi] terminal renderer failed to start for pane ${paneID} after ` +
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
            setFailure(null);

            const ingest = createTerminalIngest(renderer);
            if (initial !== null) geometryRef.current = initial;

            /**
             * #166 — resize the engine to the snapshot's grid BEFORE the snapshot is applied.
             *
             * ORDER IS THE WHOLE THING. `ingest.replay` resets the engine and writes the
             * snapshot; a resize after that would re-wrap what was just painted (the engine
             * reflows on a column change), and a resize without a replay would leave the engine
             * holding a grid it has not been told the contents of. Doing it here, one statement
             * ahead, means the reset lands on an engine that is already the right shape and the
             * paint hold `renderer.resize` opens (§N24) is ended by that same reset.
             *
             * Only for a client that does NOT own PTY sizing (`ownsSize === false`, read through
             * `latest` so it is this commit's answer). An owner's engine is already at the grid
             * the daemon just serialised at — it is the client that put it there — and a
             * transient disagreement (a gesture that moved the box while the daemon's snapshot
             * was in flight) is repaired by that gesture's own settled resync, which is the
             * mechanism this would otherwise fight.
             *
             * ONE EXCEPTION, and it is the armed mirror (see the ownership effect): a client that
             * owns sizing but has never measured a box has no grid of its own to render, so the
             * grid the daemon states is the only one it knows — and it is the right one, because
             * the geometry the daemon is sizing that PTY from came from this client's own attach
             * (80x24 when it had nothing to measure, `connection/pty.ts`). Following it turns what
             * used to be a mis-parsed window — the engine armed at the EX-owner's grid while the
             * daemon replayed at the attach fallback, visible until the first real measurement
             * repaired it — into a screen that is simply right from the first replay. The mirror
             * stays armed, so `data-terminal-mirror` keeps saying the canvas is not this box's,
             * which while this pane has no box is exactly true.
             *
             * `grid` is absent against a daemon that predates #166, and then nothing happens at
             * all: the engine keeps the box's grid, which is the behaviour that shipped.
             */
            const adoptReplayGrid = (grid: { cols: number; rows: number } | undefined): void => {
                if (grid === undefined || grid.cols <= 0 || grid.rows <= 0) return;
                if (latest.current.ownsSize !== false && mirrorRef.current === null) return;
                const current = rendererRef.current;
                if (current === null) return;
                mirrorRef.current = { cols: grid.cols, rows: grid.rows };
                publishMirror(mirrorRef.current);
                // A no-op when the engine is already at this grid (`renderer.resize` short
                // circuits, and does not open a paint hold for a grid that did not move).
                current.resize(grid.cols, grid.rows);
            };

            const subscription: PtySubscription = {
                // The daemon replays the server-side VT snapshot before going live; ingest keeps
                // that ordering true across engine load, reconnect and flow-control resync.
                onReplay: (data, grid) => {
                    // Recorded whoever owns sizing (see `replayGridRef`): it is what tells the
                    // ownership effect that a replay was applied at a grid this engine is not at.
                    if (grid !== undefined && grid.cols > 0 && grid.rows > 0) {
                        replayGridRef.current = { cols: grid.cols, rows: grid.rows };
                    }
                    adoptReplayGrid(grid);
                    ingest.replay(data);
                },
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
            });
            /**
             * #81: publish this pane's live selection read for the app's `copy` action.
             *
             * A registration rather than a callback prop, and a PULL rather than the push above,
             * because the engine's `clearSelection()` fires no change event
             * (`vendor/ghostty-web-patched/source/lib/selection-manager.ts:227`, called from the
             * mousedown at `:439`): a cached selection survives the click that visibly cleared
             * it. `terminal/pane-registry.ts` has the full argument.
             */
            const offRegistry = registerTerminalPane(paneID, {
                selection: () => rendererRef.current?.selection() ?? '',
                // #82: the mirrored `input` frame, the same one `renderer.onData` takes above,
                // because what an action like ⌘Backspace produces IS a keystroke (§8.2).
                write: (data) => {
                    streamRef.current?.write(data);
                },
                // C9: and the half the WINDOW's key bar uses. Every one of these is a function
                // this component already had; publishing them here is what lets ONE bar at the
                // bottom of the window act on whichever pane holds the caret, instead of each
                // pane carrying a bar of its own inside its own box.
                root: () => rootRef.current,
                dispatchKey: sendKey,
                pasteText,
                showKeyboard,
                hideKeyboard,
                cellHeight: () => rendererRef.current?.cellSize().height ?? 0,
                // `latest` is written in a LAYOUT effect (§N35 residual (b)), so this answers with
                // the commit that gave the pane the ring rather than one commit later.
                focusedOnScreen: () => latest.current.focused && latest.current.visible
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
            /*
             * Who holds the caret while this engine is loading is NOT this pane's question to
             * answer on its own (§N35 residual (a)). It used to be: each pane kept its own
             * `engineTookFrom`, seeded from `document.activeElement` and updated by a capture
             * listener of its own, which on a multi-pane reload made every arming pane record
             * every other arming pane's grab — so two undos handed the caret back and forth,
             * ~50 synchronous `focusin`s inside one millisecond at three panes and worse at
             * eight. `app/pane-focus.ts` now holds ONE owner for the whole window, refuses to
             * record a caret that is inside a host still grabbing (that is the grab), and
             * ignores an undo raised by its own hand-off. One listener, one answer, at most one
             * hand-off per grab.
             */
            const closeEngineFocusWindow = openEngineFocusWindow(host);
            /** Every grab this engine makes while the window is open, answered the same way. */
            const answerEngineGrab = (): void => {
                if (cancelled) return;
                // Entitled after all (the pane gained focus while its engine was loading):
                // `shouldGrabFocus` passes trivially for a caret already inside this host.
                // `latest` is written in a LAYOUT effect (§N35 residual (b)), so a pane that
                // took the ring in this commit reads as focused here rather than one commit
                // later — the window in which this handed the ring's own caret away.
                if (latest.current.focused && latest.current.visible && shouldGrabFocus(host)) return;
                undoSurfaceAutoFocus(host);
            };
            let closeUndoWindow: (() => void) | null = null;
            void renderer.open(host).then(
                () => {
                    if (cancelled) {
                        closeEngineFocusWindow();
                        return;
                    }
                    setStatus('live');
                    // The engine's real metrics exist only now; a disagreement with the
                    // estimate is corrected here, before anything else can measure.
                    syncGeometry(true);
                    // C5: `claimCaret` is the same claim with the phone rule in front of it. The
                    // BRANCH is unchanged on a phone even though the claim is a no-op there: the
                    // `else` undoes the engine's own grab, and an entitled pane whose claim the
                    // phone rule declines has nothing to undo - the engine put the caret in its
                    // own textarea, which is where a tap on the terminal would have put it.
                    if (latest.current.focused && latest.current.visible && shouldGrabFocus(host)) claimCaret();
                    else undoSurfaceAutoFocus(host);
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
                        closeEngineFocusWindow();
                    };
                },
                (error: unknown) => {
                    closeEngineFocusWindow();
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
                closeEngineFocusWindow();
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
                offRegistry();
                offFailure();
                offHold();
                stream.unsubscribe();
                renderer.dispose();
                rendererRef.current = null;
                streamRef.current = null;
                geometryRef.current = null;
                // #166: a mirror belongs to an engine and a stream. The next one establishes its
                // own on its first replay, and until then the pane renders its own box.
                mirrorRef.current = null;
                replayGridRef.current = null;
                publishMirror(null);
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
    }, [paneID, ptyApi, clearResizeTimer, syncGeometry, publishMirror, props.fontFamily, props.fontSize]);

    /**
     * #166 — size control changed hands. Both directions, and neither of them waits for a render
     * that might not come.
     *
     * GAINING it (the `take-size-control` chip, or the owner disconnecting and this client being
     * the successor) has to act NOW, and it has to act HERE rather than through `syncGeometry`.
     * That was the first version and it was wrong: `syncGeometry` returns early for a pane that is
     * not visible and for a transient 0x0 box, so a takeover in either state cleared the mirror
     * and left the engine on the EX-OWNER's grid with nothing able to move it — `adoptReplayGrid`
     * no longer adopts (this client owns sizing now), and the hand-off's own resync replay,
     * serialised at this client's grid, was then written into an engine still at the old one.
     * That is #166's glue, on the owner's own pane, steady. So the engine is moved from the last
     * MEASUREMENT (`geometryRef`, taken at mount whether the pane is visible or not), and the
     * daemon is told in the same breath: it has been caching these numbers as a non-owner's, and
     * `republish` is what turns one of them into a PTY resize rather than "nothing moved".
     *
     * With no measurement at all — a pane that has only ever been zero-boxed — the mirror is left
     * ARMED instead: the engine is at the ex-owner's grid, the replays already in flight were
     * serialised at it, and `syncGeometry` clears the mirror and moves the engine on the first real
     * measurement. Clearing it here would be claiming the engine had moved when it had not.
     *
     * An armed mirror keeps FOLLOWING the daemon's stated grid (`adoptReplayGrid`), which is what
     * makes this branch correct rather than merely safe. The daemon does not stand still while this
     * pane has no box: `applyCachedSizes` moves the PTY to the geometry this client last reported,
     * which for a pane that never measured anything is `attach-pane`'s own 80x24 fallback
     * (`connection/pty.ts`), and the resync that follows is serialised at THAT. Without the
     * following, the engine sat at the ex-owner's grid parsing an 80x24 snapshot — the #166 glue
     * again, on this pane, until the first real measurement repaired it (about 150 ms for a pane
     * about to be shown, indefinitely for one that stays hidden).
     *
     * LOSING it normally needs nothing: the taker's grid reaches the daemon's emulator, that is a
     * grid CHANGE, and a grid change is what arms the settled-resize resync for every attached
     * client (`noteGeometry` → `resyncPane`, `ws/streams.ts`). The replay it sends carries the new
     * grid and `adoptReplayGrid` mirrors it — 150 ms after the hand-off, with the screen the owner
     * is looking at, rather than this instant with a grid nobody has sent the contents of.
     *
     * Except when that replay ARRIVED FIRST. The broadcast updates the store at once but reaches
     * these props one render later, and a big snapshot is applied in chunks across several tasks
     * (`ingest.ts`), so the new owner's screen can be painted at this engine's grid before
     * `ownsSize` turns false. Then nothing is left: the box has not moved, so this client sends no
     * geometry; the daemon replays a non-owner only on a CHANGED grid; and a replay provokes no
     * replay. `replayGridRef` is how that is detected — the last replay stated a grid this engine
     * is not at — and ONE forced `resize-pane` is how it is repaired: the daemon's non-owner path
     * takes a forced report as "re-seed me" (`ws/sync.ts`), and the snapshot that comes back
     * carries the owner's grid for `adoptReplayGrid` to mirror. One request per transition, never
     * a poll: this effect runs only when `ownsSize` itself changes.
     */
    useEffect(() => {
        const renderer = rendererRef.current;
        const measured = geometryRef.current;
        if (props.ownsSize === false) {
            const stated = replayGridRef.current;
            if (stated === null || renderer === null || measured === null) return;
            if (stated.cols === renderer.cols && stated.rows === renderer.rows) return;
            streamRef.current?.resize(measured.cols, measured.rows, true);
            return;
        }
        if (mirrorRef.current === null) return;
        if (measured === null) return;
        mirrorRef.current = null;
        publishMirror(null);
        renderer?.resize(measured.cols, measured.rows);
        streamRef.current?.resize(measured.cols, measured.rows, true);
        // …and re-measure, for the pane whose box moved while it was somebody else's mirror.
        syncGeometry(true);
    }, [props.ownsSize, publishMirror, syncGeometry]);

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
            // #158: and the caret comes with the press. Consuming it also took away the engine's
            // own canvas `mousedown → textarea.focus()` (`vendor/…/terminal.ts:486-489`), which
            // is the only thing that re-focuses a pane that is ALREADY the focused one: the focus
            // effect's deps do not change on that click, so it does not run. Without this a pane
            // running `vim` or `htop` whose textarea had been blurred (a click on a sidebar row,
            // on its own header) wore the ring and took no keystrokes until the user clicked
            // another pane and came back.
            //
            // NOT polite (`shouldGrabFocus`), which is the one way it differs from the other
            // claims: those are made on the user's behalf (a mount, a resync, the focus effect),
            // and this is the user's own click, which focuses the pane (§6). The listener it stands
            // in for takes the caret whatever holds it, so a rename or the sidebar filter mid-edit
            // gives it up to this click exactly as it does with tracking off. `claimCaret` still
            // makes it a no-op on a phone.
            if (latest.current.focused && latest.current.visible) claimCaret();
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

    // ── C3: a finger on the terminal (docs/MOBILE-PLAN.md §4) ───────────────────────
    //
    // **Owner-directed divergence from the shipped Swift app**, like every phone rule in this
    // program: there is no Swift phone UI, so a touch gesture has no parity reference
    // (`chrome/form-factor.ts` carries the note for all of it).
    //
    // PHONE ONLY, and that is the whole "desktop is untouched" claim for this feature: the effect
    // returns before it attaches anything unless `phone` is true, so a desktop terminal grows no
    // touch listener, no attribute and no gesture machine - it is the tree it has always been,
    // down to the byte (MOBILE-PLAN.md §3, principle 1).
    //
    // THE RULE THE SPIKE WROTE, enforced here and nowhere else: **a touch reaches the PTY only
    // while an application has asked for the mouse**. With tracking `none` the gesture machine
    // owns the contact and the only thing it can do is move a viewport.
    //
    // #123 CHANGED THE OTHER HALF OF THAT SENTENCE. It used to read "with tracking on, the same
    // touch goes to the mouse reporter as button 0 at the cell under the finger, and the gesture
    // machine never sees it" - so a DRAG arrived at the application as a press, a run of motion
    // reports and a release, and a press with a release is a click. The owner's phone found it on
    // a Claude Code tab: a scroll down ended on the bottom rows and clicked the task line, which
    // opens its agents-and-monitors list. Measured on the base by `phone-touch-mouse-reporting`:
    //
    //     ^[[<0;24;16M  ^[[<32;24;18M … ^[[<32;24;50M  ^[[<0;24;50m
    //     └ press        └ 12 motion reports            └ release, on the LAST ROW of 50
    //
    // Now the gesture machine sees EVERY contact in both modes, recognises the gesture first, and
    // reports only what the gesture earned: a drag is wheel reports at the finger, a tap (and a
    // long press, which is a tap held) is the one click, and a drag's end is nothing at all. The
    // rule, the reason and the rest of the measurement are in `touch-scroll.ts`'s header;
    // `PointerLike` is structural, so a `Touch` is one and the reporter needs no new entry point.
    //
    // Capture on the host, exactly as the mouse and the kitty interceptors are, so a consumed
    // event never reaches the engine's canvas listeners BELOW it - which is what stops a scroll
    // ending in the engine's own `touchend` focus (and, on a phone, the software keyboard coming
    // up because someone read their scrollback). A plain TAP is deliberately not consumed: that
    // focus is how a phone raises its keyboard at all.
    useEffect(() => {
        if (!phone) {
            clearTouchScrollOffset(rootRef.current);
            return;
        }
        const host = hostRef.current;
        const root = rootRef.current;
        if (host === null) return;
        const reporter = mouseRef.current;

        const scroller = createTouchScroll({
            scrollLines: (delta) => rendererRef.current?.scrollLines(delta),
            scrollOffset: () => rendererRef.current?.scrollOffset() ?? 0,
            cellHeight: () => rendererRef.current?.cellSize().height ?? 0,
            // Read once per gesture by the machine, which latches it (#123). `active` is the live
            // mode the daemon streams, so an application that turns reporting on between two
            // gestures gets the second one and not half of the first.
            reportsMouse: () => reporter?.active === true,
            /*
             * A drag, one wheel detent per line, at the finger.
             *
             * `deltaMode: 1` is DOM_DELTA_LINE, and it is exact rather than convenient: the
             * reporter's discrete-tick path multiplies a line delta by ITS OWN cell height before
             * spending the accumulator against that same height, so `lines` in is exactly `lines`
             * button-64/65 reports out - no rounding, and no drift between the cell the gesture
             * machine divides by and the cell the reporter's metrics report. Going through
             * `wheel()` also keeps the encoder, the modifier bits and the
             * `MAX_WHEEL_REPORTS_PER_EVENT` guard that a real mouse already has.
             */
            reportWheel: (lines, point) => {
                reporter?.wheel({
                    clientX: point.clientX,
                    clientY: point.clientY,
                    deltaX: 0,
                    deltaY: lines,
                    deltaMode: 1
                });
            },
            /*
             * A tap: the press and the release the application asked for, at one point.
             *
             * `down` then `up` rather than two hand-rolled reports, so the click carries the
             * reporter's own state - the `held` set, the motion dedupe, the "release for a press
             * this pane never saw" rule - and a phone's click is byte-identical to a mouse's at
             * the same cell. A `TouchPointLike` has no `button`, which `DOM_BUTTONS[… ?? 0]`
             * reads as button 0, exactly as the old touch branch did.
             */
            reportClick: (point) => {
                const at = { clientX: point.clientX, clientY: point.clientY };
                reporter?.down(at);
                reporter?.up(at);
            },
            onLongPress: (point) => {
                const renderer = rendererRef.current;
                if (renderer === null) return;
                // `selectWordAt` is optional on the interface: the fallback engine has no
                // long-press selection, and a pane on it simply does not select (see
                // `renderer.ts`). A press on blank space returns true and selects nothing, which
                // is why the read below is what decides whether anything happened.
                if (renderer.selectWordAt?.(point.clientX, point.clientY) !== true) return;
                const text = renderer.selection();
                if (text === '') return;
                // The pill, not the clipboard: a long press has no transient activation behind
                // it, so `navigator.clipboard.writeText` is refused on every mobile browser. C4's
                // Copy pill IS the tap that has one, and this reuses it rather than growing a
                // second surface (`state/clipboard.ts`).
                offerSelection(paneID, text);
            }
        });

        const consume = (event: Event): void => {
            // `passive: false` below is what makes this legal; without it the browser ignores it
            // and pans the page under the pane.
            event.preventDefault();
            event.stopPropagation();
        };
        /*
         * ONE PATH, BOTH MODES (#123).
         *
         * There used to be a branch here that handed the raw touch events to the mouse reporter
         * whenever an application was reporting - a `down` on `touchstart` and an `up` on
         * `touchend`, which is the press and the release the owner's phone turned into a click on
         * Claude Code's task line. The branch was the bug: it decided what to send BEFORE it knew
         * what the gesture was, and a `touchstart` cannot know.
         *
         * Now every contact goes to the gesture machine, which recognises it first and calls back
         * with the bytes it earned (`reportWheel` / `reportClick` above). The machine's return
         * value is unchanged in meaning - "the engine must not also see this" - and it says yes
         * for every event of a reported gesture, which is what the old branch did too.
         */
        const onStart = (event: TouchEvent): void => {
            // A new contact clears the word the last long press left highlighted, and the mirror
            // is written by hand BOTH ways. The engine's `clearSelection()` fires no change event
            // (#81), so a clear nobody announced leaves `data-terminal-selection` reporting a
            // highlight that is not on the screen - measured on this pane in the audit, which
            // found a stale `1` from an earlier step surviving three gestures. After this line
            // there is no selection, whoever cleared it, so the mirror says so.
            //
            // It runs in both modes for the same reason ghostty clears one (`Surface.zig:3850`):
            // once the application is being sent the gesture, a selection from before it asked
            // must not sit highlighted over a TUI that is handling the same contact.
            if (rendererRef.current?.selection() !== '') rendererRef.current?.clearSelection();
            setSelectionLength(0);
            if (scroller.start(event)) consume(event);
        };
        const onMove = (event: TouchEvent): void => {
            if (scroller.move(event)) consume(event);
        };
        const onEnd = (event: TouchEvent): void => {
            if (scroller.end(event)) consume(event);
        };
        const onCancel = (): void => {
            scroller.cancel();
            reporter?.reset();
        };

        host.addEventListener('touchstart', onStart, { capture: true, passive: false });
        host.addEventListener('touchmove', onMove, { capture: true, passive: false });
        host.addEventListener('touchend', onEnd, { capture: true, passive: false });
        host.addEventListener('touchcancel', onCancel, { capture: true, passive: false });

        // The viewport's distance from the live bottom, mirrored onto the root for the audit.
        // Subscribed rather than written after each gesture because the engine moves it too: any
        // PTY byte snaps it back to the bottom (`renderer.ts` `onScrollChange`), and an attribute
        // that only knew what a finger asked for would lie the moment the shell printed.
        publishTouchScrollOffset(root, rendererRef.current?.scrollOffset() ?? 0);
        const offScroll = rendererRef.current?.onScrollChange((offset) => {
            publishTouchScrollOffset(rootRef.current, offset);
        });

        return () => {
            host.removeEventListener('touchstart', onStart, { capture: true });
            host.removeEventListener('touchmove', onMove, { capture: true });
            host.removeEventListener('touchend', onEnd, { capture: true });
            host.removeEventListener('touchcancel', onCancel, { capture: true });
            scroller.cancel();
            offScroll?.();
            clearTouchScrollOffset(rootRef.current);
        };
        // `status` is in the deps for the reason C2's textarea effect has it: a restart builds a
        // FRESH engine, and the scroll subscription belongs to the engine, not to the pane.
    }, [phone, paneID, status]);

    // ── C9 round 9: the caret is handed OVER, never handed back ─────────────────────
    //
    // **Owner-directed divergence from the shipped Swift app**, like every phone rule in this
    // program (`chrome/form-factor.ts` carries the note for all of it).
    //
    // The owner, on a real Android phone with three panes split (device round 9, 2026-09-08):
    // *"clicking between panes causes the keyboard to briefly hide and show."*
    //
    // THE MECHANISM, and it is two events with a gap between them. With the keyboard up, pane A's
    // engine textarea holds the caret. A tap on pane B's canvas starts by moving the caret to
    // NOTHING: the canvas is not focusable, so the browser's own focus move for the tap blurs A's
    // textarea, and Android begins dismissing the IME the moment the caret leaves an editable.
    // B's engine then takes the caret in its own `touchend` handler
    // (`vendor/ghostty-web-patched/source/lib/terminal.ts:490-493`), which summons the IME back.
    // The gap between the two is the length of the tap, which is exactly long enough for the
    // keyboard to animate down and up. Nothing in C3 closes it: the gesture machine deliberately
    // does NOT consume a plain tap's `touchstart` (`touch-scroll.ts` `start`, "a press that turns
    // out to be a tap belongs to the engine"), which is what lets a tap raise the keyboard at all.
    //
    // THE RULE. On a phone, while a keyboard is measurably up and the caret sits on ANOTHER pane's
    // surface, a touch that lands on this pane's terminal takes the caret STRAIGHT from that pane's
    // engine to this one, inside the gesture's first event, and cancels the browser's own focus
    // move for that gesture. The IME never sees the caret leave an editable, so it never animates.
    //
    // It is not a new way to raise a keyboard, which is what C5's rule protects
    // (`app/pane-focus.ts` `mayClaimPaneCaret`): it moves a caret that is ALREADY on a terminal,
    // between terminals, on the one gesture C5 names - a direct tap on a terminal surface. Both
    // gates are what keep it that narrow:
    //
    //   - the caret must be on a pane SURFACE outside this pane (`isPaneSurfaceCaret`). A caret on
    //     the body, on a key bar button, or in a chrome field is not a hand-over and is left alone;
    //   - a keyboard must be MEASURABLY up (C7's `data-keyboard-viewport`, the same signal C8's
    //     label reads). With no keyboard on screen there is nothing to flicker, so the tap keeps
    //     the path it has today and the engine's own `touchend` raises the keyboard - the person
    //     asked for it. That also answers Android's back gesture, which leaves the caret in the
    //     textarea with the keyboard gone (C8's shape): the mode reads `none`, so nothing here
    //     fires and a tap cannot summon a keyboard the person put away.
    //
    // WHEN IN THE GESTURE, and why it is the start rather than the end: the defect IS the browser's
    // focus move, and that happens at the start. Waiting for a tap to be a tap would leave the
    // caret on nothing for the length of the gesture, which is the gap this exists to remove. The
    // cost is that a DRAG that begins on this pane also brings the caret here - which is the same
    // answer the pane FOCUS already gives (`onTouchStartCapture` reports focus at the gesture's
    // start), so the caret and the ring now agree instead of disagreeing for the length of a drag.
    // C3's gesture machine is untouched: it still sees every touch event, a drag still scrolls this
    // pane, and a long press still selects.
    //
    // The one side effect of cancelling the event is that the compatibility mouse events (and the
    // synthesized click) are suppressed for that gesture. Nothing on a phone needs them: the pane
    // reports focus from `onTouchStartCapture`, C3 answers touch directly, and the mouse reporter's
    // phone path is the touch branch above.
    useEffect(() => {
        if (!phone) return;
        const root = rootRef.current;
        const host = hostRef.current;
        if (root === null || host === null || typeof document === 'undefined') return;
        /*
         * One gesture, both of its opening events. Chrome raises `pointerdown` and then
         * `touchstart` for the same finger, and which of the two suppresses the compatibility mouse
         * events (the ones that carry the browser's focus move for a touch) is engine-specific -
         * so the answer is to cancel both. The flag is what makes the second one cancel without
         * re-deciding: by then this pane holds the caret, so the condition below would (correctly)
         * say there is nothing to hand over.
         */
        let handedOver = false;
        const takeCaret = (event: Event): void => {
            if (handedOver) {
                event.preventDefault();
                return;
            }
            const target = event.target;
            if (!(target instanceof Node) || !host.contains(target)) return;
            const active = document.activeElement;
            // FROM another pane's surface, and from nothing else.
            if (active === null || host.contains(active) || !isPaneSurfaceCaret(active)) return;
            // …and only with a keyboard measurably on screen. A client that publishes no mode at
            // all (SSR, a tick before `main.tsx` binds it) has not measured one, so it does not
            // take this path.
            const mode = readKeyboardViewportMode(document);
            if (mode === null || mode === 'none') return;
            const input = engineKeyTarget(host);
            if (input === null) return;
            handedOver = true;
            // Cancel the browser's own focus move for this gesture, THEN make the move ourselves.
            // `preventScroll` because C7's whole rule is that nothing scrolls the app inside its
            // own window for a keyboard, and a focus is one of the things that can.
            event.preventDefault();
            input.focus({ preventScroll: true });
        };
        const endGesture = (): void => {
            handedOver = false;
        };
        root.addEventListener('pointerdown', takeCaret, { capture: true, passive: false });
        root.addEventListener('touchstart', takeCaret, { capture: true, passive: false });
        root.addEventListener('touchend', endGesture, true);
        root.addEventListener('touchcancel', endGesture, true);
        root.addEventListener('pointerup', endGesture, true);
        root.addEventListener('pointercancel', endGesture, true);
        return () => {
            root.removeEventListener('pointerdown', takeCaret, { capture: true });
            root.removeEventListener('touchstart', takeCaret, { capture: true });
            root.removeEventListener('touchend', endGesture, true);
            root.removeEventListener('touchcancel', endGesture, true);
            root.removeEventListener('pointerup', endGesture, true);
            root.removeEventListener('pointercancel', endGesture, true);
        };
        // `status` for the reason the effects around it have it: a restart builds a FRESH engine
        // with a fresh textarea, and `engineKeyTarget` has to resolve the new one.
    }, [phone, status]);

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
    // anything that is a Kelpi binding. A bound ⌘ chord can never reach this encoder.
    //
    // Nothing is intercepted while no application has negotiated the protocol: `keyboard.key()`
    // returns false for every event when the flags are zero, and for every key whose legacy
    // encoding is already correct even when they are not.
    //
    // The ONE thing this listener does with the protocol off is #95's, below.
    useEffect(() => {
        const host = hostRef.current;
        if (host === null) return;
        const keyboard = kittyRef.current;
        if (keyboard === null) return;

        const composing = (event: KeyboardEvent): boolean =>
            composingRef.current || event.isComposing || event.keyCode === 229;

        const handle = (event: KeyboardEvent, type: 'keydown' | 'keyup'): void => {
            if (composing(event)) return;
            if (keyboard.active) {
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
                if (consumed) {
                    event.preventDefault();
                    // Not `stopPropagation`: the engine may attach more than one listener to the
                    // same node, and only the immediate form guarantees none of them runs.
                    event.stopImmediatePropagation();
                    return;
                }
            }

            /*
             * #95: the chords the platform owns (⌘H, ⌥⌘H, ⌃⌘F, ⌘M, ⌘Q), at BOTH layers.
             *
             * macOS answers these from `role` rows in the application menu, and a native
             * accelerator on a role row fires only for a key the page did not consume
             * (`shell/src/menu.ts`, the ordering that whole file relies on). A terminal pane
             * consumed all five, so ⌘H hid Kelpi from a web pane and did nothing from a shell.
             *
             * Two layers had to be answered and the encoder can only reach one of them. Above:
             * `encodeKittyKey` returns null for these (`@kelpi/core/config` ▸ `isPlatformChord`),
             * which is what makes `consumed` false here even with the protocol negotiated.
             * Below: the vendored engine maps `event.code` and then calls `preventDefault()` on
             * anything it mapped, and a prevented key is never redispatched to the menu. So the
             * pane takes the event AWAY from the engine and deliberately does not prevent its
             * default: `stopImmediatePropagation()` without `preventDefault()`, the exact
             * opposite pairing to the branch above.
             *
             * Keydown only. The engine registers no `keyup` listener at all, so a release has
             * nothing below to protect it from, and the encoder has already declined it.
             *
             * A user binding still wins, by ordering rather than by a check here: the app's
             * dispatcher consumed a bound chord at window capture long before this runs. See
             * `@kelpi/core/config` ▸ `platform-chords.ts` for the whole rule.
             */
            if (type === 'keydown' && isPlatformChord(event)) event.stopImmediatePropagation();
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

    // ── the keyboard, as this pane sees it (C2, C6's box, C9's owner) ──────────────
    //
    // TWO clocks, deliberately (`keyboard-inset.ts` holds the reasons), and C9 moved the first of
    // them out of this component:
    //
    //   - the BOX runs at the viewport's clock, and the WINDOW owns it now. C6 wrote the live
    //     inset as a bottom padding on the pane ROOT, because C1's key bar sat inside the pane and
    //     had to ride the keyboard with it. The bar is one per window (`terminal/PhoneKeyBar.tsx`),
    //     so the padding is one per window too: `PhoneKeyBar` pads the content AREA in the same
    //     task as every visual-viewport event, the pane grid inside it gets shorter, and this
    //     pane's own `ResizeObserver` sees a shorter host exactly as it does for a divider drag.
    //     That also fixes an arithmetic the pane-local padding got wrong: two STACKED panes each
    //     took 300 px for one 300 px keyboard, because each padded itself, so 600 px of terminal
    //     went for a 300 px keyboard. The window takes the keyboard's pixels once, where the
    //     keyboard is.
    //   - the DAEMON still runs at the settle clock, and that is still this effect's: ONE resize
    //     per transition, up and down, because `onSettle` is what measures and the observer's own
    //     path is gated shut while the keyboard is moving.
    //
    // What the pane still PUBLISHES is the inset in force on its box, per frame, because the audit
    // reads it per pane (`phone-keyboard-inset`) and because "the daemon was told the rows this
    // keyboard leaves" is a fact about a pane rather than about a window. It is the inset as
    // measured here; the clamp that keeps a line to type on is the window's, and the two can only
    // differ for a keyboard taller than the whole content area.
    //
    // Measured (`phone-keyboard-inset`, `phone-key-bar-split`, and the jsdom tests beside them): a
    // burst of frame-cadence `visualViewport` resizes taking the viewport down by 300 px moves the
    // content area's box on every one of them, shrinks every pane in the grid, and costs each pane
    // exactly one `resize` on its stream; the return to zero costs one more.
    const publishKeyboardBox = useCallback((inset: number): void => {
        const next = Math.max(0, inset);
        if (next === keyboardInsetRef.current) return;
        keyboardInsetRef.current = next;
        publishKeyboardInset(rootRef.current, next);
    }, []);

    useEffect(() => {
        phoneRef.current = phone;
        if (!phone) {
            keyboardMovingRef.current = false;
            publishKeyboardBox(0);
            clearPhoneTerminalState(rootRef.current);
            return;
        }
        const motion = watchSoftKeyboardMotion(
            formFactorWindow,
            {
                onMove: (inset) => {
                    keyboardMovingRef.current = true;
                    // A resize already in flight would land an intermediate grid on the PTY
                    // behind us; not being in the race is cheaper than winning it.
                    clearResizeTimer();
                    publishKeyboardBox(inset);
                },
                onSettle: (inset) => {
                    keyboardMovingRef.current = false;
                    // The window has already moved the box: its listener and this one answer the
                    // SAME viewport event, in the same task, and the box the settle measures is
                    // therefore the one the keyboard left. The rows the daemon is told are the
                    // rows the pane can actually paint.
                    publishKeyboardBox(inset);
                    syncGeometry();
                }
            },
            keyboardSettleMs
        );
        // A pane that mounts (or turns into a phone) with the keyboard already up takes it
        // straight away: that is not a transition, so it neither arms the gate nor waits for it.
        publishKeyboardBox(motion.live());
        syncGeometry();
        publishPhoneTerminalState(rootRef.current, {
            inset: keyboardInsetRef.current,
            rows: geometryRef.current?.rows ?? 0,
            resizes: resizeMessages.current
        });
        return () => {
            motion.dispose();
            keyboardMovingRef.current = false;
            publishKeyboardBox(0);
        };
    }, [phone, formFactorWindow, keyboardSettleMs, publishKeyboardBox, clearResizeTimer, syncGeometry]);

    /*
     * C9 - the window's key bar mounts on `focused && visible`, and this pane is the answer.
     *
     * The registry publishes the predicate as `focusedOnScreen()` and reads it at call time; what
     * a pull cannot do is say that the answer MOVED, which it does whenever the ring moves or a
     * sibling is zoomed - none of which touches this pane's engine, its handle or its DOM. One
     * announcement per change, on the two props that decide it. Phone only: on a desktop nothing
     * is subscribed, so an announcement would be a message to nobody.
     */
    useEffect(() => {
        if (!phone) return;
        notifyTerminalPanes();
    }, [phone, focused, visible]);

    // ── the engine's textarea, told it is talking to a software keyboard (C2) ───────
    //
    // Phone only, and never called at all on a desktop - `applied` is what makes the "never"
    // literal: a pane that has always been a desktop never reaches the renderer, so its textarea
    // carries exactly the attributes the engine gave it. `status` is in the deps for the same
    // reason the focus effect has it: a restart builds a FRESH engine with a FRESH textarea, and
    // it has to be told again.
    const appliedTextInput = useRef(false);
    useEffect(() => {
        const renderer = rendererRef.current;
        if (renderer === null) return;
        if (phone) {
            renderer.setTextInputAttributes?.(PHONE_TEXT_INPUT_ATTRIBUTES);
            appliedTextInput.current = true;
            return;
        }
        if (!appliedTextInput.current) return;
        appliedTextInput.current = false;
        renderer.setTextInputAttributes?.(PHONE_TEXT_INPUT_ATTRIBUTES_CLEARED);
    }, [phone, status]);

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
             *
             * C5: and `claimCaret` is what actually makes it, so a phone coming back from
             * another app does not come back with the software keyboard up.
             */
            if (latest.current.focused === true && shouldGrabFocus(hostRef.current)) {
                claimCaret();
            }
        };
        document.addEventListener('visibilitychange', resync);
        window.addEventListener('focus', resync);
        return () => {
            document.removeEventListener('visibilitychange', resync);
            window.removeEventListener('focus', resync);
        };
    }, [syncGeometry, claimCaret]);

    // ── focus ───────────────────────────────────────────────────────────────────────
    useEffect(() => {
        const renderer = rendererRef.current;
        if (renderer === null) return;
        if (focused && visible) {
            /*
             * Issue #35 - the claim is ARMED, not one-shot.
             *
             * `shouldGrabFocus` declining is correct: a sidebar rename, the filter or the palette
             * mid-edit keeps its caret. What was missing was the second attempt. This effect's
             * deps are `[focused, visible, status]`, none of which change when the field the
             * claim deferred to is finally let go, so a declined claim was dropped outright: the
             * pane wore the ring, drew a blinking cursor (below), and every keystroke went to the
             * field until the user clicked the pane. A click takes the caret whatever holds it,
             * which is the whole of "clicking it fixes it": the engine's canvas `mousedown`
             * listener focuses its textarea, and while an application tracks the mouse the
             * reporter, which keeps that press from the engine, makes the claim itself for the
             * pane wearing the ring (#158).
             *
             * `armCaretClaim` is the rule the WEB pane has had since §N30's residual, in the
             * shared module: claim now if the caret is free, otherwise stay armed and re-decide
             * when it moves. The cleanup disarms, so an armed claim never outlives the ring that
             * justified it, and `rendererRef` is read at claim time rather than closed over
             * because a restart builds a fresh engine.
             *
             * C5 - and the claim itself is `claimCaret`, which is a no-op on a phone. The arming
             * is deliberately left in place there rather than skipped: what it costs is two
             * capture listeners that decide nothing, and what it buys is that the desktop path
             * through this effect is not a second shape somebody has to keep in step with the
             * first. The claim was the whole of the keyboard, and the claim is where the rule is.
             */
            return armCaretClaim(hostRef.current, claimCaret);
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
    // (`BaseTerminalController.syncFocusToSurfaceTree`) — a Kelpi window sent to the background
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

    const background = props.background ?? theme?.background ?? 'var(--kelpi-term-bg, #0A0A0C)';


    return (
        <div
            ref={rootRef}
            data-pane-id={paneID}
            data-terminal-status={status}
            data-terminal-attempts={String(attempts)}
            data-terminal-failure={failure ?? undefined}
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
            /*
             * C9 - ONE class string, on a phone as on a desktop.
             *
             * C1's bar was a flex child of this element, so a phone pane became a column flex box
             * and the host became a shrinkable flex item. The bar is one per WINDOW now
             * (`terminal/PhoneKeyBar.tsx`, and the owner's 2026-09-08 report is why), so there is
             * nothing below the host to make room for and the pane renders the tree it has always
             * rendered - the same string on both form factors, which is a stronger statement of
             * "desktop is untouched" than the branch it replaces.
             */
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
                // the Swift app had. The top gets the same treatment (`window-padding-y`'s top
                // half) so row 1 doesn't sit flush against the pane edge; the host's
                // `clientHeight` shrinks with it, so the rows the PTY is told about stay exactly
                // the rows the canvas can paint and the bottom row is never clipped.
                //
                // The BOTTOM is deliberately not here. On a phone it is the software keyboard's
                // (C6), written imperatively by `applyKeyboardInset` at the viewport's frame rate;
                // React never renders the property, so it never fights that write, and a desktop
                // pane's inline style is the same three declarations it has always had.
                paddingLeft: props.paddingX ?? TERMINAL_EDGE_PADDING,
                paddingRight: props.paddingX ?? TERMINAL_EDGE_PADDING,
                paddingTop: props.paddingY ?? TERMINAL_EDGE_PADDING_TOP
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
            <div
                ref={hostRef}
                className="h-full w-full"
                data-terminal-host=""
                {...{ [PANE_SURFACE_ATTR]: '' }}
            />
            {status === 'error' ? (
                // Interactive on purpose (it used to be `pointer-events-none`): the placeholder
                // is now the last stop on the retry path, not a dead end. The pane root still
                // sees the click through the capture-phase handler above, so asking for focus
                // keeps working.
                <div
                    role="status"
                    className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-xs"
                    style={{ color: 'var(--kelpi-fg-secondary, #9A9AA0)' }}
                >
                    <span>
                        {failure === 'wasm-address-space'
                            ? 'the renderer is out of WebAssembly memory - restart the UI to recover (the daemon keeps every pane and session)'
                            : 'terminal renderer failed to start'}
                    </span>
                    {failure === 'wasm-address-space' ? (
                        <button
                            type="button"
                            data-testid={`terminal-restart-ui-${paneID}`}
                            onClick={restartUI}
                            title="Reload the UI and reconnect to the daemon; panes and sessions are kept"
                            className="cursor-pointer rounded text-xs font-medium whitespace-nowrap"
                            style={{
                                padding: '5px 12px',
                                border: '1px solid var(--kelpi-border, #24242B)',
                                color: 'var(--kelpi-accent, #6F9BD8)',
                                backgroundColor: 'var(--kelpi-header-bg, #13131A)'
                            }}
                        >
                            Restart UI
                        </button>
                    ) : null}
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
                            border: '1px solid var(--kelpi-border, #24242B)',
                            color: 'var(--kelpi-accent, #6F9BD8)',
                            backgroundColor: 'var(--kelpi-header-bg, #13131A)'
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
