/**
 * Every buffer read is bounded to the GRID — `capture()` (READ-1) and search (READ-2).
 *
 * The ⌘-click fix (`cellText`, `cell-text.test.ts`) proved the shape of the bug and fixed it in
 * one reader; these are the other two readers of the same buffer, and this file is their proof.
 *
 * The root cause, once: `NO_REFLOW` (§N11) leaves xterm's post-shrink per-line trim un-run —
 * that trim lives INSIDE `if (this._isReflowEnabled)` in `Buffer.resize`, so on a column shrink
 * every existing `BufferLine` keeps the width it was allocated at while `term.cols` becomes the
 * new one. `translateToString()` with no column bounds then hands back the whole allocation:
 * cells the shrink stranded past the grid, which no program can ever overwrite and no renderer
 * ever draws. Splice those into a capture and the user reads text that is not on the screen;
 * splice them into the search join and the find bar counts matches that cannot be revealed.
 *
 * Each test asserts BOTH halves: the old code shape (computed inline, against the same real
 * `@xterm/headless` buffer) producing the splice, and the shipped reader producing the clean
 * answer.
 */

import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import { afterEach, describe, expect, it } from 'vitest';

import { collectLogicalLines, findMatches } from './search.js';
import { TerminalStateServiceImpl } from './service.js';

const services: TerminalStateServiceImpl[] = [];

function makeService(): TerminalStateServiceImpl {
    const service = new TerminalStateServiceImpl();
    services.push(service);
    return service;
}

async function write(service: TerminalStateServiceImpl, paneID: string, data: string): Promise<void> {
    service.feed(paneID, data);
    await service.flush(paneID);
}

afterEach(() => {
    for (const service of services.splice(0)) service.disposeAll();
});

/** The service keeps its emulators private; these tests read one through a narrow accessor. */
function termOf(service: TerminalStateServiceImpl, paneID: string): HeadlessTerminal {
    const panes = (service as unknown as { panes: Map<string, { term: HeadlessTerminal }> }).panes;
    const entry = panes.get(paneID);
    if (entry === undefined) throw new Error(`pane ${paneID} has no terminal state`);
    return entry.term;
}

/** Row text the way BOTH readers used to take it: no column bound at all. */
function unbounded(term: HeadlessTerminal, y: number): string {
    const line = term.buffer.active.getLine(y);
    return line === undefined ? '' : line.translateToString(true);
}

/** How wide the row's cells actually are (its allocation, not the grid). */
function allocation(term: HeadlessTerminal, y: number): number {
    return term.buffer.active.getLine(y)?.length ?? 0;
}

describe('capture (readRegion) — bounded to the grid', () => {
    /**
     * The `cellText` regression, in the capture reader: a shrink strands cells past the new
     * width and only the first `cols` of the row can ever be overwritten again, so an unbounded
     * read glues pre-shrink garbage onto the end of live output.
     */
    it('never reports cells the column shrink stranded past the grid', async () => {
        const service = makeService();
        service.attach('p', 40, 6);
        // Row 0 filled edge to edge at the wide geometry; `STRANDED` sits past column 20.
        await write(service, 'p', `${'-'.repeat(32)}STRANDED`);

        service.resize('p', 20, 6);
        await service.flush('p');
        // Home the cursor and overwrite the row edge to edge — all the new grid lets a program
        // touch. Every cell past column 20 is now unreachable.
        await write(service, 'p', '\x1b[H/tmp/dir/notes-xy.md');

        const term = termOf(service, 'p');
        // The defect, proven against the live buffer: the row is still 40 cells wide and the
        // read the reader used to do still returns the stale tail.
        expect(allocation(term, 0)).toBeGreaterThan(term.cols);
        expect(unbounded(term, 0)).toContain('STRANDED');

        // The shipped reader answers with what the pane actually shows.
        expect(service.capture('p', { scrollback: false })).toBe('/tmp/dir/notes-xy.md');
        expect(service.capture('p', { scrollback: true })).not.toContain('STRANDED');
    });

    /**
     * The same bound on the wrap JOIN. A logical line wrapped at the old width keeps its
     * continuation row, so an unbounded first row contributes the pre-shrink tail *inside* the
     * joined line — text spliced into the middle, not merely appended.
     */
    it('joins a soft-wrapped line at the grid width after a shrink', async () => {
        const service = makeService();
        service.attach('p', 40, 6);
        await write(service, 'p', `${'a'.repeat(40)}TAIL`);

        service.resize('p', 20, 6);
        await service.flush('p');

        const term = termOf(service, 'p');
        expect(term.buffer.active.getLine(1)?.isWrapped).toBe(true);
        // Old shape: row 0 hands back all 40 of its cells, so the join is 44 characters for a
        // 20-column grid — 20 of them invisible in every renderer.
        expect(`${unbounded(term, 0)}${unbounded(term, 1)}`).toHaveLength(44);

        // Bounded: the 20 columns the grid shows, plus the continuation row.
        expect(service.capture('p', { scrollback: false })).toBe(`${'a'.repeat(20)}TAIL`);
    });

    /** The widen half of `NO_REFLOW` must not regress: trimming still keeps the join clean. */
    it('still joins a stale wrap after a widen without padding it out', async () => {
        const service = makeService();
        service.attach('p', 20, 6);
        await write(service, 'p', `${'a'.repeat(20)}TAIL`);

        service.resize('p', 40, 6);
        await service.flush('p');

        expect(service.capture('p', { scrollback: false })).toBe(`${'a'.repeat(20)}TAIL`);
    });
});

