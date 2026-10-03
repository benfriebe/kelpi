/**
 * `cellText` — the buffer read behind ⌘-clicking a path in a terminal (CONT-122 / TERM-052).
 *
 * Separate from `service.test.ts` so the wrap-joining and offset arithmetic are readable on
 * their own; both exercise the same real `@xterm/headless` emulator, never a stub.
 */

import { describe, expect, it } from 'vitest';

import { cellRuns, tokenRangeAt } from '../ws/desktop.js';
import { createTerminalStateService } from './service.js';

const PANE = 'AAAAAAAA-0000-4000-8000-000000000001';

async function seeded(text: string, cols = 20, rows = 6): Promise<ReturnType<typeof createTerminalStateService>> {
    const term = createTerminalStateService({ defaultCols: cols, defaultRows: rows });
    term.attach(PANE, cols, rows);
    term.feed(PANE, text);
    await term.flush(PANE);
    return term;
}

describe('cellText', () => {
    it('returns the row under the cell and the offset of the clicked column', async () => {
        const term = await seeded('cat docs/a.md\r\n');
        const cell = term.cellText(PANE, 0, 8);
        expect(cell?.text.startsWith('cat docs/a.md')).toBe(true);
        expect(cell?.offset).toBe(8);
        expect(cell?.text[cell.offset]).toBe('/'); // "cat docs[/]a.md"
    });

    it('re-joins a soft-wrapped line so a wrapped path is one token again', async () => {
        // 20 columns; the path straddles the wrap.
        const term = await seeded('cat /very/long/dir/name/notes.md\r\n', 20, 6);
        // The tail of the path lives on visual row 1.
        const cell = term.cellText(PANE, 1, 4);
        expect(cell).not.toBeNull();
        expect(cell?.text).toContain('/very/long/dir/name/notes.md');
        // Offset maps back through the full-width first row.
        expect(cell?.offset).toBe(24);
        // Row 0 held the first 20 cells ("cat /very/long/dir/n"), so column 4 of the wrapped
        // row is index 24 of the joined line — the "n" of "notes.md".
        expect(cell?.text.slice(cell.offset, cell.offset + 3)).toBe('not');
    });

    it('answers null for an unknown pane, an out-of-range row and a blank line', async () => {
        const term = await seeded('hello\r\n');
        expect(term.cellText('nope', 0, 0)).toBeNull();
        expect(term.cellText(PANE, 99, 0)).toBeNull();
        expect(term.cellText(PANE, 0, -1)).toBeNull();
        // Row 3 is untouched screen: an empty line has no token to read.
        expect(term.cellText(PANE, 3, 0)).toBeNull();
    });

    /**
     * The `run-Q` regression, at the seam that caused it.
     *
     * `NO_REFLOW` (§N11) leaves xterm's post-shrink per-line trim un-run — that trim lives
     * INSIDE `if (this._isReflowEnabled)` in `Buffer.resize`, so on a column shrink every
     * existing `BufferLine` keeps the width it was allocated at while `term.cols` becomes the
     * new one. A row is then WIDER than the grid, and `translateToString()` with no column
     * bounds returns the whole allocation. Splitting a 132-column pane in half and printing a
     * path that soft-wraps at 65 used to join as
     * `…nexaudit-ui-yjs0` + 67 spaces + `ZC/work/AUDIT.md`, with `offset` (which is computed
     * from `cols`) landing in the space run — so `tokenAt` saw a separator and the ⌘-click did
     * nothing at all. Both halves are asserted: the joined line, and the offset that indexes it.
     */
    it('bounds every row to the GRID after a column shrink with reflow off (run-Q)', async () => {
        const wide = 132;
        const narrow = 65;
        const term = createTerminalStateService({ defaultCols: wide, defaultRows: 24 });
        term.attach(PANE, wide, 24);
        // Fill the rows this test will re-use at the WIDE geometry, so their BufferLine
        // allocation is 132 when the shrink arrives.
        term.feed(PANE, `${'w'.repeat(wide)}\r\n${'w'.repeat(wide)}\r\n`);
        await term.flush(PANE);

        term.resize(PANE, narrow, 24);
        await term.flush(PANE);
        // What the audit step does before it prints: clear screen + scrollback, home the
        // cursor. `ED` fills the whole allocation, so the surviving damage is pure PADDING —
        // 132 cells read back where the grid has 65.
        term.feed(PANE, '[2J[3J[H');
        await term.flush(PANE);

        const filePath = '/var/folders/5x/k7q6qbys3p35wb8dcn0dlfmh0000gn/T/nexaudit-ui-yjs0ZC/work/AUDIT.md';
        expect(filePath.length).toBeGreaterThan(narrow); // it must actually wrap
        term.feed(PANE, `${filePath}\r\n`);
        await term.flush(PANE);

        // Row 0 starts the path; row 1 is its wrapped continuation. Both must join to exactly
        // the path, with no stale cells and no padding from the pre-shrink allocation.
        const first = term.cellText(PANE, 0, 2);
        expect(first?.text).toBe(filePath);
        expect(first?.offset).toBe(2);

        const wrapped = term.cellText(PANE, 1, 2);
        expect(wrapped?.text).toBe(filePath);
        // (1 - 0) * 65 + 2 — only true if row 0 contributed exactly `cols` characters.
        expect(wrapped?.offset).toBe(narrow + 2);
        expect(wrapped?.text.slice(wrapped.offset)).toBe('/work/AUDIT.md');
    });

    /**
     * The same root cause with the damage the audit's `ED` hides: `EL` and an ordinary
     * overwrite only reach `cols`, so cells the shrink stranded PAST the new width keep the
     * wide screen's characters. An unbounded read splices them into the middle of the logical
     * line — a token the daemon then refuses, with no way for the user to tell why.
     */
    it('never reads cells the column shrink stranded past the grid', async () => {
        const wide = 40;
        const narrow = 20;
        const term = createTerminalStateService({ defaultCols: wide, defaultRows: 6 });
        term.attach(PANE, wide, 6);
        // Row 0 is filled edge to edge at the wide geometry; `STRANDED` sits past column 20.
        term.feed(PANE, `${'-'.repeat(32)}STRANDED`);
        await term.flush(PANE);

        term.resize(PANE, narrow, 6);
        await term.flush(PANE);
        // No screen clear: home the cursor and overwrite the row edge to edge, which is all
        // the grid's own width lets the program touch — every cell past 20 is untouchable.
        term.feed(PANE, '[H/tmp/dir/notes-xy.md');
        await term.flush(PANE);

        const cell = term.cellText(PANE, 0, 3);
        expect(cell?.text).toBe('/tmp/dir/notes-xy.md');
        expect(cell?.text).not.toContain('STRANDED');
        expect(cell?.offset).toBe(3);
    });

    /**
     * #303: `cellsOf` is what turns a token back into the cells a hover underline is drawn
     * under, so each unit of the text must name the cell that shows it.
     */
    it('names the viewport cell of every unit of a range of the text', async () => {
        const term = await seeded('cat docs/a.md\r\n');
        const cell = term.cellText(PANE, 0, 8);
        expect(cell?.cellsOf(4, 13)).toHaveLength(9);
        expect(cell?.cellsOf(4, 5)).toEqual([{ row: 0, col: 4, width: 1 }]); // "d"
        expect(cell?.cellsOf(12, 13)).toEqual([{ row: 0, col: 12, width: 1 }]); // the last "d"
        expect(cell?.cellsOf(3, 3)).toEqual([]);
    });

    it('maps a soft-wrapped line onto both of its rows', async () => {
        const term = await seeded('cat /very/long/dir/name/notes.md\r\n', 20, 6);
        const cell = term.cellText(PANE, 1, 4);
        // Unit 24 is the "n" of "notes.md", column 4 of the wrapped row (see the test above).
        expect(cell?.cellsOf(19, 25)).toEqual([
            { row: 0, col: 19, width: 1 },
            { row: 1, col: 0, width: 1 },
            { row: 1, col: 1, width: 1 },
            { row: 1, col: 2, width: 1 },
            { row: 1, col: 3, width: 1 },
            { row: 1, col: 4, width: 1 }
        ]);
    });

    it('puts a character after a wide one on its own cell, not one cell early', async () => {
        // "日" covers columns 0 and 1 and reads as ONE unit, so text and cells disagree by one
        // from there on; the mapping is what keeps the underline on the right cells.
        const term = await seeded('日 see a.md\r\n');
        const cell = term.cellText(PANE, 0, 7);
        expect(cell?.text.startsWith('日 see a.md')).toBe(true);
        expect(cell?.cellsOf(0, 2)).toEqual([
            { row: 0, col: 0, width: 2 },
            { row: 0, col: 2, width: 1 }
        ]);
        expect(cell?.cellsOf(6, 7)).toEqual([{ row: 0, col: 7, width: 1 }]); // "a"
    });

    it('reads the right half of a wide character as that character', async () => {
        // "a日b": column 2 is the spacer of "日". Read as itself it put the offset on "b".
        const term = await seeded('a日b\r\n');
        expect(term.cellText(PANE, 0, 1)?.offset).toBe(1);
        expect(term.cellText(PANE, 0, 2)?.offset).toBe(1);
        expect(term.cellText(PANE, 0, 3)?.offset).toBe(2);
    });

    it('names rows above the screen with negative rows once the line starts in history', async () => {
        // 10 columns x 3 rows: the 25-cell line wraps over three rows, and two more lines push
        // its head row up into history.
        const term = await seeded(`${'x'.repeat(25)}\r\nb\r\nc`, 10, 3);
        const cell = term.cellText(PANE, 0, 1);
        expect(cell?.text).toBe('x'.repeat(25));
        expect(cell?.cellsOf(0, 1)?.[0]?.row).toBeLessThan(0);
        expect(cell?.cellsOf(24, 25)).toEqual([{ row: 0, col: 4, width: 1 }]);
    });

    it('reads at most maxRows either side, and nothing of a line that runs past them', async () => {
        // 10 columns: an 85-cell line is nine rows, all on screen.
        const term = await seeded(`${'y'.repeat(85)}\r\n`, 10, 12);
        expect(term.cellText(PANE, 4, 1)?.text).toBe('y'.repeat(85));
        expect(term.cellText(PANE, 4, 1, { maxRows: 8 })?.text).toBe('y'.repeat(85));
        expect(term.cellText(PANE, 4, 1, { maxRows: 3 })).toBeNull();
        // A short line is unaffected by the bound.
        const short = await seeded('see a.md\r\n', 10, 12);
        expect(short.cellText(PANE, 0, 4, { maxRows: 0 })?.text).toBe('see a.md');
    });

    /**
     * #303, the whole daemon half on the real emulator: the line, the token in it, and the
     * cells to underline, for a URL that soft-wraps and one that follows a wide character.
     */
    it('turns a token back into the cells that show it, across a wrap and after a wide character', async () => {
        const url = 'https://example.com/a/long/path';
        const wrapped = await seeded(`see ${url} now\r\n`, 20, 6);
        const head = wrapped.cellText(PANE, 0, 6)!;
        const range = tokenRangeAt(head.text, head.offset)!;
        expect(head.text.slice(range.start, range.end)).toBe(url);
        expect(cellRuns(head.cellsOf(range.start, range.end))).toEqual([
            { row: 0, col: 4, width: 16 },
            { row: 1, col: 0, width: 15 }
        ]);
        const tail = wrapped.cellText(PANE, 1, 3)!;
        const tailRange = tokenRangeAt(tail.text, tail.offset)!;
        expect(cellRuns(tail.cellsOf(tailRange.start, tailRange.end))).toEqual([
            { row: 0, col: 4, width: 16 },
            { row: 1, col: 0, width: 15 }
        ]);

        const wide = await seeded('日本 notes.md\r\n', 20, 6);
        const line = wide.cellText(PANE, 0, 7)!;
        const token = tokenRangeAt(line.text, line.offset)!;
        expect(line.text.slice(token.start, token.end)).toBe('notes.md');
        expect(cellRuns(line.cellsOf(token.start, token.end))).toEqual([{ row: 0, col: 5, width: 8 }]);
    });

    it('cellTextAsync flushes pending writes first', async () => {
        const term = createTerminalStateService({ defaultCols: 30, defaultRows: 5 });
        term.attach(PANE, 30, 5);
        term.feed(PANE, 'vim notes.md');
        // Deliberately NOT flushed: the synchronous read may not see it yet, the async one must.
        const cell = await term.cellTextAsync(PANE, 0, 5);
        expect(cell?.text).toContain('notes.md');
    });
});
