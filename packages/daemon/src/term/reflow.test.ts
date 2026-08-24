/**
 * The emulator's REFLOW POLICY (`service.ts` `NO_REFLOW` / `STOCK_REFLOW` / `applyGrid`).
 *
 * Three claims, one per axis and one about the lever itself:
 *
 *   1. a COLUMN change never rewraps — which is what keeps a line editor's SIGWINCH repaint
 *      landing on the row it computed, and is the whole of the resize-trail fix;
 *   2. a ROW change still pulls history down out of scrollback — the stock xterm behaviour
 *      that every "windows" spelling of the reflow switch would otherwise take away;
 *   3. no soft wrap is ever FABRICATED — the reason `windowsPty` is used here and
 *      `windowsMode` (its deprecated sibling, which arms `updateWindowsModeWrappedState`) is
 *      not. That heuristic would glue any full-width line to the next one in `capture()`,
 *      `search()`, `cellText()` and — worst — in the snapshot a client replays.
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

describe('reflow policy — columns', () => {
    it('does not rewrap a full-width line when the pane narrows', async () => {
        // Stock `@xterm/headless` 6.0.0 splits the 40-cell line into two rows here and pushes
        // everything below it down one — which is exactly what strands a prompt copy, because
        // zle has already computed how far up its repaint has to go.
        const service = makeService();
        service.attach('p', 40, 10);
        await write(service, 'p', `${'A'.repeat(40)}\r\nsecond\r\nthird`);

        service.resize('p', 30, 10);

        expect(service.cellText('p', 1, 0)?.text.trimEnd()).toBe('second');
        expect(service.cellText('p', 2, 0)?.text.trimEnd()).toBe('third');
    });

    it('keeps the rows below a full-width line where they were, shrink after shrink', async () => {
        // The storm, in miniature: 12 successive narrowings must not move `third` off row 2.
        const service = makeService();
        service.attach('p', 60, 10);
        await write(service, 'p', `${'A'.repeat(60)}\r\nsecond\r\nthird`);

        for (let cols = 59; cols >= 48; cols -= 1) service.resize('p', cols, 10);

        expect(service.cellText('p', 2, 0)?.text.trimEnd()).toBe('third');
        expect(service.gridSize('p')).toEqual({ cols: 48, rows: 10 });
    });

    it('still joins a line that really did soft-wrap, at whatever width it is read', async () => {
        // Reflow-off means the rows keep their old width rather than being re-split; the
        // `isWrapped` flags are untouched, so a logical line is still read as one — ONE line
        // here, never two.
        //
        // What each row contributes is the grid, `min(cols, line.length)` (READ-1,
        // `read-bounds.test.ts`): a shrink leaves the rows allocated at 20 cells while the grid
        // is 10, and those 10 stranded cells per row are unreachable by any program and drawn
        // by no renderer. Reading them back put pre-shrink cells inside live output. The trade
        // is stated where the bound is: a row printed before the shrink reads at the width the
        // pane has NOW, so this capture is 2 × 10 X rather than the 35 that were typed.
        const service = makeService();
        service.attach('w', 20, 6);
        await write(service, 'w', `${'X'.repeat(35)}\r\nplain`);

        service.resize('w', 10, 6);

        expect(service.capture('w', { scrollback: true })).toBe(`${'X'.repeat(20)}\nplain`);
    });
});

describe('reflow policy — rows', () => {
    it('pulls history back into the viewport when the pane grows taller', async () => {
        // The clause `windowsMode` / a windows `windowsPty` would break: both push blank rows
        // onto the bottom instead, so a taller window would show empty space where the shipped
        // app (and ghostty) show scrollback.
        const service = makeService();
        service.attach('r', 20, 3);
        for (let line = 1; line <= 8; line += 1) await write(service, 'r', `line-${String(line)}\r\n`);

        service.resize('r', 20, 6);

        expect(service.capture('r', { scrollback: false }).split('\n')).toEqual([
            'line-4',
            'line-5',
            'line-6',
            'line-7',
            'line-8'
        ]);
    });

    it('applies both axes when a window drag changes both at once', async () => {
        const service = makeService();
        service.attach('b', 40, 3);
        for (let line = 1; line <= 8; line += 1) await write(service, 'b', `line-${String(line)}\r\n`);
        await write(service, 'b', 'A'.repeat(40));

        service.resize('b', 30, 6);

        expect(service.gridSize('b')).toEqual({ cols: 30, rows: 6 });
        // rows: history came back…
        expect(service.capture('b', { scrollback: false }).split('\n')[0]).toBe('line-4');
        // …columns: and the full-width line was not split in two. It reads at the grid the pane
        // has now (READ-1's bound — 30 of its 40 allocated cells), on ONE line, which is the
        // claim: a rewrap would have made it two.
        expect(service.capture('b', { scrollback: true }).split('\n').at(-1)).toBe('A'.repeat(30));
    });

    it('restores the no-reflow policy after the row half of a resize', async () => {
        // `applyGrid` lifts the policy for the row resize and puts it back in a `finally`;
        // if it ever failed to, the NEXT narrowing would rewrap.
        const service = makeService();
        service.attach('p', 40, 6);
        await write(service, 'p', `${'A'.repeat(40)}\r\nsecond`);

        service.resize('p', 40, 12); // rows only — stock policy runs here
        service.resize('p', 24, 12); // columns only — must not rewrap

        expect(service.cellText('p', 1, 0)?.text.trimEnd()).toBe('second');
    });

    it('re-asserting the grid through attach() uses the same policy', async () => {
        const service = makeService();
        service.attach('p', 40, 6);
        await write(service, 'p', `${'A'.repeat(40)}\r\nsecond`);

        service.attach('p', 24, 6); // registry semantics: an existing pane keeps its state

        expect(service.gridSize('p')).toEqual({ cols: 24, rows: 6 });
        expect(service.cellText('p', 1, 0)?.text.trimEnd()).toBe('second');
    });
});

describe('reflow policy — no fabricated wraps (why not `windowsMode`)', () => {
    it('does not glue a full-width line to the next one in capture()', async () => {
        // With `windowsMode: true` this reads `AAAA…AAAAshort` — one line — because the
        // heuristic marks row 1 wrapped whenever row 0's last cell is not blank.
        const service = makeService();
        service.attach('q', 20, 6);
        await write(service, 'q', `${'A'.repeat(20)}\r\nshort\r\n`);

        expect(service.capture('q', { scrollback: true })).toBe(`${'A'.repeat(20)}\nshort`);
    });

    it('does not glue them in the snapshot a client replays either', async () => {
        const service = makeService();
        service.attach('q', 20, 6);
        await write(service, 'q', `${'A'.repeat(20)}\r\nshort\r\n`);

        const snapshot = decoder.decode(service.snapshot('q').data);

        expect(snapshot).toContain(`${'A'.repeat(20)}\r\nshort`);
        expect(snapshot).not.toContain(`${'A'.repeat(20)}short`);
    });

    it('survives a narrowing without inventing a wrap', async () => {
        const service = makeService();
        service.attach('q', 20, 6);
        await write(service, 'q', `${'A'.repeat(20)}\r\nshort\r\n`);

        service.resize('q', 12, 6);

        // The claim is the NEWLINE: `short` is its own line, never glued onto the A's the way
        // `windowsMode`'s fabricated wrap would. The A's themselves read at the grid (READ-1).
        expect(service.capture('q', { scrollback: true })).toBe(`${'A'.repeat(12)}\nshort`);
    });
});
