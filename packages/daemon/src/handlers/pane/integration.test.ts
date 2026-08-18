/**
 * The pane handlers against the REAL terminal-state service and the REAL input encoder:
 * the composition boot performs. Only the PTY is stubbed (its bytes are the assertion).
 */

import { describe, expect, it } from 'vitest';

import { createTerminalInput } from '../../pty/index.js';
import { createTerminalStateService } from '../../term/index.js';
import type { PaneHandlerContext } from './context.js';
import { handlePaneCapture, handlePaneSend, handlePaneSendKey } from './index.js';
import { W1, harness, seedSplit, seedWorkspace, stubReply, testID } from './testing.js';

const P1 = testID('1', 1);
const P2 = testID('2', 2);
const encoder = new TextEncoder();

async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

function wired() {
    const h = harness();
    seedWorkspace(h, { id: W1, name: 'dev', paneID: P1 });
    seedSplit(h, { workspaceID: W1, sourcePaneID: P1, paneID: P2, label: 'worker-1' });
    const term = createTerminalStateService();
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
        await settle();

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
        await settle();

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
