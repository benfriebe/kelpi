import { describe, expect, it } from 'vitest';

import { serializeTicketDefaults, ticketCreateDefaults, type TicketDefaultsInput } from './defaults.js';
import { NO_LOCAL_BRANCHES, type LocalBranchFact } from './names.js';

const ISSUE: TicketDefaultsInput = {
    kind: 'issue',
    number: 418,
    key: '#418',
    title: 'Retry login on 401',
    url: 'https://github.com/acme/api/issues/418',
    repo: 'acme/api',
    author: 'octocat',
    labels: [],
    repoID: 'R1',
    pullRequest: null,
    localBranch: NO_LOCAL_BRANCHES
};

const PR: TicketDefaultsInput = {
    ...ISSUE,
    kind: 'pr',
    url: 'https://github.com/acme/api/pull/418',
    pullRequest: { headRef: 'fix/login', headOwner: 'octocat', baseRef: 'main', baseDefaultBranch: 'main' }
};

const lookup = (table: Readonly<Record<string, LocalBranchFact>>) => (name: string): LocalBranchFact => table[name] ?? { exists: false };

describe('ticketCreateDefaults', () => {
    it('gives a new issue a new branch off the fetched default branch', () => {
        expect(ticketCreateDefaults(ISSUE)).toEqual({
            name: '#418 Retry login on 401',
            repoID: 'R1',
            worktree: '418-retry-login-on-401',
            branch: '418-retry-login-on-401',
            checkout: 'new-branch',
            updateMain: true,
            prompt: 'Work on issue #418: Retry login on 401 (https://github.com/acme/api/issues/418). Read @.kelpi/ticket-418.md first, it has the full issue.',
            promptVariant: 'ticket-file',
            checkedOutAt: null,
            warnings: []
        });
    });

    it('attaches an issue branch that already exists, with update main off', () => {
        const defaults = ticketCreateDefaults({
            ...ISSUE,
            localBranch: lookup({ '418-retry-login-on-401': { exists: true, tracksPullRequest: false, checkedOutAt: null } })
        });
        expect(defaults).toMatchObject({ checkout: 'attach-branch', updateMain: false, worktree: '418-retry-login-on-401' });
    });

    it("takes another branch name for a pull request whose head's is held by a folder-gone worktree, and says why", () => {
        const stale = { exists: true, tracksPullRequest: true, checkedOutAt: null, staleCheckoutAt: '/wt/fix-login' } as const;
        const defaults = ticketCreateDefaults({ ...PR, localBranch: lookup({ 'fix/login': stale }) });
        expect(defaults).toMatchObject({ checkout: 'pr-head', branch: 'octocat/fix/login', checkedOutAt: null });
        expect(defaults.warnings).toEqual([
            'branch "fix/login" is still held by a worktree whose folder is gone (/wt/fix-login): run `git worktree prune` in the repository to free it; using "octocat/fix/login" instead'
        ]);
    });

    it("warns that an issue's branch held by a folder-gone worktree must be pruned, and never opens there", () => {
        const stale = { exists: true, tracksPullRequest: false, checkedOutAt: null, staleCheckoutAt: '/wt/418' } as const;
        const defaults = ticketCreateDefaults({ ...ISSUE, localBranch: lookup({ '418-retry-login-on-401': stale }) });
        expect(defaults).toMatchObject({ checkout: 'attach-branch', checkedOutAt: null });
        expect(defaults.warnings).toEqual(['branch "418-retry-login-on-401" is still held by a worktree whose folder is gone (/wt/418): run `git worktree prune` in the repository to free it']);
    });

    it('opens at the checkout that already has the branch, with no worktree', () => {
        const fact = { exists: true, tracksPullRequest: false, checkedOutAt: '/Users/ben/code/api' } as const;
        expect(ticketCreateDefaults({ ...ISSUE, localBranch: lookup({ '418-retry-login-on-401': fact }) })).toMatchObject({
            checkout: 'existing-checkout',
            worktree: null,
            updateMain: false,
            checkedOutAt: '/Users/ben/code/api'
        });
        const tracked = { exists: true, tracksPullRequest: true, checkedOutAt: '/Users/ben/code/api' } as const;
        expect(ticketCreateDefaults({ ...PR, localBranch: lookup({ 'fix/login': tracked }) })).toMatchObject({
            checkout: 'existing-checkout',
            branch: 'fix/login',
            worktree: null,
            checkedOutAt: '/Users/ben/code/api'
        });
    });

    it("checks a pull request out on its head's own name, in a folder named after it", () => {
        expect(ticketCreateDefaults(PR)).toMatchObject({
            name: '#418 Retry login on 401',
            branch: 'fix/login',
            worktree: 'fix-login',
            checkout: 'pr-head',
            updateMain: false,
            prompt: 'Pick up pull request #418: Retry login on 401 (https://github.com/acme/api/pull/418) on branch fix/login. Read @.kelpi/ticket-418.md first, it has the description and recent review comments.'
        });
        expect(
            ticketCreateDefaults({ ...PR, pullRequest: { headRef: 'main', headOwner: 'octocat', baseRef: 'main', baseDefaultBranch: 'main' } })
        ).toMatchObject({ branch: 'octocat/main', worktree: 'octocat-main' });
    });

    it('warns, and proposes no branch or worktree, for a head it cannot check out', () => {
        const defaults = ticketCreateDefaults({
            ...PR,
            pullRequest: { headRef: '--upload-pack=x', headOwner: 'octocat', baseRef: 'main', baseDefaultBranch: 'main' }
        });
        expect(defaults).toMatchObject({ branch: null, worktree: null, checkout: 'pr-head' });
        expect(defaults.warnings).toHaveLength(1);
        expect(ticketCreateDefaults({ ...PR, pullRequest: null }).warnings).toEqual(['pull request #418 has no head branch']);
    });

    it('serializes to the wire form ticket-resolve answers with', () => {
        expect(serializeTicketDefaults(ticketCreateDefaults(PR))).toEqual({
            name: '#418 Retry login on 401',
            repo_id: 'R1',
            worktree: 'fix-login',
            branch: 'fix/login',
            checkout: 'pr-head',
            update_main: false,
            prompt: expect.stringContaining('@.kelpi/ticket-418.md first'),
            prompt_variant: 'ticket-file'
        });
    });
});
