import { describe, expect, it } from 'vitest';

import {
    gitHubOwnersFromRemotes,
    gitHubTicketKey,
    gitHubTicketURL,
    isGitHubOwner,
    isGitHubRepoName,
    parseGitHubRemote,
    parseTicketRef,
    registryRemoteURL,
    replaceGitHubRemoteRepo,
    sameGitHubRepo,
    ticketIdentity
} from './refs.js';

describe('parseTicketRef', () => {
    it('reads issue and pull request pages in every spelling people paste', () => {
        const pr = { provider: 'github', owner: 'acme', name: 'api', repo: 'acme/api', number: 418, kind: 'pr' };
        for (const ref of [
            'https://github.com/acme/api/pull/418',
            'https://github.com/acme/api/pull/418/',
            'https://github.com/acme/api/pull/418/files',
            'https://github.com/acme/api/pull/418/files/abc123..def456',
            'https://github.com/acme/api/pull/418/commits/abc123',
            'https://github.com/acme/api/pull/418/checks?check_run_id=1',
            'https://github.com/acme/api/pull/418#issuecomment-123',
            'https://github.com/acme/api/pull/418?notification_referrer_id=x',
            'http://github.com/acme/api/pull/418',
            'https://www.github.com/acme/api/pull/418',
            'github.com/acme/api/pull/418',
            '  https://GitHub.com/acme/api/pull/418  '
        ]) {
            expect(parseTicketRef(ref), ref).toEqual(pr);
        }
        const issue = { ...pr, kind: 'issue' };
        for (const ref of [
            'https://github.com/acme/api/issues/418',
            'https://github.com/acme/api/issues/418/',
            'https://github.com/acme/api/issues/418#issuecomment-9',
            'github.com/acme/api/issues/418?q=1'
        ]) {
            expect(parseTicketRef(ref), ref).toEqual(issue);
        }
    });

    it('reads owner/name#n with no kind (GitHub numbers issues and pull requests together)', () => {
        expect(parseTicketRef('acme/api#7')).toEqual({ provider: 'github', owner: 'acme', name: 'api', repo: 'acme/api', number: 7, kind: null });
        expect(parseTicketRef('Acme-Co/.github#12')?.repo).toBe('Acme-Co/.github');
        expect(parseTicketRef('octo_emu/my.repo#1')?.repo).toBe('octo_emu/my.repo');
    });

    it('refuses anything else', () => {
        for (const ref of [
            '',
            '#418',
            '418',
            'acme/api',
            'acme/api#0',
            'acme/api#007',
            'acme/api#99999999999',
            'acme/api#1 extra',
            '-acme/api#1',
            'acme/-x#1',
            'acme/..#1',
            'acme/a/b#1',
            'https://gitlab.com/acme/api/issues/1',
            'https://github.com.evil.example/acme/api/pull/1',
            'https://token@github.com/acme/api/pull/1',
            'https://github.com:8443/acme/api/pull/1',
            'https://github.com/acme/api/pulls/1',
            'https://github.com/acme/api/pull/1/frobnicate',
            'https://github.com/acme/api/issues/1/edit',
            'https://github.com/acme/api/discussions/1',
            'https://github.com/acme/api',
            'ftp://github.com/acme/api/pull/1',
            'https://github.com/ac%20me/api/pull/1',
            'x'.repeat(5000)
        ]) {
            expect(parseTicketRef(ref), ref).toBeNull();
        }
    });
});

describe('parseGitHubRemote', () => {
    it('reads scp-like, ssh:// and https:// remotes, with and without .git', () => {
        const table: readonly (readonly [string, string, string, 'ssh' | 'https'])[] = [
            ['git@github.com:acme/api.git', 'acme/api', 'github.com', 'ssh'],
            ['git@github.com:acme/api', 'acme/api', 'github.com', 'ssh'],
            ['git@github.com:/acme/api.git/', 'acme/api', 'github.com', 'ssh'],
            ['github.com:acme/api.git', 'acme/api', 'github.com', 'ssh'],
            ['org-123@github.com:acme/api.git', 'acme/api', 'github.com', 'ssh'],
            ['git@github.com-work:acme/api.git', 'acme/api', 'github.com-work', 'ssh'],
            ['git@GitHub.com:acme/api.git', 'acme/api', 'GitHub.com', 'ssh'],
            ['ssh://git@github.com/acme/api.git', 'acme/api', 'github.com', 'ssh'],
            ['ssh://git@github.com:22/acme/api', 'acme/api', 'github.com', 'ssh'],
            ['ssh://git@ssh.github.com:443/acme/api.git', 'acme/api', 'ssh.github.com', 'ssh'],
            ['git+ssh://git@github.com-personal/acme/api.git', 'acme/api', 'github.com-personal', 'ssh'],
            ['https://github.com/acme/api.git', 'acme/api', 'github.com', 'https'],
            ['https://github.com/acme/api', 'acme/api', 'github.com', 'https'],
            ['https://github.com/acme/api/', 'acme/api', 'github.com', 'https'],
            ['https://ben@github.com/acme/api.git', 'acme/api', 'github.com', 'https'],
            ['https://x-access-token:ghp_secret@github.com/acme/api.git', 'acme/api', 'github.com', 'https'],
            ['http://www.github.com/acme/my.repo.git', 'acme/my.repo', 'www.github.com', 'https']
        ];
        for (const [url, repo, host, protocol] of table) {
            const remote = parseGitHubRemote(url);
            expect(remote, url).toMatchObject({ repo, host, protocol });
            expect(JSON.stringify(remote)).not.toContain('secret');
        }
    });

    it('refuses other hosts, local paths and names GitHub would not have', () => {
        for (const url of [
            'git@gitlab.com:acme/api.git',
            'https://gitlab.com/acme/api.git',
            'https://github.com-work/acme/api.git',
            'git@github.company.com:acme/api.git',
            '/Users/ben/code/api',
            'C:/code/api',
            'file:///Users/ben/code/api.git',
            'https://github.com/acme/api/tree/main',
            'git@github.com:-acme/api.git',
            'git@github.com:acme/...git',
            'git@github.com:acme',
            ''
        ]) {
            expect(parseGitHubRemote(url), url).toBeNull();
        }
    });
});

