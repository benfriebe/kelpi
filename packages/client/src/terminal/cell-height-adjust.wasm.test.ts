/**
 * A cell's height can be adjusted by whole pixels (`0.4.0-kelpi.26`), measured against the REAL
 * engine. The font fixes a row at `ceil(ascent + descent) + 2` (12 with the stub below); the
 * adjustment is added to that, with shrink limited to the padding, and the glyph stays centred in the row.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ghostty, Terminal } from 'ghostty-web';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let realGetContext: unknown;
let fontAscent = 8;
const strokeStarts: number[] = [];

function installCanvas(): void {
    const context = new Proxy({} as Record<string, unknown>, {
        get(target, property) {
            if (property in target) return target[property as string];
            if (property === 'measureText') {
                return () => ({ width: 8, actualBoundingBoxAscent: fontAscent, actualBoundingBoxDescent: 2 });
            }
            if (property === 'moveTo') return (_x: number, y: number) => strokeStarts.push(y);
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
    installCanvas();
    const module = await WebAssembly.compile(new Uint8Array(fs.readFileSync(wasmPath)));
    ghostty = new Ghostty(await WebAssembly.instantiate(module, { env: { log() {} } }), module);
});

afterAll(() => {
    (HTMLCanvasElement.prototype as unknown as Record<string, unknown>)['getContext'] = realGetContext;
});

function open(cellHeightAdjust?: number): { term: Terminal; done: () => void } {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const term = new Terminal({
        ghostty,
        cols: 40,
        rows: 6,
        ...(cellHeightAdjust === undefined ? {} : { cellHeightAdjust })
    });
    term.open(host);
    return {
        term,
        done: () => {
            term.dispose();
            host.remove();
        }
    };
}

describe('cellHeightAdjust (0.4.0-kelpi.26)', () => {
    it('leaves the font-derived row alone when unset', () => {
        const { term, done } = open();
        try {
            expect(term.renderer!.getMetrics()).toMatchObject({ width: 8, height: 12, baseline: 9 });
        } finally {
            done();
        }
    });

    it('makes every row taller by the adjustment and keeps the glyph centred', () => {
        const { term, done } = open(6);
        try {
            const metrics = term.renderer!.getMetrics();
            expect(metrics).toMatchObject({ width: 8, height: 18, baseline: 12 });
            // The canvas is sized from the metrics, so the pane's rows really are taller.
            expect(term.renderer!.getCanvas().height).toBe(Math.floor(18 * 6 * window.devicePixelRatio));
        } finally {
            done();
        }
    });

    it('can shrink a row, but only by the 2px of padding, so the glyph and underline still fit', () => {
        const small = open(-2);
        try {
            // Natural row is 12 (10 of glyph plus 2 of padding); the baseline moves up by one.
            expect(small.term.renderer!.getMetrics()).toMatchObject({ height: 10, baseline: 8 });
        } finally {
            small.done();
        }
        const floor = open(-500);
        try {
            expect(floor.term.renderer!.getMetrics()).toMatchObject({ height: 10, baseline: 8 });
        } finally {
            floor.done();
        }
    });

    it('draws an underline inside a row at maximum shrink', async () => {
        const { term, done } = open(-2);
        try {
            strokeStarts.length = 0;
            term.write('\x1b[4mA\x1b[0m');
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            expect(strokeStarts).toContain(9.5);
            expect(strokeStarts).not.toContain(10);
        } finally {
            done();
        }
    });

    it('draws link underlines inside a row at maximum shrink, where the text underline is', () => {
        const { term, done } = open(-2);
        try {
            term.write('AAAAAA\r\nBBBBBB\r\nCCCCCC');
            const renderer = term.renderer!;
            // Row 1 carries the embedder's link underline, row 2 the hovered link range. Rows are
            // 10px tall with the baseline at 8, so two pixels under the baseline is the row's
            // boundary (20, 30), which the next row's background paints over half of.
            renderer.setLinkUnderline([{ row: 1, col: 0, width: 6 }]);
            renderer.setHoveredLinkRange({ startX: 0, startY: 2, endX: 5, endY: 2 });
            strokeStarts.length = 0;
            renderer.render((term as unknown as { wasmTerm: Parameters<typeof renderer.render>[0] }).wasmTerm, true, 0, term);
            expect(strokeStarts).toContain(19.5);
            expect(strokeStarts).toContain(29.5);
            expect(strokeStarts).not.toContain(20);
            expect(strokeStarts).not.toContain(30);
        } finally {
            done();
        }
    });

    /**
     * A row height change that lands while paint is suspended (the resize hold) must leave the
     * frozen frame alone. Upstream's `handleFontChange` followed `renderer.resize()` with its own
     * `canvas.width`/`height` assignments in CSS pixels: a second allocation that wipes the canvas
     * and drops the display scale, with the render that would repair it suppressed.
     */
    it('sizes the canvas once, at the display scale, when the option changes while paint is suspended', () => {
        vi.stubGlobal('devicePixelRatio', 2);
        const { term, done } = open();
        try {
            const canvas = term.renderer!.getCanvas();
            const assigned: string[] = [];
            for (const key of ['width', 'height'] as const) {
                const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, key)!;
                Object.defineProperty(canvas, key, {
                    configurable: true,
                    get: () => descriptor.get!.call(canvas) as number,
                    set: (value: number) => {
                        assigned.push(`${key}=${String(value)}`);
                        descriptor.set!.call(canvas, value);
                    }
                });
            }
            term.setPaintSuspended(true);
            term.options.cellHeightAdjust = 4;
            // 40 columns of 8px and 6 rows of 16px, both times the display scale, and nothing after.
            expect(assigned).toEqual(['width=640', 'height=192']);
            expect(canvas.height).toBe(192);

            // Not suspended, the same change is one allocation too, where it used to be three.
            term.setPaintSuspended(false);
            assigned.length = 0;
            term.options.cellHeightAdjust = 0;
            expect(assigned).toEqual(['width=640', 'height=144']);
        } finally {
            done();
            vi.unstubAllGlobals();
        }
    });

    it('resizes the canvas when the font metrics change and the adjustment stays unchanged', () => {
        const { term, done } = open(-2);
        try {
            fontAscent = 12;
            term.refreshMetrics();
            expect(term.renderer!.getMetrics()).toMatchObject({ height: 14, baseline: 12 });
            expect(term.renderer!.getCanvas().height).toBe(Math.floor(14 * 6 * window.devicePixelRatio));
        } finally {
            fontAscent = 8;
            done();
        }
    });

    it('ignores a value that is not a number', () => {
        const { term, done } = open(Number.NaN);
        try {
            expect(term.renderer!.getMetrics().height).toBe(12);
        } finally {
            done();
        }
    });

    it('re-measures and resizes the canvas when the option changes after open', () => {
        const { term, done } = open();
        try {
            term.options.cellHeightAdjust = 4;
            expect(term.renderer!.getMetrics().height).toBe(16);
            expect(term.renderer!.getCanvas().height).toBe(Math.floor(16 * 6 * window.devicePixelRatio));
        } finally {
            done();
        }
    });
});
