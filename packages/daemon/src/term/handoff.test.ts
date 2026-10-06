/**
 * Checkpoint and restore for the terminal host handoff (`docs/terminal-host.md` §5, §7).
 */

import { describe, expect, it } from 'vitest';

import type { OscNotification } from './osc-notify.js';
import { createTerminalStateService, type TerminalStateServiceImpl } from './service.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function service(options: Parameters<typeof createTerminalStateService>[0] = {}): TerminalStateServiceImpl {
    return createTerminalStateService({ defaultCols: 40, defaultRows: 8, ...options });
}

/** Checkpoint `from`, restore into a fresh service, and return both captures. */
async function roundTrip(from: TerminalStateServiceImpl, pane = 'P'): Promise<{ before: string; after: string; to: TerminalStateServiceImpl }> {
    const checkpoint = await from.checkpointAsync(pane);
    if (checkpoint === null) throw new Error('no checkpoint');
    const to = service();
    to.attach(pane, checkpoint.cols, checkpoint.rows);
    to.restore(pane, checkpoint);
    return {
        before: await from.captureAsync(pane, { scrollback: true }),
        after: await to.captureAsync(pane, { scrollback: true }),
        to
    };
}

describe('terminal checkpoints', () => {
    it('rebuild the screen and scrollback in a fresh terminal', async () => {
        const from = service();
        from.attach('P', 40, 8);
        for (let line = 0; line < 20; line += 1) from.feed('P', bytes(`line ${String(line)}\r\n`));
        from.feed('P', bytes('\x1b[1;31mred\x1b[0m prompt$ '));
        const { before, after } = await roundTrip(from);
        expect(after).toBe(before);
        expect(after).toContain('line 0');
        expect(after).toContain('red prompt$');
    });

    it('rebuild an alternate screen with its scroll region, hidden cursor and modes', async () => {
        const from = service();
        from.attach('P', 40, 8);
        from.feed('P', bytes('shell history\r\n'));
        // A full-screen app: alternate screen, bracketed paste, app cursor keys, a scroll
        // region, a hidden cursor, kitty flags and SGR mouse.
        from.feed('P', bytes('\x1b[?1049h\x1b[?2004h\x1b[?1h\x1b[2;6r\x1b[?25l\x1b[>5u\x1b[?1000h\x1b[?1006h'));
        from.feed('P', bytes('\x1b[1;1HTUI header\x1b[3;1Hbody'));
        const { before, after, to } = await roundTrip(from);
        expect(after).toBe(before);
        const modes = await to.modesAsync('P');
        expect(modes).toEqual(await from.modesAsync('P'));
        expect(modes).toMatchObject({
            applicationCursorKeys: true,
            bracketedPaste: true,
            mouseTracking: 'vt200',
            mouseFormat: 'sgr'
        });
        expect(modes.kittyKeyboardFlags).toBeGreaterThan(0);
        const core = (to as unknown as { panes: Map<string, { term: { _core: { buffer: { scrollTop: number; scrollBottom: number }; coreService: { isCursorHidden: boolean } } } }> })
            .panes.get('P')!.term._core;
        expect([core.buffer.scrollTop, core.buffer.scrollBottom]).toEqual([1, 5]);
        expect(core.coreService.isCursorHidden).toBe(true);
    });

    it('step back over an unfinished escape sequence or character', async () => {
        const csi = service();
        csi.attach('P', 40, 8);
        csi.feed('P', bytes('hello\x1b[3'));
        expect((await csi.checkpointAsync('P'))?.tailBack).toBe(3);

        const osc = service();
        osc.attach('P', 40, 8);
        osc.feed('P', bytes('x\x1b]0;half a title'));
        expect((await osc.checkpointAsync('P'))?.tailBack).toBe('\x1b]0;half a title'.length);

        const utf8 = service();
        utf8.attach('P', 40, 8);
        utf8.feed('P', Uint8Array.of(0x61, 0xe2, 0x82)); // "a" then two bytes of "€"
        expect((await utf8.checkpointAsync('P'))?.tailBack).toBe(2);

        const clean = service();
        clean.attach('P', 40, 8);
        clean.feed('P', bytes('done\x1b[0m'));
        expect((await clean.checkpointAsync('P'))?.tailBack).toBe(0);
    });

    it('a restored screen followed by the replayed tail reads as if nothing happened', async () => {
        const from = service();
        from.attach('P', 40, 8);
        from.feed('P', bytes('before \x1b[1'));
        const checkpoint = (await from.checkpointAsync('P'))!;
        const to = service();
        to.attach('P', checkpoint.cols, checkpoint.rows);
        to.restore('P', checkpoint);
        // What the host sends from the stepped-back offset: the unfinished sequence, then more.
        to.feed('P', bytes('\x1b[1mbold\x1b[0m after'));
        expect(await to.captureAsync('P', { scrollback: false })).toContain('before bold after');
        expect(await to.captureAsync('P', { scrollback: false })).not.toContain('[1');
    });
});

describe('replayed output', () => {
    it('never answers a kitty query it replays, but answers live ones', async () => {
        const replies: string[] = [];
        const terminal = service({ onQueryReply: (_pane, reply) => replies.push(new TextDecoder().decode(reply)) });
        terminal.attach('P', 40, 8);
        terminal.markReplay('P', 4, false);
        terminal.feed('P', bytes('\x1b[?u'));
        await terminal.flush('P');
        expect(replies).toEqual([]);
        terminal.feed('P', bytes('\x1b[?u'));
        await terminal.flush('P');
        expect(replies).toEqual(['\x1b[?0u']);
    });

    it('keeps notifications from a quiet replay, and from a restore', async () => {
        const notes: OscNotification[] = [];
        const terminal = service({ onOscNotification: (_pane, note) => notes.push(note) });
        terminal.attach('P', 40, 8);
        const quiet = '\x1b]9;already posted\x07';
        terminal.markReplay('P', quiet.length, true);
        terminal.feed('P', bytes(quiet));
        terminal.feed('P', bytes('\x1b]9;new one\x07'));
        await terminal.flush('P');
        expect(notes.map((note) => note.body)).toEqual(['new one']);
    });
});
