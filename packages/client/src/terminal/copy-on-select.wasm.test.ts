import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ghostty, SelectionManager, Terminal, type CanvasRenderer } from 'ghostty-web';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// `copy-on-select`, on the installed bundle, its real WASM and the engine's own mouse listeners.
// Before `0.4.0-kelpi.21` every selection went to the clipboard on release, whatever the user
// wanted. Only canvas metrics and the clipboard sink are doubles.
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

function fixture(options: { copyOnSelect?: boolean } = {}) {
    const cols = 40;
    const term = new Terminal({ ghostty, cols, rows: 10, ...options });
    const vt = ghostty.createTerminal(cols, 10, { scrollbackLimit: 10_000 });
    const canvas = document.createElement('canvas');
    Object.defineProperty(canvas, 'clientHeight', { value: 200 });
    canvas.getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 200, right: cols * 10, width: cols * 10, height: 200, x: 0, y: 0, toJSON() {} });
    // Attached, so a release on the canvas bubbles to the manager's document listener.
    document.body.appendChild(canvas);
    const renderer = {
        getCanvas: () => canvas,
        getMetrics: () => ({ width: 10, height: 20 })
    } as unknown as CanvasRenderer;
    const selection = new SelectionManager(term, renderer, vt, document.createElement('textarea'));
    Object.assign(term, { isOpen: true, wasmTerm: vt, selectionManager: selection });
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const changes = vi.fn();
    const offChange = selection.onSelectionChange(changes);

    const fire = (type: string, point: { clientX: number; clientY: number }, init: MouseEventInit = {}) =>
        canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...point, ...init }));
    /**
     * A single-click drag across the cells from one to another (from the start of the first to the
     * end of the last, so both are crossed), released on the canvas.
     */
    const dragSelect = (from: [number, number], to: [number, number]) => {
        const start = { clientX: from[0] * 10 + 1, clientY: at(...from).clientY };
        const end = { clientX: to[0] * 10 + 9, clientY: at(...to).clientY };
        fire('mousedown', start, { detail: 1, buttons: 1 });
        fire('mousemove', end, { buttons: 1 });
        fire('mouseup', end, { detail: 1 });
    };
    /** A whole double-click, the browser's `dblclick` included. */
    const doubleClick = (col: number, row: number) => {
        fire('mousedown', at(col, row), { detail: 1, buttons: 1 });
        fire('mouseup', at(col, row), { detail: 1 });
        fire('mousedown', at(col, row), { detail: 2, buttons: 1 });
        fire('mouseup', at(col, row), { detail: 2 });
        fire('dblclick', at(col, row), { detail: 2 });
    };
    const dispose = () => { offChange.dispose(); selection.dispose(); vt.free(); canvas.remove(); };
    return { term, writeText, changes, fire, dragSelect, doubleClick, dispose };
}

// Row 2:  the quick brown fox  (quick = cols 4-8, brown = 10-14)
const TEXT = '\r\n\r\nthe quick brown fox';

describe('copy-on-select (vendor 0.4.0-kelpi.21)', () => {
    it('copies a drag on release by default, as it always has', () => {
        const f = fixture();
        try {
            f.term.write(TEXT);
            expect(f.term.options.copyOnSelect).toBe(true);
            f.dragSelect([4, 2], [14, 2]);
            expect(f.writeText).toHaveBeenCalledWith('quick brown');
        } finally { f.dispose(); }
    });

    it('off, makes and announces the selection but leaves the clipboard alone', () => {
        const f = fixture({ copyOnSelect: false });
        try {
            f.term.write(TEXT);
            f.dragSelect([4, 2], [14, 2]);
            expect(f.term.getSelection()).toBe('quick brown');
            // Announced, so the pane's own copy (⌘C) still has something to read.
            expect(f.changes).toHaveBeenCalled();
            f.doubleClick(12, 2);
            expect(f.term.getSelection()).toBe('brown');
            expect(f.writeText).not.toHaveBeenCalled();
        } finally { f.dispose(); }
    });

    it('off, also leaves a long press (a bare `dblclick`) off the clipboard', () => {
        const f = fixture({ copyOnSelect: false });
        try {
            f.term.write(TEXT);
            f.fire('dblclick', at(6, 2), { detail: 2 });
            expect(f.term.getSelection()).toBe('quick');
            expect(f.writeText).not.toHaveBeenCalled();
        } finally { f.dispose(); }
    });

    it('follows a change made at runtime, on the very next selection', () => {
        const f = fixture();
        try {
            f.term.write(TEXT);
            f.term.options.copyOnSelect = false;
            f.dragSelect([4, 2], [8, 2]);
            expect(f.term.getSelection()).toBe('quick');
            expect(f.writeText).not.toHaveBeenCalled();
            f.term.options.copyOnSelect = true;
            f.dragSelect([10, 2], [14, 2]);
            expect(f.writeText).toHaveBeenCalledTimes(1);
            expect(f.writeText).toHaveBeenCalledWith('brown');
        } finally { f.dispose(); }
    });
});

