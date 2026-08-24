/**
 * `cellText` — the buffer read behind ⌘-clicking a path in a terminal (CONT-122 / TERM-052).
 *
 * Separate from `service.test.ts` so the wrap-joining and offset arithmetic are readable on
 * their own; both exercise the same real `@xterm/headless` emulator, never a stub.
 */

import { describe, expect, it } from 'vitest';

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

    it('cellTextAsync flushes pending writes first', async () => {
        const term = createTerminalStateService({ defaultCols: 30, defaultRows: 5 });
        term.attach(PANE, 30, 5);
        term.feed(PANE, 'vim notes.md');
        // Deliberately NOT flushed: the synchronous read may not see it yet, the async one must.
        const cell = await term.cellTextAsync(PANE, 0, 5);
        expect(cell?.text).toContain('notes.md');
    });
});
