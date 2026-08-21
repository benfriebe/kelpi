/**
 * The git primitive layer the daemon's handlers and the graft engine drive (graft-git.md §3.2).
 *
 * Branch reads, default-branch resolution, the worktree family (including `--update-main`),
 * repo-root resolution — and, since M7, everything graft needs: status/dirtiness, in-flight
 * operation detection, the stash pair, the tree-level sync primitives and the restore verbs.
 *
 * Every call is async, runs with `cwd` = the repo/worktree path (**never `-C`**), and never
 * carries a timeout shorter than `MIN_LONG_GIT_TIMEOUT_MS` on the worktree/fetch family.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    createGitRunner,
    longGitTimeout,
    type CreateGitRunnerOptions,
    type GitRunner
} from './exec.js';
import {
    NOTHING_TO_STASH,
    parseShortstat,
    parseStashList,
    parseWorktreeList,
    porcelainLines,
    type RepoGitStatus,
    type RepoState,
    type WorktreeInfo
} from './status.js';

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
    /**
     * `git diff --no-color [-- <targetPath>]` in `repoPath` (content-panes.md §5.1). Throws a
     * `GitCommandError` on a non-zero exit — the diff pane renders the failure as text.
     *
     * `signal` aborts the child when the caller has stopped caring (§CONT-107: a refresh that
     * supersedes an in-flight run, or a pane that closed while git was still reading).
     */
    getDiff(
        repoPath: string,
        targetPath?: string | null,
        options?: { readonly signal?: AbortSignal | undefined }
    ): Promise<string>;
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

    // ── graft + sidebar primitives (M7) ──────────────────────────────────────────────

    /**
     * `git status --porcelain` (+ `git diff --shortstat HEAD` when dirty). Untracked files
     * count towards `changedFiles` but NOT towards additions/deletions, and a failing
     * shortstat (fresh repo, no HEAD) is swallowed → 0/0. Throws only when the porcelain
     * read itself fails (callers that want a badge fall back to `unknown`).
     */
    getStatus(repoPath: string): Promise<RepoGitStatus>;
    /** Marker files in the RESOLVED git dir (per-worktree for a linked worktree). */
    repoState(repoPath: string): Promise<RepoState>;
    /** `git rev-parse HEAD`, trimmed. */
    getHeadSha(repoPath: string): Promise<string>;
    /** `git rev-parse --git-path HEAD`, resolved against `worktreePath` and normalized. */
    resolveHeadPath(worktreePath: string): Promise<string>;
    /**
     * `git stash push --include-untracked -m <message>` → the stash **SHA** (not `stash@{N}`,
     * which shifts as stashes land). `null` when there was nothing to stash.
     */
    stashPushIncludeUntracked(repoPath: string, message: string): Promise<string | null>;
    /**
     * Pop the stash whose SHA is `stashRef`. A ref that is no longer in `git stash list`
     * **succeeds silently** (the user dropped it; the rest of the stop sequence must run).
     */
    stashPopRef(repoPath: string, stashRef: string): Promise<void>;
    /**
     * The worktree-side sync primitive: seed a THROW-AWAY index from HEAD, `add -A` into it,
     * `write-tree` — the worktree's real index and staging state are never touched.
     */
    writeTreeForWorktree(worktreePath: string): Promise<string>;
    /** The parent-side sync primitive: `git read-tree --reset -u <tree>`. */
    readTreeInto(repoPath: string, treeSha: string): Promise<void>;
    /** `git checkout -f <branchOrSha> --`. */
    checkoutBranchForce(repoPath: string, branchOrSha: string): Promise<void>;
    /** `git checkout -f HEAD --` — discard working-tree drift without moving HEAD. */
    checkoutHeadForce(repoPath: string): Promise<void>;
    resetHard(repoPath: string, sha: string): Promise<void>;
    resetMixed(repoPath: string, sha: string): Promise<void>;
    /** `git worktree list --porcelain`; the first entry is always the main worktree. */
    listWorktrees(repoPath: string): Promise<WorktreeInfo[]>;
    /** `git worktree remove <path>` — NON-forcing (git refuses dirty/locked worktrees). */
    removeWorktree(repoPath: string, worktreePath: string): Promise<void>;
    pruneWorktrees(repoPath: string): Promise<void>;
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

function pathExists(candidate: string): boolean {
    try {
        fs.statSync(candidate);
        return true;
    } catch {
        return false;
    }
}

/** Marker files checked, in order, inside the resolved git dir (§3.2 `repoState`). */
const REPO_STATE_MARKERS: readonly (readonly [string, RepoState])[] = [
    ['MERGE_HEAD', 'merge'],
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['CHERRY_PICK_HEAD', 'cherryPick'],
    ['REVERT_HEAD', 'revert'],
    ['BISECT_LOG', 'bisect']
];

/** Prefix of the throw-away index files `writeTreeForWorktree` creates (port note 18). */
export const GRAFT_TEMP_INDEX_PREFIX = 'nex-graft-index-';

/** A day: only temp indexes older than this are swept, so a live sync is never robbed. */
const TEMP_INDEX_SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Best-effort startup sweep of abandoned `nex-graft-index-*` files (a crashed sync leaks one).
 * Only files older than a day are removed — another daemon may be mid-`write-tree` right now.
 * Returns the number of files deleted; never throws.
 */
