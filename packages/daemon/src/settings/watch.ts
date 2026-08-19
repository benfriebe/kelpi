/**
 * The config-file watcher.
 *
 * Same shape as `content/watcher.ts` (fs.watch + the vim-save rename re-attach), with two
 * differences that a *config* file forces and a *document* file does not:
 *
 *   1. **The file usually does not exist.** A user with no `~/.config/ghostty/config` is the
 *      common case, and `fs.watch` on a missing path throws. So when the file is absent this
 *      watches its PARENT DIRECTORY and filters by basename, which is also how the file's
 *      first-ever creation gets noticed. When the directory is missing too, the watch simply
 *      does not attach — a retry would be a poll, and a daemon that never sees a config file
 *      appear is exactly today's behavior, not a regression.
 *   2. **Editors rewrite it.** `$EDITOR` on a config file is atomic-rename territory just like
 *      vim on a note, and every rename invalidates the file watch — hence the same
 *      detach → wait → re-attach → fire dance.
 *
 * Events are DEBOUNCED: one save can produce a `rename` plus two `change`s, and each of those
 * would otherwise re-read two files and broadcast to every client.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Delay between losing the watch and re-attaching (content-panes.md §3.12's 200 ms). */
export const CONFIG_REATTACH_DELAY_MS = 200;

/** Coalescing window: an editor's save burst is one settings change, not three. */
export const CONFIG_DEBOUNCE_MS = 60;

export interface ConfigWatchHandle {
    close(): void;
    on(event: 'error', listener: (error: Error) => void): unknown;
}

export type ConfigWatchFn = (
    target: string,
    listener: (event: string, filename: string | null) => void
) => ConfigWatchHandle;

export interface ConfigWatcher {
    readonly path: string;
    /** True while an OS watch is attached (to the file or to its directory). */
    readonly watching: boolean;
    /** What the current watch is attached to; null when nothing could be watched. */
    readonly mode: 'file' | 'directory' | null;
    close(): void;
}

export interface WatchConfigOptions {
    readonly path: string;
    /** Fired (debounced) for any write / rename / create of the watched file. */
    readonly onChange: () => void;
    readonly debounceMs?: number | undefined;
    readonly reattachDelayMs?: number | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
    /** Injection point for tests; defaults to `fs.watch`. */
    readonly watch?: ConfigWatchFn | undefined;
    /** Existence probe; defaults to `fs.existsSync`. */
    readonly exists?: ((target: string) => boolean) | undefined;
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

export function watchConfigFile(options: WatchConfigOptions): ConfigWatcher {
    const debounceMs = options.debounceMs ?? CONFIG_DEBOUNCE_MS;
    const reattachDelayMs = options.reattachDelayMs ?? CONFIG_REATTACH_DELAY_MS;
    const exists = options.exists ?? ((target: string): boolean => fs.existsSync(target));
    const watchFn: ConfigWatchFn =
        options.watch ??
        ((target, listener) => fs.watch(target, { persistent: false }, listener) as ConfigWatchHandle);

    const directory = path.dirname(options.path);
    const basename = path.basename(options.path);

    let handle: ConfigWatchHandle | null = null;
    let mode: 'file' | 'directory' | null = null;
    let reattachTimer: ReturnType<typeof setTimeout> | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const clear = (timer: ReturnType<typeof setTimeout> | null): null => {
        if (timer !== null) clearTimeout(timer);
        return null;
    };

    const detach = (): void => {
        if (handle === null) return;
        try {
            handle.close();
        } catch {
            // Already dead; nothing to release.
        }
        handle = null;
        mode = null;
    };

    const fire = (): void => {
        if (closed) return;
        debounceTimer = clear(debounceTimer);
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            if (closed) return;
            options.onChange();
        }, debounceMs);
        debounceTimer.unref?.();
    };

    const scheduleReattach = (): void => {
        if (closed) return;
        detach();
        reattachTimer = clear(reattachTimer);
        reattachTimer = setTimeout(() => {
            reattachTimer = null;
            if (closed) return;
            attach();
            fire();
        }, reattachDelayMs);
        // A pending re-attach must never hold the daemon open.
        reattachTimer.unref?.();
    };

    function attach(): void {
        if (closed || handle !== null) return;
        // File first: a direct watch sees writes that a directory watch may not report.
        if (exists(options.path)) {
            try {
                const created = watchFn(options.path, (event) => {
                    if (closed) return;
                    if (event === 'rename') scheduleReattach();
                    else fire();
                });
                created.on('error', () => scheduleReattach());
                handle = created;
                mode = 'file';
                return;
            } catch (error) {
                options.onError?.(toError(error), `watch ${options.path}`);
            }
        }
        // Fall back to the directory so the file's creation is noticed.
        if (!exists(directory)) return;
        try {
            const created = watchFn(directory, (_event, filename) => {
                if (closed) return;
                // A directory event names the entry that changed; anything else is noise.
                if (filename !== null && filename !== basename) return;
                // The file may now exist — swap up to a direct watch and report the change.
                scheduleReattach();
            });
            created.on('error', () => scheduleReattach());
            handle = created;
            mode = 'directory';
        } catch (error) {
            options.onError?.(toError(error), `watch ${directory}`);
        }
    }

    attach();

    return {
        path: options.path,
        get watching() {
            return handle !== null;
        },
        get mode() {
            return mode;
        },
        close() {
            if (closed) return;
            closed = true;
            reattachTimer = clear(reattachTimer);
            debounceTimer = clear(debounceTimer);
            detach();
        }
    };
}
