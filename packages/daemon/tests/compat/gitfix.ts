/**
 * Real git fixtures for the compat suite (M7).
 *
 * `graft.test.ts` and `workspace-worktree.test.ts` are the two places where the contract is
 * about what git does on disk, so the repos here are real: `git init`, a real commit, a real
 * `git worktree add`. Stubbing git would test nothing (the graft engine is `write-tree` in the
 * worktree + `read-tree` in the parent, and `--prune-worktree` is `git worktree remove`).
 *
 * Two isolation rules matter:
 *   1. every repo lives inside the calling test's tmp root, which the harness deletes on
 *      `stop()` — nothing is ever created in the user's real checkouts;
 *   2. the fixture writes **local** `user.name` / `user.email` / `commit.gpgsign=false` into
 *      each repo. The daemon's own git spawns inherit the vitest process environment (and
 *      therefore the developer's `~/.gitconfig`), so identity has to come from the repo itself
 *      or `git stash push` would fail on a machine without a global identity — and signing has
 *      to be off or it would fail on a machine that has one.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { resolveGitExecutable } from '../../src/git/index.js';

export const GIT = resolveGitExecutable();

/** Suites skip themselves when git is missing (same shape as the Swift-CLI skip). */
export function gitAvailable(): boolean {
    try {
        execFileSync(GIT, ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/**
 * Run git for the FIXTURE (not for the daemon). Config is pinned off the machine so a
 * developer's global settings cannot change what the fixture looks like; stderr is captured
 * because `git worktree add` chats on every call.
 */
export function git(cwd: string, ...args: string[]): string {
    return execFileSync(GIT, args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'nex',
            GIT_AUTHOR_EMAIL: 'nex@example.com',
            GIT_COMMITTER_NAME: 'nex',
            GIT_COMMITTER_EMAIL: 'nex@example.com',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null'
        }
    });
}

/**
 * A repo at `dir` with one commit on `main`. Returns the **realpath**: the daemon canonicalizes
 * every parent root (macOS `/var` → `/private/var`), so comparing against the raw mkdtemp path
 * would spuriously fail.
 */
export function initRepo(dir: string, files: Readonly<Record<string, string>> = {}): string {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '--initial-branch=main');
    // Local identity + no signing: the DAEMON's git runs with the ambient env (see the header).
    git(dir, 'config', 'user.name', 'nex');
    git(dir, 'config', 'user.email', 'nex@example.com');
    git(dir, 'config', 'commit.gpgsign', 'false');
    const seeded = { 'README.md': '# fixture\n', ...files };
    for (const [name, contents] of Object.entries(seeded)) {
        const target = path.join(dir, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents);
    }
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'initial');
    return fs.realpathSync(dir);
}

/** `git rev-parse --abbrev-ref HEAD`, trimmed. */
export function currentBranch(repoPath: string): string {
    return git(repoPath, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
}

/** `git status --porcelain`, trimmed (empty string = clean). */
export function porcelain(repoPath: string): string {
    return git(repoPath, 'status', '--porcelain').trim();
}

export function readIfPresent(file: string): string | null {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

/** Poll until `predicate` holds; resolves `true` on success, `false` on timeout. */
export async function waitFor(
    predicate: () => boolean | Promise<boolean>,
    timeoutMs = 20_000,
    stepMs = 100
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await predicate()) return true;
        if (Date.now() > deadline) return false;
        await new Promise<void>((resolve) => setTimeout(resolve, stepMs));
    }
}
