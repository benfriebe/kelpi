/**
 * #323: copying a selection over a SOFT-WRAPPED line, measured against the REAL engine.
 *
 * Copy reads the engine's own `getSelection()` (`TerminalRenderer.selection()`), so this runs the
 * installed `ghostty-web` bundle on its shipped WASM, opened into jsdom over a stub 2D context, and
 * asserts on the exact text a ⌘C would put on the clipboard. Before `0.4.0-nex.17` every row ended
 * in `'\n'` and lost its trailing spaces, wrap or no wrap, so a wrapped command or URL pasted back
 * as several lines; the WASM had no way to say whether a HISTORY row was wrapped at all.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ghostty, Terminal } from 'ghostty-web';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let realGetContext: unknown;
let realRaf: unknown;
let realCaf: unknown;
const frames = new Set<ReturnType<typeof setTimeout>>();

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

beforeAll(async () => {
    installStubCanvas();
    const module = await WebAssembly.compile(new Uint8Array(fs.readFileSync(wasmPath)));
    ghostty = new Ghostty(await WebAssembly.instantiate(module, { env: { log() {} } }), module);
});

afterAll(restoreCanvas);

const COLS = 20;
const ROWS = 6;

function openTerminal(): { term: Terminal; dispose: () => void } {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const term = new Terminal({ ghostty, cols: COLS, rows: ROWS, scrollback: 1_000_000 });
    term.open(host);
    return {
        term,
        dispose: () => {
            term.dispose();
            host.remove();
        }
    };
}

/** Select `length` cells from viewport (col, row), wrapping across rows as a drag would. */
function selectRun(term: Terminal, col: number, row: number, length: number): string {
    term.select(col, row, length);
    return term.getSelection();
}

/** Scroll so the history row whose text starts with `prefix` is viewport row 0. */
function scrollRowToTop(term: Terminal, prefix: string): void {
    const vt = term.wasmTerm!;
    const scrollback = vt.getScrollbackLength();
    for (let row = 0; row < scrollback; row += 1) {
        const text = (vt.getScrollbackLine(row) ?? []).map((c) => String.fromCodePoint(c.codepoint || 32)).join('');
        if (text.startsWith(prefix)) {
            term.scrollToLine(scrollback - row);
            return;
        }
    }
    throw new Error(`no history row starts with ${prefix}`);
}

