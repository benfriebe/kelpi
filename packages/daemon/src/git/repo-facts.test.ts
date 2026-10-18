/**
 * `repo-facts.ts` against real temporary repositories: remotes beyond `origin`, branch config
 * with dots and slashes in branch names, where each branch is checked out (a prunable worktree
 * excluded), the root/subfolder/linked-worktree layout, caching and cancellation. Git runs with
 * an isolated HOME and no global or system config, so nothing of the user's is read.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createGitRunner, resolveGitExecutable, type GitRunner } from './exec.js';
import { createRepoFacts, parseBranchConfig, parseRemoteConfig, parseRemoteVerbose, parseWorktreePorcelain, readBranchFacts, readRemoteFacts } from './repo-facts.js';

const GIT = resolveGitExecutable();
const roots: string[] = [];
const ISOLATED_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-facts-home-')));
roots.push(ISOLATED_HOME);
const ISOLATED_ENV: Record<string, string> = {
    HOME: ISOLATED_HOME,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'kelpi',
    GIT_AUTHOR_EMAIL: 'kelpi@example.com',
    GIT_COMMITTER_NAME: 'kelpi',
    GIT_COMMITTER_EMAIL: 'kelpi@example.com'
};

afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `kelpi-facts-${prefix}-`)));
    roots.push(dir);
    return dir;
}

function git(cwd: string, ...args: string[]): string {
    return execFileSync(GIT, args, { cwd, encoding: 'utf8', env: { ...process.env, ...ISOLATED_ENV } }).trim();
}

/** The production runner, with the same isolation every test git call has. */
function isolatedRunner(calls?: string[][]): GitRunner {
    const base = createGitRunner();
    return (args, options) => {
        calls?.push([...args]);
        return base(args, { ...options, env: { ...(options.env ?? {}), ...ISOLATED_ENV } });
    };
}

