/**
 * The daemon's git process layer (graft-git.md §3.1 `runGit`).
 *
 * Conventions that are contract:
 *   - `cwd` is the repo/worktree path; **no `-C` flag** is ever used;
 *   - the daemon's environment is inherited, extra vars are merged OVER it;
 *   - stdout and stderr are captured separately;
 *   - exit 0 → stdout (possibly empty); non-zero → a `GitCommandError` whose **trimmed
 *     stderr is load-bearing** (`worktreeErrorMessage` mines it for the user-facing text);
 *   - **no timeout by default.** `git fetch` on the `--update-main` path can take minutes and
 *     the CLI already waits 120s for the reply, so any caller-supplied budget is clamped up to
 *     `MIN_LONG_GIT_TIMEOUT_MS` for the worktree/fetch family.
 *
 * The executable is resolved from `PATH` (the Swift app hard-codes `/usr/bin/git`; the port
 * note asks for PATH resolution so Homebrew/asdf gits win).
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Nothing in the worktree family may be given a shorter budget than this (graft-git §7.6). */
export const MIN_LONG_GIT_TIMEOUT_MS = 120_000;

/** 64 MiB: a `git diff` of a large tree must not be truncated into a parse error. */
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

export class GitCommandError extends Error {
    readonly kind = 'commandFailed' as const;
    /** `"git " + args.join(" ")` — echoed in diagnostics, never in the CLI reply. */
    readonly command: string;
    readonly exitCode: number;
    /** Trimmed; used verbatim by `worktreeErrorMessage`. */
    readonly stderr: string;
    readonly cwd: string;

    constructor(input: {
        readonly command: string;
        readonly exitCode: number;
        readonly stderr: string;
        readonly cwd: string;
    }) {
        super(
            input.stderr.length > 0
                ? input.stderr
                : `${input.command} exited with code ${String(input.exitCode)}`
        );
        this.name = 'GitCommandError';
        this.command = input.command;
        this.exitCode = input.exitCode;
        this.stderr = input.stderr;
        this.cwd = input.cwd;
    }
}

export function isGitCommandError(value: unknown): value is GitCommandError {
    return value instanceof GitCommandError;
}

export interface RunGitOptions {
    /** The repo/worktree directory git runs in. */
    readonly cwd: string;
    /** Merged OVER the inherited environment (only `GIT_INDEX_FILE` uses this today). */
    readonly env?: Readonly<Record<string, string>> | undefined;
    /** Milliseconds; omitted = block until git exits (the spec default). */
    readonly timeoutMs?: number | undefined;
    readonly maxBuffer?: number | undefined;
}

export interface GitRunner {
    (args: readonly string[], options: RunGitOptions): Promise<string>;
}

function executableAt(candidate: string): boolean {
    try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}

/**
 * First `git` on `PATH`, or the bare name so `spawn` can still resolve it (and produce a
 * normal ENOENT if it truly is not installed). `NEX_GIT` overrides for tests / odd installs.
 */
export function resolveGitExecutable(
    env: Readonly<Record<string, string | undefined>> = process.env
): string {
    const override = env['NEX_GIT'];
    if (override !== undefined && override.length > 0) return override;
    const search = env['PATH'] ?? '';
    for (const entry of search.split(path.delimiter)) {
        if (entry.length === 0) continue;
        const candidate = path.join(entry, 'git');
        if (executableAt(candidate)) return candidate;
    }
    return 'git';
}

export interface CreateGitRunnerOptions {
    readonly executable?: string | undefined;
    readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

export function createGitRunner(options: CreateGitRunnerOptions = {}): GitRunner {
    const executable = options.executable ?? resolveGitExecutable(options.env ?? process.env);
    return (args, runOptions) =>
        new Promise<string>((resolve, reject) => {
            const command = `git ${args.join(' ')}`;
            execFile(
                executable,
                [...args],
                {
                    cwd: runOptions.cwd,
                    env: { ...process.env, ...(runOptions.env ?? {}) },
                    maxBuffer: runOptions.maxBuffer ?? DEFAULT_MAX_BUFFER,
                    // `execFile` reads `timeout: 0` as "no timeout", which is the spec default.
                    timeout: runOptions.timeoutMs ?? 0,
                    encoding: 'utf8'
                },
                (error, stdout, stderr) => {
                    if (error === null) {
                        resolve(stdout);
                        return;
                    }
                    const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
                    if (typeof code === 'string') {
                        // ENOENT / EACCES: git itself is missing, not a failed git command.
                        reject(error);
                        return;
                    }
                    reject(
                        new GitCommandError({
                            command,
                            exitCode: typeof code === 'number' ? code : 1,
                            stderr: stderr.trim(),
                            cwd: runOptions.cwd
                        })
                    );
                }
            );
        });
}

/** Clamp a caller budget up to the long-operation floor (never shortens a worktree op). */
export function longGitTimeout(timeoutMs: number | undefined): number | undefined {
    if (timeoutMs === undefined) return undefined;
    return Math.max(timeoutMs, MIN_LONG_GIT_TIMEOUT_MS);
}
