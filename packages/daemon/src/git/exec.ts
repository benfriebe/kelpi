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
import { StringDecoder } from 'node:string_decoder';
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
    /** SIGTERM → SIGKILL grace for an aborted run's process group (tests shorten it). */
    readonly abortGraceMs?: number | undefined;
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

/** How long an aborted run's group gets to exit on SIGTERM before it is SIGKILLed. */
export const ABORT_KILL_GRACE_MS = 5_000;

/** How often an aborted run checks whether its process group is gone yet. */
const GROUP_POLL_MS = 25;

/** True while any process of the group led by `pid` is alive (the leader may already be reaped). */
function groupAlive(pid: number): boolean {
    try {
        process.kill(-pid, 0);
        return true;
    } catch (error) {
        // EPERM means it exists but is not ours to signal; only ESRCH means gone.
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/** The error `execFile` rejects with on overflow, so both runner paths fail the same way. */
function maxBufferError(stream: 'stdout' | 'stderr'): Error {
    return Object.assign(new RangeError(`${stream} maxBuffer length exceeded`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
}

/**
 * The cancellable run: `spawn` rather than `execFile`, because `execFile` does not pass
 * `detached` through, and a group of its own is what lets an abort reach git's children.
 *
 * Kept to `execFile`'s contract for the callers that were already passing a signal (the diff
 * pane's `getDiff`, §CONT-107): stdout on exit 0; a `GitCommandError` with trimmed stderr on a
 * non-zero exit AND on a timeout (what `execFile` produced for a killed child); the raw Node
 * error when git cannot be started; `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` when either stream
 * passes `maxBuffer` BYTES. What differs, deliberately: stdin is `/dev/null` (nothing in the
 * cancellable family reads it), and an abort rejects with an `AbortError` only once the whole
 * process GROUP is gone (SIGTERM, then SIGKILL after `ABORT_KILL_GRACE_MS`), so a caller's
 * cleanup never runs while a child of git (a checkout's filter, a hook) is still writing.
 */
function runCancellable(
    executable: string,
    args: readonly string[],
    runOptions: RunGitOptions & { readonly signal: AbortSignal },
    command: string,
    graceMs: number
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
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const maxBuffer = runOptions.maxBuffer ?? DEFAULT_MAX_BUFFER;
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        const stderrText = new StringDecoder('utf8');
        let settled = false;
        let failure: Error | null = null;
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let abortedAt: number | null = null;
        let killedHard = false;
        const finish = (settle: () => void): void => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            if (timer !== null) clearTimeout(timer);
            settle();
        };
        /*
         * After an abort the run settles when the GROUP is gone, not when the leader exits: git's
         * `worktree add` can die on SIGTERM while a child that ignores it (a smudge filter, a hook)
         * keeps writing into the directory the caller is about to delete. The SIGKILL escalation
         * therefore stays armed past the leader's exit, and `kill(-pid)` on a group that is already
         * gone only gets ESRCH.
         */
        const settleWhenGroupGone = (): void => {
            const pid = child.pid;
            if (pid === undefined || !groupAlive(pid)) {
                finish(() => reject(gitAbortError(command)));
                return;
            }
            if (!killedHard && abortedAt !== null && Date.now() - abortedAt >= graceMs) {
                killedHard = true;
                killRunTree(child, 'SIGKILL');
            }
            // Give up waiting a second after SIGKILL: a process that survives it is not ours.
            if (killedHard && abortedAt !== null && Date.now() - abortedAt >= graceMs + 1_000) {
                finish(() => reject(gitAbortError(command)));
                return;
            }
            setTimeout(settleWhenGroupGone, GROUP_POLL_MS);
        };
        const onAbort = (): void => {
            abortedAt = Date.now();
            killRunTree(child);
            const escalate = setTimeout(() => {
                if (settled || killedHard) return;
                killedHard = true;
                killRunTree(child, 'SIGKILL');
            }, graceMs);
            escalate.unref?.();
            // The leader may already have exited (its pipes held open by a child): settle from here.
            if (child.exitCode !== null || child.signalCode !== null) settleWhenGroupGone();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (runOptions.timeoutMs !== undefined && runOptions.timeoutMs > 0) {
            timer = setTimeout(() => {
                timedOut = true;
                killRunTree(child);
            }, runOptions.timeoutMs);
            timer.unref?.();
        }
        child.stdout?.on('data', (chunk: Buffer) => {
            stdoutBytes += chunk.length;
            if (stdoutBytes > maxBuffer) {
                failure ??= maxBufferError('stdout');
                killRunTree(child);
                return;
            }
            stdout.push(chunk);
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            stderrBytes += chunk.length;
            if (stderrBytes > maxBuffer) {
                failure ??= maxBufferError('stderr');
                killRunTree(child);
                return;
            }
            stderr.push(chunk);
            // A decoder, so a multi-byte character split across chunks reaches the tap whole.
            const text = stderrText.write(chunk);
            if (text !== '') runOptions.onStderr?.(text);
        });
        child.on('error', (error) => {
            // ENOENT / EACCES: git itself is missing, not a failed git command.
            finish(() => reject(error));
        });
        child.on('exit', () => {
            if (signal.aborted) settleWhenGroupGone();
        });
        child.on('close', (code) => {
            if (signal.aborted) return; // settled by `settleWhenGroupGone`
            finish(() => {
                const stderrString = Buffer.concat(stderr).toString('utf8').trim();
                if (failure !== null) reject(failure);
                else if (code === 0 && !timedOut) resolve(Buffer.concat(stdout).toString('utf8'));
                else reject(new GitCommandError({ command, exitCode: code ?? 1, stderr: stderrString, cwd: runOptions.cwd }));
            });
        });
    });
}

export function createGitRunner(options: CreateGitRunnerOptions = {}): GitRunner {
    const executable = options.executable ?? resolveGitExecutable(options.env ?? process.env);
    return (args, runOptions) => {
        const command = `git ${args.join(' ')}`;
        const signal = runOptions.signal;
        if (signal !== undefined) {
            return runCancellable(executable, args, { ...runOptions, signal }, command, options.abortGraceMs ?? ABORT_KILL_GRACE_MS);
        }
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