// A click (to focus a pane, say) used to select the pressed cell and copy it on release, so
// switching panes replaced the clipboard with one character, and a press that wobbled over a cell
// boundary with two. A cell was then selected only once a drag crossed 60% of it, as in Ghostty;
// since `-kelpi.23` a drag selects once it leaves a dead zone around the press (below).
describe('a click selects nothing (vendor 0.4.0-kelpi.22)', () => {
    /** A point `x` pixels into a cell. */
    const px = (col: number, x: number, row: number) => ({ clientX: col * 10 + x, clientY: row * 20 + 10 });

    it('a click on a character leaves the clipboard and the selection alone', () => {
        const f = fixture();
        try {
            f.term.write(TEXT);
            f.fire('mousedown', at(6, 2), { detail: 1, buttons: 1 });
            f.fire('mouseup', at(6, 2), { detail: 1 });
            expect(f.term.getSelection()).toBe('');
            expect(f.term.hasSelection()).toBe(false);
            expect(f.writeText).not.toHaveBeenCalled();
        } finally { f.dispose(); }
    });

    it('a press that wobbles across a cell boundary selects nothing', () => {
        const f = fixture();
        try {
            f.term.write(TEXT);
            f.fire('mousedown', px(6, 9, 2), { detail: 1, buttons: 1 });
            f.fire('mousemove', px(7, 1, 2), { buttons: 1 });
            f.fire('mouseup', px(7, 1, 2), { detail: 1 });
            expect(f.term.getSelection()).toBe('');
            expect(f.writeText).not.toHaveBeenCalled();
        } finally { f.dispose(); }
    });

    it('a drag across one character selects, shows and copies just it', () => {
        const f = fixture();
        try {
            f.term.write(TEXT);
            f.fire('mousedown', px(6, 1, 2), { detail: 1, buttons: 1 });
            f.fire('mousemove', px(6, 8, 2), { buttons: 1 });
            f.fire('mouseup', px(6, 8, 2), { detail: 1 });
            expect(f.term.getSelection()).toBe('i');
            expect(f.term.hasSelection()).toBe(true);
            expect(f.writeText).toHaveBeenCalledWith('i');
        } finally { f.dispose(); }
    });

    it('a late press and an early release still take both end cells', () => {
        const f = fixture();
        try {
            f.term.write(TEXT);
            // Was 'uic' under Ghostty's 60% threshold rule; #404 includes both end cells again.
            f.fire('mousedown', px(4, 8, 2), { detail: 1, buttons: 1 });
            f.fire('mousemove', px(8, 2, 2), { buttons: 1 });
            f.fire('mouseup', px(8, 2, 2), { detail: 1 });
            expect(f.writeText).toHaveBeenLastCalledWith('quick');
            // Backwards, from late in `k` to early in `q`: both again.
            f.fire('mousedown', px(8, 8, 2), { detail: 1, buttons: 1 });
            f.fire('mousemove', px(4, 2, 2), { buttons: 1 });
            f.fire('mouseup', px(4, 2, 2), { detail: 1 });
            expect(f.writeText).toHaveBeenLastCalledWith('quick');
        } finally { f.dispose(); }
    });

    it('a drag to another row starts at the press', () => {
        const f = fixture();
        try {
            f.term.write('\r\n\r\nthe quick brown fox\r\njumps over');
            f.dragSelect([16, 2], [4, 3]);
            expect(f.writeText).toHaveBeenCalledWith('fox\njumps');
        } finally { f.dispose(); }
    });
});

