/**
 * `TerminalRenderer` — the engine seam (WP3.2).
 *
 * Everything above this file talks to ONE narrow interface: `open / write / onData / resize /
 * focus / dispose / setTheme / cellSize`. Two engines implement it:
 *
 *   - **ghostty-web** (default): Ghostty's real VT parser as WASM behind an xterm.js-shaped
 *     API — the fidelity bet in ARCHITECTURE.md.
 *   - **@xterm/xterm** (fallback): selected with `VITE_TERMINAL_ENGINE=xterm` at build time,
 *     the escape hatch for the ghostty-web gaps catalogued in
 *     `docs/research/ghostty-web-spike.md`.
 *
 * The adapter itself is engine-agnostic: it codes strictly to `XtermLikeTerminal`, the subset
 * both engines implement identically. Anything engine-specific (cell metrics, forced repaint,
 * live theming) is isolated in an `EngineLoader`, so a third engine is one loader away and the
 * component layer never learns which one it got.
 *
 * Three behaviours the adapter owns, all forced by the engines (verified hands-on — see the
 * spike doc):
 *
 *   1. **Deferred open.** Both engines load asynchronously (ghostty-web must `await init()`
 *      for its WASM), and ghostty-web THROWS on `write()`/`resize()`/`getMode()` before
 *      `open()` ("Terminal must be opened before use"; xterm.js tolerates it). Writes and the
 *      pending geometry are therefore queued and flushed when the engine is live — which is
 *      also what makes "replay first, then live bytes" hold across the load (`ingest.ts`).
 *   2. **Focus discipline.** `ghostty-web`'s `open()` calls `focus()` on itself (coder/
 *      ghostty-web#100). An unfocused pane mounting in a grid must not steal the caret, so the
 *      adapter re-asserts the caller's intent right after open.
 *   3. **Reset is a byte, not a call.** `reset()` writes RIS (`ESC c`) into the same stream
 *      instead of calling the engine's `reset()`: it keeps ordering with xterm.js's
 *      *asynchronous* write queue (a synchronous `reset()` would clobber bytes still parsing),
 *      and it avoids ghostty-web's `reset()`, which frees and re-creates the WASM terminal
 *      (ghostty-web#141 reports corruption after freeing a terminal that saw graphemes).
 *      Verified on both engines: RIS clears screen + scrollback, resets modes and leaves the
 *      alternate screen.
 *   4. **Startups are serialized, and an engine that throws is poisoned, not retried in
 *      place.** See `serializeEngineStartup` and `AdapterRenderer.poison` — the two halves of
 *      run-F N1.
 */

import { loadTerminalFonts, measureCellSize, TERMINAL_FONT_FALLBACKS } from './fonts';

export type TerminalEngine = 'ghostty' | 'xterm';

export const TERMINAL_ENGINES: readonly TerminalEngine[] = ['ghostty', 'xterm'];

export const DEFAULT_TERMINAL_ENGINE: TerminalEngine = 'ghostty';

/** Cell metrics in CSS pixels — what cols/rows are measured with (terminal-surface.md §5). */
export interface CellSize {
    readonly width: number;
    readonly height: number;
}

/**
 * xterm.js `ITheme` shape. Both engines accept exactly this object, so it is the portable
 * theme format. **Colors must be `#rgb` / `#rrggbb` / `rgb(r, g, b)`**: ghostty-web's
 * `parseColorToHex` silently maps anything else (named colors, `rgba()`, `hsl()`,
 * `color-mix()`) to black.
 *
 * Every member is `string | undefined` here (this repo builds with
 * `exactOptionalPropertyTypes`) while both engines declare theirs as plain `string?`, so the
 * object is passed through `compactTheme` on the way in — which is a runtime requirement too:
 * ghostty-web merges `{ ...defaults, ...theme }`, so an explicitly-`undefined` key wipes the
 * default and `parseColorToHex(undefined) === 0` paints that role **black**.
 */
export interface TerminalTheme {
    readonly background?: string | undefined;
    readonly foreground?: string | undefined;
    readonly cursor?: string | undefined;
    readonly cursorAccent?: string | undefined;
    readonly selectionBackground?: string | undefined;
    readonly selectionForeground?: string | undefined;
    readonly black?: string | undefined;
    readonly red?: string | undefined;
    readonly green?: string | undefined;
    readonly yellow?: string | undefined;
    readonly blue?: string | undefined;
    readonly magenta?: string | undefined;
    readonly cyan?: string | undefined;
    readonly white?: string | undefined;
    readonly brightBlack?: string | undefined;
    readonly brightRed?: string | undefined;
    readonly brightGreen?: string | undefined;
    readonly brightYellow?: string | undefined;
    readonly brightBlue?: string | undefined;
    readonly brightMagenta?: string | undefined;
    readonly brightCyan?: string | undefined;
    readonly brightWhite?: string | undefined;
}

export interface TerminalRendererOptions {
    readonly engine?: TerminalEngine | undefined;
    readonly fontFamily?: string | undefined;
    readonly fontSize?: number | undefined;
    readonly theme?: TerminalTheme | undefined;
    readonly cols?: number | undefined;
    readonly rows?: number | undefined;
    /** `@xterm/xterm`: scrollback in LINES. */
    readonly scrollbackLines?: number | undefined;
    /** `ghostty-web`: scrollback in BYTES — its `scrollback` option is bytes (issue #140). */
    readonly scrollbackBytes?: number | undefined;
    readonly cursorBlink?: boolean | undefined;
    /**
     * Let the pane fill BEHIND the canvas show through the terminal's default background (§4).
     *
     * §N17 — this used to default to `true` and mean nothing: `ghostty-web` accepted the option
     * and never read it, so the canvas was filled opaque whatever the pane behind it did, and a
     * `background-opacity = 0.85` terminal came out solid. The vendored engine implements it
     * now (`RendererOptions.allowTransparency`, `0.4.0-nex.3`), which makes the DEFAULT
     * load-bearing: it is `false`, the value both engines document, so an opaque config takes
     * exactly the paint path it always did. Assembly passes `backgroundOpacity < 1`.
     */
    readonly allowTransparency?: boolean | undefined;
}

/**
 * Where a search match sits, addressed from the BOTTOM of the buffer.
 *
 * The daemon holds the buffer that was searched (`daemon/src/ws/search.ts`) and its scrollback
 * is not this engine's: `@xterm/headless` keeps 10 000 lines, ghostty-web bounds its own in
 * BYTES, and a fresh client replays a possibly-capped snapshot. Absolute line indices therefore
 * do not survive the crossing; the bottom does, so that is the anchor.
 *
 * `linesFromBottom` is `bufferLength - matchLine`, so 1 is the last line of the buffer.
 */
export interface TerminalMatchLocation {
    readonly linesFromBottom: number;
    readonly col: number;
    readonly length: number;
}

