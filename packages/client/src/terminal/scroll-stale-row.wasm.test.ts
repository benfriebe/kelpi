/**
 * A terminal scrolled back by a trackpad shows every row it holds, once (vendor `0.4.0-kelpi.20`).
 *
 * Users saw an agent's output line drawn twice, sometimes more, while scrolling a pane. A
 * pixel-mode wheel (every trackpad, and a mouse on macOS) leaves the engine's `viewportY`
 * fractional, mid-animation and at rest. The renderer decided "history or live screen" for each
 * row with `y < viewportY` but indexed history with `Math.floor(viewportY)`, so on the row
 * `y = floor(viewportY)` it asked for the history line one past the end, got none and painted
 * nothing: that row kept its previous frame. It is the row where the live screen's first line
 * belongs, so the pane showed a neighbouring line twice and never showed that one.
 *
 * Everything here runs the installed bundle on the shipped WASM over a 2D context that remembers,
 * for each canvas row, the text the renderer last painted there (`renderLine` is the one place a
 * row's cells reach the canvas). A row is stale when that text is not what the engine holds for
 * the row on screen. Scrolling goes through the engine's own wheel listener with pixel deltas.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ghostty, Terminal, type GhosttyCell } from 'ghostty-web';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let realGetContext: unknown;

/** jsdom has no canvas; a context that accepts every call is all the engine needs to open. */
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
}

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.resolve(here, '../../../../vendor/ghostty-web-patched/ghostty-vt.wasm');
let ghostty: Ghostty;

beforeAll(async () => {
    installStubCanvas();
    const module = await WebAssembly.compile(new Uint8Array(fs.readFileSync(wasmPath)));
    ghostty = new Ghostty(await WebAssembly.instantiate(module, { env: { log() {} } }), module);
});

afterAll(() => {
    (HTMLCanvasElement.prototype as unknown as Record<string, unknown>)['getContext'] = realGetContext;
});

const text = (cells: GhosttyCell[] | null): string =>
    (cells ?? [])
        .filter((c) => c.width !== 0)
        .map((c) => (c.codepoint === 0 ? ' ' : String.fromCodePoint(c.codepoint)))
        .join('')
        .trimEnd();

function openTerminal(cols: number, rows: number) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    // No animation: a wheel event lands its target at once, as the last frame of one would.
    const term = new Terminal({ ghostty, cols, rows, scrollback: 100_000, smoothScrollDuration: 0 });
    term.open(host);
    const renderer = term.renderer as unknown as Record<string, unknown>;
    const painted: string[] = Array.from({ length: rows }, () => '');
    const renderLine = renderer['renderLine'] as (line: GhosttyCell[], y: number, cols: number) => void;
    renderer['renderLine'] = function (this: unknown, line: GhosttyCell[], y: number, width: number): void {
        painted[y] = text(line);
        renderLine.call(this, line, y, width);
    };
    /** One frame, as the render loop asks for it. */
    const frame = (): void => {
        term.renderer!.render(term.wasmTerm!, false, term.viewportY, term, 0);
    };
    /** A trackpad's wheel event: `deltaY` pixels, positive towards the live bottom. */
    const wheel = (deltaY: number): void => {
        host.dispatchEvent(new WheelEvent('wheel', { deltaY, deltaMode: WheelEvent.DOM_DELTA_PIXEL, bubbles: true, cancelable: true }));
    };
    const lineHeight = term.renderer!.getMetrics().height;
    /** The text the engine holds on viewport row `row`, through the whole-line floor of the offset. */
    const held = (row: number): string => {
        const vt = term.wasmTerm!;
        const scrollback = vt.getScrollbackLength();
        const absolute = scrollback - Math.floor(term.viewportY) + row;
        return text(absolute < scrollback ? vt.getScrollbackLine(absolute) : vt.getLine(absolute - scrollback));
    };
    /** Every row whose last paint is not what the engine holds there. */
    const staleRows = (): string[] =>
        painted.flatMap((shown, y) => {
            const truth = held(y);
            return shown === truth ? [] : [`row ${String(y)} shows ${JSON.stringify(shown)}, holds ${JSON.stringify(truth)}`];
        });
    const dispose = (): void => {
        term.dispose();
        host.remove();
    };
    return { term, painted, frame, wheel, lineHeight, staleRows, dispose };
}