// #404: `-kelpi.22`'s threshold rule took the cell a drag ended in only once the pointer was 60% of
// the way across it, so a drag released in the middle of the last character (where people stop)
// copied one character short: `conversation-00667` as `conversation-0066`. A drag now selects the
// pressed cell to the cell under the pointer, both included, once the pointer has left a dead zone
// of 60% of a cell width (6 px here) around the press point.
describe('a drag includes the cell under the pointer (vendor 0.4.0-kelpi.23)', () => {
    /** A canvas point `x` px into a cell's column and `y` px into its row. */
    const point = (col: number, x: number, row: number, y = 10) => ({ clientX: col * 10 + x, clientY: row * 20 + y });
    /** Press at one point, move to the next ones, release at the last. */
    type Point = { clientX: number; clientY: number };
    const gesture = (f: ReturnType<typeof fixture>, press: Point, ...moves: Point[]) => {
        f.fire('mousedown', press, { detail: 1, buttons: 1 });
        for (const p of moves) f.fire('mousemove', p, { buttons: 1 });
        f.fire('mouseup', moves.at(-1) ?? press, { detail: 1 });
    };
    // Row 2: WSTART (cols 0-5), eight 漢 (cols 6-21, two cells each: first halves on even
    // columns), WEND (cols 22-25).
    const WIDE = `\r\n\r\nWSTART${'漢'.repeat(8)}WEND`;

    it('a forward drag ending in the middle of a cell includes it', () => {
        const f = fixture();
        try {
            f.term.write('\r\n\r\nconversation-00667');
            gesture(f, at(0, 2), at(17, 2));
            expect(f.writeText).toHaveBeenLastCalledWith('conversation-00667');
            gesture(f, at(4, 2), at(8, 2));
            expect(f.writeText).toHaveBeenLastCalledWith('ersat');
        } finally { f.dispose(); }
    });

    it('a backward drag runs from the cell under the pointer to the pressed cell, both included', () => {
        const f = fixture();
        try {
            f.term.write(TEXT);
            gesture(f, at(8, 2), at(4, 2));
            expect(f.term.getSelection()).toBe('quick');
            expect(f.writeText).toHaveBeenLastCalledWith('quick');
            gesture(f, at(14, 2), at(10, 2));
            expect(f.writeText).toHaveBeenLastCalledWith('brown');
        } finally { f.dispose(); }
    });

    it('a drag across wide glyphs copies every glyph, with no spaces, both ways', () => {
        const f = fixture();
        try {
            f.term.write(WIDE);
            const all = `WSTART${'漢'.repeat(8)}WEND`;
            expect([...all]).toHaveLength(18);
            gesture(f, at(0, 2), at(25, 2));
            expect(f.writeText).toHaveBeenLastCalledWith(all);
            gesture(f, at(25, 2), at(0, 2));
            expect(f.writeText).toHaveBeenLastCalledWith(all);
        } finally { f.dispose(); }
    });

    it('a drag ending on either half of a wide glyph includes the glyph', () => {
        const f = fixture();
        try {
            f.term.write(WIDE);
            // Forwards to the third 漢, on its first half (col 10) and on its second (col 11).
            gesture(f, at(0, 2), at(10, 2));
            expect(f.writeText).toHaveBeenLastCalledWith('WSTART漢漢漢');
            gesture(f, at(0, 2), at(11, 2));
            expect(f.writeText).toHaveBeenLastCalledWith('WSTART漢漢漢');
            // Backwards to the same glyph: the selection starts on it, on either half.
            gesture(f, at(25, 2), at(10, 2));
            expect(f.writeText).toHaveBeenLastCalledWith('漢漢漢漢漢漢WEND');
            gesture(f, at(25, 2), at(11, 2));
            expect(f.writeText).toHaveBeenLastCalledWith('漢漢漢漢漢漢WEND');
            // And a forward drag pressed on a glyph's second half starts with that glyph.
            gesture(f, at(7, 2), at(25, 2));
            expect(f.writeText).toHaveBeenLastCalledWith(`${'漢'.repeat(8)}WEND`);
        } finally { f.dispose(); }
    });

    it('a press and release with no move selects and copies nothing', () => {
        const f = fixture();
        try {
            f.term.write(TEXT);
            gesture(f, at(6, 2), at(6, 2));
            expect(f.term.getSelection()).toBe('');
            expect(f.term.hasSelection()).toBe(false);
            expect(f.writeText).not.toHaveBeenCalled();
        } finally { f.dispose(); }
    });

    it('a press that drifts a few px over a cell or a row boundary selects nothing', () => {
        const f = fixture();
        try {
            f.term.write('\r\n\r\nthe quick brown fox\r\njumps over');
            // 2 px over a column boundary, then 4 px down over a row boundary (from row 2 into 3).
            gesture(f, point(6, 9, 2), point(7, 1, 2));
            gesture(f, point(6, 5, 2, 18), point(6, 5, 3, 2));
            expect(f.term.getSelection()).toBe('');
            expect(f.term.hasSelection()).toBe(false);
            expect(f.writeText).not.toHaveBeenCalled();
        } finally { f.dispose(); }
    });

    it('selects nothing inside the dead zone, statelessly, and one character just outside it', () => {
        const f = fixture();
        try {
            f.term.write(TEXT);
            f.fire('mousedown', point(6, 1, 2), { detail: 1, buttons: 1 });
            f.fire('mousemove', point(6, 6, 2), { buttons: 1 }); // 5 px: inside
            expect(f.term.hasSelection()).toBe(false);
            f.fire('mousemove', point(6, 8, 2), { buttons: 1 }); // 7 px: out, one character
            expect(f.term.getSelection()).toBe('i');
            expect(f.term.hasSelection()).toBe(true);
            f.fire('mousemove', point(6, 3, 2), { buttons: 1 }); // back inside: nothing again
            expect(f.term.hasSelection()).toBe(false);
            f.fire('mouseup', point(6, 3, 2), { detail: 1 });
            expect(f.writeText).not.toHaveBeenCalled();
            // A one-character drag within a cell, from x=1 to x=8, selects, shows and copies it.
            gesture(f, point(6, 1, 2), point(6, 8, 2));
            expect(f.term.hasSelection()).toBe(true);
            expect(f.writeText).toHaveBeenLastCalledWith('i');
        } finally { f.dispose(); }
    });
});
