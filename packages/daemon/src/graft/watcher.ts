/**
 * The recursive worktree watcher that drives graft sync passes (graft-git.md §9.1).
 *
 * Semantics that are contract:
 *   - **500 ms trailing debounce**: every event (re)schedules the flush, so a burst of writes
 *     yields ONE batch ~500 ms after the last write;
 *   - **component-based ignore list** (`.git`, `node_modules`, `target`, `.DS_Store`): a path
 *     is dropped when ANY of its components matches. `.git` is the load-bearing one — graft's
 *     own `read-tree`/`write-tree` traffic would otherwise re-trigger it forever;
 *   - batches are **sorted + deduplicated**, and an empty batch is never emitted;
 *   - `close()` drops any pending batch and tears the OS watch down.
 *
 * Filtering runs on the path **relative to the root**, not the absolute path: a worktree that
 * happens to live under a directory called `target` must still be watched. The emitted paths
 * are absolute (the consumer only uses them for diagnostics today).
 */

import fs from 'node:fs';
import path from 'node:path';

/** §9.1 debounce. */
export const GRAFT_WATCH_DEBOUNCE_MS = 500;

/** §9.1 ignore list. */
export const GRAFT_IGNORED_COMPONENTS: readonly string[] = [
    '.git',
    'node_modules',
    'target',
    '.DS_Store'
];

/** True when ANY `/`-separated component of `relativePath` is ignored. */
export function isIgnoredPath(
    relativePath: string,
    ignored: ReadonlySet<string> = new Set(GRAFT_IGNORED_COMPONENTS)
): boolean {
    for (const component of relativePath.split(/[/\\]/)) {
        if (component === '') continue;
        if (ignored.has(component)) return true;
    }
    return false;
}

/** The slice of `fs.FSWatcher` used here, so tests can inject a fake. */
export interface RecursiveWatchHandle {
    close(): void;
    on(event: 'error', listener: (error: Error) => void): unknown;
}

export type RecursiveWatchFn = (
    root: string,
    listener: (event: string, filename: string | null) => void
) => RecursiveWatchHandle;

export interface RecursiveWatcher {
    readonly root: string;
    /** True while an OS watch is attached. */
    readonly watching: boolean;
    /** Paths accumulated but not yet flushed. */
    readonly pending: number;
    /** Flush the current batch immediately (tests; also used by nothing in production). */
    flush(): void;
    close(): void;
}

export interface WatchRecursiveOptions {
    readonly root: string;
    /** Receives the sorted, deduplicated, absolute paths of one batch. */
    readonly onBatch: (paths: readonly string[]) => void;
    readonly debounceMs?: number | undefined;
    readonly ignored?: readonly string[] | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
    /** Injection point for tests; defaults to a recursive `fs.watch`. */
    readonly watch?: RecursiveWatchFn | undefined;
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

export function watchRecursive(options: WatchRecursiveOptions): RecursiveWatcher {
    const debounceMs = options.debounceMs ?? GRAFT_WATCH_DEBOUNCE_MS;
    const ignored = new Set(options.ignored ?? GRAFT_IGNORED_COMPONENTS);
    const watchFn: RecursiveWatchFn =
        options.watch ??
        ((root, listener) =>
            fs.watch(root, { recursive: true, persistent: false }, listener) as RecursiveWatchHandle);

    const batch = new Set<string>();
    let handle: RecursiveWatchHandle | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const cancelTimer = (): void => {
        if (timer === null) return;
        clearTimeout(timer);
        timer = null;
    };

    const flush = (): void => {
        cancelTimer();
        if (batch.size === 0) return;
        const paths = [...batch].sort();
        batch.clear();
        if (closed) return;
        options.onBatch(paths);
    };

    const schedule = (): void => {
        // Trailing debounce: the newest event always wins the timer.
        cancelTimer();
        timer = setTimeout(() => {
            timer = null;
            flush();
        }, debounceMs);
        timer.unref?.();
    };

    const record = (filename: string | null): void => {
        if (closed) return;
        // A null filename (platform could not name the entry) is still a change under the
        // root; attribute it to the root itself rather than dropping the signal.
        const relative = filename ?? '';
        if (relative !== '' && isIgnoredPath(relative, ignored)) return;
        batch.add(relative === '' ? options.root : path.resolve(options.root, relative));
        schedule();
    };

    try {
        const created = watchFn(options.root, (_event, filename) => {
            record(filename);
        });
        created.on('error', (error) => {
            options.onError?.(toError(error), `graft watch ${options.root}`);
        });
        handle = created;
    } catch (error) {
        // The worktree vanished before the watch attached: stay unwatched. The session is
        // still live and its next sync pass reports `missingWorktree` honestly.
        options.onError?.(toError(error), `graft watch ${options.root}`);
    }

    return {
        root: options.root,
        get watching() {
            return handle !== null;
        },
        get pending() {
            return batch.size;
        },
        flush,
        close() {
            if (closed) return;
            closed = true;
            cancelTimer();
            batch.clear();
            if (handle === null) return;
            try {
                handle.close();
            } catch {
                // Already dead.
            }
            handle = null;
        }
    };
}