describe('copying a soft-wrapped line (#323)', () => {
    it('joins the rows of one wrapped line, with no newline at the wrap', () => {
        const { term, dispose } = openTerminal();
        try {
            // 50 characters on a 20-column grid: three rows, one logical line.
            const line = 'https://example.com/' + 'abcdefghij'.repeat(3);
            term.write(`${line}\r\n`);
            expect(term.wasmTerm!.isRowWrapped(1)).toBe(true);
            expect(term.wasmTerm!.isRowWrapped(2)).toBe(true);
            expect(selectRun(term, 0, 0, line.length)).toBe(line);
        } finally {
            dispose();
        }
    });

    it('keeps a space that falls in the last column of a wrapped row', () => {
        const { term, dispose } = openTerminal();
        try {
            // 19 x's then a space in column 19, then the rest on the next row.
            const line = `${'x'.repeat(COLS - 1)} alpha bravo`;
            term.write(`${line}\r\n`);
            expect(selectRun(term, 0, 0, line.length)).toBe(line);
        } finally {
            dispose();
        }
    });

    it('keeps the newlines a program printed, and still trims their padding', () => {
        const { term, dispose } = openTerminal();
        try {
            term.write('one   \r\ntwo\r\nthree\r\n');
            // From (0,0) to the end of row 2: rows end in real newlines, so each is trimmed and
            // separated exactly as before.
            expect(selectRun(term, 0, 0, COLS * 2 + 5)).toBe('one\ntwo\nthree');
        } finally {
            dispose();
        }
    });

    it('mixes both: a wrapped line between two printed ones', () => {
        const { term, dispose } = openTerminal();
        try {
            const long = 'k'.repeat(COLS) + 'tail';
            term.write(`head\r\n${long}\r\nfoot\r\n`);
            // Rows: head | kkkk… | tail | foot.
            expect(selectRun(term, 0, 0, COLS * 3 + 4)).toBe(`head\n${long}\nfoot`);
        } finally {
            dispose();
        }
    });

    it('does not copy the spacer a wide character leaves when it wraps early', () => {
        const { term, dispose } = openTerminal();
        try {
            // 19 columns of x, then a 2-column CJK character that cannot fit in column 19: it wraps
            // to the next row and column 19 is left as a spacer, not a space.
            const line = `${'x'.repeat(COLS - 1)}漢字`;
            term.write(`${line}\r\n`);
            expect(term.wasmTerm!.isRowWrapped(1)).toBe(true);
            expect(selectRun(term, 0, 0, COLS + 4)).toBe(line);
        } finally {
            dispose();
        }
    });

    it('keeps the newline after a line exactly as wide as the terminal', () => {
        const { term, dispose } = openTerminal();
        try {
            // Filling the last column arms a pending wrap; the program's own CRLF then ends the line.
            const full = 'f'.repeat(COLS);
            term.write(`${full}\r\nnext\r\n`);
            expect(term.wasmTerm!.isRowWrapped(1)).toBe(false);
            expect(selectRun(term, 0, 0, COLS + 4)).toBe(`${full}\nnext`);
        } finally {
            dispose();
        }
    });

    it('joins from a selection that starts part-way along a wrapped row', () => {
        const { term, dispose } = openTerminal();
        try {
            term.write(`${'x'.repeat(COLS - 4)}abcd efgh\r\n`);
            // From column 16 ("abcd") onto the next row.
            expect(selectRun(term, COLS - 4, 0, 9)).toBe('abcd efgh');
        } finally {
            dispose();
        }
    });

    it('joins on the alternate screen too', () => {
        const { term, dispose } = openTerminal();
        try {
            const line = 'alt ' + 'z'.repeat(COLS) + ' done';
            term.write(`\x1b[?1049h\x1b[H${line}`);
            expect(selectRun(term, 0, 0, line.length)).toBe(line);
        } finally {
            dispose();
        }
    });

    it('joins a line whose head is the last history row and whose tail is on the screen', () => {
        const { term, dispose } = openTerminal();
        try {
            // A two-row line at the top, then exactly enough lines to scroll the screen by ONE: the
            // line's head becomes the only history row while its tail is screen row 0.
            const line = `split ${'s'.repeat(COLS)}`;
            term.write(`${line}\r\n`);
            term.write(Array.from({ length: ROWS - 2 }, (_, i) => `post${String(i)}`).join('\r\n') + '\r\n');
            const vt = term.wasmTerm!;
            const scrollback = vt.getScrollbackLength();
            const lastHistory = (vt.getScrollbackLine(scrollback - 1) ?? []).map((c) => String.fromCodePoint(c.codepoint || 32)).join('');
            expect(lastHistory.startsWith('split')).toBe(true);
            expect(vt.isScreenRowWrapped(scrollback)).toBe(true);
            term.scrollToLine(1);
            expect(selectRun(term, 0, 0, line.length)).toBe(line);
        } finally {
            dispose();
        }
    });

    it('joins a wrapped line that has scrolled into history', () => {
        const { term, dispose } = openTerminal();
        try {
            const line = `history ${'w'.repeat(COLS)} end`;
            term.write(`${line}\r\n`);
            // Push it well into scrollback.
            term.write(Array.from({ length: ROWS * 3 }, (_, i) => `filler${String(i)}`).join('\r\n') + '\r\n');
            const vt = term.wasmTerm!;
            expect(vt.getScrollbackLength()).toBeGreaterThan(0);
            scrollRowToTop(term, 'history');
            // The export answers for history rows; the active-area-only one cannot.
            const scrollback = vt.getScrollbackLength();
            const head = scrollback - Math.floor(term.viewportY);
            expect(head).toBeLessThan(scrollback);
            expect(vt.isScreenRowWrapped(head)).toBe(false);
            expect(vt.isScreenRowWrapped(head + 1)).toBe(true);
            expect(selectRun(term, 0, 0, line.length)).toBe(line);
            // And the xterm-compatible buffer API reports the history row as wrapped too.
            expect(term.buffer.active.getLine(head + 1)?.isWrapped).toBe(true);
        } finally {
            dispose();
        }
    });
});
