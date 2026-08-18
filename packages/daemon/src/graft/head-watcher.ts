/**
 * `GitHeadWatcher` (graft-git.md §9.2 + port note 10): sub-second sidebar branch refresh at
 * zero at-rest CPU, by watching each association's HEAD **file**.
 *
 * `resolveHeadPath` (`git rev-parse --git-path HEAD`) is what makes this work for linked
 * worktrees, whose HEAD lives at `<repo>/.git/worktrees/<name>/HEAD`, not `<worktree>/.git`.
 *
 * Port choice: the Swift app watches the file descriptor and re-opens 200 ms after a
 * rename/delete, because `git checkout` writes HEAD via temp-file + atomic rename and kills
 * the watched inode. Node has the same problem, so this port instead watches the HEAD file's
 * **parent directory** and filters events to the `HEAD` entry — rename-proof by construction,
 * with no re-open dance. Everything else port note 10 requires is preserved: per-association
 * identity, start-replaces-start, idempotent stop, a silent no-op for non-repos, and the
 * 150 ms downstream debounce before the `git status` + branch read.
 */

import fs from 'node:fs';
import path from 'node:path';

/** §9.2: coalesce checkout's temp-file + rename double event before doing git work. */
export const HEAD_CHANGE_DEBOUNCE_MS = 150;

export interface HeadWatchHandle {
    close(): void;
    on(event: 'error', listener: (error: Error) => void): unknown;
}

export type HeadWatchFn = (
    directory: string,
    listener: (event: string, filename: string | null) => void
) => HeadWatchHandle;

export interface HeadWatchService {
    /**
     * Watch `worktreePath`'s HEAD for `associationID`. Starting again for the same id replaces
     * the previous watch. A path that is not a checkout is a silent no-op.
     */
    start(associationID: string, worktreePath: string): Promise<void>;
    /** Idempotent; also cancels a pending debounce. */
    stop(associationID: string): void;
    stopAll(): void;
    /** Association ids with a live watch (test/diagnostic surface). */
    watched(): readonly string[];
    /** The resolved HEAD path per association (test/diagnostic surface). */
    headPath(associationID: string): string | null;
}

export interface CreateHeadWatchServiceOptions {
    /** `git rev-parse --git-path HEAD`, resolved + normalized. */
    readonly resolveHeadPath: (worktreePath: string) => Promise<string>;
    /** Called at most once per debounce window per association. */
    readonly onChanged: (associationID: string) => void;
    readonly debounceMs?: number | undefined;
    /** Injected directory watcher (tests); defaults to a non-recursive `fs.watch`. */
    readonly watch?: HeadWatchFn | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
}

interface Entry {
    readonly headPath: string;
    readonly handle: HeadWatchHandle | null;
    timer: ReturnType<typeof setTimeout> | null;
    /** Bumped on every `start` so a slow `resolveHeadPath` cannot resurrect a stopped watch. */
    readonly epoch: number;
}

export function createHeadWatchService(
    options: CreateHeadWatchServiceOptions
): HeadWatchService {
    const debounceMs = options.debounceMs ?? HEAD_CHANGE_DEBOUNCE_MS;
    const watchFn: HeadWatchFn =
        options.watch ??
        ((directory, listener) =>
            fs.watch(directory, { persistent: false }, listener) as HeadWatchHandle);

    const entries = new Map<string, Entry>();
    const epochs = new Map<string, number>();

    const clearTimer = (entry: Entry): void => {
        if (entry.timer === null) return;
        clearTimeout(entry.timer);
        entry.timer = null;
    };

    const teardown = (associationID: string): void => {
        const entry = entries.get(associationID);
        if (entry === undefined) return;
        entries.delete(associationID);
        clearTimer(entry);
        try {
            entry.handle?.close();
        } catch {
            // Already dead.
        }
    };

    const schedule = (associationID: string): void => {
        const entry = entries.get(associationID);
        if (entry === undefined) return;
        clearTimer(entry);
        entry.timer = setTimeout(() => {
            const current = entries.get(associationID);
            if (current !== undefined) current.timer = null;
            options.onChanged(associationID);
        }, debounceMs);
        entry.timer.unref?.();
    };

    return {
        async start(associationID, worktreePath) {
            const epoch = (epochs.get(associationID) ?? 0) + 1;
            epochs.set(associationID, epoch);
            teardown(associationID);

            let headPath: string;
            try {
                headPath = await options.resolveHeadPath(worktreePath);
            } catch {
                // Not a repo (or git is unavailable): nothing to watch, and that is fine.
                return;
            }
            // A stop() or a newer start() landed while we were resolving.
            if (epochs.get(associationID) !== epoch) return;

            const directory = path.dirname(headPath);
            const name = path.basename(headPath);
            let handle: HeadWatchHandle | null = null;
            try {
                handle = watchFn(directory, (_event, filename) => {
                    // A null filename means the platform could not name the entry; treating it
                    // as a HEAD change costs one debounced git read.
                    if (filename !== null && path.basename(filename) !== name) return;
                    schedule(associationID);
                });
                handle.on('error', (error) => {
                    options.onError?.(error, `head watch ${headPath}`);
                });
            } catch (error) {
                options.onError?.(
                    error instanceof Error ? error : new Error(String(error)),
                    `head watch ${headPath}`
                );
                handle = null;
            }
            entries.set(associationID, { headPath, handle, timer: null, epoch });
        },

        stop(associationID) {
            epochs.set(associationID, (epochs.get(associationID) ?? 0) + 1);
            teardown(associationID);
        },

        stopAll() {
            for (const associationID of [...entries.keys()]) {
                epochs.set(associationID, (epochs.get(associationID) ?? 0) + 1);
                teardown(associationID);
            }
        },

        watched() {
            return [...entries.keys()];
        },

        headPath(associationID) {
            return entries.get(associationID)?.headPath ?? null;
        }
    };
}
