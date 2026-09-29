/**
 * #283: the page's pending folder requests, settled by the daemon's `choose-folder-result`.
 *
 * Every request must settle, and exactly once: resolved with the path, a cancel, a refusal, a
 * timeout or a dropped connection. An answer nobody is waiting for changes nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommandReply } from '../connection/commands';
import { createFolderChooser, type FolderChooserRequest } from './folder-chooser';

interface Rig {
    readonly chooser: ReturnType<typeof createFolderChooser>;
    readonly sent: FolderChooserRequest[];
    readonly refused: string[];
}

function rig(reply: () => Promise<CommandReply> = async () => ({ ok: true })): Rig {
    const sent: FolderChooserRequest[] = [];
    const refused: string[] = [];
    let counter = 0;
    const chooser = createFolderChooser({
        windowID: 'WIN-1',
        send: (request) => {
            sent.push(request);
            return reply();
        },
        onRefused: (detail) => refused.push(detail),
        timeoutMs: 5_000,
        newID: () => {
            counter += 1;
            return `R${String(counter)}`;
        }
    });
    return { chooser, sent, refused };
}

const result = (requestID: string, path: unknown, windowID: string | undefined = 'WIN-1'): Record<string, unknown> => ({
    type: 'choose-folder-result',
    requestID,
    path,
    ...(windowID === undefined ? {} : { windowID })
});

/**
 * A promise's state, read without waiting on a timer (the timers are faked): 'pending' when it has
 * not resolved after the microtask queue has drained.
 */
async function state<T>(promise: Promise<T>): Promise<T | 'pending'> {
    let settled: { value: T } | null = null;
    void promise.then((value) => {
        settled = { value };
    });
    for (let tick = 0; tick < 10; tick++) await Promise.resolve();
    const read = settled as { value: T } | null;
    return read === null ? 'pending' : read.value;
}

describe('createFolderChooser (#283)', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('sends one request naming this window, and resolves with the path its result carries', async () => {
        const r = rig();
        const answer = r.chooser.choose();
        expect(r.sent).toEqual([{ requestID: 'R1', windowID: 'WIN-1' }]);
        expect(r.chooser.pending).toBe(1);
        expect(r.chooser.handleMessage(result('R1', '/src/app'))).toBe(true);
        await expect(answer).resolves.toBe('/src/app');
        expect(r.chooser.pending).toBe(0);
    });

    it('resolves a cancel, and an empty or malformed path, as null', async () => {
        const r = rig();
        const cancelled = r.chooser.choose();
        const empty = r.chooser.choose();
        const malformed = r.chooser.choose();
        r.chooser.handleMessage(result('R1', null));
        r.chooser.handleMessage(result('R2', ''));
        r.chooser.handleMessage(result('R3', 42));
        await expect(cancelled).resolves.toBeNull();
        await expect(empty).resolves.toBeNull();
        await expect(malformed).resolves.toBeNull();
    });

    it('keeps concurrent requests apart by id', async () => {
        const r = rig();
        const first = r.chooser.choose();
        const second = r.chooser.choose();
        r.chooser.handleMessage(result('R2', '/second'));
        r.chooser.handleMessage(result('R1', '/first'));
        await expect(first).resolves.toBe('/first');
        await expect(second).resolves.toBe('/second');
    });

    it('ignores a result for an unknown id, another window, or a message of another type', async () => {
        const r = rig();
        const answer = r.chooser.choose();
        expect(r.chooser.handleMessage(result('nobody', '/x'))).toBe(false);
        expect(r.chooser.handleMessage(result('R1', '/x', 'WIN-2'))).toBe(false);
        expect(r.chooser.handleMessage({ type: 'menu-command', requestID: 'R1', path: '/x' })).toBe(false);
        expect(r.chooser.handleMessage(null)).toBe(false);
        expect(r.chooser.handleMessage('choose-folder-result')).toBe(false);
        expect(await state(answer)).toBe('pending');
        expect(r.chooser.handleMessage(result('R1', '/right'))).toBe(true);
        await expect(answer).resolves.toBe('/right');
    });

    it('settles once: a second result for the same id is ignored', async () => {
        const r = rig();
        const answer = r.chooser.choose();
        expect(r.chooser.handleMessage(result('R1', '/a'))).toBe(true);
        expect(r.chooser.handleMessage(result('R1', '/b'))).toBe(false);
        await expect(answer).resolves.toBe('/a');
    });

    it('times out to null, and then ignores the late answer', async () => {
        const r = rig();
        const answer = r.chooser.choose();
        vi.advanceTimersByTime(4_999);
        expect(await state(answer)).toBe('pending');
        vi.advanceTimersByTime(1);
        await expect(answer).resolves.toBeNull();
        expect(r.chooser.pending).toBe(0);
        expect(r.chooser.handleMessage(result('R1', '/late'))).toBe(false);
    });

    it('settles null at once when the daemon refuses the request, and says why', async () => {
        const r = rig(async () => ({ ok: false, error: 'shell-action requires action open-file-dialog | install-cli' }));
        const answer = r.chooser.choose();
        await expect(answer).resolves.toBeNull();
        expect(r.refused).toEqual(['shell-action requires action open-file-dialog | install-cli']);
        expect(r.chooser.pending).toBe(0);
    });

    it('settles null when the request cannot be sent at all', async () => {
        const r = rig(async () => {
            throw new Error('connection lost');
        });
        await expect(r.chooser.choose()).resolves.toBeNull();
        expect(r.refused).toEqual(['connection lost']);
    });

    it('cancels everything pending when the connection drops', async () => {
        const r = rig();
        const first = r.chooser.choose();
        const second = r.chooser.choose();
        r.chooser.cancelAll();
        await expect(first).resolves.toBeNull();
        await expect(second).resolves.toBeNull();
        expect(r.chooser.pending).toBe(0);
        // Nothing was refused: a drop is not the daemon saying no.
        expect(r.refused).toEqual([]);
    });
});
