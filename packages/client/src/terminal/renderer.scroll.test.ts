/**
 * C3: the renderer's scroll, and the long press, measured against the REAL engine.
 *
 * Its own file rather than a block in `renderer.test.ts` for the reason
 * `renderer.text-input.test.ts` gives: other lanes are adding methods to the same interface in the
 * same hours, and a 1,200-line shared test file is a merge conflict per assertion.
 *
 * Two halves, and the first is why the second is allowed to be small:
 *
 *   1. **The engine half.** The spike (MOBILE-PLAN.md §7) says `scrollLines` / `scrollToBottom` /
 *      `getViewportY` are the engine's whole scroll API and that its PUBLIC `select()` cannot be
 *      used to select a word, because it converts a viewport row to an absolute one as
 *      `viewportY + row` while its own renderer converts back as
 *      `absoluteRow - scrollbackLength + viewportY`. Both claims are measured here against the
 *      vendored engine (its WASM loads in Node perfectly well) over the stub 2D context
 *      `KeyBar.test.tsx` established, because a fake engine cannot disprove either.
 *   2. **The adapter half.** That the port's four new members reach whatever engine it is holding,
 *      and that a disposed or poisoned one is inert.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
    createRendererFromLoader,
    createTerminalRenderer,
    resetEngineStartupGateForTests,
    type EngineDisposable,
    type EngineHandle,
    type XtermLikeTerminal
} from './renderer';

// ── the stub canvas ─────────────────────────────────────────────────────────────────
//
// The same hole `KeyBar.test.tsx` fills, for the same reason and with the same shim: jsdom throws
// from `HTMLCanvasElement.prototype.getContext` without the optional `canvas` package, and that
// single gap is all that stops the engine opening in Node. Nothing about painting is asserted
// here; the audit's `phone-touch-scroll` owns the pixels and this file owns the numbers.

let realGetContext: unknown;
let realRaf: unknown;
let realCaf: unknown;
const animationFrames = new Set<ReturnType<typeof setTimeout>>();

function cancelStubAnimationFrames(): void {
    for (const handle of animationFrames) clearTimeout(handle);
    animationFrames.clear();
}

function installStubCanvas(): void {
    const context = new Proxy({} as Record<string, unknown>, {
        get(target, property) {
            if (property in target) return target[property as string];
            if (property === 'measureText') {
                return () => ({ width: 8, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
            }
            if (property === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
            if (property === 'createLinearGradient') return () => ({ addColorStop: () => undefined });
            if (property === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
            return () => undefined;
        },
        set(target, property, value) {
            target[property as string] = value;
            return true;
        }
    });
    realGetContext = HTMLCanvasElement.prototype.getContext;
    (HTMLCanvasElement.prototype as unknown as Record<string, unknown>)['getContext'] = (): unknown => context;
    const global = globalThis as Record<string, unknown>;
    realRaf = global['requestAnimationFrame'];
    realCaf = global['cancelAnimationFrame'];
    global['requestAnimationFrame'] = (callback: FrameRequestCallback): number => {
        const handle = setTimeout(() => { animationFrames.delete(handle); callback(0); }, 0);
        animationFrames.add(handle);
        return handle as unknown as number;
    };
    global['cancelAnimationFrame'] = (handle: number): void => {
        clearTimeout(handle);
        animationFrames.delete(handle as unknown as ReturnType<typeof setTimeout>);
    };
}

function restoreCanvas(): void {
    cancelStubAnimationFrames();
    (HTMLCanvasElement.prototype as unknown as Record<string, unknown>)['getContext'] = realGetContext;
    const global = globalThis as Record<string, unknown>;
    global['requestAnimationFrame'] = realRaf;
    global['cancelAnimationFrame'] = realCaf;
}

function host(): HTMLElement {
    const element = document.createElement('div');
    document.body.appendChild(element);
    return element;
}

describe('the scroll API against a real ghostty-web', () => {
    beforeAll(installStubCanvas);
    afterAll(restoreCanvas);

    let element: HTMLElement;
    let renderer: ReturnType<typeof createTerminalRenderer>;

    /** 100 numbered lines through an 8-row window: 93 lines of scrollback, line 94 at the top. */
    beforeEach(async () => {
        element = host();
        renderer = createTerminalRenderer({ cols: 40, rows: 8 });
        await renderer.open(element);
        const lines: string[] = [];
        for (let n = 1; n <= 100; n += 1) lines.push(`line${String(n)}`);
        renderer.write(`${lines.join('\r\n')}\r\n`);
        await new Promise((resolve) => setTimeout(resolve, 20));
    });

    afterEach(() => {
        renderer.dispose();
        // Scrollbar fades schedule their own frames beyond engine disposal. In a browser the
        // window keeps rAF alive; this test must stop its timers before restoring the globals.
        cancelStubAnimationFrames();
        element.remove();
    });

    it('starts at the live bottom and scrolls back by whole lines, clamped to the scrollback', () => {
        expect(renderer.scrollOffset()).toBe(0);

        // Negative is back through history (the engines' shared sign).
        renderer.scrollLines(-5);
        expect(renderer.scrollOffset()).toBe(5);
        renderer.scrollLines(-3);
        expect(renderer.scrollOffset()).toBe(8);
        // …and positive comes back toward the bottom.
        renderer.scrollLines(2);
        expect(renderer.scrollOffset()).toBe(6);

        // The engine's own clamp, at both ends: 93 lines of scrollback for 100 lines of output
        // through an 8-row window, and never past the live bottom.
        renderer.scrollLines(-10_000);
        expect(renderer.scrollOffset()).toBe(93);
        renderer.scrollLines(10_000);
        expect(renderer.scrollOffset()).toBe(0);
    });

    it('announces every move, including the pin that keeps a scrolled view on its lines under output', async () => {
        const seen: number[] = [];
        const off = renderer.onScrollChange((offset) => seen.push(offset));
        renderer.scrollLines(-4);
        expect(seen).toEqual([4]);

        // §7's spike named the constraint: output snapped the viewport to the bottom, so a
        // scrolled-back view was lost on the next chunk. `0.4.0-nex.11` removes it: the offset
        // counts lines up from the bottom, so one appended line moves it from 4 to 5 and the
        // lines on screen stay the lines on screen. The move is announced like any other.
        renderer.write('a new line of output\r\n');
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(renderer.scrollOffset()).toBe(5);
        expect(seen).toEqual([4, 5]);

        renderer.scrollLines(-2);
        renderer.scrollToBottom();
        expect(seen).toEqual([4, 5, 7, 0]);
        off();
        renderer.scrollLines(-1);
        expect(seen).toEqual([4, 5, 7, 0]);
    });

    /**
     * The long press, and the measurement that decided how it is implemented.
     *
     * `offsetX`/`offsetY` are 0 in jsdom (it has no layout), so the synthesized `dblclick` lands
     * on cell 0,0 - the FIRST VISIBLE ROW, which is exactly the row that tells the two candidate
     * implementations apart. Scrolled back 5 lines with 93 lines of scrollback, the first visible
     * row is `line89`; the engine's public `select(0, 0, 7)` answers `line6`, and its own
     * double-click path answers `line89`. That is why `selectWordAt` raises the event the engine
     * already listens for instead of calling `select`.
     */
    it('selects the word under the point, at the row that is actually on screen', () => {
        renderer.scrollLines(-5);
        const seen: string[] = [];
        renderer.onSelectionChange((text) => seen.push(text));

        expect(renderer.selectWordAt?.(0, 0)).toBe(true);
        expect(renderer.selection()).toBe('line89');
        // …and the change reaches the pane, which is what puts a Copy pill on the screen.
        expect(seen).toEqual(['line89']);

        // At the bottom the same press is the first row of the live screen.
        renderer.scrollToBottom();
        renderer.clearSelection();
        expect(renderer.selectWordAt?.(0, 0)).toBe(true);
        expect(renderer.selection()).toBe('line94');
    });

    it('and a disposed renderer scrolls and selects nothing at all', () => {
        renderer.scrollLines(-5);
        expect(renderer.scrollOffset()).toBe(5);
        renderer.dispose();
        renderer.scrollLines(-5);
        renderer.scrollToBottom();
        expect(renderer.scrollOffset()).toBe(0);
        expect(renderer.selectWordAt?.(0, 0)).toBe(false);
    });
});

