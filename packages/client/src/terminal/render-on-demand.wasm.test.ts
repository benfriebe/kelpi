/**
 * The engine's render loop runs on demand (`0.4.0-kelpi.25`), measured against the REAL engine.
 *
 * Upstream chained `requestAnimationFrame` forever, so every open terminal woke the page, the GPU
 * process and the window server at the display's refresh rate while showing nothing new. Frames
 * here are a queue this file drains by hand: an idle terminal must leave it EMPTY, and output or a
 * renderer setter must put a frame back on it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ghostty, Terminal } from 'ghostty-web';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let realGetContext: unknown;
let realRaf: unknown;
let realCaf: unknown;
const queue = new Map<number, FrameRequestCallback>();
let nextHandle = 1;

function installCanvasAndFrames(): void {
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
        const handle = nextHandle++;
        queue.set(handle, callback);
        return handle;
    };
    global['cancelAnimationFrame'] = (handle: number): void => {
        queue.delete(handle);
    };
}

/** Run frames until none is pending; returns how many ran. Throws if the loop never stops. */
function drainFrames(limit = 100): number {
    let ran = 0;
    while (queue.size > 0) {
        if (ran >= limit) throw new Error(`render loop still scheduling after ${String(limit)} frames`);
        const [handle, callback] = queue.entries().next().value!;
        queue.delete(handle);
        callback(0);
        ran++;
    }
    return ran;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.resolve(here, '../../../../vendor/ghostty-web-patched/ghostty-vt.wasm');
let ghostty: Ghostty;

beforeAll(async () => {
    installCanvasAndFrames();
    const module = await WebAssembly.compile(new Uint8Array(fs.readFileSync(wasmPath)));
    ghostty = new Ghostty(await WebAssembly.instantiate(module, { env: { log() {} } }), module);
});

afterAll(() => {
    queue.clear();
    (HTMLCanvasElement.prototype as unknown as Record<string, unknown>)['getContext'] = realGetContext;
    const global = globalThis as Record<string, unknown>;
    global['requestAnimationFrame'] = realRaf;
    global['cancelAnimationFrame'] = realCaf;
});

describe('the render loop runs on demand (0.4.0-kelpi.25)', () => {
    it('stops once idle, and output, a renderer setter or a scroll wakes it for a short tail', () => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const term = new Terminal({ ghostty, cols: 40, rows: 6, cursorBlink: true });
        term.open(host);
        try {
            expect(drainFrames()).toBeGreaterThan(0);
            expect(queue.size).toBe(0);

            term.write('hello\r\n');
            expect(queue.size).toBe(1);
            drainFrames();

            term.renderer!.setFocused(false);
            expect(queue.size).toBe(1);
            drainFrames();

            term.viewportY = 0;
            expect(queue.size).toBe(1);
            drainFrames();

            // Idle again: nothing pending, however long it sits.
            expect(queue.size).toBe(0);
        } finally {
            term.dispose();
            host.remove();
        }
        expect(queue.size).toBe(0);
    });

    it('goes idle at a fractional device pixel ratio', () => {
        // 40 cols x 8 px x 1.37 = 438.4 device px, which `canvas.width` truncates to 438. An
        // unrounded size check resized on every frame, and the resize woke the loop again: a
        // phone's page hung the moment a terminal opened.
        const ratio = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
        Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1.37 });
        const host = document.createElement('div');
        document.body.appendChild(host);
        const term = new Terminal({ ghostty, cols: 40, rows: 6 });
        term.open(host);
        try {
            expect(drainFrames()).toBeGreaterThan(0);
            expect(queue.size).toBe(0);
        } finally {
            term.dispose();
            host.remove();
            if (ratio) Object.defineProperty(window, 'devicePixelRatio', ratio);
            else delete (window as unknown as Record<string, unknown>)['devicePixelRatio'];
        }
    });
});
