/**
 * `performWorktreeAdd` (issue #294): the default-branch order, the single-branch fetch, step
 * reporting, prefetch reuse, and cancellation's cleanup, first against a scripted git, then
 * against real repos with a bare origin (the `group-default-repo` scenario's fixture shape).
 *
 * The cancel tests slow git down with the repo's OWN configuration, never a product seam: an
 * `uploadpack` wrapper that sleeps holds a fetch open, and a `post-checkout` hook that sleeps
 * holds `git worktree add` open after it has made the branch and the directory.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createGitRunner, GitCommandError, resolveGitExecutable } from './exec.js';
import { createDefaultBranchFetchCache } from './fetch-cache.js';
import type { GitProgress } from './progress.js';
import {
    cleanupCancelledWorktreeAdd,
    createWorktreeAddGuard,
    defaultBranchFetchArgs,
    performWorktreeAdd,
    resolveDefaultBranch,
    WorktreeBranchExistsError,
    WorktreeBusyError,
    WorktreeCreateCancelledError,
    worktreeGitOps,
    type DefaultBranchFetches,
    type WorktreeGitCallOptions,
    type WorktreeGitOps
} from './worktree-add.js';
import { createStepTracker, worktreeStepsFor, type WorktreeProgressSnapshot, type WorktreeStepTracker } from './worktree-steps.js';

// ---------------------------------------------------------------------------
// Scripted git
// ---------------------------------------------------------------------------

interface Call {
    readonly args: readonly string[];
    readonly options: WorktreeGitCallOptions | undefined;
}

type Script = (args: readonly string[], options: WorktreeGitCallOptions | undefined) => Promise<string> | string;

function scripted(script: Script): { ops: WorktreeGitOps; calls: Call[] } {
    const calls: Call[] = [];
    const run = async (args: readonly string[], _cwd: string, options?: WorktreeGitCallOptions): Promise<string> => {
        calls.push({ args, options });
        return script(args, options);
    };
    return { ops: { read: run, long: run }, calls };
}

const SHA = 'b'.repeat(40);
const notFound = (): never => {
    throw new GitCommandError({ command: 'git', exitCode: 1, stderr: '', cwd: '/repo' });
};

/** origin/HEAD → origin/<head>, every origin branch in `remoteBranches` exists, no local ones. */
function repoScript(options: { head?: string | null; remoteBranches?: string[]; lsRemote?: string | null; localBranches?: string[] } = {}): Script {
    const head = options.head === undefined ? 'main' : options.head;
    const remote = new Set(options.remoteBranches ?? ['main']);
    const local = new Set(options.localBranches ?? []);
    return (args) => {
        if (args[0] === 'symbolic-ref') return head === null ? notFound() : `origin/${head}\n`;
        if (args[0] === 'rev-parse') {
            const ref = args[3] ?? '';
            if (ref.startsWith('refs/remotes/origin/') && remote.has(ref.slice('refs/remotes/origin/'.length))) return `${SHA}\n`;
            if (ref.startsWith('refs/heads/') && local.has(ref.slice('refs/heads/'.length))) return `${SHA}\n`;
            if (ref === 'HEAD') return `${SHA}\n`;
            return notFound();
        }
        if (args[0] === 'ls-remote') return options.lsRemote === null || options.lsRemote === undefined ? notFound() : `ref: refs/heads/${options.lsRemote}\tHEAD\n${SHA}\tHEAD\n`;
        return '';
    };
}

function recordingTracker(updateMain = true): { steps: WorktreeStepTracker; frames: WorktreeProgressSnapshot[] } {
    const frames: WorktreeProgressSnapshot[] = [];
    // No throttle: every change is a frame, so the test sees every transition.
    const steps = createStepTracker({ steps: worktreeStepsFor(updateMain), emit: (snapshot) => frames.push(snapshot), intervalMs: 0 });
    return { steps, frames };
}

const REQUEST = { repoPath: '/repo', worktreePath: '/wt/x', branchName: 'x', updateMain: true } as const;

