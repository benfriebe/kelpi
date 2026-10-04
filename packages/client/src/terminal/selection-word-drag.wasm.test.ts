import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ghostty, SelectionManager, Terminal, type CanvasRenderer } from 'ghostty-web';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// A double-click held and dragged, on the installed bundle, its real WASM and the engine's own
// mouse listeners. Before `0.4.0-kelpi.19` the word was selected only on `dblclick`, which fires
// on the release, so the drag ran by cells from the pressed cell: from the middle of "quick",
// "ick brown fox". Only canvas metrics and the clipboard sink are doubles.
let ghostty: Ghostty;
beforeAll(async () => {
    const module = await WebAssembly.compile(new Uint8Array(fs.readFileSync(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../vendor/ghostty-web-patched/ghostty-vt.wasm')
    )));
    ghostty = new Ghostty(await WebAssembly.instantiate(module, { env: { log() {} } }), module);
});
afterEach(() => { vi.unstubAllGlobals(); });

/** Cells are 10 x 20 px; jsdom reports `offsetX`/`offsetY` as the client point. */
const at = (col: number, row: number) => ({ clientX: col * 10 + 5, clientY: row * 20 + 10 });

function fixture(cols = 40, scrollbackLimit = 10_000) {
    const term = new Terminal({ ghostty, cols, rows: 10 });
    const vt = ghostty.createTerminal(cols, 10, { scrollbackLimit });
    const canvas = document.createElement('canvas');
    // Exactly the terminal's 10 rows, as in the app. A taller canvas hid the old auto-scroll band:
    // no row used here was within 30 px of its edges.
    Object.defineProperty(canvas, 'clientHeight', { value: 200 });
    canvas.getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 200, right: cols * 10, width: cols * 10, height: 200, x: 0, y: 0, toJSON() {} });
    // Attached, so a release on the canvas bubbles to the manager's document listener.
    document.body.appendChild(canvas);
    const textarea = document.createElement('textarea');
    const renderer = {
        getCanvas: () => canvas,
        getMetrics: () => ({ width: 10, height: 20 })
    } as unknown as CanvasRenderer;
    const selection = new SelectionManager(term, renderer, vt, textarea);
    Object.assign(term, { isOpen: true, wasmTerm: vt, selectionManager: selection });
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    const fire = (type: string, point: { clientX: number; clientY: number }, init: MouseEventInit = {}) =>
        canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...point, ...init }));
    /** The first click of a double-click, then the second press, held. */
    const doublePress = (col: number, row: number) => {
        fire('mousedown', at(col, row), { detail: 1, buttons: 1 });
        fire('mouseup', at(col, row), { detail: 1 });
        fire('click', at(col, row), { detail: 1 });
        fire('mousedown', at(col, row), { detail: 2, buttons: 1 });
    };
    const drag = (col: number, row: number) => fire('mousemove', at(col, row), { buttons: 1 });
    /** The release on the canvas, and the `click` and `dblclick` the browser raises after it. */
    const releaseDouble = (col: number, row: number) => {
        fire('mouseup', at(col, row), { detail: 2 });
        fire('click', at(col, row), { detail: 2 });
        fire('dblclick', at(col, row), { detail: 2 });
    };
    /** A whole double-click, then the third press, held. Chromium raises no `dblclick` after it. */
    const triplePress = (col: number, row: number) => {
        doublePress(col, row);
        releaseDouble(col, row);
        fire('mousedown', at(col, row), { detail: 3, buttons: 1 });
    };
    const release = (col: number, row: number, detail: number) => {
        fire('mouseup', at(col, row), { detail });
        fire('click', at(col, row), { detail });
    };
    const dispose = () => { selection.dispose(); vt.free(); canvas.remove(); };
    return { term, vt, selection, canvas, writeText, fire, doublePress, drag, releaseDouble, triplePress, release, dispose };
}

// Rows 2 and 3:  the quick brown fox      (quick = cols 4-8, brown = 10-14, fox = 16-18)
//                jumps over the lazy dog  (jumps = 0-4, over = 6-9, lazy = 15-18)
const TEXT = '\r\n\r\nthe quick brown fox\r\njumps over the lazy dog';

