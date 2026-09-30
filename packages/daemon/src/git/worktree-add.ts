/**
 * `performWorktreeAdd` (graft-git.md §8.3, §8.5): the git half of every worktree create, with
 * the step reporting, cancellation and prefetch reuse issue #294 added.
 *
 * The update-main path runs, in order:
 *
 *   1. `resolve-default-branch`: the LOCAL `refs/remotes/<remote>/HEAD` first, which needs no
 *      network; `git ls-remote --symref` only when that is not set (or points somewhere that is
 *      not a branch of that remote); `main` last (§3.2);
 *   2. the §8.5 refusal of a branch name that already exists, before any network;
 *   3. `fetch`: ONE branch, no tags, into its remote-tracking ref (`defaultBranchFetchArgs`),
 *      or no fetch at all when a prefetch for the same branch is running (joined) or finished
 *      moments ago (reused);
 *   4. `worktree-add`: `git worktree add -b <branch> <path> <remote>/<default>`.
 *
 * Without update main it is the one `worktree-add` step: attach to an existing branch, falling
 * back to `-b <branch>` off the current HEAD.
 *
 * Cancellation (§8.5.2) kills the running git child (and its children: the runner kills the
 * whole process group) and then removes what THIS request created, and nothing else:
 *
 *   - the worktree directory, only when it did not exist before the add started;
 *   - its worktree registration, by the same test (`git worktree remove --force <path>`, which
 *     also unregisters a path whose directory is already gone);
 *   - the branch, only when it did not exist before the add started AND its tip is one of the
 *     commits this add could have created it at. A branch someone else made, or moved, stays.
 *
 * A cancel that arrives once `worktree-add` has returned is too late to roll back here; the
 * caller completes the create (workspaces.ts documents why).
 */

import fs from 'node:fs';
import path from 'node:path';

import { GitCommandError, isGitCommandError, type GitRunner } from './exec.js';
import { worktreeErrorMessage } from './names.js';
import { createGitProgressParser, stripGitProgress, type GitProgress } from './progress.js';
import type { WorktreeStepID, WorktreeStepSink } from './worktree-steps.js';

/** Last-resort default branch when neither symref lookup answers (§3.2). */
export const FALLBACK_DEFAULT_BRANCH = 'main';

/**
 * graft-git.md §8.5: an update-main worktree asked for a branch that already exists.
 *
 * Its message reaches the user verbatim (the sheet's inline error, the CLI's stderr), so it
 * says what happened and the two ways out, in words that fit both surfaces: pick a name that
 * is free, or turn update main off, which checks the existing branch out instead.
 */
export class WorktreeBranchExistsError extends Error {
    readonly branchName: string;
    constructor(branchName: string, baseRef: string) {
        super(
            `branch '${branchName}' already exists, and update main always creates a new branch off ${baseRef}: ` +
                'choose another worktree or branch name, or turn off update main to check out the existing branch'
        );
        this.name = 'WorktreeBranchExistsError';
        this.branchName = branchName;
    }
}

/** §8.5.2: the requester cancelled. `step` is the one that was running. */
export class WorktreeCreateCancelledError extends Error {
    readonly step: WorktreeStepID;
    constructor(step: WorktreeStepID) {
        super('worktree create cancelled');
        this.name = 'WorktreeCreateCancelledError';
        this.step = step;
    }
}

export interface WorktreeAddRequest {
    readonly repoPath: string;
    readonly worktreePath: string;
    readonly branchName: string;
    /** Fetch `origin` and branch off `origin/<default>` instead of current HEAD. */
    readonly updateMain: boolean;
    readonly remote?: string | undefined;
}

/** `ref: refs/heads/main\tHEAD` → `main`; anything else → null. */
export function parseSymrefLine(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith('ref:')) return null;
    const token = trimmed.slice('ref:'.length).trim().split(/\s+/)[0];
    if (token === undefined) return null;
    const prefix = 'refs/heads/';
    if (!token.startsWith(prefix)) return null;
    const name = token.slice(prefix.length);
    return name === '' ? null : name;
}

