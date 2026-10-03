/**
 * #306: ⌘F over a terminal pane, measured against the REAL engine.
 *
 * The daemon finds the matches (`daemon/src/term/search.ts`); this file is about the half the
 * issue found missing, which is showing them. Everything here runs the installed `ghostty-web`
 * bundle on its shipped WASM, opened into jsdom over a 2D context that RECORDS what is painted, so
 * "the match is highlighted on row 3" is a statement about the `fillRect` calls the renderer made
 * rather than about a fake's bookkeeping. Three groups:
 *
 *   1. **`select()` with scrollback.** Before `0.4.0-kelpi.16` it stored `viewportY + row`, which the
 *      renderer paints back at `row + 2 * viewportY - scrollbackLength`: right on a fresh pane,
 *      off screen in any pane with history. The old `terminal/reveal.test.ts` checked the
 *      adapter's arithmetic against a fake handle and could never have seen it.
 *   2. **The highlight layer.** Every visible match at once, the current one distinct, following
 *      scrolls and output, gone when the bar closes, under the user's own selection.
 *   3. **Parity with the daemon.** The same bytes into the daemon's own emulator and matcher and
 *      into the engine: every match the daemon counts is one the engine paints as current when the
 *      daemon's coordinates for it are handed over, on the cells that show the needle.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ghostty, Terminal, type GhosttyCell } from 'ghostty-web';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createTerminalRenderer, resetEngineStartupGateForTests, type TerminalSearchSpan } from './renderer';

// ── the recording canvas ────────────────────────────────────────────────────────────

interface Paint {
    readonly op: 'fillRect' | 'fillText' | 'clearRect';
    readonly style: string;
    readonly x: number;
    readonly y: number;
    readonly text?: string;
}

const painted: Paint[] = [];
let realGetContext: unknown;
let realRaf: unknown;
let realCaf: unknown;
const frames = new Set<ReturnType<typeof setTimeout>>();

/**
 * `KeyBar.test.tsx`'s stub 2D context, with the three paint calls recorded. jsdom has no canvas,
 * and that one gap is all that stops the engine opening in Node.
 */
