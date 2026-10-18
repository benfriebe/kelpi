/**
 * Checking a pull request out into a new worktree (graft-git.md §8.5.3; docs/integrations.md §8):
 * the git half of a `workspace-create` from a pull request, in the `pr-head` mode.
 *
 * It is its OWN request type, deliberately not a field on `WorktreeAddRequest`, so it never leaks
 * into the plugin `git.worktreeAdd` contract; and it runs only on Kelpi's own git (a create from a
 * pull request is refused while a plugin provider owns `kelpi.git`). Like `gh pr checkout`, with a
 * worktree where gh checks out in place:
 *
 *   head reachable through a remote      (a same-repository pull request: the base remote; a fork:
 *   the remote that already points at it, `headRemote`)
 *       git fetch --no-tags <remote> +refs/heads/<head>:refs/remotes/<remote>/<head>
 *       no local branch   git worktree add --track -b <b> <path> refs/remotes/<remote>/<head>
 *       a local branch    git worktree add <path> <b>, then a best-effort `merge --ff-only` onto
 *                         the fetched head; a branch that has diverged (a force-push) stays as it
 *                         was and the reply carries a WARNING; its upstream is set only if missing
 *
 *   a fork with no such remote, or a head branch that is gone (merged and deleted)
 *       git fetch --no-tags <base remote> refs/pull/<n>/head:refs/heads/<b>      (NOT forced: a
 *                         local branch the head is not a fast-forward of is a clear error)
 *       git worktree add <path> <b>
 *       upstream, only when the branch has none (never overwriting `branch.<b>.*`):
 *         maintainers may push, fork alive   remote = pushRemote = the fork's URL (`headPushURL`),
 *                                            merge = refs/heads/<head>
 *         otherwise                          remote = pushRemote = the base remote,
 *                                            merge = refs/pull/<n>/head (pull works, push cannot)
 *
 * A head branch that is gone is detected without reading git's (localized) stderr: when the fetch
 * fails, `git ls-remote --exit-code <remote> refs/heads/<head>` exits 2 for "no such ref".
 *
 * It never falls back to `-b <b>` off HEAD: a pull request's worktree is on its head or nowhere.
 * A branch checked out anywhere (the main clone included) is an error naming that path; a local
 * branch of the chosen name that does not track this pull request is an error too. Both are read
 * with `git/repo-facts.ts`' strict readers and judged by `@kelpi/core/tickets`' `tracksPullRequest`,
 * the reader and the rule the resolve and the create's plan use, so a branch the sheet prefilled
 * as this pull request's is never refused here as someone else's. Head and local
 * branch names are used RAW (never `sanitizedGitName`, which would push to another branch) but must
 * pass `isSafeBranchName` and `git check-ref-format --branch`, and remote names must be remotes of
 * the repository.
 *
 * Hooks: a RELATIVE `core.hooksPath` (`.githooks`, husky's `.husky/_`) names a folder of the
 * checkout. The fast-forward runs IN the new worktree, so its `post-merge` is the worktree's own
 * copy: for a fork's pull request, the fork's tracked script. `worktree add` runs `post-checkout`
 * in the new worktree too; git 2.50 looks the hook up from where it was started (the main
 * checkout), but where that lookup happens is git's choice, not ours. So for a cross-repository
 * pull request with a relative `core.hooksPath`, both calls run with `-c core.hooksPath=/dev/null`
 * and the reply says so; an absolute (or `~`) hooks path, the default `.git/hooks`, and every
 * same-repository pull request keep the user's hooks (`hooksGuard`).
 *
 * Cancellation follows §8.5.2: a snapshot taken BEFORE the fetch (the pull-ref fetch can create the
 * branch), with the commit the fetch arrived at counted as a tip this create could have made; a
 * cancel once `worktree add` has returned is too late, and what follows (the fast-forward, the
 * upstream) is not cancellable.
 */