describe('double-click and drag selects whole words (vendor 0.4.0-kelpi.19)', () => {
    it('selects the word on the second press, before any release', () => {
        const f = fixture();
        try {
            f.term.write(TEXT);
            f.doublePress(6, 2);
            expect(f.term.getSelection()).toBe('quick');
        } finally { f.dispose(); }
    });

    it('extends forward from the START of the pressed word, not from the pressed cell', () => {
        const f = fixture();
        try {
            f.term.write(TEXT);
            f.doublePress(6, 2); // the "i" of "quick"
            f.drag(12, 2); // mid "brown"
            expect(f.term.getSelection()).toBe('quick brown');
            f.drag(17, 2); // mid "fox"
            expect(f.term.getSelection()).toBe('quick brown fox');
            // The dblclick after the release must not re-select the word under the release point.
            f.releaseDouble(17, 2);
            expect(f.term.getSelection()).toBe('quick brown fox');
            expect(f.writeText).toHaveBeenLastCalledWith('quick brown fox');
        } finally { f.dispose(); }
    });

    it('extends backward from the END of the pressed word', () => {
        const f = fixture();
        try {
            f.term.write(TEXT);
            f.doublePress(12, 2); // mid "brown"
            f.drag(5, 2); // mid "quick"
            expect(f.term.getSelection()).toBe('quick brown');
            f.drag(1, 2); // mid "the"
            expect(f.term.getSelection()).toBe('the quick brown');
            f.releaseDouble(1, 2);
            expect(f.term.getSelection()).toBe('the quick brown');
        } finally { f.dispose(); }
    });

    it('shrinks back to the pressed word, and runs by words across rows', () => {
        const f = fixture();
        try {
            f.term.write(TEXT);
            f.doublePress(6, 2);
            f.drag(17, 2);
            f.drag(5, 2); // back inside "quick"
            expect(f.term.getSelection()).toBe('quick');
            f.drag(7, 3); // mid "over", the next row
            expect(f.term.getSelection()).toBe('quick brown fox\njumps over');
            f.drag(2, 1); // a blank row above: the selection flips to end at "quick"'s end
            expect(f.term.getSelection()).toBe('\nthe quick');
            f.releaseDouble(2, 1);
        } finally { f.dispose(); }
    });

    it('leaves a single-click drag running by cells', () => {
        const f = fixture();
        try {
            f.term.write(TEXT);
            f.fire('mousedown', at(6, 2), { detail: 1, buttons: 1 });
            f.drag(17, 2);
            f.fire('mouseup', at(17, 2), { detail: 1 });
            expect(f.term.getSelection()).toBe('ick brown fo');
        } finally { f.dispose(); }
    });

    it('still selects on a dblclick no press handled (the long press), even after a double-click released off the canvas', () => {
        const f = fixture();
        try {
            f.term.write(TEXT);
            f.fire('dblclick', at(11, 3), { detail: 2 });
            expect(f.term.getSelection()).toBe('the');

            // A double-click whose release lands outside the canvas raises no dblclick on it.
            f.doublePress(6, 2);
            f.drag(17, 2);
            document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, detail: 2 }));
            expect(f.term.getSelection()).toBe('quick brown fox');
            f.fire('dblclick', at(16, 3), { detail: 2 });
            expect(f.term.getSelection()).toBe('lazy');
        } finally { f.dispose(); }
    });

    it('measures the word on the row on screen when the view is scrolled back, and drags into the live screen', () => {
        const f = fixture();
        try {
            // Every line's first word has its own length, so a word measured on the wrong row
            // selects the wrong number of cells.
            for (let n = 0; n < 30; n++) f.term.write(`${'a'.repeat(n + 1)} end\r\n`);
            expect(f.vt.getScrollbackLength()).toBe(21); // lines 0-20; the screen shows 21-29
            f.term.viewportY = 5; // viewport row 3 is line 19
            f.doublePress(2, 3);
            expect(f.term.getSelection()).toBe('a'.repeat(20));
            f.drag(2, 5); // line 21, the first row of the live screen
            expect(f.term.getSelection()).toBe(`${'a'.repeat(20)} end\n${'a'.repeat(21)} end\n${'a'.repeat(22)}`);
            f.releaseDouble(2, 5);
            expect(f.term.getSelection()).toBe(`${'a'.repeat(20)} end\n${'a'.repeat(21)} end\n${'a'.repeat(22)}`);
        } finally { f.dispose(); }
    });

    // Upstream auto-scrolled inside a 30 px band at the canvas's top and bottom edges, and every
    // 50 ms pulled the selection's end to the top-left (bottom-right) cell. Over a row inside the
    // band that flipped the selection onto the row above (below), back on the next move, and kept
    // it there while the pointer held still. The app's prompt sat on exactly such rows.
    it.each([
        ['the second row, inside the old top band', '\x1b[1;1Hprompt line\r\nthe quick brown fox', 1, 25],
        ['the second-to-last row, inside the old bottom band', '\x1b[9;1Hthe quick brown fox\r\nprompt line', 8, 175]
    ])('holds a drag along %s where the pointer is, with no scroll', async (_, text, row, y) => {
        const f = fixture();
        try {
            f.term.write(text);
            const point = (col: number) => ({ clientX: col * 10 + 5, clientY: y });
            f.fire('mousedown', point(6), { detail: 1, buttons: 1 });
            f.fire('mouseup', point(6), { detail: 1 });
            f.fire('mousedown', point(6), { detail: 2, buttons: 1 });
            f.fire('mousemove', point(17), { buttons: 1 });
            expect(f.term.getSelection()).toBe('quick brown fox');
            await new Promise((resolve) => setTimeout(resolve, 150)); // three auto-scroll ticks
            expect(f.term.getSelection()).toBe('quick brown fox');
            expect(f.selection.getSelectionCoords()).toEqual({ startCol: 4, startRow: row, endCol: 18, endRow: row });
            f.releaseDouble(17, row);
        } finally { f.dispose(); }
    });

    it('keeps the pressed word anchored to its text when output trims history mid-drag', () => {
        // The #170 fixture's geometry: 80 columns and a 10-byte limit trim a page per few hundred rows.
        const f = fixture(80, 10);
        try {
            const line = (n: number) => `conversation-${String(n).padStart(5, '0')}`;
            let next = 0;
            const writeLines = (count: number) => {
                for (let i = 0; i < count; i++) f.term.write(`${line(next++)}\r\n`);
            };
            writeLines(1100);
            f.term.viewportY = 100;
            f.doublePress(1, 2);
            const pressed = f.term.getSelection();
            expect(pressed).toMatch(/^conversation-\d{5}$/);
            const first = Number(pressed.slice(-5));
            f.drag(1, 3);
            expect(f.term.getSelection()).toBe(`${line(first)}\n${line(first + 1)}`);

            const before = f.vt.getScrollbackLength();
            writeLines(100);
            expect(f.vt.getScrollbackLength()).toBeLessThan(before); // a real page was trimmed
            expect(f.term.getSelection()).toBe(`${line(first)}\n${line(first + 1)}`);

            // The next move recomputes the start from the anchor, which must have moved with it.
            const coords = f.selection.getSelectionCoords();
            expect(coords).not.toBeNull();
            f.drag(1, coords!.endRow + 1);
            expect(f.term.getSelection()).toBe(`${line(first)}\n${line(first + 1)}\n${line(first + 2)}`);
            f.releaseDouble(1, coords!.endRow + 1);
        } finally { f.dispose(); }
    });
});

