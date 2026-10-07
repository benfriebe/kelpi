import { describe, expect, it } from 'vitest';

import {
    NO_LOCAL_BRANCHES,
    TICKET_SLUG_MAX_LENGTH,
    isSafeBranchName,
    issueBranchName,
    prLocalBranchName,
    prWorktreeName,
    ticketSlug,
    ticketWorkspaceName,
    ticketWorktreeName,
    type LocalBranchFact,
    type LocalBranchLookup
} from './names.js';

describe('ticketSlug and issueBranchName', () => {
    it('slugs a title to ASCII lowercase words', () => {
        expect(ticketSlug('Retry login on 401')).toBe('retry-login-on-401');
        expect(ticketSlug('  [API] Retry login: on 401!!  ')).toBe('api-retry-login-on-401');
        expect(ticketSlug('Café crashes in Straße and Ørsted')).toBe('cafe-crashes-in-strasse-and-orsted');
        expect(ticketSlug('v2.0_release/notes')).toBe('v2-0-release-notes');
    });

    it('is at most 40 characters, cut at a hyphen when one fits', () => {
        const slug = ticketSlug('Retry the login request when the session token expires during upload');
        expect(slug).toBe('retry-the-login-request-when-the-session');
        expect(slug.length).toBeLessThanOrEqual(TICKET_SLUG_MAX_LENGTH);
        // Exactly on a word boundary.
        expect(ticketSlug(`${'a'.repeat(40)} tail`)).toBe('a'.repeat(40));
        // One word longer than the limit is cut where it hits it.
        expect(ticketSlug('x'.repeat(60))).toBe('x'.repeat(40));
        expect(ticketSlug(`ab ${'c'.repeat(60)}`)).toBe('ab');
    });

    it('drops invisible characters before slugging, and gives nothing for an emoji or non-Latin title', () => {
        expect(ticketSlug('fix\u202e\u200blogin')).toBe('fixlogin');
        expect(ticketSlug('🚀✨')).toBe('');
        expect(ticketSlug('修复登录')).toBe('');
        expect(issueBranchName(418, 'Retry login on 401')).toBe('418-retry-login-on-401');
        expect(issueBranchName(418, '🚀✨')).toBe('418');
        expect(issueBranchName(418, '')).toBe('418');
    });
});

describe('ticketWorkspaceName', () => {
    it('is the key, then the title as one cleaned line', () => {
        expect(ticketWorkspaceName({ key: '#418', title: 'Retry login on 401' })).toBe('#418 Retry login on 401');
        expect(ticketWorkspaceName({ key: '#418', title: ' Retry\nlogin\u202e ' })).toBe('#418 Retry login');
        expect(ticketWorkspaceName({ key: '#418', title: '   ' })).toBe('#418');
        expect(ticketWorkspaceName({ key: '#1', title: 'x'.repeat(500) }).length).toBeLessThanOrEqual(3 + 200);
    });
});

describe('isSafeBranchName', () => {
    it("takes a pull request head's own spelling", () => {
        for (const name of ['fix/login', 'feat+x', 'fix#12', 'día', 'user@fix', 'release-1.2', 'a/b/c']) {
            expect(isSafeBranchName(name), name).toBe(true);
        }
    });

    it('refuses what git refuses, an option-like name, and invisible characters', () => {
        for (const name of [
            '',
            '@',
            '-rf',
            '/x',
            'x/',
            'x.',
            'a..b',
            'a@{1}',
            'a//b',
            'a b',
            'a~1',
            'a^',
            'a:b',
            'a?',
            'a*',
            'a[b',
            'a\\b',
            'a\u0007b',
            'a\u007fb',
            '.hidden',
            'a/.b',
            'x.lock',
            'a/b.lock/c',
            'fix\u202elogin',
            'fix\u200blogin',
            'x'.repeat(201)
        ]) {
            expect(isSafeBranchName(name), JSON.stringify(name)).toBe(false);
        }
    });
});

const facts = (table: Readonly<Record<string, LocalBranchFact>>): LocalBranchLookup => (name) => table[name] ?? { exists: false };

describe('prLocalBranchName (integrations.md §4)', () => {
    const base = { number: 418, headRef: 'fix/login', headOwner: 'octocat', baseDefaultBranch: 'main', localBranch: NO_LOCAL_BRANCHES };

    it("uses the head's own name when it is free", () => {
        expect(prLocalBranchName(base)).toEqual({ ok: true, branch: 'fix/login', fact: { exists: false } });
    });

    it('reuses a local branch that already tracks this pull request', () => {
        const fact = { exists: true, tracksPullRequest: true, checkedOutAt: null } as const;
        expect(prLocalBranchName({ ...base, localBranch: facts({ 'fix/login': fact }) })).toEqual({ ok: true, branch: 'fix/login', fact });
    });

    it("falls back to <owner>/<head> for a fork's default branch and for an unrelated local branch", () => {
        expect(prLocalBranchName({ ...base, headRef: 'main' })).toMatchObject({ ok: true, branch: 'octocat/main' });
        const other = { exists: true, tracksPullRequest: false, checkedOutAt: null } as const;
        expect(prLocalBranchName({ ...base, localBranch: facts({ 'fix/login': other }) })).toMatchObject({
            ok: true,
            branch: 'octocat/fix/login'
        });
    });

    it('falls back to pr-<n> for a deleted fork, and when <owner>/<head> is taken too', () => {
        expect(prLocalBranchName({ ...base, headRef: 'main', headOwner: null })).toMatchObject({ ok: true, branch: 'pr-418' });
        const other = { exists: true, tracksPullRequest: false, checkedOutAt: null } as const;
        expect(
            prLocalBranchName({ ...base, localBranch: facts({ 'fix/login': other, 'octocat/fix/login': other }) })
        ).toMatchObject({ ok: true, branch: 'pr-418' });
        expect(
            prLocalBranchName({ ...base, localBranch: facts({ 'fix/login': other, 'octocat/fix/login': other, 'pr-418': other }) })
        ).toEqual({
            ok: false,
            error: 'local branches "fix/login", "octocat/fix/login", "pr-418" already exist and none of them tracks pull request #418: rename or delete one'
        });
    });

    it('refuses a head name git or Kelpi will not take, naming it safely', () => {
        const refused = prLocalBranchName({ ...base, headRef: '-x\u202e' });
        expect(refused.ok).toBe(false);
        expect(!refused.ok && refused.error).toBe(`pull request #418's head branch "-x" is not a branch name Kelpi can check out`);
        expect(prLocalBranchName({ ...base, headRef: 'a..b' }).ok).toBe(false);
    });

    it('names the worktree folder after the branch', () => {
        expect(prWorktreeName('octocat/main', 418)).toBe('octocat-main');
        expect(prWorktreeName('fix/login', 418)).toBe('fix-login');
        expect(prWorktreeName('día', 418)).toBe('d-a');
        expect(prWorktreeName('🚀', 418)).toBe('pr-418');
        expect(ticketWorktreeName('pr', 418, 'fix/login')).toBe('fix-login');
        expect(ticketWorktreeName('issue', 418, '418-retry-login')).toBe('418-retry-login');
    });
});
