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
 * timeout, with concurrent asks for the same pid sharing one lookup and no cache (the answer
 * changes the moment the agent starts or exits). A lookup that cannot answer REJECTS: the caller
 * treats "unknown" as "the shell may have the terminal", never as permission to paste.
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

export function createForegroundReader(options: ForegroundReaderOptions = {}): ForegroundReader {
    const timeoutMs = options.timeoutMs ?? FOREGROUND_CHECK_TIMEOUT_MS;
    const platform = options.platform ?? process.platform;
    const runPs = options.runPs ?? execPs;
    const readProcStat = options.readProcStat ?? ((path: string) => readFile(path, 'utf8'));
    const inflight = new Map<number, Promise<boolean>>();

    const resolve = async (pid: number): Promise<boolean> => {
        if (platform === 'linux') {
            // `pid (comm) state ppid pgrp session tty_nr tpgid …`; comm may hold spaces and
            // parentheses, so the fields are counted from the LAST `)`.
            const stat = await readProcStat(`/proc/${String(pid)}/stat`);
            const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
            return isForeground(Number(fields[5]), Number(fields[2]), pid);
        }
        const stdout = await runPs(['-o', 'tpgid=,pgid=', '-p', String(pid)], timeoutMs);
        const [tpgid, pgid] = stdout.trim().split(/\s+/).map(Number);
        return isForeground(tpgid ?? Number.NaN, pgid ?? Number.NaN, pid);
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