describe('registryRemoteURL', () => {
    it('keeps the URL git uses, unless only the one as written names GitHub', () => {
        // insteadOf rewrites a GitHub URL onto a mirror: only the spelling as written names GitHub.
        expect(registryRemoteURL('/srv/mirror/api.git', 'https://github.com/acme/api.git')).toBe('https://github.com/acme/api.git');
        // An alias that names GitHub once rewritten: the URL git uses.
        expect(registryRemoteURL('git@github.com:acme/api', 'gh:acme/api')).toBe('git@github.com:acme/api');
        // Neither, or nothing written: the URL git uses, as main stored it.
        expect(registryRemoteURL('https://gitlab.com/acme/api.git', 'https://gitlab.com/acme/api.git')).toBe('https://gitlab.com/acme/api.git');
        expect(registryRemoteURL('/srv/git/api.git', null)).toBe('/srv/git/api.git');
        expect(registryRemoteURL('https://github.com/acme/api.git', 'https://github.com/acme/api.git')).toBe('https://github.com/acme/api.git');
    });
});

describe('replaceGitHubRemoteRepo', () => {
    it('swaps only owner/name, so the scheme, user, alias and .git carry over', () => {
        expect(replaceGitHubRemoteRepo('git@github.com-work:acme/api.git', 'octocat', 'api')).toBe('git@github.com-work:octocat/api.git');
        expect(replaceGitHubRemoteRepo('https://github.com/acme/api', 'octocat', 'api-fork')).toBe('https://github.com/octocat/api-fork');
        expect(replaceGitHubRemoteRepo('ssh://git@github.com:22/acme/api.git/', 'o', 'r')).toBe('ssh://git@github.com:22/o/r.git/');
    });

    it('refuses a remote that is not GitHub, or names that are not valid', () => {
        expect(replaceGitHubRemoteRepo('git@gitlab.com:acme/api.git', 'o', 'r')).toBeNull();
        expect(replaceGitHubRemoteRepo('git@github.com:acme/api.git', '-o', 'r')).toBeNull();
        expect(replaceGitHubRemoteRepo('git@github.com:acme/api.git', 'o', '../r')).toBeNull();
    });
});

describe('names and identities', () => {
    it('validates owners and repository names by their charset', () => {
        expect(isGitHubOwner('octocat')).toBe(true);
        expect(isGitHubOwner('Acme-Co')).toBe(true);
        expect(isGitHubOwner('octo_emu')).toBe(true);
        expect(isGitHubOwner('-x')).toBe(false);
        expect(isGitHubOwner('a'.repeat(40))).toBe(false);
        expect(isGitHubOwner('a/b')).toBe(false);
        expect(isGitHubRepoName('.github')).toBe(true);
        expect(isGitHubRepoName('my.repo_x-1')).toBe(true);
        expect(isGitHubRepoName('.')).toBe(false);
        expect(isGitHubRepoName('..')).toBe(false);
        expect(isGitHubRepoName('-x')).toBe(false);
        expect(isGitHubRepoName('a b')).toBe(false);
    });

    it('keys, URLs and identities', () => {
        expect(gitHubTicketKey(418)).toBe('#418');
        expect(gitHubTicketURL('acme/api', 'pr', 418)).toBe('https://github.com/acme/api/pull/418');
        expect(gitHubTicketURL('acme/api', 'issue', 7)).toBe('https://github.com/acme/api/issues/7');
        expect(ticketIdentity({ provider: 'github', repo: 'Acme/API', number: 418, key: '#418' })).toBe('github:acme/api#418');
        expect(ticketIdentity({ provider: 'linear', repo: '', number: null, key: 'eng-123' })).toBe('linear:ENG-123');
        expect(sameGitHubRepo('Acme/API', 'acme/api')).toBe(true);
    });

    it('collects the distinct owners of a set of remotes', () => {
        expect(
            gitHubOwnersFromRemotes([
                'git@github.com:Acme/api.git',
                null,
                'https://github.com/acme/web',
                'git@github.com-work:octocat/dotfiles.git',
                'git@gitlab.com:other/x.git',
                undefined
            ])
        ).toEqual(['acme', 'octocat']);
    });
});