import { isSafeBranchName, parseGitHubRemote, pullRequestUpstreamPointsAt, tracksPullRequest } from '@kelpi/core/tickets';

import { isGitCommandError } from './exec.js';
import { worktreeErrorMessage } from './names.js';
import type { GitProgress } from './progress.js';
import { readBranchFacts, readRemoteFacts, type BranchConfigFact, type GitRead, type RemoteFact } from './repo-facts.js';
import {
    cleanupCancelledWorktreeAdd,
    pathExists,
    probeRef,
    seconds,
    snapshotBeforeAdd,
    withProgress,
    WorktreeCreateCancelledError,
    type WorktreeAddHooks,
    type WorktreeAddRequest,
    type WorktreeAddSnapshot,
    type WorktreeGitCallOptions,
    type WorktreeGitOps
} from './worktree-add.js';
import type { WorktreeStepID } from './worktree-steps.js';

export interface PullRequestCheckoutRequest {
    readonly repoPath: string;
    readonly worktreePath: string;
    /** The local branch: `prLocalBranchName`'s choice, or the name the user gave it. Used raw. */
    readonly branchName: string;
    readonly number: number;
    /** The head branch's own name (`headRefName`). Used raw. */
    readonly headRef: string;
    /** The head commit GitHub reported (`headRefOid`). */
    readonly headSha: string;
    readonly crossRepository: boolean;
    readonly maintainerCanModify: boolean;
    /** `owner/name` of the pull request's (base) repository: the ticket's. */
    readonly baseRepo: string;
    /** `owner/name` of the head repository; null when the fork was deleted. */
    readonly headRepo: string | null;
    /** The remote of `repoPath` that points at the pull request's base repository. */
    readonly baseRemote: string;
    /** A remote of `repoPath` that already points at the head repository (a fork's). */
    readonly headRemote: string | null;
    /** Where a fork's branch is pushed when there is no `headRemote` and its maintainers may push. */
    readonly headPushURL: string | null;
}

export interface PullRequestCheckoutResult {
    /** Reply warnings: a branch that could not be fast-forwarded, a head that cannot be pushed to. */
    readonly warnings: readonly string[];
    /** The local branch existed before this checkout (it was attached, not made). */
    readonly branchExisted: boolean;
    /** Where the commits came from: the head branch, or `refs/pull/<n>/head`. */
    readonly source: 'head-branch' | 'pull-ref';
}

/** A request this module refuses, or a checkout it cannot do; the message is ready to show. */
export class PullRequestCheckoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PullRequestCheckoutError';
    }
}

export type PullRequestCheckoutHooks = Pick<WorktreeAddHooks, 'signal' | 'steps' | 'log'>;

// ---------------------------------------------------------------------------
// Reads (the one reader and the one rule: module note)
// ---------------------------------------------------------------------------

/** What a local branch is to this repository right now. */
interface LocalBranchState {
    readonly exists: boolean;
    /** The checkout it is checked out in (the repository itself, a linked worktree, or one whose directory is gone), or null. */
    readonly checkedOutAt: string | null;
    /** `branch.<b>.*`; all null for a branch with none, or none at all. */
    readonly config: BranchConfigFact;
    readonly tracksPullRequest: boolean;
}

/** `ops.read` in `repoPath`, as `repo-facts.ts`' strict readers take it. */
function readIn(ops: WorktreeGitOps, repoPath: string, signal?: AbortSignal): GitRead {
    return (args) => ops.read(args, repoPath, signal !== undefined ? { signal } : {});
}

/**
 * Whether git takes `name` as a branch name: `isSafeBranchName` (strict, and never a leading `-`)
 * AND `git check-ref-format --branch`, which is git's own rule for the git that will run.
 */
export async function isUsableBranchName(ops: WorktreeGitOps, repoPath: string, name: string, signal?: AbortSignal): Promise<boolean> {
    if (!isSafeBranchName(name)) return false;
    try {
        const out = (await ops.read(['check-ref-format', '--branch', name], repoPath, signal !== undefined ? { signal } : {})).trim();
        return out === name;
    } catch (error) {
        if (signal?.aborted) throw error;
        return false;
    }
}

