/**
 * The snapshot a client REPLAYS must describe the pane's grid — and nothing outside it (N23).
 *
 * `NO_REFLOW` (see `service.ts`) buys the resize-trail fix at one documented cost: xterm's
 * post-shrink per-line trim lives inside `if (this._isReflowEnabled)`, so on a column shrink
 * every existing `BufferLine` keeps the width it was allocated at while `_cols` becomes the new
 * one. Cells stranded past the new width are unreachable — `EL` cannot clear them, an ordinary
 * overwrite cannot reach them — but they are still in the line, and `@xterm/addon-serialize`
 * reads `line.length`, not `term.cols`.
 *
 * So the replay frame carried rows WIDER than the pane. The daemon's own screen never shows
 * them (`capture()` bounds itself to `term.cols`), and the client's engine has no such stranded
 * cells — it just renders the bytes it is given, wraps the overflow onto the next row, and every
 * row below shifts. That is the owner's "rows of garbage glyphs after closing/adjusting panes":
 * stale off-screen text made visible, re-wrapped through whatever glyph sat on the boundary.
 *
 * The two claims below are the whole invariant:
 *
 *   1. no serialized row is wider than the grid it was serialized for, and
 *   2. replaying a snapshot into a FRESH emulator at the same grid reproduces the screen it was
 *      taken from — the server-text-equals-client-text equality, one layer below the wire.
 */

import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import { afterEach, describe, expect, it } from 'vitest';

import { TerminalStateServiceImpl } from './service.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const services: TerminalStateServiceImpl[] = [];

function makeService(): TerminalStateServiceImpl {
    const service = new TerminalStateServiceImpl();
    services.push(service);
    return service;
}

async function write(service: TerminalStateServiceImpl, paneID: string, data: string): Promise<void> {
    service.feed(paneID, encoder.encode(data));
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

/**
 * The visible grid, ROW BY ROW — deliberately not `capture()`, which joins soft-wrapped rows
 * back into logical lines and therefore reads the same whether or not a row overflowed onto
 * the next one. A row that shifts is exactly what the user sees.
 */
function gridRows(service: TerminalStateServiceImpl, paneID: string): string[] {
    const term = termOf(service, paneID);
    const buffer = term.buffer.active;
    const rows: string[] = [];
    for (let y = 0; y < term.rows; y += 1) {
        rows.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '');
    }
    return rows;
}

/** Replay a pane's snapshot into a fresh emulator at the grid it was taken for. */
async function replayInto(
    source: TerminalStateServiceImpl,
    paneID: string
): Promise<{ service: TerminalStateServiceImpl; paneID: string }> {
    const snapshot = source.snapshot(paneID);
    const replayed = makeService();
    replayed.attach('replayed', snapshot.cols, snapshot.rows);
    replayed.feed('replayed', snapshot.data);
    await replayed.flush('replayed');
    return { service: replayed, paneID: 'replayed' };
}

/**
 * Columns each serialized row occupies, as a terminal would count them: printable cells (wide
 * characters count 2) plus the width of every `CSI n C` (cursor-forward) run, which is how the
 * serializer encodes a gap.
 */
function serializedRowWidths(snapshot: string): number[] {
    const widths: number[] = [];
    for (const row of snapshot.split('\r\n')) {
        let columns = 0;
        let index = 0;
        while (index < row.length) {
            const char = row[index] as string;
            if (char === '') {
                // CSI … final byte. Only cursor-forward moves the column counter.
                const match = /^\[([0-9;?]*)([@-~])/u.exec(row.slice(index));
                if (match === null) {
                    index += 1;
                    continue;
                }
                if (match[2] === 'C') columns += Number.parseInt(match[1] ?? '1', 10) || 1;
                index += match[0].length;
                continue;
            }
            const codePoint = row.codePointAt(index) as number;
            const text = String.fromCodePoint(codePoint);
            index += text.length;
            // East-Asian wide + emoji take two cells; everything else here takes one.
            columns += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]|[\u{1f300}-\u{1faff}]/u.test(text)
                ? 2
                : 1;
        }
        widths.push(columns);
    }
    return widths;
}

