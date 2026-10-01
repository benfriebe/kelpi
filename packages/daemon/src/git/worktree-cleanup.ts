/**
 * Worktree cleanup (graft-git.md §8.7): which of a workspace's linked worktrees may go when the
 * workspace does, and removing the ones the user chose.
 *
 * Two callers share it so a preview and the delete it leads to can never disagree:
 *
 *   - `worktree-cleanup-preview` (`ws/repos.ts`) plans the workspaces a delete dialog is about
 *     to remove and shows every candidate with its reason;
 *   - `workspace-delete` (`handlers/app/workspaces.ts`) plans AGAIN at delete time, after the
 *     panes are gone, and removes only candidates that are still not blocked. A client's
 *     preview is advice; the checks here are the authority.
 *
 * **What counts is git's answer, never the registry's.** A row is offered only when git says
 * its path is the root of a LINKED worktree: `rev-parse` names a parent that is a different
 * checkout, and `git worktree list` does not call it the main one (a submodule or a
 * `--separate-git-dir` checkout has a common dir not named `.git`, so the parent reads as the
 * git dir itself). The registry cannot say this reliably: rows linked before `resolveRepoRoot`
 * asked for absolute paths named an ancestor directory as the parent of a MAIN checkout.
 *
 * **Nothing here forces.** Removal is `git worktree remove` without `--force`, so git itself
 * refuses a worktree with modified or untracked files, and a lock. The checks below add what
 * git does not refuse on its own:
 *
 *   - a worktree another workspace still uses (a row of its own, or a pane inside it);
 *   - a worktree with ANOTHER worktree inside it: git counts an ignored directory as clean, so
 *     `.claude/worktrees/<agent>` under a globally ignored `.claude/` is deleted with its parent,
 *     uncommitted work and all, and left behind as a `prunable` registration;
 *   - a detached HEAD with commits no branch, remote-tracking ref or tag reaches: its reflog
 *     goes with the worktree, so those commits would be unreachable.
 *
 * Removing a worktree on a branch loses no commits (the branch stays). Deleting the branch is a
 * separate choice, offered only when every commit on it is reachable from another branch, a
 * remote-tracking ref or a tag, so it loses nothing either. `git branch -d` cannot make that
 * call: a branch made off `origin/<default>` tracks it, and a squash-merged branch never looks
 * merged into its upstream.
 */

import path from 'node:path';

import { canonicalizePath } from '../graft/paths.js';
import type { DaemonState, RepoAssociation } from '../store/types.js';
import { resolvedWorktreeBasePath, standardizePath, worktreeErrorMessage } from './names.js';
import { DETACHED_HEAD, type GitService } from './service.js';
import type { WorktreeInfo } from './status.js';
import type { WorktreeGitOps } from './worktree-add.js';

/** The `kelpi.git` primitives cleanup reads and removes with (provider-aware). */
export type WorktreeCleanupGit = Pick<
    GitService,
    'resolveRepoRoot' | 'getStatus' | 'getCurrentBranch' | 'listWorktrees' | 'removeWorktree'
>;

/**
 * The branch reads and the two mutations the `kelpi.git` v1 provider contract has no method
 * for. Bundled git only: while a plugin provider owns `kelpi.git` this is null, so no branch is
 * offered for deletion, a detached worktree reads as possibly holding commits, and a worktree
 * with uncommitted changes cannot be forced.
 */
export interface BundledWorktreeOps {
    /**
     * Commits reachable from `branch` (or `HEAD` in `cwd` when null) that no other local branch,
     * remote-tracking ref or tag reaches: what deleting the branch, or dropping a detached
     * worktree's HEAD, would make unreachable.
     */
    commitsOnlyHere(cwd: string, branch: string | null): Promise<number>;
    /** The branch `origin/HEAD` names locally (no network), which is never deleted; else null. */
    defaultBranch(repoPath: string): Promise<string | null>;
    /** `git branch -D <branch>`, run only after `commitsOnlyHere` answered 0. */
    deleteBranch(repoPath: string, branch: string): Promise<void>;
    /**
     * `git worktree remove --force <path>`: discards modified and untracked files. One `--force`
     * only, so git still refuses a LOCKED worktree. Run only for a worktree the user named in
     * `force_worktree_paths` whose sole problem the plan found is uncommitted changes.
     */
    forceRemoveWorktree(repoPath: string, worktreePath: string): Promise<void>;
}

