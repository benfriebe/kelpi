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
    /** Sub-1.0 pane background opacity composites through to the window (§4). */
    readonly allowTransparency?: boolean | undefined;
}

export interface TerminalRenderer {
    readonly engine: TerminalEngine;
    /** Grid size the engine currently holds (the requested size until it is open). */
    readonly cols: number;
    readonly rows: number;
    /** Resolves when the engine is loaded and attached; rejects if the engine failed to open. */
    readonly ready: Promise<void>;
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
    resize(cols: number, rows: number): void;
    focus(): void;
    blur(): void;
    setTheme(theme: TerminalTheme): void;
    /** CSS-pixel cell metrics; falls back to a font-derived estimate before the engine is up. */
    cellSize(): CellSize;
    /** Best-effort full repaint (visibility regain). No-op where the engine has no hook. */
    repaint(): void;
    /**
     * Re-measure the cell after a font has loaded. Optional because a fake or a third engine
     * may have nothing to re-measure; the pane calls it when the bundled face settles AFTER
     * the engine was built (a slow link), which is the only way to correct metrics that were
     * taken against the fallback.
     */
    remeasure?(): void;
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
 * Dark palette matching the chrome tokens (`--nex-bg` / `--nex-fg`). Hex only — see
 * `TerminalTheme`.
 */
export const DEFAULT_TERMINAL_THEME: TerminalTheme = {
    background: '#0A0A0C',
    foreground: '#E6E6EA',
    cursor: '#E6E6EA',
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
 * CSS custom properties the terminal reads, with the dark preset as the fallback — same
 * pattern as `grid/tokens.ts`, so assembly unifies the palette by defining them on `:root`.
 */
export const TERMINAL_TOKEN_NAMES: Readonly<Record<keyof TerminalTheme, string>> = {
    background: '--nex-term-bg',
    foreground: '--nex-term-fg',
    cursor: '--nex-term-cursor',
    cursorAccent: '--nex-term-cursor-accent',
    selectionBackground: '--nex-term-selection-bg',
    selectionForeground: '--nex-term-selection-fg',
    black: '--nex-term-black',
    red: '--nex-term-red',
    green: '--nex-term-green',
    yellow: '--nex-term-yellow',
    blue: '--nex-term-blue',
    magenta: '--nex-term-magenta',
    cyan: '--nex-term-cyan',
    white: '--nex-term-white',
    brightBlack: '--nex-term-bright-black',
    brightRed: '--nex-term-bright-red',
    brightGreen: '--nex-term-bright-green',
    brightYellow: '--nex-term-bright-yellow',
    brightBlue: '--nex-term-bright-blue',
    brightMagenta: '--nex-term-bright-magenta',
    brightCyan: '--nex-term-bright-cyan',
    brightWhite: '--nex-term-bright-white'
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
 * Resolve the palette from CSS custom properties on `element` (or `:root`), keeping the dark
 * preset for anything unset or in a color format the engines cannot parse.
 */
export function resolveTerminalTheme(element?: Element | null): TerminalTheme {
    const scope = element ?? (typeof document === 'undefined' ? null : document.documentElement);
    if (scope === null || typeof getComputedStyle !== 'function') return DEFAULT_TERMINAL_THEME;
    let styles: CSSStyleDeclaration;
    try {
        styles = getComputedStyle(scope);
    } catch {
        return DEFAULT_TERMINAL_THEME;
    }
    const resolved: Record<string, string> = {};
    for (const [key, token] of Object.entries(TERMINAL_TOKEN_NAMES)) {
        const raw = styles.getPropertyValue(token).trim();
        if (isEngineColor(raw)) resolved[key] = raw;
    }
    return { ...DEFAULT_TERMINAL_THEME, ...resolved };
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
        allowTransparency: options?.allowTransparency ?? true
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

    private readonly dataListeners = new Set<(data: string) => void>();
    private readonly bellListeners = new Set<() => void>();
    private readonly titleListeners = new Set<(title: string) => void>();
    private readonly engineDisposables: EngineDisposable[] = [];

    private pending: (Uint8Array | string)[] = [];
    private pendingBytes = 0;
    private wantFocus = false;
    private requestedCols: number;
    private requestedRows: number;

    constructor(
        engine: TerminalEngine,
        private readonly loader: EngineLoader,
        options?: TerminalRendererOptions
    ) {
        this.engine = engine;
        this.options = resolveOptions(options, engine);
        this.requestedCols = this.options.cols;
        this.requestedRows = this.options.rows;
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

    open(element: HTMLElement): Promise<void> {
        if (this.openPromise !== undefined) return this.openPromise;
        this.openPromise = this.load(element);
        return this.openPromise;
    }

    write(data: Uint8Array | string): void {
        if (this.disposed) return;
        const terminal = this.handle?.terminal;
        if (terminal === undefined) {
            this.queue(data);
            return;
        }
        terminal.write(data);
    }

    reset(): void {
        if (this.disposed) return;
        const terminal = this.handle?.terminal;
        if (terminal === undefined) {
            // Nothing has been painted yet; dropping the queue *is* the reset, and a fresh
            // engine needs no RIS.
            this.pending = [];
            this.pendingBytes = 0;
            return;
        }
        // RIS in-stream rather than `terminal.reset()` — see the header note (ordering with
        // xterm's async write queue; ghostty-web's reset() frees the WASM terminal).
        terminal.write(TERMINAL_RESET_SEQUENCE);
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

    resize(cols: number, rows: number): void {
        if (this.disposed) return;
        // Zero-size guard (terminal-surface.md §15.4): a transient 0×0 layout pass must never
        // reach the engine, let alone the PTY.
        if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
        const nextCols = Math.max(1, Math.trunc(cols));
        const nextRows = Math.max(1, Math.trunc(rows));
        this.requestedCols = nextCols;
        this.requestedRows = nextRows;
        const terminal = this.handle?.terminal;
        if (terminal === undefined) return; // applied at open
        if (terminal.cols === nextCols && terminal.rows === nextRows) return;
        terminal.resize(nextCols, nextRows);
    }

    focus(): void {
        this.wantFocus = true;
        if (this.disposed) return;
        this.handle?.terminal.focus();
    }

    blur(): void {
        this.wantFocus = false;
        if (this.disposed) return;
        this.handle?.terminal.blur();
    }

    setTheme(theme: TerminalTheme): void {
        this.options = { ...this.options, theme };
        if (this.disposed) return;
        this.handle?.setTheme?.(theme);
    }

    cellSize(): CellSize {
        const measured = this.handle?.cellSize?.();
        if (measured !== undefined && measured.width > 0 && measured.height > 0) return measured;
        return estimateCellSize(this.options.fontSize, this.options.fontFamily);
    }

    repaint(): void {
        if (this.disposed) return;
        this.handle?.repaint?.();
    }

    remeasure(): void {
        if (this.disposed) return;
        try {
            this.handle?.remeasure?.();
        } catch {
            /* an engine that cannot re-measure keeps its construction metrics */
        }
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
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
        this.pending = [];
        this.pendingBytes = 0;
        this.dataListeners.clear();
        this.bellListeners.clear();
        this.titleListeners.clear();
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

    // ── internals ───────────────────────────────────────────────────────────────────

    private queue(data: Uint8Array | string): void {
        this.pending.push(data);
        this.pendingBytes += byteLength(data);
        while (this.pendingBytes > PENDING_WRITE_LIMIT_BYTES && this.pending.length > 1) {
            const dropped = this.pending.shift();
            if (dropped === undefined) break;
            this.pendingBytes -= byteLength(dropped);
        }
    }

    private async load(element: HTMLElement): Promise<void> {
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
        for (const chunk of queued) terminal.write(chunk);

        // ghostty-web#100: `open()` focuses itself. Re-assert what the caller actually asked for.
        if (this.wantFocus) terminal.focus();
        else terminal.blur();
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
            terminal.renderer?.setTheme(compactTheme(theme));
        },
        remeasure: (): void => {
            // Belt and braces: the loader already awaited the font, but a face that landed
            // during `open()` would otherwise leave the cell at fallback metrics forever.
            terminal.renderer?.remeasureFont();
        },
        repaint: (): void => {
            const renderer = terminal.renderer;
            const wasmTerm = terminal.wasmTerm;
            if (renderer === undefined || wasmTerm === undefined) return;
            renderer.render(wasmTerm, true, terminal.viewportY, terminal);
        }
    };
};

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
