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
    it('starts at 0 and reads 0 for a pane with no terminal state', () => {
        const service = makeService();
        service.attach('p', 80, 24);

        expect(service.revision('p')).toBe(0);
        expect(service.revision('nope')).toBe(0);
    });

    it('bumps once per non-empty feed, at enqueue time, before the bytes are parsed', async () => {
        const service = makeService();
        service.attach('p', 80, 24);

        service.feed('p', encoder.encode('one'));
        expect(service.revision('p')).toBe(1);
        service.feed('p', 'two');
        service.feed('p', new Uint8Array(0));
        service.feed('p', '');
        expect(service.revision('p')).toBe(2);

        await service.flush('p');
        expect(service.revision('p')).toBe(2);
        expect(service.capture('p', { scrollback: false })).toBe('onetwo');
    });

    it('counts a replayed feed split across two writes as one bump', () => {
        const service = makeService();
        service.attach('p', 80, 24);
        service.markReplay('p', 3, false);

        service.feed('p', encoder.encode('abcdef'));
        expect(service.revision('p')).toBe(1);
    });

    it('creates a lazily fed pane at 0 and counts that first feed', () => {
        const service = makeService();
        service.feed('late', 'hi');
        expect(service.revision('late')).toBe(1);
    });

    it('bumps on a restore that queues a snapshot, and not on an empty one', async () => {
        const service = makeService();
        service.attach('src', 40, 10);
        service.feed('src', 'saved screen');
        const checkpoint = await service.checkpointAsync('src');
        if (checkpoint === null) throw new Error('no checkpoint');

        service.attach('p', 40, 10);
        service.restore('p', checkpoint);
        expect(service.revision('p')).toBe(1);
        service.restore('p', { ...checkpoint, snapshot: new Uint8Array(0) });
        expect(service.revision('p')).toBe(1);
        service.restore('nope', checkpoint);
        expect(service.revision('nope')).toBe(0);
    });

    it('bumps on a resize that changes the grid, and only then', () => {
        const service = makeService();
        service.attach('p', 80, 24);

        service.resize('p', 80, 24);
        expect(service.revision('p')).toBe(0);
        service.resize('p', 100, 24);
        expect(service.revision('p')).toBe(1);
        service.resize('p', 100, 30);
        expect(service.revision('p')).toBe(2);
        // A re-attach at a new size is a resize too; at the same size it is not.
        service.attach('p', 100, 30);
        expect(service.revision('p')).toBe(2);
        service.attach('p', 90, 30);
        expect(service.revision('p')).toBe(3);
    });

    it('starts over when the pane is disposed and attached again', () => {
        const service = makeService();
        service.attach('p', 80, 24);
        service.feed('p', 'x');
        service.dispose('p');
        expect(service.revision('p')).toBe(0);
        service.attach('p', 80, 24);
        expect(service.revision('p')).toBe(0);
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

    it('resolves on dispose and clears its timers', async () => {
        vi.useFakeTimers();
        const service = makeService();
        service.attach('p', 80, 24);
        const before = vi.getTimerCount();

        const first = service.settle('p', 1_000);
        const second = service.settle('p', 2_000);
        expect(vi.getTimerCount()).toBe(before + 4);
        service.dispose('p');

        await expect(first).resolves.toBe(true);
        await expect(second).resolves.toBe(true);
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
