import { describe, expect, it } from 'vitest';

import { bestRemoteFor, pullRequestUpstreamPointsAt, remoteFetchesFrom, tracksPullRequest, type PullRequestRemotes, type TicketRemote } from './tracking.js';

const remote = (name: string, ...fetchURLs: string[]): TicketRemote => ({ name, fetchURLs });

describe('bestRemoteFor', () => {
    it('prefers origin, then upstream, then git order, and matches owner/name case-insensitively', () => {
        const remotes = [
            remote('mine', 'git@github.com:me/api.git'),
            remote('mirror', 'https://github.com/acme/api.git'),
            remote('upstream', 'https://github.com/Acme/API.git'),
            remote('origin', 'git@github.com-work:acme/api.git')
        ];
        expect(bestRemoteFor(remotes, 'acme/api')).toBe(remotes[3]);
        expect(bestRemoteFor(remotes.slice(0, 3), 'acme/api')).toBe(remotes[2]);
        expect(bestRemoteFor(remotes.slice(0, 2), 'acme/api')).toBe(remotes[1]);
        expect(bestRemoteFor(remotes, 'me/api')).toBe(remotes[0]);
        expect(bestRemoteFor(remotes, 'other/api')).toBeNull();
    });

    it('counts a URL as git uses it or as written: an insteadOf alias, and a GitHub URL rewritten onto a mirror', () => {
        // `gh:acme/api` as written, `git@github.com:acme/api` once git rewrites it.
        expect(remoteFetchesFrom(remote('upstream', 'git@github.com:acme/api', 'gh:acme/api'), 'acme/api')).toBe(true);
        // A GitHub URL that `insteadOf` maps onto a mirror (or a local path).
        expect(remoteFetchesFrom(remote('origin', '/srv/mirror/api.git', 'https://github.com/acme/api.git'), 'acme/api')).toBe(true);
        expect(remoteFetchesFrom(remote('origin', 'gh:acme/api'), 'acme/api')).toBe(false);
    });
});

describe('tracksPullRequest', () => {
    const fork = { number: 8, headRef: 'fix', crossRepository: true };
    const same = { number: 7, headRef: 'feat/login', crossRepository: false };
    const remotes = [remote('origin', 'https://github.com/acme/api.git'), remote('upstream', 'git@github.com:acme/api.git'), remote('octo', 'git@github.com:octo/api.git')];
    const known: PullRequestRemotes = { baseRepo: 'acme/api', headRepo: 'octo/api', crossRepository: true, baseRemote: 'origin', headRemote: null, headPushURL: 'git@github.com-work:octo/api.git' };
    const forkPointsAt = pullRequestUpstreamPointsAt(remotes, known);
    const samePointsAt = pullRequestUpstreamPointsAt(remotes, { ...known, headRepo: 'acme/api', crossRepository: false, headPushURL: null });
    const tracks = (remoteValue: string | null, merge: string | null, pr = fork, pointsAt = forkPointsAt): boolean => tracksPullRequest({ remote: remoteValue, merge }, pr, pointsAt);

    it("reads gh's configurations as this pull request's, through any remote or URL that points at the right repository", () => {
        expect(tracks('origin', 'refs/pull/8/head')).toBe(true);
        // A second remote for the base repository, not the one the create matched: still the base.
        expect(tracks('upstream', 'refs/pull/8/head')).toBe(true);
        expect(tracks('git@github.com-work:octo/api.git', 'refs/heads/fix')).toBe(true);
        expect(tracks('https://github.com/octo/api.git', 'refs/heads/fix')).toBe(true);
        expect(tracks('octo', 'refs/heads/fix')).toBe(true);
        expect(tracks('upstream', 'refs/heads/feat/login', same, samePointsAt)).toBe(true);
        expect(tracks('origin', 'refs/heads/feat/login', same, samePointsAt)).toBe(true);
    });

    it('refuses everything else: the wrong repository, the wrong pull request, a local upstream, a fork branch with no upstream', () => {
        expect(tracks('origin', 'refs/heads/fix')).toBe(false);
        expect(tracks('octo', 'refs/pull/8/head')).toBe(false);
        expect(tracks('origin', 'refs/pull/9/head')).toBe(false);
        expect(tracks('.', 'refs/heads/fix')).toBe(false);
        expect(tracks('nowhere', 'refs/heads/fix')).toBe(false);
        expect(tracks(null, null)).toBe(false);
        expect(tracks('origin', null)).toBe(false);
        // The author's own branch of a same-repository pull request, never pushed with -u.
        expect(tracks(null, null, same, samePointsAt)).toBe(true);
    });

    it('takes the remotes the create already matched as pointing where they were matched, whatever their URLs', () => {
        // A test clone's remotes are local paths; the plan matched them by other means.
        const local = [remote('origin', '/tmp/origin.git'), remote('octo', '/tmp/fork.git')];
        const pointsAt = pullRequestUpstreamPointsAt(local, { ...known, headRemote: 'octo', headPushURL: null });
        expect(tracksPullRequest({ remote: 'origin', merge: 'refs/pull/8/head' }, fork, pointsAt)).toBe(true);
        expect(tracksPullRequest({ remote: 'octo', merge: 'refs/heads/fix' }, fork, pointsAt)).toBe(true);
        expect(tracksPullRequest({ remote: 'origin', merge: 'refs/heads/fix' }, fork, pointsAt)).toBe(false);
    });
});
