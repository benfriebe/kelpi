/**
 * The screen revision and the settle wait (#390): what `pane-capture` reports and what a
 * guarded `pane-send` compares against.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CAPTURE_SETTLE_CAP_MS, TerminalStateServiceImpl } from './service.js';

const encoder = new TextEncoder();

const services: TerminalStateServiceImpl[] = [];

function makeService(options?: ConstructorParameters<typeof TerminalStateServiceImpl>[0]): TerminalStateServiceImpl {
    const service = new TerminalStateServiceImpl(options);
    services.push(service);
    return service;
}

afterEach(() => {
    for (const service of services.splice(0)) service.disposeAll();
    vi.useRealTimers();
});

describe('TerminalStateServiceImpl: revision', () => {
    it('starts new state past every revision the service has issued, and reads 0 with no state', () => {
        const service = makeService({ revisionBase: 0 });
        expect(service.revision('nope')).toBe(0);

        service.attach('a', 80, 24);
        expect(service.revision('a')).toBe(1);
        service.feed('a', 'x');
        service.feed('a', 'y');
        expect(service.revision('a')).toBe(3);
        service.attach('b', 80, 24);
        expect(service.revision('b')).toBe(4);
        // Each bump is +1 on that pane's own value, whatever the other panes are at.
        service.feed('a', 'z');
        expect(service.revision('a')).toBe(4);
        expect(service.revision('nope')).toBe(0);
    });

    it('seeds from the clock by default, so the first revision is past the time it started', () => {
        const startedAfter = Date.now();
        const service = makeService();
        service.attach('a', 80, 24);

        expect(service.revision('a')).toBeGreaterThan(startedAfter);
        expect(Number.isSafeInteger(service.revision('a'))).toBe(true);
        expect(service.revision('nope')).toBe(0);
    });

    it('never lets a service started later reissue a revision an earlier one gave out (restart)', () => {
        vi.useFakeTimers({ now: new Date('2026-10-13T09:00:00Z') });
        const first = makeService();
        first.attach('p', 80, 24);
        const issued = [first.revision('p')];
        for (const chunk of ['a', 'b', 'c']) {
            first.feed('p', chunk);
            issued.push(first.revision('p'));
        }
        first.resize('p', 100, 24);
        issued.push(first.revision('p'));
        first.disposeAll();

        // A second later the handoff or update brings up a new daemon, and with it a new service.
        vi.setSystemTime(Date.now() + 1_000);
        const second = makeService();
        second.attach('p', 80, 24);
        const reissued = [second.revision('p')];
        second.feed('p', 'x');
        reissued.push(second.revision('p'));

        expect(Math.min(...reissued)).toBeGreaterThan(Math.max(...issued));
    });

    it('bumps once per non-empty feed, at enqueue time, before the bytes are parsed', async () => {
        const service = makeService();
        service.attach('p', 80, 24);
        const start = service.revision('p');

        service.feed('p', encoder.encode('one'));
        expect(service.revision('p')).toBe(start + 1);
        service.feed('p', 'two');
        service.feed('p', new Uint8Array(0));
        service.feed('p', '');
        expect(service.revision('p')).toBe(start + 2);

        await service.flush('p');
        expect(service.revision('p')).toBe(start + 2);
        expect(service.capture('p', { scrollback: false })).toBe('onetwo');
    });

    it('counts a replayed feed split across two writes as one bump', () => {
        const service = makeService();
        service.attach('p', 80, 24);
        const start = service.revision('p');
        service.markReplay('p', 3, false);

        service.feed('p', encoder.encode('abcdef'));
        expect(service.revision('p')).toBe(start + 1);
    });

    it('creates a lazily fed pane past every issued revision and counts that first feed', () => {
        const service = makeService();
        service.attach('p', 80, 24);
        service.feed('p', 'abc');
        const highest = service.revision('p');

        service.feed('late', 'hi');
        expect(service.revision('late')).toBe(highest + 2);
    });

    it('bumps on a restore that queues a snapshot, and not on an empty one', async () => {
        const service = makeService();
        service.attach('src', 40, 10);
        service.feed('src', 'saved screen');
        const checkpoint = await service.checkpointAsync('src');
        if (checkpoint === null) throw new Error('no checkpoint');

        service.attach('p', 40, 10);
        const start = service.revision('p');
        service.restore('p', checkpoint);
        expect(service.revision('p')).toBe(start + 1);
        service.restore('p', { ...checkpoint, snapshot: new Uint8Array(0) });
        expect(service.revision('p')).toBe(start + 1);
        service.restore('nope', checkpoint);
        expect(service.revision('nope')).toBe(0);
    });

    it('bumps on a resize that changes the grid, and only then', () => {
        const service = makeService();
        service.attach('p', 80, 24);
        const start = service.revision('p');

        service.resize('p', 80, 24);
        expect(service.revision('p')).toBe(start);
        service.resize('p', 100, 24);
        expect(service.revision('p')).toBe(start + 1);
        service.resize('p', 100, 30);
        expect(service.revision('p')).toBe(start + 2);
        // A re-attach at a new size is a resize too; at the same size it is not.
        service.attach('p', 100, 30);
        expect(service.revision('p')).toBe(start + 2);
        service.attach('p', 90, 30);
        expect(service.revision('p')).toBe(start + 3);
    });

    it('carries on past the old value when the pane is disposed and gets state again', () => {
        const service = makeService();
        service.attach('p', 80, 24);
        service.feed('p', 'x');
        const before = service.revision('p');
        service.dispose('p');
        expect(service.revision('p')).toBe(0);
        service.attach('p', 80, 24);
        expect(service.revision('p')).toBe(before + 1);

        // A late feed after dispose creates the state lazily, and that too starts past it.
        const second = service.revision('p');
        service.dispose('p');
        service.feed('p', 'late');
        expect(service.revision('p')).toBe(second + 2);
    });

    it('never describes two screens with one revision across dispose and re-attach (ABA)', async () => {
        const service = makeService();
        service.attach('p', 80, 24);
        for (const chunk of ['a', 'b', 'c']) service.feed('p', chunk);
        const before = await service.readScreen('p', { scrollback: false });
        expect(before.text).toBe('abc');

        // Restart old terminals and a forgotten shell both dispose and respawn into the same id.
        service.dispose('p');
        service.attach('p', 80, 24);
        const seen = [service.revision('p')];
        for (const chunk of ['x', 'y', 'z']) {
            service.feed('p', chunk);
            seen.push(service.revision('p'));
        }
        const after = await service.readScreen('p', { scrollback: false });

        expect(after.text).toBe('xyz');
        expect(seen).not.toContain(before.revision);
        expect(Math.min(...seen)).toBeGreaterThan(before.revision);
    });
});

describe('TerminalStateServiceImpl: readScreen', () => {
    it('reads the text, revision and cursor of what has been fed so far', async () => {
        const service = makeService();
        service.attach('p', 80, 24);
        service.feed('p', 'one');
        const reading = service.readScreen('p', { scrollback: false });
        service.feed('p', 'two');

        expect(await reading).toEqual({
            text: 'onetwo',
            revision: service.revision('p'),
            cursor: { alternate: false, row: 0, col: 6 }
        });
    });

    it('reads in the same turn as its last queue check, so a feed in a microtask is newer', async () => {
        const service = makeService();
        service.attach('p', 80, 24);
        service.feed('p', 'Proceed? [y/n]');
        await service.flush('p');

        // Queued now, so it runs in the hop an `await flush()` would take before reading.
        queueMicrotask(() => service.feed('p', '\r\nAre you sure? [y/n]'));
        const read = await service.readScreen('p', { scrollback: false });

        expect(read.text).toBe('Proceed? [y/n]');
        expect(service.revision('p')).toBe(read.revision + 1);
        const again = await service.readScreen('p', { scrollback: false });
        expect(again).toMatchObject({ text: 'Proceed? [y/n]\nAre you sure? [y/n]', revision: read.revision + 1 });
    });

    it('follows a pane that is disposed and attached again while it waits', async () => {
        const service = makeService();
        service.attach('p', 80, 24);
        service.feed('p', 'old');
        const reading = service.readScreen('p', { scrollback: false });
        service.dispose('p');
        service.attach('p', 80, 24);
        service.feed('p', 'new');

        expect(await reading).toMatchObject({ text: 'new', revision: service.revision('p') });
    });

    it('reads an unknown pane as empty, revision 0 and no cursor', async () => {
        const service = makeService();
        expect(await service.readScreen('nope', { scrollback: false })).toEqual({ text: '', revision: 0, cursor: null });
    });
});

describe('TerminalStateServiceImpl: settle', () => {
    it('resolves true once quietMs passes with no output, counted from the call', async () => {
        vi.useFakeTimers();
        const service = makeService();
        service.attach('p', 80, 24);
        let result: boolean | undefined;
        void service.settle('p', 100).then((settled) => (result = settled));

        await vi.advanceTimersByTimeAsync(99);
        expect(result).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(result).toBe(true);
    });

    it('restarts the quiet window on every bump, output and resize alike', async () => {
        vi.useFakeTimers();
        const service = makeService();
        service.attach('p', 80, 24);
        let result: boolean | undefined;
        void service.settle('p', 100).then((settled) => (result = settled));

        await vi.advanceTimersByTimeAsync(80);
        service.feed('p', 'more');
        await vi.advanceTimersByTimeAsync(80);
        service.resize('p', 100, 24);
        await vi.advanceTimersByTimeAsync(99);
        expect(result).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(result).toBe(true);
    });

    it('gives up with false at the cap while the pane keeps printing', async () => {
        vi.useFakeTimers();
        const service = makeService({ settleCapMs: 500 });
        service.attach('p', 80, 24);
        let result: boolean | undefined;
        void service.settle('p', 100).then((settled) => (result = settled));

        for (let elapsed = 0; elapsed < 450; elapsed += 50) {
            service.feed('p', '.');
            await vi.advanceTimersByTimeAsync(50);
        }
        expect(result).toBeUndefined();
        await vi.advanceTimersByTimeAsync(50);
        expect(result).toBe(false);
    });

    it('clamps quietMs to the cap, and an untouched pane at the cap still counts as settled', async () => {
        vi.useFakeTimers();
        const service = makeService();
        service.attach('p', 80, 24);
        let result: boolean | undefined;
        void service.settle('p', 60_000).then((settled) => (result = settled));

        await vi.advanceTimersByTimeAsync(CAPTURE_SETTLE_CAP_MS - 1);
        expect(result).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(result).toBe(true);
        expect(CAPTURE_SETTLE_CAP_MS).toBe(10_000);
    });

    it('takes an explicit cap over the default', async () => {
        vi.useFakeTimers();
        const service = makeService();
        service.attach('p', 80, 24);
        let result: boolean | undefined;
        void service.settle('p', 100, 30).then((settled) => (result = settled));

        await vi.advanceTimersByTimeAsync(30);
        expect(result).toBe(true); // quietMs clamped to the 30 ms cap, and nothing printed
    });

    it('resolves true at once for an unknown pane, with no timer armed', async () => {
        vi.useFakeTimers();
        const service = makeService();
        const before = vi.getTimerCount();

        await expect(service.settle('nope', 100)).resolves.toBe(true);
        expect(vi.getTimerCount()).toBe(before);
    });

    it('resolves false on dispose, since no quiet was seen, and clears its timers', async () => {
        vi.useFakeTimers();
        const service = makeService();
        service.attach('p', 80, 24);
        const before = vi.getTimerCount();

        const first = service.settle('p', 1_000);
        const second = service.settle('p', 2_000);
        expect(vi.getTimerCount()).toBe(before + 4);
        service.dispose('p');

        await expect(first).resolves.toBe(false);
        await expect(second).resolves.toBe(false);
        expect(vi.getTimerCount()).toBe(before);
    });

    it('leaves no timer behind once it resolves either way', async () => {
        vi.useFakeTimers();
        const service = makeService({ settleCapMs: 200 });
        service.attach('p', 80, 24);
        const before = vi.getTimerCount();

        const quiet = service.settle('p', 50);
        await vi.advanceTimersByTimeAsync(50);
        await expect(quiet).resolves.toBe(true);
        expect(vi.getTimerCount()).toBe(before);

        const busy = service.settle('p', 150);
        await vi.advanceTimersByTimeAsync(100);
        service.resize('p', 90, 24);
        await vi.advanceTimersByTimeAsync(100);
        await expect(busy).resolves.toBe(false);
        expect(vi.getTimerCount()).toBe(before);
    });
});