export function sweepGraftTempIndexes(
    directory: string = os.tmpdir(),
    now: number = Date.now(),
    maxAgeMs: number = TEMP_INDEX_SWEEP_AGE_MS
): number {
    let removed = 0;
    let entries: string[];
    try {
        entries = fs.readdirSync(directory);
    } catch {
        return 0;
    }
    for (const entry of entries) {
        if (!entry.startsWith(GRAFT_TEMP_INDEX_PREFIX)) continue;
        const full = path.join(directory, entry);
        try {
            if (now - fs.statSync(full).mtimeMs < maxAgeMs) continue;
            fs.rmSync(full, { force: true });
            removed += 1;
        } catch {
            // Someone else's file, or already gone. Nothing to do.
        }
    }
    return removed;
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

        async getDiff(repoPath, targetPath, diffOptions) {
            const scope = targetPath ?? '';
            const args =
                scope === '' ? ['diff', '--no-color'] : ['diff', '--no-color', '--', scope];
            // §CONT-107: a superseded diff is KILLED, not merely ignored. `git diff` over a big
            // tree is the one read here that can outlive the request that asked for it, so the
            // caller's signal rides all the way down to the child process.
            const signal = diffOptions?.signal;
            if (signal === undefined) return readGit(args, repoPath);
            return run(args, {
                cwd: repoPath,
                ...(short !== undefined ? { timeoutMs: short } : {}),
                signal
            });
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
        },

        // ── graft + sidebar primitives ───────────────────────────────────────────────

        async getStatus(repoPath) {
            const porcelain = await readGit(['status', '--porcelain'], repoPath);
            const lines = porcelainLines(porcelain);
            if (lines.length === 0) return { kind: 'clean' };
            let additions = 0;
            let deletions = 0;
            try {
                // Against HEAD so STAGED edits count too; a repo without a HEAD throws here
                // and the counts stay 0 (the file count is still right).
                const shortstat = await readGit(['diff', '--shortstat', 'HEAD'], repoPath);
                const counts = parseShortstat(shortstat);
                additions = counts.additions;
                deletions = counts.deletions;
            } catch {
                // Swallowed by contract (port note 16).
            }
            return { kind: 'dirty', changedFiles: lines.length, additions, deletions };
        },

        async repoState(repoPath) {
            const raw = (await readGit(['rev-parse', '--git-dir'], repoPath)).trim();
            if (raw === '') return 'clean';
            const gitDir = path.isAbsolute(raw) ? raw : path.join(repoPath, raw);
            for (const [marker, state] of REPO_STATE_MARKERS) {
                if (pathExists(path.join(gitDir, marker))) return state;
            }
            return 'clean';
        },

        async getHeadSha(repoPath) {
            return (await readGit(['rev-parse', 'HEAD'], repoPath)).trim();
        },

        async resolveHeadPath(worktreePath) {
            const raw = (await readGit(['rev-parse', '--git-path', 'HEAD'], worktreePath)).trim();
            if (raw === '') return path.join(worktreePath, '.git', 'HEAD');
            return path.normalize(path.isAbsolute(raw) ? raw : path.join(worktreePath, raw));
        },

        async stashPushIncludeUntracked(repoPath, message) {
            const out = await readGit(
                ['stash', 'push', '--include-untracked', '-m', message],
                repoPath
            );
            // Exit code is 0 either way; stdout is the only discriminator.
            if (out.includes(NOTHING_TO_STASH)) return null;
            const sha = (await readGit(['rev-parse', 'refs/stash'], repoPath)).trim();
            return sha === '' ? null : sha;
        },

        async stashPopRef(repoPath, stashRef) {
            const list = parseStashList(await readGit(['stash', 'list', '--format=%H'], repoPath));
            const index = list.indexOf(stashRef);
            // Dropped by the user between start and stop: nothing to pop, and refusing here
            // would strand the rest of the stop sequence.
            if (index < 0) return;
            await readGit(['stash', 'pop', `stash@{${String(index)}}`], repoPath);
        },

        async writeTreeForWorktree(worktreePath) {
            const tempIndex = path.join(
                os.tmpdir(),
                `${GRAFT_TEMP_INDEX_PREFIX}${crypto.randomUUID()}`
            );
            const env = { GIT_INDEX_FILE: tempIndex };
            const withIndex = async (args: readonly string[]): Promise<string> =>
                run(args, {
                    cwd: worktreePath,
                    env,
                    ...(short !== undefined ? { timeoutMs: short } : {})
                });
            try {
                await withIndex(['read-tree', 'HEAD']);
                // `add -A` against the TEMP index: untracked (non-ignored) files join the
                // snapshot and the user's real staging state is untouched.
                await withIndex(['add', '-A']);
                return (await withIndex(['write-tree'])).trim();
            } finally {
                for (const leftover of [tempIndex, `${tempIndex}.lock`]) {
                    try {
                        fs.rmSync(leftover, { force: true });
                    } catch {
                        // Best-effort: the startup sweep collects anything left behind.
                    }
                }
            }
        },

        async readTreeInto(repoPath, treeSha) {
            await readGit(['read-tree', '--reset', '-u', treeSha], repoPath);
        },

        async checkoutBranchForce(repoPath, branchOrSha) {
            await readGit(['checkout', '-f', branchOrSha, '--'], repoPath);
        },

        async checkoutHeadForce(repoPath) {
            await readGit(['checkout', '-f', 'HEAD', '--'], repoPath);
        },

        async resetHard(repoPath, sha) {
            await readGit(['reset', '--hard', sha], repoPath);
        },

        async resetMixed(repoPath, sha) {
            await readGit(['reset', '--mixed', sha], repoPath);
        },

        async listWorktrees(repoPath) {
            return parseWorktreeList(await readGit(['worktree', 'list', '--porcelain'], repoPath));
        },

        async removeWorktree(repoPath, worktreePath) {
            await longGit(['worktree', 'remove', worktreePath], repoPath);
        },

        async pruneWorktrees(repoPath) {
            await longGit(['worktree', 'prune'], repoPath);
        }
    };

    return service;
}
