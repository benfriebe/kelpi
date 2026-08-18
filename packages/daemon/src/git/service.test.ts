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
import {
    createGitService,
    DETACHED_HEAD,
    FALLBACK_DEFAULT_BRANCH,
    GRAFT_TEMP_INDEX_PREFIX,
    parseSymrefLine,
    stripRemotePrefix,
    sweepGraftTempIndexes
} from './service.js';
import { describeRepoState, parseShortstat, parseWorktreeList } from './status.js';

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

// ---------------------------------------------------------------------------
// M7 primitives (graft-git.md §3.2): status, in-flight ops, stash, tree sync
// ---------------------------------------------------------------------------

describe('status parsers', () => {
    it('parses every shortstat shape the sidebar can see', () => {
        expect(parseShortstat(' 3 files changed, 27 insertions(+), 12 deletions(-)')).toEqual({
            additions: 27,
            deletions: 12
        });
        expect(parseShortstat(' 1 file changed, 5 insertions(+)')).toEqual({
            additions: 5,
            deletions: 0
        });
        expect(parseShortstat(' 1 file changed, 2 deletions(-)')).toEqual({
            additions: 0,
            deletions: 2
        });
        expect(parseShortstat('')).toEqual({ additions: 0, deletions: 0 });
        expect(parseShortstat('garbage')).toEqual({ additions: 0, deletions: 0 });
    });

    it('names each in-flight operation the way repoBusy reports it', () => {
        expect(describeRepoState('merge')).toBe('merge in progress');
        expect(describeRepoState('rebase')).toBe('rebase in progress');
        expect(describeRepoState('cherryPick')).toBe('cherry-pick in progress');
        expect(describeRepoState('revert')).toBe('revert in progress');
        expect(describeRepoState('bisect')).toBe('bisect in progress');
        expect(describeRepoState('clean')).toBe('clean');
    });

    it('parses `worktree list --porcelain`, force-marking the first entry main', () => {
        const parsed = parseWorktreeList(
            [
                'worktree /repo',
                'HEAD abc',
                'branch refs/heads/main',
                '',
                'worktree /wt/feature',
                'HEAD def',
                'branch refs/heads/feature/x',
                '',
                'worktree /wt/detached',
                'HEAD 123',
                'detached',
                ''
            ].join('\n')
        );
        expect(parsed).toEqual([
            { path: '/repo', branch: 'main', isMain: true },
            { path: '/wt/feature', branch: 'feature/x', isMain: false },
            { path: '/wt/detached', branch: null, isMain: false }
        ]);
        expect(parseWorktreeList('')).toEqual([]);
    });
});