export interface TerminalRenderer {
    readonly engine: TerminalEngine;
    /** Grid size the engine currently holds (the requested size until it is open). */
    readonly cols: number;
    readonly rows: number;
    /** Resolves when the engine is loaded and attached; rejects if the engine failed to open. */
    readonly ready: Promise<void>;
    /**
     * The engine threw from inside itself and has been abandoned. A poisoned renderer accepts
     * no further bytes — its owner must dispose it and build a fresh one (run-F N1).
     */
    readonly failed: boolean;
    /**
     * The engine died AFTER `open()` had resolved. Fires at most once, and only for a renderer
     * that was already live: a failure DURING the open is reported by rejecting `open()`, so a
     * caller that handles both never gets told twice. Returns an unsubscribe.
     */
    onEngineFailure(listener: (error: unknown) => void): () => void;
    /** Idempotent: a second `open` returns the same promise. */
    open(element: HTMLElement): Promise<void>;
    /** Raw PTY bytes. Never decode them first — UTF-8 splits across chunk boundaries. */
    write(data: Uint8Array | string): void;
    /** Full reset; used when a replay supersedes what is on screen. */
    reset(): void;
    /** Keyboard/paste output, already encoded by the engine. Returns an unsubscribe. */
    onData(listener: (data: string) => void): () => void;
    onBell(listener: () => void): () => void;
    onTitleChange(listener: (title: string) => void): () => void;
    /**
     * The live selection, as text (`''` when there is none, or when the engine has no read).
     *
     * §TERM-034's port-side answer. The Swift reads the selection out of libghostty so macOS
     * text services see it; a browser has no equivalent consumer, but the read itself is not
     * engine-specific — BOTH engines expose `getSelection()` — and having it is what lets the
     * app (and the audit) tell "the engine made a selection" from "the application was sent a
     * mouse report", which are mutually exclusive by design (§TERM-037).
     */
    selection(): string;
    /** Fires when the engine's selection changes. Returns an unsubscribe. */
    onSelectionChange(listener: (selection: string) => void): () => void;
    /**
     * Drop the engine's selection.
     *
     * Called the moment a mouse report is sent (§TERM-037), which is ghostty's own rule:
     * `Surface.zig:3850-3852` — "In any other mouse button scenario without shift pressed we
     * clear the selection since the underlying application can handle that in any way." Without
     * it, a selection made before an application asked for the mouse would sit highlighted over
     * a TUI that is now handling the same drag itself.
     */
    clearSelection(): void;
    resize(cols: number, rows: number): void;
    focus(): void;
    blur(): void;
    /**
     * Does the PANE hold focus? (§N20 — `ghostty_surface_set_focus`.)
     *
     * Separate from `focus()`/`blur()`, which move the DOM caret, because the two answers
     * differ in both directions and the cursor follows this one:
     *
     *   - a window that loses OS focus keeps its `document.activeElement` exactly where it was,
     *     and native ghostty unfocuses the surface anyway
     *     (`BaseTerminalController.syncFocusToSurfaceTree` gates on `window.isKeyWindow`);
     *   - a pane whose engine is mid-load has not been focused yet but already knows whether it
     *     is the focused pane.
     *
     * Focused, the cursor is the one the terminal asked for, blinking if it asked for that.
     * Unfocused, it is a steady hollow block — `src/renderer/cursor.zig:59-60`.
     */
    setSurfaceFocus(focused: boolean): void;
    setTheme(theme: TerminalTheme): void;
    /** CSS-pixel cell metrics; falls back to a font-derived estimate before the engine is up. */
    cellSize(): CellSize;
    /** Best-effort full repaint (visibility regain). No-op where the engine has no hook. */
    repaint(): void;
    /**
     * Scroll a search match into view and select it (`grid/PaneSearchOverlay.tsx`).
     *
     * Best-effort by contract: an engine with no scroll hook, or a match older than this
     * renderer's retained scrollback, leaves the viewport where it is. The overlay's counter
     * stays correct either way, because the count is the daemon's, not the engine's.
     */
    revealMatch(match: TerminalMatchLocation): void;
    /**
     * Re-measure the cell after a font has loaded. Optional because a fake or a third engine
     * may have nothing to re-measure; the pane calls it when the bundled face settles AFTER
     * the engine was built (a slow link), which is the only way to correct metrics that were
     * taken against the fallback.
     */
    remeasure?(): void;
    /**
     * Is the engine currently holding its paint across a resize→replay window? (§N24.)
     *
     * Diagnostics only — the pane mirrors it into a `data-` attribute so the audit can assert
     * that the hold engages and, more importantly, that it always ends.
     */
    readonly paintHeld: boolean;
    /** Resize→replay windows this renderer released on the TIMEOUT rather than on a replay. */
    readonly paintHoldTimeouts: number;
    /**
     * Fires on every transition of `paintHeld`. Returns an unsubscribe.
     *
     * The pane mirrors it onto its root node imperatively (no React re-render — a drag opens a
     * window per debounce fire), which is what lets the audit assert the invariant in pixels:
     * while the attribute reads `true` the canvas must not change.
     */
    onPaintHoldChange(listener: (held: boolean) => void): () => void;
    dispose(): void;
}

export type TerminalRendererFactory = (options?: TerminalRendererOptions) => TerminalRenderer;

// ── the engine subset ───────────────────────────────────────────────────────────────

export interface EngineDisposable {
    dispose(): void;
}

/**
 * The xterm.js API subset both engines implement identically. The adapter uses nothing else,
 * which is the whole compatibility contract.
 */
export interface XtermLikeTerminal {
    readonly cols: number;
    readonly rows: number;
    open(parent: HTMLElement): void;
    write(data: string | Uint8Array, callback?: () => void): void;
    reset(): void;
    focus(): void;
    blur(): void;
    resize(cols: number, rows: number): void;
    dispose(): void;
    onData(listener: (data: string) => void): EngineDisposable;
    onBell?(listener: () => void): EngineDisposable;
    onTitleChange?(listener: (title: string) => void): EngineDisposable;
    onResize?(listener: (size: { cols: number; rows: number }) => void): EngineDisposable;
    /** Both shipped engines have these; typed optional so a fake need not (§TERM-034). */
    getSelection?(): string;
    onSelectionChange?(listener: () => void): EngineDisposable;
    clearSelection?(): void;
}

/** What a loader hands back: the terminal plus the engine-specific bits it can serve. */
export interface EngineHandle {
    readonly terminal: XtermLikeTerminal;
    /** Real cell metrics once the engine has measured its font. */
    cellSize?(): CellSize | undefined;
    /** Live theming; without it the adapter falls back to nothing (theme is init-only). */
    setTheme?(theme: TerminalTheme): void;
    /**
     * Re-measure the font after it has loaded. The engines measure their cell once, at
     * construction; a face that arrives later leaves them drawing at fallback metrics.
     */
    remeasure?(): void;
    /** Force a full redraw. */
    repaint?(): void;
    /**
     * Report SURFACE focus, so the cursor can take ghostty's unfocused treatment (§N20).
     *
     * Optional because it is engine-specific in an asymmetric way. `ghostty-web` had no such
     * concept at all until `0.4.0-nex.4` added `Terminal.setFocused` (every pane on the page
     * blinked a filled block forever, which is the defect); `@xterm/xterm` has drawn an outline
     * cursor on blur since forever, driven by its own DOM focus, so its handle omits this and
     * `focus()`/`blur()` remain the whole story there. A fake engine omits it too.
     */
    setSurfaceFocus?(focused: boolean): void;
    /**
     * Suspend or resume PAINTING, without touching the VT (§N24 — `ghostty-web 0.4.0-nex.6`).
     *
     * Optional, and only ghostty-web has it: a widening `ghostty_terminal_resize` can leave
     * cells in libghostty-vt's own storage that the VT never wrote, and the engine's render
     * loop paints them on the very next frame. `@xterm/xterm` has no such state (its buffer is
     * JS objects), and a fake engine has no canvas — both simply omit this, and the adapter's
     * hold becomes a no-op for them.
     */
    setPaintSuspended?(suspended: boolean): void;
    /**
     * Scroll a search match into view and select it. Engine-specific on purpose: the two
     * engines' `scrollToLine` mean different things (xterm.js takes the absolute buffer line to
     * put at the top of the viewport; ghostty-web takes the number of lines scrolled UP from the
     * bottom), and their `select()` row is absolute vs viewport-relative respectively.
     */
    revealMatch?(match: TerminalMatchLocation): void;
    /** Extra teardown beyond `terminal.dispose()`. */
    dispose?(): void;
}

export type EngineLoader = (options: ResolvedRendererOptions) => Promise<EngineHandle>;

export interface ResolvedRendererOptions {
    readonly engine: TerminalEngine;
    readonly fontFamily: string;
    readonly fontSize: number;
    readonly theme: TerminalTheme;
    readonly cols: number;
    readonly rows: number;
    readonly scrollbackLines: number;
    readonly scrollbackBytes: number;
    readonly cursorBlink: boolean;
    readonly allowTransparency: boolean;
}

// ── defaults ────────────────────────────────────────────────────────────────────────

/**
 * The bundled Nerd Font first (see `fonts.ts`): without it a powerlevel10k prompt is a row of
 * tofu boxes, because no system monospace on macOS carries Powerline or Nerd Font glyphs.
 */
