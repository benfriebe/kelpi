import { describe, expect, it } from 'vitest';

import { createLinkHover, linkSpanFromReply, type LinkHoverCell } from './link-hover';
import type { TerminalCellRun } from './renderer';

/**
 * A probe whose answers the test releases by hand, so ordering is explicit, over a screen whose
 * rows the test can rewrite (`screen`). `snapshot: false` plays a pane that cannot read rows.
 */
function harness(options: { snapshot?: boolean; missMs?: number } = {}) {
    const asked: Array<{ cell: LinkHoverCell; answer: (cells: readonly TerminalCellRun[] | null) => void; fail: () => void }> = [];
    const painted: Array<readonly TerminalCellRun[] | null> = [];
    const timers: Array<{ run: () => void; cancelled: boolean }> = [];
    const screen = new Map<number, string>();
    const clock = { now: 0 };
    const hover = createLinkHover({
        now: () => clock.now,
        ...(options.missMs === undefined ? {} : { missMs: options.missMs }),
        probe: (row, col) =>
            new Promise((resolve, reject) => {
                asked.push({ cell: { row, col }, answer: resolve, fail: () => reject(new Error('socket closed')) });
            }),
        paint: (cells) => painted.push(cells),
        ...(options.snapshot === false
            ? {}
            : { snapshot: (rows: readonly number[]) => rows.map((row) => screen.get(row) ?? '').join('\n') }),
        schedule: (run) => {
            const timer = { run, cancelled: false };
            timers.push(timer);
            return () => {
                timer.cancelled = true;
            };
        }
    });
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    const fire = (): void => {
        for (const timer of timers.splice(0)) if (!timer.cancelled) timer.run();
    };
    return { hover, asked, painted, screen, settle, fire, timers, clock };
}

const LINK: readonly TerminalCellRun[] = [{ row: 2, col: 5, width: 10 }];
const WRAPPED: readonly TerminalCellRun[] = [
    { row: 2, col: 70, width: 10 },
    { row: 3, col: 0, width: 12 }
];

