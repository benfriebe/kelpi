/**
 * The per-open-file watcher behind the markdown preview (content-panes.md §3.12 + port note 6).
 *
 * The Swift app watches the file itself (kqueue, `O_EVTONLY`) with mask
 * `[write, extend, rename, delete]`. Node's `fs.watch` collapses that to two event names, and
 * the important half is the same either way:
 *
 *   - `change`  → reload (the caller's unchanged-content guard makes a `touch` free);
 *   - `rename`  → the **vim save dance**: vim writes a new file and renames it over the old
 *     one, which invalidates the watch. So: stop watching, wait 200 ms, re-attach to the same
 *     path, reload. A file that is genuinely gone leaves the re-attach failing silently (the
 *     reload renders the "Failed to load file" blockquote) until something rebuilds the watch.
 *
 * `suspend()` exists for edit mode: while a pane's authoritative buffer is being edited the
 * watcher must not fire, or the editor's own autosave would echo back as an external change
 * (§4.2 "No file watching in edit mode"; port note 7 keeps that invariant in the daemon).
 */

import fs from 'node:fs';

/** §3.12: the delay between losing the watch and re-attaching to the same path. */
export const RENAME_REATTACH_DELAY_MS = 200;

/** The slice of `fs.FSWatcher` this module uses (so tests can inject a fake). */
export interface WatchHandle {
    close(): void;
    on(event: 'error', listener: (error: Error) => void): unknown;
}

export type WatchFn = (
    path: string,
    listener: (event: string, filename: string | null) => void
) => WatchHandle;

export interface FileWatcher {
    readonly path: string;
    /** True while an OS watch is attached. */
    readonly watching: boolean;
    readonly suspended: boolean;
    /** Detach without forgetting the path (edit mode). Idempotent. */
    suspend(): void;
    /** Re-attach after `suspend`. Does NOT fire `onChange` by itself. Idempotent. */
    resume(): void;
    close(): void;
}

export interface WatchFileOptions {
    readonly path: string;
    /** Fired for a write/extend, and again after every successful rename re-attach. */
    readonly onChange: () => void;
    readonly reattachDelayMs?: number | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
    /** Injection point for tests; defaults to `fs.watch`. */
    readonly watch?: WatchFn | undefined;
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

export function watchFile(options: WatchFileOptions): FileWatcher {
    const delay = options.reattachDelayMs ?? RENAME_REATTACH_DELAY_MS;
    const watchFn: WatchFn =
        options.watch ??
        ((path, listener) => fs.watch(path, { persistent: false }, listener) as WatchHandle);

    let handle: WatchHandle | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let suspended = false;

    const detach = (): void => {
        if (handle === null) return;
        try {
            handle.close();
        } catch {
            // Already dead; nothing to release.
        }
        handle = null;
    };

    const cancelTimer = (): void => {
        if (timer === null) return;
        clearTimeout(timer);
        timer = null;
    };

    const attach = (): void => {
        if (closed || suspended || handle !== null) return;
        try {
            const created = watchFn(options.path, (event) => {
                onEvent(event);
            });
            // An ENOENT surfacing as an error is the delete half of the rename dance.
            created.on('error', () => {
                scheduleReattach();
            });
            handle = created;
        } catch (error) {
            // The path does not exist (yet): stay unwatched rather than throwing at the caller.
            options.onError?.(toError(error), `watch ${options.path}`);
        }
    };

    const scheduleReattach = (): void => {
        if (closed || suspended) return;
        detach();
        cancelTimer();
        timer = setTimeout(() => {
            timer = null;
            if (closed || suspended) return;
            attach();
            options.onChange();
        }, delay);
        // A pending re-attach must never hold the daemon open.
        timer.unref?.();
    };

    function onEvent(event: string): void {
        if (closed || suspended) return;
        if (event === 'rename') {
            scheduleReattach();
            return;
        }
        options.onChange();
    }

    attach();

    return {
        path: options.path,
        get watching() {
            return handle !== null;
        },
        get suspended() {
            return suspended;
        },
        suspend() {
            if (closed || suspended) return;
            suspended = true;
            cancelTimer();
            detach();
        },
        resume() {
            if (closed || !suspended) return;
            suspended = false;
            attach();
        },
        close() {
            if (closed) return;
            closed = true;
            cancelTimer();
            detach();
        }
    };
}
