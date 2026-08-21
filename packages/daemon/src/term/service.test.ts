import pty from 'node-pty';
import { afterEach, describe, expect, it } from 'vitest';

import { TerminalStateServiceImpl } from './service.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const services: TerminalStateServiceImpl[] = [];

function makeService(options?: ConstructorParameters<typeof TerminalStateServiceImpl>[0]): TerminalStateServiceImpl {
    const service = options ? new TerminalStateServiceImpl(options) : new TerminalStateServiceImpl();
    services.push(service);
    return service;
}

/** Feed a chunk as bytes (the real PTY path) and wait for the emulator to parse it. */
async function write(service: TerminalStateServiceImpl, paneID: string, data: string): Promise<void> {
    service.feed(paneID, encoder.encode(data));
    await service.flush(paneID);
}

afterEach(() => {
    for (const service of services.splice(0)) service.disposeAll();
});

describe('TerminalStateServiceImpl — capture', () => {
    it('strips SGR colors and returns plain text', async () => {
        const service = makeService();
        service.attach('p', 40, 10);
        await write(service, 'p', 'hello \x1b[1;31mred\x1b[0m world');

        expect(service.capture('p', { scrollback: false })).toBe('hello red world');
    });

    it('honours cursor movement and preserves interior blank columns', async () => {
        const service = makeService();
        service.attach('p', 20, 6);
        // CUP to row 3 col 5, write "xy"; then CHA to column 10 on row 4 after a "a".
        await write(service, 'p', '\x1b[3;5Hxy\r\n a\x1b[10Gb');

        expect(service.capture('p', { scrollback: false })).toBe(['', '', '    xy', ' a       b'].join('\n'));
    });

    it('trims trailing blank lines but keeps interior ones', async () => {
        const service = makeService();
        service.attach('p', 20, 10);
        await write(service, 'p', 'a\r\n\r\nb\r\n\r\n\r\n');

        expect(service.capture('p', { scrollback: false })).toBe('a\n\nb');
    });

    it('returns an empty string for an untouched terminal and for unknown panes', async () => {
        const service = makeService();
        service.attach('p', 20, 6);
        await service.flush('p');

        expect(service.capture('p', { scrollback: false })).toBe('');
        expect(service.capture('p', { scrollback: true })).toBe('');
        expect(service.capture('nope', { scrollback: true })).toBe('');
        expect(service.has('nope')).toBe(false);
    });

    it('re-joins soft-wrapped rows into one logical line', async () => {
        const service = makeService();
        service.attach('p', 20, 6);
        const long = 'x'.repeat(30);
        await write(service, 'p', `${long}\r\nshort`);

        expect(service.capture('p', { scrollback: false })).toBe(`${long}\nshort`);
    });

    it('reads the viewport by default and the whole buffer with scrollback', async () => {
        const service = makeService();
        service.attach('p', 40, 24);
        for (let i = 1; i <= 100; i++) service.feed('p', encoder.encode(`line ${i}\r\n`));
        await service.flush('p');

        const viewport = service.capture('p', { scrollback: false }).split('\n');
        const full = service.capture('p', { scrollback: true }).split('\n');

        // 24 visible rows, the last of which holds the (blank) cursor line -> trimmed.
        expect(viewport).toHaveLength(23);
        expect(viewport[0]).toBe('line 78');
        expect(viewport.at(-1)).toBe('line 100');

        expect(full).toHaveLength(100);
        expect(full[0]).toBe('line 1');
        expect(full.at(-1)).toBe('line 100');
    });

    it('captures a full 10 000-line scrollback', async () => {
        const service = makeService();
        service.attach('p', 40, 24);
        for (let i = 1; i <= 10_000; i++) service.feed('p', encoder.encode(`line ${i}\r\n`));
        await service.flush('p');

        const full = service.capture('p', { scrollback: true }).split('\n');
        expect(full).toHaveLength(10_000);
        expect(full[0]).toBe('line 1');
        expect(full.at(-1)).toBe('line 10000');
    });

    it('drops history beyond the configured scrollback depth', async () => {
        const service = makeService({ scrollback: 100 });
        service.attach('p', 40, 24);
        for (let i = 1; i <= 500; i++) service.feed('p', encoder.encode(`line ${i}\r\n`));
        await service.flush('p');

        const full = service.capture('p', { scrollback: true }).split('\n');
        expect(full.length).toBeLessThanOrEqual(124);
        expect(full.at(-1)).toBe('line 500');
        expect(full).not.toContain('line 1');
    });

    it('follows the alternate screen and restores the primary buffer on exit', async () => {
        const service = makeService();
        service.attach('p', 30, 8);
        await write(service, 'p', 'primary content\r\n');
        await write(service, 'p', '\x1b[?1049h\x1b[2J\x1b[H'); // enter alt screen, clear, home
        await write(service, 'p', 'ALT SCREEN');

        expect(service.capture('p', { scrollback: false })).toBe('ALT SCREEN');
        // The alt buffer has no scrollback: the primary history is not visible from it.
        expect(service.capture('p', { scrollback: true })).toBe('ALT SCREEN');

        await write(service, 'p', '\x1b[?1049l'); // leave alt screen
        expect(service.capture('p', { scrollback: false })).toBe('primary content');
        expect(service.capture('p', { scrollback: true })).toBe('primary content');
    });

    it('survives resize, keeping wrapped content joined', async () => {
        const service = makeService();
        service.attach('p', 20, 6);
        const long = 'abcdefghij'.repeat(3); // 30 chars -> wraps at 20 cols
        await write(service, 'p', long);

        expect(service.capture('p', { scrollback: false })).toBe(long);
        expect(service.gridSize('p')).toEqual({ cols: 20, rows: 6 });

        service.resize('p', 40, 6);
        await service.flush('p');

        // @xterm/headless does not reflow, so the wrap point survives the widen; the
        // capture still reads as one logical line because padded rows are trimmed.
        expect(service.gridSize('p')).toEqual({ cols: 40, rows: 6 });
        expect(service.capture('p', { scrollback: false })).toBe(long);

        // Later output lands at the new width.
        await write(service, 'p', '\r\n' + 'y'.repeat(35));
        expect(service.capture('p', { scrollback: false })).toBe(`${long}\n${'y'.repeat(35)}`);
    });

    it('keeps the grid at xterm’s minimum instead of zero', async () => {
        const service = makeService();
        service.attach('p', 0, 0);
        expect(service.gridSize('p')).toEqual({ cols: 2, rows: 1 });

        service.resize('p', 0, -5);
        expect(service.gridSize('p')).toEqual({ cols: 2, rows: 1 });

        service.resize('p', Number.NaN, Number.NaN);
        expect(service.gridSize('p')).toEqual({ cols: 2, rows: 1 });

        service.resize('p', 30, 10);
        await write(service, 'p', 'ok');
        expect(service.gridSize('p')).toEqual({ cols: 30, rows: 10 });
        expect(service.capture('p', { scrollback: false })).toBe('ok');
    });
});

