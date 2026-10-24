/**
 * The cursor is repainted when it changes and only then (`0.4.0-kelpi.24`), on the REAL engine.
 *
 * Upstream redrew the cursor line on every frame while the blink SETTING was on, and drew the
 * cursor on every frame regardless. That per-frame paint also hid the cases where nothing marks
 * the cursor's row dirty: DECTCEM hiding the cursor, a focus flip, a style change. Frames here
 * are `render()` calls this file makes by hand, counting `renderLine` and `renderCursor`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ghostty, Terminal } from 'ghostty-web';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let realGetContext: unknown;
let realRaf: unknown;

function installCanvas(): void {
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
    // The engine's own loop never runs: every frame below is an explicit `render()`.
    const global = globalThis as Record<string, unknown>;
    realRaf = global['requestAnimationFrame'];
    global['requestAnimationFrame'] = (): number => 0;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.resolve(here, '../../../../vendor/ghostty-web-patched/ghostty-vt.wasm');
let ghostty: Ghostty;

beforeAll(async () => {
    installCanvas();
    const module = await WebAssembly.compile(new Uint8Array(fs.readFileSync(wasmPath)));
    ghostty = new Ghostty(await WebAssembly.instantiate(module, { env: { log() {} } }), module);
});

afterAll(() => {
    (HTMLCanvasElement.prototype as unknown as Record<string, unknown>)['getContext'] = realGetContext;
    (globalThis as Record<string, unknown>)['requestAnimationFrame'] = realRaf;
});

describe('the cursor is repainted when it changes (0.4.0-kelpi.24)', () => {
    it('repaints on a focus flip, a style change and a DECTCEM hide, and not on an idle frame', () => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const term = new Terminal({ ghostty, cols: 40, rows: 6, cursorBlink: true });
        term.open(host);
        const renderer = term.renderer!;
        const spied = renderer as unknown as Record<string, (...args: unknown[]) => unknown>;
        const counts = { lines: [] as number[], cursors: 0 };
        for (const name of ['renderLine', 'renderCursor'] as const) {
            const original = spied[name]!.bind(renderer);
            spied[name] = (...args: unknown[]): unknown => {
                if (name === 'renderLine') counts.lines.push(args[1] as number);
                else counts.cursors++;
                return original(...args);
            };
        }
        const frame = (): typeof counts => {
            counts.lines = [];
            counts.cursors = 0;
            renderer.render(term.wasmTerm!, false, 0, term, 0);
            return { lines: [...counts.lines], cursors: counts.cursors };
        };
        try {
            term.write('$ ');
            frame();

            // Idle, blink setting on: nothing to paint. Upstream redrew the line and the cursor.
            expect(frame()).toEqual({ lines: [], cursors: 0 });

            // Focus flip: filled block -> hollow outline, once.
            renderer.setFocused(false);
            expect(frame()).toEqual({ lines: [0], cursors: 1 });
            expect(frame()).toEqual({ lines: [], cursors: 0 });

            // A live style change paints the new shape over a cleared cell.
            renderer.setCursorStyle('bar');
            expect(frame()).toEqual({ lines: [0], cursors: 1 });

            // DECTCEM hide dirties no row; the cursor's row must still be repainted to erase it.
            term.write('\x1b[?25l');
            const hidden = frame();
            expect(hidden.lines).toContain(0);
            expect(hidden.cursors).toBe(0);
            expect(frame()).toEqual({ lines: [], cursors: 0 });

            // …and showing it again draws it.
            term.write('\x1b[?25h');
            expect(frame().cursors).toBe(1);
        } finally {
            term.dispose();
            host.remove();
        }
    });
});
