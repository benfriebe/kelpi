/**
 * Integration tests against throwaway repos created with a real `git init`. CI is this
 * machine, so real git is the honest fixture; the whole suite skips when git is absent.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GitCommandError, createGitRunner, resolveGitExecutable, longGitTimeout, MIN_LONG_GIT_TIMEOUT_MS } from './exec.js';
import { createGitService, DETACHED_HEAD, FALLBACK_DEFAULT_BRANCH, parseSymrefLine, stripRemotePrefix } from './service.js';

const GIT = resolveGitExecutable();

function gitAvailable(): boolean {
    try {
        execFileSync(GIT, ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

const HAS_GIT = gitAvailable();
const roots: string[] = [];

function tmpDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nex-git-${prefix}-`));
    roots.push(dir);
    return fs.realpathSync(dir);
}

function git(cwd: string, ...args: string[]): string {
    return execFileSync(GIT, args, {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'nex',
            GIT_AUTHOR_EMAIL: 'nex@example.com',
            GIT_COMMITTER_NAME: 'nex',
            GIT_COMMITTER_EMAIL: 'nex@example.com'
        }
    });
}

/** A repo with one commit on `main`. */
function initRepo(prefix = 'repo'): string {
    const dir = tmpDir(prefix);
    git(dir, 'init', '--initial-branch=main');
    fs.writeFileSync(path.join(dir, 'README.md'), '# hi\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'initial');
    return dir;
}

afterAll(() => {
    for (const root of roots) {
        try {
            fs.rmSync(root, { recursive: true, force: true });
        } catch {
            // best effort
        }
    }
});

describe('pure helpers', () => {
    it('parses ls-remote symref lines', () => {
        expect(parseSymrefLine('ref: refs/heads/main\tHEAD')).toBe('main');
        expect(parseSymrefLine('ref: refs/heads/feature/x   HEAD')).toBe('feature/x');
        expect(parseSymrefLine('ref: refs/tags/v1\tHEAD')).toBeNull();
        expect(parseSymrefLine('abc123\tHEAD')).toBeNull();
    });

    it('strips the remote prefix', () => {
        expect(stripRemotePrefix('origin/main')).toBe('main');
        expect(stripRemotePrefix('origin/feature/x')).toBe('feature/x');
        expect(stripRemotePrefix('main')).toBe('main');
    });

    it('never shortens a long-operation timeout below the 120s floor', () => {
        expect(longGitTimeout(undefined)).toBeUndefined();
        expect(longGitTimeout(1_000)).toBe(MIN_LONG_GIT_TIMEOUT_MS);
        expect(longGitTimeout(300_000)).toBe(300_000);
    });
});

describe.skipIf(!HAS_GIT)('runner', () => {
    it('returns stdout on success and a GitCommandError with trimmed stderr on failure', async () => {
        const repo = initRepo('runner');
        const run = createGitRunner();
        await expect(run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo })).resolves.toContain('main');

        const failure = await run(['worktree', 'add', path.join(repo, 'README.md'), 'main'], {
            cwd: repo
        }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(GitCommandError);
        const error = failure as GitCommandError;
        expect(error.kind).toBe('commandFailed');
        expect(error.exitCode).toBeGreaterThan(0);
        expect(error.stderr).not.toBe('');
        expect(error.stderr).toBe(error.stderr.trim());
        expect(error.command.startsWith('git worktree add')).toBe(true);
    });
});

