import { describe, expect, it } from 'vitest';

import { collectLogicalLines, findMatches, searchTerminal } from './search.js';
import { createTerminalStateService } from './service.js';

const PANE = '11111111-2222-4333-8444-555555555555';

async function pane(text: string, cols = 20, rows = 6): Promise<ReturnType<typeof createTerminalStateService>> {
    const term = createTerminalStateService({ defaultCols: cols, defaultRows: rows });
    term.attach(PANE, cols, rows);
    term.feed(PANE, text);
    await term.flush(PANE);
    return term;
}

describe('collectLogicalLines', () => {
    it('re-joins soft-wrapped rows into one logical line', async () => {
        // 30 characters into a 20-column terminal wraps onto a second row.
        const term = await pane('abcdefghijklmnopqrstuvwxyz1234\r\n');
        const lines = collectLogicalLines(termOf(term));
        expect(lines[0]?.text.startsWith('abcdefghijklmnopqrst')).toBe(true);
        expect(lines[0]?.text).toContain('uvwxyz1234');
        expect(lines[0]?.startLine).toBe(0);
    });

    it('reads the viewport only when scrollback is excluded', async () => {
        const term = await pane('one\r\ntwo\r\nthree\r\n', 20, 2);
        const all = collectLogicalLines(termOf(term), true).map((line) => line.text.trim());
        const viewport = collectLogicalLines(termOf(term), false).map((line) => line.text.trim());
        expect(all).toContain('one');
        expect(viewport).not.toContain('one');
    });
});

describe('findMatches', () => {
    const line = { text: 'alpha beta alpha', startLine: 4, cols: 80 };

    it('finds every occurrence, case-insensitively by default', () => {
        const matches = findMatches([line], 'ALPHA', { bufferLength: 10 });
        expect(matches).toHaveLength(2);
        expect(matches[0]).toMatchObject({ line: 4, col: 0, length: 5, linesFromBottom: 6 });
        expect(matches[1]).toMatchObject({ line: 4, col: 11 });
    });

    it('honours case sensitivity when asked', () => {
        expect(findMatches([line], 'ALPHA', { bufferLength: 10, caseSensitive: true })).toHaveLength(0);
        expect(findMatches([line], 'alpha', { bufferLength: 10, caseSensitive: true })).toHaveLength(2);
    });

    it('counts overlapping occurrences separately', () => {
        const matches = findMatches([{ text: 'aaa', startLine: 0, cols: 80 }], 'aa', { bufferLength: 1 });
        expect(matches).toHaveLength(2);
    });

    it('maps an offset past the wrap point back onto the following buffer row', () => {
        // cols=10, so offset 12 lives on the second row of the logical line.
        const wrapped = { text: '0123456789xxNEEDLE', startLine: 3, cols: 10 };
        const matches = findMatches([wrapped], 'NEEDLE', { bufferLength: 20 });
        expect(matches[0]).toMatchObject({ line: 4, col: 2, linesFromBottom: 16 });
    });

    it('stops at the limit', () => {
        const matches = findMatches([{ text: 'aaaaaa', startLine: 0, cols: 80 }], 'a', {
            bufferLength: 1,
            limit: 3
        });
        expect(matches).toHaveLength(3);
    });

    it('never matches an empty needle', () => {
        expect(findMatches([line], '', { bufferLength: 1 })).toEqual([]);
    });
});

describe('searchTerminal / TerminalStateService.search', () => {
    it('finds a marker written into the buffer', async () => {
        const term = await pane('hello NEEDLE world\r\nsecond NEEDLE line\r\n', 40, 4);
        const matches = term.search(PANE, 'needle');
        expect(matches).toHaveLength(2);
        expect(matches[0]?.linesFromBottom).toBeGreaterThan(matches[1]?.linesFromBottom ?? 0);
    });

    it('finds a needle that straddles a soft wrap', async () => {
        // 18 columns: "aaaaaaaaaaaaaaaaSPLITME" wraps with SPLITME across the boundary.
        const term = await pane('aaaaaaaaaaaaaaaaSPLITME\r\n', 18, 4);
        expect(term.search(PANE, 'SPLITME')).toHaveLength(1);
    });

    it('reports nothing for a pane with no terminal state', () => {
        const term = createTerminalStateService();
        expect(term.search('nope', 'x')).toEqual([]);
    });

    it('searchAsync sees bytes fed a moment earlier', async () => {
        const term = createTerminalStateService({ defaultCols: 40, defaultRows: 4 });
        term.attach(PANE, 40, 4);
        term.feed(PANE, 'LATEMARKER\r\n');
        // No flush: the synchronous read may not see it yet, but the async one must.
        expect(await term.searchAsync(PANE, 'LATEMARKER')).toHaveLength(1);
    });

    it('searchTerminal short-circuits an empty needle', async () => {
        const term = await pane('anything\r\n');
        expect(searchTerminal(termOf(term), '')).toEqual([]);
    });
});

/** The service keeps its emulators private; the tests read one through a narrow accessor. */
function termOf(service: ReturnType<typeof createTerminalStateService>): Parameters<typeof collectLogicalLines>[0] {
    const panes = (service as unknown as { panes: Map<string, { term: Parameters<typeof collectLogicalLines>[0] }> })
        .panes;
    const entry = panes.get(PANE);
    if (entry === undefined) throw new Error('pane has no terminal state');
    return entry.term;
}
