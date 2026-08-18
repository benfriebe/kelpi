/**
 * The minimal git primitive layer the daemon's handlers need (graft-git.md §3.2).
 *
 * Only the operations WP2.5b actually drives are implemented: branch reads, default-branch
 * resolution, the worktree-add family (including the `--update-main` flow) and repo-root
 * resolution. The rest of §3.2 (status, stash, tree sync) lands with graft in M7 — this
 * interface is meant to be widened, not rewritten.
 *
 * Every call is async, runs with `cwd` = the repo/worktree path, and never carries a timeout
 * shorter than `MIN_LONG_GIT_TIMEOUT_MS` on the worktree/fetch family.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
    createGitRunner,
    longGitTimeout,
    type CreateGitRunnerOptions,
    type GitRunner
} from './exec.js';

/** `git rev-parse --abbrev-ref HEAD` prints this literal when HEAD is detached. */
export const DETACHED_HEAD = 'HEAD';

/** Last-resort default branch when neither symref lookup answers (§3.2). */
export const FALLBACK_DEFAULT_BRANCH = 'main';

export interface RepoRootInfo {
    /** `git rev-parse --show-toplevel` — the worktree the path lives in. */
    readonly worktreeRoot: string;
    /** The MAIN checkout for that worktree; equal to `worktreeRoot` for the main one. */
    readonly parentRepoRoot: string;
}

export interface WorktreeAddRequest {
    readonly repoPath: string;
    readonly worktreePath: string;
    readonly branchName: string;
    /** Fetch `origin` and branch off `origin/<default>` instead of current HEAD. */
    readonly updateMain: boolean;
    readonly remote?: string | undefined;
}

export interface GitService {
    /** `git rev-parse --abbrev-ref HEAD`; trimmed, empty → null, `"HEAD"` = detached. */
    getCurrentBranch(repoPath: string): Promise<string | null>;
    /** `git remote get-url origin`; trimmed, empty → null. Never throws. */
    getRemoteURL(repoPath: string): Promise<string | null>;
    /** ls-remote symref → local `origin/HEAD` symref → `"main"`. Never throws. */
    defaultBranch(repoPath: string): Promise<string>;
    fetch(repoPath: string, remote?: string): Promise<void>;
    /** Attach to an EXISTING branch, falling back to `-b <branch>` off current HEAD. */
    createWorktree(repoPath: string, worktreePath: string, branchName: string): Promise<void>;
    /** `git worktree add -b <branch> <path> <baseRef>`. */
    createWorktreeFromBase(
        repoPath: string,
        worktreePath: string,
        branchName: string,
        baseRef: string
    ): Promise<void>;
    /** `performWorktreeAdd` (graft-git §8.3): the shared GUI + socket entry point. */
    worktreeAdd(request: WorktreeAddRequest): Promise<void>;
    /** `git rev-parse --show-toplevel`; null when the path is not inside a checkout. */
    toplevel(directory: string): Promise<string | null>;
    /** `--show-toplevel --git-common-dir` in one spawn; null when not a checkout. */
    resolveRepoRoot(directory: string): Promise<RepoRootInfo | null>;
}

export interface CreateGitServiceOptions extends CreateGitRunnerOptions {
    /** Injected for tests; defaults to a real `execFile`-backed runner. */
    readonly run?: GitRunner | undefined;
    /** Budget for ordinary reads (branch, symref). Omitted = block. */
    readonly timeoutMs?: number | undefined;
    /** Budget for worktree/fetch ops; clamped up to `MIN_LONG_GIT_TIMEOUT_MS`. */
    readonly longTimeoutMs?: number | undefined;
}

function firstNonEmptyLine(text: string): string | null {
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed !== '') return trimmed;
    }
    return null;
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

function isDirectory(candidate: string): boolean {
    try {
        return fs.statSync(candidate).isDirectory();
    } catch {
        return false;
    }
}

