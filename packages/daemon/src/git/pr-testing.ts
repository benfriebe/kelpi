/**
 * Real-git fixtures for pull request checkouts and ticket files (tests only, like `testing.ts`):
 * a bare base repository with GitHub's `refs/pull/<n>/head` refs written by hand
 * (`git update-ref`), a second bare repository as a fork, a seed clone that pushes to both, and the
 * clone a create runs in. No network: every URL is a local path, or a GitHub-looking URL that
 * `url.<path>.insteadOf` maps onto one.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveGitExecutable } from './exec.js';

export const GIT = resolveGitExecutable();

export const HAS_GIT = ((): boolean => {
    try {
        execFileSync(GIT, ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
})();

const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 'kelpi',
    GIT_AUTHOR_EMAIL: 'kelpi@example.com',
    GIT_COMMITTER_NAME: 'kelpi',
    GIT_COMMITTER_EMAIL: 'kelpi@example.com',
    GIT_CONFIG_NOSYSTEM: '1'
};

const roots: string[] = [];

export function tmpDir(prefix: string): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `kelpi-pr-${prefix}-`)));
    roots.push(dir);
    return dir;
}

/** Remove every directory `tmpDir` made (call from `afterAll`). */
export function removeTmpDirs(): void {
    for (const root of roots.splice(0)) {
        try {
            fs.rmSync(root, { recursive: true, force: true });
        } catch {
            // best effort
        }
    }
}

export function git(cwd: string, ...args: string[]): string {
    return execFileSync(GIT, args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function tryGit(cwd: string, ...args: string[]): string | null {
    try {
        return git(cwd, ...args);
    } catch {
        return null;
    }
}

export function commit(dir: string, file: string, text: string, message: string): string {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', message);
    return git(dir, 'rev-parse', 'HEAD');
}

export interface PullRequestFixture {
    readonly root: string;
    /** The base repository (GitHub's `acme/api`), bare. */
    readonly origin: string;
    /** A fork (`octo/api`), bare. */
    readonly fork: string;
    /** A clone that pushes to both. */
    readonly seed: string;
    /** The clone the create runs in (`origin` = the base). */
    readonly work: string;
    readonly main: string;
}

/** A bare base, a bare fork, a seed and a work clone, all on `main`. */
export function pullRequestFixture(): PullRequestFixture {
    const root = tmpDir('fx');
    const origin = path.join(root, 'origin.git');
    const fork = path.join(root, 'fork.git');
    const seed = path.join(root, 'seed');
    const work = path.join(root, 'work');
    git(root, 'init', '-q', '--bare', '--initial-branch=main', origin);
    git(root, 'clone', '-q', origin, seed);
    git(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    const main = commit(seed, 'README.md', '# api\n', 'first');
    git(seed, 'push', '-q', 'origin', 'main');
    git(root, 'clone', '-q', '--bare', origin, fork);
    git(seed, 'remote', 'add', 'fork', fork);
    git(root, 'clone', '-q', origin, work);
    return { root, origin, fork, seed, work, main };
}

/**
 * A pull request from the base repository itself: `branch` pushed to origin with one commit, and
 * origin's `refs/pull/<number>/head` pointing at it. Returns the head commit.
 */
export function sameRepoPullRequest(fx: PullRequestFixture, number: number, branch: string, file = `${branch}.txt`): string {
    git(fx.seed, 'checkout', '-q', '-B', branch, 'main');
    const head = commit(fx.seed, file.replace(/\//g, '-'), `${branch}\n`, `work on ${branch}`);
    git(fx.seed, 'push', '-q', '-f', 'origin', `${branch}:refs/heads/${branch}`);
    git(fx.origin, 'update-ref', `refs/pull/${number}/head`, head);
    git(fx.seed, 'checkout', '-q', 'main');
    return head;
}

/**
 * A pull request from the fork: `branch` pushed to the fork, and its commits copied into the base
 * as `refs/pull/<number>/head` (what GitHub does). Returns the head commit.
 */
export function forkPullRequest(fx: PullRequestFixture, number: number, branch: string, extra?: (seed: string) => void): string {
    git(fx.seed, 'checkout', '-q', '-B', `fork-${branch}`, 'main');
    extra?.(fx.seed);
    const head = commit(fx.seed, `fork-${branch.replace(/\//g, '-')}.txt`, `${branch}\n`, `fork work on ${branch}`);
    git(fx.seed, 'push', '-q', '-f', 'fork', `fork-${branch}:refs/heads/${branch}`);
    git(fx.origin, 'fetch', '-q', fx.fork, `+refs/heads/${branch}:refs/pull/${number}/head`);
    git(fx.seed, 'checkout', '-q', 'main');
    return head;
}

/** Point `https://github.com/<repo>.git` (and the `.git`-less form) at a local bare repository. */
export function mapGitHubURL(repo: string, repoPath: string, bare: string): void {
    git(repoPath, 'config', '--add', `url.${bare}.insteadOf`, `https://github.com/${repo}.git`);
}
