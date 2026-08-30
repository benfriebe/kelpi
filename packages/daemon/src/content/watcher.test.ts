import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RENAME_REATTACH_DELAY_MS, watchFile, type WatchFn, type WatchHandle } from './watcher.js';

// ── injected-watcher unit tests (deterministic) ─────────────────────────────────────

interface FakeWatch {
    readonly fn: WatchFn;
    readonly attaches: string[];
    readonly closes: number[];
    /** How many watches are currently open. */
    readonly open: number;
    fire(event: string): void;
    error(): void;
}

function fakeWatch(): FakeWatch {
    const attaches: string[] = [];
    const closes: number[] = [];
    let handlers: ((event: string, filename: string | null) => void)[] = [];
    let errorHandlers: ((error: Error) => void)[] = [];
    let open = 0;

    const fn: WatchFn = (target, listener) => {
        attaches.push(target);
        open += 1;
        handlers = [listener];
        errorHandlers = [];
        const handle: WatchHandle = {
            close() {
                open -= 1;
                closes.push(Date.now());
                handlers = [];
                errorHandlers = [];
            },
            on(_event, listener2) {
                errorHandlers.push(listener2);
                return handle;
            }
        };
        return handle;
    };

    return {
        fn,
        attaches,
        closes,
        get open() {
            return open;
        },
        fire(event) {
            for (const handler of [...handlers]) handler(event, 'file.md');
        },
        error() {
            for (const handler of [...errorHandlers]) handler(new Error('gone'));
        }
    };
}

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('watchFile (injected)', () => {
    it('attaches on creation and reloads on a change event', () => {
        const fake = fakeWatch();
        let changes = 0;
        const watcher = watchFile({ path: '/x/file.md', onChange: () => (changes += 1), watch: fake.fn });
        expect(fake.attaches).toEqual(['/x/file.md']);
        expect(watcher.watching).toBe(true);

        fake.fire('change');
        fake.fire('change');
        expect(changes).toBe(2);
        watcher.close();
    });

    it('does the vim rename dance: detach, wait, re-attach, reload', async () => {
        const fake = fakeWatch();
        let changes = 0;
        const watcher = watchFile({
            path: '/x/file.md',
            onChange: () => (changes += 1),
            reattachDelayMs: 20,
            watch: fake.fn
        });

        fake.fire('rename');
        // Immediately after the rename the watch is gone and nothing has reloaded yet.
        expect(watcher.watching).toBe(false);
        expect(changes).toBe(0);

        await tick(45);
        expect(fake.attaches).toEqual(['/x/file.md', '/x/file.md']);
        expect(watcher.watching).toBe(true);
        expect(changes).toBe(1);
        watcher.close();
    });

    it('treats a watcher error as the delete half of the dance', async () => {
        const fake = fakeWatch();
        let changes = 0;
        const watcher = watchFile({
            path: '/x/file.md',
            onChange: () => (changes += 1),
            reattachDelayMs: 10,
            watch: fake.fn
        });
        fake.error();
        await tick(35);
        expect(changes).toBe(1);
        watcher.close();
    });

    it('coalesces a burst of renames into one re-attach', async () => {
        const fake = fakeWatch();
        let changes = 0;
        const watcher = watchFile({
            path: '/x/file.md',
            onChange: () => (changes += 1),
            reattachDelayMs: 20,
            watch: fake.fn
        });
        fake.fire('rename');
        fake.fire('rename');
        await tick(45);
        expect(changes).toBe(1);
        expect(fake.attaches).toHaveLength(2);
        watcher.close();
    });

    it('survives a re-attach onto a missing path (stays unwatched, no throw)', async () => {
        let attempts = 0;
        const failing: WatchFn = (_target, _listener) => {
            attempts += 1;
            if (attempts > 1) throw new Error('ENOENT');
            return {
                close: () => {},
                on: (_event, listener) => {
                    void listener;
                    return null;
                }
            } as WatchHandle;
        };
        const errors: string[] = [];
        let changes = 0;
        const watcher = watchFile({
            path: '/x/gone.md',
            onChange: () => (changes += 1),
            reattachDelayMs: 5,
            watch: failing,
            onError: (error) => errors.push(error.message)
        });
        // Trigger the dance through the error path is impossible here (no error listener), so
        // suspend/resume exercises the same re-attach.
        watcher.suspend();
        watcher.resume();
        expect(watcher.watching).toBe(false);
        expect(errors).toEqual(['ENOENT']);
        expect(changes).toBe(0);
        watcher.close();
    });

    it('suspend detaches (edit mode) and resume re-attaches without reloading', () => {
        const fake = fakeWatch();
        let changes = 0;
        const watcher = watchFile({ path: '/x/file.md', onChange: () => (changes += 1), watch: fake.fn });

        watcher.suspend();
        expect(watcher.suspended).toBe(true);
        expect(watcher.watching).toBe(false);
        expect(fake.open).toBe(0);

        watcher.resume();
        expect(watcher.watching).toBe(true);
        expect(changes).toBe(0);
        expect(fake.attaches).toHaveLength(2);
        watcher.close();
    });

    it('suspend cancels a pending re-attach', async () => {
        const fake = fakeWatch();
        let changes = 0;
        const watcher = watchFile({
            path: '/x/file.md',
            onChange: () => (changes += 1),
            reattachDelayMs: 20,
            watch: fake.fn
        });
        fake.fire('rename');
        watcher.suspend();
        await tick(45);
        expect(changes).toBe(0);
        watcher.close();
    });

    it('close is idempotent and stops everything', async () => {
        const fake = fakeWatch();
        let changes = 0;
        const watcher = watchFile({
            path: '/x/file.md',
            onChange: () => (changes += 1),
            reattachDelayMs: 10,
            watch: fake.fn
        });
        fake.fire('rename');
        watcher.close();
        watcher.close();
        await tick(30);
        expect(changes).toBe(0);
        expect(fake.open).toBe(0);
        expect(watcher.watching).toBe(false);
    });

    it('defaults the re-attach delay to the spec 200 ms', () => {
        expect(RENAME_REATTACH_DELAY_MS).toBe(200);
    });
});

