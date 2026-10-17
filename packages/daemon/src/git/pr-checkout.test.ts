/**
 * `performPullRequestCheckout` (graft-git.md §8.5.3) against real repositories: a bare base with
 * hand-written `refs/pull/<n>/head` refs and a bare fork (`pr-testing.ts`). No network.
 *
 * The fork cases compare the branch configuration with `gh pr checkout`'s (cli/cli
 * `pkg/cmd/pr/checkout/checkout.go`, `cmdsForMissingRemote`): with maintainer edits,
 * `branch.<b>.remote` and `.pushRemote` are the fork's URL and `.merge` is `refs/heads/<head>`;
 * without, both are the base remote and `.merge` is `refs/pull/<n>/head`; and an existing
 * `branch.<b>.merge` is never rewritten. gh itself is not run (it would talk to GitHub).
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createGitRunner } from './exec.js';
import {
    branchTracksPullRequest,
    listRemotes,
    matchTicketRemotes,
    performPullRequestCheckout,
    PullRequestCheckoutError,
    type PullRequestCheckoutRequest
} from './pr-checkout.js';
import {
    commit,
    forkPullRequest,
    git,
    HAS_GIT,
    pullRequestFixture,
    removeTmpDirs,
    sameRepoPullRequest,
    tryGit,
    type PullRequestFixture
} from './pr-testing.js';
import { WorktreeCreateCancelledError, worktreeGitOps, type WorktreeGitOps } from './worktree-add.js';
import { createStepTracker, worktreeStepsFor, type WorktreeStepTracker } from './worktree-steps.js';

afterAll(removeTmpDirs);

const ops = (): WorktreeGitOps => worktreeGitOps(createGitRunner());

function request(fx: PullRequestFixture, overrides: Partial<PullRequestCheckoutRequest> & Pick<PullRequestCheckoutRequest, 'headSha'>): PullRequestCheckoutRequest {
    const branchName = overrides.branchName ?? overrides.headRef ?? 'feat/login';
    return {
        repoPath: fx.work,
        worktreePath: path.join(fx.root, 'wt', branchName.replace(/\//g, '-')),
        branchName,
        number: 7,
        headRef: 'feat/login',
        crossRepository: false,
        maintainerCanModify: true,
        headRepo: 'acme/api',
        baseRemote: 'origin',
        headRemote: null,
        headPushURL: null,
        ...overrides
    };
}

function config(repo: string, key: string): string | null {
    return tryGit(repo, 'config', '--get', key);
}

function tracker(): WorktreeStepTracker {
    return createStepTracker({ steps: worktreeStepsFor({ ticket: true, checkout: 'pr-head' }), emit: () => {}, intervalMs: 0 });
}

async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!check()) {
        if (Date.now() > deadline) throw new Error('timed out waiting');
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

describe('matchTicketRemotes', () => {
    it('prefers origin, then upstream, and matches owner/name case-insensitively', () => {
        const remotes = [
            { name: 'mine', url: 'git@github.com:me/api.git' },
            { name: 'upstream', url: 'https://github.com/Acme/API.git' },
            { name: 'origin', url: 'git@github.com-work:acme/api.git' }
        ];
        expect(matchTicketRemotes(remotes, 'acme/api', 'me/api')).toEqual({ base: remotes[2], head: remotes[0] });
        expect(matchTicketRemotes(remotes, 'other/api', null)).toEqual({ base: null, head: null });
    });
});

describe('branchTracksPullRequest', () => {
    const identity = { number: 7, headRef: 'fix', crossRepository: true, headRepo: 'octo/api', baseRemote: 'origin', headRemote: null, headPushURL: 'git@github.com:octo/api.git' };
    it("reads gh's configurations as this pull request's, and nothing else", () => {
        const state = (remote: string | null, merge: string | null) => ({ exists: true, checkedOutAt: null, remote, merge });
        expect(branchTracksPullRequest(state('origin', 'refs/pull/7/head'), identity)).toBe(true);
        expect(branchTracksPullRequest(state('git@github.com:octo/api.git', 'refs/heads/fix'), identity)).toBe(true);
        expect(branchTracksPullRequest(state('https://github.com/octo/api.git', 'refs/heads/fix'), identity)).toBe(true);
        expect(branchTracksPullRequest(state('origin', 'refs/heads/fix'), identity)).toBe(false);
        expect(branchTracksPullRequest(state(null, null), identity)).toBe(false);
        // The author's own branch of a same-repository pull request, never pushed with -u.
        expect(branchTracksPullRequest(state(null, null), { ...identity, crossRepository: false })).toBe(true);
    });
});

describe.skipIf(!HAS_GIT)('performPullRequestCheckout against real git', { timeout: 30_000 }, () => {
    it('same repository, no local branch: a new branch tracking the head, at the head', async () => {
        const fx = pullRequestFixture();
        const head = sameRepoPullRequest(fx, 7, 'feat/login');
        const steps = tracker();
        const result = await performPullRequestCheckout(ops(), request(fx, { headSha: head }), { steps });
        const wt = path.join(fx.root, 'wt', 'feat-login');
        expect(git(wt, 'rev-parse', 'HEAD')).toBe(head);
        expect(git(wt, 'symbolic-ref', 'HEAD')).toBe('refs/heads/feat/login');
        expect(config(fx.work, 'branch.feat/login.remote')).toBe('origin');
        expect(config(fx.work, 'branch.feat/login.merge')).toBe('refs/heads/feat/login');
        expect(result).toEqual({ warnings: [], branchExisted: false, source: 'head-branch' });
        expect(steps.snapshot().steps.map((step) => [step.id, step.status])).toEqual([
            ['ticket', 'pending'],
            ['fetch', 'done'],
            ['worktree-add', 'done'],
            ['create-workspace', 'pending']
        ]);
    });

    it('same repository, a free local branch behind the head: attached and fast-forwarded, its config untouched', async () => {
        const fx = pullRequestFixture();
        const first = sameRepoPullRequest(fx, 7, 'feat/login');
        git(fx.work, 'fetch', '-q', 'origin');
        git(fx.work, 'branch', '--track', 'feat/login', 'origin/feat/login');
        git(fx.work, 'config', 'branch.feat/login.pushRemote', 'origin');
        git(fx.seed, 'checkout', '-q', 'feat/login');
        const head = commit(fx.seed, 'more.txt', 'more\n', 'more');
        git(fx.seed, 'push', '-q', 'origin', 'feat/login');
        git(fx.seed, 'checkout', '-q', 'main');
        expect(git(fx.work, 'rev-parse', 'feat/login')).toBe(first);
        const result = await performPullRequestCheckout(ops(), request(fx, { headSha: head }));
        expect(result).toEqual({ warnings: [], branchExisted: true, source: 'head-branch' });
        expect(git(fx.work, 'rev-parse', 'feat/login')).toBe(head);
        expect(config(fx.work, 'branch.feat/login.pushRemote')).toBe('origin');
    });

    it('same repository, a diverged local branch (force-push): attached as it was, with a warning', async () => {
        const fx = pullRequestFixture();
        sameRepoPullRequest(fx, 7, 'feat/login');
        git(fx.work, 'fetch', '-q', 'origin');
        git(fx.work, 'branch', '--track', 'feat/login', 'origin/feat/login');
        // The author rewrites the branch; the local one keeps its own commit.
        const rewritten = sameRepoPullRequest(fx, 7, 'feat/login', 'rewritten.txt');
        git(fx.work, 'checkout', '-q', 'feat/login');
        const local = commit(fx.work, 'local.txt', 'local\n', 'local work');
        git(fx.work, 'checkout', '-q', 'main');
        const result = await performPullRequestCheckout(ops(), request(fx, { headSha: rewritten }));
        expect(git(fx.work, 'rev-parse', 'feat/login')).toBe(local);
        expect(result.warnings).toEqual([expect.stringContaining("local branch 'feat/login' has diverged from origin/feat/login") as unknown as string]);
    });

    it('a merged pull request whose head branch was deleted is checked out from refs/pull/<n>/head', async () => {
        const fx = pullRequestFixture();
        const head = sameRepoPullRequest(fx, 7, 'feat/login');
        git(fx.origin, 'update-ref', '-d', 'refs/heads/feat/login');
        const result = await performPullRequestCheckout(ops(), request(fx, { headSha: head }));
        expect(git(fx.work, 'rev-parse', 'feat/login')).toBe(head);
        expect(result.source).toBe('pull-ref');
        expect(config(fx.work, 'branch.feat/login.remote')).toBe('origin');
        expect(config(fx.work, 'branch.feat/login.merge')).toBe('refs/pull/7/head');
        expect(result.warnings).toEqual([expect.stringContaining("head branch 'feat/login' no longer exists on origin") as unknown as string]);
    });

    it('a fork whose maintainers may push: fetched from refs/pull, pushing to the fork like gh pr checkout', async () => {
        const fx = pullRequestFixture();
        const head = forkPullRequest(fx, 8, 'fix');
        const pushURL = 'git@github.com:octo/api.git';
        const result = await performPullRequestCheckout(
            ops(),
            request(fx, { number: 8, headRef: 'fix', branchName: 'fix', headSha: head, crossRepository: true, headRepo: 'octo/api', headPushURL: pushURL })
        );
        expect(result).toEqual({ warnings: [], branchExisted: false, source: 'pull-ref' });
        expect(git(path.join(fx.root, 'wt', 'fix'), 'rev-parse', 'HEAD')).toBe(head);
        // gh: remote = pushRemote = the fork's URL, merge = refs/heads/<head>.
        expect(config(fx.work, 'branch.fix.remote')).toBe(pushURL);
        expect(config(fx.work, 'branch.fix.pushRemote')).toBe(pushURL);
        expect(config(fx.work, 'branch.fix.merge')).toBe('refs/heads/fix');
        // No named remote was added.
        expect(git(fx.work, 'remote')).toBe('origin');
    });

    it('a fork without maintainer edits: pulls refs/pull/<n>/head from the base, and says it cannot push', async () => {
        const fx = pullRequestFixture();
        const head = forkPullRequest(fx, 8, 'fix');
        const result = await performPullRequestCheckout(
            ops(),
            request(fx, { number: 8, headRef: 'fix', branchName: 'fix', headSha: head, crossRepository: true, maintainerCanModify: false, headRepo: 'octo/api' })
        );
        expect(config(fx.work, 'branch.fix.remote')).toBe('origin');
        expect(config(fx.work, 'branch.fix.pushRemote')).toBe('origin');
        expect(config(fx.work, 'branch.fix.merge')).toBe('refs/pull/8/head');
        expect(result.warnings).toEqual([expect.stringContaining('does not let maintainers push') as unknown as string]);
    });

    it('a fork with a remote of its own: fetched from that remote and tracking it', async () => {
        const fx = pullRequestFixture();
        const head = forkPullRequest(fx, 8, 'fix');
        git(fx.work, 'remote', 'add', 'octo', fx.fork);
        const result = await performPullRequestCheckout(
            ops(),
            request(fx, { number: 8, headRef: 'fix', branchName: 'fix', headSha: head, crossRepository: true, headRepo: 'octo/api', headRemote: 'octo' })
        );
        expect(result.source).toBe('head-branch');
        expect(git(fx.work, 'rev-parse', 'fix')).toBe(head);
        expect(config(fx.work, 'branch.fix.remote')).toBe('octo');
        expect(config(fx.work, 'branch.fix.merge')).toBe('refs/heads/fix');
    });

    it("never rewrites an existing branch's configuration, and a force-pushed fork is a clear error", async () => {
        const fx = pullRequestFixture();
        const first = forkPullRequest(fx, 8, 'fix');
        git(fx.work, 'fetch', '-q', 'origin', `refs/pull/8/head:refs/heads/fix`);
        git(fx.work, 'config', 'branch.fix.remote', 'origin');
        git(fx.work, 'config', 'branch.fix.merge', 'refs/pull/8/head');
        git(fx.work, 'config', 'branch.fix.pushRemote', 'somewhere-else');
        // A fast-forward of the existing branch works and keeps the config.
        git(fx.seed, 'checkout', '-q', 'fork-fix');
        const next = commit(fx.seed, 'next.txt', 'next\n', 'next');
        git(fx.seed, 'push', '-q', 'fork', 'fork-fix:refs/heads/fix');
        git(fx.origin, 'fetch', '-q', fx.fork, '+refs/heads/fix:refs/pull/8/head');
        git(fx.seed, 'checkout', '-q', 'main');
        const pr = { number: 8, headRef: 'fix', branchName: 'fix', crossRepository: true, headRepo: 'octo/api', headPushURL: 'git@github.com:octo/api.git' };
        await performPullRequestCheckout(ops(), request(fx, { ...pr, headSha: next }));
        expect(git(fx.work, 'rev-parse', 'fix')).toBe(next);
        expect(config(fx.work, 'branch.fix.pushRemote')).toBe('somewhere-else');
        expect(config(fx.work, 'branch.fix.merge')).toBe('refs/pull/8/head');
        expect(first).not.toBe(next);

        // The fork is force-pushed: the fetch into the existing branch is not forced.
        git(fx.work, 'worktree', 'remove', '--force', path.join(fx.root, 'wt', 'fix'));
        const rewritten = forkPullRequest(fx, 8, 'fix');
        const failure = performPullRequestCheckout(ops(), request(fx, { ...pr, headSha: rewritten, worktreePath: path.join(fx.root, 'wt', 'fix-2') }));
        await expect(failure).rejects.toBeInstanceOf(PullRequestCheckoutError);
        await expect(failure).rejects.toThrow(/could not bring local branch 'fix' up to pull request #8's head/);
        expect(git(fx.work, 'rev-parse', 'fix')).toBe(next);
    });

    it('a branch checked out elsewhere is an error naming the path, before any fetch', async () => {
        const fx = pullRequestFixture();
        const head = sameRepoPullRequest(fx, 7, 'feat/login');
        git(fx.work, 'fetch', '-q', 'origin');
        git(fx.work, 'checkout', '-q', '--track', 'origin/feat/login');
        const before = tryGit(fx.work, 'rev-parse', 'refs/remotes/origin/feat/login');
        git(fx.seed, 'checkout', '-q', 'feat/login');
        commit(fx.seed, 'later.txt', 'later\n', 'later');
        git(fx.seed, 'push', '-q', 'origin', 'feat/login');
        git(fx.seed, 'checkout', '-q', 'main');
        await expect(performPullRequestCheckout(ops(), request(fx, { headSha: head }))).rejects.toThrow(
            `branch 'feat/login' is already checked out at '${fx.work}'`
        );
        expect(tryGit(fx.work, 'rev-parse', 'refs/remotes/origin/feat/login')).toBe(before);
    });

    it('a local branch of that name that is not this pull request is refused', async () => {
        const fx = pullRequestFixture();
        const head = forkPullRequest(fx, 8, 'fix');
        git(fx.work, 'branch', 'fix');
        await expect(
            performPullRequestCheckout(ops(), request(fx, { number: 8, headRef: 'fix', branchName: 'fix', headSha: head, crossRepository: true, headRepo: 'octo/api' }))
        ).rejects.toThrow("a local branch 'fix' already exists and does not track pull request #8");
    });

    it('never falls back to a branch off HEAD when the head cannot be fetched', async () => {
        const fx = pullRequestFixture();
        const head = sameRepoPullRequest(fx, 7, 'feat/login');
        git(fx.origin, 'update-ref', '-d', 'refs/heads/feat/login');
        git(fx.origin, 'update-ref', '-d', 'refs/pull/7/head');
        const branchesBefore = git(fx.work, 'branch', '--list');
        await expect(performPullRequestCheckout(ops(), request(fx, { headSha: head }))).rejects.toThrow();
        expect(git(fx.work, 'branch', '--list')).toBe(branchesBefore);
        expect(fs.existsSync(path.join(fx.root, 'wt', 'feat-login'))).toBe(false);
    });

    it('refuses unusable head refs, branch names and remotes before running any fetch', async () => {
        const fx = pullRequestFixture();
        const head = sameRepoPullRequest(fx, 7, 'feat/login');
        const fetches: string[][] = [];
        const real = ops();
        const watching: WorktreeGitOps = {
            read: real.read,
            long: (args, cwd, options) => {
                if (args[0] === 'fetch') fetches.push([...args]);
                return real.long(args, cwd, options);
            }
        };
        for (const headRef of ['-x', 'a..b', 'foo bar', '@{-1}', 'x.lock', 'refs/../x', 'a‮b']) {
            await expect(performPullRequestCheckout(watching, request(fx, { headSha: head, headRef, branchName: 'ok' }))).rejects.toThrow(
                "pull request #7's head branch is not a branch name Kelpi can check out"
            );
        }
        await expect(performPullRequestCheckout(watching, request(fx, { headSha: head, branchName: '--force' }))).rejects.toThrow("isn't a usable branch name");
        await expect(performPullRequestCheckout(watching, request(fx, { headSha: head, baseRemote: '--upload-pack=x' }))).rejects.toThrow('has no remote named');
        await expect(performPullRequestCheckout(watching, request(fx, { headSha: 'nope' }))).rejects.toThrow('has no usable head commit');
        expect(fetches).toEqual([]);
    });

    it('a cancel during the fetch leaves nothing; a cancel during the checkout removes the worktree and the branch it fetched', async () => {
        const fx = pullRequestFixture();
        const head = forkPullRequest(fx, 8, 'fix');
        const pr = { number: 8, headRef: 'fix', branchName: 'fix', headSha: head, crossRepository: true, headRepo: 'octo/api' };

        const fetchMarker = path.join(fx.root, 'fetch-started');
        const wrapper = path.join(fx.root, 'slow-upload-pack.sh');
        fs.writeFileSync(wrapper, `#!/bin/sh\ntouch '${fetchMarker}'\nsleep 20\nexec git-upload-pack "$@"\n`, { mode: 0o755 });
        git(fx.work, 'config', 'remote.origin.uploadpack', wrapper);
        const first = new AbortController();
        const steps = tracker();
        const pending = performPullRequestCheckout(ops(), request(fx, pr), { signal: first.signal, steps });
        await waitFor(() => fs.existsSync(fetchMarker));
        first.abort();
        await expect(pending).rejects.toBeInstanceOf(WorktreeCreateCancelledError);
        expect(tryGit(fx.work, 'rev-parse', '--verify', '--quiet', 'refs/heads/fix')).toBeNull();
        expect(steps.snapshot()).toMatchObject({ cancelled: true });
        expect(steps.snapshot().steps.find((step) => step.id === 'fetch')).toMatchObject({ status: 'failed', error: 'cancelled' });
        git(fx.work, 'config', '--unset', 'remote.origin.uploadpack');

        const checkoutMarker = path.join(fx.root, 'checkout-started');
        fs.writeFileSync(path.join(fx.work, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch '${checkoutMarker}'\nsleep 20\n`, { mode: 0o755 });
        const second = new AbortController();
        const during = performPullRequestCheckout(ops(), request(fx, pr), { signal: second.signal });
        await waitFor(() => fs.existsSync(checkoutMarker));
        expect(tryGit(fx.work, 'rev-parse', '--verify', '--quiet', 'refs/heads/fix')).toBe(head);
        second.abort();
        await expect(during).rejects.toBeInstanceOf(WorktreeCreateCancelledError);
        expect(tryGit(fx.work, 'rev-parse', '--verify', '--quiet', 'refs/heads/fix')).toBeNull();
        expect(fs.existsSync(path.join(fx.root, 'wt', 'fix'))).toBe(false);
        expect(git(fx.work, 'worktree', 'list', '--porcelain')).not.toContain('/wt/fix');
    });

    it('lists remotes with their URLs, and none for a repository without', async () => {
        const fx = pullRequestFixture();
        git(fx.work, 'remote', 'add', 'my.fork', 'git@github.com:me/api.git');
        expect(await listRemotes(ops(), fx.work)).toEqual([
            { name: 'origin', url: fx.origin },
            { name: 'my.fork', url: 'git@github.com:me/api.git' }
        ]);
        git(fx.work, 'remote', 'remove', 'origin');
        git(fx.work, 'remote', 'remove', 'my.fork');
        expect(await listRemotes(ops(), fx.work)).toEqual([]);
    });
});