describe.skipIf(!HAS_GIT)('GitService', () => {
    it('reads the current branch and reports the HEAD sentinel when detached', async () => {
        const repo = initRepo('branch');
        const service = createGitService();
        expect(await service.getCurrentBranch(repo)).toBe('main');

        const sha = git(repo, 'rev-parse', 'HEAD').trim();
        git(repo, 'checkout', '--detach', sha);
        expect(await service.getCurrentBranch(repo)).toBe(DETACHED_HEAD);
    });

    it('returns null for a non-repo directory instead of throwing', async () => {
        const service = createGitService();
        expect(await service.getCurrentBranch(tmpDir('plain'))).toBeNull();
        expect(await service.getRemoteURL(tmpDir('plain'))).toBeNull();
        expect(await service.toplevel(tmpDir('plain'))).toBeNull();
        expect(await service.resolveRepoRoot(tmpDir('plain'))).toBeNull();
        expect(await service.resolveRepoRoot('/nope/does/not/exist')).toBeNull();
    });

    it('resolves the default branch from the remote symref, then the local one, then "main"', async () => {
        const service = createGitService();

        const origin = initRepo('origin');
        git(origin, 'branch', '-m', 'trunk');
        const clone = tmpDir('clone');
        git(clone, 'clone', origin, 'work');
        const work = path.join(clone, 'work');
        expect(await service.defaultBranch(work)).toBe('trunk');

        // No remote at all: falls all the way through to the literal default.
        const solo = initRepo('solo');
        expect(await service.defaultBranch(solo)).toBe(FALLBACK_DEFAULT_BRANCH);
    });

    it('resolves toplevel and the parent repo root for main and linked worktrees', async () => {
        const service = createGitService();
        const repo = initRepo('roots');
        fs.mkdirSync(path.join(repo, 'nested/deep'), { recursive: true });

        expect(await service.toplevel(path.join(repo, 'nested/deep'))).toBe(repo);
        expect(await service.resolveRepoRoot(repo)).toEqual({
            worktreeRoot: repo,
            parentRepoRoot: repo
        });

        const worktreePath = path.join(tmpDir('wt'), 'feature');
        await service.worktreeAdd({
            repoPath: repo,
            worktreePath,
            branchName: 'feature-x',
            updateMain: false
        });
        const info = await service.resolveRepoRoot(worktreePath);
        expect(info?.worktreeRoot).toBe(fs.realpathSync(worktreePath));
        expect(info?.parentRepoRoot).toBe(repo);
        expect(await service.getCurrentBranch(worktreePath)).toBe('feature-x');
    });

    it('attaches to an existing branch first and falls back to -b for a new one', async () => {
        const service = createGitService();
        const repo = initRepo('add');
        git(repo, 'branch', 'existing');

        const attached = path.join(tmpDir('wt-existing'), 'existing');
        await service.createWorktree(repo, attached, 'existing');
        expect(await service.getCurrentBranch(attached)).toBe('existing');
        // The branch already existed, so no new one was created off HEAD.
        expect(git(repo, 'branch', '--list', 'existing')).toContain('existing');

        const created = path.join(tmpDir('wt-new'), 'brand-new');
        await service.createWorktree(repo, created, 'brand-new');
        expect(await service.getCurrentBranch(created)).toBe('brand-new');
    });

    it('propagates the fallback’s GitCommandError when both worktree adds fail', async () => {
        const service = createGitService();
        const repo = initRepo('fail');
        const occupied = path.join(repo, 'README.md');
        const error = await service
            .createWorktree(repo, occupied, 'whatever')
            .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(GitCommandError);
        expect((error as GitCommandError).stderr.toLowerCase()).toContain('fatal:');
    });

    it('branches off origin/<default> on the --update-main path', async () => {
        const service = createGitService();
        const origin = initRepo('um-origin');
        git(origin, 'branch', '-m', 'trunk');
        const cloneRoot = tmpDir('um-clone');
        git(cloneRoot, 'clone', origin, 'work');
        const work = path.join(cloneRoot, 'work');

        // A commit that only exists on the remote: the worktree must contain it.
        fs.writeFileSync(path.join(origin, 'remote-only.txt'), 'x\n');
        git(origin, 'add', '.');
        git(origin, 'commit', '-m', 'remote only');

        const worktreePath = path.join(tmpDir('um-wt'), 'from-main');
        await service.worktreeAdd({
            repoPath: work,
            worktreePath,
            branchName: 'from-main',
            updateMain: true
        });
        expect(await service.getCurrentBranch(worktreePath)).toBe('from-main');
        expect(fs.existsSync(path.join(worktreePath, 'remote-only.txt'))).toBe(true);
    });

    it('drives worktreeAdd through the plain path when updateMain is false', async () => {
        const calls: string[][] = [];
        const service = createGitService({
            run: async (args) => {
                calls.push([...args]);
                return '';
            }
        });
        await service.worktreeAdd({
            repoPath: '/repo',
            worktreePath: '/wt',
            branchName: 'b',
            updateMain: false
        });
        expect(calls).toEqual([['worktree', 'add', '/wt', 'b']]);
    });

    it('fetches before branching off the resolved default on the update-main path', async () => {
        const calls: string[][] = [];
        const service = createGitService({
            run: async (args) => {
                calls.push([...args]);
                if (args[0] === 'ls-remote') return 'ref: refs/heads/trunk\tHEAD\n';
                return '';
            }
        });
        await service.worktreeAdd({
            repoPath: '/repo',
            worktreePath: '/wt',
            branchName: 'b',
            updateMain: true
        });
        expect(calls).toEqual([
            ['ls-remote', '--symref', 'origin', 'HEAD'],
            ['fetch', 'origin'],
            ['worktree', 'add', '-b', 'b', '/wt', 'origin/trunk']
        ]);
    });

    it('clamps a short long-op budget up to the 120s floor', async () => {
        const seen: (number | undefined)[] = [];
        const service = createGitService({
            longTimeoutMs: 5,
            run: async (_args, options) => {
                seen.push(options.timeoutMs);
                return '';
            }
        });
        await service.fetch('/repo');
        expect(seen).toEqual([MIN_LONG_GIT_TIMEOUT_MS]);
    });
});
