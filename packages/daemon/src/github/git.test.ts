import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGitRunner } from '../git/exec.js';
import { createPullRequestGit } from './git.js';

const ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com'
};

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();
}

function commit(cwd: string, file: string): string {
    fs.writeFileSync(path.join(cwd, file), file);
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-q', '-m', file);
    return git(cwd, 'rev-parse', 'HEAD');
}

let root: string;
let clone: string;
let worktree: string;
const shas: Record<string, string> = {};

beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-prgit-')));
    const origin = path.join(root, 'origin.git');
    const seed = path.join(root, 'seed');
    clone = path.join(root, 'clone');
    git(root, 'init', '-q', '--bare', '--initial-branch=main', origin);
    git(root, 'clone', '-q', origin, seed);
    git(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    shas['base'] = commit(seed, 'base');
    git(seed, 'push', '-q', 'origin', 'main');
    git(root, 'clone', '-q', origin, clone);
    git(clone, 'checkout', '-q', '-b', 'feat-x');
    shas['tip'] = commit(clone, 'tip');
    git(clone, 'push', '-q', 'origin', 'feat-x');
    // Someone else pushes to feat-x on the remote; this clone fetches but does not merge.
    git(seed, 'fetch', '-q', 'origin', 'feat-x:feat-x');
    git(seed, 'checkout', '-q', 'feat-x');
    shas['pushed'] = commit(seed, 'pushed');
    git(seed, 'push', '-q', 'origin', 'feat-x');
    git(clone, 'fetch', '-q', 'origin');
    // A commit on top of the local tip that no branch here holds (an Update branch, fetched by sha).
    shas['ahead'] = git(clone, 'commit-tree', `${shas['tip'] as string}^{tree}`, '-p', shas['tip'] as string, '-m', 'ahead');
    // Known here, but another line of work entirely.
    shas['orphan'] = git(clone, 'commit-tree', `${shas['tip'] as string}^{tree}`, '-m', 'orphan');
    worktree = path.join(root, 'wt');
    git(clone, 'worktree', 'add', '-q', worktree, 'main');
}, 30_000);

afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe('createPullRequestGit', () => {
    const pr = () => createPullRequestGit(createGitRunner());

    it('reads origin and the default branch, and answers null outside a repo', async () => {
        expect(await pr().remoteURL(clone)).toBe(path.join(root, 'origin.git'));
        expect(await pr().defaultBranch(clone)).toBe('main');
        expect(await pr().remoteURL(root)).toBeNull();
    });

    it('places a PR head against the branch: on it, on origin\'s copy, ahead of it, unrelated, never fetched', async () => {
        const git = pr();
        expect(await git.headRelation(clone, shas['tip'] as string, 'feat-x')).toBe('contained');
        expect(await git.headRelation(clone, shas['base'] as string, 'feat-x')).toBe('contained');
        expect(await git.headRelation(clone, shas['pushed'] as string, 'feat-x')).toBe('contained');
        expect(await git.headRelation(clone, shas['ahead'] as string, 'feat-x')).toBe('ahead');
        expect(await git.headRelation(clone, shas['orphan'] as string, 'feat-x')).toBe('unrelated');
        expect(await git.headRelation(clone, 'f'.repeat(40), 'feat-x')).toBe('unknown');
    });

    it('answers the same from a linked worktree, which shares the branch refs', async () => {
        expect(await pr().headRelation(worktree, shas['tip'] as string, 'feat-x')).toBe('contained');
        expect(await pr().headRelation(worktree, shas['ahead'] as string, 'feat-x')).toBe('ahead');
    });
});
