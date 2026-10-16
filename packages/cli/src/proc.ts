/**
 * Minimal subprocess runner — `doctor`'s `ps` and `workspace delete --prune-worktree`'s git.
 *
 * `execFile` drains stdout and stderr concurrently, which is the whole point (cli.md port
 * note 20): a sequential drain deadlocks once a child writes more than a pipe buffer (~16 KB
 * on macOS) to the stream nobody is reading yet, and `ps -axo` on a busy workstation is in
 * exactly that size range.
 */

import { execFile } from 'node:child_process';

export interface ProcessResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
}

export type ProcessRunner = (path: string, args: readonly string[]) => Promise<ProcessResult>;

export async function runProcess(path: string, args: readonly string[]): Promise<ProcessResult> {
    return new Promise<ProcessResult>((resolve) => {
        execFile(path, [...args], { maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
            if (error !== null) {
                const code = typeof error.code === 'number' ? error.code : -1;
                resolve({ stdout, stderr, exitCode: code });
                return;
            }
            resolve({ stdout, stderr, exitCode: 0 });
        });
    });
}

/**
 * The pids in `ps -axo pid=,comm=` output whose executable path ends with `suffix`: one app's
 * processes, told apart by the path inside its bundle (`Kelpi.app/Contents/MacOS/Kelpi`).
 */
export function pidsOfExecutable(psOutput: string, suffix: string): number[] {
    const pids: number[] = [];
    for (const line of psOutput.split('\n')) {
        const trimmed = line.trim();
        const separator = trimmed.indexOf(' ');
        if (separator < 0) continue;
        const pid = Number.parseInt(trimmed.slice(0, separator), 10);
        const comm = trimmed.slice(separator + 1).trim();
        if (Number.isInteger(pid) && comm.endsWith(suffix)) pids.push(pid);
    }
    return pids;
}
