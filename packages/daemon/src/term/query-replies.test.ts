/**
 * Terminal query replies (#349): the daemon's VT answers device queries the way a real terminal
 * does, on the asking pane's PTY, and only for live output.
 *
 * An application that probes the terminal at startup (crossterm's keyboard-enhancement check sends
 * `CSI ? u` then `CSI c`, and waits for the DA1 reply as its end-of-replies sentinel) hangs when
 * the answer never comes. `@xterm/headless` already composes these replies; the service forwards
 * an allowlist of them, and nothing else (`isForwardedQueryReply` in `@kelpi/protocol`).
 */

import { describe, expect, it } from 'vitest';

import { createTerminalStateService, type TerminalStateServiceImpl } from './service.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function makeService(): { service: TerminalStateServiceImpl; replies: string[] } {
    const replies: string[] = [];
    const service = createTerminalStateService({
        onQueryReply: (_paneID, reply) => {
            replies.push(decoder.decode(reply));
        }
    });
    service.attach('P', 40, 8);
    return { service, replies };
}

async function write(service: TerminalStateServiceImpl, data: string): Promise<void> {
    service.feed('P', encoder.encode(data));
    await service.flush('P');
}

describe('device query replies', () => {
    it('answers Primary Device Attributes (CSI c and CSI 0 c)', async () => {
        const { service, replies } = makeService();
        await write(service, '\x1b[c');
        await write(service, '\x1b[0c');
        expect(replies).toHaveLength(2);
        for (const reply of replies) expect(reply).toMatch(/^\x1b\[\?[\d;]+c$/);
        service.disposeAll();
    });

    it('still ends a kitty probe with the DA1 sentinel (the crossterm sequence)', async () => {
        const { service, replies } = makeService();
        await write(service, '\x1b[?u\x1b[c');
        expect(replies[0]).toBe('\x1b[?0u');
        expect(replies[1]).toMatch(/^\x1b\[\?[\d;]+c$/);
        service.disposeAll();
    });

    it('answers Secondary Device Attributes (CSI > c)', async () => {
        const { service, replies } = makeService();
        await write(service, '\x1b[>c');
        expect(replies).toHaveLength(1);
        expect(replies[0]).toMatch(/^\x1b\[>[\d;]+c$/);
        service.disposeAll();
    });

    it('reports the cursor position from the daemon’s own screen (CSI 6n)', async () => {
        const { service, replies } = makeService();
        await write(service, 'ab\r\ncdef\x1b[6n');
        expect(replies).toEqual(['\x1b[2;5R']);
        service.disposeAll();
    });

    // xterm's pending wrap puts the cursor one past the last column; a real terminal reports the
    // last column, and an application told 41 on a 40-column screen draws off it.
    it('keeps the cursor report on the screen after a line that exactly fills it', async () => {
        const { service, replies } = makeService();
        await write(service, `${'x'.repeat(40)}\x1b[6n\x1b[?6n`);
        expect(replies).toEqual(['\x1b[1;40R', '\x1b[?1;40R']);
        await write(service, '\r\nab\x1b[?6n');
        expect(replies[2]).toBe('\x1b[?2;3R');
        service.disposeAll();
    });

    it('reports status OK (CSI 5n)', async () => {
        const { service, replies } = makeService();
        await write(service, '\x1b[5n');
        expect(replies).toEqual(['\x1b[0n']);
        service.disposeAll();
    });

    // The daemon's VT has no idea of the window's theme, so a colour answer would be a guess, and
    // a wrong background makes an editor pick the wrong palette. Unanswered, apps fall back.
    it('does not answer colour queries (OSC 10 / 11)', async () => {
        const { service, replies } = makeService();
        await write(service, '\x1b]10;?\x07\x1b]11;?\x1b\\');
        expect(replies).toEqual([]);
        service.disposeAll();
    });

    it('never answers a query it replays, but answers live ones', async () => {
        const { service, replies } = makeService();
        service.markReplay('P', 3, false); // exactly the 3 bytes of the replayed query
        service.feed('P', encoder.encode('\x1b[c'));
        await service.flush('P');
        expect(replies).toEqual([]);
        await write(service, '\x1b[c');
        expect(replies).toHaveLength(1);
        service.disposeAll();
    });
});