describe('search (collectLogicalLines / findMatches) — bounded to the grid', () => {
    /**
     * A find bar that counts a match in cells no renderer draws is worse than one that misses
     * it: the counter says "1 of 1" and the reveal scrolls to nothing.
     */
    it('never matches cells the column shrink stranded past the grid', async () => {
        const service = makeService();
        service.attach('p', 40, 6);
        await write(service, 'p', `${'-'.repeat(32)}STRANDED`);

        service.resize('p', 20, 6);
        await service.flush('p');
        await write(service, 'p', '\x1b[H/tmp/dir/notes-xy.md');

        const term = termOf(service, 'p');
        expect(unbounded(term, 0)).toContain('STRANDED'); // still in the buffer's allocation

        expect(service.search('p', 'STRANDED')).toEqual([]);
        expect(service.search('p', 'notes-xy')).toHaveLength(1);
    });

    /**
     * The `% cols` padding, and the `offset / cols` division it existed to serve, are both
     * nonsense once a row is not exactly `cols` characters wide. After a shrink the first row
     * of a stale wrap hands back MORE than `cols`, so `floor(offset / cols)` walks the match
     * off the end of its own logical line.
     */
    it('maps a match past the wrap point onto the row it is really on', async () => {
        const service = makeService();
        service.attach('p', 40, 6);
        await write(service, 'p', `${'a'.repeat(40)}NEEDLE`);

        service.resize('p', 20, 6);
        await service.flush('p');

        const term = termOf(service, 'p');
        const cols = term.cols;
        // Old shape, computed here: unbounded first row (40 chars), `40 % 20 === 0` so no pad,
        // then the continuation. The needle lands at offset 40 and the division claims row 2 —
        // a row this logical line never touched.
        const legacy = `${unbounded(term, 0)}${unbounded(term, 1)}`;
        expect(Math.floor(legacy.indexOf('NEEDLE') / cols)).toBe(2);

        const matches = service.search('p', 'NEEDLE');
        expect(matches).toHaveLength(1);
        expect(matches[0]).toMatchObject({ line: 1, col: 0, length: 6 });
    });

    /**
     * The widen half. Padding a trimmed row back out to `cols` injected spaces that were never
     * on the screen, so a needle straddling a stale wrap could not match at all.
     */
    it('matches a needle straddling a wrap the widen left stale', async () => {
        const service = makeService();
        service.attach('p', 20, 6);
        await write(service, 'p', `${'a'.repeat(20)}NEEDLE`);

        service.resize('p', 40, 6);
        await service.flush('p');

        const lines = collectLogicalLines(termOf(service, 'p'));
        expect(lines[0]?.text).toBe(`${'a'.repeat(20)}NEEDLE`);
        // The join is continuous: a needle that spans the wrap point is one match.
        const matches = service.search('p', 'aaNEEDLE');
        expect(matches).toHaveLength(1);
        expect(matches[0]).toMatchObject({ line: 0, col: 18 });
    });

    /** Positions come from the row map, not from arithmetic over `cols`. */
    it('resolves a match through the row map it was built with', () => {
        const line = {
            text: '0123456789xxNEEDLE',
            startLine: 3,
            cols: 10,
            rows: [
                { line: 3, offset: 0 },
                { line: 4, offset: 10 }
            ]
        };
        const matches = findMatches([line], 'NEEDLE', { bufferLength: 20 });
        expect(matches[0]).toMatchObject({ line: 4, col: 2, linesFromBottom: 16 });
    });
});