// ── real filesystem (the actual vim save shape) ─────────────────────────────────────

describe('watchFile (real fs)', () => {
    const dirs: string[] = [];

    afterEach(() => {
        for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    });

    const tmpdir = (): string => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-watch-'));
        dirs.push(dir);
        return dir;
    };

    const waitFor = async (predicate: () => boolean, timeoutMs = 4000): Promise<boolean> => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (predicate()) return true;
            await tick(20);
        }
        return predicate();
    };

    it('fires on an in-place write', async () => {
        const dir = tmpdir();
        const file = path.join(dir, 'note.md');
        fs.writeFileSync(file, 'one');
        let changes = 0;
        const watcher = watchFile({ path: file, onChange: () => (changes += 1) });
        try {
            // Let the OS watch settle before mutating (FSEvents coalesces same-tick writes).
            await tick(50);
            fs.writeFileSync(file, 'two');
            expect(await waitFor(() => changes > 0)).toBe(true);
        } finally {
            watcher.close();
        }
    });

    it('re-attaches after a vim-style write-and-rename and reloads', async () => {
        const dir = tmpdir();
        const file = path.join(dir, 'note.md');
        fs.writeFileSync(file, 'one');
        let changes = 0;
        const watcher = watchFile({ path: file, onChange: () => (changes += 1), reattachDelayMs: 30 });
        try {
            await tick(50);
            // What vim does: write a new file, then rename it over the target.
            const temp = path.join(dir, 'note.md~');
            fs.writeFileSync(temp, 'two');
            fs.renameSync(temp, file);
            expect(await waitFor(() => changes > 0)).toBe(true);

            // The watch must be live again afterwards: a second edit still reports.
            const before = changes;
            await tick(60);
            fs.writeFileSync(file, 'three');
            expect(await waitFor(() => changes > before)).toBe(true);
        } finally {
            watcher.close();
        }
    });
});