export const DEFAULT_FONT_FAMILY = TERMINAL_FONT_FALLBACKS;
export const DEFAULT_FONT_SIZE = 13;
/** xterm counts lines. */
export const DEFAULT_SCROLLBACK_LINES = 10_000;
/** ghostty-web counts bytes (issue #140); native Ghostty defaults to 10 MB. */
export const DEFAULT_SCROLLBACK_BYTES = 5_000_000;
/** Queued bytes tolerated before the engine is open; beyond this the oldest chunks go. */
export const PENDING_WRITE_LIMIT_BYTES = 4 * 1024 * 1024;

/**
 * Ceiling on how long one engine startup may hold the serialization gate (see
 * `serializeEngineStartup`). A startup that wedges must not wedge every pane behind it, so the
 * next waiter goes anyway once this elapses — the gate narrows a race, it is not a lock whose
 * failure mode is a hung window.
 */
export const ENGINE_STARTUP_GATE_TIMEOUT_MS = 10_000;

/**
 * Ceiling on the resize→replay paint hold (§N24). See `AdapterRenderer.resize`.
 *
 * The daemon owes one settled-resize replay per changed grid and takes
 * `DEFAULT_RESIZE_RESYNC_MS` (150 ms) to settle before it even snapshots, so the honest window
 * is "150 ms plus a snapshot plus a socket". This is the defensive cap on top of that: a replay
 * that never arrives — a socket that dropped mid-gesture, a pane the daemon has already
 * detached, a resize the hub decided not to resync — must not leave a pane frozen forever.
 *
 * Releasing on the timeout is a DELIBERATE fall back to the pre-N24 behaviour for that one
 * frame (the engine may still be holding the corrupt cells), because a stale-but-live pane is
 * better than a dead one, and the very next byte from the shell repaints it. It is counted
 * (`paintHoldTimeouts`) precisely so "this never happens in practice" stays a measurement.
 */
export const RESIZE_PAINT_HOLD_TIMEOUT_MS = 1_000;

/**
 * Dark palette matching the chrome tokens (`--kelpi-bg` / `--kelpi-fg`). Hex only — see
 * `TerminalTheme`.
 *
 * The foreground is **ghostty's own default** (`#FFFFFF`, `src/config/Config.zig`), not the
 * chrome's `textPrimary`. The terminal is ghostty's surface, and a body dimmer than the pane
 * header that frames it is precisely the "ordinary output reads like SGR dim" the audit found
 * (run-B L4): against `#0A0A0C` the chrome grey is 17.7:1 while ghostty's white is 20.4:1, and
 * the difference is exactly the gap a user reads as "this text is faint".
 */
export const DEFAULT_TERMINAL_THEME: TerminalTheme = {
    background: '#0A0A0C',
    foreground: '#FFFFFF',
    cursor: '#FFFFFF',
    cursorAccent: '#0A0A0C',
    selectionBackground: '#2A3550',
    selectionForeground: '#E6E6EA',
    black: '#15151A',
    red: '#D9707A',
    green: '#5FBE89',
    yellow: '#D3A329',
    blue: '#6F9BD8',
    magenta: '#B18AD1',
    cyan: '#5FB3B3',
    white: '#C9C9D1',
    brightBlack: '#4A4A55',
    brightRed: '#E88E96',
    brightGreen: '#7FD4A3',
    brightYellow: '#E5BE55',
    brightBlue: '#8FB5E6',
    brightMagenta: '#C7A6E0',
    brightCyan: '#7FCACA',
    brightWhite: '#F2F2F6'
};

/**
 * The light column of the same palette — the values `styles.css` defines under
 * `prefers-color-scheme: light` / `[data-kelpi-theme="light"]`, as data.
 *
 * It exists so the palette can be chosen from the RESOLVED chrome bucket instead of by reading
 * the DOM at a moment nobody controls. Reading CSS variables one commit too early is how the
 * light foreground (`#2B2B2E`) ended up painted on the dark background for a whole session
 * (run-B L4): the values were never wrong, the *timing* was.
 */
export const LIGHT_TERMINAL_THEME: TerminalTheme = {
    background: '#FFFFFF',
    foreground: '#2B2B2E',
    cursor: '#2B2B2E',
    cursorAccent: '#FFFFFF',
    selectionBackground: '#CFE0F5',
    selectionForeground: '#2B2B2E',
    black: '#2B2B2E',
    red: '#D0453C',
    green: '#3F9457',
    yellow: '#B99413',
    blue: '#3D74C0',
    magenta: '#8158C8',
    cyan: '#3F8F8F',
    white: '#D8D6D0',
    brightBlack: '#6B6C70',
    brightRed: '#E0655C',
    brightGreen: '#4FA46B',
    brightYellow: '#C8A52A',
    brightBlue: '#5E8AC4',
    brightMagenta: '#9A72DD',
    brightCyan: '#4FA8A8',
    brightWhite: '#FFFFFF'
};

/** The palette for a resolved chrome bucket (`chrome/theme.ts` `ChromeBucket`). */
export function terminalThemePreset(bucket: 'light' | 'dark'): TerminalTheme {
    return bucket === 'light' ? LIGHT_TERMINAL_THEME : DEFAULT_TERMINAL_THEME;
}

/**
 * CSS custom properties the terminal reads, with the dark preset as the fallback — same
 * pattern as `grid/tokens.ts`, so assembly unifies the palette by defining them on `:root`.
 */
export const TERMINAL_TOKEN_NAMES: Readonly<Record<keyof TerminalTheme, string>> = {
    background: '--kelpi-term-bg',
    foreground: '--kelpi-term-fg',
    cursor: '--kelpi-term-cursor',
    cursorAccent: '--kelpi-term-cursor-accent',
    selectionBackground: '--kelpi-term-selection-bg',
    selectionForeground: '--kelpi-term-selection-fg',
    black: '--kelpi-term-black',
    red: '--kelpi-term-red',
    green: '--kelpi-term-green',
    yellow: '--kelpi-term-yellow',
    blue: '--kelpi-term-blue',
    magenta: '--kelpi-term-magenta',
    cyan: '--kelpi-term-cyan',
    white: '--kelpi-term-white',
    brightBlack: '--kelpi-term-bright-black',
    brightRed: '--kelpi-term-bright-red',
    brightGreen: '--kelpi-term-bright-green',
    brightYellow: '--kelpi-term-bright-yellow',
    brightBlue: '--kelpi-term-bright-blue',
    brightMagenta: '--kelpi-term-bright-magenta',
    brightCyan: '--kelpi-term-bright-cyan',
    brightWhite: '--kelpi-term-bright-white'
};

/**
 * RIS — the engine-agnostic full reset (`ingest.ts` uses it when a replay supersedes the
 * screen). Verified on both engines: clears screen + scrollback, resets modes (DECCKM,
 * bracketed paste), leaves the alternate screen, homes the cursor.
 */
export const TERMINAL_RESET_SEQUENCE = '\u001bc';

const COLOR_PATTERN = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/i;

/** ghostty-web parses only these forms; anything else would silently render black. */
export function isEngineColor(value: string | undefined | null): value is string {
    return typeof value === 'string' && COLOR_PATTERN.test(value.trim());
}

/**
 * Drop undefined members before handing a theme to an engine. Required twice over: the
 * engines' `ITheme` is not `exactOptionalPropertyTypes`-compatible, and an explicit
 * `undefined` would override their built-in default with black at runtime.
 */
export function compactTheme(theme: TerminalTheme): Record<string, string> {
    const compact: Record<string, string> = {};
    for (const [key, value] of Object.entries(theme)) {
        if (typeof value === 'string' && value !== '') compact[key] = value;
    }
    return compact;
}

/**
 * Resolve the palette from CSS custom properties on `element` (or `:root`), keeping `base`
 * (the dark preset unless the caller knows better) for anything unset or in a color format the
 * engines cannot parse.
 *
 * Pass the bucket's preset as `base` when the caller knows which appearance it is rendering:
 * the DOM read is only as current as the last theme stamp, and the preset is the answer that
 * cannot be stale.
 */