describe('TerminalStateServiceImpl — modes', () => {
    it('tracks DECCKM set/reset', async () => {
        const service = makeService();
        service.attach('p', 20, 5);
        expect(service.modes('p').applicationCursorKeys).toBe(false);

        await write(service, 'p', '\x1b[?1h');
        expect(service.modes('p').applicationCursorKeys).toBe(true);

        await write(service, 'p', '\x1b[?1l');
        expect(service.modes('p').applicationCursorKeys).toBe(false);
    });

    it('tracks bracketed paste on/off', async () => {
        const service = makeService();
        service.attach('p', 20, 5);
        expect(service.modes('p').bracketedPaste).toBe(false);

        await write(service, 'p', '\x1b[?2004h');
        expect(service.modes('p').bracketedPaste).toBe(true);

        await write(service, 'p', '\x1b[?2004l');
        expect(service.modes('p').bracketedPaste).toBe(false);
    });

    it('modesAsync flushes pending writes first', async () => {
        const service = makeService();
        service.attach('p', 20, 5);
        service.feed('p', encoder.encode('\x1b[?1h\x1b[?2004h'));

        await expect(service.modesAsync('p')).resolves.toEqual({
            applicationCursorKeys: true,
            bracketedPaste: true,
            mouseTracking: 'none',
            mouseFormat: 'x10',
            kittyKeyboardFlags: 0
        });
    });

    it('reports idle modes for unknown panes', () => {
        const service = makeService();
        expect(service.modes('gone')).toEqual({
            applicationCursorKeys: false,
            bracketedPaste: false,
            mouseTracking: 'none',
            mouseFormat: 'x10',
            kittyKeyboardFlags: 0
        });
    });
});