/**
 * `branch` in the request's repository: does it exist, where is it checked out (any worktree git
 * lists, so git's own "already used by worktree" never surfaces first), and whether it already is
 * this pull request's (`tracksPullRequest` with what the request matched: its base remote, a
 * fork's remote or push URL, and every remote that fetches from either repository).
 */
async function readLocalBranch(
    ops: WorktreeGitOps,
    request: PullRequestCheckoutRequest,
    remotes: readonly RemoteFact[],
    headPushURL: string | null,
    signal?: AbortSignal
): Promise<LocalBranchState> {
    const facts = await readBranchFacts(readIn(ops, request.repoPath, signal));
    const branch = request.branchName;
    const config = facts.branches.get(branch);
    const checkedOutAt = facts.worktrees.find((worktree) => worktree.branch === branch && !worktree.bare)?.path ?? null;
    if (config === undefined) return { exists: false, checkedOutAt, config: { remote: null, merge: null, pushRemote: null }, tracksPullRequest: false };
    const pointsAt = pullRequestUpstreamPointsAt(remotes, {
        baseRepo: request.baseRepo,
        headRepo: request.crossRepository ? request.headRepo : request.baseRepo,
        crossRepository: request.crossRepository,
        baseRemote: request.baseRemote,
        headRemote: request.headRemote,
        headPushURL
    });
    return {
        exists: true,
        checkedOutAt,
        config,
        tracksPullRequest: tracksPullRequest(config, { number: request.number, headRef: request.headRef, crossRepository: request.crossRepository }, pointsAt)
    };
}

// ---------------------------------------------------------------------------
// The checkout
// ---------------------------------------------------------------------------

const SHA_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

async function validate(
    ops: WorktreeGitOps,
    request: PullRequestCheckoutRequest,
    signal: AbortSignal | undefined
): Promise<{ readonly headPushURL: string | null; readonly warnings: string[]; readonly remotes: readonly RemoteFact[] }> {
    const warnings: string[] = [];
    if (!Number.isSafeInteger(request.number) || request.number <= 0) throw new PullRequestCheckoutError(`'${String(request.number)}' is not a pull request number`);
    if (!SHA_PATTERN.test(request.headSha)) throw new PullRequestCheckoutError(`pull request #${request.number} has no usable head commit`);
    if (!(await isUsableBranchName(ops, request.repoPath, request.headRef, signal))) {
        throw new PullRequestCheckoutError(`pull request #${request.number}'s head branch is not a branch name Kelpi can check out`);
    }
    if (!(await isUsableBranchName(ops, request.repoPath, request.branchName, signal))) {
        throw new PullRequestCheckoutError(`"${request.branchName}" isn't a usable branch name`);
    }
    const remotes = await readRemoteFacts(readIn(ops, request.repoPath, signal));
    const names = new Set(remotes.map((remote) => remote.name));
    if (!names.has(request.baseRemote)) throw new PullRequestCheckoutError(`${request.repoPath} has no remote named '${request.baseRemote}'`);
    if (request.headRemote !== null && !names.has(request.headRemote)) {
        throw new PullRequestCheckoutError(`${request.repoPath} has no remote named '${request.headRemote}'`);
    }
    let headPushURL = request.headPushURL;
    if (headPushURL !== null && (headPushURL.startsWith('-') || parseGitHubRemote(headPushURL) === null)) {
        warnings.push(`the fork's push address for pull request #${request.number} is not a GitHub remote, so the branch was not set to push there`);
        headPushURL = null;
    }
    return { headPushURL, warnings, remotes };
}

/** A hooks path git resolves without the working tree: absolute, home-relative, or under git's runtime prefix. */
function hooksPathOutsideCheckout(value: string): boolean {
    return value.startsWith('/') || value.startsWith('~') || value.startsWith('%(prefix)/');
}

