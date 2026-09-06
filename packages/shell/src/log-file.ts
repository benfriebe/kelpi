/**
 * The shell log's file sink (issue #77).
 *
 * `./log.ts` writes to stdout, and a packaged app launched from the Dock or by the promote
 * restarter has nowhere for stdout to go. The one instrument the web-pane work is built around,
 *
 *     web pane <id> view owner=main|holder bounds=x,y w×h (reason)
 *
 * therefore existed only for someone running `electron .` in a terminal: a user reporting "web
 * panes are blank after I switched desktops" left nothing on disk to check that report against.
 * This is the second stream, and it is deliberately the dumbest thing that can work.
 *
 * The rules it keeps, in the order they matter:
 *
 *   - **It never throws.** A log sink that can raise turns a full disk, a deleted directory or a
 *     read-only volume into a crashed main process. Every filesystem call here is wrapped; a
 *     sink that cannot write goes quiet (`live === false`) and the app carries on with stdout
 *     exactly as it did before this file existed. That is the same posture `./log.ts` takes for
 *     a dead pipe, for the same reason.
 *   - **It is bounded.** `maxBytes` per file and `generations` files in total, checked BEFORE
 *     each write, so a shell left running for a month cannot fill a user's disk. The live file
 *     can exceed the cap by at most the one line that crossed it; splitting a line across two
 *     generations would be worse than a few bytes of overshoot.
 *   - **It is synchronous.** No buffer, no flush timer: the line that matters most is the last
 *     one before whatever went wrong, and a queued write is exactly the line a crash loses.
 *     The volume is a few hundred lines a session, so the cost is noise.
 *
 * Generations are `shell.log`, `shell.log.1`, … `shell.log.<generations-1>`, newest first, the
 * shape `logrotate` and `kelpid`'s own restarter log already use.
 *
 * One documented limit: the sink holds the live file open, so a file DELETED under a running
 * shell keeps taking writes on an unlinked inode until the app restarts. Noticing that would
 * cost a `stat` per line to buy back a case ("I deleted the log while it was running") that
 * costs nothing to work around, and the alternative - a sink that reopens speculatively - is a
 * hot filesystem loop on every log call.
 */

import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Per file. A few MB is several days of an ordinary session, and small enough to paste. */
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
/** Files kept in total, the live one included: `shell.log` and `shell.log.1`. */
export const DEFAULT_GENERATIONS = 2;

/** `<userData>/logs/shell.log`, beside Electron's own crash dumps, under the app's own state. */
export function shellLogFile(userDataDir: string): string {
    return join(userDataDir, 'logs', 'shell.log');
}

export interface FileSinkOptions {
    /** Rotate before a write that would take the live file past this. */
    readonly maxBytes?: number | undefined;
    /** Files kept in total (the live one plus `generations - 1` backups). Minimum 1. */
    readonly generations?: number | undefined;
    /** Told once, when the sink gives up. Never called with anything that must be handled. */
    readonly onError?: ((error: unknown) => void) | undefined;
}

export interface FileSink {
    /** Append one already-formatted chunk. Never throws. */
    write(chunk: string): void;
    close(): void;
    /** The live file's path (diagnostics: the shell prints it on stdout at startup). */
    readonly file: string;
    /** Bytes in the live file. */
    readonly bytes: number;
    /** False once the sink has given up; writes are then no-ops. */
    readonly live: boolean;
}

/** A sink that swallows everything, for a shell with nowhere to write (and for `close()`). */
const DEAD: FileSink = {
    write: () => {},
    close: () => {},
    file: '',
    bytes: 0,
    live: false
};

export function deadFileSink(): FileSink {
    return DEAD;
}

/**
 * Open (or create) `file` and return a sink that appends to it.
 *
 * Nothing here reports a failure by throwing: a sink that cannot be opened comes back already
 * dead, which is a sink the caller can use unconditionally.
 */
export function createFileSink(file: string, options: FileSinkOptions = {}): FileSink {
    const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
    const generations = Math.max(1, Math.floor(options.generations ?? DEFAULT_GENERATIONS));
    let fd: number | null = null;
    let bytes = 0;
    let live = true;

    const giveUp = (error: unknown): void => {
        if (!live) return;
        live = false;
        if (fd !== null) {
            try {
                closeSync(fd);
            } catch {
                // Already gone; there is nothing left to do about it.
            }
            fd = null;
        }
        try {
            options.onError?.(error);
        } catch {
            // A reporter that throws must not be the thing that takes the app down.
        }
    };

    /** Open the live file for append and adopt its current size. Returns false when it cannot. */
    const open = (): boolean => {
        try {
            mkdirSync(dirname(file), { recursive: true });
            fd = openSync(file, 'a');
            try {
                bytes = statSync(file).size;
            } catch {
                // A file we just opened but cannot stat: count from zero rather than refuse to
                // log. The worst case is one late rotation.
                bytes = 0;
            }
            return true;
        } catch (error) {
            giveUp(error);
            return false;
        }
    };

    /**
     * `shell.log.<n-1>` is dropped, every other backup shifts up one, and the live file becomes
     * `shell.log.1`. Best-effort throughout: a rename that fails leaves the sink writing to a
     * file that is over its cap, which is better than a sink that stops.
     */
    const rotate = (): void => {
        if (fd !== null) {
            try {
                closeSync(fd);
            } catch {
                // Nothing to do; the rename below is what matters.
            }
            fd = null;
        }
        try {
            rmSync(`${file}.${String(generations - 1)}`, { force: true });
        } catch {
            // Never a reason to stop rotating.
        }
        for (let index = generations - 2; index >= 1; index -= 1) {
            try {
                renameSync(`${file}.${String(index)}`, `${file}.${String(index + 1)}`);
            } catch {
                // That generation does not exist yet.
            }
        }
        if (generations > 1) {
            try {
                renameSync(file, `${file}.1`);
            } catch {
                // The live file is gone (someone deleted it): re-opening below creates it.
            }
        } else {
            try {
                rmSync(file, { force: true });
            } catch {
                // Same.
            }
        }
        bytes = 0;
        open();
    };

    if (!open()) return DEAD;

    return {
        write(chunk: string): void {
            if (!live) return;
            const size = Buffer.byteLength(chunk, 'utf8');
            // Before the write, not after: the cap is a promise about what is on disk, and a
            // file checked afterwards is always one line over it.
            if (bytes > 0 && bytes + size > maxBytes) rotate();
            const first = fd;
            if (!live || first === null) return;
            try {
                writeSync(first, chunk);
                bytes += size;
                return;
            } catch {
                // One reopen, then quiet. A file rotated out from under us by something else
                // (a tidy-up script, a user with `rm`) is recoverable and worth recovering;
                // a full disk is not, and a sink that retries every line would be a hot loop
                // on every log call for the rest of the session.
                fd = null;
            }
            if (!open()) return;
            const second = fd;
            if (second === null) return;
            try {
                writeSync(second, chunk);
                bytes += size;
            } catch (error) {
                giveUp(error);
            }
        },

        close(): void {
            if (fd !== null) {
                try {
                    closeSync(fd);
                } catch {
                    // Already gone.
                }
                fd = null;
            }
            live = false;
        },

        file,

        get bytes(): number {
            return bytes;
        },

        get live(): boolean {
            return live;
        }
    };
}