export function resolveTerminalTheme(element?: Element | null, base: TerminalTheme = DEFAULT_TERMINAL_THEME): TerminalTheme {
    const scope = element ?? (typeof document === 'undefined' ? null : document.documentElement);
    if (scope === null || typeof getComputedStyle !== 'function') return base;
    let styles: CSSStyleDeclaration;
    try {
        styles = getComputedStyle(scope);
    } catch {
        return base;
    }
    const resolved: Record<string, string> = {};
    for (const [key, token] of Object.entries(TERMINAL_TOKEN_NAMES)) {
        const raw = styles.getPropertyValue(token).trim();
        if (isEngineColor(raw)) resolved[key] = raw;
    }
    return { ...base, ...resolved };
}

// ── engine selection ────────────────────────────────────────────────────────────────

export function resolveTerminalEngine(raw?: string | null | undefined): TerminalEngine {
    const value = (raw ?? '').trim().toLowerCase();
    return value === 'xterm' || value === 'ghostty' ? value : DEFAULT_TERMINAL_ENGINE;
}

/** `VITE_TERMINAL_ENGINE` at build time; `ghostty` unless it says otherwise. */
export function configuredTerminalEngine(): TerminalEngine {
    const meta = import.meta as ImportMeta & { env?: Record<string, string | undefined> | undefined };
    return resolveTerminalEngine(meta.env?.['VITE_TERMINAL_ENGINE']);
}

// ── cell metrics ────────────────────────────────────────────────────────────────────

/**
 * Cell estimate for the geometry a pane needs BEFORE its engine exists (and for jsdom, where
 * there is no 2D context at all).
 *
 * It measures the way the engine does — `fonts.ts` `measureCellSize` mirrors ghostty-web's
 * `ceil(measureText('M').width)` — so the columns a pane attaches with are the columns the
 * engine will report afterwards. Measuring differently is not a harmless approximation: a
 * fractional advance yields one column too many, whose canvas is then wider than the pane and
 * clipped on the right (the p10k filler that runs off the edge). Accuracy also depends on the
 * font being LOADED, which is why every caller awaits `loadTerminalFonts()` first.
 */
export function estimateCellSize(fontSize: number, fontFamily: string): CellSize {
    return measureCellSize(fontSize, fontFamily);
}

// ── engine startup serialization (run-F N1) ─────────────────────────────────────────

/**
 * Every engine startup in the page runs one at a time.
 *
 * ghostty-web 0.4 puts **every terminal in the tab through one shared WASM instance**, and its
 * `init()` is not idempotent under concurrency — the shipped dist is literally
 *
 *     let R = null;
 *     async function init() { R || (R = await Ghostty.load()); }
 *
 * so two panes that start while neither `load()` has settled each see `R === null`, each
 * instantiate the module, and the singleton ends up whichever finished last. Panes then hold
 * terminals from *different* instances, allocate from one heap and index another, and the first
 * write after `open()` lands outside the buffer it was measured against:
 *
 *     RangeError: offset is out of bounds
 *         at Uint8Array.set        ← GhosttyTerminal.write: alloc into instance A,
 *         at K.write                 `new Uint8Array(memory.buffer).set(bytes, ptr)`
 *
 * That is run-F N1 — two occurrences in four full audit runs, always on a flow that reveals a
 * pane while another engine is still coming up (`kelpi pane split`, `kelpi workspace create`).
 * Serializing the whole startup — load, `open()`, geometry, and the first flush — means a
 * second pane never instantiates while the first is mid-flight, which is the window the bug
 * lives in. The cost is nothing after the first pane: `init()` returns an already-resolved
 * promise and the rest of the critical section is synchronous.
 *
 * It is a *narrowing*, not a proof of absence, which is why the retry path exists too.
 */
let engineStartupGate: Promise<void> = Promise.resolve();

/** Resolve when `promise` settles or `ms` elapses — whichever comes first. Never rejects. */
function settledOrAfter(promise: Promise<void>, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        // A gate timer must never hold a test runner (or Node) open on its own.
        (timer as unknown as { unref?: () => void }).unref?.();
        void promise.then(
            () => {
                clearTimeout(timer);
                resolve();
            },
            () => {
                clearTimeout(timer);
                resolve();
            }
        );
    });
}

/**
 * Run `task` with no other serialized startup in flight. Exported because it is the seam the
 * unit tests assert exclusivity through.
 */
export function serializeEngineStartup<T>(task: () => Promise<T>, timeoutMs = ENGINE_STARTUP_GATE_TIMEOUT_MS): Promise<T> {
    const predecessor = engineStartupGate;
    let release: () => void = () => undefined;
    engineStartupGate = new Promise<void>((resolve) => {
        release = resolve;
    });
    return (async (): Promise<T> => {
        await settledOrAfter(predecessor, timeoutMs);
        try {
            return await task();
        } finally {
            release();
        }
    })();
}

/** Drop the queue between test files, so one pending startup cannot stall the next suite. */
export function resetEngineStartupGateForTests(): void {
    engineStartupGate = Promise.resolve();
}

// ── engine fault injection (the stress harness's seam) ──────────────────────────────

/** Where a synthetic engine failure is planted. */
export type EngineFaultKind = 'load' | 'open' | 'write';

/**
 * A page-global hook the renderer consults, so a harness can make the N1 failure happen on
 * demand instead of waiting for a one-in-two run of the full audit.
 *
 * Nothing in the app installs it: the adapter reads `globalThis.__kelpiTerminalFaults` once per
 * renderer and holds `undefined` in every real session, so the cost in production is one
 * property read at construction. `packages/shell/scripts/renderer-start-stress.mjs` sets it
 * over CDP; returning a message plants that error, returning nothing lets the call through.
 */
export interface EngineFaultHook {
    fault(kind: EngineFaultKind, engine: TerminalEngine): string | undefined;
}

function engineFaultHook(): EngineFaultHook | undefined {
    const hook = (globalThis as { __kelpiTerminalFaults?: EngineFaultHook | undefined }).__kelpiTerminalFaults;
    return hook !== undefined && typeof hook.fault === 'function' ? hook : undefined;
}

// ── the adapter ─────────────────────────────────────────────────────────────────────

function resolveOptions(options: TerminalRendererOptions | undefined, engine: TerminalEngine): ResolvedRendererOptions {
    return {
        engine,
        fontFamily: options?.fontFamily ?? DEFAULT_FONT_FAMILY,
        fontSize: options?.fontSize ?? DEFAULT_FONT_SIZE,
        theme: options?.theme ?? DEFAULT_TERMINAL_THEME,
        cols: Math.max(1, Math.trunc(options?.cols ?? 80)),
        rows: Math.max(1, Math.trunc(options?.rows ?? 24)),
        scrollbackLines: options?.scrollbackLines ?? DEFAULT_SCROLLBACK_LINES,
        scrollbackBytes: options?.scrollbackBytes ?? DEFAULT_SCROLLBACK_BYTES,
        cursorBlink: options?.cursorBlink ?? true,
        // §N17: `false`, both engines' own default. See `TerminalRendererOptions`.
        allowTransparency: options?.allowTransparency ?? false
    };
}

function byteLength(data: Uint8Array | string): number {
    return typeof data === 'string' ? data.length : data.length;
}

class AdapterRenderer implements TerminalRenderer {
    readonly engine: TerminalEngine;

    private options: ResolvedRendererOptions;
    private handle: EngineHandle | undefined;
    private openPromise: Promise<void> | undefined;
    private disposed = false;
    /** The engine threw from inside itself; it takes no further bytes (run-F N1). */
    private poisoned = false;
    /** `open()` resolved — the point after which a failure is the owner's to hear about. */
    private opened = false;

    private readonly dataListeners = new Set<(data: string) => void>();
    private readonly bellListeners = new Set<() => void>();
    private readonly titleListeners = new Set<(title: string) => void>();
    private readonly selectionListeners = new Set<(selection: string) => void>();
    private readonly failureListeners = new Set<(error: unknown) => void>();
    private readonly engineDisposables: EngineDisposable[] = [];

