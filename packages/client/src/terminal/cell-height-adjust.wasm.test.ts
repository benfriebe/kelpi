/**
 * A cell's height can be adjusted by whole pixels (`0.4.0-kelpi.26`), measured against the REAL
 * engine. The font fixes a row at `ceil(ascent + descent) + 2` (12 with the stub below); the
 * adjustment is added to that, never below one pixel, and the glyph stays centred in the row.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ghostty, Terminal } from 'ghostty-web';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let realGetContext: unknown;

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
            expect(term.renderer!.getCanvas().height).toBeGreaterThanOrEqual(18 * 6);
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
            expect(term.renderer!.getCanvas().height).toBeGreaterThanOrEqual(16 * 6);
        } finally {
            done();
        }
    });
});