/** `origin/main` → `main`; a name without `/` is returned whole. */
export function stripRemotePrefix(ref: string): string {
    const slash = ref.indexOf('/');
    return slash < 0 ? ref : ref.slice(slash + 1);
}

// ---------------------------------------------------------------------------
// The git calls
// ---------------------------------------------------------------------------

export interface WorktreeGitCallOptions {
    readonly signal?: AbortSignal | undefined;
    readonly onStderr?: ((chunk: string) => void) | undefined;
    readonly env?: Readonly<Record<string, string>> | undefined;
}

/** The two budgets `createGitService` runs git with, as one seam the flow and tests share. */
export interface WorktreeGitOps {
    /** Ordinary reads: `symbolic-ref`, `rev-parse`, `ls-remote`. */
    read(args: readonly string[], cwd: string, options?: WorktreeGitCallOptions): Promise<string>;
    /** The worktree/fetch family (§7.6's long budget). */
    long(args: readonly string[], cwd: string, options?: WorktreeGitCallOptions): Promise<string>;
}

export function worktreeGitOps(
    run: GitRunner,
    budgets: { readonly short?: number | undefined; readonly long?: number | undefined } = {}
): WorktreeGitOps {
    const call =
        (timeoutMs: number | undefined) =>
        (args: readonly string[], cwd: string, options: WorktreeGitCallOptions = {}): Promise<string> =>
            run(args, {
                cwd,
                ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                ...(options.signal !== undefined ? { signal: options.signal } : {}),
                ...(options.onStderr !== undefined ? { onStderr: options.onStderr } : {}),
                ...(options.env !== undefined ? { env: options.env } : {})
            });
    return { read: call(budgets.short), long: call(budgets.long) };
}

export type DefaultBranchSource = 'origin-head' | 'ls-remote' | 'fallback';

export interface ResolvedDefaultBranch {
    readonly branch: string;
    readonly source: DefaultBranchSource;
}

/** What the log and the step's detail say about where the name came from. */
export function describeDefaultBranchSource(resolved: ResolvedDefaultBranch, remote = 'origin'): string {
    switch (resolved.source) {
        case 'origin-head':
            return `${resolved.branch} (from ${remote}/HEAD)`;
        case 'ls-remote':
            return `${resolved.branch} (asked ${remote})`;
        case 'fallback':
            return `${resolved.branch} (${remote} did not say, so the default)`;
    }
}

async function verifiedRef(ops: WorktreeGitOps, repoPath: string, ref: string, signal?: AbortSignal): Promise<string | null> {
    try {
        const out = (await ops.read(['rev-parse', '--verify', '--quiet', ref], repoPath, signal !== undefined ? { signal } : {})).trim();
        return out === '' ? null : out;
    } catch (error) {
        if (signal?.aborted) throw error;
        return null;
    }
}

/**
 * §3.2, reordered by #294: local `<remote>/HEAD` → `ls-remote --symref` → `main`.
 *
 * The local symref is only believed when it names a branch OF THAT REMOTE that exists here
 * (`refs/remotes/<remote>/<branch>` resolves). Anything else (a symref into another namespace,
 * one left dangling by a deleted branch) falls through to asking the remote, which is what every
 * repo got before, so a repo with an odd `origin/HEAD` behaves exactly as it did.
 *
 * Never throws, except that an abort propagates so a cancelled create stops here.
 */