describe('resolveDefaultBranch (#294 order)', () => {
    it('believes a local origin/HEAD that names an existing origin branch, without the network', async () => {
        const { ops, calls } = scripted(repoScript({ head: 'trunk', remoteBranches: ['trunk'], lsRemote: 'main' }));
        expect(await resolveDefaultBranch(ops, '/repo')).toEqual({ branch: 'trunk', source: 'origin-head' });
        expect(calls.map((call) => call.args[0])).toEqual(['symbolic-ref', 'rev-parse']);
        expect(calls[0]?.args).toEqual(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    });

    it('asks the remote when origin/HEAD is unset', async () => {
        const { ops, calls } = scripted(repoScript({ head: null, lsRemote: 'develop' }));
        expect(await resolveDefaultBranch(ops, '/repo')).toEqual({ branch: 'develop', source: 'ls-remote' });
        expect(calls.map((call) => call.args[0])).toEqual(['symbolic-ref', 'ls-remote']);
    });

    it('asks the remote, as before #294, when origin/HEAD points somewhere unexpected', async () => {
        // Dangling: origin/HEAD → origin/gone, and there is no refs/remotes/origin/gone.
        const dangling = scripted(repoScript({ head: 'gone', remoteBranches: ['main'], lsRemote: 'main' }));
        expect(await resolveDefaultBranch(dangling.ops, '/repo')).toEqual({ branch: 'main', source: 'ls-remote' });
        // Into another namespace entirely.
        const odd = scripted((args) => (args[0] === 'symbolic-ref' ? 'upstream/main\n' : repoScript({ lsRemote: 'trunk' })(args, undefined)));
        expect(await resolveDefaultBranch(odd.ops, '/repo')).toEqual({ branch: 'trunk', source: 'ls-remote' });
        expect(odd.calls.map((call) => call.args[0])).toEqual(['symbolic-ref', 'ls-remote']);
    });

    it('falls back to main when neither answers', async () => {
        const { ops } = scripted(repoScript({ head: null, lsRemote: null }));
        expect(await resolveDefaultBranch(ops, '/repo')).toEqual({ branch: 'main', source: 'fallback' });
    });

    it('lets an abort through instead of falling back', async () => {
        const controller = new AbortController();
        const { ops } = scripted(() => {
            controller.abort();
            throw new Error('killed');
        });
        await expect(resolveDefaultBranch(ops, '/repo', 'origin', controller.signal)).rejects.toThrow('killed');
    });
});

describe('createWorktreeAddGuard', () => {
    it('refuses a second create for the same (repo, path) or (repo, branch) until the first releases', () => {
        const guard = createWorktreeAddGuard();
        const release = guard.acquire({ repoPath: '/repo', worktreePath: '/wt/x', branchName: 'x', updateMain: true });
        expect(() => guard.acquire({ repoPath: '/repo/', worktreePath: '/wt/x/', branchName: 'y', updateMain: true })).toThrow(WorktreeBusyError);
        expect(() => guard.acquire({ repoPath: '/repo', worktreePath: '/wt/y', branchName: 'x', updateMain: false })).toThrow(/branch 'x'/);
        // Another repo, or another path and branch, is independent.
        guard.acquire({ repoPath: '/other', worktreePath: '/wt/x', branchName: 'x', updateMain: true })();
        guard.acquire({ repoPath: '/repo', worktreePath: '/wt/z', branchName: 'z', updateMain: true })();
        release();
        guard.acquire({ repoPath: '/repo', worktreePath: '/wt/x', branchName: 'x', updateMain: true })();
    });
});

describe('defaultBranchFetchArgs', () => {
    it('fetches one branch, no tags, straight into its remote-tracking ref', () => {
        expect(defaultBranchFetchArgs('origin', 'main')).toEqual(['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
        expect(defaultBranchFetchArgs('upstream', 'release/2.0', true)).toEqual([
            'fetch',
            '--no-tags',
            '--progress',
            'upstream',
            '+refs/heads/release/2.0:refs/remotes/upstream/release/2.0'
        ]);
    });
});

describe('performWorktreeAdd, scripted', () => {
    it('reports every step, turns git meters on, and forwards the percentages', async () => {
        const base = repoScript();
        const { ops, calls } = scripted((args, options) => {
            if (args[0] === 'fetch') {
                options?.onStderr?.('remote: Counting objects: 100% (3/3), done.\nReceiving objects:  45% (45/100)\r');
                options?.onStderr?.('Receiving objects: 100% (100/100), done.\n');
                return '';
            }
            if (args[0] === 'worktree') {
                options?.onStderr?.('Updating files:  60% (6/10)\rUpdating files: 100% (10/10), done.\n');
                return '';
            }
            return base(args, options);
        });
        const { steps, frames } = recordingTracker();
        const seen: GitProgress[] = [];
        const tracked: WorktreeStepTracker = { ...steps, progress: (id, progress) => { seen.push(progress); steps.progress(id, progress); } };
        await performWorktreeAdd(ops, REQUEST, { steps: tracked });

        const fetch = calls.find((call) => call.args[0] === 'fetch');
        expect(fetch?.args).toEqual(['fetch', '--no-tags', '--progress', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
        const add = calls.find((call) => call.args[0] === 'worktree');
        expect(add?.args).toEqual(['worktree', 'add', '-b', 'x', '/wt/x', 'origin/main']);
        // `worktree add` has no --progress: its checkout's delayed meter is switched on by env.
        expect(add?.options?.env).toEqual({ GIT_PROGRESS_DELAY: '0' });
        expect(seen.map((p) => `${p.phase} ${String(p.percent)}`)).toEqual([
            'Counting objects 100',
            'Receiving objects 45',
            'Receiving objects 100',
            'Updating files 60',
            'Updating files 100'
        ]);
        expect(frames.some((frame) => frame.steps[1]?.status === 'running' && frame.steps[1].percent === 45)).toBe(true);
        expect(steps.snapshot().steps).toEqual([
            { id: 'resolve-default-branch', status: 'done', detail: 'main (from origin/HEAD)' },
            { id: 'fetch', status: 'done', detail: expect.stringMatching(/^origin\/main \(\d+\.\d s\)$/) as unknown as string },
            // A finished step drops the meter it had while running.
            { id: 'worktree-add', status: 'done', detail: 'x off origin/main' },
            { id: 'create-workspace', status: 'pending' }
        ]);
    });

    it('runs without meters or snapshots when nobody is listening (the CLI, the inspector)', async () => {
        const { ops, calls } = scripted(repoScript());
        await performWorktreeAdd(ops, REQUEST);
        expect(calls.map((call) => call.args)).toEqual([
            ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
            ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'],
            ['rev-parse', '--verify', '--quiet', 'refs/heads/x'],
            ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
            ['worktree', 'add', '-b', 'x', '/wt/x', 'origin/main']
        ]);
        expect(calls.every((call) => call.options?.env === undefined && call.options?.onStderr === undefined)).toBe(true);
    });

    it('skips the fetch when a prefetch is reusable, and says how old it is', async () => {
        const { ops, calls } = scripted(repoScript());
        const fetches: DefaultBranchFetches = { fetchForCreate: async () => ({ kind: 'reused', ageMs: 5_000, origin: 'prefetch' }) };
        const { steps } = recordingTracker();
        const logs: string[] = [];
        await performWorktreeAdd(ops, REQUEST, { steps, fetches, log: (line) => logs.push(line) });
        expect(calls.some((call) => call.args[0] === 'fetch')).toBe(false);
        expect(steps.snapshot().steps[1]).toEqual({ id: 'fetch', status: 'skipped', detail: 'prefetched 5.0 s ago' });
        expect(logs.some((line) => line.includes('fetch of origin/main skipped for /repo: prefetched 5.0 s ago'))).toBe(true);
        expect(logs.some((line) => line.includes('default branch of /repo is main (from origin/HEAD)'))).toBe(true);
    });

    it('waits on a running prefetch and reports it as joined', async () => {
        const { ops } = scripted(repoScript());
        const fetches: DefaultBranchFetches = {
            fetchForCreate: async (input) => {
                input.onJoin?.('prefetch');
                input.onProgress?.({ phase: 'Receiving objects', percent: 70, current: 7, total: 10, remote: false });
                return { kind: 'joined', origin: 'prefetch' };
            }
        };
        const { steps, frames } = recordingTracker();
        await performWorktreeAdd(ops, REQUEST, { steps, fetches });
        expect(frames.some((frame) => frame.steps[1]?.detail === 'finishing the prefetch' && frame.steps[1].percent === 70)).toBe(true);
        expect(steps.snapshot().steps[1]?.detail).toMatch(/^origin\/main \(prefetch, \d+\.\d s\)$/);
    });

    it('marks the failed step with git’s message and throws it without the meter', async () => {
        const base = repoScript();
        const { ops } = scripted((args, options) => {
            if (args[0] === 'fetch') {
                throw new GitCommandError({
                    command: 'git fetch',
                    exitCode: 128,
                    stderr: "Receiving objects:  10% (1/10)\rfatal: couldn't find remote ref refs/heads/main",
                    cwd: '/repo'
                });
            }
            return base(args, options);
        });
        const { steps } = recordingTracker();
        const error = await performWorktreeAdd(ops, REQUEST, { steps }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(GitCommandError);
        expect((error as GitCommandError).stderr).toBe("fatal: couldn't find remote ref refs/heads/main");
        expect(steps.snapshot().steps[1]).toMatchObject({ id: 'fetch', status: 'failed', error: "fatal: couldn't find remote ref refs/heads/main" });
    });

    it('reports an existing branch against the worktree step, before any fetch', async () => {
        const { ops, calls } = scripted(repoScript({ localBranches: ['x'] }));
        const { steps } = recordingTracker();
        await expect(performWorktreeAdd(ops, REQUEST, { steps })).rejects.toBeInstanceOf(WorktreeBranchExistsError);
        expect(calls.some((call) => call.args[0] === 'fetch')).toBe(false);
        expect(steps.snapshot().steps.map((step) => step.status)).toEqual(['done', 'pending', 'failed', 'pending']);
    });

    it('an abort before anything ran is a cancel with no git at all', async () => {
        const { ops, calls } = scripted(repoScript());
        const controller = new AbortController();
        controller.abort();
        const { steps } = recordingTracker();
        const error = await performWorktreeAdd(ops, REQUEST, { steps, signal: controller.signal }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(WorktreeCreateCancelledError);
        expect((error as WorktreeCreateCancelledError).step).toBe('resolve-default-branch');
        expect(calls).toEqual([]);
        expect(steps.snapshot().cancelled).toBe(true);
        expect(steps.snapshot().steps[0]).toEqual({ id: 'resolve-default-branch', status: 'failed', error: 'cancelled' });
    });

    it('retries once with what the remote says when a local origin/HEAD names a branch the remote dropped', async () => {
        const base = repoScript({ head: 'main', remoteBranches: ['main', 'trunk'], lsRemote: 'trunk' });
        const { ops, calls } = scripted((args, options) => {
            if (args[0] === 'fetch' && args.at(-1) === '+refs/heads/main:refs/remotes/origin/main') {
                throw new GitCommandError({ command: 'git fetch', exitCode: 128, stderr: "fatal: couldn't find remote ref refs/heads/main", cwd: '/repo' });
            }
            return base(args, options);
        });
        const { steps } = recordingTracker();
        const logs: string[] = [];
        await performWorktreeAdd(ops, REQUEST, { steps, log: (line) => logs.push(line) });
        expect(calls.map((call) => call.args.join(' ')).filter((line) => /^(fetch|ls-remote|remote|worktree)/.test(line))).toEqual([
            'fetch --no-tags --progress origin +refs/heads/main:refs/remotes/origin/main',
            'ls-remote --symref origin HEAD',
            'fetch --no-tags --progress origin +refs/heads/trunk:refs/remotes/origin/trunk',
            'remote set-head origin trunk',
            'worktree add -b x /wt/x origin/trunk'
        ]);
        expect(steps.snapshot().steps[0]).toEqual({ id: 'resolve-default-branch', status: 'done', detail: 'trunk (asked origin; origin/HEAD said main)' });
        expect(logs.some((line) => line.includes('named main, which origin no longer has; origin says trunk'))).toBe(true);
    });

    it('does not second-guess a name the remote itself gave, or any other fetch failure', async () => {
        const missing = new GitCommandError({ command: 'git fetch', exitCode: 128, stderr: "fatal: couldn't find remote ref refs/heads/main", cwd: '/repo' });
        // Asked the remote already (no local origin/HEAD): the failure stands.
        const asked = scripted((args, options) => (args[0] === 'fetch' ? Promise.reject(missing) : repoScript({ head: null, lsRemote: 'main' })(args, options)));
        await expect(performWorktreeAdd(asked.ops, REQUEST)).rejects.toBe(missing);
        expect(asked.calls.filter((call) => call.args[0] === 'ls-remote')).toHaveLength(1);
        // A local name, but a different failure (no network): no retry either.
        const offline = new GitCommandError({ command: 'git fetch', exitCode: 128, stderr: 'fatal: unable to access', cwd: '/repo' });
        const local = scripted((args, options) => (args[0] === 'fetch' ? Promise.reject(offline) : repoScript()(args, options)));
        await expect(performWorktreeAdd(local.ops, REQUEST)).rejects.toBe(offline);
        expect(local.calls.some((call) => call.args[0] === 'ls-remote')).toBe(false);
    });

    it('fails closed: a snapshot read that errors (not "no such ref") keeps the cleanup off that branch', async () => {
        const controller = new AbortController();
        let snapshotRead = true;
        const cleanup: string[][] = [];
        const { ops } = scripted((args) => {
            if (args[0] === 'rev-parse' && args[3] === 'refs/heads/x') {
                if (snapshotRead) {
                    snapshotRead = false;
                    // A transient spawn failure, not rev-parse's exit 1.
                    throw Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' });
                }
                return `${SHA}\n`; // after the cancel it exists, at a tip this add could have made
            }
            if (args[0] === 'rev-parse') return `${SHA}\n`;
            if (args[0] === 'worktree' && args[1] === 'add') {
                controller.abort();
                return '';
            }
            if (args[0] === 'branch' || (args[0] === 'worktree' && args[1] === 'remove')) cleanup.push([...args]);
            return '';
        });
        const logs: string[] = [];
        await expect(
            performWorktreeAdd(ops, { ...REQUEST, updateMain: false }, { signal: controller.signal, log: (line) => logs.push(line) })
        ).rejects.toBeInstanceOf(WorktreeCreateCancelledError);
        expect(cleanup.some((call) => call[0] === 'branch')).toBe(false);
    });

    it("with update main, a same-named origin branch's commit is not a tip this add could have made", async () => {
        const controller = new AbortController();
        const REMOTE_X = 'c'.repeat(40);
        let branchCreatedBySomeoneElse = false;
        const cleanup: string[][] = [];
        const { ops } = scripted((args) => {
            if (args[0] === 'symbolic-ref') return 'origin/main\n';
            if (args[0] === 'rev-parse') {
                const ref = args[3] ?? '';
                if (ref === 'refs/remotes/origin/main') return `${SHA}\n`;
                if (ref === 'refs/remotes/origin/x') return `${REMOTE_X}\n`;
                if (ref === 'refs/heads/x') return branchCreatedBySomeoneElse ? `${REMOTE_X}\n` : notFound();
                return notFound();
            }
            if (args[0] === 'worktree' && args[1] === 'add') {
                // Someone else makes `x` at origin/x while this add runs, then the cancel lands.
                branchCreatedBySomeoneElse = true;
                controller.abort();
                return '';
            }
            if (args[0] === 'branch') cleanup.push([...args]);
            return '';
        });
        await expect(performWorktreeAdd(ops, REQUEST, { signal: controller.signal })).rejects.toBeInstanceOf(WorktreeCreateCancelledError);
        expect(cleanup).toEqual([]);
    });

    it('an abort that lands as git exits still rolls the add back', async () => {
        const controller = new AbortController();
        const base = repoScript();
        const cleanup: string[][] = [];
        const { ops } = scripted((args, options) => {
            if (args[0] === 'worktree' && args[1] === 'add') {
                controller.abort(); // the cancel arrives while git is finishing successfully
                return '';
            }
            if ((args[0] === 'worktree' && args[1] === 'remove') || args[0] === 'branch') cleanup.push([...args]);
            return base(args, options);
        });
        await expect(performWorktreeAdd(ops, REQUEST, { signal: controller.signal })).rejects.toBeInstanceOf(WorktreeCreateCancelledError);
        // No real directory or branch appeared in this scripted repo, so the cleanup had nothing
        // it could prove was this request's except the (never-existing) path's registration.
        expect(cleanup).toEqual([['worktree', 'remove', '-f', '-f', '/wt/x']]);
    });
});

// ---------------------------------------------------------------------------
// Real git
// ---------------------------------------------------------------------------

const GIT = resolveGitExecutable();
const HAS_GIT = (() => {
    try {
        execFileSync(GIT, ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
})();
const roots: string[] = [];
const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 'kelpi',
    GIT_AUTHOR_EMAIL: 'kelpi@example.com',
    GIT_COMMITTER_NAME: 'kelpi',
    GIT_COMMITTER_EMAIL: 'kelpi@example.com'
};

function tmpDir(prefix: string): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `kelpi-wt294-${prefix}-`)));
    roots.push(dir);
    return dir;
}

function git(cwd: string, ...args: string[]): string {
    return execFileSync(GIT, args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
}

function tryGit(cwd: string, ...args: string[]): string | null {
    try {
        return git(cwd, ...args);
    } catch {
        return null;
    }
}

function commit(dir: string, file: string, text: string, message: string): string {
    fs.writeFileSync(path.join(dir, file), text);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', message);
    return git(dir, 'rev-parse', 'HEAD');
}

/** A bare origin, a seed clone that pushes to it, and the clone the create runs in. */
function fixture(): { root: string; origin: string; seed: string; work: string; first: string } {
    const root = tmpDir('fx');
    const origin = path.join(root, 'origin.git');
    const seed = path.join(root, 'seed');
    const work = path.join(root, 'work');
    git(root, 'init', '-q', '--bare', '--initial-branch=main', origin);
    git(root, 'clone', '-q', origin, seed);
    git(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    const first = commit(seed, 'README.md', '# app\n', 'first');
    git(seed, 'push', '-q', 'origin', 'main');
    git(root, 'clone', '-q', origin, work);
    return { root, origin, seed, work, first };
}

const realOps = (): WorktreeGitOps => worktreeGitOps(createGitRunner());

async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!check()) {
        if (Date.now() > deadline) throw new Error('timed out waiting');
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

/**
 * A post-checkout hook that marks when it starts (writing its shell's pid) and then holds
 * `worktree add` open. The pid lets a test prove the cancel killed git's CHILDREN too.
 */
function slowCheckoutHook(repo: string, marker: string): void {
    const hook = path.join(repo, '.git', 'hooks', 'post-checkout');
    fs.writeFileSync(hook, `#!/bin/sh\necho $$ > '${marker}'\nsleep 20\n`, { mode: 0o755 });
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/** An uploadpack wrapper that marks when the fetch reached the server, then stalls it. */
function slowUploadPack(root: string, repo: string, marker: string): void {
    const wrapper = path.join(root, 'slow-upload-pack.sh');
    fs.writeFileSync(wrapper, `#!/bin/sh\ntouch '${marker}'\nsleep 20\nexec git-upload-pack "$@"\n`, { mode: 0o755 });
    git(repo, 'config', 'remote.origin.uploadpack', wrapper);
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

describe.skipIf(!HAS_GIT)('performWorktreeAdd against real git', { timeout: 30_000 }, () => {
    it('resolves the default branch from origin/HEAD, then the remote, then main', async () => {
        const fx = fixture();
        const ops = realOps();
        expect(await resolveDefaultBranch(ops, fx.work)).toEqual({ branch: 'main', source: 'origin-head' });
        git(fx.work, 'remote', 'set-head', 'origin', '--delete');
        expect(await resolveDefaultBranch(ops, fx.work)).toEqual({ branch: 'main', source: 'ls-remote' });
        // A dangling origin/HEAD is not believed.
        git(fx.work, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone');
        expect(await resolveDefaultBranch(ops, fx.work)).toEqual({ branch: 'main', source: 'ls-remote' });
        git(fx.work, 'remote', 'remove', 'origin');
        expect(await resolveDefaultBranch(ops, fx.work)).toEqual({ branch: 'main', source: 'fallback' });
    });

    it('fetches only the default branch, no tags, and updates origin/<default> whatever the refspec says', async () => {
        const fx = fixture();
        const ahead = commit(fx.seed, 'CHANGELOG.md', 'latest\n', 'latest on origin');
        git(fx.seed, 'push', '-q', 'origin', 'main');
        git(fx.seed, 'tag', 'v1');
        git(fx.seed, 'push', '-q', 'origin', 'v1');
        git(fx.seed, 'checkout', '-q', '-b', 'other');
        commit(fx.seed, 'other.txt', 'other\n', 'other branch');
        git(fx.seed, 'push', '-q', 'origin', 'other');
        // A refspec that would never have updated origin/main on its own.
        git(fx.work, 'config', '--replace-all', 'remote.origin.fetch', '+refs/heads/nothing:refs/remotes/origin/nothing');

        await performWorktreeAdd(realOps(), { repoPath: fx.work, worktreePath: path.join(fx.root, 'wt', 'a'), branchName: 'a', updateMain: true });

        expect(git(fx.work, 'rev-parse', 'origin/main')).toBe(ahead);
        expect(tryGit(fx.work, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/other')).toBeNull();
        expect(tryGit(fx.work, 'rev-parse', '--verify', '--quiet', 'refs/tags/v1')).toBeNull();
        expect(git(path.join(fx.root, 'wt', 'a'), 'rev-parse', 'HEAD')).toBe(ahead);
    });

    it('cuts the worktree from the latest origin commit, reusing a prefetch that already fetched it', async () => {
        const fx = fixture();
        const ops = realOps();
        const logs: string[] = [];
        const cache = createDefaultBranchFetchCache({ ops, log: (line) => logs.push(line) });
        const latest = commit(fx.seed, 'CHANGELOG.md', 'latest\n', 'latest on origin');
        git(fx.seed, 'push', '-q', 'origin', 'main');
        expect(git(fx.work, 'rev-parse', 'origin/main')).toBe(fx.first);

        expect(cache.prefetch(fx.work)).toBe('started');
        await waitFor(() => cache.peek(fx.work)?.ok === true);
        expect(git(fx.work, 'rev-parse', 'origin/main')).toBe(latest);

        const { steps } = recordingTracker();
        const worktreePath = path.join(fx.root, 'wt', 'fix');
        await performWorktreeAdd(ops, { repoPath: fx.work, worktreePath, branchName: 'fix', updateMain: true }, { steps, fetches: cache, log: (line) => logs.push(line) });
        expect(git(worktreePath, 'rev-parse', 'HEAD')).toBe(latest);
        expect(git(worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('fix');
        expect(git(fx.work, 'rev-parse', 'main')).toBe(fx.first); // the local main is untouched
        expect(steps.snapshot().steps[1]).toMatchObject({ status: 'skipped', detail: expect.stringMatching(/^prefetched \d+\.\d s ago$/) as unknown as string });
        expect(logs.some((line) => line.includes('skipped') && line.includes('prefetched'))).toBe(true);
    });

    it('a cancel during the fetch kills it and leaves nothing behind', async () => {
        const fx = fixture();
        const marker = path.join(fx.root, 'fetch-started');
        slowUploadPack(fx.root, fx.work, marker);
        const branchesBefore = git(fx.work, 'branch', '--list');
        const controller = new AbortController();
        const { steps } = recordingTracker();
        const worktreePath = path.join(fx.root, 'wt', 'never');
        const started = Date.now();
        const pending = performWorktreeAdd(realOps(), { repoPath: fx.work, worktreePath, branchName: 'never', updateMain: true }, { steps, signal: controller.signal });
        await waitFor(() => fs.existsSync(marker));
        controller.abort();
        const error = await pending.catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(WorktreeCreateCancelledError);
        expect((error as WorktreeCreateCancelledError).step).toBe('fetch');
        // Killed, not waited out: the wrapper sleeps 20 s.
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(fs.existsSync(worktreePath)).toBe(false);
        expect(git(fx.work, 'branch', '--list')).toBe(branchesBefore);
        expect(steps.snapshot()).toMatchObject({ cancelled: true, steps: [{ status: 'done' }, { status: 'failed', error: 'cancelled' }, { status: 'pending' }, { status: 'pending' }] });
    });

    it('a cancel during worktree add removes the new worktree and branch, and only those', async () => {
        const fx = fixture();
        git(fx.work, 'branch', 'keep-me');
        const marker = path.join(fx.root, 'checkout-started');
        slowCheckoutHook(fx.work, marker);
        const controller = new AbortController();
        const worktreePath = path.join(fx.root, 'wt', 'doomed');
        const logs: string[] = [];
        const pending = performWorktreeAdd(realOps(), { repoPath: fx.work, worktreePath, branchName: 'doomed', updateMain: true }, { signal: controller.signal, log: (line) => logs.push(line) });
        await waitFor(() => fs.existsSync(marker));
        // Mid-add: git has made both the branch and the directory.
        expect(tryGit(fx.work, 'rev-parse', '--verify', '--quiet', 'refs/heads/doomed')).not.toBeNull();
        expect(fs.existsSync(worktreePath)).toBe(true);
        controller.abort();
        const error = await pending.catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(WorktreeCreateCancelledError);
        expect((error as WorktreeCreateCancelledError).step).toBe('worktree-add');
        expect(fs.existsSync(worktreePath)).toBe(false);
        expect(tryGit(fx.work, 'rev-parse', '--verify', '--quiet', 'refs/heads/doomed')).toBeNull();
        expect(git(fx.work, 'worktree', 'list', '--porcelain')).not.toContain('doomed');
        // What was there before is still there.
        expect(tryGit(fx.work, 'rev-parse', '--verify', '--quiet', 'refs/heads/keep-me')).not.toBeNull();
        expect(tryGit(fx.work, 'rev-parse', '--verify', '--quiet', 'refs/heads/main')).not.toBeNull();
        // git's own signal handler can beat the cleanup to the directory; either way it is gone.
        expect(logs.some((line) => /removed (worktree, )?branch doomed; no directory left$/.test(line))).toBe(true);
        // The hook git was running died with it: the whole process group was killed.
        const hookPid = Number(fs.readFileSync(marker, 'utf8').trim());
        expect(hookPid).toBeGreaterThan(0);
        await waitFor(() => !alive(hookPid), 3_000);
    });

    it('a cancel never deletes a directory that existed before the create', async () => {
        const fx = fixture();
        const marker = path.join(fx.root, 'checkout-started');
        slowCheckoutHook(fx.work, marker);
        const worktreePath = path.join(fx.root, 'wt', 'mine');
        fs.mkdirSync(worktreePath, { recursive: true }); // empty: git will happily fill it
        const controller = new AbortController();
        const logs: string[] = [];
        const pending = performWorktreeAdd(realOps(), { repoPath: fx.work, worktreePath, branchName: 'mine', updateMain: true }, { signal: controller.signal, log: (line) => logs.push(line) });
        await waitFor(() => fs.existsSync(marker));
        controller.abort();
        await expect(pending).rejects.toBeInstanceOf(WorktreeCreateCancelledError);
        expect(fs.existsSync(worktreePath)).toBe(true);
        expect(logs.some((line) => line.includes(`left ${worktreePath} alone`))).toBe(true);
    });

    it('a cancel of a plain (no update main) add attaching to an EXISTING branch never deletes it', async () => {
        const fx = fixture();
        git(fx.work, 'branch', 'existing');
        const tip = git(fx.work, 'rev-parse', 'existing');
        const marker = path.join(fx.root, 'checkout-started');
        slowCheckoutHook(fx.work, marker);
        const controller = new AbortController();
        const worktreePath = path.join(fx.root, 'wt', 'existing');
        const { steps } = recordingTracker(false);
        const pending = performWorktreeAdd(realOps(), { repoPath: fx.work, worktreePath, branchName: 'existing', updateMain: false }, { steps, signal: controller.signal });
        await waitFor(() => fs.existsSync(marker));
        controller.abort();
        await expect(pending).rejects.toBeInstanceOf(WorktreeCreateCancelledError);
        expect(git(fx.work, 'rev-parse', 'existing')).toBe(tip);
        expect(fs.existsSync(worktreePath)).toBe(false);
        expect(steps.snapshot()).toMatchObject({ cancelled: true, steps: [{ id: 'worktree-add', status: 'failed' }, { id: 'create-workspace', status: 'pending' }] });
    });

    it('a cancel of a plain add that made a NEW branch off HEAD deletes that branch', async () => {
        const fx = fixture();
        const marker = path.join(fx.root, 'checkout-started');
        slowCheckoutHook(fx.work, marker);
        const controller = new AbortController();
        const worktreePath = path.join(fx.root, 'wt', 'fresh');
        const pending = performWorktreeAdd(realOps(), { repoPath: fx.work, worktreePath, branchName: 'fresh', updateMain: false }, { signal: controller.signal });
        await waitFor(() => fs.existsSync(marker));
        controller.abort();
        await expect(pending).rejects.toBeInstanceOf(WorktreeCreateCancelledError);
        expect(tryGit(fx.work, 'rev-parse', '--verify', '--quiet', 'refs/heads/fresh')).toBeNull();
        expect(fs.existsSync(worktreePath)).toBe(false);
    });

    it('recovers when the remote renamed its default branch after the clone (stale origin/HEAD)', async () => {
        const fx = fixture();
        // Upstream renames main to trunk and moves it on; the clone still says origin/HEAD -> main.
        git(fx.origin, 'branch', '-m', 'main', 'trunk');
        git(fx.origin, 'symbolic-ref', 'HEAD', 'refs/heads/trunk');
        git(fx.seed, 'fetch', '-q', 'origin');
        git(fx.seed, 'checkout', '-q', '-B', 'trunk', 'origin/trunk');
        const latest = commit(fx.seed, 'after-rename.txt', 'x\n', 'after the rename');
        git(fx.seed, 'push', '-q', 'origin', 'trunk');
        expect(git(fx.work, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')).toBe('origin/main');
        expect(tryGit(fx.work, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main')).not.toBeNull();

        const logs: string[] = [];
        const worktreePath = path.join(fx.root, 'wt', 'renamed');
        const { steps } = recordingTracker();
        await performWorktreeAdd(realOps(), { repoPath: fx.work, worktreePath, branchName: 'renamed', updateMain: true }, { steps, log: (line) => logs.push(line) });
        expect(git(worktreePath, 'rev-parse', 'HEAD')).toBe(latest);
        // The local symref was refreshed, so the next create resolves without asking.
        expect(git(fx.work, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')).toBe('origin/trunk');
        expect(await resolveDefaultBranch(realOps(), fx.work)).toEqual({ branch: 'trunk', source: 'origin-head' });
        expect(steps.snapshot().steps[0]?.detail).toBe('trunk (asked origin; origin/HEAD said main)');
        expect(logs.some((line) => line.includes('pointed origin/HEAD'))).toBe(true);
    });

    it('the prefetch recovers from a stale origin/HEAD the same way, and a create then reuses it', async () => {
        const fx = fixture();
        git(fx.origin, 'branch', '-m', 'main', 'trunk');
        git(fx.origin, 'symbolic-ref', 'HEAD', 'refs/heads/trunk');
        const ops = realOps();
        const cache = createDefaultBranchFetchCache({ ops });
        expect(cache.prefetch(fx.work)).toBe('started');
        await waitFor(() => cache.peek(fx.work)?.finishedAt !== null);
        expect(cache.peek(fx.work)).toMatchObject({ ok: true, branch: 'trunk' });
        const { steps } = recordingTracker();
        const worktreePath = path.join(fx.root, 'wt', 'after-prefetch');
        await performWorktreeAdd(ops, { repoPath: fx.work, worktreePath, branchName: 'after-prefetch', updateMain: true }, { steps, fetches: cache });
        expect(git(worktreePath, 'rev-parse', 'HEAD')).toBe(git(fx.origin, 'rev-parse', 'trunk'));
        expect(steps.snapshot().steps[1]?.status).toBe('skipped');
    });

    it('the cleanup removes a LOCKED half-made worktree (checkout in progress) and then its branch', async () => {
        const fx = fixture();
        const ops = realOps();
        for (const gone of [false, true]) {
            const name = gone ? 'locked-gone' : 'locked-here';
            const worktreePath = path.join(fx.root, 'wt', name);
            const tip = git(fx.work, 'rev-parse', 'origin/main');
            git(fx.work, 'worktree', 'add', '-q', '-b', name, worktreePath, 'origin/main');
            git(fx.work, 'worktree', 'lock', '--reason', 'initializing', worktreePath);
            // `gone`: git was SIGKILLed after we removed nothing, and the directory went anyway.
            if (gone) fs.rmSync(worktreePath, { recursive: true, force: true });
            const removed = await cleanupCancelledWorktreeAdd(
                ops,
                { repoPath: fx.work, worktreePath, branchName: name, updateMain: true },
                { pathExisted: false, branchExisted: false, possibleTips: new Set([tip]) }
            );
            expect(removed).toContain(`branch ${name}`);
            expect(fs.existsSync(worktreePath)).toBe(false);
            expect(git(fx.work, 'worktree', 'list', '--porcelain')).not.toContain(name);
            expect(tryGit(fx.work, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`)).toBeNull();
        }
        // …and the next create with that name works.
        await performWorktreeAdd(ops, { repoPath: fx.work, worktreePath: path.join(fx.root, 'wt', 'locked-here'), branchName: 'locked-here', updateMain: true });
    });

    it("removes only its OWN leftover registration when git will not, never another's", async () => {
        const fx = fixture();
        const admin = path.join(fx.work, '.git', 'worktrees');
        fs.mkdirSync(path.join(admin, 'half'), { recursive: true });
        fs.mkdirSync(path.join(admin, 'someone-else'), { recursive: true });
        const ours = path.join(fx.root, 'wt', 'half');
        // What a git killed mid-registration leaves: a gitdir file and nothing else.
        fs.writeFileSync(path.join(admin, 'half', 'gitdir'), `${ours}/.git\n`);
        fs.writeFileSync(path.join(admin, 'someone-else', 'gitdir'), `${path.join(fx.root, 'elsewhere')}/.git\n`);
        // A git that refuses to remove it (whatever the reason): the cleanup's own step runs.
        const real = realOps();
        const refusing: WorktreeGitOps = {
            read: real.read,
            long: (args, cwd, options) =>
                args[0] === 'worktree' && args[1] === 'remove'
                    ? Promise.reject(new GitCommandError({ command: 'git worktree remove', exitCode: 128, stderr: "fatal: 'half' is not a working tree", cwd }))
                    : real.long(args, cwd, options)
        };
        const removed = await cleanupCancelledWorktreeAdd(
            refusing,
            { repoPath: fx.work, worktreePath: ours, branchName: 'half', updateMain: true },
            { pathExisted: false, branchExisted: false, possibleTips: new Set() }
        );
        expect(removed).toContain('worktree registration');
        expect(fs.existsSync(path.join(admin, 'half'))).toBe(false);
        expect(fs.existsSync(path.join(admin, 'someone-else'))).toBe(true);
    });

    it('a cancel MID-CHECKOUT waits for every process of git to be gone (SIGKILL for one ignoring SIGTERM) before cleaning up', async () => {
        const fx = fixture();
        // A smudge filter that ignores SIGTERM runs inside the checkout, with the worktree locked.
        fs.writeFileSync(path.join(fx.seed, '.gitattributes'), '*.slow filter=slow\n');
        fs.writeFileSync(path.join(fx.seed, 'big.slow'), 'slow\n');
        git(fx.seed, 'add', '.');
        git(fx.seed, 'commit', '-q', '-m', 'a slow file');
        git(fx.seed, 'push', '-q', 'origin', 'main');
        const marker = path.join(fx.root, 'smudge-started');
        const filter = path.join(fx.root, 'slow-smudge.sh');
        fs.writeFileSync(filter, `#!/bin/sh\ntrap '' TERM\necho $$ > '${marker}'\nsleep 30\ncat\n`, { mode: 0o755 });
        git(fx.work, 'config', 'filter.slow.smudge', filter);
        const ops = worktreeGitOps(createGitRunner({ abortGraceMs: 500 }));
        const controller = new AbortController();
        const worktreePath = path.join(fx.root, 'wt', 'mid');
        const pending = performWorktreeAdd(ops, { repoPath: fx.work, worktreePath, branchName: 'mid', updateMain: true }, { signal: controller.signal });
        await waitFor(() => fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() !== '');
        const filterPid = Number(fs.readFileSync(marker, 'utf8').trim());
        controller.abort();
        await expect(pending).rejects.toBeInstanceOf(WorktreeCreateCancelledError);
        // Settled only once the SIGTERM-proof filter was gone (SIGKILLed after the grace).
        expect(alive(filterPid)).toBe(false);
        expect(fs.existsSync(worktreePath)).toBe(false);
        expect(git(fx.work, 'worktree', 'list', '--porcelain')).not.toContain('/mid');
        expect(tryGit(fx.work, 'rev-parse', '--verify', '--quiet', 'refs/heads/mid')).toBeNull();
    });

    it('the cleanup leaves a new branch whose tip it cannot account for', async () => {
        const fx = fixture();
        // Someone else made `raced` at a commit this create would never have used.
        commit(fx.work, 'local.txt', 'local\n', 'local only');
        git(fx.work, 'branch', 'raced');
        const logs: string[] = [];
        const removed = await cleanupCancelledWorktreeAdd(
            realOps(),
            { repoPath: fx.work, worktreePath: path.join(fx.root, 'wt', 'raced'), branchName: 'raced', updateMain: true },
            { pathExisted: false, branchExisted: false, possibleTips: new Set([fx.first]) },
            (line) => logs.push(line)
        );
        expect(removed).toEqual([]);
        expect(tryGit(fx.work, 'rev-parse', '--verify', '--quiet', 'refs/heads/raced')).not.toBeNull();
        expect(logs.some((line) => line.includes('left branch raced alone'))).toBe(true);
    });
});