export interface WorktreeCleanupDeps {
    readonly git: WorktreeCleanupGit;
    readonly bundled: BundledWorktreeOps | null;
    /** Settings `worktreeBasePath` template: a worktree directly inside it is Kelpi's. */
    readonly worktreeBasePath: string;
}

export type WorktreeCleanupBlock =
    | { readonly kind: 'shared'; readonly workspaces: readonly string[] }
    | { readonly kind: 'nested'; readonly worktrees: readonly string[] }
    | { readonly kind: 'dirty'; readonly changedFiles: number }
    | { readonly kind: 'unreadable' }
    | { readonly kind: 'detached-commits'; readonly commits: number | null };

/** The rows that planned a worktree, by workspace. A synthetic row (a pane's cwd) has no id. */
export type WorktreeCleanupOwners = readonly { readonly workspaceID: string; readonly associationID: string | null }[];

export interface WorktreeCleanupCandidate {
    /** Canonical path: what two workspaces' rows for one worktree have in common. */
    readonly key: string;
    /** The path as the first row stored it. */
    readonly worktreePath: string;
    /** The main checkout, as git names it: where removal runs from. */
    readonly repoPath: string;
    /** Every planned row for this worktree, in the order they were given. */
    readonly associations: WorktreeCleanupOwners;
    /** Null = detached HEAD (or unreadable). */
    readonly branch: string | null;
    /** Directly inside the worktree base path for its repo: Kelpi made it. */
    readonly managed: boolean;
    readonly changedFiles: number | null;
    /** Null = unknown (a plugin provider owns `kelpi.git`, or the read failed). */
    readonly commitsOnlyHere: number | null;
    readonly blocked: WorktreeCleanupBlock | null;
    /**
     * Blocked ONLY by uncommitted changes (nothing shared, nested, unreadable or holding
     * commits no branch has), with bundled git to force it: the user may opt in to discarding
     * them (`force_worktree_paths`). Never the default.
     */
    readonly forceable: boolean;
    /** The dialog's default: removable, and Kelpi made it. */
    readonly recommended: boolean;
    /** Every commit on the branch is reachable elsewhere, and it is not the default branch. */
    readonly branchDeletable: boolean;
}

/** A row the plan did not offer, and why: so a caller can say so without asking git again. */
export interface WorktreeCleanupSkipped {
    readonly key: string;
    readonly worktreePath: string;
    readonly associations: WorktreeCleanupOwners;
    /** `main-checkout`: git calls it the main one. `not-a-worktree`: gone, or not a root. */
    readonly reason: 'main-checkout' | 'not-a-worktree';
}

export interface WorktreeCleanupPlan {
    readonly candidates: readonly WorktreeCleanupCandidate[];
    readonly skipped: readonly WorktreeCleanupSkipped[];
}

export interface WorktreeCleanupRow {
    readonly workspaceID: string;
    readonly association: Pick<RepoAssociation, 'worktreePath'> & { readonly id: string | null };
}

export interface PlanWorktreeCleanupInput {
    /** Current state: who else uses a worktree is read from it. */
    readonly state: DaemonState;
    readonly rows: readonly WorktreeCleanupRow[];
    /** Workspaces going in the same delete: their rows and panes do not count as sharing. */
    readonly excluding: ReadonlySet<string>;
}

export interface WorktreeCleanupResult {
    /** The first planning row's id; absent for a worktree planned from a pane's cwd. */
    readonly associationID?: string | undefined;
    readonly worktreePath: string;
    readonly removed: boolean;
    /** Removed with `--force`: this many uncommitted changes went with it. */
    readonly discardedChanges?: number | undefined;
    /** The plan kept it: what kept it (`error` is the reason in words). */
    readonly blocked?: WorktreeCleanupBlock['kind'] | undefined;
    /** Why it was not removed: the plan's reason, or git's own refusal. */
    readonly error?: string | undefined;
    readonly branch?: string | undefined;
    readonly branchDeleted?: boolean | undefined;
    readonly branchError?: string | undefined;
}

/** A worktree path's identity: standardized (`~` expanded), then symlinks resolved. */
export function worktreeKey(worktreePath: string, home: string): string {
    const standardized = standardizePath(worktreePath, home);
    return standardized === '' ? '' : canonicalizePath(standardized);
}

/** Is canonical `candidate` the canonical `root` or inside it? */
export function isInsideKey(candidate: string, root: string): boolean {
    return candidate !== '' && root !== '' && (candidate === root || candidate.startsWith(`${root}/`));
}

