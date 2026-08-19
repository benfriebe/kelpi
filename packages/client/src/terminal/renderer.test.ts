import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    DEFAULT_FONT_FAMILY,
    DEFAULT_TERMINAL_ENGINE,
    DEFAULT_TERMINAL_THEME,
    TERMINAL_RESET_SEQUENCE,
    compactTheme,
    createRendererFromLoader,
    estimateCellSize,
    isEngineColor,
    resolveTerminalEngine,
    resolveTerminalTheme,
    terminalThemePreset,
    LIGHT_TERMINAL_THEME,
    type CellSize,
    type EngineDisposable,
    type EngineHandle,
    type TerminalTheme,
    type XtermLikeTerminal
} from './renderer';

const decoder = new TextDecoder();

function text(data: string | Uint8Array): string {
    return typeof data === 'string' ? data : decoder.decode(data);
}

/**
 * Stands in for a real engine, and reproduces the behaviour that shapes the adapter:
 * ghostty-web throws `Terminal must be opened before use` from `write()` / `resize()` /
 * `getMode()` until `open()` lands (verified hands-on in jsdom; xterm.js tolerates those
 * calls, so the strict engine is the one worth modelling).
 */
class StubTerminal implements XtermLikeTerminal {
    cols = 80;
    rows = 24;
    opened: HTMLElement | null = null;
    readonly writes: string[] = [];
    readonly resizes: { cols: number; rows: number }[] = [];
    resets = 0;
    focuses = 0;
    blurs = 0;
    disposals = 0;
    /** Ordering probes: mount has to size the engine before any byte reaches it. */
    onWriteRecorded: (() => void) | undefined;
    onResizeRecorded: (() => void) | undefined;

    private dataListener: ((data: string) => void) | undefined;
    private bellListener: (() => void) | undefined;

    open(parent: HTMLElement): void {
        this.opened = parent;
    }

    private assertOpen(): void {
        if (this.opened === null) throw new Error('Terminal must be opened before use.');
    }

    write(data: string | Uint8Array): void {
        this.assertOpen();
        this.writes.push(text(data));
        this.onWriteRecorded?.();
    }

    reset(): void {
        this.assertOpen();
        this.resets += 1;
    }

    focus(): void {
        this.focuses += 1;
    }

    blur(): void {
        this.blurs += 1;
    }

    resize(cols: number, rows: number): void {
        this.assertOpen();
        this.cols = cols;
        this.rows = rows;
        this.resizes.push({ cols, rows });
        this.onResizeRecorded?.();
    }

    dispose(): void {
        this.disposals += 1;
    }

    onData(listener: (data: string) => void): EngineDisposable {
        this.dataListener = listener;
        return {
            dispose: () => {
                this.dataListener = undefined;
            }
        };
    }

    onBell(listener: () => void): EngineDisposable {
        this.bellListener = listener;
        return {
            dispose: () => {
                this.bellListener = undefined;
            }
        };
    }

    emitData(data: string): void {
        this.dataListener?.(data);
    }

    emitBell(): void {
        this.bellListener?.();
    }
}

class StubEngine {
    readonly terminal = new StubTerminal();
    readonly themes: TerminalTheme[] = [];
    repaints = 0;
    remeasures = 0;
    onRemeasure: (() => void) | undefined;
    cell: CellSize | undefined;

    private release: (() => void) | undefined;
    private readonly gate: Promise<void>;

    constructor() {
        this.gate = new Promise<void>((resolve) => {
            this.release = resolve;
        });
    }

    /** Let the (async) engine load finish — the ghostty-web `await init()` window. */
    settle(): void {
        this.release?.();
        this.release = undefined;
    }

    readonly loader = async (): Promise<EngineHandle> => {
        await this.gate;
        return {
            terminal: this.terminal,
            cellSize: (): CellSize | undefined => this.cell,
            setTheme: (theme: TerminalTheme): void => {
                this.themes.push(theme);
            },
            repaint: (): void => {
                this.repaints += 1;
            },
            remeasure: (): void => {
                this.remeasures += 1;
                this.onRemeasure?.();
            }
        };
    };
}

function stubEngine(): StubEngine {
    return new StubEngine();
}

