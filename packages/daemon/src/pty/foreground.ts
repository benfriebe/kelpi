/**
 * Is a pane's shell the terminal's foreground process group right now? Asked of the OS.
 *
 * The agent launcher's hard rule (docs/agent-lifecycle.md §6.5): a prompt is only ever pasted
 * into an AGENT, never into a shell. When the agent never starts (command not found), crashes,
 * exits at an update or auth prompt, or is quit at its trust dialog, the shell takes the terminal
 * back, turns bracketed paste on again and would take a paste as a command line. Bracketed paste
 * and the screen cannot tell the two apart; the terminal's foreground process group can. The
 * shell is a job-control shell and its own group leader, so "the foreground group is the shell's
 * group" means nothing else is running in the pane.
 *
 * Read the way `./process-cwd.ts` reads a cwd: `/proc/<pid>/stat` on Linux, `ps` elsewhere
 * (`tpgid` is the controlling terminal's foreground group, `pgid` the shell's own), bounded by a
 * timeout, and never cached (the answer changes the moment the agent starts or exits). A lookup
 * that cannot answer REJECTS: the caller treats "unknown" as "the shell may have the terminal",
 * never as permission to paste.
 *
 * **Batched, and always fresh.** Every ask made in one turn of the event loop waits for the end
 * of that turn (`setImmediate`) and is then answered by ONE sample: a single
 * `ps -o pid=,tpgid=,pgid= -p a,b,c` for every pid asked about (two asks for the same pid share
 * it), or on Linux one `/proc` read per pid, which costs no process. Several pending launches
 * re-evaluating on the same event (a store change reaches all of them) therefore cost one `ps`,
 * not one each. An ask never joins a sample that had already been sent when it was made: it goes
 * into the next batch. So every answer was read from the OS AFTER the question was asked, which
 * is what the launcher's check immediately before a paste relies on (agent-lifecycle.md §6.5,
 * "The hard rule").
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

/** Longest a foreground check waits on the OS before it counts as unanswered. */
export const FOREGROUND_CHECK_TIMEOUT_MS = 1_000;

/** Resolves true when `pid`'s process group holds its terminal; rejects when the OS will not say. */
export type ForegroundReader = (pid: number) => Promise<boolean>;

export interface ForegroundReaderOptions {
    readonly timeoutMs?: number | undefined;
    readonly platform?: NodeJS.Platform | undefined;
    /** Runs `ps` and resolves its stdout (tests). */
    readonly runPs?: ((args: readonly string[], timeoutMs: number) => Promise<string>) | undefined;
    /** Reads `/proc/<pid>/stat` (tests). */
    readonly readProcStat?: ((path: string) => Promise<string>) | undefined;
}

/** The terminal's foreground group is the process's own; throws when either number is unusable. */
function isForeground(tpgid: number, pgid: number, pid: number): boolean {
    // `tpgid` is 0 or -1 for a process with no controlling terminal: no answer to give.
    if (!Number.isInteger(tpgid) || !Number.isInteger(pgid) || tpgid <= 0 || pgid <= 0) {
        throw new Error(`no foreground process group for pid ${String(pid)}`);
    }
    return tpgid === pgid;
}

interface Waiter {
    readonly resolve: (shell: boolean) => void;
    readonly reject: (error: Error) => void;
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

function settle(waiters: readonly Waiter[], answer: () => boolean): void {
    let shell: boolean;
    try {
        shell = answer();
    } catch (error) {
        for (const waiter of waiters) waiter.reject(toError(error));
        return;
    }
    for (const waiter of waiters) waiter.resolve(shell);
}

export function createForegroundReader(options: ForegroundReaderOptions = {}): ForegroundReader {
    const timeoutMs = options.timeoutMs ?? FOREGROUND_CHECK_TIMEOUT_MS;
    const platform = options.platform ?? process.platform;
    const runPs = options.runPs ?? execPs;
    const readProcStat = options.readProcStat ?? ((path: string) => readFile(path, 'utf8'));
    /** Asks not yet sent to the OS, by pid. Replaced (not cleared) when a batch is sent. */
    let queued = new Map<number, Waiter[]>();
    let scheduled = false;

    const readLinux = (pid: number, waiters: readonly Waiter[]): void => {
        // Through a resolved promise, so a reader that throws rejects instead of escaping.
        Promise.resolve(`/proc/${String(pid)}/stat`).then(readProcStat).then(
            (stat) => {
                // `pid (comm) state ppid pgrp session tty_nr tpgid …`; comm may hold spaces and
                // parentheses, so the fields are counted from the LAST `)`.
                const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
                settle(waiters, () => isForeground(Number(fields[5]), Number(fields[2]), pid));
            },
            (error: unknown) => {
                for (const waiter of waiters) waiter.reject(toError(error));
            }
        );
    };

    const send = (batch: ReadonlyMap<number, readonly Waiter[]>): void => {
        if (platform === 'linux') {
            for (const [pid, waiters] of batch) readLinux(pid, waiters);
            return;
        }
        const pids = [...batch.keys()];
        // `ps` prints a row for each pid that exists, in its own order, and fails only when none
        // does; a pid with no row is one that cannot be answered for.
        const args = ['-o', 'pid=,tpgid=,pgid=', '-p', pids.map(String).join(',')];
        Promise.resolve(args).then((asked) => runPs(asked, timeoutMs)).then(
            (stdout) => {
                const rows = new Map<number, readonly [number, number]>();
                for (const line of stdout.split('\n')) {
                    const [pid, tpgid, pgid] = line.trim().split(/\s+/).map(Number);
                    if (pid !== undefined && Number.isInteger(pid)) rows.set(pid, [tpgid ?? Number.NaN, pgid ?? Number.NaN]);
                }
                for (const [pid, waiters] of batch) {
                    const row = rows.get(pid);
                    settle(waiters, () => isForeground(row?.[0] ?? Number.NaN, row?.[1] ?? Number.NaN, pid));
                }
            },
            (error: unknown) => {
                for (const waiters of batch.values()) for (const waiter of waiters) waiter.reject(toError(error));
            }
        );
    };

    return (pid) =>
        new Promise<boolean>((resolve, reject) => {
            const waiters = queued.get(pid);
            if (waiters === undefined) queued.set(pid, [{ resolve, reject }]);
            else waiters.push({ resolve, reject });
            if (scheduled) return;
            scheduled = true;
            setImmediate(() => {
                scheduled = false;
                const batch = queued;
                queued = new Map();
                send(batch);
            });
        });
}

const PS = '/bin/ps';

/** `ps` from its usual home, so a daemon whose PATH lacks `/bin` still finds it. */
function execPs(args: readonly string[], timeoutMs: number): Promise<string> {
    const file = existsSync(PS) ? PS : 'ps';
    return new Promise((resolve, reject) => {
        execFile(file, [...args], { encoding: 'utf8', timeout: timeoutMs }, (error, stdout) => {
            if (error !== null) reject(error);
            else resolve(stdout);
        });
    });
}