    private pending: (Uint8Array | string)[] = [];
    private pendingBytes = 0;
    private wantFocus = false;
    /**
     * §N20 — the SURFACE's focus, which is not the same thing as the DOM caret (`wantFocus`).
     *
     * `true` until the pane reports otherwise, so an engine that opens before its first focus
     * report looks the way upstream always did rather than flashing an outline for a frame.
     */
    private wantSurfaceFocus = true;
    private requestedCols: number;
    private requestedRows: number;
    private readonly faults: EngineFaultHook | undefined;

    /**
     * §N24 — the resize→replay paint hold.
     *
     * `holding` is set the moment the engine's grid actually changes and cleared when the
     * settled-resize replay has been written back in (or the timeout fires). `sawResetWhileHeld`
     * is how the replay is recognised: `ingest.replay()` is the ONLY caller of `reset()`, and it
     * always does `reset()` then `write(snapshot)` — so the write that follows a reset is the
     * authoritative screen, and the frame after it is safe to paint.
     */
    private holding = false;
    private sawResetWhileHeld = false;
    private holdTimer: ReturnType<typeof setTimeout> | null = null;
    private holdTimeouts = 0;
    private readonly holdListeners = new Set<(held: boolean) => void>();

    constructor(
        engine: TerminalEngine,
        private readonly loader: EngineLoader,
        options?: TerminalRendererOptions
    ) {
        this.engine = engine;
        this.options = resolveOptions(options, engine);
        this.requestedCols = this.options.cols;
        this.requestedRows = this.options.rows;
        // Read once, at construction: `write()` is the hottest path in the client and must not
        // pay a global lookup per PTY chunk. Undefined in every real session.
        this.faults = engineFaultHook();
    }

    get cols(): number {
        return this.handle?.terminal.cols ?? this.requestedCols;
    }

    get rows(): number {
        return this.handle?.terminal.rows ?? this.requestedRows;
    }

    get ready(): Promise<void> {
        return this.openPromise ?? Promise.resolve();
    }

    get failed(): boolean {
        return this.poisoned;
    }

    /** §N24 — is a resize→replay paint hold in force right now? */
    get paintHeld(): boolean {
        return this.holding;
    }

    /** §N24 — holds released by the timeout instead of by a replay. Expected to stay 0. */
    get paintHoldTimeouts(): number {
        return this.holdTimeouts;
    }

    onPaintHoldChange(listener: (held: boolean) => void): () => void {
        this.holdListeners.add(listener);
        return () => this.holdListeners.delete(listener);
    }

    onEngineFailure(listener: (error: unknown) => void): () => void {
        this.failureListeners.add(listener);
        return () => this.failureListeners.delete(listener);
    }

    open(element: HTMLElement): Promise<void> {
        if (this.openPromise !== undefined) return this.openPromise;
        this.openPromise = this.load(element);
        return this.openPromise;
    }

    write(data: Uint8Array | string): void {
        if (this.disposed || this.poisoned) return;
        /**
         * ZERO BYTES ARE A NO-OP, AND THEY MUST NOT REACH THE ENGINE (N23, and the whole of N1).
         *
         * ghostty-web's `write()` hands `bytes.length` to the WASM allocator and then does
         * `new Uint8Array(memory.buffer).set(bytes, ptr)`. Zig answers a ZERO-size allocation
         * with its non-null sentinel address — 0xFFFFFFFF, which JS reads back as `-1` — so
         * `set(empty, -1)` throws `RangeError: offset is out of bounds`. That is the exact
         * stack run-F, run-H, run-U and run-V all logged, and the daemon produces the input for
         * it routinely: a pane whose shell has not printed yet snapshots to NOTHING, so its
         * attach replay is an empty frame and the first write into the fresh engine kills it
         * (61 of 181 replays in a 60-round close/adjust storm were empty). Fixed in the engine
         * too (`0.4.0-nex.5`); kept here because this layer decides whether a pane restarts,
         * and it must never restart over zero bytes.
         */
        if (data.length === 0) {
            /**
             * …but an EMPTY replay is still a replay (§N24).
             *
             * ~34 % of replay frames under close/adjust churn are empty — a pane whose shell has
             * not printed yet snapshots to nothing — and the `reset()` in front of this one has
             * already applied the authoritative screen (RIS clears it, which is exactly what the
             * corrupt cells needed). Returning without ending the hold would leave the pane
             * frozen on its last good frame until the timeout, for a replay that DID arrive.
             */
            if (this.holding && this.sawResetWhileHeld) this.releaseHold();
            return;
        }
        const terminal = this.handle?.terminal;
        if (terminal === undefined) {
            this.queue(data);
            return;
        }
        // CONTAIN (run-F N1): ghostty-web's `write()` reaches straight into the shared WASM
        // heap and can throw `RangeError: offset is out of bounds`. Unwrapped, that throw goes
        // wherever the byte came from — the WebSocket message handler — as an unhandled
        // rejection, and the pane keeps feeding a dead engine. Caught here it poisons the
        // renderer exactly once, which is the signal the pane restarts on.
        this.guard(() => terminal.write(data), 'write');
        /**
         * §N24 — this was the replay: end the hold, in the SAME synchronous turn as the write.
         *
         * `reset()` + `write()` is `ingest.replay()`, and nothing else in the client produces
         * that pair. Resuming here (rather than on a timer, or from the pane) is what makes the
         * whole window atomic with respect to painting: the engine's grid changed, every frame
         * since was suppressed, and the first frame allowed through is the one drawn from the
         * snapshot that has just been parsed. `setPaintSuspended(false)` forces a full render,
         * so that frame is complete rather than a dirty-row patch.
         */
        if (this.holding && this.sawResetWhileHeld) this.releaseHold();
    }

    reset(): void {
        if (this.disposed || this.poisoned) return;
        // §N24: a reset while held is the leading edge of the replay — the write behind it is
        // the authoritative screen, and that is what ends the hold (see `write`).
        if (this.holding) this.sawResetWhileHeld = true;
        const terminal = this.handle?.terminal;
        if (terminal === undefined) {
            /**
             * The engine is still loading — so drop the queue (a replay supersedes anything
             * waiting) and make RIS the FIRST thing it will be handed.
             *
             * "A fresh engine needs no RIS" is the assumption this used to make, and it is
             * false for the engine the app actually ships: ghostty-web runs every Terminal
             * through one shared WASM instance, and a Terminal constructed moments after
             * another was disposed comes up holding that one's grid. `ingest.ts` already
             * resets before every replay for exactly that reason, but on the path that
             * matters — a pane REMOUNTING, where the replay lands while `open()` is still in
             * flight — the reset arrived here with no terminal to write to and was swallowed,
             * so the snapshot was painted over the previous pane's screen. Switching
             * workspaces is that path for every visible pane at once (`mount-policy.ts`
             * evicts a background workspace's engines), which is why clicking a sidebar row
             * came back to a garbled grid.
             */
            this.pending = [TERMINAL_RESET_SEQUENCE];
            this.pendingBytes = byteLength(TERMINAL_RESET_SEQUENCE);
            return;
        }
        // RIS in-stream rather than `terminal.reset()` — see the header note (ordering with
        // xterm's async write queue; ghostty-web's reset() frees the WASM terminal).
        this.guard(() => terminal.write(TERMINAL_RESET_SEQUENCE), 'reset');
    }

    onData(listener: (data: string) => void): () => void {
        this.dataListeners.add(listener);
        return () => this.dataListeners.delete(listener);
    }

    onBell(listener: () => void): () => void {
        this.bellListeners.add(listener);
        return () => this.bellListeners.delete(listener);
    }

    onTitleChange(listener: (title: string) => void): () => void {
        this.titleListeners.add(listener);
        return () => this.titleListeners.delete(listener);
    }