function host(): HTMLElement {
    const element = document.createElement('div');
    document.body.appendChild(element);
    return element;
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('engine selection', () => {
    it('defaults to ghostty and accepts the documented override', () => {
        expect(DEFAULT_TERMINAL_ENGINE).toBe('ghostty');
        expect(resolveTerminalEngine(undefined)).toBe('ghostty');
        expect(resolveTerminalEngine('')).toBe('ghostty');
        expect(resolveTerminalEngine('XTERM')).toBe('xterm');
        expect(resolveTerminalEngine(' xterm ')).toBe('xterm');
        expect(resolveTerminalEngine('webgl')).toBe('ghostty');
    });
});

describe('theme resolution', () => {
    it('accepts only the color formats the engines can parse', () => {
        expect(isEngineColor('#0A0A0C')).toBe(true);
        expect(isEngineColor('#abc')).toBe(true);
        expect(isEngineColor('rgb(10, 10, 12)')).toBe(true);
        // ghostty-web's parseColorToHex maps all of these to black, so they must not pass.
        expect(isEngineColor('rgba(10, 10, 12, 0.5)')).toBe(false);
        expect(isEngineColor('hsl(240 5% 4%)')).toBe(false);
        expect(isEngineColor('color-mix(in srgb, #fff 50%, transparent)')).toBe(false);
        expect(isEngineColor('black')).toBe(false);
        expect(isEngineColor(undefined)).toBe(false);
    });

    it('drops undefined members before an engine sees the theme', () => {
        // The engines merge `{ ...their defaults, ...theme }`, so an explicit undefined would
        // override a default and paint that role black (`parseColorToHex(undefined) === 0`).
        const compact = compactTheme({ background: '#101013', foreground: undefined, cursor: '' });

        expect(compact).toEqual({ background: '#101013' });
        expect('foreground' in compact).toBe(false);
    });

    it('falls back to the dark preset when no tokens are defined', () => {
        expect(resolveTerminalTheme(host())).toEqual(DEFAULT_TERMINAL_THEME);
    });

    it('reads --nex-term-* custom properties where the platform exposes them', () => {
        const element = host();
        element.style.setProperty('--nex-term-bg', '#123456');
        element.style.setProperty('--nex-term-fg', 'chartreuse'); // unparseable → ignored

        const theme = resolveTerminalTheme(element);

        // jsdom does not compute custom properties; assert the invariant that holds either way.
        expect([DEFAULT_TERMINAL_THEME.background, '#123456']).toContain(theme.background);
        expect(theme.foreground).toBe(DEFAULT_TERMINAL_THEME.foreground);
    });
});

describe('terminal palette presets (run-B L4)', () => {
    it('has a light column, so the palette can follow the RESOLVED bucket', () => {
        // The light foreground painted on the dark background is what "the terminal reads like
        // SGR dim" actually was: the DOM was read one commit before the theme stamp landed, and
        // nothing ever re-read it. A preset per bucket is the answer that cannot be stale.
        expect(terminalThemePreset('dark')).toBe(DEFAULT_TERMINAL_THEME);
        expect(terminalThemePreset('light')).toBe(LIGHT_TERMINAL_THEME);
        expect(LIGHT_TERMINAL_THEME.foreground).not.toBe(DEFAULT_TERMINAL_THEME.foreground);
    });

    it('defaults the terminal foreground to ghostty’s own white, not the chrome grey', () => {
        // ghostty `src/config/Config.zig`: background #282c34, foreground #ffffff. The pane
        // header beside it paints chrome `textPrimary` (#E6E6EA); a terminal body dimmer than
        // its own header is the defect.
        expect(DEFAULT_TERMINAL_THEME.foreground).toBe('#FFFFFF');
        expect(DEFAULT_TERMINAL_THEME.cursor).toBe('#FFFFFF');
    });

    it('falls back to the base the caller passes, not always to dark', () => {
        expect(resolveTerminalTheme(host(), LIGHT_TERMINAL_THEME)).toEqual(LIGHT_TERMINAL_THEME);
        expect(resolveTerminalTheme(null, LIGHT_TERMINAL_THEME)).toEqual(LIGHT_TERMINAL_THEME);
    });
});

describe('TerminalRenderer adapter', () => {
    it('queues writes until the engine is open, then flushes them in order', async () => {
        const engine = stubEngine();
        const renderer = createRendererFromLoader('xterm', engine.loader);
        const element = host();

        const opening = renderer.open(element);
        renderer.write('one');
        renderer.write(new TextEncoder().encode('two'));
        expect(engine.terminal.writes).toEqual([]);

        engine.settle();
        await opening;

        expect(engine.terminal.opened).toBe(element);
        expect(engine.terminal.writes).toEqual(['one', 'two']);

        renderer.write('three');
        expect(engine.terminal.writes).toEqual(['one', 'two', 'three']);
        renderer.dispose();
    });

    it('sizes the engine and re-measures the font BEFORE flushing the queued replay', async () => {
        // Order is the whole fix: a replay serialized for 120 columns, written into an engine
        // still holding its 80×24 construction grid, wraps — and the resize that follows
        // reflows it into the stacked half-width prompt copies a re-attach used to paint.
        const engine = stubEngine();
        const order: string[] = [];
        engine.onRemeasure = () => order.push('remeasure');
        engine.terminal.onResizeRecorded = () => order.push('resize');
        engine.terminal.onWriteRecorded = () => order.push('write');

        const renderer = createRendererFromLoader('ghostty', engine.loader, { cols: 120, rows: 40 });
        const opening = renderer.open(host());
        renderer.write('REPLAY');
        engine.settle();
        await opening;

        expect(order).toEqual(['remeasure', 'resize', 'write']);
        expect(engine.terminal.cols).toBe(120);
        expect(engine.terminal.rows).toBe(40);
        renderer.dispose();
    });

    it('applies a grid requested before the engine finished loading', async () => {
        const engine = stubEngine();
        const renderer = createRendererFromLoader('xterm', engine.loader);

        const opening = renderer.open(host());
        renderer.resize(169, 47);
        expect(renderer.cols).toBe(169); // the requested grid answers until the engine is up
        engine.settle();
        await opening;

        expect(engine.terminal.cols).toBe(169);
        expect(engine.terminal.rows).toBe(47);
        renderer.dispose();
    });

    it('drops the queue on a reset before the engine is up, and leads the flush with RIS', async () => {
        // The RIS is not ceremony. ghostty-web hands a new Terminal the WASM slot a disposed
        // one just freed, so the engine this queue flushes into may already hold another
        // pane's grid — and a remount (workspace switch, font change, LRU eviction) delivers
        // its replay while `open()` is still in flight, which is exactly when this branch
        // runs. Swallowing the reset here is what painted a pane's snapshot over its
        // predecessor's screen.
        const engine = stubEngine();
        const renderer = createRendererFromLoader('xterm', engine.loader);

        const opening = renderer.open(host());
        renderer.write('stale');
        renderer.reset();
        renderer.write('replay');
        engine.settle();
        await opening;

        expect(engine.terminal.writes).toEqual([TERMINAL_RESET_SEQUENCE, 'replay']);
        // Still the in-stream byte, never the engine's own reset() (ghostty-web#141).
        expect(engine.terminal.resets).toBe(0);
        renderer.dispose();
    });

    it('resets by writing RIS into the stream, not by calling the engine reset', async () => {
        const engine = stubEngine();
        const renderer = createRendererFromLoader('ghostty', engine.loader);

        const opening = renderer.open(host());
        engine.settle();
        await opening;

        renderer.write('stale screen');
        renderer.reset();
        renderer.write('SNAPSHOT');

        // Order matters more than the mechanism: xterm's write() is asynchronous, so a
        // synchronous reset() would land BEFORE bytes that were written earlier.
        expect(engine.terminal.writes).toEqual(['stale screen', TERMINAL_RESET_SEQUENCE, 'SNAPSHOT']);
        // ghostty-web's own reset() frees + re-creates the WASM terminal (#141) — never called.
        expect(engine.terminal.resets).toBe(0);
        renderer.dispose();
    });

    it('applies the pending geometry at open and dedupes an unchanged resize', async () => {
        const engine = stubEngine();
        const renderer = createRendererFromLoader('xterm', engine.loader);

        const opening = renderer.open(host());
        renderer.resize(120, 40);
        renderer.resize(0, 0); // zero-size guard: never reaches the engine
        renderer.resize(100.7, 30.2);
        expect(renderer.cols).toBe(100);
        expect(renderer.rows).toBe(30);

        engine.settle();
        await opening;

        expect(engine.terminal.resizes).toEqual([{ cols: 100, rows: 30 }]);
        renderer.resize(100, 30);
        expect(engine.terminal.resizes).toHaveLength(1);
        renderer.resize(101, 30);
        expect(engine.terminal.resizes).toHaveLength(2);
        renderer.dispose();
    });

    it('forwards engine data to listeners registered before open, and stops on unsubscribe', async () => {
        const engine = stubEngine();
        const renderer = createRendererFromLoader('xterm', engine.loader);
        const seen: string[] = [];
        const bells: number[] = [];
        const off = renderer.onData((data) => seen.push(data));
        renderer.onBell(() => bells.push(1));

        const opening = renderer.open(host());
        engine.settle();
        await opening;

        engine.terminal.emitData('ls\r');
        engine.terminal.emitBell();
        expect(seen).toEqual(['ls\r']);
        expect(bells).toEqual([1]);

        off();
        engine.terminal.emitData('ignored');
        expect(seen).toEqual(['ls\r']);
        renderer.dispose();
    });

    it('does not let the engine steal focus on open (ghostty-web#100)', async () => {
        const engine = stubEngine();
        const renderer = createRendererFromLoader('ghostty', engine.loader);

        const opening = renderer.open(host());
        engine.settle();
        await opening;

        expect(engine.terminal.blurs).toBe(1);
        expect(engine.terminal.focuses).toBe(0);
        renderer.dispose();
    });

    it('honours a focus requested before the engine finished loading', async () => {
        const engine = stubEngine();
        const renderer = createRendererFromLoader('ghostty', engine.loader);

        const opening = renderer.open(host());
        renderer.focus();
        engine.settle();
        await opening;

        expect(engine.terminal.focuses).toBe(1);
        expect(engine.terminal.blurs).toBe(0);
        renderer.dispose();
    });

    it('disposing mid-load never opens the engine', async () => {
        const engine = stubEngine();
        const renderer = createRendererFromLoader('xterm', engine.loader);

        const opening = renderer.open(host());
        renderer.dispose();
        engine.settle();
        await opening;

        expect(engine.terminal.opened).toBeNull();
        expect(engine.terminal.disposals).toBe(1);
    });

    it('estimates cell metrics until the engine measures its font', async () => {
        const engine = stubEngine();
        const renderer = createRendererFromLoader('xterm', engine.loader, { fontSize: 20 });

        const estimate = renderer.cellSize();
        expect(estimate).toEqual(estimateCellSize(20, DEFAULT_FONT_FAMILY));
        expect(estimate.width).toBeGreaterThan(0);
        expect(estimate.height).toBeGreaterThan(0);

        engine.cell = { width: 8.4, height: 17 };
        const opening = renderer.open(host());
        engine.settle();
        await opening;

        expect(renderer.cellSize()).toEqual({ width: 8.4, height: 17 });
        renderer.dispose();
    });

    it('routes setTheme and repaint to the engine', async () => {
        const engine = stubEngine();
        const renderer = createRendererFromLoader('xterm', engine.loader);
        const opening = renderer.open(host());
        engine.settle();
        await opening;

        renderer.setTheme({ background: '#101013' });
        renderer.repaint();

        expect(engine.themes).toEqual([{ background: '#101013' }]);
        expect(engine.repaints).toBe(1);
        renderer.dispose();
    });

    it('is inert after dispose', async () => {
        const engine = stubEngine();
        const renderer = createRendererFromLoader('xterm', engine.loader);
        const opening = renderer.open(host());
        engine.settle();
        await opening;
        renderer.dispose();

        renderer.write('after');
        renderer.resize(10, 10);
        renderer.reset();
        renderer.focus();
        renderer.repaint();

        expect(engine.terminal.writes).toEqual([]);
        expect(engine.terminal.disposals).toBe(1);
    });
});

/**
 * Adapter smoke test against a REAL engine. `@xterm/xterm` opens in jsdom once `matchMedia`
 * exists (its dimensions stay 0 — there is no 2D context — which is exactly why `cellSize()`
 * falls back to the font estimate). ghostty-web cannot be smoke-tested here: `init()` loads
 * its WASM fine, but `open()` throws `Failed to get 2D rendering context`
 * (docs/research/ghostty-web-spike.md §"jsdom").
 */
describe('xterm engine (real, jsdom)', () => {
    it('opens, writes, resizes and reports input through the adapter', async () => {
        const original = (window as unknown as { matchMedia?: unknown }).matchMedia;
        Object.defineProperty(window, 'matchMedia', {
            configurable: true,
            writable: true,
            value: (query: string) => ({
                matches: false,
                media: query,
                onchange: null,
                addEventListener: (): void => undefined,
                removeEventListener: (): void => undefined,
                addListener: (): void => undefined,
                removeListener: (): void => undefined,
                dispatchEvent: (): boolean => false
            })
        });
        // jsdom has no canvas: xterm logs a "not implemented" error but still opens.
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            const { loadXtermEngine } = await import('./renderer');
            const renderer = createRendererFromLoader('xterm', loadXtermEngine, {
                cols: 80,
                rows: 24,
                fontSize: 13
            });
            const typed: string[] = [];
            renderer.onData((data) => typed.push(data));

            await renderer.open(host());
            renderer.write(new TextEncoder().encode('hello\r\n'));
            renderer.resize(100, 30);

            expect(renderer.cols).toBe(100);
            expect(renderer.rows).toBe(30);
            // No 2D context → no measured cell → the estimate keeps cols/rows computable.
            expect(renderer.cellSize().width).toBeGreaterThan(0);

            renderer.dispose();
            expect(typed).toEqual([]);
        } finally {
            consoleError.mockRestore();
            Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: original });
        }
    });
});
