/**
 * `matching.ts` (docs/integrations.md §9.6) on hand-made facts: the resolve's branch lookup applies
 * `@kelpi/core/tickets`' one rule with the remotes the match found, and a fork's push URL comes
 * from the base remote's URLs as git uses them or as written.
 */

import { describe, expect, it } from 'vitest';

import type { BranchConfigFact, BranchFacts, RemoteFact } from '../git/repo-facts.js';
import { forkPushURL, headRemoteFor, localBranchLookup, type BranchLookupTarget } from './matching.js';

function remote(name: string, fetchURL: string, extra: Partial<RemoteFact> = {}): RemoteFact {
    const configuredFetchURL = extra.configuredFetchURL ?? null;
    return {
        name,
        fetchURL,
        pushURL: extra.pushURL ?? fetchURL,
        configuredFetchURL,
        configuredPushURL: extra.configuredPushURL ?? null,
        fetchURLs: configuredFetchURL !== null && configuredFetchURL !== fetchURL ? [fetchURL, configuredFetchURL] : [fetchURL]
    };
}

function branches(config: Record<string, Partial<BranchConfigFact>>, checkedOut: Record<string, string> = {}): BranchFacts {
    const map = new Map<string, BranchConfigFact>();
    for (const [name, value] of Object.entries(config)) map.set(name, { remote: null, merge: null, pushRemote: null, ...value });
    return { branches: map, worktrees: [], checkedOutAt: (name) => checkedOut[name] ?? null };
}

const SAME: BranchLookupTarget = {
    kind: 'pr',
    number: 7,
    repo: 'acme/api',
    headRef: 'feat/login',
    headRepo: 'acme/api',
    crossRepository: false,
    baseRemote: 'origin',
    headRemote: null,
    headPushURL: null
};

describe('localBranchLookup', () => {
    it('calls a branch tracking any remote of the base repository the pull request\'s, and one tracking another repository not', () => {
        const remotes = [
            remote('origin', 'https://github.com/acme/api.git'),
            // An insteadOf alias: only its rewritten URL names GitHub.
            remote('mirror', 'git@github.com:acme/api', { configuredFetchURL: 'gh:acme/api' }),
            remote('other', 'https://github.com/other/api.git')
        ];
        const lookup = localBranchLookup(
            branches(
                {
                    'feat/login': { remote: 'mirror', merge: 'refs/heads/feat/login' },
                    'pr-7': { remote: 'origin', merge: 'refs/pull/7/head' },
                    'acme/feat/login': { remote: 'other', merge: 'refs/heads/feat/login' },
                    mine: {}
                },
                { 'feat/login': '/code/api' }
            ),
            remotes,
            SAME
        );
        expect(lookup('feat/login')).toEqual({ exists: true, tracksPullRequest: true, checkedOutAt: '/code/api' });
        expect(lookup('pr-7')).toEqual({ exists: true, tracksPullRequest: true, checkedOutAt: null });
        expect(lookup('acme/feat/login')).toEqual({ exists: true, tracksPullRequest: false, checkedOutAt: null });
        // No upstream at all: the author's own branch of a same-repository pull request.
        expect(lookup('mine')).toEqual({ exists: true, tracksPullRequest: true, checkedOutAt: null });
        expect(lookup('missing')).toEqual({ exists: false });
        // An issue's branches never track anything.
        expect(localBranchLookup(branches({ x: {} }), remotes, { ...SAME, kind: 'issue' })('x')).toMatchObject({ tracksPullRequest: false });
    });

    it("takes a fork's matched remote and gh's push URL as the head repository's, even when their URLs are local paths", () => {
        const remotes = [remote('origin', '/tmp/origin.git'), remote('octo', '/tmp/fork.git')];
        const fork: BranchLookupTarget = { ...SAME, number: 8, headRef: 'fix', headRepo: 'octo/api', crossRepository: true };
        const viaRemote = localBranchLookup(branches({ fix: { remote: 'octo', merge: 'refs/heads/fix' } }), remotes, { ...fork, headRemote: 'octo' });
        expect(viaRemote('fix')).toMatchObject({ tracksPullRequest: true });
        const viaURL = localBranchLookup(branches({ fix: { remote: 'git@github.com-work:octo/api.git', merge: 'refs/heads/fix' } }), remotes, {
            ...fork,
            headPushURL: 'git@github.com-work:octo/api.git'
        });
        expect(viaURL('fix')).toMatchObject({ tracksPullRequest: true });
        expect(localBranchLookup(branches({ fix: { remote: 'origin', merge: 'refs/heads/fix' } }), remotes, fork)('fix')).toMatchObject({ tracksPullRequest: false });
    });
});

describe('headRemoteFor and forkPushURL', () => {
    const pr = { crossRepository: true, headRepo: 'octo/api', maintainerCanModify: true };

    it('prefers a remote that fetches from the fork (origin first), through an alias too', () => {
        const remotes = [remote('upstream', 'https://github.com/acme/api.git'), remote('fork', 'git@github.com:octo/api', { configuredFetchURL: 'gh:octo/api' })];
        expect(headRemoteFor(pr, remotes, remotes[0] ?? null)).toEqual({ headRemote: 'fork', headPushURL: null });
    });

    it("else swaps owner/name in the base remote's push URL, then its fetch URL, as git uses them or as written", () => {
        const base = remote('origin', 'https://github.com/acme/api.git', { pushURL: 'git@github.com-work:acme/api.git' });
        expect(headRemoteFor(pr, [base], base)).toEqual({ headRemote: null, headPushURL: 'git@github.com-work:octo/api.git' });
        // A GitHub URL rewritten onto a mirror: only the spelling as written can be swapped.
        const mirrored = remote('origin', '/srv/mirror/api.git', { configuredFetchURL: 'https://github.com/acme/api.git' });
        expect(forkPushURL(mirrored, 'octo', 'api')).toBe('https://github.com/octo/api.git');
        expect(forkPushURL(remote('origin', '/srv/mirror/api.git'), 'octo', 'api')).toBeNull();
        expect(headRemoteFor({ ...pr, maintainerCanModify: false }, [base], base)).toEqual({ headRemote: null, headPushURL: null });
        expect(headRemoteFor({ ...pr, crossRepository: false }, [base], base)).toEqual({ headRemote: null, headPushURL: null });
    });
});