describe('createLinkHover (#303)', () => {
    it('underlines the cells the daemon names, and takes them down off the link', async () => {
        const h = harness();
        h.hover.hover({ row: 2, col: 8 });
        expect(h.asked.map((ask) => ask.cell)).toEqual([{ row: 2, col: 8 }]);
        h.asked[0]?.answer(LINK);
        await h.settle();
        expect(h.painted).toEqual([LINK]);

        h.hover.hover({ row: 2, col: 30 });
        expect(h.painted).toEqual([LINK, null]);
    });

    it('asks nothing while the pointer moves along the link, including onto its next row', async () => {
        const h = harness();
        h.hover.hover({ row: 2, col: 72 });
        h.asked[0]?.answer(WRAPPED);
        await h.settle();
        h.hover.hover({ row: 2, col: 79 });
        h.hover.hover({ row: 3, col: 4 });
        expect(h.asked).toHaveLength(1);
        expect(h.painted).toEqual([WRAPPED]);
    });

    it('does not ask about a cell that is not a link again while its row reads the same', async () => {
        const h = harness();
        h.screen.set(0, '$ ls');
        h.hover.hover({ row: 0, col: 1 });
        h.asked[0]?.answer(null);
        await h.settle();
        h.hover.hover({ row: 1, col: 1 });
        h.asked[1]?.answer(null);
        await h.settle();
        h.hover.hover({ row: 0, col: 1 });
        expect(h.asked).toHaveLength(2);
        expect(h.painted).toEqual([]);

        // The row now holds a link: the old "no" is about text that is gone.
        h.hover.hover({ row: 1, col: 1 });
        h.screen.set(0, 'https://example.com/');
        h.hover.hover({ row: 0, col: 1 });
        expect(h.asked).toHaveLength(3);
    });

    it('asks again about a cell that was not a link once the answer is a couple of seconds old', async () => {
        // An agent just wrote the `.md` file the row names: the row reads the same, the answer does not.
        const h = harness({ missMs: 2_000 });
        h.screen.set(0, 'see notes.md');
        h.hover.hover({ row: 0, col: 6 });
        h.asked[0]?.answer(null);
        await h.settle();
        h.hover.hover({ row: 1, col: 0 });
        h.asked[1]?.answer(null);
        await h.settle();
        h.clock.now = 2_500;
        h.hover.hover({ row: 0, col: 6 });
        expect(h.asked).toHaveLength(3);
    });

    it('treats the cell it asked about as on the link, even where the answer trimmed it off', async () => {
        // `https://example.com/a.` - the trailing full stop is not underlined, but the pointer on
        // it is on the URL a ⌘-click there opens: no flicker, no question per visit.
        const h = harness();
        h.screen.set(2, 'see https://example.com/a. now');
        h.hover.hover({ row: 2, col: 25 });
        h.asked[0]?.answer([{ row: 2, col: 4, width: 21 }]);
        await h.settle();
        h.hover.hover({ row: 2, col: 10 });
        h.hover.hover({ row: 2, col: 25 });
        expect(h.asked).toHaveLength(1);
        expect(h.painted).toEqual([[{ row: 2, col: 4, width: 21 }]]);
    });

    it('does not trust the underline along a link whose rows moved without a word', async () => {
        const h = harness();
        h.screen.set(2, 'see https://example.com now');
        h.hover.hover({ row: 2, col: 8 });
        h.asked[0]?.answer(LINK);
        await h.settle();
        // The text changed, but no output was announced (a write the pane never heard about).
        h.screen.set(2, 'different text on the row');
        h.hover.hover({ row: 2, col: 9 });
        expect(h.painted).toEqual([LINK, null]);
        expect(h.asked).toHaveLength(2);
    });

    it('keeps one question out at a time and asks about the newest cell when it lands', async () => {
        const h = harness();
        h.hover.hover({ row: 0, col: 1 });
        h.hover.hover({ row: 0, col: 2 });
        h.hover.hover({ row: 2, col: 9 });
        expect(h.asked).toHaveLength(1);
        h.asked[0]?.answer(null);
        await h.settle();
        expect(h.asked.map((ask) => ask.cell)).toEqual([
            { row: 0, col: 1 },
            { row: 2, col: 9 }
        ]);
        h.asked[1]?.answer(LINK);
        await h.settle();
        expect(h.painted).toEqual([LINK]);
    });

    it('never paints an answer about a cell the pointer has already left', async () => {
        const h = harness();
        h.hover.hover({ row: 2, col: 8 });
        h.hover.hover({ row: 6, col: 0 });
        h.asked[0]?.answer(LINK);
        await h.settle();
        expect(h.painted).toEqual([]);
    });

    it('paints an answer the pointer has moved along, since it is the same link', async () => {
        const h = harness();
        h.hover.hover({ row: 2, col: 8 });
        h.hover.hover({ row: 2, col: 9 });
        h.asked[0]?.answer(LINK);
        await h.settle();
        expect(h.painted).toEqual([LINK]);
        expect(h.asked).toHaveLength(1);
    });

    /**
     * An agent pane prints all the time. Output that does not touch the hovered or underlined
     * rows cannot change the answer, so it must cost nothing: no probe, no repaint.
     */
    it('ignores output that leaves the rows it is looking at alone', async () => {
        const h = harness();
        h.screen.set(2, 'see https://example.com now');
        h.hover.hover({ row: 2, col: 8 });
        h.asked[0]?.answer(LINK);
        await h.settle();
        for (let frame = 0; frame < 10; frame++) {
            h.screen.set(9, `✻ Thinking… ${String(frame)}s`);
            h.hover.contentChanged();
        }
        h.fire();
        expect(h.asked).toHaveLength(1);
        expect(h.painted).toEqual([LINK]);
    });

    it('takes the underline down when its row changes, then asks again', async () => {
        const h = harness();
        h.screen.set(2, 'see https://example.com now');
        h.hover.hover({ row: 2, col: 8 });
        h.asked[0]?.answer(LINK);
        await h.settle();

        // Output scrolled the link up a row, under a pointer that did not move. A burst of
        // output is one comparison, made once the engine has had a moment to parse it.
        h.screen.set(2, 'next line of output');
        h.hover.contentChanged();
        h.hover.contentChanged();
        expect(h.painted).toEqual([LINK]);
        h.fire();
        expect(h.painted).toEqual([LINK, null]);
        expect(h.asked).toHaveLength(2);
        h.asked[1]?.answer(null);
        await h.settle();
        expect(h.painted).toEqual([LINK, null]);
    });

    /**
     * The pane is told the moment bytes arrive, and the engine may parse them a beat later (a
     * mount flush, a replay fed in chunks). Comparing at once would read the old text and miss
     * the change for good, leaving the underline under whatever replaced the link.
     */
    it('compares the rows after the output has landed, not when it was announced', async () => {
        const h = harness();
        h.screen.set(2, 'see https://example.com now');
        h.hover.hover({ row: 2, col: 8 });
        h.asked[0]?.answer(LINK);
        await h.settle();

        h.hover.contentChanged();
        h.screen.set(2, 'parsed after the announcement');
        h.fire();
        expect(h.painted).toEqual([LINK, null]);
    });

    it('watches every row of a wrapped link, not only the hovered one', async () => {
        const h = harness();
        h.hover.hover({ row: 2, col: 72 });
        h.asked[0]?.answer(WRAPPED);
        await h.settle();
        h.screen.set(3, 'the tail row was redrawn');
        h.hover.contentChanged();
        h.fire();
        expect(h.painted).toEqual([WRAPPED, null]);
    });

    it('does not paint an answer whose row changed while it was out', async () => {
        const h = harness();
        h.screen.set(2, 'see https://example.com now');
        h.hover.hover({ row: 2, col: 8 });
        h.screen.set(2, 'something else entirely');
        h.hover.contentChanged();
        h.asked[0]?.answer(LINK);
        await h.settle();
        expect(h.painted).toEqual([]);
        h.fire();
        expect(h.asked).toHaveLength(2);
    });

    it('treats every frame as a change when the rows cannot be read', async () => {
        const h = harness({ snapshot: false });
        h.hover.hover({ row: 2, col: 8 });
        h.asked[0]?.answer(LINK);
        await h.settle();
        h.hover.contentChanged();
        h.fire();
        expect(h.painted).toEqual([LINK, null]);
        h.asked[1]?.answer(LINK);
        await h.settle();
        expect(h.painted).toEqual([LINK, null, LINK]);
    });

    it('clears at once, and an answer from before the clear never paints', async () => {
        const h = harness();
        h.hover.hover({ row: 2, col: 8 });
        h.hover.clear();
        h.asked[0]?.answer(LINK);
        await h.settle();
        expect(h.painted).toEqual([]);

        // Hovering again after the clear asks afresh, once the void answer is in.
        h.hover.hover({ row: 2, col: 8 });
        await h.settle();
        expect(h.asked).toHaveLength(2);
    });

    it('asks afresh for a pointer that came back while a voided answer was out', async () => {
        const h = harness();
        h.hover.hover({ row: 2, col: 8 });
        h.hover.clear();
        h.hover.hover({ row: 2, col: 8 });
        expect(h.asked).toHaveLength(1);
        h.asked[0]?.answer(LINK);
        await h.settle();
        expect(h.painted).toEqual([]);
        expect(h.asked).toHaveLength(2);
        h.asked[1]?.answer(LINK);
        await h.settle();
        expect(h.painted).toEqual([LINK]);
    });

    it('treats a failed probe as no link', async () => {
        const h = harness();
        h.hover.hover({ row: 2, col: 8 });
        h.asked[0]?.fail();
        await h.settle();
        expect(h.painted).toEqual([]);
        h.hover.hover({ row: 2, col: 9 });
        h.asked[1]?.fail();
        await h.settle();
        h.hover.hover({ row: 2, col: 8 });
        expect(h.asked).toHaveLength(2);
    });

    it('does nothing after dispose', async () => {
        const h = harness();
        h.hover.hover({ row: 2, col: 8 });
        h.hover.dispose();
        h.asked[0]?.answer(LINK);
        await h.settle();
        h.hover.hover({ row: 3, col: 1 });
        h.hover.contentChanged();
        expect(h.painted).toEqual([]);
        expect(h.asked).toHaveLength(1);
    });
});

describe('linkSpanFromReply (#303)', () => {
    it('reads the span of an answer the click would act on', () => {
        expect(linkSpanFromReply({ ok: true, opened: 'external', span: [{ row: 1, col: 2, width: 3 }] })).toEqual([
            { row: 1, col: 2, width: 3 }
        ]);
    });

    it('reads everything else as no link, including a daemon that predates the verb', () => {
        expect(linkSpanFromReply({ ok: true, opened: 'none' })).toBeNull();
        expect(linkSpanFromReply({ ok: false, error: 'unknown command: probe-terminal-target' })).toBeNull();
        expect(linkSpanFromReply({ ok: true, span: [] })).toBeNull();
        expect(linkSpanFromReply({ ok: true, span: [{ row: 1, col: 2 }] })).toBeNull();
        expect(linkSpanFromReply({ ok: true, span: [{ row: -1, col: 2, width: 3 }] })).toBeNull();
        expect(linkSpanFromReply(null)).toBeNull();
    });
});