export async function resolveDefaultBranch(
    ops: WorktreeGitOps,
    repoPath: string,
    remote = 'origin',
    signal?: AbortSignal,
    env?: Readonly<Record<string, string>>
): Promise<ResolvedDefaultBranch> {
    const opts = { ...(signal !== undefined ? { signal } : {}), ...(env !== undefined ? { env } : {}) };
    try {
        const out = (await ops.read(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`], repoPath, opts)).trim();
        const prefix = `${remote}/`;
        if (out.startsWith(prefix) && out.length > prefix.length) {
            const branch = out.slice(prefix.length);
            if ((await verifiedRef(ops, repoPath, `refs/remotes/${remote}/${branch}`, signal)) !== null) {
                return { branch, source: 'origin-head' };
            }
        }
    } catch (error) {
        if (signal?.aborted) throw error;
        // Not set (exit 1 under --quiet): ask the remote.
    }
    return (await resolveDefaultBranchFromRemote(ops, repoPath, remote, signal, env)) ?? { branch: FALLBACK_DEFAULT_BRANCH, source: 'fallback' };
}

/**
 * `git ls-remote --symref <remote> HEAD` alone: what the remote says its default branch is NOW.
 * Null when it cannot say (offline, no such remote). An abort propagates.
 */
export async function resolveDefaultBranchFromRemote(
    ops: WorktreeGitOps,
    repoPath: string,
    remote = 'origin',
    signal?: AbortSignal,
    env?: Readonly<Record<string, string>>
): Promise<ResolvedDefaultBranch | null> {
    const opts = { ...(signal !== undefined ? { signal } : {}), ...(env !== undefined ? { env } : {}) };
    try {
        const out = await ops.read(['ls-remote', '--symref', remote, 'HEAD'], repoPath, opts);
        for (const line of out.split('\n')) {
            const branch = parseSymrefLine(line);
            if (branch !== null) return { branch, source: 'ls-remote' };
        }
    } catch (error) {
        if (signal?.aborted) throw error;
    }
    return null;
}

/** `fatal: couldn't find remote ref refs/heads/<b>`: the branch is gone from the remote. */
export function isMissingRemoteRef(error: unknown): boolean {
    return isGitCommandError(error) && /couldn't find remote ref/i.test(error.stderr);
}

export interface RenameFallbackOptions {
    readonly signal?: AbortSignal | undefined;
    readonly env?: Readonly<Record<string, string>> | undefined;
    readonly log?: ((message: string) => void) | undefined;
    /** The default branch turned out to have moved: `from` was stale, `to` is what is fetched. */
    readonly onRenamed?: ((from: string, to: ResolvedDefaultBranch) => void) | undefined;
}

/**
 * Fetch the resolved default branch, recovering from a STALE local `origin/HEAD` (#294 review).
 *
 * When the remote renames its default branch (`main` → `trunk`), a clone keeps
 * `origin/HEAD -> origin/main` and, since fetch does not prune, `refs/remotes/origin/main` too, so
 * the local lookup still believes `main` and the one-branch fetch fails with `couldn't find
 * remote ref refs/heads/main`. Only for a name that came from the local symref, and only for
 * that error: ask the remote (`ls-remote`), fetch what it names instead, once, and point the
 * local `origin/HEAD` at it (`git remote set-head`) so the next create is fast again. Anything
 * else (the remote says the same name, or cannot be asked) rethrows the original error.
 */
export async function fetchWithRenameFallback(
    ops: WorktreeGitOps,
    repoPath: string,
    remote: string,
    resolved: ResolvedDefaultBranch,
    fetch: (branch: string) => Promise<void>,
    options: RenameFallbackOptions = {}
): Promise<ResolvedDefaultBranch> {
    try {
        await fetch(resolved.branch);
        return resolved;
    } catch (error) {
        if (options.signal?.aborted || resolved.source !== 'origin-head' || !isMissingRemoteRef(error)) throw error;
        const fresh = await resolveDefaultBranchFromRemote(ops, repoPath, remote, options.signal, options.env);
        if (fresh === null || fresh.branch === resolved.branch) throw error;
        options.log?.(`worktree-create: ${remote}/HEAD in ${repoPath} named ${resolved.branch}, which ${remote} no longer has; ${remote} says ${fresh.branch}`);
        options.onRenamed?.(resolved.branch, fresh);
        await fetch(fresh.branch);
        try {
            await ops.read(['remote', 'set-head', remote, fresh.branch], repoPath, options.env !== undefined ? { env: options.env } : {});
            options.log?.(`worktree-create: pointed ${remote}/HEAD in ${repoPath} at ${remote}/${fresh.branch}`);
        } catch (setHeadError) {
            options.log?.(`worktree-create: could not update ${remote}/HEAD in ${repoPath}: ${setHeadError instanceof Error ? setHeadError.message : String(setHeadError)}`);
        }
        return fresh;
    }
}

/**
 * `git fetch --no-tags [--progress] <remote> +refs/heads/<b>:refs/remotes/<remote>/<b>`.
 *
 * The explicit refspec is what makes "fetch one branch" safe: a bare `git fetch origin main`
 * only updates `origin/main` opportunistically, through the remote's configured fetch refspec,
 * and a single-branch clone or a hand-edited refspec would leave the ref the worktree is cut
 * from stale. `+` because the default refspec forces too (a rewritten remote branch still lands).
 */
export function defaultBranchFetchArgs(remote: string, branch: string, progress = false): string[] {
    return [
        'fetch',
        '--no-tags',
        ...(progress ? ['--progress'] : []),
        remote,
        `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`
    ];
}

/** Run git with its meter on, reporting each reading; the error comes back without the meter. */
async function withProgress(
    call: (options: WorktreeGitCallOptions) => Promise<string>,
    onProgress: ((progress: GitProgress) => void) | undefined
): Promise<string> {
    if (onProgress === undefined) return call({});
    const parser = createGitProgressParser(onProgress);
    try {
        const out = await call({ onStderr: (chunk) => parser.push(chunk) });
        parser.end();
        return out;
    } catch (error) {
        if (isGitCommandError(error)) {
            throw new GitCommandError({
                command: error.command,
                exitCode: error.exitCode,
                stderr: stripGitProgress(error.stderr),
                cwd: error.cwd
            });
        }
        throw error;
    }
}

export interface FetchDefaultBranchOptions {
    readonly signal?: AbortSignal | undefined;
    readonly onProgress?: ((progress: GitProgress) => void) | undefined;
    /** Extra environment (a background prefetch turns terminal prompts off). */
    readonly env?: Readonly<Record<string, string>> | undefined;
}

export async function fetchDefaultBranch(
    ops: WorktreeGitOps,
    repoPath: string,
    remote: string,
    branch: string,
    options: FetchDefaultBranchOptions = {}
): Promise<void> {
    await withProgress(
        (extra) =>
            ops.long(defaultBranchFetchArgs(remote, branch, options.onProgress !== undefined), repoPath, {
                ...extra,
                ...(options.signal !== undefined ? { signal: options.signal } : {}),
                ...(options.env !== undefined ? { env: options.env } : {})
            }),
        options.onProgress
    );
}

// ---------------------------------------------------------------------------
// Prefetch reuse (the cache lives in fetch-cache.ts; this is the seam the flow sees)
// ---------------------------------------------------------------------------

export type FetchForCreateOutcome =
    | { readonly kind: 'fetched' }
    /** A fetch of the same branch was already running; the create waited for it. */
    | { readonly kind: 'joined'; readonly origin: 'prefetch' | 'create' }
    /** One finished `ageMs` ago, recently enough to stand in for this create's. */
    | { readonly kind: 'reused'; readonly ageMs: number; readonly origin: 'prefetch' | 'create' };

export interface FetchForCreateInput {
    readonly repoPath: string;
    readonly remote: string;
    readonly branch: string;
    readonly signal?: AbortSignal | undefined;
    readonly onProgress?: ((progress: GitProgress) => void) | undefined;
    /** Called when the create starts waiting on a fetch it did not start. */
    readonly onJoin?: ((origin: 'prefetch' | 'create') => void) | undefined;
}

export interface DefaultBranchFetches {
    fetchForCreate(input: FetchForCreateInput): Promise<FetchForCreateOutcome>;
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

export interface WorktreeAddHooks {
    /** Aborted by `workspace-create-cancel`; absent = the create cannot be cancelled. */
    readonly signal?: AbortSignal | undefined;
    /** Step reporting; absent (the CLI, the inspector) = git runs without its meter. */
    readonly steps?: WorktreeStepSink | null | undefined;
    /** Prefetch reuse; absent = the create always fetches for itself. */
    readonly fetches?: DefaultBranchFetches | null | undefined;
    readonly log?: ((message: string) => void) | undefined;
}

/** What the tree looked like before `worktree add` ran: the cleanup's whole authority. */
export interface WorktreeAddSnapshot {
    readonly pathExisted: boolean;
    readonly branchExisted: boolean;
    /**
     * Every commit the add could have created the branch at: the base ref with update main;
     * HEAD or git's DWIM `origin/<branch>` without it.
     */
    readonly possibleTips: ReadonlySet<string>;
}

function pathExists(candidate: string): boolean {
    return pathState(candidate) !== 'absent';
}

/**
 * `absent` only for ENOENT / ENOTDIR. Anything else (EACCES, EIO, a transient error) is
 * `unknown`, which every cleanup decision reads as "it was there": the snapshot FAILS CLOSED, so
 * a flaky read can make a cancel leave something behind, never delete something the user had.
 */
function pathState(candidate: string): 'exists' | 'absent' | 'unknown' {
    try {
        fs.lstatSync(candidate);
        return 'exists';
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unknown';
    }
}

/**
 * The snapshot's ref read, failing closed: the sha, `null` only for rev-parse's own "no such
 * ref" (exit 1 under `--verify --quiet`), and `undefined` for any other failure (a spawn error,
 * a broken repo), which the cleanup reads as "it existed".
 */
async function probeRef(ops: WorktreeGitOps, repoPath: string, ref: string): Promise<string | null | undefined> {
    try {
        const out = (await ops.read(['rev-parse', '--verify', '--quiet', ref], repoPath)).trim();
        return out === '' ? null : out;
    } catch (error) {
        return isGitCommandError(error) && error.exitCode === 1 ? null : undefined;
    }
}

/**
 * @param refs every ref whose commit the add could create the branch at: the base ref on the
 *   update-main path; HEAD and git's DWIM `origin/<branch>` on the plain path.
 */
async function snapshotBeforeAdd(
    ops: WorktreeGitOps,
    request: WorktreeAddRequest,
    refs: readonly string[]
): Promise<WorktreeAddSnapshot> {
    // Deliberately NOT given the abort signal: these reads are what the cleanup trusts, so a
    // cancel landing mid-snapshot must not leave half of it. They are quick.
    const tips = new Set<string>();
    for (const ref of refs) {
        const sha = await probeRef(ops, request.repoPath, ref);
        // An unreadable candidate is simply not a candidate: fewer tips is the safe direction.
        if (typeof sha === 'string') tips.add(sha);
    }
    return {
        pathExisted: pathState(request.worktreePath) !== 'absent',
        branchExisted: (await probeRef(ops, request.repoPath, `refs/heads/${request.branchName}`)) !== null,
        possibleTips: tips
    };
}

/** A path compared the way git stores it: through symlinks (`/var` → `/private/var`). */
function canonical(candidate: string): string {
    const absolute = path.resolve(candidate);
    try {
        return fs.realpathSync(absolute);
    } catch {
        try {
            return path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
        } catch {
            return absolute;
        }
    }
}

/**
 * Remove the registration git keeps for `worktreePath` (`<common-dir>/worktrees/<id>`) when
 * `git worktree remove -f -f` could not: its directory is gone, or git never finished writing it.
 * Only the entry whose `gitdir` names THIS path is touched. `git worktree prune` is deliberately
 * not used: it would also drop the user's other stale entries (a worktree on an unmounted disk).
 */
async function removeOwnRegistration(ops: WorktreeGitOps, repoPath: string, worktreePath: string): Promise<boolean> {
    let common: string;
    try {
        const out = (await ops.read(['rev-parse', '--git-common-dir'], repoPath)).trim();
        common = path.isAbsolute(out) ? out : path.join(repoPath, out);
    } catch {
        return false;
    }
    const admin = path.join(common, 'worktrees');
    let entries: string[];
    try {
        entries = fs.readdirSync(admin);
    } catch {
        return false;
    }
    const target = canonical(worktreePath);
    for (const entry of entries) {
        let gitdir: string;
        try {
            gitdir = fs.readFileSync(path.join(admin, entry, 'gitdir'), 'utf8').trim();
        } catch {
            continue;
        }
        if (canonical(path.dirname(gitdir)) !== target) continue;
        fs.rmSync(path.join(admin, entry), { recursive: true, force: true });
        return true;
    }
    return false;
}

/**
 * §8.5.2: undo what a cancelled add created, and ONLY that. Best-effort (a failure is logged,
 * never thrown: the cancel has already happened) and deliberately not cancellable itself.
 */
export async function cleanupCancelledWorktreeAdd(
    ops: WorktreeGitOps,
    request: WorktreeAddRequest,
    before: WorktreeAddSnapshot,
    log: (message: string) => void = () => {}
): Promise<string[]> {
    const removed: string[] = [];
    const { repoPath, worktreePath, branchName } = request;
    const samePlaceAsRepo = path.resolve(worktreePath) === path.resolve(repoPath);
    if (!before.pathExisted && !samePlaceAsRepo) {
        // `-f -f`: a checkout in progress leaves the entry LOCKED ("initializing"), which a
        // single --force refuses, and a later `branch -D` then fails with "used by worktree".
        // Safe here because this branch only runs for a path that did not exist before the add.
        // It also unregisters an entry whose directory git's own signal handler already removed.
        try {
            await ops.long(['worktree', 'remove', '-f', '-f', worktreePath], repoPath);
            removed.push('worktree');
        } catch {
            // Not registered (git died first), or its directory is half-written: handled below.
        }
        if (pathExists(worktreePath)) {
            try {
                fs.rmSync(worktreePath, { recursive: true, force: true });
                if (!removed.includes('worktree')) removed.push('worktree directory');
            } catch (error) {
                log(`worktree-create: could not remove ${worktreePath} after a cancel: ${String(error)}`);
            }
        }
        if (!removed.includes('worktree') && (await removeOwnRegistration(ops, repoPath, worktreePath))) {
            removed.push('worktree registration');
        }
    } else if (before.pathExisted) {
        log(`worktree-create: left ${worktreePath} alone after a cancel: it existed before this create (or could not be checked)`);
    }
    if (!before.branchExisted) {
        const tip = await probeRef(ops, repoPath, `refs/heads/${branchName}`);
        if (typeof tip === 'string' && before.possibleTips.has(tip)) {
            try {
                await ops.long(['branch', '-D', branchName], repoPath);
                removed.push(`branch ${branchName}`);
            } catch (error) {
                log(`worktree-create: could not delete branch ${branchName} after a cancel: ${error instanceof Error ? error.message : String(error)}`);
            }
        } else if (typeof tip === 'string') {
            log(`worktree-create: left branch ${branchName} alone after a cancel: its tip ${tip.slice(0, 12)} is not where this create would have made it`);
        } else if (tip === undefined) {
            log(`worktree-create: left branch ${branchName} alone after a cancel: it could not be read`);
        }
    }
    return removed;
}

/** Issue #294 review: a second create for a worktree path or branch that one is already making. */
export class WorktreeBusyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WorktreeBusyError';
    }
}

/**
 * One create at a time per (repo, worktree path) and per (repo, branch). Two creates racing
 * for the same path or branch would each believe the other's directory or branch was theirs,
 * and a cancelled loser could clean up the winner's worktree. So the second is refused at once.
 */
export function createWorktreeAddGuard(): { acquire(request: WorktreeAddRequest): () => void } {
    const busy = new Set<string>();
    return {
        acquire(request) {
            const repo = path.resolve(request.repoPath);
            const pathKey = `${repo}\0path\0${path.resolve(request.worktreePath)}`;
            const branchKey = `${repo}\0branch\0${request.branchName}`;
            if (busy.has(pathKey)) {
                throw new WorktreeBusyError(`another create is already making the worktree at ${request.worktreePath}: wait for it to finish, or choose another worktree name`);
            }
            if (busy.has(branchKey)) {
                throw new WorktreeBusyError(`another create is already making branch '${request.branchName}': wait for it to finish, or choose another branch name`);
            }
            busy.add(pathKey);
            busy.add(branchKey);
            return () => {
                busy.delete(pathKey);
                busy.delete(branchKey);
            };
        }
    };
}

function seconds(ms: number): string {
    return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${String(Math.round(ms / 1000))} s`;
}

export async function performWorktreeAdd(
    ops: WorktreeGitOps,
    request: WorktreeAddRequest,
    hooks: WorktreeAddHooks = {}
): Promise<void> {
    const remote = request.remote ?? 'origin';
    const { signal } = hooks;
    const steps = hooks.steps ?? null;
    const log = hooks.log ?? ((): void => {});
    const reporting = steps !== null;
    const onProgress = (step: WorktreeStepID) => (reporting ? (progress: GitProgress) => steps.progress(step, progress) : undefined);
    const callOptions = (step: WorktreeStepID): WorktreeGitCallOptions => ({
        ...(signal !== undefined ? { signal } : {}),
        // A checkout's "Updating files" meter is a DELAYED one (2 s by default, and never for a
        // short checkout). `git worktree add` has no `--progress`, but its internal
        // `reset --hard` honours GIT_PROGRESS_DELAY, so 0 shows the meter from the first file.
        ...(reporting && step === 'worktree-add' ? { env: { GIT_PROGRESS_DELAY: '0' } } : {})
    });
    let current: WorktreeStepID = request.updateMain ? 'resolve-default-branch' : 'worktree-add';
    let before: WorktreeAddSnapshot | null = null;
    const bail = (): void => {
        if (signal?.aborted) throw new WorktreeCreateCancelledError(current);
    };

    try {
        bail();
        if (!request.updateMain) {
            steps?.running('worktree-add', request.branchName);
            // Only a cancellable add needs the snapshot (it is the cleanup's authority), so an
            // uncancellable one (the CLI, the inspector) runs exactly the git it always ran.
            before = signal !== undefined ? await snapshotBeforeAdd(ops, request, ['HEAD', `refs/remotes/${remote}/${request.branchName}`]) : null;
            bail();
            const add = (args: readonly string[]): Promise<string> =>
                withProgress((extra) => ops.long(args, request.repoPath, { ...callOptions('worktree-add'), ...extra }), onProgress('worktree-add'));
            try {
                await add(['worktree', 'add', request.worktreePath, request.branchName]);
            } catch (error) {
                if (signal?.aborted) throw error;
                // The branch does not exist yet: create it off current HEAD. The FALLBACK's
                // error is what propagates (its stderr is the actionable one).
                await add(['worktree', 'add', '-b', request.branchName, request.worktreePath]);
            }
            bail();
            steps?.done('worktree-add');
            return;
        }

        steps?.running('resolve-default-branch');
        const resolved = await resolveDefaultBranch(ops, request.repoPath, remote, signal);
        bail();
        log(`worktree-create: default branch of ${request.repoPath} is ${describeDefaultBranchSource(resolved, remote)}`);
        steps?.done('resolve-default-branch', describeDefaultBranchSource(resolved, remote));

        // graft-git.md §8.5: update main ALWAYS creates the branch (`-b`), so a name that
        // already exists can only fail, and git's own `fatal: a branch named 'x' already
        // exists` says nothing about why or what to do. Checked after the default-branch
        // lookup but before the fetch, so no fetch is made. Only a LOCAL branch counts: a name
        // that exists solely as `origin/<b>` passes, and gets a new local branch off
        // `origin/<default>` that does not track the remote one. Reported against the
        // worktree step, since that is the step it stops.
        current = 'worktree-add';
        if ((await verifiedRef(ops, request.repoPath, `refs/heads/${request.branchName}`, signal)) !== null) {
            throw new WorktreeBranchExistsError(request.branchName, `${remote}/${resolved.branch}`);
        }
        bail();

        current = 'fetch';
        steps?.running('fetch', `${remote}/${resolved.branch}`);
        const fetchOne = async (branch: string): Promise<void> => {
            const ref = `${remote}/${branch}`;
            const startedAt = Date.now();
            if (hooks.fetches !== undefined && hooks.fetches !== null) {
                const outcome = await hooks.fetches.fetchForCreate({
                    repoPath: request.repoPath,
                    remote,
                    branch,
                    signal,
                    onProgress: onProgress('fetch'),
                    onJoin: (origin) => {
                        // Short: the sheet is 360 px wide and the row also carries the step's name.
                        steps?.running('fetch', origin === 'prefetch' ? 'finishing the prefetch' : "finishing another create's fetch");
                    }
                });
                bail();
                if (outcome.kind === 'reused') {
                    const detail = outcome.origin === 'prefetch' ? `prefetched ${seconds(outcome.ageMs)} ago` : `fetched ${seconds(outcome.ageMs)} ago`;
                    log(`worktree-create: fetch of ${ref} skipped for ${request.repoPath}: ${detail}`);
                    steps?.skipped('fetch', detail);
                } else if (outcome.kind === 'joined') {
                    log(`worktree-create: fetch of ${ref} for ${request.repoPath} joined the ${outcome.origin} already running (${seconds(Date.now() - startedAt)} waited)`);
                    steps?.done('fetch', `${ref} (${outcome.origin === 'prefetch' ? 'prefetch' : 'shared fetch'}, ${seconds(Date.now() - startedAt)})`);
                } else {
                    log(`worktree-create: fetched ${ref} for ${request.repoPath} in ${seconds(Date.now() - startedAt)}`);
                    steps?.done('fetch', `${ref} (${seconds(Date.now() - startedAt)})`);
                }
                return;
            }
            await fetchDefaultBranch(ops, request.repoPath, remote, branch, {
                ...(signal !== undefined ? { signal } : {}),
                onProgress: onProgress('fetch')
            });
            bail();
            steps?.done('fetch', `${ref} (${seconds(Date.now() - startedAt)})`);
        };
        const fetched = await fetchWithRenameFallback(ops, request.repoPath, remote, resolved, fetchOne, {
            signal,
            log,
            onRenamed: (from, to) => {
                steps?.done('resolve-default-branch', `${to.branch} (asked ${remote}; ${remote}/HEAD said ${from})`);
                steps?.running('fetch', `${remote}/${to.branch}`);
            }
        });
        const base = fetched.branch;
        const baseRef = `${remote}/${base}`;

        current = 'worktree-add';
        steps?.running('worktree-add', `${request.branchName} off ${baseRef}`);
        before = signal !== undefined ? await snapshotBeforeAdd(ops, request, [`refs/remotes/${remote}/${base}`]) : null;
        bail();
        await withProgress(
            (extra) =>
                ops.long(['worktree', 'add', '-b', request.branchName, request.worktreePath, baseRef], request.repoPath, {
                    ...callOptions('worktree-add'),
                    ...extra
                }),
            onProgress('worktree-add')
        );
        bail();
        steps?.done('worktree-add');
    } catch (error) {
        if (signal?.aborted) {
            if (before !== null) {
                const removed = await cleanupCancelledWorktreeAdd(ops, request, before, log);
                // git's own signal handler may already have removed its half-made worktree, so
                // the line says what this cleanup removed AND where the directory ended up.
                const directory = pathExists(request.worktreePath)
                    ? before.pathExisted
                        ? 'the directory was left (it existed before)'
                        : 'the directory could not be removed'
                    : 'no directory left';
                log(`worktree-create: cancelled during ${current} for ${request.worktreePath}; removed ${removed.length > 0 ? removed.join(', ') : 'nothing'}; ${directory}`);
            } else {
                log(`worktree-create: cancelled during ${current} for ${request.worktreePath}; nothing had been created`);
            }
            steps?.cancelled(current);
            throw new WorktreeCreateCancelledError(current);
        }
        steps?.failed(current, worktreeErrorMessage(error));
        throw error;
    }
}
