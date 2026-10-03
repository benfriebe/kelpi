/**
 * #303: the link underline, measured against the REAL engine (`0.4.0-kelpi.18`).
 *
 * The installed `ghostty-web` bundle on its shipped WASM, opened into jsdom over a 2D context that
 * RECORDS its strokes, so "row 2 is underlined from column 4 to 12 in the text's colour" is a
 * statement about the lines the renderer drew. Two halves:
 *
 *   1. **`linkDetection: false`.** The engine's own detector underlined a plain hover by its own
 *      rules and set a pointer cursor; Kelpi turns it off and asks the daemon instead.
 *   2. **`setLinkUnderline`.** Exactly the cells named, in each cell's foreground colour, across
 *      rows, and gone again when cleared.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ghostty, Terminal } from 'ghostty-web';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createTerminalRenderer, resetEngineStartupGateForTests } from './renderer';

interface Stroke {
    readonly style: string;
    readonly x1: number;
    readonly x2: number;
    readonly y: number;
}

const strokes: Stroke[] = [];
let realGetContext: unknown;
let realRaf: unknown;
let realCaf: unknown;
const frames = new Set<ReturnType<typeof setTimeout>>();

/** A stub 2D context that records every straight line `stroke()` draws. */
function installRecordingCanvas(): void {
    let path: Array<{ x: number; y: number; move: boolean }> = [];
    const context = new Proxy({} as Record<string, unknown>, {
        get(target, property) {
            if (property in target) return target[property as string];
            if (property === 'measureText') {
                return () => ({ width: 8, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
            }
            if (property === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
            if (property === 'createLinearGradient') return () => ({ addColorStop: () => undefined });
            if (property === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
            if (property === 'beginPath') return () => (path = []);
            if (property === 'moveTo') return (x: number, y: number) => path.push({ x, y, move: true });
            if (property === 'lineTo') return (x: number, y: number) => path.push({ x, y, move: false });
            if (property === 'stroke') {
                return () => {
                    for (let index = 1; index < path.length; index++) {
                        const from = path[index - 1]!;
                        const to = path[index]!;
                        if (to.move || from.y !== to.y) continue;
                        strokes.push({ style: String(target['strokeStyle']), x1: from.x, x2: to.x, y: from.y });
                    }
                };
            }
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
        const handle = setTimeout(() => {
            frames.delete(handle);
            callback(0);
        }, 0);
        frames.add(handle);
        return handle as unknown as number;
    };
    global['cancelAnimationFrame'] = (handle: number): void => {
        clearTimeout(handle);
        frames.delete(handle as unknown as ReturnType<typeof setTimeout>);
    };
}

function restoreCanvas(): void {
    for (const handle of frames) clearTimeout(handle);
    frames.clear();
    (HTMLCanvasElement.prototype as unknown as Record<string, unknown>)['getContext'] = realGetContext;
    const global = globalThis as Record<string, unknown>;
    global['requestAnimationFrame'] = realRaf;
    global['cancelAnimationFrame'] = realCaf;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.resolve(here, '../../../../vendor/ghostty-web-patched/ghostty-vt.wasm');
let ghostty: Ghostty;

const THEME = { background: '#101010', foreground: '#e0e0e0' };

function openTerminal(options: { linkDetection?: boolean } = {}) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const term = new Terminal({ ghostty, cols: 40, rows: 6, theme: THEME, ...options });
    term.open(host);
    const renderer = term.renderer!;
    const cell = renderer.getMetrics();
    /** The next frame, as the render loop would paint it (not forced: only the rows it needs). */
    const frame = (): Stroke[] => {
        strokes.length = 0;
        renderer.render(term.wasmTerm!, false, term.viewportY, term, 0);
        return [...strokes];
    };
    /** A frame's underlines as `row:fromCol-toCol style`, one per stroked cell run. */
    const underlines = (drawn: readonly Stroke[]): string[] =>
        drawn
            .map((stroke) => {
                const row = Math.floor(stroke.y / cell.height);
                const from = Math.round(stroke.x1 / cell.width);
                const to = Math.round(stroke.x2 / cell.width);
                return `${String(row)}:${String(from)}-${String(to)} ${stroke.style}`;
            })
            .sort();
    const dispose = (): void => {
        term.dispose();
        host.remove();
    };
    return { term, renderer, cell, host, frame, underlines, dispose };
}

/** Cells `from..to` (exclusive) of one row, the way the renderer strokes them: one per cell. */
function cells(row: number, from: number, to: number, style: string): string[] {
    return Array.from({ length: to - from }, (_, index) => `${String(row)}:${String(from + index)}-${String(from + index + 1)} ${style}`);
}

beforeAll(async () => {
    installRecordingCanvas();
    const module = await WebAssembly.compile(new Uint8Array(fs.readFileSync(wasmPath)));
    ghostty = new Ghostty(await WebAssembly.instantiate(module, { env: { log() {} } }), module);
});

afterAll(restoreCanvas);

afterEach(() => {
    resetEngineStartupGateForTests();
});

describe('linkDetection: false (#303)', () => {
    it('builds no link detector, so a hover over a URL draws nothing and sets no cursor', async () => {
        const t = openTerminal({ linkDetection: false });
        try {
            t.term.write('see https://example.com/x now\r\n');
            t.frame();
            expect((t.term as unknown as { linkDetector?: unknown }).linkDetector).toBeUndefined();
            const canvas = t.host.querySelector('canvas')!;
            canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 320, bottom: 120, width: 320, height: 120, x: 0, y: 0, toJSON() {} });
            t.host.dispatchEvent(new MouseEvent('mousemove', { clientX: 8 * t.cell.width + 2, clientY: 2, bubbles: true }));
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(t.underlines(t.frame())).toEqual([]);
            expect(t.host.style.cursor).toBe('');
        } finally {
            t.dispose();
        }
    });

    it('leaves upstream detection on by default', () => {
        const t = openTerminal();
        try {
            expect((t.term as unknown as { linkDetector?: unknown }).linkDetector).toBeDefined();
        } finally {
            t.dispose();
        }
    });
});

describe('setLinkUnderline (#303)', () => {
    it('underlines exactly the cells named, in the text colour', () => {
        const t = openTerminal({ linkDetection: false });
        try {
            t.term.write('see https://example.com/x now\r\n');
            t.frame();
            t.term.setLinkUnderline([{ row: 0, col: 4, width: 21 }]);
            expect(t.underlines(t.frame())).toEqual(cells(0, 4, 25, '#e0e0e0').sort());
        } finally {
            t.dispose();
        }
    });

    it('follows each cell\'s own colour, and covers a link on two rows', () => {
        const t = openTerminal({ linkDetection: false });
        try {
            // Row 0 is red from column 4; row 1 is the default colour.
            t.term.write('see \x1b[31mhttps://example.\x1b[0m\r\ncom/wrapped now\r\n');
            t.frame();
            t.term.setLinkUnderline([
                { row: 0, col: 4, width: 16 },
                { row: 1, col: 0, width: 11 }
            ]);
            const drawn = t.underlines(t.frame());
            expect(drawn.filter((line) => line.startsWith('1:'))).toEqual(cells(1, 0, 11, '#e0e0e0').sort());
            const red = drawn.filter((line) => line.startsWith('0:'));
            expect(red).toHaveLength(16);
            expect(new Set(red.map((line) => line.split(' ')[1]))).toEqual(new Set([red[0]!.split(' ')[1]]));
            expect(red[0]!.split(' ')[1]).not.toBe('#e0e0e0');
        } finally {
            t.dispose();
        }
    });

    it('repaints the rows it leaves when cleared, and draws nothing there afterwards', () => {
        const t = openTerminal({ linkDetection: false });
        try {
            t.term.write('see https://example.com/x now\r\n');
            t.frame();
            t.term.setLinkUnderline([{ row: 0, col: 4, width: 21 }]);
            t.frame();
            t.term.setLinkUnderline(null);
            // The cleared row is repainted (its glyphs are drawn again, with no line under them).
            expect(t.underlines(t.frame())).toEqual([]);
            expect(t.underlines(t.frame())).toEqual([]);
        } finally {
            t.dispose();
        }
    });

    it('draws one line under a cell the program already underlined', () => {
        const t = openTerminal({ linkDetection: false });
        try {
            t.term.write('\x1b[4mhttps://example.com/x\x1b[0m\r\n');
            t.frame();
            t.term.setLinkUnderline([{ row: 0, col: 0, width: 21 }]);
            expect(t.underlines(t.frame())).toEqual(cells(0, 0, 21, '#e0e0e0').sort());
        } finally {
            t.dispose();
        }
    });

    it('keeps an underline asked for before open()', () => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const term = new Terminal({ ghostty, cols: 40, rows: 6, theme: THEME, linkDetection: false });
        try {
            term.setLinkUnderline([{ row: 0, col: 0, width: 3 }]);
            term.open(host);
            term.write('abc\r\n');
            strokes.length = 0;
            term.renderer!.render(term.wasmTerm!, true, term.viewportY, term, 0);
            expect(strokes).toHaveLength(3);
        } finally {
            term.dispose();
            host.remove();
        }
    });
});

/**
 * The adapter's half (#303): `screenRowsKey` is what the hover compares to decide whether output
 * moved a link, so it is read here off the real engine through the real adapter, at the bottom
 * of a screen with history, on the alternate screen, and across a change only an OSC 8 attribute
 * makes. `onContentChange` is when it is asked.
 */
describe('screenRowsKey and onContentChange through the adapter (#303)', () => {
    const codes = (text: string): string => Array.from(text, (char) => String(char.codePointAt(0))).join(',');
    const row = (key: string | null, index: number): string => (key ?? '').split('\n')[index + 1] ?? '';
    const numbered = (count: number, from = 1): string =>
        Array.from({ length: count }, (_, i) => `line${String(from + i)}`).join('\r\n') + '\r\n';
    const osc8 = (uri: string, text: string): string => `\x1b]8;;${uri}\x1b\\${text}\x1b]8;;\x1b\\`;

    async function open() {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const renderer = createTerminalRenderer({ cols: 40, rows: 6 });
        let changes = 0;
        renderer.onContentChange(() => {
            changes += 1;
        });
        await renderer.open(host);
        return {
            renderer,
            changes: () => changes,
            dispose: () => {
                renderer.dispose();
                host.remove();
            }
        };
    }

    it('keys the rows on screen, below a history, and the grid they sit in', async () => {
        const t = await open();
        try {
            t.renderer.write(numbered(30));
            // 30 lines through 6 rows: line26 to line30 on rows 0 to 4, the cursor's blank row 5.
            const key = t.renderer.screenRowsKey([2, 4]);
            expect(key?.split('\n')[0]).toBe('40x6');
            expect(row(key, 0).startsWith(codes('line28'))).toBe(true);
            expect(row(key, 1).startsWith(codes('line30'))).toBe(true);
        } finally {
            t.dispose();
        }
    });

    it('announces applied output, and the key moves with the rows it covers and nothing else', async () => {
        const t = await open();
        try {
            t.renderer.write('\x1b[2J\x1b[Hlink row\r\nother row\r\n');
            const linkRow = t.renderer.screenRowsKey([0]);
            const before = t.changes();
            // Rewrite row 1 only: row 0's key is unchanged.
            t.renderer.write('\x1b[2;1Hchanged!!');
            expect(t.changes()).toBeGreaterThan(before);
            expect(t.renderer.screenRowsKey([0])).toBe(linkRow);
            // Rewrite row 0: it moves.
            t.renderer.write('\x1b[1;1Hnew text');
            expect(t.renderer.screenRowsKey([0])).not.toBe(linkRow);
        } finally {
            t.dispose();
        }
    });

    /**
     * A link that appears or goes away under the same text moves the key. A different address
     * swapped in under the same text does not: the engine reuses the cell's link id for it, so
     * nothing on the client can tell. The cells are still a link then, which is what the
     * underline says; only a swap to an address the daemon refuses would differ from a click.
     */
    it('moves when an OSC 8 link appears or goes away under the same text', async () => {
        const t = await open();
        try {
            t.renderer.write('\x1b[2J\x1b[Hthe docs');
            const plain = t.renderer.screenRowsKey([0]);
            expect(row(plain, 0).startsWith(codes('the docs'))).toBe(true);
            t.renderer.write(`\x1b[1;1H${osc8('https://a.example/', 'the docs')}`);
            const linked = t.renderer.screenRowsKey([0]);
            expect(linked).not.toBe(plain);
            t.renderer.write('\x1b[1;1Hthe docs');
            expect(t.renderer.screenRowsKey([0])).not.toBe(linked);
        } finally {
            t.dispose();
        }
    });

    it('keys the alternate screen, where a full-screen TUI lives', async () => {
        const t = await open();
        try {
            t.renderer.write(numbered(30));
            t.renderer.write('\x1b[?1049h\x1b[3;1Halt screen');
            expect(row(t.renderer.screenRowsKey([2]), 0).startsWith(codes('alt screen'))).toBe(true);
        } finally {
            t.dispose();
        }
    });

    it('announces a resize, and keys the new grid', async () => {
        const t = await open();
        try {
            const before = t.changes();
            t.renderer.resize(30, 6);
            expect(t.changes()).toBeGreaterThan(before);
            expect(t.renderer.screenRowsKey([0])?.split('\n')[0]).toBe('30x6');
        } finally {
            t.dispose();
        }
    });
});