describe('TerminalStateServiceImpl — snapshot', () => {
    it('round-trips screen, scrollback and modes through a second headless terminal', async () => {
        const service = makeService();
        service.attach('source', 40, 10);
        for (let i = 1; i <= 30; i++) {
            await write(service, 'source', `\x1b[3${i % 8}mline ${i}\x1b[0m\r\n`);
        }
        await write(service, 'source', '\x1b[?1h\x1b[?2004h');
        await write(service, 'source', '\x1b[4;10Hmid-screen edit');

        const snap = await service.snapshotAsync('source');
        expect(snap.cols).toBe(40);
        expect(snap.rows).toBe(10);
        expect(snap.data.byteLength).toBeGreaterThan(0);

        // Replay into a second, fresh terminal of the same size (what a client does).
        const replay = makeService();
        replay.attach('replay', snap.cols, snap.rows);
        replay.feed('replay', snap.data);
        await replay.flush('replay');

        expect(replay.capture('replay', { scrollback: false })).toBe(
            service.capture('source', { scrollback: false })
        );
        expect(replay.capture('replay', { scrollback: true })).toBe(
            service.capture('source', { scrollback: true })
        );
        expect(replay.modes('replay')).toEqual(service.modes('source'));

        // The serialized form is a VT stream, i.e. it carries the SGR attributes too.
        expect(decoder.decode(snap.data)).toContain('\x1b[');
    });

    it('caps snapshot scrollback when configured', async () => {
        const service = makeService({ snapshotScrollbackLines: 0 });
        service.attach('p', 30, 5);
        for (let i = 1; i <= 200; i++) service.feed('p', encoder.encode(`line ${i}\r\n`));
        const snap = await service.snapshotAsync('p');

        const replay = makeService();
        replay.attach('r', snap.cols, snap.rows);
        replay.feed('r', snap.data);
        await replay.flush('r');

        // Only the viewport survives; history was excluded from the snapshot.
        expect(replay.capture('r', { scrollback: true })).toBe(service.capture('p', { scrollback: false }));
        expect(replay.capture('r', { scrollback: true })).not.toContain('line 1\n');
    });

    it('returns an empty snapshot for unknown panes', () => {
        const service = makeService();
        expect(service.snapshot('gone')).toEqual({ data: new Uint8Array(0), cols: 0, rows: 0 });
        expect(service.gridSize('gone')).toBeNull();
    });
});

describe('TerminalStateServiceImpl — lifecycle', () => {
    it('is idempotent per paneID and never resets live state', async () => {
        const service = makeService();
        service.attach('p', 30, 8);
        await write(service, 'p', 'important output');

        service.attach('p', 30, 8);
        expect(service.capture('p', { scrollback: false })).toBe('important output');
        expect(service.paneIDs()).toEqual(['p']);

        // Re-attaching with a different geometry re-asserts the grid, keeping the content.
        service.attach('p', 50, 12);
        await service.flush('p');
        expect(service.gridSize('p')).toEqual({ cols: 50, rows: 12 });
        expect(service.capture('p', { scrollback: false })).toBe('important output');
    });

    it('keeps consuming output with zero clients attached (lazy create on feed)', async () => {
        const service = makeService();
        await write(service, 'orphan', 'daemon still owns this');

        expect(service.has('orphan')).toBe(true);
        expect(service.capture('orphan', { scrollback: false })).toBe('daemon still owns this');
        expect(service.gridSize('orphan')).toEqual({ cols: 80, rows: 24 });
    });

    it('captureAsync observes bytes fed moments earlier', async () => {
        const service = makeService();
        service.attach('p', 30, 6);
        service.feed('p', encoder.encode('first '));
        service.feed('p', 'second'); // string feeds are accepted too

        await expect(service.captureAsync('p', { scrollback: false })).resolves.toBe('first second');
    });

    it('drops all state on dispose and tolerates double dispose', async () => {
        const service = makeService();
        service.attach('p', 30, 6);
        await write(service, 'p', 'transient');

        service.dispose('p');
        service.dispose('p');
        service.dispose('never-existed');

        expect(service.has('p')).toBe(false);
        expect(service.paneIDs()).toEqual([]);
        expect(service.capture('p', { scrollback: true })).toBe('');
        expect(service.snapshot('p').data.byteLength).toBe(0);
        expect(service.ringTail('p').byteLength).toBe(0);
    });

    it('never strands a flush when the pane is disposed mid-write', async () => {
        const service = makeService();
        service.attach('p', 30, 6);
        for (let i = 0; i < 50; i++) service.feed('p', encoder.encode(`chunk ${i}\r\n`));

        const pending = service.flush('p');
        service.dispose('p');
        await expect(pending).resolves.toBeUndefined();
        await expect(service.flush('p')).resolves.toBeUndefined();
    });

    it('disposeAll clears every pane', async () => {
        const service = makeService();
        service.attach('a', 20, 5);
        service.attach('b', 20, 5);
        await write(service, 'a', 'a');
        service.disposeAll();

        expect(service.paneIDs()).toEqual([]);
    });
});

