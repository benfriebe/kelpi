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

import { execFile, spawn, type ChildProcess } from 'node:child_process';
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
    /**
     * Kill the child when the caller no longer wants the answer — the content service uses it
     * to cancel a superseded `git diff` (content-panes.md §5.1 / §CONT-107), and a cancelled
     * worktree create its fetch or checkout (#294). The child's whole process group is killed,
     * so git's own children go too. An abort rejects the promise, so callers that expect one
     * check `signal.aborted` instead of reading the error.
     */
    readonly signal?: AbortSignal | undefined;
    /**
     * Sees stderr as it arrives, chunk by chunk, while it is still being buffered for the
     * error (issue #294: the worktree create's `--progress` percentages). A tap, not a
     * redirect: the promise still settles exactly as it would without one.
     */
    readonly onStderr?: ((chunk: string) => void) | undefined;
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
 * normal ENOENT if it truly is not installed). `KELPI_GIT` overrides for tests / odd installs.
 */
export function resolveGitExecutable(
    env: Readonly<Record<string, string | undefined>> = process.env
): string {
    const override = env['KELPI_GIT'];
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

/** The rejection an aborted run settles with (`signal.aborted` is still the test callers use). */
function gitAbortError(command: string): Error {
    return Object.assign(new Error(`${command} was cancelled`), { name: 'AbortError', code: 'ABORT_ERR' });
}

/**
 * Kill a run's whole process GROUP (issue #294). `git worktree add` does its checkout in a child
 * `git reset --hard` (and runs hooks), and a fetch runs `index-pack` and the transport: killing
 * only the parent would leave a child writing into a worktree the cancel is about to delete, and
 * holding the output pipes open so the run never settles. A run with a signal is therefore
 * spawned as its own group leader (`detached`); the fallback covers a pid-less child.
 */
function killRunTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
    const pid = child.pid;
    if (pid !== undefined) {
        try {
            process.kill(-pid, signal);
            return;
        } catch {
            // Already gone, or not a group leader: fall through to the child itself.
        }
    }
    child.kill(signal);
}

/** How long an aborted run gets to exit on SIGTERM before its group is SIGKILLed. */
const ABORT_KILL_GRACE_MS = 5_000;

/**
 * The cancellable run: `spawn` rather than `execFile`, because `execFile` does not pass
 * `detached` through, and a group of its own is what lets an abort reach git's children.
 * Otherwise the same contract: stdout on exit 0, a `GitCommandError` with trimmed stderr on a
 * non-zero exit, the raw error when git cannot be started, and an `AbortError` once aborted
 * (settled when git EXITS, so the caller's cleanup never races git's own).
 */
function runCancellable(
    executable: string,
    args: readonly string[],
    runOptions: RunGitOptions & { readonly signal: AbortSignal },
    command: string
): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const { signal } = runOptions;
        if (signal.aborted) {
            reject(gitAbortError(command));
            return;
        }
        const child = spawn(executable, [...args], {
            cwd: runOptions.cwd,
            env: { ...process.env, ...(runOptions.env ?? {}) },
            detached: true,
            // Nothing the cancellable family runs reads stdin.
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const maxBuffer = runOptions.maxBuffer ?? DEFAULT_MAX_BUFFER;
        let stdout = '';
        let stderr = '';
        let settled = false;
        let failure: Error | null = null;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let escalate: ReturnType<typeof setTimeout> | null = null;
        const finish = (settle: () => void): void => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            if (timer !== null) clearTimeout(timer);
            if (escalate !== null) clearTimeout(escalate);
            settle();
        };
        const onAbort = (): void => {
            killRunTree(child);
            escalate = setTimeout(() => killRunTree(child, 'SIGKILL'), ABORT_KILL_GRACE_MS);
            escalate.unref?.();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (runOptions.timeoutMs !== undefined && runOptions.timeoutMs > 0) {
            timer = setTimeout(() => {
                failure = new Error(`${command} timed out after ${String(runOptions.timeoutMs)} ms`);
                killRunTree(child);
            }, runOptions.timeoutMs);
            timer.unref?.();
        }
        const overflow = (): void => {
            failure = new Error(`${command} produced more than ${String(maxBuffer)} bytes of output`);
            killRunTree(child);
        };
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
            stdout += chunk;
            if (stdout.length > maxBuffer) overflow();
        });
        child.stderr?.on('data', (chunk: string) => {
            stderr += chunk;
            if (stderr.length > maxBuffer) overflow();
            runOptions.onStderr?.(chunk);
        });
        child.on('error', (error) => {
            // ENOENT / EACCES: git itself is missing, not a failed git command.
            finish(() => reject(error));
        });
        // An aborted run settles on EXIT: a grandchild that escaped the group must not be able
        // to hold the pipes, and with them the cancel, open.
        child.on('exit', () => {
            if (signal.aborted) finish(() => reject(gitAbortError(command)));
        });
        child.on('close', (code) => {
            finish(() => {
                if (signal.aborted) reject(gitAbortError(command));
                else if (failure !== null) reject(failure);
                else if (code === 0) resolve(stdout);
                else reject(new GitCommandError({ command, exitCode: code ?? 1, stderr: stderr.trim(), cwd: runOptions.cwd }));
            });
        });
    });
}

export function createGitRunner(options: CreateGitRunnerOptions = {}): GitRunner {
    const executable = options.executable ?? resolveGitExecutable(options.env ?? process.env);
    return (args, runOptions) => {
        const command = `git ${args.join(' ')}`;
        const signal = runOptions.signal;
        if (signal !== undefined) return runCancellable(executable, args, { ...runOptions, signal }, command);
        return new Promise<string>((resolve, reject) => {
            const child = execFile(
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
            const onStderr = runOptions.onStderr;
            // `encoding: 'utf8'` has already set the stream's encoding, so chunks are strings.
            if (onStderr !== undefined) child.stderr?.on('data', (chunk: string | Buffer) => onStderr(String(chunk)));
        });
    };
}

/** Clamp a caller budget up to the long-operation floor (never shortens a worktree op). */
export function longGitTimeout(timeoutMs: number | undefined): number | undefined {
    if (timeoutMs === undefined) return undefined;
    return Math.max(timeoutMs, MIN_LONG_GIT_TIMEOUT_MS);
}
