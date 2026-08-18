import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    GRAFT_IGNORED_COMPONENTS,
    GRAFT_WATCH_DEBOUNCE_MS,
    isIgnoredPath,
    watchRecursive,
    type RecursiveWatchFn
} from './watcher.js';

const ROOT = '/work/tree';

interface FakeWatch {
    readonly fn: RecursiveWatchFn;
    emit(filename: string | null): void;
    fail(error: Error): void;
    readonly closed: number;
    readonly roots: string[];
}

function fakeWatch(): FakeWatch {
    let listener: ((event: string, filename: string | null) => void) | null = null;
    let errorListener: ((error: Error) => void) | null = null;
    let closed = 0;
    const roots: string[] = [];
    return {
        fn: (root, cb) => {
            roots.push(root);
            listener = cb;
            return {
                close() {
                    closed += 1;
                },
                on(_event, cb2) {
                    errorListener = cb2;
                    return undefined;
                }
            };
        },
        emit(filename) {
            listener?.('change', filename);
        },
        fail(error) {
            errorListener?.(error);
        },
        get closed() {
            return closed;
        },
        roots
    };
}

describe('isIgnoredPath', () => {
    it('drops a path when ANY component is ignored', () => {
        const ignored = new Set(GRAFT_IGNORED_COMPONENTS);
        expect(isIgnoredPath('.git/index', ignored)).toBe(true);
        expect(isIgnoredPath('src/.git/HEAD', ignored)).toBe(true);
        expect(isIgnoredPath('node_modules/react/index.js', ignored)).toBe(true);
        expect(isIgnoredPath('rust/target/debug/app', ignored)).toBe(true);
        expect(isIgnoredPath('assets/.DS_Store', ignored)).toBe(true);
        expect(isIgnoredPath('src/app.ts', ignored)).toBe(false);
        // Not a whole component: `.gitignore` is a real, syncable file.
        expect(isIgnoredPath('.gitignore', ignored)).toBe(false);
        expect(isIgnoredPath('src/target-practice.ts', ignored)).toBe(false);
    });

    it('defaults to the documented ignore set', () => {
        expect([...GRAFT_IGNORED_COMPONENTS]).toEqual([
            '.git',
            'node_modules',
            'target',
            '.DS_Store'
        ]);
        expect(isIgnoredPath('.git/objects/ab/cd')).toBe(true);
    });
});

describe('watchRecursive', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('emits ONE sorted, deduplicated batch a debounce after the last write', () => {
        const watch = fakeWatch();
        const batches: readonly string[][] = [];
        const seen: string[][] = [];
        const watcher = watchRecursive({
            root: ROOT,
            watch: watch.fn,
            onBatch: (paths) => {
                seen.push([...paths]);
            }
        });
        expect(watch.roots).toEqual([ROOT]);
        expect(batches).toEqual([]);

        watch.emit('src/b.ts');
        watch.emit('src/a.ts');
        watch.emit('src/b.ts');
        vi.advanceTimersByTime(GRAFT_WATCH_DEBOUNCE_MS - 1);
        expect(seen).toEqual([]);
        // A late event re-arms the trailing debounce.
        watch.emit('src/c.ts');
        vi.advanceTimersByTime(GRAFT_WATCH_DEBOUNCE_MS - 1);
        expect(seen).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(seen).toEqual([[`${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`, `${ROOT}/src/c.ts`]]);
        watcher.close();
    });

    it('never emits an empty batch, and ignored paths alone produce nothing', () => {
        const watch = fakeWatch();
        const seen: string[][] = [];
        const watcher = watchRecursive({
            root: ROOT,
            watch: watch.fn,
            onBatch: (paths) => {
                seen.push([...paths]);
            }
        });
        watch.emit('.git/index');
        watch.emit('.git/refs/heads/main');
        watch.emit('node_modules/x/package.json');
        vi.advanceTimersByTime(1_000);
        expect(seen).toEqual([]);
        expect(watcher.pending).toBe(0);
        watcher.close();
    });

    it('attributes an unnamed event to the root instead of dropping the signal', () => {
        const watch = fakeWatch();
        const seen: string[][] = [];
        const watcher = watchRecursive({
            root: ROOT,
            watch: watch.fn,
            debounceMs: 10,
            onBatch: (paths) => {
                seen.push([...paths]);
            }
        });
        watch.emit(null);
        vi.advanceTimersByTime(10);
        expect(seen).toEqual([[ROOT]]);
        watcher.close();
    });

    it('close() drops the pending batch and tears the OS watch down', () => {
        const watch = fakeWatch();
        const seen: string[][] = [];
        const watcher = watchRecursive({
            root: ROOT,
            watch: watch.fn,
            onBatch: (paths) => {
                seen.push([...paths]);
            }
        });
        watch.emit('src/a.ts');
        expect(watcher.pending).toBe(1);
        watcher.close();
        vi.advanceTimersByTime(5_000);
        expect(seen).toEqual([]);
        expect(watch.closed).toBe(1);
        expect(watcher.watching).toBe(false);
        watcher.close();
        expect(watch.closed).toBe(1);
    });

    it('reports watch errors without throwing at the caller', () => {
        const watch = fakeWatch();
        const errors: string[] = [];
        const watcher = watchRecursive({
            root: ROOT,
            watch: watch.fn,
            onBatch: () => {},
            onError: (_error, context) => {
                errors.push(context);
            }
        });
        watch.fail(new Error('EMFILE'));
        expect(errors).toEqual([`graft watch ${ROOT}`]);
        watcher.close();
    });

    it('stays constructible when the worktree is already gone', () => {
        const errors: string[] = [];
        const watcher = watchRecursive({
            root: ROOT,
            watch: () => {
                throw new Error('ENOENT');
            },
            onBatch: () => {},
            onError: (_error, context) => {
                errors.push(context);
            }
        });
        expect(watcher.watching).toBe(false);
        expect(errors).toHaveLength(1);
        watcher.close();
    });

    it('filters on the path RELATIVE to the root, not the absolute path', () => {
        const seen: string[][] = [];
        const watch = fakeWatch();
        // A worktree that itself lives under a directory called `target` must still sync.
        const watcher = watchRecursive({
            root: '/build/target/worktree',
            watch: watch.fn,
            debounceMs: 5,
            onBatch: (paths) => {
                seen.push([...paths]);
            }
        });
        watch.emit('src/app.ts');
        vi.advanceTimersByTime(5);
        expect(seen).toEqual([['/build/target/worktree/src/app.ts']]);
        watcher.close();
    });
});