    /** §TERM-034. `''` for a poisoned/unopened engine, or one with no selection read. */
    selection(): string {
        if (this.disposed || this.poisoned) return '';
        const terminal = this.handle?.terminal;
        if (terminal?.getSelection === undefined) return '';
        // Swallowed, not guarded: a failed selection read is cosmetic and must never poison a
        // pane whose PTY is fine.
        let value = '';
        this.swallow(() => {
            value = terminal.getSelection?.() ?? '';
        });
        return value;
    }

    onSelectionChange(listener: (selection: string) => void): () => void {
        this.selectionListeners.add(listener);
        return () => this.selectionListeners.delete(listener);
    }

    clearSelection(): void {
        if (this.disposed || this.poisoned) return;
        this.swallow(() => this.handle?.terminal.clearSelection?.());
    }

    resize(cols: number, rows: number): void {
        if (this.disposed) return;
        // Zero-size guard (terminal-surface.md §15.4): a transient 0×0 layout pass must never
        // reach the engine, let alone the PTY.
        if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
        const nextCols = Math.max(1, Math.trunc(cols));
        const nextRows = Math.max(1, Math.trunc(rows));
        this.requestedCols = nextCols;
        this.requestedRows = nextRows;
        if (this.poisoned) return;
        const terminal = this.handle?.terminal;
        if (terminal === undefined) return; // applied at open
        if (terminal.cols === nextCols && terminal.rows === nextRows) return;
        /**
         * §N24 — HOLD THE PAINT ACROSS THE RESIZE→REPLAY WINDOW.
         *
         * The grid is about to change under a VT whose contents this client does not own. The
         * daemon owns them: it resizes the PTY and the server-side VT, waits for the gesture to
         * settle, and sends one replay that re-seeds this engine (`ws/streams.ts` `resyncPane`,
         * N11/N12's contract — the server VT is authoritative and the replay is the sync
         * mechanism). Between the two, the engine holds a grid it has not been told the contents
         * of, and ghostty-web will happily paint it: a widening `ghostty_terminal_resize` under
         * heap churn leaves cells in libghostty-vt's own storage that the VT never wrote, which
         * read back as constant-stride runs of increasing codepoints and stale off-screen text
         * (N23's exonerated residual — measured at 119 of 120 close/reopen cycles, and every
         * frame in the window, not just the first).
         *
         * So: suspend the engine's paint BEFORE the resize (the canvas then keeps the last good
         * frame across it, `0.4.0-nex.6`), and resume when the replay lands. No frame is ever
         * produced from a resized-but-not-yet-replayed buffer. Nothing about the byte stream
         * changes — this suppresses PAINTS, not writes, so there is no second reconciliation
         * path and the daemon stays the only source of truth.
         *
         * A re-arm during an existing hold is deliberate: a drag emits several grid changes and
         * each one gets its own window, ending at the last one's replay.
         */
        this.beginHold();
        this.guard(() => terminal.resize(nextCols, nextRows), 'resize');
    }

    focus(): void {
        this.wantFocus = true;
        if (this.disposed || this.poisoned) return;
        this.swallow(() => this.handle?.terminal.focus());
    }

    blur(): void {
        this.wantFocus = false;
        if (this.disposed || this.poisoned) return;
        this.swallow(() => this.handle?.terminal.blur());
    }

    setSurfaceFocus(focused: boolean): void {
        this.wantSurfaceFocus = focused;
        if (this.disposed || this.poisoned) return;
        this.swallow(() => this.handle?.setSurfaceFocus?.(focused));
    }

    setTheme(theme: TerminalTheme): void {
        this.options = { ...this.options, theme };
        if (this.disposed || this.poisoned) return;
        this.swallow(() => this.handle?.setTheme?.(theme));
        /*
         * …and REDRAW what is already on screen (§APP-014).
         *
         * Both engines paint incrementally, so a new palette otherwise applies only to the next
         * cell they draw: the audit caught exactly that — a canvas whose most-painted colour
         * was still the old background while the new theme's cursor colour was already on it.
         * libghostty had no equivalent gap, because `ghostty_app_update_config` rebuilt the
         * surface's whole frame.
         *
         * Cheap and idempotent (one walk of the cell buffer), and a theme only changes when a
         * config file does.
         *
         * §N18: until `ghostty-web 0.4.0-nex.7` this walk repainted the OLD background anyway —
         * a cell reports the colours its WASM terminal was CONSTRUCTED with, and the engine
         * painted them literally, so the theme reached everything except the cells. The engine
         * now resolves a DEFAULT cell through its live theme at paint time, and this repaint is
         * what makes that resolution reach the rows nothing has written to since.
         */
        this.repaint();
    }

    cellSize(): CellSize {
        const measured = this.handle?.cellSize?.();
        if (measured !== undefined && measured.width > 0 && measured.height > 0) return measured;
        return estimateCellSize(this.options.fontSize, this.options.fontFamily);
    }

    repaint(): void {
        if (this.disposed || this.poisoned) return;
        // A repaint walks the WASM cell buffer, so it can throw the same way `write()` does.
        this.guard(() => this.handle?.repaint?.(), 'repaint');
    }

    remeasure(): void {
        if (this.disposed || this.poisoned) return;
        this.swallow(() => this.handle?.remeasure?.());
    }

    revealMatch(match: TerminalMatchLocation): void {
        if (this.disposed || this.poisoned) return;
        // Cosmetic: a scroll or a selection that did not take is not worth poisoning a pane
        // whose PTY is otherwise fine, and the overlay's counter is unaffected either way.
        this.swallow(() => this.handle?.revealMatch?.(match));
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        const wasHolding = this.holding;
        this.clearHoldTimer();
        this.holding = false;
        this.sawResetWhileHeld = false;
        if (wasHolding) this.announceHold(false);
        this.holdListeners.clear();
        this.releaseEngine();
        this.pending = [];
        this.pendingBytes = 0;
        this.dataListeners.clear();
        this.bellListeners.clear();
        this.titleListeners.clear();
        this.selectionListeners.clear();
        this.failureListeners.clear();
    }

    // ── internals ───────────────────────────────────────────────────────────────────

    /**
     * §N24 — start (or re-arm) the resize→replay paint hold.
     *
     * A no-op for an engine with no `setPaintSuspended` (`@xterm/xterm`, a fake): its buffer is
     * JS objects, it has no uninitialised cell storage to paint, and holding a paint it cannot
     * suspend would only cost a timer.
     */
    private beginHold(): void {
        if (this.handle?.setPaintSuspended === undefined) return;
        this.sawResetWhileHeld = false;
        if (!this.holding) {
            this.holding = true;
            this.swallow(() => this.handle?.setPaintSuspended?.(true));
            this.announceHold(true);
        }
        this.clearHoldTimer();
        // The net under the net: the daemon always sends one replay per settled resize, but a
        // pane must never be frozen by one that does not arrive.
        this.holdTimer = setTimeout(() => {
            this.holdTimer = null;
            if (!this.holding) return;
            this.holdTimeouts += 1;
            this.releaseHold();
        }, RESIZE_PAINT_HOLD_TIMEOUT_MS);
        (this.holdTimer as unknown as { unref?: () => void }).unref?.();
    }

    /** End the hold and let the engine paint again (a forced full frame, in the engine). */
    private releaseHold(): void {
        this.clearHoldTimer();
        if (!this.holding) return;
        this.holding = false;
        this.sawResetWhileHeld = false;
        if (!this.disposed) this.swallow(() => this.handle?.setPaintSuspended?.(false));
        this.announceHold(false);
    }

    private clearHoldTimer(): void {
        if (this.holdTimer === null) return;
        clearTimeout(this.holdTimer);
        this.holdTimer = null;
    }

    private announceHold(held: boolean): void {
        for (const listener of [...this.holdListeners]) {
            try {
                listener(held);
            } catch {
                /* a listener that throws must not take the hold's bookkeeping with it */
            }
        }
    }

    /**
     * Run an engine call that touches the VT. A throw means the engine is gone — poison it,
     * never call it again, and tell the owner so it can build a fresh one.
     */
    private guard(action: () => void, kind: 'write' | 'reset' | 'resize' | 'repaint'): void {
        const planted = kind === 'write' ? this.faults?.fault('write', this.engine) : undefined;
        if (planted !== undefined) {
            this.poison(new RangeError(planted));
            return;
        }
        try {
            action();
        } catch (error) {
            this.poison(error);
        }
    }