const numbered = (count: number, from = 1): string =>
    Array.from({ length: count }, (_, i) => `line${String(from + i)}`).join('\r\n');

describe('a scrolled terminal paints every row it holds (vendor 0.4.0-kelpi.20)', () => {
    it('comes to rest between lines with no row left over from the frame before', () => {
        const t = openTerminal(40, 10);
        try {
            t.term.write(numbered(60));
            t.frame();
            // Up 3.4 lines in three trackpad events, a frame after each.
            for (const lines of [1.2, 1.4, 0.8]) {
                t.wheel(-lines * t.lineHeight);
                t.frame();
            }
            expect(t.term.viewportY).toBeCloseTo(3.4);
            expect(t.staleRows()).toEqual([]);
            // The whole-line offset is 3: history's last three lines, then the live screen from its top.
            expect(t.painted).toEqual(['line48', 'line49', 'line50', 'line51', 'line52', 'line53', 'line54', 'line55', 'line56', 'line57']);
        } finally {
            t.dispose();
        }
    });

    it('never paints a line twice through a slow scroll up and back down', () => {
        const t = openTerminal(40, 12);
        try {
            t.term.write(numbered(200));
            t.frame();
            const seen: string[] = [];
            const step = (deltaY: number): void => {
                t.wheel(deltaY);
                t.frame();
                const stale = t.staleRows();
                if (stale.length > 0) seen.push(`viewportY ${t.term.viewportY.toFixed(2)}: ${stale.join('; ')}`);
                for (let y = 1; y < t.painted.length; y++) {
                    if (t.painted[y] === t.painted[y - 1]) seen.push(`viewportY ${t.term.viewportY.toFixed(2)}: ${t.painted[y]!} on rows ${String(y - 1)} and ${String(y)}`);
                }
            };
            // A third of a line per event, the way a finger moves slowly on a trackpad.
            for (let i = 0; i < 60; i++) step(-t.lineHeight / 3);
            for (let i = 0; i < 70; i++) step(t.lineHeight / 3);
            expect(seen).toEqual([]);
        } finally {
            t.dispose();
        }
    });

    it('keeps every row current while an agent redraws its live region under a scrolled view', () => {
        const rows = 12;
        const t = openTerminal(50, rows);
        try {
            t.term.write(numbered(40) + '\r\n');
            // An inline agent UI: finished lines go above a spinner and a 3-line input box, which
            // is erased and redrawn in place on every tick, the way a log-update renderer does it.
            const live = (tick: number): string[] => [`* Thinking ${String(tick)}s`, '+--------+', '| >      |', '+--------+'];
            const erase = '\x1b[2K\x1b[1A'.repeat(3) + '\x1b[2K\x1b[G';
            t.term.write(live(0).join('\r\n'));
            const seen: string[] = [];
            for (let tick = 1; tick <= 60; tick++) {
                const finished = tick % 3 === 0 ? `At 75%, Remy or the sous chef tells you: ${String(tick / 3)}\r\n` : '';
                t.term.write(erase + finished + live(tick).join('\r\n'));
                // Up for the first half, back down for the second: under half a line per tick.
                t.wheel((tick <= 30 ? -0.45 : 0.45) * t.lineHeight);
                t.frame();
                const stale = t.staleRows();
                if (stale.length > 0) seen.push(`tick ${String(tick)}, viewportY ${t.term.viewportY.toFixed(2)}: ${stale.join('; ')}`);
            }
            expect(seen).toEqual([]);
        } finally {
            t.dispose();
        }
    });
});
