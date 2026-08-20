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

    it('cellTextAsync flushes pending writes first', async () => {
        const term = createTerminalStateService({ defaultCols: 30, defaultRows: 5 });
        term.attach(PANE, 30, 5);
        term.feed(PANE, 'vim notes.md');
        // Deliberately NOT flushed: the synchronous read may not see it yet, the async one must.
        const cell = await term.cellTextAsync(PANE, 0, 5);
        expect(cell?.text).toContain('notes.md');
    });
});