export function createGitService(options: CreateGitServiceOptions = {}): GitService {
    const run =
        options.run ??
        createGitRunner({
            ...(options.executable !== undefined ? { executable: options.executable } : {}),
            ...(options.env !== undefined ? { env: options.env } : {})
        });
    const short = options.timeoutMs;
    const long = longGitTimeout(options.longTimeoutMs);

    const readGit = async (args: readonly string[], cwd: string): Promise<string> =>
        run(args, { cwd, ...(short !== undefined ? { timeoutMs: short } : {}) });

    const longGit = async (args: readonly string[], cwd: string): Promise<string> =>
        run(args, { cwd, ...(long !== undefined ? { timeoutMs: long } : {}) });

    const service: GitService = {
        async getCurrentBranch(repoPath) {
            try {
                const out = (await readGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath)).trim();
                return out === '' ? null : out;
            } catch {
                return null;
            }
        },

        async getRemoteURL(repoPath) {
            try {
                const out = (await readGit(['remote', 'get-url', 'origin'], repoPath)).trim();
                return out === '' ? null : out;
            } catch {
                return null;
            }
        },

        async defaultBranch(repoPath) {
            try {
                const out = await readGit(['ls-remote', '--symref', 'origin', 'HEAD'], repoPath);
                for (const line of out.split('\n')) {
                    const branch = parseSymrefLine(line);
                    if (branch !== null) return branch;
                }
            } catch {
                // fall through to the local symref
            }
            try {
                const out = (
                    await readGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoPath)
                ).trim();
                if (out !== '') return stripRemotePrefix(out);
            } catch {
                // fall through to the literal default
            }
            return FALLBACK_DEFAULT_BRANCH;
        },

        async fetch(repoPath, remote = 'origin') {
            await longGit(['fetch', remote], repoPath);
        },

        async createWorktree(repoPath, worktreePath, branchName) {
            try {
                await longGit(['worktree', 'add', worktreePath, branchName], repoPath);
            } catch {
                // The branch does not exist yet: create it off current HEAD. The FALLBACK's
                // error is what propagates (its stderr is the actionable one).
                await longGit(['worktree', 'add', '-b', branchName, worktreePath], repoPath);
            }
        },

        async createWorktreeFromBase(repoPath, worktreePath, branchName, baseRef) {
            await longGit(['worktree', 'add', '-b', branchName, worktreePath, baseRef], repoPath);
        },

        async worktreeAdd(request) {
            const remote = request.remote ?? 'origin';
            if (!request.updateMain) {
                await service.createWorktree(
                    request.repoPath,
                    request.worktreePath,
                    request.branchName
                );
                return;
            }
            const base = await service.defaultBranch(request.repoPath);
            await service.fetch(request.repoPath, remote);
            await service.createWorktreeFromBase(
                request.repoPath,
                request.worktreePath,
                request.branchName,
                `${remote}/${base}`
            );
        },

        async toplevel(directory) {
            if (!isDirectory(directory)) return null;
            try {
                const out = (await readGit(['rev-parse', '--show-toplevel'], directory)).trim();
                const line = firstNonEmptyLine(out);
                return line === null ? null : path.normalize(line);
            } catch {
                return null;
            }
        },

        async resolveRepoRoot(directory) {
            if (!isDirectory(directory)) return null;
            let out: string;
            try {
                out = await readGit(['rev-parse', '--show-toplevel', '--git-common-dir'], directory);
            } catch {
                return null;
            }
            const lines = out
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line !== '');
            const worktreeRootRaw = lines[0];
            const commonDirRaw = lines[1];
            if (worktreeRootRaw === undefined || commonDirRaw === undefined) return null;

            const worktreeRoot = path.normalize(worktreeRootRaw);
            const commonDir = path.isAbsolute(commonDirRaw)
                ? path.normalize(commonDirRaw)
                : path.normalize(path.join(worktreeRoot, commonDirRaw));
            const parentRepoRoot =
                path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
            return { worktreeRoot, parentRepoRoot };
        }
    };

    return service;
}
