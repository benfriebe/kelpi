import { DROPPED_FILES_STASH, WS_DROPPED_FILES_RESULT_MESSAGE } from '@kelpi/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommandReply } from '../connection/commands';
import {
    createDroppedFilesResolver,
    droppedFilesRefusal,
    pageDroppedFilesStash,
    type DroppedFilesRequest,
    type DroppedFilesStash
} from './dropped-files';

function setup(options: { reply?: CommandReply | Error; timeoutMs?: number } = {}) {
    const stash: DroppedFilesStash = new Map();
    const sent: DroppedFilesRequest[] = [];
    // The stash as the shell sees it at the moment the request goes out.
    const stashAtSend: (readonly unknown[] | undefined)[] = [];
    let counter = 0;
    const resolver = createDroppedFilesResolver({
        windowID: 'WIN',
        stash,
        timeoutMs: options.timeoutMs ?? 1_000,
        newID: () => `D${String(++counter)}`,
        send: (request) => {
            sent.push(request);
            stashAtSend.push(stash.get(request.requestID));
            if (options.reply instanceof Error) return Promise.reject(options.reply);
            return Promise.resolve(options.reply ?? ({ ok: true } as CommandReply));
        }
    });
    return { resolver, stash, sent, stashAtSend };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
    vi.useRealTimers();
});

describe('createDroppedFilesResolver (#288)', () => {
    it('parks the files under the request id before asking, then settles on the matching result', async () => {
        const { resolver, stash, sent, stashAtSend } = setup();
        const files = [{ name: 'a b.png' }, { name: 'dir' }];
        const answer = resolver.resolve(files);
        expect(sent).toEqual([{ requestID: 'D1', windowID: 'WIN' }]);
        // The shell must never look for an entry that is not there yet.
        expect(stashAtSend[0]).toEqual(files);

        expect(
            resolver.handleMessage({
                type: WS_DROPPED_FILES_RESULT_MESSAGE,
                requestID: 'D1',
                paths: ['/Users/me/a b.png', '/Users/me/dir'],
                unresolved: 0,
                windowID: 'WIN'
            })
        ).toBe(true);
        await expect(answer).resolves.toEqual({ paths: ['/Users/me/a b.png', '/Users/me/dir'], unresolved: 0, error: null });
        // The page's Files do not outlive the drop.
        expect(stash.size).toBe(0);
        expect(resolver.pending).toBe(0);
    });

    it('ignores a result for another id or another window, and anything that is not a result', async () => {
        const { resolver } = setup();
        void resolver.resolve([{}]);
        expect(resolver.handleMessage({ type: WS_DROPPED_FILES_RESULT_MESSAGE, requestID: 'other', paths: ['/x'], unresolved: 0 })).toBe(false);
        expect(
            resolver.handleMessage({ type: WS_DROPPED_FILES_RESULT_MESSAGE, requestID: 'D1', paths: ['/x'], unresolved: 0, windowID: 'ELSEWHERE' })
        ).toBe(false);
        expect(resolver.handleMessage({ type: 'choose-folder-result', requestID: 'D1', path: '/x' })).toBe(false);
        expect(resolver.handleMessage(null)).toBe(false);
        expect(resolver.pending).toBe(1);
    });

    it('keeps only absolute paths from the wire, counting what it drops, and passes the shell’s reason on only when nothing resolved', async () => {
        const { resolver } = setup();
        const first = resolver.resolve([{}]);
        resolver.handleMessage({ type: WS_DROPPED_FILES_RESULT_MESSAGE, requestID: 'D1', paths: ['/ok', 'relative', 3], unresolved: 2 });
        await expect(first).resolves.toEqual({ paths: ['/ok'], unresolved: 4, error: null });

        const second = resolver.resolve([{}]);
        resolver.handleMessage({ type: WS_DROPPED_FILES_RESULT_MESSAGE, requestID: 'D2', paths: [], unresolved: 0, error: 'no debugger' });
        await expect(second).resolves.toEqual({ paths: [], unresolved: 0, error: 'no debugger' });
    });

    it('settles empty with the daemon’s refusal, reworded without the window’s UUID, and clears the stash', async () => {
        const { resolver, stash } = setup({
            reply: { ok: false, error: "no desktop window cccccccc-0000-4000-8000-000000000288 is connected that can read a dropped file's path" } as CommandReply
        });
        const answer = await resolver.resolve([{}]);
        expect(answer).toEqual({ paths: [], unresolved: 0, error: "this window can't read dropped file paths right now; try again" });
        expect(stash.size).toBe(0);
    });

    it('settles empty when the send itself fails', async () => {
        const { resolver } = setup({ reply: new Error('socket closed') });
        await expect(resolver.resolve([{}])).resolves.toEqual({
            paths: [],
            unresolved: 0,
            error: 'could not ask the desktop window: socket closed'
        });
    });

    it('settles empty after the timeout, and a late result changes nothing', async () => {
        vi.useFakeTimers();
        const { resolver, stash } = setup({ timeoutMs: 500 });
        const answer = resolver.resolve([{}]);
        await vi.advanceTimersByTimeAsync(501);
        await expect(answer).resolves.toMatchObject({ paths: [], error: 'the desktop window did not answer in time' });
        expect(stash.size).toBe(0);
        expect(resolver.handleMessage({ type: WS_DROPPED_FILES_RESULT_MESSAGE, requestID: 'D1', paths: ['/late'], unresolved: 0 })).toBe(false);
    });

    it('settles every pending request when the connection drops', async () => {
        const { resolver, stash } = setup();
        const a = resolver.resolve([{}]);
        const b = resolver.resolve([{}]);
        await flush();
        resolver.cancelAll();
        await expect(a).resolves.toMatchObject({ paths: [], error: 'the connection to the daemon dropped' });
        await expect(b).resolves.toMatchObject({ paths: [] });
        expect(stash.size).toBe(0);
    });
});

describe('droppedFilesRefusal (#288 review)', () => {
    it('tells a paired device where dropping files works, and everyone else to try again', () => {
        expect(droppedFilesRefusal('resolve-dropped-files is owner-only')).toBe(
            'dropping files onto a terminal works in the Kelpi desktop app'
        );
        for (const detail of [
            "no desktop window cccccccc-0000-4000-8000-000000000288 is connected that can read a dropped file's path",
            'dropped-files request D1 is already pending',
            'shell-action resolve-dropped-files requires window_id'
        ]) {
            const sentence = droppedFilesRefusal(detail);
            expect(sentence).toBe("this window can't read dropped file paths right now; try again");
            expect(sentence).not.toMatch(/[0-9a-f]{8}-/);
        }
    });
});

describe('pageDroppedFilesStash (#288)', () => {
    it('lives on globalThis under the name the shell reads, and is created once', () => {
        const scope = globalThis as unknown as Record<string, unknown>;
        delete scope[DROPPED_FILES_STASH];
        const stash = pageDroppedFilesStash();
        expect(scope[DROPPED_FILES_STASH]).toBe(stash);
        expect(stash).toBeInstanceOf(Map);
        expect(pageDroppedFilesStash()).toBe(stash);
        delete scope[DROPPED_FILES_STASH];
    });
});
