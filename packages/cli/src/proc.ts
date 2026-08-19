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
