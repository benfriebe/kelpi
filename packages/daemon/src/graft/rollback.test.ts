/**
 * Graft's FAILURE branches, against real git repos + worktrees in a temp dir.
 *
 * `service.test.ts` covers the happy path and the one injected stop-time stash-pop conflict.
 * What lives here is the other half of the contract — every branch that only runs when
 * something has already gone wrong, and whose whole job is to leave the user's repository the
 * way it found it:
 *
 *   §GIT-008  a start that fails AFTER the auto-stash pops it back, releases the mid-start
 *             claim and rethrows the ORIGINAL error; if the rollback pop ALSO fails the stash
 *             is left in place and a recovery breadcrumb is written instead.
 *   §GIT-009  the initial sync pass runs inside start; on failure the breadcrumb is removed,
 *             the stash rolled back and the sync error surfaced — nothing left half-grafted.
 *   §GIT-027  a failed parent restore during stop drops the in-memory session (releasing the
 *             root claim) but KEEPS the breadcrumb, so the orphan banner is the way back.
 *             Except (#342) when the failure is another process holding the index lock: the
 *             session is kept as stop-incomplete, visible and claimed, and the next stop
 *             finishes it. A removal path (`dropOnFailure`) still drops it.
 *   §GIT-032  "Restore" replays the sequence from the breadcrumb; any failure leaves the
 *             breadcrumb (and the stash) for a retry.
 *   §GIT-033  "Dismiss" deletes the breadcrumb only — the stash and the parent are untouched.
 *
 * The failures are made to happen for real wherever git can be made to fail for real: a merge
 * marker in the worktree aborts the sync pass, a directory sitting where the breadcrumb file
 * goes makes the write throw, an `index.lock` in the parent makes checkout/reset/stash-pop
 * fail exactly the way a crashed git leaves them, and a breadcrumb naming a SHA the repo does
 * not have makes the restore fail the way a re-cloned parent would. Only the *timing* of the
 * lock is scripted (a passthrough wrapper plants it at the moment the sync is about to fail),
 * plus one deliberately injected `stashPopRef` for the recovery-conflict case, which is
 * genuinely unstageable — the restore resets the parent back to the commit the stash was taken
 * against, so a real pop always applies cleanly.
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
import type { GraftAssociation, GraftOrphan } from './types.js';

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
    /** The worktree's resolved git dir, where a merge marker goes. */
    readonly worktreeGitDir: string;
}

/**
 * A parent repo with one commit + a linked worktree on branch `feature`, with the worktree
 * already diverged (so a successful sync is visible in the parent) and the parent carrying an
 * uncommitted edit (so every start has a stash to roll back).
 */
function fixture(prefix: string, associationID = 'ASSOC-1'): Fixture {
    const container = tmpDir(prefix);
    const parent = path.join(container, 'repo');
    fs.mkdirSync(parent);
    git(parent, 'init', '--initial-branch=main');
    fs.writeFileSync(path.join(parent, 'README.md'), '# hi\n');
    fs.writeFileSync(path.join(parent, 'keep.txt'), 'original\n');
    git(parent, 'add', '.');
    git(parent, 'commit', '-m', 'initial');

    const worktree = path.join(container, 'wt-feature');
    git(parent, 'worktree', 'add', '-b', 'feature', worktree);
    fs.writeFileSync(path.join(worktree, 'MIRROR.md'), 'from the worktree\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-m', 'worktree work');

    // The parent's own uncommitted work — the thing the auto-stash holds and every rollback
    // below has to hand back.
    fs.writeFileSync(path.join(parent, 'keep.txt'), 'local edit\n');

    return {
        parent: fs.realpathSync(parent),
        worktree: fs.realpathSync(worktree),
        association: { id: associationID, worktreePath: worktree, branchName: 'feature' },
        worktreeGitDir: git(worktree, 'rev-parse', '--absolute-git-dir').trim()
    };
}

interface Reported {
    readonly error: Error;
    readonly context: string;
}

