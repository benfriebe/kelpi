/**
 * Graft engine integration tests against REAL git repos + worktrees in the temp dir.
 *
 * The sync engine's contract is entirely about what lands on disk (parent working tree, parent
 * refs, worktree index, breadcrumb file, stash list), so stubbing git would test nothing. The
 * whole suite skips when git is unavailable.
 *
 * The FS watcher is injected: real `fs.watch` timing would make "a batch triggers a sync"
 * flaky, and watcher discipline itself is covered by `watcher.test.ts`.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { createGitService, resolveGitExecutable, type GitService } from '../git/index.js';
import { breadcrumbPath, readBreadcrumb, writeBreadcrumb } from './breadcrumb.js';
import { GraftError } from './errors.js';
import { createGraftService, type GraftService } from './service.js';
import type { GraftAssociation } from './types.js';
import type { RecursiveWatchFn } from './watcher.js';

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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kelpi-graft-${prefix}-`));
    roots.push(dir);
    return dir;
}

function git(cwd: string, ...args: string[]): string {
    return execFileSync(GIT, args, {
        cwd,
        encoding: 'utf8',
        // Capture stderr instead of inheriting it: `git worktree add` chats about "Preparing
        // worktree" on every fixture and would drown the test output.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'kelpi',
            GIT_AUTHOR_EMAIL: 'kelpi@example.com',
            GIT_COMMITTER_NAME: 'kelpi',
            GIT_COMMITTER_EMAIL: 'kelpi@example.com',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null'
        }
    });
}

interface Fixture {
    /** The main checkout, canonicalized (what graft reports as `parentRepoRoot`). */
    readonly parent: string;
    readonly worktree: string;
    readonly association: GraftAssociation;
}

/** A parent repo with one commit + a linked worktree on branch `feature`. */
function fixture(prefix: string, associationID = 'ASSOC-1'): Fixture {
    const container = tmpDir(prefix);
    const parent = path.join(container, 'repo');
    fs.mkdirSync(parent);
    git(parent, 'init', '--initial-branch=main');
    fs.writeFileSync(path.join(parent, 'README.md'), '# hi\n');
    fs.writeFileSync(path.join(parent, 'keep.txt'), 'original\n');
    // `build/` stands in for node_modules: ignored, so neither the auto-stash
    // (`--include-untracked` skips ignored files) nor `read-tree` may touch it.
    fs.writeFileSync(path.join(parent, '.gitignore'), 'build/\n');
    git(parent, 'add', '.');
    git(parent, 'commit', '-m', 'initial');

    const worktree = path.join(container, 'wt-feature');
    git(parent, 'worktree', 'add', '-b', 'feature', worktree);

    return {
        parent: fs.realpathSync(parent),
        worktree: fs.realpathSync(worktree),
        association: { id: associationID, worktreePath: worktree, branchName: 'feature' }
    };
}

interface WatchControl {
    readonly fn: RecursiveWatchFn;
    /** Fire one raw change event for the watcher rooted at `root`. */
    fire(root: string, filename: string): void;
    readonly roots: string[];
}

function watchControl(): WatchControl {
    const listeners = new Map<string, (event: string, filename: string | null) => void>();
    const seen: string[] = [];
    return {
        fn: (root, cb) => {
            const key = fs.existsSync(root) ? fs.realpathSync(root) : root;
            seen.push(key);
            listeners.set(key, cb);
            return {
                close() {
                    listeners.delete(key);
                },
                on() {
                    return undefined;
                }
            };
        },
        fire(root, filename) {
            const key = fs.existsSync(root) ? fs.realpathSync(root) : root;
            listeners.get(key)?.('change', filename);
        },
        roots: seen
    };
}

function service(
    gitService: GitService,
    watch?: WatchControl
): GraftService {
    return createGraftService({
        git: gitService,
        debounceMs: 1,
        ...(watch !== undefined ? { watch: watch.fn } : {})
    });
}

function settle(ms = 30): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * A file the parent may be mid-`read-tree` on. `read-tree --reset -u` unlinks and rewrites
 * paths, so a poll that lands inside a sync pass can see the file missing for a few
 * milliseconds — "not there yet" is a false predicate, never an exception.
 */
function readOrEmpty(file: string): string {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return '';
    }
}

// Fixed delays race real git subprocesses when the whole suite runs in parallel; poll the
// condition instead of guessing how long a sync pass takes under load.
async function waitFor(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (condition()) return;
        await settle(40);
    }
    if (!condition()) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
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

