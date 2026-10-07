/**
 * Where a pane's shell is right now, asked of the OS: what a split inherits when the stored
 * directory may be stale.
 *
 * A pane's `workingDirectory` only follows the shell over OSC 7 (terminal-surface.md §7.2), and
 * the daemon's zsh integration (`shell-integration.ts`) is the only thing that sends it for a
 * stock setup. bash, fish, a zsh that ran `exec zsh`, or one started with the integration
 * turned off never report, so a split of them copied the directory the pane was born in.
 * Orca resolves a split the same way this does: the process's own cwd, from `/proc` on Linux
 * and `lsof` on macOS (about 50 ms there), bounded by a timeout, with concurrent asks for the
 * same pid sharing one lookup. There is no result cache: a `cd` just before a split must count.
 *
 * The answer is the PHYSICAL path. `chooseSplitDirectory` keeps the stored, logical one
 * (`/var/folders/…`, a symlinked `~/code`) whenever both name the same directory.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readlink, realpath, stat } from 'node:fs/promises';

/** Longest a split waits on the OS before it falls back to the stored directory. */
export const PROCESS_CWD_TIMEOUT_MS = 1_000;

export type ProcessCwdReader = (pid: number) => Promise<string | null>;

export interface ProcessCwdReaderOptions {
    readonly timeoutMs?: number | undefined;
    readonly platform?: NodeJS.Platform | undefined;
    /** Runs `lsof` and resolves its stdout (tests). */
    readonly runLsof?: ((args: readonly string[], timeoutMs: number) => Promise<string>) | undefined;
    /** Reads `/proc/<pid>/cwd` (tests). */
    readonly readProcLink?: ((path: string) => Promise<string>) | undefined;
}

/** A reader of a process's cwd; null when the OS would not say (gone, timed out, no lsof). */
export function createProcessCwdReader(options: ProcessCwdReaderOptions = {}): ProcessCwdReader {
    const timeoutMs = options.timeoutMs ?? PROCESS_CWD_TIMEOUT_MS;
    const platform = options.platform ?? process.platform;
    const runLsof = options.runLsof ?? execLsof;
    const readProcLink = options.readProcLink ?? readlink;
    const inflight = new Map<number, Promise<string | null>>();

    const resolve = async (pid: number): Promise<string | null> => {
        if (platform === 'linux') {
            try {
                return await readProcLink(`/proc/${String(pid)}/cwd`);
            } catch {
                // Not ours to read, or gone: lsof will not do better.
                return null;
            }
        }
        try {
            const stdout = await runLsof(['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], timeoutMs);
            // `-Fn` prints one field per line; the name field is the one starting with `n`.
            const name = stdout.split('\n').find((line) => line.startsWith('n/'));
            return name === undefined ? null : name.slice(1);
        } catch {
            return null;
        }
    };

    return (pid) => {
        const pending = inflight.get(pid);
        if (pending !== undefined) return pending;
        const lookup = resolve(pid).finally(() => {
            inflight.delete(pid);
        });
        inflight.set(pid, lookup);
        return lookup;
    };
}

export interface SplitDirectoryFs {
    readonly realpath: (path: string) => Promise<string>;
    readonly isDirectory: (path: string) => Promise<boolean>;
}

const nodeFs: SplitDirectoryFs = {
    realpath: (path) => realpath(path),
    isDirectory: async (path) => {
        try {
            return (await stat(path)).isDirectory();
        } catch {
            return false;
        }
    }
};

/**
 * The directory a split should open in, from the stored one and where the shell really is.
 *
 * The stored path wins when the shell is still in it, because it is the logical path the user
 * typed or the shell reported. Otherwise the live directory wins, so a shell that never sent
 * OSC 7 (or sent a stale or remote one, as an ssh session's shell can) still splits where it
 * is. A live answer that is not a directory here (lsof escapes odd names) is not trusted.
 */
export async function chooseSplitDirectory(
    stored: string,
    live: string | null,
    fs: SplitDirectoryFs = nodeFs
): Promise<string> {
    if (live === null || live === '' || live === stored) return stored;
    try {
        if ((await fs.realpath(stored)) === live) return stored;
    } catch {
        // The stored directory is gone: the live one is the only answer left.
    }
    return (await fs.isDirectory(live)) ? live : stored;
}

const LSOF = '/usr/sbin/lsof';

/** `lsof` from its macOS home, so a daemon whose PATH lacks `/usr/sbin` still finds it. */
function execLsof(args: readonly string[], timeoutMs: number): Promise<string> {
    const file = existsSync(LSOF) ? LSOF : 'lsof';
    return new Promise((resolve, reject) => {
        execFile(file, [...args], { encoding: 'utf8', timeout: timeoutMs }, (error, stdout) => {
            if (error !== null) reject(error);
            else resolve(stdout);
        });
    });
}