/**
 * Everything one plan reads more than once, worked out once: canonical paths (a realpath walk
 * each, memoized), the other workspaces' rows and panes as canonical keys, and one
 * `git worktree list` per repo however many candidates share it.
 */
interface PlanContext {
    keyOf(worktreePath: string): string;
    readonly others: readonly { readonly name: string; readonly rows: readonly string[]; readonly panes: readonly string[] }[];
    worktreesOf(repoPath: string): Promise<readonly WorktreeInfo[] | null>;
}

function planContext(input: PlanWorktreeCleanupInput, deps: WorktreeCleanupDeps): PlanContext {
    const home = input.state.homeDirectory;
    const keys = new Map<string, string>();
    const keyOf = (worktreePath: string): string => {
        let key = keys.get(worktreePath);
        if (key === undefined) {
            key = worktreeKey(worktreePath, home);
            keys.set(worktreePath, key);
        }
        return key;
    };
    const others = input.state.workspaces
        .filter((workspace) => !input.excluding.has(workspace.id))
        .map((workspace) => ({
            name: workspace.name,
            rows: workspace.repoAssociations.map((association) => keyOf(association.worktreePath)),
            panes: [...workspace.panes, ...workspace.parkedPanes].map((pane) => keyOf(pane.workingDirectory))
        }));
    const lists = new Map<string, Promise<readonly WorktreeInfo[] | null>>();
    const worktreesOf = (repoPath: string): Promise<readonly WorktreeInfo[] | null> => {
        let list = lists.get(repoPath);
        if (list === undefined) {
            list = settled(deps.git.listWorktrees(repoPath));
            lists.set(repoPath, list);
        }
        return list;
    };
    return { keyOf, others, worktreesOf };
}

async function settled<T>(work: Promise<T>): Promise<T | null> {
    try {
        return await work;
    } catch {
        return null;
    }
}

type PlannedRow = WorktreeCleanupCandidate | WorktreeCleanupSkipped;

async function planOne(
    key: string,
    worktreePath: string,
    associations: WorktreeCleanupOwners,
    context: PlanContext,
    input: PlanWorktreeCleanupInput,
    deps: WorktreeCleanupDeps
): Promise<PlannedRow> {
    const skip = (reason: WorktreeCleanupSkipped['reason']): WorktreeCleanupSkipped => ({ key, worktreePath, associations, reason });
    const info = await settled(deps.git.resolveRepoRoot(worktreePath));
    // Gone, or not a checkout at all: there is nothing to remove.
    if (info === null) return skip('not-a-worktree');
    // The row names a folder inside a checkout rather than a worktree root.
    if (context.keyOf(info.worktreeRoot) !== key) return skip('not-a-worktree');
    const repoPath = info.parentRepoRoot;
    if (context.keyOf(repoPath) === key) return skip('main-checkout');
    const worktrees = await context.worktreesOf(repoPath);
    // A submodule's (or `--separate-git-dir`'s) parent reads as its git dir, not a checkout;
    // git's own list knows which entry is the main worktree.
    if (worktrees?.some((entry) => entry.isMain && context.keyOf(entry.path) === key) === true) {
        return skip('main-checkout');
    }

    const [status, rawBranch] = await Promise.all([
        settled(deps.git.getStatus(worktreePath)),
        settled(deps.git.getCurrentBranch(worktreePath))
    ]);
    const branch = rawBranch === null || rawBranch === DETACHED_HEAD ? null : rawBranch;
    const commitsOnlyHere =
        deps.bundled === null ? null : await settled(deps.bundled.commitsOnlyHere(worktreePath, branch));
    const nested =
        worktrees === null
            ? []
            : worktrees
                  .map((entry) => entry.path)
                  .filter((entry) => {
                      const nestedKey = context.keyOf(entry);
                      return nestedKey !== key && isInsideKey(nestedKey, key);
                  });
    const sharers = context.others
        .filter((other) => other.rows.includes(key) || other.panes.some((pane) => isInsideKey(pane, key)))
        .map((other) => other.name);

    // Every reason that applies, most serious first: `blocked` reports the first, and only a
    // worktree whose ONE reason is uncommitted changes may be forced.
    const reasons: WorktreeCleanupBlock[] = [];
    if (sharers.length > 0) reasons.push({ kind: 'shared', workspaces: sharers });
    if (nested.length > 0) reasons.push({ kind: 'nested', worktrees: nested });
    if (status === null || status.kind === 'unknown' || worktrees === null) reasons.push({ kind: 'unreadable' });
    else if (status.kind === 'dirty') reasons.push({ kind: 'dirty', changedFiles: status.changedFiles });
    if (branch === null && commitsOnlyHere !== 0) reasons.push({ kind: 'detached-commits', commits: commitsOnlyHere });
    const blocked = reasons[0] ?? null;
    const forceable = reasons.length === 1 && blocked?.kind === 'dirty' && deps.bundled !== null;

    let branchDeletable = false;
    if ((blocked === null || forceable) && branch !== null && commitsOnlyHere === 0 && deps.bundled !== null) {
        const protectedBranch = await settled(deps.bundled.defaultBranch(repoPath));
        branchDeletable = branch !== protectedBranch;
    }

    const base = context.keyOf(resolvedWorktreeBasePath(deps.worktreeBasePath, repoPath, input.state.homeDirectory));
    const managed = base !== '' && path.dirname(key) === base;
    return {
        key,
        worktreePath,
        repoPath,
        associations,
        branch,
        managed,
        changedFiles: status === null || status.kind === 'unknown' ? null : status.kind === 'dirty' ? status.changedFiles : 0,
        commitsOnlyHere,
        blocked,
        forceable,
        recommended: blocked === null && managed,
        branchDeletable
    };
}