describe('TerminalStateServiceImpl — byte-level feeding', () => {
    it('reassembles a multi-byte character split across two feeds', async () => {
        const service = makeService();
        service.attach('p', 20, 5);
        const emoji = encoder.encode('héllo 🌍');
        const cut = 4; // mid "é" ... mid-sequence split, exactly what a PTY read can do
        service.feed('p', emoji.subarray(0, cut));
        service.feed('p', emoji.subarray(cut));

        await expect(service.captureAsync('p', { scrollback: false })).resolves.toBe('héllo 🌍');
        expect(decoder.decode(service.ringTail('p'))).toBe('héllo 🌍');
    });

    it('ignores empty feeds', async () => {
        const service = makeService();
        service.attach('p', 20, 5);
        service.feed('p', new Uint8Array(0));
        service.feed('p', '');
        await service.flush('p');

        expect(service.capture('p', { scrollback: false })).toBe('');
        expect(service.ringTail('p').byteLength).toBe(0);
    });

    it('captures the output of a real PTY with no client attached', async () => {
        const service = makeService();
        const paneID = 'real-pty';
        service.attach(paneID, 40, 10);

        const child = pty.spawn('/bin/sh', ['-c', 'printf "hello from a real pty\\n"; printf "second line\\n"'], {
            name: 'xterm-256color',
            cols: 40,
            rows: 10,
            cwd: process.cwd(),
            env: { ...process.env } as Record<string, string>
        });
        child.onData((chunk) => service.feed(paneID, chunk));
        const exitCode = await new Promise<number>((resolve) => {
            child.onExit(({ exitCode: code }) => resolve(code));
        });
        await service.flush(paneID);

        expect(exitCode).toBe(0);
        expect(service.capture(paneID, { scrollback: false }).split('\n')).toEqual([
            'hello from a real pty',
            'second line'
        ]);
    });
});

describe('TerminalStateServiceImpl — raw ring buffer', () => {
    it('keeps a byte-perfect tail of raw output alongside the VT state', async () => {
        const service = makeService();
        service.attach('p', 30, 6);
        await write(service, 'p', '\x1b[32mgreen\x1b[0m\r\n');

        expect(decoder.decode(service.ringTail('p'))).toBe('\x1b[32mgreen\x1b[0m\r\n');
        expect(decoder.decode(service.ringTail('p', 5))).toBe('[0m\r\n');
    });

    it('evicts oldest raw bytes at the configured capacity without harming capture', async () => {
        const service = makeService({ ringCapacityBytes: 32 });
        service.attach('p', 40, 24);
        for (let i = 1; i <= 20; i++) await write(service, 'p', `line ${i}\r\n`);

        const tail = service.ringTail('p');
        expect(tail.byteLength).toBe(32);
        expect(decoder.decode(tail)).toContain('line 20\r\n');
        expect(decoder.decode(tail)).not.toContain('line 1\r\n');

        // The VT state is unaffected by ring eviction.
        expect(service.capture('p', { scrollback: true }).split('\n')).toHaveLength(20);
    });
});