interface Harness {
    readonly graft: GraftService;
    readonly reported: Reported[];
}

function service(gitService: GitService): Harness {
    const reported: Reported[] = [];
    const graft = createGraftService({
        git: gitService,
        debounceMs: 1,
        // A planted lock is never released mid-stop here; keep the #342 retries short.
        lockRetryDelaysMs: [5, 5],
        onError: (error, context) => {
            reported.push({ error, context });
        }
    });
    return { graft, reported };
}

/** The parent as the fixture left it: HEAD unmoved, on main, the local edit intact. */
function expectParentUntouched(f: Fixture): void {
    expect(fs.readFileSync(path.join(f.parent, 'keep.txt'), 'utf8')).toBe('local edit\n');
    expect(fs.readFileSync(path.join(f.parent, 'README.md'), 'utf8')).toBe('# hi\n');
    expect(fs.existsSync(path.join(f.parent, 'MIRROR.md'))).toBe(false);
    expect(git(f.parent, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(git(f.parent, 'stash', 'list').trim()).toBe('');
}

function stashCount(repo: string): number {
    const out = git(repo, 'stash', 'list').trim();
    return out === '' ? 0 : out.split('\n').length;
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

describe.skipIf(!HAS_GIT)('start rollback', () => {
    it('unwinds the stash and leaves nothing half-grafted when the first sync pass fails', async () => {
        const f = fixture('sync-fail');
        const { graft } = service(createGitService());
        const headBefore = git(f.parent, 'rev-parse', 'HEAD').trim();

        // A merge in flight IN THE WORKTREE: `runSyncPass` refuses rather than snapshotting
        // conflict markers into the parent. This is §GIT-009's failure, unfaked.
        fs.writeFileSync(path.join(f.worktreeGitDir, 'MERGE_HEAD'), 'deadbeef\n');

        const failure = await graft.start(f.association).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(GraftError);
        // The ORIGINAL sync error, not whatever the rollback did afterwards.
        expect((failure as GraftError).kind).toBe('repoBusy');
        expect((failure as GraftError).state).toBe('merge in progress');

        // Nothing left half-grafted: no breadcrumb (it would raise a bogus recovery banner),
        // no session, no claim, and the parent is byte-for-byte what it was.
        expect(fs.existsSync(breadcrumbPath(f.parent))).toBe(false);
        expect(graft.activeSessions()).toEqual([]);
        expect(graft.claimedRoots()).toEqual([]);
        expectParentUntouched(f);
        expect(git(f.parent, 'rev-parse', 'HEAD').trim()).toBe(headBefore);
        // The only thing git can see is the user's own edit — no grafted paths, staged or not.
        expect(git(f.parent, 'status', '--porcelain').trim()).toBe('M keep.txt');

        // …and the retry the user is invited to make actually works.
        fs.rmSync(path.join(f.worktreeGitDir, 'MERGE_HEAD'));
        const session = await graft.start(f.association);
        expect(session.status).toEqual({ kind: 'watching' });
        expect(fs.readFileSync(path.join(f.parent, 'MIRROR.md'), 'utf8')).toBe('from the worktree\n');
        await graft.stop(session.id);
        expectParentUntouched(f);
    }, 60_000);

    it('rolls back a failure raised BEFORE the breadcrumb is written', async () => {
        const f = fixture('crumb-fail');
        const { graft } = service(createGitService());
        // A directory sitting where the breadcrumb file goes: `writeBreadcrumb` throws EISDIR
        // (the same shape an unwritable git dir produces), which is a post-stash failure with
        // no breadcrumb and no sync behind it.
        fs.mkdirSync(breadcrumbPath(f.parent));

        const failure = await graft.start(f.association).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as GraftError).kind).toBeUndefined();
        expect(String((failure as Error).message)).toContain('EISDIR');

        // The stash went back in, the claim was released, and the bogus "breadcrumb" the test
        // planted is not readable as one (so no phantom orphan).
        expect(graft.claimedRoots()).toEqual([]);
        expect(graft.activeSessions()).toEqual([]);
        expect(readBreadcrumb(f.parent)).toBeNull();
        expectParentUntouched(f);

        fs.rmdirSync(breadcrumbPath(f.parent));
        const session = await graft.start(f.association);
        expect(session.stashRef).not.toBeNull();
        await graft.stop(session.id);
        expectParentUntouched(f);
    }, 60_000);

    it('keeps the stash and writes a recovery breadcrumb when the rollback pop also fails', async () => {
        const f = fixture('rollback-pop-fail');
        const real = createGitService();
        const lockPath = path.join(f.parent, '.git', 'index.lock');
        // Everything is real git; the wrapper only decides WHEN the parent becomes unusable.
        // The lock lands at the instant the sync pass gives up, so the rollback's `stash pop`
        // hits the same "another git process is running" wall a crashed git leaves behind.
        const lockingGit: GitService = {
            ...real,
            repoState: async (repoPath) => {
                const state = await real.repoState(repoPath);
                if (state !== 'clean' && !fs.existsSync(lockPath)) fs.writeFileSync(lockPath, '');
                return state;
            }
        };
        const { graft, reported } = service(lockingGit);
        fs.writeFileSync(path.join(f.worktreeGitDir, 'MERGE_HEAD'), 'deadbeef\n');

        const failure = await graft.start(f.association).catch((error: unknown) => error);
        // The user still sees the ORIGINAL failure, not the rollback's.
        expect((failure as GraftError).kind).toBe('repoBusy');
        expect(fs.existsSync(lockPath)).toBe(true);

        // The user's uncommitted work is now only in the stash…
        expect(stashCount(f.parent)).toBe(1);
        expect(fs.readFileSync(path.join(f.parent, 'keep.txt'), 'utf8')).toBe('original\n');
        // …so a breadcrumb has to exist to offer it back.
        const crumb = readBreadcrumb(f.parent);
        expect(crumb?.stashed).toBe(true);
        expect(crumb?.assocId).toBe(f.association.id);
        expect(crumb?.stashRef).toBe(git(f.parent, 'rev-parse', 'refs/stash').trim());
        expect(crumb?.preGraftBranch).toBe('main');
        expect(crumb?.preGraftSha).toBe(git(f.parent, 'rev-parse', 'HEAD').trim());
        // The claim is released either way: the root must stay graftable after a retry.
        expect(graft.claimedRoots()).toEqual([]);
        expect(graft.activeSessions()).toEqual([]);
        expect(reported.map((entry) => entry.context)).toContain('graft rollback stash pop');

        // And the breadcrumb is a real route back, not a note: clear the wreckage and recover.
        fs.rmSync(lockPath);
        fs.rmSync(path.join(f.worktreeGitDir, 'MERGE_HEAD'));
        const relaunched = service(createGitService()).graft;
        const orphan = relaunched.detectOrphans([f.parent])[0] as GraftOrphan;
        expect(orphan.parentRepoRoot).toBe(f.parent);
        await relaunched.recoverOrphan(orphan);
        expectParentUntouched(f);
        expect(fs.existsSync(breadcrumbPath(f.parent))).toBe(false);
    }, 60_000);
});

describe.skipIf(!HAS_GIT)('stop rollback', () => {
    it('keeps a stop-incomplete session when the restore hits a held index lock, and the next stop finishes it', async () => {
        const f = fixture('restore-locked');
        const { graft } = service(createGitService());
        // Prepared before anything is locked: the rival worktree the claim check below needs.
        const second = path.join(path.dirname(f.worktree), 'wt-other');
        git(f.parent, 'worktree', 'add', '-b', 'other', second);

        const session = await graft.start(f.association);
        expect(fs.readFileSync(path.join(f.parent, 'MIRROR.md'), 'utf8')).toBe('from the worktree\n');
        const events: string[] = [];
        const off = graft.updates((event) => {
            events.push(event.kind);
        });

        // Another git process holds the lock through every retry: `checkout -f` / `reset --hard`
        // refuse before touching anything.
        const lockPath = path.join(f.parent, '.git', 'index.lock');
        fs.writeFileSync(lockPath, '');

        const failure = await graft.stop(session.id).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(GraftError);
        const message = (failure as GraftError).message;
        expect(message).toMatch(/^stop incomplete: /);
        expect(message).toContain('index.lock');
        expect(message).toContain(`kelpi graft stop --repo ${f.parent}`);

        // #342: the session stays, visibly not finished, and still owns the root; `graft status`
        // can never say "nothing is grafted" over a parent that still holds the graft.
        const kept = graft.session(session.id);
        expect(kept?.stopIncomplete).toBe(true);
        expect(kept?.status).toEqual({ kind: 'error', message });
        expect(graft.claimedRoots()).toEqual([f.parent]);
        expect(events).toEqual(['updated']);
        expect(fs.existsSync(breadcrumbPath(f.parent))).toBe(true);
        expect(stashCount(f.parent)).toBe(1);
        expect(fs.existsSync(path.join(f.parent, 'MIRROR.md'))).toBe(true);
        const contest = await graft
            .start({ id: 'ASSOC-2', worktreePath: second, branchName: 'other' })
            .catch((error: unknown) => error);
        expect((contest as GraftError).kind).toBe('alreadyActive');

        // The holder goes away; the next stop finishes the restore and the pop.
        fs.rmSync(lockPath);
        await graft.stop(session.id);
        off();
        expectParentUntouched(f);
        expect(graft.activeSessions()).toEqual([]);
        expect(graft.claimedRoots()).toEqual([]);
        expect(fs.existsSync(breadcrumbPath(f.parent))).toBe(false);
        expect(events.at(-1)).toBe('stopped');
    }, 60_000);

    it('drops the session but keeps the breadcrumb when the restore fails for a reason no retry fixes', async () => {
        const f = fixture('restore-fail');
        const real = createGitService();
        let broken = false;
        // Not a lock: the kind of failure a later stop would hit again, so the session must not
        // pin the root (#231). Injected, because git offers no non-lock reset failure on a repo
        // whose HEAD the stop itself recorded.
        const failing: GitService = {
            ...real,
            resetHard: async (repoPath, sha) => {
                if (broken) throw new Error(`fatal: Could not reset index file to revision '${sha}'.`);
                await real.resetHard(repoPath, sha);
            }
        };
        const { graft } = service(failing);

        const session = await graft.start(f.association);
        const events: string[] = [];
        const off = graft.updates((event) => {
            events.push(event.kind);
        });
        broken = true;
        const failure = await graft.stop(session.id).catch((error: unknown) => error);
        off();
        expect(String((failure as Error).message)).toContain('Could not reset index file');

        // §GIT-027: the session is gone (no client keeps a phantom row) and the root claim is
        // released, but the breadcrumb (and the stash) stay, because they are the only way back.
        expect(events.at(-1)).toBe('stopped');
        expect(graft.activeSessions()).toEqual([]);
        expect(graft.claimedRoots()).toEqual([]);
        expect(fs.existsSync(breadcrumbPath(f.parent))).toBe(true);
        expect(stashCount(f.parent)).toBe(1);

        // The breadcrumb picks the mess up on the next launch.
        const relaunched = service(createGitService()).graft;
        const orphan = relaunched.detectOrphans([f.parent])[0] as GraftOrphan;
        await relaunched.recoverOrphan(orphan);
        expectParentUntouched(f);
        expect(fs.existsSync(breadcrumbPath(f.parent))).toBe(false);
    }, 60_000);

    it('drops a lock-blocked session on a removal path (`dropOnFailure`), leaving the breadcrumb', async () => {
        const f = fixture('restore-locked-removed');
        const { graft } = service(createGitService());
        const session = await graft.start(f.association);
        const lockPath = path.join(f.parent, '.git', 'index.lock');
        fs.writeFileSync(lockPath, '');

        // Its association is gone, so nothing could ever target a kept session again.
        await expect(graft.stop(session.id, { dropOnFailure: true })).rejects.toThrow('index.lock');
        expect(graft.activeSessions()).toEqual([]);
        expect(graft.claimedRoots()).toEqual([]);
        expect(fs.existsSync(breadcrumbPath(f.parent))).toBe(true);

        fs.rmSync(lockPath);
        const relaunched = service(createGitService()).graft;
        await relaunched.recoverOrphan(relaunched.detectOrphans([f.parent])[0] as GraftOrphan);
        expectParentUntouched(f);
    }, 60_000);

    it('shutdown finishes a stop-incomplete session once the lock is gone, or leaves the breadcrumb', async () => {
        const f = fixture('restore-locked-shutdown');
        const { graft } = service(createGitService());
        const session = await graft.start(f.association);
        const lockPath = path.join(f.parent, '.git', 'index.lock');
        fs.writeFileSync(lockPath, '');
        await expect(graft.stop(session.id)).rejects.toThrow('stop incomplete');

        // Still locked at quit: nothing is lost, the breadcrumb is the way back next launch.
        await graft.shutdown();
        expect(graft.session(session.id)?.stopIncomplete).toBe(true);
        expect(fs.existsSync(breadcrumbPath(f.parent))).toBe(true);

        // Unlocked at quit: the quit flush finishes the stop like any other session.
        fs.rmSync(lockPath);
        await graft.shutdown();
        expect(graft.activeSessions()).toEqual([]);
        expect(fs.existsSync(breadcrumbPath(f.parent))).toBe(false);
        expectParentUntouched(f);
    }, 60_000);

    it('a removal-path stop joining a running stop drops what that stop kept', async () => {
        const f = fixture('restore-locked-joined');
        const { graft } = service(createGitService());
        const session = await graft.start(f.association);
        const lockPath = path.join(f.parent, '.git', 'index.lock');
        fs.writeFileSync(lockPath, '');

        const events: string[] = [];
        const off = graft.updates((event) => {
            events.push(event.kind);
        });
        const [user, removal] = await Promise.allSettled([
            graft.stop(session.id),
            graft.stop(session.id, { dropOnFailure: true })
        ]);
        off();
        // The user's stop ran WITHOUT dropOnFailure, so it kept the session (`updated`); the
        // removal path that joined it then dropped what it kept (`stopped`). Both see the same
        // failure.
        expect(user.status).toBe('rejected');
        expect(removal.status).toBe('rejected');
        const userError = (user as PromiseRejectedResult).reason as GraftError;
        expect(userError.message).toMatch(/^stop incomplete: /);
        expect((removal as PromiseRejectedResult).reason).toBe(userError);
        expect(events).toEqual(['updated', 'stopped']);
        expect(graft.activeSessions()).toEqual([]);
        expect(fs.existsSync(breadcrumbPath(f.parent))).toBe(true);
        fs.rmSync(lockPath);
        const relaunched = service(createGitService()).graft;
        await relaunched.recoverOrphan(relaunched.detectOrphans([f.parent])[0] as GraftOrphan);
        expectParentUntouched(f);
    }, 60_000);
});

describe.skipIf(!HAS_GIT)('orphan recovery failures', () => {
    /** Start a graft, then "crash": a brand-new service, breadcrumb + stash still on disk. */
    async function crashed(f: Fixture): Promise<GraftService> {
        const { graft } = service(createGitService());
        const session = await graft.start(f.association);
        expect(session.stashRef).not.toBeNull();
        expect(fs.existsSync(breadcrumbPath(f.parent))).toBe(true);
        return service(createGitService()).graft;
    }

    it('leaves the breadcrumb when the restore fails, and the retry recovers', async () => {
        const f = fixture('recover-restore-fail');
        const relaunched = await crashed(f);
        const good = readBreadcrumb(f.parent);
        expect(good).not.toBeNull();

        // A breadcrumb naming a commit this repo does not have — what a re-cloned or
        // history-rewritten parent leaves behind. `reset --hard` cannot parse it.
        writeBreadcrumb(f.parent, {
            ...(good as NonNullable<typeof good>),
            preGraftSha: '0123456789012345678901234567890123456789'
        });
        const orphan = relaunched.detectOrphans([f.parent])[0] as GraftOrphan;
        const failure = await relaunched.recoverOrphan(orphan).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);

        // §GIT-032: the breadcrumb (and the stash) survive, so the banner can offer a retry.
        expect(fs.existsSync(breadcrumbPath(f.parent))).toBe(true);
        expect(stashCount(f.parent)).toBe(1);
        expect(relaunched.detectOrphans([f.parent])).toHaveLength(1);

        // The retry: the same call, against a breadcrumb whose SHA the repo really has.
        writeBreadcrumb(f.parent, good as NonNullable<typeof good>);
        await relaunched.recoverOrphan(relaunched.detectOrphans([f.parent])[0] as GraftOrphan);
        expectParentUntouched(f);
        expect(fs.existsSync(breadcrumbPath(f.parent))).toBe(false);
        expect(relaunched.detectOrphans([f.parent])).toEqual([]);
    }, 60_000);

    it('leaves the breadcrumb AND the stash when the recovery stash pop conflicts', async () => {
        const f = fixture('recover-pop-fail');
        await crashed(f);
        const real = createGitService();
        const conflicting: GitService = {
            ...real,
            stashPopRef: async () => {
                throw new Error('CONFLICT (content): Merge conflict in keep.txt');
            }
        };
        const relaunched = service(conflicting).graft;
        const orphan = relaunched.detectOrphans([f.parent])[0] as GraftOrphan;

        const failure = await relaunched.recoverOrphan(orphan).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(GraftError);
        expect((failure as GraftError).kind).toBe('stashPopConflict');
        // The parent WAS restored (the pop is the last step), but the breadcrumb stays because
        // the user's stashed work has not been handed back yet.
        expect(fs.existsSync(path.join(f.parent, 'MIRROR.md'))).toBe(false);
        expect(fs.existsSync(breadcrumbPath(f.parent))).toBe(true);
        expect(stashCount(f.parent)).toBe(1);

        // Retried against real git, the same breadcrumb finishes the job.
        const retry = service(createGitService()).graft;
        await retry.recoverOrphan(retry.detectOrphans([f.parent])[0] as GraftOrphan);
        expectParentUntouched(f);
        expect(fs.existsSync(breadcrumbPath(f.parent))).toBe(false);
    }, 60_000);

    it('dismiss deletes the breadcrumb only — the stash and the parent are untouched', async () => {
        const f = fixture('dismiss-real');
        const relaunched = await crashed(f);
        const orphan = relaunched.detectOrphans([f.parent])[0] as GraftOrphan;
        expect(orphan.stashRef).not.toBeNull();
        const stashSha = git(f.parent, 'rev-parse', 'refs/stash').trim();

        relaunched.dismissOrphan(orphan);

        // §GIT-033: no restore, no pop. The breadcrumb is gone and nothing else moved — the
        // parent is still holding the grafted content and the stash is still on the stack.
        expect(fs.existsSync(breadcrumbPath(f.parent))).toBe(false);
        expect(relaunched.detectOrphans([f.parent])).toEqual([]);
        expect(stashCount(f.parent)).toBe(1);
        expect(git(f.parent, 'rev-parse', 'refs/stash').trim()).toBe(stashSha);
        expect(fs.readFileSync(path.join(f.parent, 'MIRROR.md'), 'utf8')).toBe('from the worktree\n');
        // The user's work is recoverable by hand, which is the point of leaving it.
        git(f.parent, 'checkout', '-f', 'main');
        git(f.parent, 'stash', 'pop');
        expect(fs.readFileSync(path.join(f.parent, 'keep.txt'), 'utf8')).toBe('local edit\n');
    }, 60_000);
});