// ── the adapter's own half ──────────────────────────────────────────────────────────

beforeEach(() => {
    resetEngineStartupGateForTests();
});

afterEach(() => {
    resetEngineStartupGateForTests();
});

/** The narrowest engine that satisfies the adapter, with nothing scroll-shaped on it. */
class BareEngine implements XtermLikeTerminal {
    cols = 80;
    rows = 24;
    open(): void {
        /* nothing to attach */
    }
    write(): void {
        /* not exercised */
    }
    reset(): void {
        /* not exercised */
    }
    focus(): void {
        /* not exercised */
    }
    blur(): void {
        /* not exercised */
    }
    resize(cols: number, rows: number): void {
        this.cols = cols;
        this.rows = rows;
    }
    dispose(): void {
        /* nothing to free */
    }
    onData(): EngineDisposable {
        return { dispose: () => undefined };
    }
}

describe('the adapter over an engine with no scroll of its own', () => {
    it('is inert rather than broken: no throw, and the bottom is where it says it is', async () => {
        const renderer = createRendererFromLoader('xterm', () =>
            Promise.resolve<EngineHandle>({ terminal: new BareEngine() })
        );
        await renderer.open(host());
        renderer.scrollLines(-10);
        renderer.scrollToBottom();
        expect(renderer.scrollOffset()).toBe(0);
        expect(renderer.selectWordAt?.(10, 10)).toBe(false);
        // A listener on an engine that never scrolls is a listener that never fires, not a leak.
        const off = renderer.onScrollChange(() => expect.unreachable('nothing scrolled'));
        off();
        renderer.dispose();
    });

    it('passes the delta through unrounded, and drops the calls that mean nothing', async () => {
        const deltas: number[] = [];
        let offset = 7;
        const renderer = createRendererFromLoader('xterm', () =>
            Promise.resolve<EngineHandle>({
                terminal: new BareEngine(),
                scroll: (delta) => deltas.push(delta),
                scrollOffset: () => offset,
                scrollToBottom: () => {
                    offset = 0;
                }
            })
        );
        await renderer.open(host());
        renderer.scrollLines(-3);
        renderer.scrollLines(2);
        // Zero and a NaN reach nothing: a gesture that computed no lines must not wake the engine.
        renderer.scrollLines(0);
        renderer.scrollLines(Number.NaN);
        expect(deltas).toEqual([-3, 2]);
        expect(renderer.scrollOffset()).toBe(7);
        renderer.scrollToBottom();
        expect(renderer.scrollOffset()).toBe(0);
        renderer.dispose();
    });
});