/**
 * The `git -c` arguments the checkout's `worktree add` and `merge` run with (module note): none,
 * unless the pull request is a fork's and `core.hooksPath` is relative, so it would name a folder
 * of the fork's own checkout; then hooks are off for those two calls, and `warning` says so.
 */
async function hooksGuard(
    ops: WorktreeGitOps,
    request: PullRequestCheckoutRequest,
    signal: AbortSignal | undefined
): Promise<{ readonly args: readonly string[]; readonly warning: string | null }> {
    if (!request.crossRepository) return { args: [], warning: null };
    let value: string;
    try {
        value = (await ops.read(['config', '--get', 'core.hooksPath'], request.repoPath, signal !== undefined ? { signal } : {})).trim();
    } catch (error) {
        // Exit 1: unset, so git's own `.git/hooks`, which a checkout cannot write.
        if (!signal?.aborted && isGitCommandError(error) && error.exitCode === 1) return { args: [], warning: null };
        throw error;
    }
    if (value === '' || hooksPathOutsideCheckout(value)) return { args: [], warning: null };
    return {
        args: ['-c', 'core.hooksPath=/dev/null'],
        warning: `git hooks did not run for pull request #${request.number}'s checkout: core.hooksPath (${value}) is inside the checkout, which holds the fork's files`
    };
}

/** Exit 2 from `ls-remote --exit-code`: the remote has no such branch (any other answer: unknown). */
async function headBranchGone(ops: WorktreeGitOps, repoPath: string, remote: string, headRef: string, signal?: AbortSignal): Promise<boolean> {
    try {
        await ops.read(['ls-remote', '--exit-code', remote, `refs/heads/${headRef}`], repoPath, signal !== undefined ? { signal } : {});
        return false;
    } catch (error) {
        if (signal?.aborted) throw error;
        return isGitCommandError(error) && error.exitCode === 2;
    }
}

/** `git merge-base --is-ancestor a b`: exit 0 yes, 1 no; anything else reads as "cannot tell". */
async function isAncestor(ops: WorktreeGitOps, repoPath: string, ancestor: string, descendant: string): Promise<boolean | null> {
    try {
        await ops.read(['merge-base', '--is-ancestor', ancestor, descendant], repoPath);
        return true;
    } catch (error) {
        return isGitCommandError(error) && error.exitCode === 1 ? false : null;
    }
}

