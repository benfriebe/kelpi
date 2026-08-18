import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createHeadWatchService,
    HEAD_CHANGE_DEBOUNCE_MS,
    type HeadWatchFn
} from './head-watcher.js';

interface FakeDirWatch {
    readonly fn: HeadWatchFn;
    emit(directory: string, filename: string | null): void;
    readonly directories: string[];
    readonly closed: string[];
}

function fakeDirWatch(): FakeDirWatch {
    const listeners = new Map<string, ((event: string, filename: string | null) => void)[]>();
    const directories: string[] = [];
    const closed: string[] = [];
    return {
        fn: (directory, cb) => {
            directories.push(directory);
            const existing = listeners.get(directory) ?? [];
            existing.push(cb);
            listeners.set(directory, existing);
            return {
                close() {
                    closed.push(directory);
                    listeners.set(
                        directory,
                        (listeners.get(directory) ?? []).filter((entry) => entry !== cb)
                    );
                },
                on() {
                    return undefined;
                }
            };
        },
        emit(directory, filename) {
            for (const cb of listeners.get(directory) ?? []) cb('rename', filename);
        },
        directories,
        closed
    };
}

const A = 'assoc-a';
const B = 'assoc-b';

describe('createHeadWatchService', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('watches the HEAD file of a LINKED worktree via rev-parse --git-path', async () => {
        const watch = fakeDirWatch();
        const changed: string[] = [];
        const service = createHeadWatchService({
            resolveHeadPath: async (worktreePath) =>
                `/repo/.git/worktrees/${worktreePath.split('/').pop() ?? ''}/HEAD`,
            onChanged: (id) => changed.push(id),
            watch: watch.fn
        });
        await service.start(A, '/worktrees/feature-x');
        expect(service.headPath(A)).toBe('/repo/.git/worktrees/feature-x/HEAD');
        expect(watch.directories).toEqual(['/repo/.git/worktrees/feature-x']);

        watch.emit('/repo/.git/worktrees/feature-x', 'HEAD');
        vi.advanceTimersByTime(HEAD_CHANGE_DEBOUNCE_MS);
        expect(changed).toEqual([A]);
        service.stopAll();
    });

    it('coalesces checkout\'s temp-file + rename pair into ONE debounced change', async () => {
        const watch = fakeDirWatch();
        const changed: string[] = [];
        const service = createHeadWatchService({
            resolveHeadPath: async () => '/repo/.git/HEAD',
            onChanged: (id) => changed.push(id),
            watch: watch.fn
        });
        await service.start(A, '/repo');
        watch.emit('/repo/.git', 'HEAD.lock');
        watch.emit('/repo/.git', 'HEAD');
        watch.emit('/repo/.git', 'HEAD');
        vi.advanceTimersByTime(HEAD_CHANGE_DEBOUNCE_MS - 1);
        expect(changed).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(changed).toEqual([A]);
        service.stop(A);
    });

    it('ignores sibling entries in the git dir (index, refs, logs)', async () => {
        const watch = fakeDirWatch();
        const changed: string[] = [];
        const service = createHeadWatchService({
            resolveHeadPath: async () => '/repo/.git/HEAD',
            onChanged: (id) => changed.push(id),
            watch: watch.fn
        });
        await service.start(A, '/repo');
        watch.emit('/repo/.git', 'index');
        watch.emit('/repo/.git', 'ORIG_HEAD');
        vi.advanceTimersByTime(1_000);
        expect(changed).toEqual([]);
        service.stop(A);
    });

    it('keys watches per association and replaces on a repeat start', async () => {
        const watch = fakeDirWatch();
        const changed: string[] = [];
        const service = createHeadWatchService({
            resolveHeadPath: async (worktreePath) => `${worktreePath}/.git/HEAD`,
            onChanged: (id) => changed.push(id),
            watch: watch.fn
        });
        await service.start(A, '/a');
        await service.start(B, '/b');
        expect([...service.watched()].sort()).toEqual([A, B]);

        await service.start(A, '/a2');
        expect(watch.closed).toEqual(['/a/.git']);
        expect(service.headPath(A)).toBe('/a2/.git/HEAD');

        watch.emit('/a/.git', 'HEAD');
        vi.advanceTimersByTime(1_000);
        expect(changed).toEqual([]); // the replaced watch is gone

        watch.emit('/a2/.git', 'HEAD');
        watch.emit('/b/.git', 'HEAD');
        vi.advanceTimersByTime(HEAD_CHANGE_DEBOUNCE_MS);
        expect([...changed].sort()).toEqual([A, B]);
        service.stopAll();
    });

    it('stop is idempotent and cancels a pending debounce', async () => {
        const watch = fakeDirWatch();
        const changed: string[] = [];
        const service = createHeadWatchService({
            resolveHeadPath: async () => '/repo/.git/HEAD',
            onChanged: (id) => changed.push(id),
            watch: watch.fn
        });
        await service.start(A, '/repo');
        watch.emit('/repo/.git', 'HEAD');
        service.stop(A);
        service.stop(A);
        vi.advanceTimersByTime(1_000);
        expect(changed).toEqual([]);
        expect(service.watched()).toEqual([]);
        expect(watch.closed).toEqual(['/repo/.git']);
    });

    it('is a silent no-op when the path is not a checkout', async () => {
        const watch = fakeDirWatch();
        const service = createHeadWatchService({
            resolveHeadPath: async () => {
                throw new Error('fatal: not a git repository');
            },
            onChanged: () => {
                throw new Error('must not fire');
            },
            watch: watch.fn
        });
        await service.start(A, '/not/a/repo');
        expect(service.watched()).toEqual([]);
        expect(watch.directories).toEqual([]);
    });

    it('does not resurrect a watch stopped while rev-parse was still running', async () => {
        const watch = fakeDirWatch();
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const service = createHeadWatchService({
            resolveHeadPath: async () => {
                await gate;
                return '/repo/.git/HEAD';
            },
            onChanged: () => {},
            watch: watch.fn
        });
        const started = service.start(A, '/repo');
        service.stop(A);
        release();
        await started;
        expect(service.watched()).toEqual([]);
        expect(watch.directories).toEqual([]);
    });
});