function installRecordingCanvas(): void {
    const context = new Proxy({} as Record<string, unknown>, {
        get(target, property) {
            if (property in target) return target[property as string];
            if (property === 'measureText') {
                return () => ({ width: 8, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
            }
            if (property === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
            if (property === 'createLinearGradient') return () => ({ addColorStop: () => undefined });
            if (property === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
            if (property === 'fillRect' || property === 'clearRect') {
                return (x: number, y: number) => {
                    painted.push({ op: property, style: String(target['fillStyle']), x, y });
                };
            }
            if (property === 'fillText') {
                return (text: string, x: number, y: number) => {
                    painted.push({ op: 'fillText', style: String(target['fillStyle']), x, y, text });
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

const frame = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

// ── the engine ──────────────────────────────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.resolve(here, '../../../../vendor/ghostty-web-patched/ghostty-vt.wasm');

let ghostty: Ghostty;

const THEME = {
    background: '#101010',
    foreground: '#e0e0e0',
    selectionBackground: '#3355aa',
    selectionForeground: '#ffffff',
    searchBackground: '#f2d027',
    searchForeground: '#000000',
    searchSelectedBackground: '#ff7a00',
    searchSelectedForeground: '#111111'
};

/** The engine's own Terminal, opened for real, plus helpers that read back what it painted. */
function openTerminal(cols: number, rows: number, scrollback = 1_000_000) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const term = new Terminal({ ghostty, cols, rows, theme: THEME, scrollback });
    term.open(host);
    const renderer = term.renderer!;
    const cell = renderer.getMetrics();
    /** A full frame now, the way the adapter's `repaint` forces one; returns what it painted. */
    const render = (): Paint[] => {
        painted.length = 0;
        renderer.render(term.wasmTerm!, true, term.viewportY, term, 0);
        return [...painted];
    };
    /** The rows a frame filled with `style`, as `row:col` cells. */
    const cellsFilled = (paints: readonly Paint[], style: string): string[] =>
        paints
            .filter((paint) => paint.op === 'fillRect' && paint.style === style)
            .map((paint) => `${String(Math.round(paint.y / cell.height))}:${String(Math.round(paint.x / cell.width))}`);
    /** One viewport row's text, as the engine holds it. */
    const rowText = (row: number): string => {
        const scrollback = term.wasmTerm!.getScrollbackLength();
        const absolute = scrollback - Math.floor(term.viewportY) + row;
        const cells: GhosttyCell[] | null =
            absolute < scrollback ? term.wasmTerm!.getScrollbackLine(absolute) : term.wasmTerm!.getLine(absolute - scrollback);
        return (cells ?? [])
            .filter((c) => c.width !== 0)
            .map((c) => (c.codepoint === 0 ? ' ' : String.fromCodePoint(c.codepoint)))
            .join('')
            .trimEnd();
    };
    const dispose = (): void => {
        term.dispose();
        host.remove();
    };
    return { term, renderer, cell, render, cellsFilled, rowText, dispose };
}

/** The lines a daemon would count from the bottom, for a match on viewport row `row`. */
function linesFromBottom(term: Terminal, row: number): number {
    return term.rows + Math.floor(term.viewportY) - row;
}

/**
 * Scroll so the history row whose text starts with `prefix` is viewport row 0. Found by content:
 * the engine bounds its history in bytes, so a fixed index would depend on what it trimmed.
 */
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

beforeAll(async () => {
    installRecordingCanvas();
    const module = await WebAssembly.compile(new Uint8Array(fs.readFileSync(wasmPath)));
    ghostty = new Ghostty(await WebAssembly.instantiate(module, { env: { log() {} } }), module);
});

afterAll(restoreCanvas);

afterEach(() => {
    resetEngineStartupGateForTests();
});

const numbered = (count: number, from = 1): string =>
    Array.from({ length: count }, (_, i) => `line${String(from + i)}`).join('\r\n') + '\r\n';

// ── 1. select() with scrollback ───────────────────────────────────────────────────────

describe('select() lands on the row it names, with scrollback (#306)', () => {
    it('selects the visible row, scrolled back and at the live bottom', () => {
        const t = openTerminal(40, 8);
        try {
            // 100 lines through 8 rows: 93 lines of history, the cursor on a blank last row.
            t.term.write(numbered(100));
            expect(t.term.wasmTerm!.getScrollbackLength()).toBe(93);

            t.term.scrollToLine(5);
            expect(t.rowText(0)).toBe('line89');
            t.term.select(0, 0, 6);
            // Before -kelpi.16 this answered `line6`: the stored row was `viewportY + row`.
            expect(t.term.getSelection()).toBe('line89');
            expect(t.term.getSelectionPosition()).toEqual({ start: { x: 0, y: 0 }, end: { x: 5, y: 0 } });

            t.term.scrollToBottom();
            t.term.select(0, 2, 6);
            // …and `line3` at the bottom, where row 2 shows `line96`.
            expect(t.rowText(2)).toBe('line96');
            expect(t.term.getSelection()).toBe('line96');

            t.term.scrollToLine(5);
            t.term.selectLines(1, 2);
            expect(t.term.getSelection()).toBe('line90\nline91');
            t.term.selectAll();
            expect(t.term.getSelection().split('\n')[0]).toBe('line89');
        } finally {
            t.dispose();
        }
    });

    it('paints the selection on that row and on no other', () => {
        const t = openTerminal(40, 8);
        try {
            t.term.write(numbered(100));
            t.term.scrollToLine(5);
            t.term.select(0, 3, 6);
            expect(t.term.getSelection()).toBe(t.rowText(3));
            const cells = t.cellsFilled(t.render(), THEME.selectionBackground);
            expect(cells).toEqual(['3:0', '3:1', '3:2', '3:3', '3:4', '3:5']);
        } finally {
            t.dispose();
        }
    });
});

// ── 2. the highlight layer ──────────────────────────────────────────────────────────

/** 60 numbered lines, every tenth carrying the needle: `Marker` on row20/40/60, `marker` else. */
function seeded(): string {
    const lines: string[] = [];
    for (let n = 1; n <= 60; n += 1) {
        lines.push(n % 10 === 0 ? `row${String(n)} has a ${n % 20 === 0 ? 'Marker' : 'marker'} here` : `row${String(n)}`);
    }
    return lines.join('\r\n') + '\r\n';
}

describe('the search highlight layer (#306)', () => {
    it('highlights every visible match as soon as the needle is set, with nothing current', async () => {
        const t = openTerminal(40, 12);
        try {
            t.term.write(seeded());
            // On screen at the bottom: row50 … row60 on rows 0-10, then the blank cursor row.
            const seen: TerminalSearchSpan[][] = [];
            t.term.onSearchHighlightChange((spans) => seen.push(spans));
            t.term.setSearchHighlight({ needle: 'marker' });

            const spans = t.term.getSearchHighlights();
            // Case-insensitive by default, the daemon's rule; the needle starts at column 12.
            expect(spans).toEqual([
                { row: 0, startCol: 12, endCol: 17, current: false },
                { row: 10, startCol: 12, endCol: 17, current: false }
            ]);
            expect(t.rowText(0)).toBe('row50 has a marker here');
            expect(t.rowText(10)).toBe('row60 has a Marker here');

            const paints = t.render();
            const filled = t.cellsFilled(paints, THEME.searchBackground);
            expect(filled).toHaveLength(12);
            for (const span of spans) expect(filled).toContain(`${String(span.row)}:12`);
            // The glyphs take the match's own foreground, so the text reads on the highlight.
            const glyphs = paints.filter((paint) => paint.op === 'fillText' && paint.style === THEME.searchForeground);
            expect(glyphs.map((paint) => paint.text).join('')).toBe('markerMarker');
            expect(t.cellsFilled(paints, THEME.searchSelectedBackground)).toEqual([]);

            // The engine's own loop announces the frame that first painted them.
            await frame();
            expect(seen.at(-1)).toHaveLength(2);
        } finally {
            t.dispose();
        }
    });

    it('highlights the matches in a pane with a long scrollback, wherever it is scrolled', () => {
        const t = openTerminal(40, 12);
        try {
            t.term.write(numbered(2000));
            t.term.write(seeded());
            t.term.write(numbered(500, 3000));
            t.term.setSearchHighlight({ needle: 'MARKER' });
            expect(t.term.getSearchHighlights()).toEqual([]);

            // Scroll back to the seeded block, under 500 lines of later output: `row10 … row21`.
            scrollRowToTop(t.term, 'row10 ');
            expect(t.rowText(0)).toBe('row10 has a marker here');
            const spans = t.term.getSearchHighlights();
            expect(spans.map((span) => span.row)).toEqual([0, 10]);
            expect(t.rowText(10)).toBe('row20 has a Marker here');
            expect(t.cellsFilled(t.render(), THEME.searchBackground)).toHaveLength(12);
        } finally {
            t.dispose();
        }
    });

    it('paints the current match distinctly, on the row the daemon named', () => {
        const t = openTerminal(40, 12);
        try {
            t.term.write(seeded());
            t.term.setSearchHighlight({ needle: 'marker' });
            const [first, second] = t.term.getSearchHighlights();
            t.term.setSearchCurrent({ linesFromBottom: linesFromBottom(t.term, second!.row), col: 12, length: 6 });

            expect(t.term.getSearchHighlights()).toEqual([
                { ...first!, current: false },
                { ...second!, current: true }
            ]);
            const paints = t.render();
            expect(t.cellsFilled(paints, THEME.searchSelectedBackground)).toEqual(
                [12, 13, 14, 15, 16, 17].map((col) => `${String(second!.row)}:${String(col)}`)
            );
            expect(t.cellsFilled(paints, THEME.searchBackground)).toEqual(
                [12, 13, 14, 15, 16, 17].map((col) => `${String(first!.row)}:${String(col)}`)
            );
        } finally {
            t.dispose();
        }
    });

    it('follows the text through a scroll and through new output', () => {
        const t = openTerminal(40, 12);
        try {
            t.term.write(seeded());
            t.term.setSearchHighlight({ needle: 'marker' });
            const before = t.term.getSearchHighlights();
            t.term.setSearchCurrent({ linesFromBottom: linesFromBottom(t.term, before[1]!.row), col: 12, length: 6 });

            // Scrolled back three lines, every highlight moves down three rows with its text, and
            // the one pushed off the bottom is no longer painted.
            t.term.scrollToLine(3);
            expect(before.map((span) => span.row)).toEqual([0, 10]);
            expect(t.term.getSearchHighlights().map((span) => span.row)).toEqual([3]);
            t.term.scrollToLine(1);
            expect(t.term.getSearchHighlights().map((span) => span.row)).toEqual([1, 11]);
            t.term.scrollToBottom();

            // Four more lines of output push everything up four rows (row50 off the top); the
            // current match is pinned to its row of text, not to the bottom-relative number it
            // arrived as.
            t.term.write(numbered(4, 100));
            const after = t.term.getSearchHighlights();
            expect(after).toEqual([{ row: 6, startCol: 12, endCol: 17, current: true }]);
            expect(t.rowText(6)).toBe('row60 has a Marker here');

            // And a match the output brought with it is highlighted without anyone asking.
            t.term.write('a fresh marker\r\n');
            expect(t.term.getSearchHighlights()).toEqual([
                { row: 5, startCol: 12, endCol: 17, current: true },
                { row: 10, startCol: 8, endCol: 13, current: false }
            ]);
        } finally {
            t.dispose();
        }
    });

    it('clears every highlight when the bar closes, repainting the rows they were on', async () => {
        const t = openTerminal(40, 12);
        try {
            t.term.write(seeded());
            t.term.setSearchHighlight({ needle: 'marker' });
            await frame();
            const seen: TerminalSearchSpan[][] = [];
            t.term.onSearchHighlightChange((spans) => seen.push(spans));

            painted.length = 0;
            t.term.setSearchHighlight(null);
            await frame();
            // The engine's own incremental frame (not a forced one) repainted the two rows, in the
            // theme's colours, and announced that nothing is highlighted any more.
            expect(painted.some((paint) => paint.style === THEME.searchBackground)).toBe(false);
            const repaintedRows = new Set(
                painted.filter((paint) => paint.op === 'fillText').map((paint) => Math.round((paint.y - 1) / t.cell.height))
            );
            expect(repaintedRows.size).toBeGreaterThan(0);
            expect(seen.at(-1)).toEqual([]);
            expect(t.term.getSearchHighlights()).toEqual([]);
            expect(t.cellsFilled(t.render(), THEME.searchBackground)).toEqual([]);
        } finally {
            t.dispose();
        }
    });

    it('drops the current match with the needle it was counted for', () => {
        const t = openTerminal(40, 12);
        try {
            t.term.write(seeded());
            t.term.setSearchHighlight({ needle: 'marker' });
            const [, second] = t.term.getSearchHighlights();
            t.term.setSearchCurrent({ linesFromBottom: linesFromBottom(t.term, second!.row), col: 12, length: 6 });
            t.term.setSearchHighlight({ needle: 'marker', caseSensitive: true });
            // Only the lowercase row50 matches now, and nothing is current.
            expect(t.term.getSearchHighlights()).toEqual([
                { row: second!.row - 10, startCol: 12, endCol: 17, current: false }
            ]);
        } finally {
            t.dispose();
        }
    });

    it('joins a soft-wrapped line on screen, as the daemon does', () => {
        const t = openTerminal(20, 6);
        try {
            // 16 characters, then the needle across the wrap at column 20.
            t.term.write('0123456789abcdefWRAPNEEDLE tail\r\n');
            t.term.setSearchHighlight({ needle: 'wrapneedle' });
            expect(t.term.getSearchHighlights()).toEqual([
                { row: 0, startCol: 16, endCol: 19, current: false },
                { row: 1, startCol: 0, endCol: 5, current: false }
            ]);
        } finally {
            t.dispose();
        }
    });

    it('puts a match after a wide character on the cells that show it', () => {
        const t = openTerminal(40, 6);
        try {
            // Two CJK characters are four cells but two characters of the row's text.
            t.term.write('漢字 needle\r\n');
            t.term.setSearchHighlight({ needle: 'needle' });
            expect(t.term.getSearchHighlights()).toEqual([{ row: 0, startCol: 5, endCol: 10, current: false }]);
            // The daemon states the column as an offset into that text (3), and it is still the
            // same match.
            t.term.setSearchCurrent({ linesFromBottom: linesFromBottom(t.term, 0), col: 3, length: 6 });
            expect(t.term.getSearchHighlights()).toEqual([{ row: 0, startCol: 5, endCol: 10, current: true }]);
        } finally {
            t.dispose();
        }
    });

    it('draws a selection over a match as the selection, and leaves copy alone', () => {
        const t = openTerminal(40, 12);
        try {
            t.term.write(seeded());
            t.term.setSearchHighlight({ needle: 'marker' });
            const [first] = t.term.getSearchHighlights();
            t.term.select(10, first!.row, 4);
            expect(t.term.getSelection()).toBe('a ma');
            const paints = t.render();
            expect(t.cellsFilled(paints, THEME.selectionBackground)).toEqual(
                [10, 11, 12, 13].map((col) => `${String(first!.row)}:${String(col)}`)
            );
            // The rest of the match keeps its highlight.
            expect(t.cellsFilled(paints, THEME.searchBackground)).toEqual(
                expect.arrayContaining([14, 15, 16, 17].map((col) => `${String(first!.row)}:${String(col)}`))
            );
            expect(t.term.getSelection()).toBe('a ma');
        } finally {
            t.dispose();
        }
    });

    it('paints a current match that straddles a wrap in history, but never a stale one', () => {
        const t = openTerminal(20, 4);
        try {
            t.term.write('0123456789abcdefWRAPNEEDLE tail\r\n');
            t.term.write(numbered(6));
            // Both halves are history now, where the WASM cannot report the wrap.
            t.term.scrollToLine(t.term.wasmTerm!.getScrollbackLength());
            expect(t.rowText(0)).toBe('0123456789abcdefWRAP');
            t.term.setSearchHighlight({ needle: 'wrapneedle' });
            expect(t.term.getSearchHighlights()).toEqual([]);

            // The daemon joins them, so it can select it: the engine paints both halves current.
            t.term.setSearchCurrent({ linesFromBottom: linesFromBottom(t.term, 0), col: 16, length: 10 });
            expect(t.term.getSearchHighlights()).toEqual([
                { row: 0, startCol: 16, endCol: 19, current: true },
                { row: 1, startCol: 0, endCol: 5, current: true }
            ]);

            // A match stated where the needle is not (the buffer is not the one it was counted in)
            // is refused, and paints nothing.
            expect(t.term.setSearchCurrent({ linesFromBottom: linesFromBottom(t.term, 2), col: 0, length: 10 })).toBe(false);
            expect(t.term.getSearchHighlights()).toEqual([]);
        } finally {
            t.dispose();
        }
    });
});

describe('the current match across trimmed history (#306 review)', () => {
    /** 1,100 numbered rows, every 50th carrying the needle; 80x10 with the smallest history. */
    function trimmed() {
        const t = openTerminal(80, 10, 10);
        const rows = Array.from({ length: 1100 }, (_, i) => {
            const n = String(i + 1).padStart(4, '0');
            return (i + 1) % 50 === 0 ? `row${n} has a marker here` : `row${n}`;
        });
        t.term.write(rows.join('\r\n') + '\r\n');
        t.term.setSearchHighlight({ needle: 'marker' });
        return t;
    }

    it('follows its row when the cap drops a page of history under it', () => {
        const t = trimmed();
        try {
            scrollRowToTop(t.term, 'row1000 ');
            expect(t.term.setSearchCurrent({ linesFromBottom: linesFromBottom(t.term, 0), col: 14, length: 6 })).toBe(true);
            expect(t.term.getSearchHighlights().filter((span) => span.current)).toEqual([
                { row: 0, startCol: 14, endCol: 19, current: true }
            ]);

            // Enough output to make the native engine discard its oldest page: every retained row's
            // absolute index drops, and nothing in the WASM says by how much.
            const before = t.term.wasmTerm!.getScrollbackLength();
            t.term.write(Array.from({ length: 100 }, (_, i) => `later${String(i)}`).join('\r\n') + '\r\n');
            expect(t.term.wasmTerm!.getScrollbackLength()).toBeLessThan(before);

            // Wherever the viewport now is, the current match is still `row1000`'s marker, and only it.
            scrollRowToTop(t.term, 'row1000 ');
            const current = t.term.getSearchHighlights().filter((span) => span.current);
            expect(current).toEqual([{ row: 0, startCol: 14, endCol: 19, current: true }]);
            expect(t.rowText(0)).toBe('row1000 has a marker here');
            scrollRowToTop(t.term, 'row0950 ');
            expect(t.term.getSearchHighlights().filter((span) => span.current)).toEqual([]);
        } finally {
            t.dispose();
        }
    });

    it('ends when its row is trimmed away, rather than marking another match', () => {
        const t = trimmed();
        try {
            // `row0550` is near the oldest page, which the next trim discards.
            scrollRowToTop(t.term, 'row0550 ');
            expect(t.term.setSearchCurrent({ linesFromBottom: linesFromBottom(t.term, 0), col: 14, length: 6 })).toBe(true);
            t.term.write(Array.from({ length: 100 }, (_, i) => `later${String(i)}`).join('\r\n') + '\r\n');
            expect(() => scrollRowToTop(t.term, 'row0550 ')).toThrow();
            // Every marker still in history is an ordinary match; none is current.
            for (const prefix of ['row0700 ', 'row1000 ']) {
                scrollRowToTop(t.term, prefix);
                const spans = t.term.getSearchHighlights();
                expect(spans.length).toBeGreaterThan(0);
                expect(spans.some((span) => span.current)).toBe(false);
            }
        } finally {
            t.dispose();
        }
    });
});

describe('case folding that keeps every offset (#306 review)', () => {
    it('paints a match after a character that lowercases longer on its own cells', () => {
        const t = openTerminal(40, 6);
        try {
            // U+0130 lowercases to TWO units: a plain toLowerCase put `x` at offset 2, past its cell.
            t.term.write('\u0130x marker\r\n');
            t.term.setSearchHighlight({ needle: 'X' });
            expect(t.term.getSearchHighlights()).toEqual([{ row: 0, startCol: 1, endCol: 1, current: false }]);
            t.term.setSearchHighlight({ needle: 'MARKER' });
            expect(t.term.getSearchHighlights()).toEqual([{ row: 0, startCol: 3, endCol: 8, current: false }]);
            // …and the daemon's offset for it (3, folded the same way) pins the same match.
            expect(t.term.setSearchCurrent({ linesFromBottom: linesFromBottom(t.term, 0), col: 3, length: 6 })).toBe(true);
            expect(t.term.getSearchHighlights()).toEqual([{ row: 0, startCol: 3, endCol: 8, current: true }]);
        } finally {
            t.dispose();
        }
    });
});

describe('the change announcement (#306 review)', () => {
    it('fires when the matches change even though the painted cells do not', async () => {
        const t = openTerminal(20, 4);
        try {
            t.term.write('aa\r\n');
            const seen: TerminalSearchSpan[][] = [];
            t.term.onSearchHighlightChange((spans) => seen.push(spans));
            t.term.setSearchHighlight({ needle: 'a' });
            await frame();
            expect(seen.at(-1)).toHaveLength(2);
            // `aa` paints exactly the cells `a` did, as one match instead of two.
            t.term.setSearchHighlight({ needle: 'aa' });
            await frame();
            expect(seen.at(-1)).toEqual([{ row: 0, startCol: 0, endCol: 1, current: false }]);
        } finally {
            t.dispose();
        }
    });
});

// ── 3. parity with the daemon ─────────────────────────────────────────────────────────

describe('the engine paints what the daemon counts (#306)', () => {
    it('shows every daemon match as the current one when handed its coordinates', async () => {
        const cols = 30;
        const rows = 10;
        const bytes =
            numbered(40) +
            'alpha NEEDLE beta needle\r\n' +
            // A needle across a soft wrap, still on screen at the end.
            '0123456789012345678901234Needle tail\r\n' +
            '漢字 needle after wide\r\n' +
            numbered(3, 900) +
            'neeneedle\r\n' +
            // A character that lowercases longer, ahead of the needle: offsets must still agree.
            '\u0130 needle\r\n';
        const pane = 'pane-306';
        // Imported here, behind the stub canvas: `@xterm/addon-serialize` asks jsdom for a 2D
        // context when its module loads, and jsdom prints a "Not implemented" error for it.
        const { createTerminalStateService } = await import('@kelpi/daemon/term');
        const daemon = createTerminalStateService();
        daemon.attach(pane, cols, rows);
        daemon.feed(pane, new TextEncoder().encode(bytes));
        const matches = await daemon.searchAsync(pane, 'needle');
        daemon.dispose(pane);
        // Two on one line, one across a soft wrap, one after a wide character, one inside a word,
        // one after a character that lowercases longer.
        expect(matches.length).toBe(6);

        const t = openTerminal(cols, rows);
        try {
            t.term.write(bytes);
            t.term.setSearchHighlight({ needle: 'needle' });
            for (const match of matches) {
                // What the adapter's `revealMatch` does: centre it.
                const scrollback = t.term.wasmTerm!.getScrollbackLength();
                t.term.scrollToLine(Math.max(0, Math.min(scrollback, match.linesFromBottom - Math.floor(rows / 2))));
                expect(t.term.setSearchCurrent({ linesFromBottom: match.linesFromBottom, col: match.col, length: match.length })).toBe(true);
                const current = t.term.getSearchHighlights().filter((span) => span.current);
                expect(current.length, `match at line ${String(match.line)} col ${String(match.col)}`).toBeGreaterThan(0);
                const text = current
                    .map((span) => {
                        const scrollbackNow = t.term.wasmTerm!.getScrollbackLength();
                        const absolute = scrollbackNow - Math.floor(t.term.viewportY) + span.row;
                        const cells =
                            absolute < scrollbackNow
                                ? t.term.wasmTerm!.getScrollbackLine(absolute)
                                : t.term.wasmTerm!.getLine(absolute - scrollbackNow);
                        return (cells ?? [])
                            .slice(span.startCol, span.endCol + 1)
                            .filter((c) => c.width !== 0)
                            .map((c) => String.fromCodePoint(c.codepoint || 32))
                            .join('');
                    })
                    .join('');
                expect(text.toLowerCase()).toBe('needle');
            }
        } finally {
            t.dispose();
        }
    });
});

// ── the adapter over the real engine ──────────────────────────────────────────────────

describe('the renderer seam over the real engine (#306)', () => {
    it('reveals by scrolling, highlights through the layer, and never touches the selection', async () => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const renderer = createTerminalRenderer({ cols: 40, rows: 12 });
        const seen: (readonly TerminalSearchSpan[])[] = [];
        renderer.onSearchHighlightChange((spans) => seen.push(spans));
        // Set before the engine is up: the adapter holds it across the load.
        renderer.setSearchHighlight({ needle: 'marker', caseSensitive: false, current: null });
        try {
            await renderer.open(host);
            renderer.write(numbered(200));
            renderer.write(seeded());
            renderer.write(numbered(200, 1000));
            await frame();
            // At the bottom, nothing seeded is on screen.
            expect(seen.at(-1) ?? []).toEqual([]);

            // `row30 has a marker here` is line 229 of 461 (the last is the blank cursor row), so
            // the daemon states it 232 lines from the bottom.
            const match = { linesFromBottom: 232, col: 12, length: 6 };
            renderer.revealMatch(match);
            renderer.setSearchHighlight({ needle: 'marker', caseSensitive: false, current: { ...match, seq: 1 } });
            await frame();
            // Centred: six rows above it on screen. row20 and row40 are ten lines either side,
            // off this 12-row screen, so it is the only highlight.
            expect(renderer.scrollOffset()).toBe(232 - 6);
            expect(seen.at(-1)).toEqual([{ row: 6, startCol: 12, endCol: 17, current: true }]);
            // Not a selection: copy and the user's own selection are untouched.
            expect(renderer.selection()).toBe('');

            // The same reply handed over again after output does NOT re-pin it: it stays on its text.
            renderer.write('later output\r\n');
            renderer.setSearchHighlight({ needle: 'marker', caseSensitive: false, current: { ...match, seq: 1 } });
            await frame();
            expect((seen.at(-1) ?? []).find((span) => span.current)?.row).toBe(6);

            renderer.setSearchHighlight(null);
            await frame();
            expect(seen.at(-1)).toEqual([]);
        } finally {
            renderer.dispose();
            host.remove();
        }
    });
});