export async function performPullRequestCheckout(
    ops: WorktreeGitOps,
    request: PullRequestCheckoutRequest,
    hooks: PullRequestCheckoutHooks = {}
): Promise<PullRequestCheckoutResult> {
    const { signal } = hooks;
    const steps = hooks.steps ?? null;
    const log = hooks.log ?? ((): void => {});
    const reporting = steps !== null;
    const onProgress = (step: WorktreeStepID) => (reporting ? (progress: GitProgress) => steps.progress(step, progress) : undefined);
    const callOptions = (step: WorktreeStepID): WorktreeGitCallOptions => ({
        ...(signal !== undefined ? { signal } : {}),
        ...(reporting && step === 'worktree-add' ? { env: { GIT_PROGRESS_DELAY: '0' } } : {})
    });
    const asAdd: WorktreeAddRequest = {
        repoPath: request.repoPath,
        worktreePath: request.worktreePath,
        branchName: request.branchName,
        updateMain: false
    };
    const { repoPath, branchName: branch, number, headRef } = request;
    let current: WorktreeStepID = 'fetch';
    let before: WorktreeAddSnapshot | null = null;
    const bail = (): void => {
        if (signal?.aborted) throw new WorktreeCreateCancelledError(current);
    };

    try {
        bail();
        const checked = await validate(ops, request, signal);
        const warnings = checked.warnings;
        const guard = await hooksGuard(ops, request, signal);
        const headPushURL = checked.headPushURL;
        const local = await readLocalBranch(ops, request, checked.remotes, headPushURL, signal);
        bail();
        if (local.checkedOutAt !== null) {
            throw new PullRequestCheckoutError(`branch '${branch}' is already checked out at '${local.checkedOutAt}': open a workspace there, or choose another branch name`);
        }
        if (local.exists && !local.tracksPullRequest) {
            throw new PullRequestCheckoutError(`a local branch '${branch}' already exists and does not track pull request #${number}: choose another branch name`);
        }

        // The cleanup's authority, taken before the fetch: the pull-ref fetch can create the branch.
        if (signal !== undefined) {
            const snapshot = await snapshotBeforeAdd(ops, asAdd, []);
            before = { ...snapshot, possibleTips: new Set([request.headSha]) };
        }
        bail();

        const fetchRemote = request.crossRepository ? request.headRemote : request.baseRemote;
        let source: 'head-branch' | 'pull-ref' = fetchRemote === null ? 'pull-ref' : 'head-branch';
        let headGone = false;
        const fetch = async (remote: string, refspec: string): Promise<void> => {
            await withProgress(
                (extra) =>
                    ops.long(['fetch', '--no-tags', ...(reporting ? ['--progress'] : []), remote, refspec], repoPath, {
                        ...callOptions('fetch'),
                        ...extra
                    }),
                onProgress('fetch')
            );
        };
        const startedAt = Date.now();
        if (fetchRemote !== null) {
            steps?.running('fetch', `${fetchRemote}/${headRef}`);
            try {
                await fetch(fetchRemote, `+refs/heads/${headRef}:refs/remotes/${fetchRemote}/${headRef}`);
            } catch (error) {
                if (signal?.aborted || !(await headBranchGone(ops, repoPath, fetchRemote, headRef, signal))) throw error;
                log(`pr-checkout: ${fetchRemote} no longer has ${headRef} (pull request #${number}); fetching refs/pull/${number}/head from ${request.baseRemote}`);
                source = 'pull-ref';
                headGone = true;
            }
        }
        if (source === 'pull-ref') {
            steps?.running('fetch', `pull/${number}/head from ${request.baseRemote}`);
            try {
                await fetch(request.baseRemote, `refs/pull/${number}/head:refs/heads/${branch}`);
            } catch (error) {
                if (signal?.aborted || !local.exists) throw error;
                throw new PullRequestCheckoutError(
                    `could not bring local branch '${branch}' up to pull request #${number}'s head (${worktreeErrorMessage(error)}): if the pull request was force-pushed, delete or rename '${branch}' and try again`
                );
            }
        }
        bail();
        const fetchedRef = source === 'head-branch' ? `refs/remotes/${fetchRemote ?? ''}/${headRef}` : `refs/heads/${branch}`;
        const fetchedTip = await probeRef(ops, repoPath, fetchedRef);
        if (typeof fetchedTip !== 'string') throw new PullRequestCheckoutError(`the fetch of pull request #${number} left no ${fetchedRef}`);
        if (before !== null) before = { ...before, possibleTips: new Set([...before.possibleTips, fetchedTip]) };
        if (fetchedTip !== request.headSha) log(`pr-checkout: pull request #${number}'s head moved since it was resolved (${request.headSha.slice(0, 12)} -> ${fetchedTip.slice(0, 12)})`);
        steps?.done('fetch', `${source === 'head-branch' ? `${fetchRemote ?? ''}/${headRef}` : `pull/${number}/head`} (${seconds(Date.now() - startedAt)})`);
        bail();

        current = 'worktree-add';
        steps?.running('worktree-add', branch);
        const args = [
            ...guard.args,
            ...(source === 'head-branch' && !local.exists
                ? ['worktree', 'add', '--track', '-b', branch, request.worktreePath, fetchedRef]
                : ['worktree', 'add', request.worktreePath, branch])
        ];
        await withProgress((extra) => ops.long(args, repoPath, { ...callOptions('worktree-add'), ...extra }), onProgress('worktree-add'));
        bail();

        // From here the create completes: nothing below is cancellable, and each part is best effort.
        if (source === 'head-branch' && local.exists) {
            const localTip = await probeRef(ops, repoPath, `refs/heads/${branch}`);
            if (typeof localTip === 'string' && localTip !== fetchedTip) {
                const behind = await isAncestor(ops, repoPath, localTip, fetchedTip);
                if (behind === true) {
                    try {
                        await ops.long([...guard.args, 'merge', '--ff-only', '--quiet', fetchedTip], request.worktreePath);
                    } catch (error) {
                        warnings.push(`could not fast-forward '${branch}' to pull request #${number}'s head: ${worktreeErrorMessage(error)}`);
                    }
                } else if ((await isAncestor(ops, repoPath, fetchedTip, localTip)) !== true) {
                    warnings.push(
                        `local branch '${branch}' has diverged from ${fetchRemote ?? ''}/${headRef} (was pull request #${number} force-pushed?): the worktree is on your local commits; run \`git reset --hard ${fetchRemote ?? ''}/${headRef}\` in it to take the pull request's`
                    );
                }
            }
        }
        const upstream: { remote: string; merge: string; pushRemote: boolean } | null =
            local.config.merge !== null
                ? null
                : source === 'head-branch'
                  ? local.exists
                      ? { remote: fetchRemote ?? request.baseRemote, merge: `refs/heads/${headRef}`, pushRemote: false }
                      : null // `--track` set it
                  : request.crossRepository && !headGone && request.headRemote === null && headPushURL !== null
                    ? { remote: headPushURL, merge: `refs/heads/${headRef}`, pushRemote: true }
                    : { remote: request.baseRemote, merge: `refs/pull/${number}/head`, pushRemote: true };
        if (upstream !== null) {
            try {
                await ops.read(['config', `branch.${branch}.remote`, upstream.remote], repoPath);
                if (upstream.pushRemote) await ops.read(['config', `branch.${branch}.pushRemote`, upstream.remote], repoPath);
                await ops.read(['config', `branch.${branch}.merge`, upstream.merge], repoPath);
            } catch (error) {
                warnings.push(`could not set what '${branch}' pulls from: ${worktreeErrorMessage(error)}`);
            }
        }
        if (source === 'pull-ref') {
            if (headGone && !request.crossRepository) {
                warnings.push(`pull request #${number}'s head branch '${headRef}' no longer exists on ${request.baseRemote}: the worktree is on refs/pull/${number}/head, which cannot be pushed to`);
            } else if (request.crossRepository && (headGone || headPushURL === null)) {
                const why =
                    request.headRepo === null
                        ? 'its fork was deleted'
                        : headGone
                          ? `its head branch '${headRef}' no longer exists on the fork`
                          : request.maintainerCanModify
                            ? 'Kelpi has no address for its fork'
                            : 'its fork does not let maintainers push to it';
                warnings.push(`pull request #${number} cannot be pushed back (${why}): the branch pulls refs/pull/${number}/head from ${request.baseRemote}`);
            }
        }
        if (guard.warning !== null) {
            log(`pr-checkout: ${guard.warning}`);
            warnings.push(guard.warning);
        }
        steps?.done('worktree-add', branch);
        return { warnings, branchExisted: local.exists, source };
    } catch (error) {
        if (signal?.aborted) {
            if (before !== null) {
                const removed = await cleanupCancelledWorktreeAdd(ops, asAdd, before, log);
                const directory = pathExists(request.worktreePath)
                    ? before.pathExisted
                        ? 'the directory was left (it existed before)'
                        : 'the directory could not be removed'
                    : 'no directory left';
                log(`pr-checkout: cancelled during ${current} for ${request.worktreePath}; removed ${removed.length > 0 ? removed.join(', ') : 'nothing'}; ${directory}`);
            }
            steps?.cancelled(current);
            throw new WorktreeCreateCancelledError(current);
        }
        steps?.failed(current, worktreeErrorMessage(error));
        throw error;
    }
}