    /** Cosmetic engine calls (focus, theme, re-measure): a throw is not worth killing a pane. */
    private swallow(action: () => void): void {
        try {
            action();
        } catch {
            /* a pane whose caret or palette did not take is still a working terminal */
        }
    }

    /**
     * Abandon the engine. Idempotent, and deliberately quiet: the owner decides what a user
     * sees, and a failure that happens DURING `open()` is already carried by that rejection —
     * announcing it here as well would restart the pane twice for one fault.
     */
    private poison(error: unknown): void {
        if (this.poisoned) return;
        this.poisoned = true;
        this.pending = [];
        this.pendingBytes = 0;
        // §N24: a poisoned engine is about to be disposed and replaced — drop the hold rather
        // than leave a timer pointing at a dead adapter. Announced, so the pane's published
        // state cannot be left saying "held" for an engine that no longer exists.
        const wasHolding = this.holding;
        this.clearHoldTimer();
        this.holding = false;
        this.sawResetWhileHeld = false;
        if (wasHolding) this.announceHold(false);
        if (!this.opened) return;
        for (const listener of [...this.failureListeners]) {
            try {
                listener(error);
            } catch {
                /* a listener that throws must not swallow the failure for the others */
            }
        }
    }

    /** Unhook and free whatever engine this adapter is holding. Safe to call twice. */
    private releaseEngine(): void {
        for (const disposable of this.engineDisposables) {
            try {
                disposable.dispose();
            } catch {
                /* an engine that fails to unhook must not block teardown */
            }
        }
        this.engineDisposables.length = 0;
        const handle = this.handle;
        this.handle = undefined;
        if (handle === undefined) return;
        try {
            handle.dispose?.();
        } catch {
            /* ignore */
        }
        try {
            handle.terminal.dispose();
        } catch {
            /* ignore */
        }
    }

    private queue(data: Uint8Array | string): void {
        this.pending.push(data);
        this.pendingBytes += byteLength(data);
        while (this.pendingBytes > PENDING_WRITE_LIMIT_BYTES && this.pending.length > 1) {
            const dropped = this.pending.shift();
            if (dropped === undefined) break;
            this.pendingBytes -= byteLength(dropped);
        }
    }

    /**
     * The whole startup runs inside the page-wide gate — see `serializeEngineStartup`. The
     * critical section is not just the WASM load: `open()` allocates the shared instance's
     * terminal and the flush below is the first thing that writes into it, which is exactly
     * where N1's `RangeError` landed.
     */
    private load(element: HTMLElement): Promise<void> {
        return serializeEngineStartup(() => this.loadExclusive(element));
    }

    private async loadExclusive(element: HTMLElement): Promise<void> {
        // Disposed while queued behind another startup — a pane evicted mid-wait must not cost
        // the shared WASM instance another terminal on its way out.
        if (this.disposed) return;

        const planted = this.faults?.fault('load', this.engine);
        if (planted !== undefined) throw new Error(planted);

        const handle = await this.loader(this.options);
        if (this.disposed) {
            try {
                handle.dispose?.();
                handle.terminal.dispose();
            } catch {
                /* ignore */
            }
            return;
        }

        const terminal = handle.terminal;
        // `open()` throws where there is no 2D context (jsdom, a detached container). Free the
        // engine — ghostty-web has already allocated a WASM terminal by then — and leave the
        // adapter un-opened, so the caller sees a rejected `ready` and the queue is not lost.
        try {
            const plantedOpen = this.faults?.fault('open', this.engine);
            if (plantedOpen !== undefined) throw new Error(plantedOpen);
            terminal.open(element);
        } catch (error) {
            try {
                handle.dispose?.();
                terminal.dispose();
            } catch {
                /* the open failure is the interesting one */
            }
            throw error;
        }
        this.handle = handle;

        /**
         * Everything from here on talks to a LIVE engine, and every one of these calls reaches
         * into the shared WASM heap. Run-F N1 threw from the flush at the bottom — after
         * `open()` had returned cleanly — which left the adapter holding a half-started engine
         * whose WASM terminal was never freed while the rejection went to the pane. Wrapping
         * the tail means one outcome per startup: either a renderer that is fully live, or a
         * freed engine and a rejection the owner can retry on.
         */
        try {
            this.engineDisposables.push(
                terminal.onData((data) => {
                    for (const listener of [...this.dataListeners]) listener(data);
                })
            );
            const bell = terminal.onBell?.((): void => {
                for (const listener of [...this.bellListeners]) listener();
            });
            if (bell !== undefined) this.engineDisposables.push(bell);
            const title = terminal.onTitleChange?.((value: string): void => {
                for (const listener of [...this.titleListeners]) listener(value);
            });
            if (title !== undefined) this.engineDisposables.push(title);
            // §TERM-034: both engines emit a bare "it changed"; the adapter resolves the TEXT
            // once and hands it to every listener, so a pane never reads the engine N times.
            const selection = terminal.onSelectionChange?.((): void => {
                const value = terminal.getSelection?.() ?? '';
                for (const listener of [...this.selectionListeners]) listener(value);
            });
            if (selection !== undefined) this.engineDisposables.push(selection);

            // Metrics first, then geometry, then the bytes. A replay written before the resize
            // would be parsed at the CONSTRUCTION grid and then reflowed by it, which is what
            // stacks duplicate prompt copies on re-attach (terminal-surface.md §4).
            try {
                handle.remeasure?.();
            } catch {
                /* an engine without a remeasure hook keeps its construction metrics */
            }
            if (terminal.cols !== this.requestedCols || terminal.rows !== this.requestedRows) {
                terminal.resize(this.requestedCols, this.requestedRows);
            }

            const queued = this.pending;
            this.pending = [];
            this.pendingBytes = 0;
            for (const chunk of queued) {
                const plantedWrite = this.faults?.fault('write', this.engine);
                if (plantedWrite !== undefined) throw new RangeError(plantedWrite);
                terminal.write(chunk);
            }

            // ghostty-web#100: `open()` focuses itself. Re-assert what the caller asked for.
            if (this.wantFocus) terminal.focus();
            else terminal.blur();
            // §N20: and the surface's focus with it — the engine is built with `focused: true`,
            // so a pane that was told it is unfocused BEFORE its engine finished loading (every
            // pane in a restored grid but one) would otherwise open blinking.
            handle.setSurfaceFocus?.(this.wantSurfaceFocus);
        } catch (error) {
            this.poisoned = true;
            this.releaseEngine();
            throw error;
        }

        this.opened = true;
    }
}

/** Build a renderer over a caller-supplied engine loader (tests, embedders, a third engine). */
export function createRendererFromLoader(
    engine: TerminalEngine,
    loader: EngineLoader,
    options?: TerminalRendererOptions
): TerminalRenderer {
    return new AdapterRenderer(engine, loader, options);
}

// ── engine loaders ──────────────────────────────────────────────────────────────────

/**
 * ghostty-web. `init()` loads the shared WASM (inlined as a `data:` URI — a strict
 * `connect-src 'self'` CSP blocks it, ghostty-web#188). Imported dynamically so a client that
 * never mounts a terminal (and a jsdom test run) never pays for it.
 */
