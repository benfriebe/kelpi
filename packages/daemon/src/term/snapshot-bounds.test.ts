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