describe('triple-click selects a whole line, and a drag from it whole lines (vendor 0.4.0-kelpi.19)', () => {
    it('selects the line on the third press, and a fourth click keeps it', () => {
        const f = fixture();
        try {
            f.term.write(TEXT);
            f.triplePress(6, 2);
            expect(f.term.getSelection()).toBe('the quick brown fox');
            expect(f.selection.getSelectionCoords()).toEqual({ startCol: 0, startRow: 2, endCol: 39, endRow: 2 });
            f.release(6, 2, 3);
            expect(f.writeText).toHaveBeenLastCalledWith('the quick brown fox');
            // macOS keeps counting: a fourth click is still a line, and raises no dblclick either.
            f.fire('mousedown', at(6, 2), { detail: 4, buttons: 1 });
            f.release(6, 2, 4);
            expect(f.term.getSelection()).toBe('the quick brown fox');
        } finally { f.dispose(); }
    });

    it('extends by whole lines forward and backward from the pressed line', () => {
        const f = fixture();
        try {
            f.term.write(TEXT);
            f.triplePress(6, 2);
            f.drag(2, 3); // anywhere on the next line takes all of it
            expect(f.term.getSelection()).toBe('the quick brown fox\njumps over the lazy dog');
            f.drag(30, 2); // back on the pressed line, past its text
            expect(f.term.getSelection()).toBe('the quick brown fox');
            f.drag(30, 1); // the blank line above: from its start to the pressed line's end
            expect(f.term.getSelection()).toBe('\nthe quick brown fox');
            expect(f.selection.getSelectionCoords()).toEqual({ startCol: 0, startRow: 1, endCol: 39, endRow: 2 });
            f.release(30, 1, 3);
            expect(f.term.getSelection()).toBe('\nthe quick brown fox');
        } finally { f.dispose(); }
    });

    it('takes every row of a soft-wrapped line, from whichever row is pressed', () => {
        const f = fixture();
        try {
            // 60 characters in 40 columns: one line the terminal wrapped onto rows 1 and 2.
            const long = 'git log --oneline --decorate --graph --all --since=yesterday';
            expect(long).toHaveLength(60);
            f.term.write(`$ short\r\n${long}\r\n$ after`);
            for (const row of [1, 2]) {
                f.triplePress(3, row);
                expect(f.term.getSelection()).toBe(long);
                expect(f.selection.getSelectionCoords()).toEqual({ startCol: 0, startRow: 1, endCol: 39, endRow: 2 });
                f.release(3, row, 3);
            }
            // A drag from the wrapped line onto the next one keeps the whole of it.
            f.triplePress(3, 2);
            f.drag(1, 3);
            expect(f.term.getSelection()).toBe(`${long}\n$ after`);
            f.drag(1, 0); // and backward, the wrapped line's own end is the far side
            expect(f.term.getSelection()).toBe(`$ short\n${long}`);
            f.release(1, 0, 3);
        } finally { f.dispose(); }
    });
});