describe.skipIf(!HAS_GIT)('graft start → sync', () => {
    it('mirrors modified, untracked and deleted files without moving the parent ref', async () => {
        const f = fixture('sync');
        const gitService = createGitService();
        const graft = service(gitService);

        const parentHeadBefore = git(f.parent, 'rev-parse', 'HEAD').trim();
        // Diverge the worktree: edit a tracked file, delete another, add an untracked one.
        fs.writeFileSync(path.join(f.worktree, 'README.md'), '# from the worktree\n');
        fs.rmSync(path.join(f.worktree, 'keep.txt'));
        fs.writeFileSync(path.join(f.worktree, 'new.txt'), 'brand new\n');

        const session = await graft.start(f.association);
        expect(session.parentRepoRoot).toBe(f.parent);
        expect(session.branch).toBe('feature');
        expect(session.status).toEqual({ kind: 'watching' });

        // The parent's working tree now matches the worktree's content…
        expect(fs.readFileSync(path.join(f.parent, 'README.md'), 'utf8')).toBe(
            '# from the worktree\n'
        );
        expect(fs.existsSync(path.join(f.parent, 'keep.txt'))).toBe(false);
        expect(fs.readFileSync(path.join(f.parent, 'new.txt'), 'utf8')).toBe('brand new\n');
        // …while its branch and HEAD stayed exactly where they were.
        expect(git(f.parent, 'rev-parse', 'HEAD').trim()).toBe(parentHeadBefore);
        expect(git(f.parent, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
        // And the worktree's own index/branch are untouched (the temp index did the work).
        expect(git(f.worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature');
        expect(git(f.worktree, 'diff', '--name-only', '--cached').trim()).toBe('');

        await graft.stop(session.id);
    }, 60_000);

    it('leaves the parent untracked files alone and restores everything on stop', async () => {
        const f = fixture('restore');
        const gitService = createGitService();
        const graft = service(gitService);

        // Parent-only untracked output (node_modules-ish) plus an uncommitted edit.
        fs.mkdirSync(path.join(f.parent, 'build'));
        fs.writeFileSync(path.join(f.parent, 'build', 'out.js'), 'compiled\n');
        fs.writeFileSync(path.join(f.parent, 'keep.txt'), 'local edit\n');

        fs.writeFileSync(path.join(f.worktree, 'README.md'), '# grafted\n');
        const session = await graft.start(f.association);
        expect(session.stashRef).not.toBeNull();
        // Untracked build output survives the read-tree.
        expect(fs.readFileSync(path.join(f.parent, 'build', 'out.js'), 'utf8')).toBe('compiled\n');
        expect(fs.readFileSync(path.join(f.parent, 'README.md'), 'utf8')).toBe('# grafted\n');

        await graft.stop(session.id);
        // The stash was popped: the local edit is back and the graft content is gone.
        expect(fs.readFileSync(path.join(f.parent, 'keep.txt'), 'utf8')).toBe('local edit\n');
        expect(fs.readFileSync(path.join(f.parent, 'README.md'), 'utf8')).toBe('# hi\n');
        expect(fs.readFileSync(path.join(f.parent, 'build', 'out.js'), 'utf8')).toBe('compiled\n');
        expect(git(f.parent, 'stash', 'list').trim()).toBe('');
        expect(graft.activeSessions()).toEqual([]);
        expect(fs.existsSync(breadcrumbPath(f.parent))).toBe(false);
    }, 60_000);

    it('clobbers a colliding parent file (the mirror is one-way) but never an ignored one', async () => {
        const f = fixture('collision');
        const gitService = createGitService();
        const watch = watchControl();
        const graft = service(gitService, watch);

        const session = await graft.start(f.association);
        expect(session.status).toEqual({ kind: 'watching' });

        // The parent grows a file at a path the worktree is about to track, plus ignored
        // build output at a path the worktree also has.
        fs.writeFileSync(path.join(f.parent, 'clash.txt'), 'parent copy\n');
        fs.mkdirSync(path.join(f.parent, 'build'), { recursive: true });
        fs.writeFileSync(path.join(f.parent, 'build', 'out.js'), 'parent build\n');
        fs.writeFileSync(path.join(f.worktree, 'clash.txt'), 'worktree copy\n');
        fs.mkdirSync(path.join(f.worktree, 'build'), { recursive: true });
        fs.writeFileSync(path.join(f.worktree, 'build', 'out.js'), 'worktree build\n');

        watch.fire(f.worktree, 'clash.txt');
        await settle(150);
        await waitFor(() => graft.session(session.id)?.status.kind === 'watching');

        // "Changes made directly in the parent while grafting will be clobbered by the next
        // sync pass" (§1): git's `read-tree --reset -u` overwrites the parent's copy without
        // complaint. (The Swift-era doc describes a git version that refused with "Untracked
        // working tree file … would be overwritten"; `describeSyncError` still renders that
        // stderr specially — see errors.test.ts — but modern git does not emit it here.)
        expect(graft.session(session.id)?.status).toEqual({ kind: 'watching' });
        expect(fs.readFileSync(path.join(f.parent, 'clash.txt'), 'utf8')).toBe('worktree copy\n');
        // The IGNORED file is not in the worktree's tree at all, so it survives untouched.
        expect(fs.readFileSync(path.join(f.parent, 'build', 'out.js'), 'utf8')).toBe(
            'parent build\n'
        );

        await graft.stop(session.id);
    }, 60_000);

    it('keeps a session alive through a failed pass and recovers on the next batch', async () => {
        const f = fixture('retry');
        const watch = watchControl();
        const graft = service(createGitService(), watch);
        const session = await graft.start(f.association);

        // An operation in flight IN THE WORKTREE must abort the pass: write-tree would
        // otherwise snapshot conflict markers straight into the parent.
        const worktreeGitDir = git(f.worktree, 'rev-parse', '--absolute-git-dir').trim();
        fs.writeFileSync(path.join(worktreeGitDir, 'MERGE_HEAD'), 'deadbeef\n');
        fs.writeFileSync(path.join(f.worktree, 'wip.txt'), 'half-merged\n');
        watch.fire(f.worktree, 'wip.txt');
        await settle(150);
        await waitFor(() => graft.session(session.id)?.status.kind === 'error');

        const errored = graft.session(session.id);
        expect(errored?.status.kind).toBe('error');
        const message = errored?.status.kind === 'error' ? errored.status.message : '';
        expect(message).toBe('Sync failed: repository is busy: merge in progress');
        expect(fs.existsSync(path.join(f.parent, 'wip.txt'))).toBe(false);
        // The session keeps the watcher, the claim and the breadcrumb.
        expect(graft.claimedRoots()).toEqual([f.parent]);
        expect(fs.existsSync(breadcrumbPath(f.parent))).toBe(true);

        fs.rmSync(path.join(worktreeGitDir, 'MERGE_HEAD'));
        watch.fire(f.worktree, 'wip.txt');
        await settle(150);
        await waitFor(() => graft.session(session.id)?.status.kind === 'watching');
        expect(graft.session(session.id)?.status).toEqual({ kind: 'watching' });
        expect(fs.readFileSync(path.join(f.parent, 'wip.txt'), 'utf8')).toBe('half-merged\n');

        await graft.stop(session.id);
    }, 60_000);

    it('syncs on a watcher batch (debounced) and keeps passes serial', async () => {
        const f = fixture('watch');
        const gitService = createGitService();
        const watch = watchControl();
        const graft = service(gitService, watch);

        const session = await graft.start(f.association);
        expect(watch.roots).toContain(f.worktree);

        fs.writeFileSync(path.join(f.worktree, 'live.txt'), 'v1\n');
        watch.fire(f.worktree, 'live.txt');
        await waitFor(() => fs.existsSync(path.join(f.parent, 'live.txt')));
        expect(fs.readFileSync(path.join(f.parent, 'live.txt'), 'utf8')).toBe('v1\n');

        // Two batches back to back: the second is buffered and drains after the first.
        fs.writeFileSync(path.join(f.worktree, 'live.txt'), 'v2\n');
        watch.fire(f.worktree, 'live.txt');
        fs.writeFileSync(path.join(f.worktree, 'live.txt'), 'v3\n');
        watch.fire(f.worktree, 'live.txt');
        await waitFor(
            () =>
                readOrEmpty(path.join(f.parent, 'live.txt')) === 'v3\n' &&
                graft.session(session.id)?.status.kind === 'watching'
        );
        expect(fs.readFileSync(path.join(f.parent, 'live.txt'), 'utf8')).toBe('v3\n');
        expect(graft.session(session.id)?.status).toEqual({ kind: 'watching' });

        await graft.stop(session.id);
        // After stop, a stale batch must not re-apply anything.
        fs.writeFileSync(path.join(f.worktree, 'late.txt'), 'nope\n');
        watch.fire(f.worktree, 'late.txt');
        await settle(80);
        expect(fs.existsSync(path.join(f.parent, 'late.txt'))).toBe(false);
    }, 60_000);
});

describe.skipIf(!HAS_GIT)('claims and guards', () => {
    it('refuses a second graft into the same parent, and frees the root on stop', async () => {
        const f = fixture('claim');
        const second = path.join(path.dirname(f.worktree), 'wt-other');
        git(f.parent, 'worktree', 'add', '-b', 'other', second);
        const gitService = createGitService();
        const graft = service(gitService);

        const session = await graft.start(f.association);
        expect(graft.claimedRoots()).toEqual([f.parent]);

        const failure = await graft
            .start({ id: 'ASSOC-2', worktreePath: second, branchName: 'other' })
            .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(GraftError);
        expect((failure as GraftError).kind).toBe('alreadyActive');
        expect((failure as GraftError).parentRepoRoot).toBe(f.parent);
        expect(graft.activeSessions()).toHaveLength(1);

        await graft.stop(session.id);
        expect(graft.claimedRoots()).toEqual([]);
        // With the claim released the other worktree can take over.
        const swapped = await graft.start({
            id: 'ASSOC-2',
            worktreePath: second,
            branchName: 'other'
        });
        expect(swapped.branch).toBe('other');
        await graft.stop(swapped.id);
    }, 60_000);

    it('rejects the main checkout and a path that is not a repo', async () => {
        const f = fixture('guards');
        const graft = service(createGitService());

        const notAWorktree = await graft
            .start({ id: 'A', worktreePath: f.parent, branchName: 'main' })
            .catch((error: unknown) => error);
        expect((notAWorktree as GraftError).kind).toBe('notAWorktree');

        const missing = await graft
            .start({ id: 'B', worktreePath: path.join(f.parent, 'nope'), branchName: null })
            .catch((error: unknown) => error);
        expect((missing as GraftError).kind).toBe('missingWorktree');
        expect(graft.claimedRoots()).toEqual([]);
    }, 60_000);

    it('refuses to start while the parent has an operation in flight', async () => {
        const f = fixture('busy');
        // A merge marker is all `repoState` looks for.
        fs.writeFileSync(path.join(f.parent, '.git', 'MERGE_HEAD'), 'deadbeef\n');
        const graft = service(createGitService());

        const failure = await graft.start(f.association).catch((error: unknown) => error);
        expect((failure as GraftError).kind).toBe('repoBusy');
        expect((failure as GraftError).state).toBe('merge in progress');
        // Nothing was stashed or written, and the claim is released.
        expect(graft.claimedRoots()).toEqual([]);
        expect(fs.existsSync(breadcrumbPath(f.parent))).toBe(false);
    }, 60_000);

    it('canonicalizes /tmp vs /private/tmp into one claim', async () => {
        const f = fixture('canon');
        const graft = service(createGitService());
        // The association addresses the worktree through the pre-realpath spelling.
        const session = await graft.start(f.association);
        expect(path.isAbsolute(session.parentRepoRoot)).toBe(true);
        expect(session.parentRepoRoot).toBe(fs.realpathSync(session.parentRepoRoot));
        await graft.stop(session.id);
    }, 60_000);
});

describe.skipIf(!HAS_GIT)('stop semantics', () => {
    it('is an idempotent no-op for an id it never knew', async () => {
        const graft = service(createGitService());
        await expect(graft.stop('NOT-A-SESSION')).resolves.toBeUndefined();
    }, 30_000);

    it('coalesces concurrent stops onto one teardown', async () => {
        const f = fixture('coalesce');
        const real = createGitService();
        let resets = 0;
        let pops = 0;
        const counting: GitService = {
            ...real,
            resetHard: async (repoPath, sha) => {
                resets += 1;
                await real.resetHard(repoPath, sha);
            },
            stashPopRef: async (repoPath, ref) => {
                pops += 1;
                await real.stashPopRef(repoPath, ref);
            }
        };
        const graft = service(counting);

        fs.writeFileSync(path.join(f.parent, 'keep.txt'), 'local edit\n');
        fs.writeFileSync(path.join(f.worktree, 'README.md'), '# grafted\n');
        const session = await graft.start(f.association);

        const [a, b, c] = await Promise.allSettled([
            graft.stop(session.id),
            graft.stop(session.id),
            graft.stop(session.id)
        ]);
        expect([a?.status, b?.status, c?.status]).toEqual([
            'fulfilled',
            'fulfilled',
            'fulfilled'
        ]);
        // The restore + pop ran exactly once, not once per caller.
        expect(resets).toBe(1);
        expect(pops).toBe(1);
        expect(fs.readFileSync(path.join(f.parent, 'keep.txt'), 'utf8')).toBe('local edit\n');
    }, 60_000);

    it('propagates a stash-pop conflict as a typed error and keeps the breadcrumb', async () => {
        const f = fixture('conflict');
        const real = createGitService();
        // A pop conflict is genuinely hard to stage (the restore resets the parent back to the
        // exact commit the stash was taken against), so the failure is injected at the one
        // primitive under test — everything else in the stop sequence is real.
        const conflicting: GitService = {
            ...real,
            stashPopRef: async () => {
                throw new Error('CONFLICT (content): Merge conflict in keep.txt');
            }
        };
        const graft = service(conflicting);

        fs.writeFileSync(path.join(f.parent, 'keep.txt'), 'parent edit\n');
        fs.writeFileSync(path.join(f.worktree, 'README.md'), '# grafted\n');
        const session = await graft.start(f.association);
        expect(session.stashRef).not.toBeNull();

        const failure = await graft.stop(session.id).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(GraftError);
        expect((failure as GraftError).kind).toBe('stashPopConflict');
        // Session dropped (claim released) but the recovery breadcrumb + stash stay on disk.
        expect(graft.activeSessions()).toEqual([]);
        expect(fs.existsSync(breadcrumbPath(f.parent))).toBe(true);
        expect(git(f.parent, 'stash', 'list').trim()).not.toBe('');
    }, 60_000);

    it('flushes every session on shutdown so a clean quit leaves no breadcrumb', async () => {
        const f = fixture('shutdown');
        const graft = service(createGitService());
        const session = await graft.start(f.association);
        expect(fs.existsSync(breadcrumbPath(f.parent))).toBe(true);
        await graft.shutdown();
        expect(graft.activeSessions()).toEqual([]);
        expect(fs.existsSync(breadcrumbPath(f.parent))).toBe(false);
        void session;
    }, 60_000);
});

describe.skipIf(!HAS_GIT)('breadcrumbs and orphan recovery', () => {
    it('writes a breadcrumb for the live session and recovers it after a crash', async () => {
        const f = fixture('crash');
        const crashed = service(createGitService());

        fs.writeFileSync(path.join(f.parent, 'keep.txt'), 'unsaved work\n');
        fs.writeFileSync(path.join(f.worktree, 'README.md'), '# grafted\n');
        const session = await crashed.start(f.association);

        const crumb = readBreadcrumb(f.parent);
        expect(crumb?.assocId).toBe(session.id);
        expect(crumb?.stashed).toBe(true);
        expect(crumb?.preGraftBranch).toBe('main');
        expect(crumb?.worktreePreGraftSha).toBeNull();
        expect(fs.readFileSync(path.join(f.parent, 'README.md'), 'utf8')).toBe('# grafted\n');

        // "Crash": a brand-new service instance, no in-memory sessions, breadcrumb on disk.
        const relaunched = service(createGitService());
        expect(relaunched.activeSessions()).toEqual([]);
        const orphans = relaunched.detectOrphans([f.parent, f.parent, '/not/a/repo']);
        expect(orphans).toHaveLength(1);
        expect(orphans[0]?.parentRepoRoot).toBe(f.parent);
        expect(orphans[0]?.worktreePath).toBe(f.association.worktreePath);

        await relaunched.recoverOrphan(orphans[0]!);
        expect(fs.readFileSync(path.join(f.parent, 'README.md'), 'utf8')).toBe('# hi\n');
        expect(fs.readFileSync(path.join(f.parent, 'keep.txt'), 'utf8')).toBe('unsaved work\n');
        expect(git(f.parent, 'stash', 'list').trim()).toBe('');
        expect(fs.existsSync(breadcrumbPath(f.parent))).toBe(false);
        expect(relaunched.detectOrphans([f.parent])).toEqual([]);
    }, 60_000);

    it('recovers a LEGACY breadcrumb: no preGraftSha → checkout -f HEAD fallback', async () => {
        const f = fixture('legacy');
        const graft = service(createGitService());
        // Simulate the pre-capture design: drift in the parent, breadcrumb without refs.
        fs.writeFileSync(path.join(f.parent, 'README.md'), '# drifted\n');
        writeBreadcrumb(f.parent, {
            version: 1,
            stashed: false,
            assocId: 'not-a-uuid',
            stashRef: null,
            worktreePath: f.worktree,
            branch: 'feature',
            preGraftBranch: null,
            preGraftSha: null,
            worktreePreGraftSha: null
        });

        const orphans = graft.detectOrphans([f.parent]);
        expect(orphans).toHaveLength(1);
        // An unparseable assocId gets a fresh id rather than being dropped.
        expect(orphans[0]?.id).not.toBe('not-a-uuid');
        await graft.recoverOrphan(orphans[0]!);
        expect(fs.readFileSync(path.join(f.parent, 'README.md'), 'utf8')).toBe('# hi\n');
        expect(fs.existsSync(breadcrumbPath(f.parent))).toBe(false);
    }, 60_000);

    it('rewinds the worktree for a LEGACY commit-based breadcrumb', async () => {
        const f = fixture('legacy-commit');
        const graft = service(createGitService());
        const before = git(f.worktree, 'rev-parse', 'HEAD').trim();
        // A checkpoint commit of the old design, still sitting on the worktree's branch.
        fs.writeFileSync(path.join(f.worktree, 'checkpoint.txt'), 'wip\n');
        git(f.worktree, 'add', '.');
        git(f.worktree, 'commit', '-m', 'kelpi graft checkpoint');
        expect(git(f.worktree, 'rev-parse', 'HEAD').trim()).not.toBe(before);

        writeBreadcrumb(f.parent, {
            version: 1,
            stashed: false,
            assocId: '5E9C1B4E-6C1D-4A6B-9A87-2C51F0B0D001',
            stashRef: null,
            worktreePath: f.worktree,
            branch: 'feature',
            preGraftBranch: 'main',
            preGraftSha: git(f.parent, 'rev-parse', 'HEAD').trim(),
            worktreePreGraftSha: before
        });
        const orphan = graft.detectOrphans([f.parent])[0]!;
        expect(orphan.id).toBe('5E9C1B4E-6C1D-4A6B-9A87-2C51F0B0D001');
        await graft.recoverOrphan(orphan);
        // The checkpoint commit is rewound (mixed: the file stays in the working tree).
        expect(git(f.worktree, 'rev-parse', 'HEAD').trim()).toBe(before);
        expect(fs.existsSync(path.join(f.worktree, 'checkpoint.txt'))).toBe(true);
    }, 60_000);

    it('dismissOrphan deletes the breadcrumb and leaves the stash alone', async () => {
        const f = fixture('dismiss');
        const graft = service(createGitService());
        writeBreadcrumb(f.parent, {
            version: 1,
            stashed: false,
            assocId: 'x',
            stashRef: null,
            worktreePath: f.worktree,
            branch: 'feature',
            preGraftBranch: 'main',
            preGraftSha: null,
            worktreePreGraftSha: null
        });
        const orphan = graft.detectOrphans([f.parent])[0]!;
        graft.dismissOrphan(orphan);
        expect(fs.existsSync(breadcrumbPath(f.parent))).toBe(false);
    }, 60_000);
});

describe.skipIf(!HAS_GIT)('event stream', () => {
    it('emits started → updated (syncing/watching) → stopped', async () => {
        const f = fixture('events');
        const watch = watchControl();
        const graft = service(createGitService(), watch);
        const kinds: string[] = [];
        const off = graft.updates((event) => {
            kinds.push(
                event.kind === 'stopped' ? 'stopped' : `${event.kind}:${event.session.status.kind}`
            );
        });

        const session = await graft.start(f.association);
        fs.writeFileSync(path.join(f.worktree, 'a.txt'), 'a\n');
        watch.fire(f.worktree, 'a.txt');
        await settle(120);
        await graft.stop(session.id);
        off();

        expect(kinds[0]).toBe('started:watching');
        expect(kinds).toContain('updated:syncing');
        expect(kinds).toContain('updated:watching');
        expect(kinds.at(-1)).toBe('stopped');

        // Unsubscribed listeners stop receiving events.
        const before = kinds.length;
        await graft.start(f.association).then((s) => graft.stop(s.id));
        expect(kinds).toHaveLength(before);
    }, 60_000);
});