/** A repository with one commit on `main`. */
function repo(): string {
    const dir = tmpDir('repo');
    git(dir, 'init', '-q', '--initial-branch=main');
    fs.writeFileSync(path.join(dir, 'README.md'), '# app\n');
    fs.mkdirSync(path.join(dir, 'packages'));
    fs.writeFileSync(path.join(dir, 'packages', 'x.txt'), 'x\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'first');
    return dir;
}

describe('parsers', () => {
    it('reads remotes with separate push URLs, in git order', () => {
        expect(
            parseRemoteVerbose(
                [
                    'origin\tgit@github.com:me/api.git (fetch)',
                    'origin\tgit@github.com:me/api.git (push)',
                    'upstream\thttps://github.com/acme/api.git (fetch)',
                    'upstream\tgit@github.com-work:acme/api.git (push)',
                    ''
                ].join('\n')
            )
        ).toEqual([
            { name: 'origin', fetchURL: 'git@github.com:me/api.git', pushURL: 'git@github.com:me/api.git', configuredFetchURL: null, configuredPushURL: null, fetchURLs: ['git@github.com:me/api.git'] },
            {
                name: 'upstream',
                fetchURL: 'https://github.com/acme/api.git',
                pushURL: 'git@github.com-work:acme/api.git',
                configuredFetchURL: null,
                configuredPushURL: null,
                fetchURLs: ['https://github.com/acme/api.git']
            }
        ]);
    });

    it('reads the URLs as written by remote (dotted names, the first of a repeated url) and keeps both spellings', () => {
        const written = parseRemoteConfig(
            ['remote.origin.url\ngh:acme/api', 'remote.my.fork.url\ngit@github.com:me/api.git', 'remote.my.fork.url\nsecond', 'remote.my.fork.pushurl\ngh:me/api', ''].join('\0')
        );
        expect(written.get('origin')).toEqual({ url: 'gh:acme/api', pushURL: null });
        expect(written.get('my.fork')).toEqual({ url: 'git@github.com:me/api.git', pushURL: 'gh:me/api' });
        const [origin, fork] = parseRemoteVerbose(
            ['origin\tgit@github.com:acme/api (fetch)', 'origin\tgit@github.com:acme/api (push)', 'my.fork\tgit@github.com:me/api.git (fetch)', 'my.fork\tgit@github.com:me/api (push)'].join('\n'),
            written
        );
        expect(origin).toMatchObject({ fetchURL: 'git@github.com:acme/api', configuredFetchURL: 'gh:acme/api', fetchURLs: ['git@github.com:acme/api', 'gh:acme/api'] });
        expect(fork).toMatchObject({ configuredPushURL: 'gh:me/api', fetchURLs: ['git@github.com:me/api.git'] });
    });

    it('reads branch config by the last segment, so dotted and slashed branch names survive', () => {
        const config = parseBranchConfig(
            [
                'branch.main.remote\norigin',
                'branch.main.merge\nrefs/heads/main',
                'branch.fix/v1.2.remote\nupstream',
                'branch.fix/v1.2.merge\nrefs/pull/7/head',
                'branch.feat.pushremote\nfork',
                'branch.feat.rebase\ntrue',
                ''
            ].join('\0')
        );
        expect(config.get('main')).toEqual({ remote: 'origin', merge: 'refs/heads/main', pushRemote: null });
        expect(config.get('fix/v1.2')).toEqual({ remote: 'upstream', merge: 'refs/pull/7/head', pushRemote: null });
        expect(config.get('feat')).toEqual({ remote: null, merge: null, pushRemote: 'fork' });
    });

    it('reads worktrees, keeping prunable and bare apart and paths untrimmed', () => {
        const list = parseWorktreePorcelain(
            [
                'worktree /repo',
                'HEAD abc',
                'branch refs/heads/main',
                '',
                'worktree /wt/ spaced',
                'HEAD def',
                'branch refs/heads/feature/x',
                '',
                'worktree /wt/gone',
                'HEAD 123',
                'branch refs/heads/old',
                'prunable gitdir file points to non-existent location',
                '',
                'worktree /wt/detached',
                'HEAD 456',
                'detached',
                ''
            ].join('\n')
        );
        expect(list).toEqual([
            { path: '/repo', branch: 'main', bare: false, prunable: false, isMain: true },
            { path: '/wt/ spaced', branch: 'feature/x', bare: false, prunable: false, isMain: false },
            { path: '/wt/gone', branch: 'old', bare: false, prunable: true, isMain: false },
            { path: '/wt/detached', branch: null, bare: false, prunable: false, isMain: false }
        ]);
    });
});

describe('createRepoFacts against real repositories', () => {
    it('lists every remote, not just origin', async () => {
        const dir = repo();
        git(dir, 'remote', 'add', 'origin', 'git@github.com:me/api.git');
        git(dir, 'remote', 'add', 'upstream', 'https://github.com/acme/api.git');
        git(dir, 'remote', 'set-url', '--push', 'upstream', 'git@github.com:acme/api.git');
        const facts = createRepoFacts({ run: isolatedRunner() });
        expect(await facts.remotes(dir)).toEqual([
            {
                name: 'origin',
                fetchURL: 'git@github.com:me/api.git',
                pushURL: 'git@github.com:me/api.git',
                configuredFetchURL: 'git@github.com:me/api.git',
                configuredPushURL: null,
                fetchURLs: ['git@github.com:me/api.git']
            },
            {
                name: 'upstream',
                fetchURL: 'https://github.com/acme/api.git',
                pushURL: 'git@github.com:acme/api.git',
                configuredFetchURL: 'https://github.com/acme/api.git',
                configuredPushURL: 'git@github.com:acme/api.git',
                fetchURLs: ['https://github.com/acme/api.git']
            }
        ]);
    });

    it('keeps a URL as git rewrites it (insteadOf) AND as written, both ways round, with no network', async () => {
        const dir = repo();
        // An alias that only names GitHub once rewritten: `gh:acme/api` -> `git@github.com:acme/api`.
        git(dir, 'remote', 'add', 'upstream', 'gh:acme/api');
        git(dir, 'config', 'url.git@github.com:.insteadOf', 'gh:');
        // A GitHub URL rewritten onto a mirror: only the spelling as written names GitHub.
        git(dir, 'remote', 'add', 'origin', 'https://github.com/me/api.git');
        git(dir, 'config', 'url./srv/mirror/me-api.git.insteadOf', 'https://github.com/me/api.git');
        const remotes = await readRemoteFacts((args) => isolatedRunner()(args, { cwd: dir }));
        expect(remotes.find((remote) => remote.name === 'upstream')).toMatchObject({
            fetchURL: 'git@github.com:acme/api',
            configuredFetchURL: 'gh:acme/api',
            fetchURLs: ['git@github.com:acme/api', 'gh:acme/api']
        });
        expect(remotes.find((remote) => remote.name === 'origin')).toMatchObject({
            fetchURL: '/srv/mirror/me-api.git',
            configuredFetchURL: 'https://github.com/me/api.git',
            fetchURLs: ['/srv/mirror/me-api.git', 'https://github.com/me/api.git']
        });
        // The cached reader answers the same.
        expect(await createRepoFacts({ run: isolatedRunner() }).remotes(dir)).toEqual(remotes);
    });

    it('the strict readers reject a path git cannot read, where the cached ones answer nothing', async () => {
        const plain = tmpDir('strict');
        const read = (args: readonly string[]): Promise<string> => isolatedRunner()(args, { cwd: plain });
        await expect(readRemoteFacts(read)).rejects.toThrow();
        await expect(readBranchFacts(read)).rejects.toThrow();
        expect(await createRepoFacts({ run: isolatedRunner() }).remotes(plain)).toEqual([]);
    });

    it('reads local branches, their config and where each is checked out', async () => {
        const dir = repo();
        git(dir, 'remote', 'add', 'upstream', 'https://github.com/acme/api.git');
        git(dir, 'branch', 'pr-head');
        git(dir, 'config', 'branch.pr-head.remote', 'upstream');
        git(dir, 'config', 'branch.pr-head.merge', 'refs/pull/7/head');
        git(dir, 'branch', 'octo/feature.v2');
        git(dir, 'config', 'branch.octo/feature.v2.remote', 'git@github.com:octo/api.git');
        git(dir, 'config', 'branch.octo/feature.v2.merge', 'refs/heads/feature.v2');
        const worktrees = tmpDir('wts');
        const linked = path.join(worktrees, 'linked');
        git(dir, 'worktree', 'add', '-q', linked, 'pr-head');
        // A worktree whose directory was deleted: listed as prunable, so not "checked out".
        const gone = path.join(worktrees, 'gone');
        git(dir, 'worktree', 'add', '-q', '-b', 'old', gone);
        fs.rmSync(gone, { recursive: true, force: true });

        const facts = createRepoFacts({ run: isolatedRunner() });
        const branches = await facts.branches(dir);
        expect([...branches.branches.keys()].sort()).toEqual(['main', 'octo/feature.v2', 'old', 'pr-head']);
        expect(branches.branches.get('pr-head')).toEqual({ remote: 'upstream', merge: 'refs/pull/7/head', pushRemote: null });
        expect(branches.branches.get('octo/feature.v2')).toEqual({
            remote: 'git@github.com:octo/api.git',
            merge: 'refs/heads/feature.v2',
            pushRemote: null
        });
        expect(branches.branches.get('main')).toEqual({ remote: null, merge: null, pushRemote: null });
        expect(branches.checkedOutAt('main')).toBe(dir);
        expect(branches.checkedOutAt('pr-head')).toBe(fs.realpathSync(linked));
        expect(branches.checkedOutAt('old')).toBeNull();
        // ...but git still holds the branch there until it is pruned: busy, not free.
        expect(branches.staleCheckoutAt('old')).toBe(path.join(fs.realpathSync(worktrees), 'gone'));
        expect(branches.staleCheckoutAt('pr-head')).toBeNull();
        expect(branches.checkedOutAt('octo/feature.v2')).toBeNull();
        expect(branches.checkedOutAt('missing')).toBeNull();
    });

    it('tells a root row from a subfolder row and a linked worktree row', async () => {
        const dir = repo();
        const linked = path.join(tmpDir('wt'), 'linked');
        git(dir, 'worktree', 'add', '-q', '-b', 'side', linked);
        const facts = createRepoFacts({ run: isolatedRunner() });
        expect(await facts.layout(dir)).toMatchObject({ toplevel: dir, isRoot: true });
        expect(await facts.layout(path.join(dir, 'packages'))).toMatchObject({ toplevel: dir, isRoot: false });
        expect(await facts.layout(linked)).toMatchObject({ toplevel: fs.realpathSync(linked), isRoot: false });
        expect(await facts.layout(path.join(dir, 'nope'))).toBeNull();
    });

    it('answers a path git cannot read with nothing, never an error', async () => {
        const plain = tmpDir('plain');
        const facts = createRepoFacts({ run: isolatedRunner() });
        expect(await facts.remotes(plain)).toEqual([]);
        expect((await facts.branches(plain)).branches.size).toBe(0);
        expect(await facts.remotes(path.join(plain, 'missing'))).toEqual([]);
        expect(await facts.layout(plain)).toBeNull();
    });

    it('reuses a read within its TTL and re-reads after invalidate or expiry', async () => {
        const dir = repo();
        git(dir, 'remote', 'add', 'origin', 'git@github.com:me/api.git');
        const calls: string[][] = [];
        let clock = 1_000;
        const facts = createRepoFacts({ run: isolatedRunner(calls), now: () => clock, remotesTTLms: 100, branchesTTLms: 10 });
        await facts.remotes(dir);
        await facts.remotes(dir);
        expect(calls.filter((args) => args[0] === 'remote')).toHaveLength(1);
        git(dir, 'remote', 'add', 'upstream', 'git@github.com:acme/api.git');
        expect((await facts.remotes(dir)).map((remote) => remote.name)).toEqual(['origin']);
        facts.invalidate(dir);
        expect((await facts.remotes(dir)).map((remote) => remote.name)).toEqual(['origin', 'upstream']);
        clock += 101;
        await facts.remotes(dir);
        expect(calls.filter((args) => args[0] === 'remote')).toHaveLength(3);
    });

    it("stops a caller's wait on abort without failing the shared read", async () => {
        const dir = repo();
        git(dir, 'remote', 'add', 'origin', 'git@github.com:me/api.git');
        const facts = createRepoFacts({ run: isolatedRunner() });
        const controller = new AbortController();
        const reason = new Error('cancelled');
        const first = facts.remotes(dir, controller.signal);
        const second = facts.remotes(dir);
        controller.abort(reason);
        await expect(first).rejects.toBe(reason);
        expect((await second).map((remote) => remote.name)).toEqual(['origin']);
    });
});