describe.skipIf(!HAS_GIT)('GitService — graft primitives', () => {
    it('counts untracked files in changedFiles but never in additions/deletions', async () => {
        const repo = initRepo('status');
        const service = createGitService();
        expect(await service.getStatus(repo)).toEqual({ kind: 'clean' });

        fs.writeFileSync(path.join(repo, 'README.md'), '# hi\nmore\n');
        fs.writeFileSync(path.join(repo, 'untracked.txt'), 'a\nb\n');
        const status = await service.getStatus(repo);
        expect(status.kind).toBe('dirty');
        if (status.kind !== 'dirty') throw new Error('unreachable');
        // Two porcelain lines (one modified, one untracked)…
        expect(status.changedFiles).toBe(2);
        // …but only the TRACKED edit contributes to the line counts.
        expect(status.additions).toBe(1);
        expect(status.deletions).toBe(0);
    });

    it('counts STAGED edits too (diff --shortstat HEAD, not plain --shortstat)', async () => {
        const repo = initRepo('staged');
        const service = createGitService();
        fs.writeFileSync(path.join(repo, 'README.md'), '# hi\nstaged line\n');
        git(repo, 'add', '.');
        const status = await service.getStatus(repo);
        if (status.kind !== 'dirty') throw new Error('expected dirty');
        expect(status.additions).toBe(1);
    });

    it('swallows the shortstat failure in a repo with no HEAD', async () => {
        const repo = tmpDir('unborn');
        git(repo, 'init', '--initial-branch=main');
        fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
        const status = await createGitService().getStatus(repo);
        expect(status).toEqual({ kind: 'dirty', changedFiles: 1, additions: 0, deletions: 0 });
    });

    it('detects an in-flight operation from the RESOLVED git dir (worktrees included)', async () => {
        const repo = initRepo('state');
        const service = createGitService();
        expect(await service.repoState(repo)).toBe('clean');

        const worktree = path.join(tmpDir('state-wt'), 'wt-state');
        git(repo, 'worktree', 'add', '-b', 'wtstate', worktree);
        const worktreeGitDir = git(worktree, 'rev-parse', '--absolute-git-dir').trim();
        fs.writeFileSync(path.join(worktreeGitDir, 'REVERT_HEAD'), 'abc\n');
        // The worktree is busy; the parent is not.
        expect(await service.repoState(worktree)).toBe('revert');
        expect(await service.repoState(repo)).toBe('clean');

        fs.writeFileSync(path.join(repo, '.git', 'MERGE_HEAD'), 'abc\n');
        expect(await service.repoState(repo)).toBe('merge');
    });

    it('stashes by SHA, pops by SHA, and treats a dropped stash as success', async () => {
        const repo = initRepo('stash');
        const service = createGitService();
        expect(await service.stashPushIncludeUntracked(repo, 'nex-graft:none')).toBeNull();

        fs.writeFileSync(path.join(repo, 'README.md'), '# edited\n');
        fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n');
        const ref = await service.stashPushIncludeUntracked(repo, 'nex-graft:test');
        expect(ref).toMatch(/^[0-9a-f]{40}$/);
        // Untracked files ride along, so the tree is clean afterwards.
        expect(await service.getStatus(repo)).toEqual({ kind: 'clean' });
        expect(git(repo, 'stash', 'list')).toContain('nex-graft:test');

        await service.stashPopRef(repo, ref as string);
        expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('# edited\n');
        expect(fs.existsSync(path.join(repo, 'untracked.txt'))).toBe(true);
        // The ref is gone now: popping again is a silent no-op, not a failure.
        await expect(service.stashPopRef(repo, ref as string)).resolves.toBeUndefined();
    });

    it('write-tree/read-tree move content without touching the source index', async () => {
        const repo = initRepo('tree');
        const service = createGitService();
        const worktree = path.join(tmpDir('tree-wt'), 'wt-tree');
        git(repo, 'worktree', 'add', '-b', 'wttree', worktree);

        fs.writeFileSync(path.join(worktree, 'README.md'), '# from worktree\n');
        fs.writeFileSync(path.join(worktree, 'extra.txt'), 'untracked but mirrored\n');
        const tree = await service.writeTreeForWorktree(worktree);
        expect(tree).toMatch(/^[0-9a-f]{40}$/);
        // The worktree's REAL index never saw an `add`.
        expect(git(worktree, 'diff', '--name-only', '--cached').trim()).toBe('');

        await service.readTreeInto(repo, tree);
        expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('# from worktree\n');
        expect(fs.readFileSync(path.join(repo, 'extra.txt'), 'utf8')).toBe(
            'untracked but mirrored\n'
        );
        // The throw-away index is cleaned up (the name is unguessable from here; the sweep
        // test below covers the leftovers a crashed pass would leave).
        expect(tree).toBe(await service.writeTreeForWorktree(worktree));
    });

    it('resolves the HEAD path for the main checkout and for a linked worktree', async () => {
        const repo = initRepo('head');
        const service = createGitService();
        expect(await service.resolveHeadPath(repo)).toBe(path.join(repo, '.git', 'HEAD'));

        const worktree = path.join(tmpDir('head-wt'), 'wt-head');
        git(repo, 'worktree', 'add', '-b', 'wthead', worktree);
        const headPath = await service.resolveHeadPath(worktree);
        expect(headPath.endsWith(path.join('.git', 'worktrees', 'wt-head', 'HEAD'))).toBe(true);
        expect(path.isAbsolute(headPath)).toBe(true);
    });

    it('restores a working tree with checkout -f / reset', async () => {
        const repo = initRepo('restore');
        const service = createGitService();
        const first = git(repo, 'rev-parse', 'HEAD').trim();
        fs.writeFileSync(path.join(repo, 'README.md'), '# drift\n');
        await service.checkoutHeadForce(repo);
        expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('# hi\n');

        git(repo, 'checkout', '-q', '-b', 'side');
        fs.writeFileSync(path.join(repo, 'side.txt'), 'side\n');
        git(repo, 'add', '.');
        git(repo, 'commit', '-m', 'side');
        await service.checkoutBranchForce(repo, 'main');
        expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
        await service.resetHard(repo, first);
        expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(first);
    });

    it('lists and removes worktrees', async () => {
        const repo = initRepo('worktrees');
        const service = createGitService();
        const worktree = path.join(tmpDir('list-wt'), 'wt-list');
        git(repo, 'worktree', 'add', '-b', 'wtlist', worktree);

        const list = await service.listWorktrees(repo);
        expect(list[0]?.isMain).toBe(true);
        expect(list.map((entry) => entry.branch)).toContain('wtlist');

        await service.removeWorktree(repo, worktree);
        expect(fs.existsSync(worktree)).toBe(false);
        await service.pruneWorktrees(repo);
        expect(await service.listWorktrees(repo)).toHaveLength(1);
    });
});

describe('sweepGraftTempIndexes', () => {
    it('removes only day-old temp indexes, so a live sync is never robbed', () => {
        const dir = tmpDir('sweep');
        const stale = path.join(dir, `${GRAFT_TEMP_INDEX_PREFIX}stale`);
        const fresh = path.join(dir, `${GRAFT_TEMP_INDEX_PREFIX}fresh`);
        const other = path.join(dir, 'unrelated.tmp');
        for (const file of [stale, fresh, other]) fs.writeFileSync(file, 'x');
        const now = Date.now();
        fs.utimesSync(stale, new Date(now - 48 * 3600_000), new Date(now - 48 * 3600_000));

        expect(sweepGraftTempIndexes(dir, now)).toBe(1);
        expect(fs.existsSync(stale)).toBe(false);
        expect(fs.existsSync(fresh)).toBe(true);
        expect(fs.existsSync(other)).toBe(true);
        // A missing directory is not an error.
        expect(sweepGraftTempIndexes(path.join(dir, 'nope'), now)).toBe(0);
    });
});