export const loadGhosttyEngine: EngineLoader = async (options) => {
    const mod = await import('ghostty-web');
    // The WASM and the font in parallel; the Terminal must not be constructed before the font
    // is usable, because its renderer measures the cell in its constructor (fonts.ts §2).
    const [, ] = await Promise.all([mod.init(), loadTerminalFonts(options.fontSize)]);
    const terminal = new mod.Terminal({
        cols: options.cols,
        rows: options.rows,
        fontSize: options.fontSize,
        fontFamily: options.fontFamily,
        theme: compactTheme(options.theme),
        // BYTES here, not lines (ghostty-web#140).
        scrollback: options.scrollbackBytes,
        cursorBlink: options.cursorBlink,
        allowTransparency: options.allowTransparency,
        convertEol: false
    });
    const engineTerminal = terminal as unknown as XtermLikeTerminal;
    return {
        terminal: engineTerminal,
        cellSize: (): CellSize | undefined => {
            const renderer = terminal.renderer;
            if (renderer === undefined) return undefined;
            const metrics = renderer.getMetrics();
            if (metrics === undefined || metrics.width <= 0 || metrics.height <= 0) return undefined;
            return { width: metrics.width, height: metrics.height };
        },
        setTheme: (theme): void => {
            // `terminal.options.theme = …` only logs "theme changes after open() are not yet
            // fully supported" (ghostty-web#125); the renderer's own setter is the one that
            // takes effect (it re-derives the 16-color palette).
            const renderer = terminal.renderer;
            renderer?.setTheme(compactTheme(theme));
            /*
             * …then CLEAR the canvas to the new background (§APP-014), which is the MARGIN's
             * half of the repaint.
             *
             * The forced render that follows (`repaint`) walks the VT's rows and paints each
             * one, so the cell area is covered by that — but a canvas is `cols × rows` cells
             * plus whatever is left over at the right and bottom, and nothing in `render()`
             * touches the leftover. `clear()` is the engine's own one-line "fill the whole
             * canvas with `theme.background`" (a CLEAR under `allowTransparency`, §N17), so it
             * costs one rect and cannot disagree with the palette the line above just set.
             *
             * The CELL area used to need it too, and it did not help: the cells reported the
             * colours the WASM terminal was CONSTRUCTED with, so the render behind this clear
             * filled the old background straight back over it, row by row — §N18, fixed in the
             * engine (`0.4.0-nex.7`: `setTerminalDefaultColors` + a paint-time lookup), not
             * here. This call is the margin's, and the margin's only.
             */
            renderer?.clear();
        },
        remeasure: (): void => {
            // Belt and braces: the loader already awaited the font, but a face that landed
            // during `open()` would otherwise leave the cell at fallback metrics forever.
            terminal.renderer?.remeasureFont();
        },
        // §N20 — `ghostty_surface_set_focus`'s port. Safe before `open()`: the engine keeps the
        // flag and hands it to the renderer it builds there (`0.4.0-nex.4`).
        setSurfaceFocus: (focused): void => {
            terminal.setFocused(focused);
        },
        // §N24 — `0.4.0-nex.6`. Suspends the engine's render loop and the forced render inside
        // its own `resize()`, and carries the canvas pixels across the resize instead of
        // clearing them, so the pane shows its last good frame for the length of the window.
        setPaintSuspended: (suspended): void => {
            terminal.setPaintSuspended(suspended);
        },
        repaint: (): void => {
            const renderer = terminal.renderer;
            const wasmTerm = terminal.wasmTerm;
            if (renderer === undefined || wasmTerm === undefined) return;
            /*
             * `scrollbarOpacity: 0`, EXPLICITLY. The parameter defaults to `1`, so an
             * argument-less forced render draws a phantom full-opacity scrollbar into any pane
             * with scrollback — and `renderScrollbar`'s backdrop clears the rightmost ~14px of
             * every row first, cutting off the last column or two of text. The engine's own
             * render loop then passes the terminal's real opacity (0 once the fade is done),
             * skips the scrollbar path, and — before `0.4.0-nex.8` — repainted nothing, so a
             * theme repaint left the right edge erased until those rows were rewritten. The
             * scrollbar belongs to the terminal's fade state machine, not to this forced
             * frame; if one is legitimately showing, the very next loop frame redraws it.
             */
            renderer.render(wasmTerm, true, terminal.viewportY, terminal, 0);
        },
        revealMatch: (match): void => {
            // ghostty-web's `scrollToLine(n)` sets `viewportY = clamp(n, 0, scrollbackLength)`,
            // and `viewportY` counts lines scrolled UP FROM THE BOTTOM (`scrollToBottom()` sets
            // it to 0) — its doc comment says "0 = top of scrollback", which the implementation
            // contradicts. So `linesFromBottom` is already in its units; centring the match in
            // the viewport is one subtraction.
            const scrollback = terminal.getScrollbackLength();
            const rows = terminal.rows;
            const viewportY = clamp(match.linesFromBottom - Math.floor(rows / 2), 0, scrollback);
            terminal.scrollToLine(viewportY);
            // Its `select(col, row, len)` row is VIEWPORT-relative (it adds `getViewportY()`
            // itself and clamps to `rows - 1`), so the row has to be derived after the scroll.
            const row = rows + viewportY - match.linesFromBottom;
            if (row >= 0 && row < rows) terminal.select(match.col, row, match.length);
        }
    };
};

function clamp(value: number, low: number, high: number): number {
    return Math.max(low, Math.min(high, value));
}

interface XtermRenderDimensions {
    readonly css?: { readonly cell?: { readonly width?: number; readonly height?: number } };
}

/** `@xterm/xterm`. The host page must also load `@xterm/xterm/css/xterm.css`. */
export const loadXtermEngine: EngineLoader = async (options) => {
    const [mod] = await Promise.all([import('@xterm/xterm'), loadTerminalFonts(options.fontSize)]);
    const terminal = new mod.Terminal({
        cols: options.cols,
        rows: options.rows,
        fontSize: options.fontSize,
        fontFamily: options.fontFamily,
        theme: compactTheme(options.theme),
        scrollback: options.scrollbackLines,
        cursorBlink: options.cursorBlink,
        allowTransparency: options.allowTransparency,
        convertEol: false
    });
    const engineTerminal = terminal as unknown as XtermLikeTerminal;
    return {
        terminal: engineTerminal,
        cellSize: (): CellSize | undefined => {
            // xterm.js exposes cell metrics nowhere public; `@xterm/addon-fit` reads exactly
            // this private path, so it is the supported-in-practice one.
            const core = (terminal as unknown as { _core?: { _renderService?: { dimensions?: XtermRenderDimensions } } })
                ._core;
            const cell = core?._renderService?.dimensions?.css?.cell;
            if (cell === undefined) return undefined;
            const width = cell.width ?? 0;
            const height = cell.height ?? 0;
            if (width <= 0 || height <= 0) return undefined;
            return { width, height };
        },
        setTheme: (theme): void => {
            terminal.options.theme = compactTheme(theme);
        },
        remeasure: (): void => {
            // xterm re-measures its cell when the font option CHANGES — and its setter compares
            // before firing (`rawOptions[key] !== value`), so re-assigning the same stack is a
            // no-op. A round trip through a different-but-equivalent value is what makes it
            // measure again after a late-arriving face.
            const family = terminal.options.fontFamily ?? options.fontFamily;
            terminal.options.fontFamily = `${family}, monospace`;
            terminal.options.fontFamily = family;
        },
        repaint: (): void => {
            terminal.refresh(0, Math.max(0, terminal.rows - 1));
        },
        revealMatch: (match): void => {
            // xterm.js is the mirror image of ghostty-web here: `scrollToLine(n)` takes the
            // ABSOLUTE buffer line to place at the TOP of the viewport, and `select(col, row,
            // len)`'s row is an absolute buffer row too.
            const total = terminal.buffer.active.length;
            const absolute = total - match.linesFromBottom;
            if (absolute < 0) return;
            const top = clamp(absolute - Math.floor(terminal.rows / 2), 0, Math.max(0, total - terminal.rows));
            terminal.scrollToLine(top);
            terminal.select(match.col, absolute, match.length);
        }
    };
};

export function engineLoader(engine: TerminalEngine): EngineLoader {
    return engine === 'xterm' ? loadXtermEngine : loadGhosttyEngine;
}

/**
 * The factory the app uses: engine from `options.engine`, else `VITE_TERMINAL_ENGINE`, else
 * ghostty-web.
 */
export const createTerminalRenderer: TerminalRendererFactory = (options) => {
    const engine = options?.engine ?? configuredTerminalEngine();
    return createRendererFromLoader(engine, engineLoader(engine), options);
};
