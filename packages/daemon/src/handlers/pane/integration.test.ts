/**
 * The pane handlers against the REAL terminal-state service and the REAL input encoder:
 * the composition boot performs. Only the PTY is stubbed (its bytes are the assertion).
 */

import { describe, expect, it, vi } from 'vitest';

import { createTerminalInput } from '../../pty/index.js';
import { createTerminalStateService, type TerminalStateOptions } from '../../term/index.js';
import type { PaneHandlerContext } from './context.js';
import { handlePaneCapture, handlePaneSend, handlePaneSendKey } from './index.js';
import { W1, harness, seedSplit, seedWorkspace, stubReply, testID, type TestReply } from './testing.js';

const P1 = testID('1', 1);
const P2 = testID('2', 2);
const encoder = new TextEncoder();

async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

function wired(options?: TerminalStateOptions) {
    const h = harness();
    seedWorkspace(h, { id: W1, name: 'dev', paneID: P1 });
    seedSplit(h, { workspaceID: W1, sourcePaneID: P1, paneID: P2, label: 'worker-1' });
    const term = createTerminalStateService(options);
    const input = createTerminalInput({ pty: h.pty, modes: (paneID) => term.modes(paneID) });
    const ctx: PaneHandlerContext = { ...h.ctx, term, input };
    term.attach(P2, 80, 24);
    return { h, term, ctx };
}

describe('pane handlers over the real terminal seams', () => {
    it('captures what the pane actually printed, viewport and scrollback', async () => {
        const { term, ctx } = wired();
        for (let i = 1; i <= 30; i++) term.feed(P2, encoder.encode(`line ${i}\r\n`));

        const viewport = stubReply();
        handlePaneCapture({ command: 'pane-capture', target: P2, scrollback: false }, ctx, viewport);
        const full = stubReply();
        handlePaneCapture({ command: 'pane-capture', target: P2, scrollback: true }, ctx, full);
        await vi.waitFor(() => expect(viewport.closed && full.closed).toBe(true));

        const viewportText = viewport.only()['text'] as string;
        const fullText = full.only()['text'] as string;
        expect(viewportText.split('\n')).toHaveLength(23); // 24 rows, last one still blank
        expect(viewportText.endsWith('line 30')).toBe(true);
        expect(viewportText.startsWith('line 8')).toBe(true);
        expect(fullText.split('\n')[0]).toBe('line 1');
        expect(fullText.split('\n')).toHaveLength(30);
    });

    it('tails the real capture to --lines', async () => {
        const { term, ctx } = wired();
        for (let i = 1; i <= 5; i++) term.feed(P2, encoder.encode(`line ${i}\r\n`));

        const reply = stubReply();
        handlePaneCapture({ command: 'pane-capture', target: P2, lines: 2, scrollback: false }, ctx, reply);
        await vi.waitFor(() => expect(reply.closed).toBe(true));

        expect(reply.only()['text']).toBe('line 4\nline 5');
    });

    it('sends text then Enter as a separate keystroke, unwrapped by default', () => {
        const { h, ctx } = wired();
        handlePaneSend(
            { command: 'pane-send', target: P2, text: 'ls -al', bare: false },
            ctx,
            stubReply()
        );

        expect(h.pty.writes).toEqual([
            { paneID: P2, data: 'ls -al' },
            { paneID: P2, data: '\r' }
        ]);
    });

    it('wraps in a bracketed-paste envelope once the app enables it, with Enter OUTSIDE', async () => {
        const { h, term, ctx } = wired();
        term.feed(P2, encoder.encode('\x1b[?2004h'));
        await settle();

        handlePaneSend({ command: 'pane-send', target: P2, text: 'hello', bare: false }, ctx, stubReply());

        expect(h.pty.writes).toEqual([
            { paneID: P2, data: '\x1b[200~hello\x1b[201~' },
            { paneID: P2, data: '\r' }
        ]);
    });

    it('--bare writes the text alone', () => {
        const { h, ctx } = wired();
        handlePaneSend({ command: 'pane-send', target: P2, text: 'ls /tm', bare: true }, ctx, stubReply());
        expect(h.pty.writes).toEqual([{ paneID: P2, data: 'ls /tm' }]);
    });

    it('encodes ctrl-c as the raw byte and arrows per live DECCKM state', async () => {
        const { h, term, ctx } = wired();

        handlePaneSendKey({ command: 'pane-send-key', target: P2, key: 'ctrl-c' }, ctx, stubReply());
        handlePaneSendKey({ command: 'pane-send-key', target: P2, key: 'up' }, ctx, stubReply());
        term.feed(P2, encoder.encode('\x1b[?1h')); // DECCKM on
        await settle();
        handlePaneSendKey({ command: 'pane-send-key', target: P2, key: 'up' }, ctx, stubReply());

        expect(h.pty.writes).toEqual([
            { paneID: P2, data: '\x03' },
            { paneID: P2, data: '\x1b[A' },
            { paneID: P2, data: '\x1bOA' }
        ]);
    });
});