describe('replay snapshot bounds (N23)', () => {
    it('never serializes a row wider than the grid it is taken at', async () => {
        const service = makeService();
        service.attach('p', 120, 10);
        // A full-width line, then the shrink a pane close/adjust causes.
        await write(service, 'p', `${'A'.repeat(100)}\r\ntail`);
        service.resize('p', 40, 10);

        const snapshot = decoder.decode(service.snapshot('p').data);
        const widest = Math.max(...serializedRowWidths(snapshot));
        expect(widest).toBeLessThanOrEqual(40);
    });

    it('bounds the stranded cells a NO_REFLOW shrink leaves in a wide-glyph row', async () => {
        const service = makeService();
        service.attach('p', 80, 10);
        await write(service, 'p', '日本語テストの行が長いのでここで切れます、と書いてある行\r\n$ ');
        service.resize('p', 24, 10);

        const snapshot = decoder.decode(service.snapshot('p').data);
        const widest = Math.max(...serializedRowWidths(snapshot));
        expect(widest).toBeLessThanOrEqual(24);
    });

    it('replays into a fresh emulator as the screen it was taken from', async () => {
        // The client's engine is a fresh VT fed the replay. It has no stranded cells of its
        // own, so anything the snapshot carries past the grid becomes visible content there —
        // this is the server-text-equals-client-text equality at the unit level.
        const source = makeService();
        source.attach('p', 120, 12);
        await write(source, 'p', 'echo hi\r\nhi\r\n');
        await write(source, 'p', `┌── ${'─'.repeat(90)}┐\r\n`);
        await write(source, 'p', '$ ');
        source.resize('p', 40, 12);
        await source.flush('p');

        const expected = await source.captureAsync('p', { scrollback: false });
        const snapshot = source.snapshot('p');

        const replayed = makeService();
        replayed.attach('q', snapshot.cols, snapshot.rows);
        replayed.feed('q', snapshot.data);
        await replayed.flush('q');

        expect(await replayed.captureAsync('q', { scrollback: false })).toBe(expected);
    });

    /**
     * The half-glyph the trim itself can leave behind (READ-4).
     *
     * `trimStrandedCells` takes every line back to `term.cols`, which is the whole invariant
     * for single-width text. A DOUBLE-width glyph occupies two cells, and when the new right
     * edge falls between them the trim keeps the LEAD cell (still `width: 2`) and drops the
     * spacer that carried its second column — a state xterm's own parser never produces,
     * because `InputHandler` wraps a wide char rather than putting its lead in the last
     * column. The line is then `cols` cells wide but `cols + 1` COLUMNS wide, and the
     * serializer, which encodes cells, emits all of them.
     *
     * The `x` is what makes the run land on odd columns, so the shrink to 22 cuts a glyph
     * rather than landing between two.
     */
    it('never serializes a wide glyph the shrink cut in half', async () => {
        const service = makeService();
        service.attach('p', 80, 8);
        await write(service, 'p', `x${'日'.repeat(30)}\r\n$ `);
        service.resize('p', 22, 8);

        const snapshot = decoder.decode(service.snapshot('p').data);
        const widest = Math.max(...serializedRowWidths(snapshot));
        expect(widest).toBeLessThanOrEqual(22);
    });

    /**
     * The same defect seen the way the owner sees it: one column of overflow is one wrapped
     * row, and every row below it moves down. `capture()` cannot show this — it joins wrapped
     * rows — so this asserts the grid row by row.
     */
    it('replays a cut-in-half glyph without shifting the rows below it', async () => {
        const source = makeService();
        source.attach('p', 80, 8);
        await write(source, 'p', `x${'日'.repeat(30)}\r\n$ `);
        source.resize('p', 22, 8);
        await source.flush('p');

        const replayed = await replayInto(source, 'p');
        expect(gridRows(replayed.service, replayed.paneID)).toEqual(gridRows(source, 'p'));
    });

    /** The same cut, on a row that has already scrolled into history. */
    it('never serializes a cut-in-half glyph out of scrollback', async () => {
        const service = makeService();
        service.attach('p', 80, 5);
        for (let index = 0; index < 12; index += 1) {
            await write(service, 'p', `x${'日'.repeat(30)}\r\n`);
        }
        await write(service, 'p', '$ ');
        service.resize('p', 22, 5);

        const snapshot = decoder.decode(service.snapshot('p').data);
        expect(Math.max(...serializedRowWidths(snapshot))).toBeLessThanOrEqual(22);
    });

    /**
     * And on the ALTERNATE screen, which `serialize()` appends behind `CSI ?1049h` whenever it
     * is the active buffer — a second route to the same client engine, and the one a
     * full-screen app (vim, less, an agent TUI) is on when the pane is resized.
     */
    it('never serializes a cut-in-half glyph off the alternate screen', async () => {
        const service = makeService();
        service.attach('p', 80, 6);
        await write(service, 'p', 'normal\r\n');
        await write(service, 'p', '\x1b[?1049h');
        await write(service, 'p', `x${'日'.repeat(30)}\r\ny${'語'.repeat(30)}`);
        service.resize('p', 22, 6);

        const snapshot = decoder.decode(service.snapshot('p').data);
        expect(Math.max(...serializedRowWidths(snapshot))).toBeLessThanOrEqual(22);
    });

    it('replays a wide-glyph screen into a fresh emulator unchanged', async () => {
        const source = makeService();
        source.attach('p', 100, 8);
        await write(source, 'p', '┌───── 日本語テスト ✅ あいうえお漢字 ──────────────────────────┐\r\n$ ');
        source.resize('p', 32, 8);
        await source.flush('p');

        const expected = await source.captureAsync('p', { scrollback: false });
        const snapshot = source.snapshot('p');

        const replayed = makeService();
        replayed.attach('q', snapshot.cols, snapshot.rows);
        replayed.feed('q', snapshot.data);
        await replayed.flush('q');

        expect(await replayed.captureAsync('q', { scrollback: false })).toBe(expected);
    });
});