/**
 * Plan the given rows: one entry per distinct worktree (rows are merged on the canonical path),
 * in first-seen order. A row that is not the root of a linked worktree (a main checkout, a
 * folder inside one, a path that is gone) is `skipped`, with the reason.
 */
export async function planWorktreeCleanup(
    input: PlanWorktreeCleanupInput,
    deps: WorktreeCleanupDeps
): Promise<WorktreeCleanupPlan> {
    const context = planContext(input, deps);
    const groups = new Map<string, { worktreePath: string; associations: { workspaceID: string; associationID: string | null }[] }>();
    for (const row of input.rows) {
        const key = context.keyOf(row.association.worktreePath);
        if (key === '') continue;
        const group = groups.get(key) ?? { worktreePath: row.association.worktreePath, associations: [] };
        group.associations.push({ workspaceID: row.workspaceID, associationID: row.association.id });
        groups.set(key, group);
    }
    const planned = await Promise.all(
        [...groups].map(([key, group]) => planOne(key, group.worktreePath, group.associations, context, input, deps))
    );
    return {
        candidates: planned.filter((entry): entry is WorktreeCleanupCandidate => !('reason' in entry)),
        skipped: planned.filter((entry): entry is WorktreeCleanupSkipped => 'reason' in entry)
    };
}

function plural(count: number, one: string, many: string): string {
    return `${count} ${count === 1 ? one : many}`;
}

/** The reason a blocked candidate stays, in the words the dialog and the CLI both show. */
export function describeWorktreeBlock(block: WorktreeCleanupBlock): string {
    switch (block.kind) {
        case 'shared': {
            const names = block.workspaces.map((name) => `"${name}"`).join(', ');
            return `also used by ${block.workspaces.length === 1 ? 'workspace' : 'workspaces'} ${names}`;
        }
        case 'nested':
            return `has another worktree inside it (${block.worktrees.join(', ')})`;
        case 'dirty':
            return `has ${plural(block.changedFiles, 'uncommitted change', 'uncommitted changes')}`;
        case 'unreadable':
            return 'its git status could not be read';
        case 'detached-commits':
            return block.commits === null
                ? 'detached HEAD that may hold commits no branch has'
                : `detached HEAD with ${plural(block.commits, 'commit', 'commits')} no branch has`;
    }
}

/** A skipped row's reason, in words. */
export function describeWorktreeSkip(reason: WorktreeCleanupSkipped['reason']): string {
    return reason === 'main-checkout'
        ? 'the main checkout, not a worktree'
        : 'not a linked worktree (its folder is gone or not a checkout)';
}

/**
 * Remove each candidate that is not blocked, one at a time (git takes the repo's worktree lock),
 * and delete its branch when asked and it is still safe. A blocked candidate is reported with
 * its reason and left alone, unless it is `forceable` and its key is in `force`: then it is
 * removed with `--force`, discarding its uncommitted changes. Never throws: every failure is a
 * result.
 */