/** Capture P2 through the real handler and wait for the reply. */
async function capture(ctx: PaneHandlerContext, extra: { settle_ms?: number } = {}): Promise<Record<string, unknown>> {
    const reply = stubReply();
    handlePaneCapture({ command: 'pane-capture', target: P2, scrollback: false, ...extra }, ctx, reply);
    await vi.waitFor(() => expect(reply.closed).toBe(true), { timeout: 2_000 });
    return reply.only();
}

function guardedSend(ctx: PaneHandlerContext, text: string, revision: number): TestReply {
    const reply = stubReply();
    handlePaneSend({ command: 'pane-send', target: P2, text, bare: false, if_revision: revision }, ctx, reply);
    return reply;
}

describe('screen revision over the real terminal seams (#390)', () => {
    it('refuses a send whose capture is stale, then types once the caller has re-read', async () => {
        const { h, term, ctx } = wired();
        term.feed(P2, encoder.encode('Proceed? [y/n]'));

        const first = await capture(ctx);
        expect(first['text']).toBe('Proceed? [y/n]');
        const seen = first['revision'] as number;

        // Output lands after the capture's read: fed, not even parsed yet.
        term.feed(P2, encoder.encode('\r\nAre you sure? [y/n]'));
        const refused = guardedSend(ctx, 'y', seen);

        expect(refused.only()).toEqual({
            ok: false,
            error: 'screen changed',
            code: 'SCREEN_CHANGED',
            revision: seen + 1
        });
        expect(h.pty.writes).toEqual([]);

        const second = await capture(ctx);
        expect(second['text']).toBe('Proceed? [y/n]\nAre you sure? [y/n]');
        const typed = guardedSend(ctx, 'y', second['revision'] as number);

        expect(typed.only()).toMatchObject({ ok: true, pane_id: P2, revision: second['revision'] });
        expect(h.pty.writes).toEqual([
            { paneID: P2, data: 'y' },
            { paneID: P2, data: '\r' }
        ]);
    });

    it('reads text and revision of one screen when output lands in the hop after the flush', async () => {
        const { h, term, ctx } = wired();
        term.feed(P2, encoder.encode('Proceed? [y/n]'));
        await term.flush(P2);

        // A feed from a promise continuation (the boot adopt path feeds from one), queued so it
        // runs after the flush saw an idle queue and before an `await flush()` could resume.
        queueMicrotask(() => term.feed(P2, encoder.encode('\r\nAre you sure? [y/n]')));
        const reply = await capture(ctx);
        const seen = reply['revision'] as number;

        // The text and the revision describe the same screen: the second prompt is newer.
        expect(reply['text']).toBe('Proceed? [y/n]');
        const refused = guardedSend(ctx, 'y', seen);
        expect(refused.only()).toMatchObject({ ok: false, code: 'SCREEN_CHANGED', revision: seen + 1 });
        expect(h.pty.writes).toEqual([]);

        const reread = await capture(ctx);
        expect(reread).toMatchObject({ text: 'Proceed? [y/n]\nAre you sure? [y/n]', revision: seen + 1 });
    });

    it('refuses a revision read before the pane was disposed and attached again', async () => {
        const { h, term, ctx } = wired();
        for (const chunk of ['a', 'b', 'c']) term.feed(P2, encoder.encode(chunk));
        const before = await capture(ctx);
        expect(before['text']).toBe('abc');

        // Restart old terminals respawns into the same pane id with fresh terminal state.
        term.dispose(P2);
        term.attach(P2, 80, 24);
        for (const chunk of ['x', 'y', 'z']) term.feed(P2, encoder.encode(chunk));
        const after = await capture(ctx);

        expect(after['text']).toBe('xyz');
        expect(after['revision']).not.toBe(before['revision']);
        const refused = guardedSend(ctx, 'y', before['revision'] as number);
        expect(refused.only()).toMatchObject({ ok: false, code: 'SCREEN_CHANGED', revision: after['revision'] });
        expect(h.pty.writes).toEqual([]);
    });

    it('guards send-key the same way', async () => {
        const { h, term, ctx } = wired();
        const seen = (await capture(ctx))['revision'] as number;
        term.feed(P2, encoder.encode('redraw'));

        const refused = stubReply();
        handlePaneSendKey({ command: 'pane-send-key', target: P2, key: 'enter', if_revision: seen }, ctx, refused);
        expect(refused.only()).toMatchObject({ ok: false, code: 'SCREEN_CHANGED', revision: seen + 1 });
        expect(h.pty.writes).toEqual([]);

        const accepted = stubReply();
        handlePaneSendKey({ command: 'pane-send-key', target: P2, key: 'enter', if_revision: seen + 1 }, ctx, accepted);
        expect(accepted.only()).toMatchObject({ ok: true, key: 'enter', revision: seen + 1 });
        expect(h.pty.writes).toEqual([{ paneID: P2, data: '\r' }]);
    });

    it('counts a resize as a screen change', async () => {
        const { term, ctx } = wired();
        const before = (await capture(ctx))['revision'] as number;

        term.resize(P2, 100, 30);
        const after = (await capture(ctx))['revision'] as number;

        expect(after).toBe(before + 1);
    });

    it('reports the cursor and the alternate screen the pane is really on', async () => {
        const { term, ctx } = wired();
        term.feed(P2, encoder.encode('$ ls'));
        expect(await capture(ctx)).toMatchObject({ cursor: { row: 0, col: 4 }, alt_screen: false });

        // A full-screen app: alternate screen, then the cursor to row 5, column 10 (1-based).
        term.feed(P2, encoder.encode('\x1b[?1049h\x1b[5;10H'));
        expect(await capture(ctx)).toMatchObject({ cursor: { row: 4, col: 9 }, alt_screen: true });

        term.feed(P2, encoder.encode('\x1b[?1049l'));
        expect(await capture(ctx)).toMatchObject({ cursor: { row: 0, col: 4 }, alt_screen: false, text: '$ ls' });
    });

    it('settle_ms answers only after that much quiet, with the screen as it ended', async () => {
        const { term, ctx } = wired();
        const start = term.revision(P2);
        const started = performance.now();
        const pending = capture(ctx, { settle_ms: 60 });
        await new Promise((resolve) => setTimeout(resolve, 20));
        term.feed(P2, encoder.encode('working'));
        await new Promise((resolve) => setTimeout(resolve, 20));
        term.feed(P2, encoder.encode(' done'));
        const fedAt = performance.now();

        const reply = await pending;
        expect(reply).toMatchObject({ ok: true, text: 'working done', settled: true, revision: start + 2 });
        // A timer may fire a millisecond early; 55 of the 60 quiet ms is the floor allowed.
        expect(performance.now() - fedAt).toBeGreaterThanOrEqual(55);
        expect(performance.now() - started).toBeGreaterThanOrEqual(95);
    });

    it('settle_ms gives up at the cap with settled: false while the pane keeps printing', async () => {
        const { term, ctx } = wired({ settleCapMs: 150 });
        let ticks = 0;
        const printer = setInterval(() => {
            ticks += 1;
            term.feed(P2, encoder.encode('.'));
        }, 20);
        try {
            const started = performance.now();
            const reply = await capture(ctx, { settle_ms: 100 });

            expect(reply).toMatchObject({ ok: true, settled: false });
            expect(performance.now() - started).toBeGreaterThanOrEqual(140);
            expect(performance.now() - started).toBeLessThan(1_000);
            expect((reply['text'] as string).length).toBeGreaterThan(0);
            expect(ticks).toBeGreaterThan(0);
        } finally {
            clearInterval(printer);
        }
    });

    it('answers pane closed during capture when the pane goes away mid-settle', async () => {
        const { h, term, ctx } = wired();
        const pending = capture(ctx, { settle_ms: 5_000 });
        h.store.dispatch({ type: 'close-pane', workspaceID: W1, paneID: P2 });
        term.dispose(P2);

        expect(await pending).toEqual({ ok: false, error: 'pane closed during capture' });
    });
});
