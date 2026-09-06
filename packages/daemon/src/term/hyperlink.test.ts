/**
 * `hyperlinkAt`: the OSC 8 read behind ⌘-clicking a link in a TUI pane (#83).
 *
 * **This test is the contract with `@xterm/headless`, and that is its whole job.** The read it
 * covers goes through two private fields (`line._extendedAttrs[x].urlId` and
 * `core._inputHandler._oscLinkService`) because the emulator parses OSC 8 and exposes it to
 * nobody; the implementation answers `null` on any shape it does not recognise, which is right
 * for a live daemon and catastrophic for a silent regression. So every case below drives a REAL
 * OSC 8 escape sequence through the REAL emulator and reads the URI back out. An xterm upgrade
 * that moves either field turns this file red instead of turning ⌘-click quietly dead again.
 */

import { describe, expect, it } from 'vitest';

import { createTerminalStateService } from './service.js';

const PANE = 'AAAAAAAA-0000-4000-8000-000000000001';
const ESC = '\x1b';
const ST = `${ESC}\\`;

/** `ESC ] 8 ; params ; URI ST  text  ESC ] 8 ; ; ST`: the sequence Codex and friends emit. */
function osc8(uri: string, text: string): string {
    return `${ESC}]8;;${uri}${ST}${text}${ESC}]8;;${ST}`;
}

/** Absolute cursor position, 1-based, the way a full-screen TUI paints every row. */
function cup(row: number, col: number): string {
    return `${ESC}[${String(row)};${String(col)}H`;
}

async function seeded(text: string, cols = 40, rows = 8): Promise<ReturnType<typeof createTerminalStateService>> {
    const term = createTerminalStateService({ defaultCols: cols, defaultRows: rows });
    term.attach(PANE, cols, rows);
    term.feed(PANE, text);
    await term.flush(PANE);
    return term;
}

describe('hyperlinkAt (#83)', () => {
    it('reads the URI of an OSC 8 link whose visible text is only its title', async () => {
        const term = await seeded(`see ${osc8('https://example.com/full/path', 'the docs')} now\r\n`);

        // The premise: the display text says nothing about the address, which is why the token
        // scan cannot find it and why this read has to exist at all.
        expect(term.cellText(PANE, 0, 5)?.text).toContain('see the docs now');
        expect(term.cellText(PANE, 0, 5)?.text).not.toContain('example.com');

        // Every cell of the title carries the link.
        expect(term.hyperlinkAt(PANE, 0, 4)).toBe('https://example.com/full/path');
        expect(term.hyperlinkAt(PANE, 0, 7)).toBe('https://example.com/full/path');
        expect(term.hyperlinkAt(PANE, 0, 11)).toBe('https://example.com/full/path');
    });

    it('answers null off the link, on blank screen and for an unknown pane', async () => {
        const term = await seeded(`see ${osc8('https://example.com/x', 'the docs')} now\r\n`);
        expect(term.hyperlinkAt(PANE, 0, 0)).toBeNull(); // "see"
        expect(term.hyperlinkAt(PANE, 0, 13)).toBeNull(); // "now"
        expect(term.hyperlinkAt(PANE, 4, 0)).toBeNull(); // untouched row
        expect(term.hyperlinkAt(PANE, 99, 0)).toBeNull();
        expect(term.hyperlinkAt(PANE, 0, -1)).toBeNull();
        expect(term.hyperlinkAt('nope', 0, 0)).toBeNull();
    });

    /**
     * The Codex case, reproduced without Codex: a ratatui-style box, CUP-positioned per row so
     * autowrap never fires and `isWrapped` is false on the tail row, with one hyperlink split
     * across two rows. `cellText` cannot re-join those rows (there is no wrap flag to key off,
     * and guessing would manufacture URLs out of box interiors), so the head row's token is a
     * truncated URL and the tail row's is not a URL at all. The attribute is on BOTH rows.
     */
    it('answers the WHOLE uri from either row of a hard-wrapped link', async () => {
        const uri = 'https://example.com/wrapped/path/that/continues/here';
        const term = await seeded(
            [
                cup(1, 1),
                '┌───────────────┐',
                cup(2, 1),
                `│${osc8(uri, 'https://example.')}│`,
                cup(3, 1),
                `│${osc8(uri, 'com/wrapped/path')}│`,
                cup(4, 1),
                '└───────────────┘'
            ].join('')
        );

        // The premise again: the rows are separate logical lines, so the text read is per-row.
        expect(term.cellText(PANE, 1, 4)?.text).toContain('https://example.');
        expect(term.cellText(PANE, 1, 4)?.text).not.toContain('com/wrapped');

        expect(term.hyperlinkAt(PANE, 1, 4)).toBe(uri); // head row
        expect(term.hyperlinkAt(PANE, 2, 4)).toBe(uri); // tail row
        expect(term.hyperlinkAt(PANE, 0, 4)).toBeNull(); // the border above it
    });

    it('reads the ALTERNATE screen, which is where a full-screen TUI lives', async () => {
        const term = await seeded(
            `${ESC}[?1049h${cup(3, 1)}${osc8('https://example.com/alt', 'alt link')}`
        );
        expect(term.hyperlinkAt(PANE, 2, 2)).toBe('https://example.com/alt');
    });

    it('keeps a non-http scheme intact rather than filtering it here', async () => {
        // The http(s) decision belongs to `ws/desktop.ts` (one spelling, shared with the token
        // scan); this read reports what the sequence said.
        const term = await seeded(`x ${osc8('file:///etc/passwd', 'passwd')}\r\n`);
        expect(term.hyperlinkAt(PANE, 0, 3)).toBe('file:///etc/passwd');
    });

    it('hyperlinkAtAsync flushes pending writes first', async () => {
        const term = createTerminalStateService({ defaultCols: 40, defaultRows: 8 });
        term.attach(PANE, 40, 8);
        term.feed(PANE, `go ${osc8('https://example.com/async', 'there')}\r\n`);
        expect(await term.hyperlinkAtAsync(PANE, 0, 4)).toBe('https://example.com/async');
    });
});