export async function removeWorktrees(
    candidates: readonly WorktreeCleanupCandidate[],
    options: { readonly deleteBranches: boolean; readonly force?: ReadonlySet<string> | undefined },
    deps: WorktreeCleanupDeps
): Promise<WorktreeCleanupResult[]> {
    const results: WorktreeCleanupResult[] = [];
    for (const candidate of candidates) {
        const associationID = candidate.associations.find((entry) => entry.associationID !== null)?.associationID;
        const base = {
            ...(associationID !== undefined && associationID !== null ? { associationID } : {}),
            worktreePath: candidate.worktreePath,
            ...(candidate.branch !== null ? { branch: candidate.branch } : {})
        };
        const forced =
            candidate.blocked?.kind === 'dirty' && candidate.forceable && options.force?.has(candidate.key) === true
                ? candidate.blocked.changedFiles
                : null;
        if (candidate.blocked !== null && forced === null) {
            results.push({
                ...base,
                removed: false,
                blocked: candidate.blocked.kind,
                error: describeWorktreeBlock(candidate.blocked)
            });
            continue;
        }
        try {
            if (forced !== null && deps.bundled !== null) await deps.bundled.forceRemoveWorktree(candidate.repoPath, candidate.worktreePath);
            else await deps.git.removeWorktree(candidate.repoPath, candidate.worktreePath);
        } catch (error) {
            results.push({ ...base, removed: false, error: worktreeErrorMessage(error) });
            continue;
        }
        const removed = { ...base, removed: true, ...(forced !== null ? { discardedChanges: forced } : {}) };
        const branch = candidate.branch;
        if (!options.deleteBranches || branch === null || deps.bundled === null) {
            results.push(removed);
            continue;
        }
        if (!candidate.branchDeletable) {
            results.push({ ...removed, branchDeleted: false, branchError: keptBranchReason(candidate) });
            continue;
        }
        results.push({ ...removed, ...(await deleteBranchIfSafe(candidate.repoPath, branch, deps.bundled)) });
    }
    return results;
}

function keptBranchReason(candidate: WorktreeCleanupCandidate): string {
    if (candidate.commitsOnlyHere === null) return 'could not check its commits';
    if (candidate.commitsOnlyHere > 0) {
        return `${plural(candidate.commitsOnlyHere, 'commit', 'commits')} no other branch or remote has`;
    }
    return 'it is the default branch';
}

/** Re-checked just before `-D`: the plan ran moments ago, but the branch is what gets lost. */
async function deleteBranchIfSafe(
    repoPath: string,
    branch: string,
    ops: BundledWorktreeOps
): Promise<{ branchDeleted: boolean; branchError?: string }> {
    try {
        const count = await ops.commitsOnlyHere(repoPath, branch);
        if (count !== 0) {
            return { branchDeleted: false, branchError: `${plural(count, 'commit', 'commits')} no other branch or remote has` };
        }
        await ops.deleteBranch(repoPath, branch);
        return { branchDeleted: true };
    } catch (error) {
        return { branchDeleted: false, branchError: worktreeErrorMessage(error) };
    }
}

/** Bundled git's `BundledWorktreeOps`, over the same runner the worktree create uses. */
export function bundledWorktreeOps(ops: WorktreeGitOps): BundledWorktreeOps {
    return {
        async commitsOnlyHere(cwd, branch) {
            // `--exclude` drops the branch itself from `--branches` (and only from it); names
            // cannot hold glob characters, so it matches exactly. `--all` would not do: it
            // includes HEAD, which in the worktree IS the branch.
            const args =
                branch === null
                    ? ['rev-list', '--count', 'HEAD', '--not', '--branches', '--remotes', '--tags']
                    : ['rev-list', '--count', `refs/heads/${branch}`, '--not', `--exclude=${branch}`, '--branches', '--remotes', '--tags'];
            const out = (await ops.read(args, cwd)).trim();
            const count = Number.parseInt(out, 10);
            if (!Number.isSafeInteger(count) || count < 0 || String(count) !== out) {
                throw new Error(`unexpected rev-list output: ${out}`);
            }
            return count;
        },
        async defaultBranch(repoPath) {
            try {
                const out = (await ops.read(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], repoPath)).trim();
                const prefix = 'refs/remotes/origin/';
                return out.startsWith(prefix) ? out.slice(prefix.length) : null;
            } catch {
                return null;
            }
        },
        async deleteBranch(repoPath, branch) {
            await ops.long(['branch', '-D', branch], repoPath);
        },
        async forceRemoveWorktree(repoPath, worktreePath) {
            await ops.long(['worktree', 'remove', '--force', worktreePath], repoPath);
        }
    };
}
