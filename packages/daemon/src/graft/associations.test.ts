import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RepoGitStatus } from '../git/index.js';
import { stubGitService } from '../git/testing.js';
import { createStore, emptyDaemonState, type KelpiStore } from '../store/index.js';
import {
    createRepoAssociationWatch,
    GIT_STATUS_POLL_MS,
    type AssociationGit,
    type RepoAssociationWatchService
} from './associations.js';
import { createHeadWatchService, type HeadWatchService } from './head-watcher.js';

const HOME = '/Users/test';
const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const P1 = 'DDDDDDDD-0000-4000-8000-000000000001';
const R1 = 'BBBBBBBB-0000-4000-8000-000000000001';
const A1 = 'CCCCCCCC-0000-4000-8000-000000000001';
const A2 = 'CCCCCCCC-0000-4000-8000-000000000002';
const NOW = 1_755_500_000_000;

interface FakeHeadWatch extends HeadWatchService {
    readonly started: { id: string; path: string }[];
    readonly stopped: string[];
    fire(associationID: string): void;
}

function fakeHeadWatch(onChanged: (id: string) => void): FakeHeadWatch {
    const started: { id: string; path: string }[] = [];
    const stopped: string[] = [];
    const live = new Set<string>();
    return {
        async start(associationID, worktreePath) {
            started.push({ id: associationID, path: worktreePath });
            live.add(associationID);
        },
        stop(associationID) {
            stopped.push(associationID);
            live.delete(associationID);
        },
        stopAll() {
            for (const id of live) stopped.push(id);
            live.clear();
        },
        watched: () => [...live],
        headPath: () => null,
        started,
        stopped,
        fire: onChanged
    };
}

interface Harness {
    readonly store: KelpiStore;
    readonly watch: RepoAssociationWatchService;
    readonly headWatch: FakeHeadWatch;
    readonly forceStopped: string[];
}

function harness(
    git: Partial<AssociationGit> = {},
    /**
     * `defaultPoll` omits `pollIntervalMs` ENTIRELY so the service falls back to its own
     * `GIT_STATUS_POLL_MS` — the constant §GIT-086 is about, and the one every other test in
     * this file disables. Passing 30_000 by hand would prove the timer works and say nothing
     * about the default the daemon actually ships with.
     */
    options: { pollIntervalMs?: number | undefined; defaultPoll?: boolean } = {}
): Harness {
    const store = createStore(emptyDaemonState(HOME));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: P1, name: 'w1', now: NOW });
    store.dispatch({
        type: 'add-repo',
        repo: {
            id: R1,
            path: '/repo',
            name: 'repo',
            remoteURL: null,
            lastAccessedAt: NOW / 1000,
            isAutoDiscovered: false
        }
    });
    const forceStopped: string[] = [];
    let changed: (id: string) => void = () => {};
    const headWatch = fakeHeadWatch((id) => {
        changed(id);
    });
    const service = createRepoAssociationWatch({
        store,
        git: { ...stubGitService(), ...git },
        graft: {
            stop: async (associationID) => {
                forceStopped.push(associationID);
            }
        },
        headWatch,
        // 0 disables the backstop, which is what every test that is not ABOUT the poll wants.
        ...(options.defaultPoll === true ? {} : { pollIntervalMs: options.pollIntervalMs ?? 0 })
    });
    changed = (id) => {
        void service.refresh(id);
    };
    return { store, watch: service, headWatch, forceStopped };
}

function addAssociation(store: KelpiStore, id: string, worktreePath: string): void {
    store.dispatch({
        type: 'add-repo-association',
        workspaceID: W1,
        association: {
            id,
            repoID: R1,
            worktreePath,
            branchName: null,
            isAutoDetected: false
        }
    });
}

const flush = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
};

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

describe('createRepoAssociationWatch', () => {
    it('starts a HEAD watcher and back-fills the branch for a new association', async () => {
        const h = harness({ getCurrentBranch: async () => 'feature/x' });
        h.watch.start();
        addAssociation(h.store, A1, '/worktrees/feature-x');
        await flush();

        expect(h.headWatch.started).toEqual([{ id: A1, path: '/worktrees/feature-x' }]);
        const association = h.store
            .getState()
            .workspaces[0]?.repoAssociations.find((entry) => entry.id === A1);
        expect(association?.branchName).toBe('feature/x');
        h.watch.dispose();
    });

    it('installs watchers for associations already in state when it starts', async () => {
        const h = harness();
        addAssociation(h.store, A1, '/worktrees/a');
        addAssociation(h.store, A2, '/worktrees/b');
        h.watch.start();
        await flush();
        expect(h.headWatch.started.map((entry) => entry.id).sort()).toEqual([A1, A2]);
        h.watch.dispose();
    });

    it('stops the watcher AND force-stops graft when an association disappears', async () => {
        const h = harness();
        h.watch.start();
        addAssociation(h.store, A1, '/worktrees/a');
        await flush();

        h.store.dispatch({
            type: 'remove-repo-association',
            workspaceID: W1,
            associationID: A1
        });
        await flush();
        expect(h.headWatch.stopped).toEqual([A1]);
        // §8.8: unconditional, so a session the store never knew about is still released.
        expect(h.forceStopped).toEqual([A1]);
        h.watch.dispose();
    });

    it('force-stops every association of a deleted workspace', async () => {
        const h = harness();
        h.watch.start();
        addAssociation(h.store, A1, '/worktrees/a');
        addAssociation(h.store, A2, '/worktrees/b');
        await flush();

        h.store.dispatch({ type: 'delete-workspace', id: W1 });
        await flush();
        expect([...h.forceStopped].sort()).toEqual([A1, A2]);
        expect([...h.headWatch.stopped].sort()).toEqual([A1, A2]);
        h.watch.dispose();
    });

    it('re-watches when an association points at a different worktree', async () => {
        const h = harness();
        h.watch.start();
        addAssociation(h.store, A1, '/worktrees/a');
        await flush();
        h.store.dispatch({
            type: 'remove-repo-association',
            workspaceID: W1,
            associationID: A1
        });
        addAssociation(h.store, A1, '/worktrees/moved');
        await flush();
        expect(h.headWatch.started.at(-1)).toEqual({ id: A1, path: '/worktrees/moved' });
        h.watch.dispose();
    });

    it('records dirtiness per association and tolerates a failing git', async () => {
        const h = harness({
            getStatus: async () => ({ kind: 'dirty', changedFiles: 3, additions: 27, deletions: 12 }),
            getCurrentBranch: async () => {
                throw new Error('boom');
            }
        });
        h.watch.start();
        addAssociation(h.store, A1, '/worktrees/a');
        await flush();
        expect(h.watch.statusFor(A1)).toEqual({
            kind: 'dirty',
            changedFiles: 3,
            additions: 27,
            deletions: 12
        });
        expect(h.watch.statusFor('unknown-id')).toEqual({ kind: 'unknown' });
        h.watch.dispose();
    });

    it('refreshes on a HEAD change event', async () => {
        let branch = 'main';
        const h = harness({ getCurrentBranch: async () => branch });
        h.watch.start();
        addAssociation(h.store, A1, '/worktrees/a');
        await flush();

        branch = 'feature/y';
        h.headWatch.fire(A1);
        await flush();
        const association = h.store
            .getState()
            .workspaces[0]?.repoAssociations.find((entry) => entry.id === A1);
        expect(association?.branchName).toBe('feature/y');
        h.watch.dispose();
    });

    it('dispose stops every watcher and detaches from the store', async () => {
        const h = harness();
        h.watch.start();
        addAssociation(h.store, A1, '/worktrees/a');
        await flush();
        h.watch.dispose();
        expect(h.headWatch.stopped).toContain(A1);

        // Post-dispose store traffic must not resurrect anything.
        addAssociation(h.store, A2, '/worktrees/b');
        await flush();
        expect(h.headWatch.started.map((entry) => entry.id)).toEqual([A1]);
    });

    it('clears old provider answers immediately, rebinds HEAD, and reads current associations', async () => {
        let branch = 'bundled/main';
        let status = Promise.resolve<RepoGitStatus>({ kind: 'clean' });
        const h = harness({ getStatus: () => status, getCurrentBranch: async () => branch });
        addAssociation(h.store, A1, '/worktrees/a');
        h.watch.start();
        await flush();
        expect(h.watch.statusFor(A1)).toEqual({ kind: 'clean' });
        expect(h.store.getState().workspaces[0]?.repoAssociations[0]?.branchName).toBe('bundled/main');

        const nextStatus = deferred<RepoGitStatus>();
        status = nextStatus.promise;
        branch = 'provider/main';
        h.watch.invalidate();
        expect(h.watch.statusFor(A1)).toEqual({ kind: 'unknown' });
        expect(h.store.getState().workspaces[0]?.repoAssociations[0]?.branchName).toBeNull();
        expect(h.headWatch.stopped).toEqual([A1]);
        expect(h.headWatch.started).toEqual([
            { id: A1, path: '/worktrees/a' },
            { id: A1, path: '/worktrees/a' }
        ]);

        nextStatus.resolve({ kind: 'dirty', changedFiles: 1, additions: 2, deletions: 3 });
        await flush();
        expect(h.watch.statusFor(A1)).toEqual({ kind: 'dirty', changedFiles: 1, additions: 2, deletions: 3 });
        expect(h.store.getState().workspaces[0]?.repoAssociations[0]?.branchName).toBe('provider/main');
        h.watch.dispose();
    });

    it('watches the new provider’s resolved HEAD location for an existing association', async () => {
        const h = harness();
        let headPath = '/bundled/repo/HEAD';
        const directories: string[] = [];
        const closed: string[] = [];
        const headWatch = createHeadWatchService({
            resolveHeadPath: async () => headPath,
            onChanged() {},
            watch(directory) {
                directories.push(directory);
                return { close() { closed.push(directory); }, on() {} };
            }
        });
        const watch = createRepoAssociationWatch({
            store: h.store,
            git: stubGitService(),
            graft: { stop: async () => {} },
            headWatch,
            pollIntervalMs: 0
        });
        addAssociation(h.store, A1, '/worktrees/a');
        watch.start();
        await flush();
        headPath = '/provider/repo/HEAD';
        watch.invalidate();
        await flush();
        expect(directories).toEqual(['/bundled/repo', '/provider/repo']);
        expect(closed).toEqual(['/bundled/repo']);
        expect(headWatch.headPath(A1)).toBe('/provider/repo/HEAD');
        watch.dispose();
        h.watch.dispose();
    });

    it('discards a pending old-provider status without starting its branch read', async () => {
        const oldStatus = deferred<RepoGitStatus>();
        const getStatus = vi.fn<AssociationGit['getStatus']>()
            .mockImplementationOnce(() => oldStatus.promise)
            .mockResolvedValue({ kind: 'clean' });
        const getCurrentBranch = vi.fn<AssociationGit['getCurrentBranch']>().mockResolvedValue('new/main');
        const h = harness({ getStatus, getCurrentBranch });
        addAssociation(h.store, A1, '/worktrees/a');
        h.watch.start();
        h.watch.invalidate();
        await flush();
        oldStatus.resolve({ kind: 'dirty', changedFiles: 5, additions: 6, deletions: 7 });
        await flush();
        expect(h.watch.statusFor(A1)).toEqual({ kind: 'clean' });
        expect(h.store.getState().workspaces[0]?.repoAssociations[0]?.branchName).toBe('new/main');
        expect(getCurrentBranch).toHaveBeenCalledTimes(1);
        h.watch.dispose();
    });

    it('keeps the latest refresh when an older branch read finishes last', async () => {
        const oldBranch = deferred<string | null>();
        const getCurrentBranch = vi.fn<AssociationGit['getCurrentBranch']>()
            .mockImplementationOnce(() => oldBranch.promise)
            .mockResolvedValue('new/main');
        const getStatus = vi.fn<AssociationGit['getStatus']>()
            .mockResolvedValueOnce({ kind: 'clean' })
            .mockResolvedValue({ kind: 'dirty', changedFiles: 1, additions: 0, deletions: 0 });
        const h = harness({ getStatus, getCurrentBranch });
        addAssociation(h.store, A1, '/worktrees/a');
        h.watch.start();
        await flush();
        await h.watch.refresh(A1);
        oldBranch.resolve('stale/main');
        await flush();
        expect(h.watch.statusFor(A1)).toEqual({ kind: 'dirty', changedFiles: 1, additions: 0, deletions: 0 });
        expect(h.store.getState().workspaces[0]?.repoAssociations[0]?.branchName).toBe('new/main');
        h.watch.dispose();
    });

    it('waits for current status and branch when a concurrent refresh supersedes its read', async () => {
        const oldStatus = deferred<RepoGitStatus>();
        const newStatus = deferred<RepoGitStatus>();
        const newBranch = deferred<string | null>();
        const getStatus = vi.fn<AssociationGit['getStatus']>()
            .mockReturnValueOnce(oldStatus.promise)
            .mockReturnValueOnce(newStatus.promise);
        const getCurrentBranch = vi.fn<AssociationGit['getCurrentBranch']>().mockReturnValue(newBranch.promise);
        const h = harness({ getStatus, getCurrentBranch });
        addAssociation(h.store, A1, '/worktrees/a');
        let oldFinished = false;
        const oldRefresh = h.watch.refresh(A1).then(() => { oldFinished = true; });
        const newRefresh = h.watch.refresh(A1);

        oldStatus.resolve({ kind: 'clean' });
        await flush();
        expect(oldFinished).toBe(false);
        expect(h.watch.statusFor(A1)).toEqual({ kind: 'unknown' });
        newStatus.resolve({ kind: 'dirty', changedFiles: 7, additions: 8, deletions: 9 });
        await flush();
        expect(oldFinished).toBe(false);
        newBranch.resolve('provider/main');
        await Promise.all([oldRefresh, newRefresh]);
        expect(h.watch.statusFor(A1)).toEqual({ kind: 'dirty', changedFiles: 7, additions: 8, deletions: 9 });
        expect(h.store.getState().workspaces[0]?.repoAssociations[0]?.branchName).toBe('provider/main');
        expect(getCurrentBranch).toHaveBeenCalledTimes(1);
        h.watch.dispose();
    });

    it('joins the newer refresh after its own status succeeded but its branch was superseded', async () => {
        const oldBranch = deferred<string | null>();
        const newBranch = deferred<string | null>();
        const getStatus = vi.fn<AssociationGit['getStatus']>()
            .mockResolvedValueOnce({ kind: 'clean' })
            .mockResolvedValue({ kind: 'dirty', changedFiles: 2, additions: 3, deletions: 4 });
        const getCurrentBranch = vi.fn<AssociationGit['getCurrentBranch']>()
            .mockReturnValueOnce(oldBranch.promise)
            .mockReturnValueOnce(newBranch.promise);
        const h = harness({ getStatus, getCurrentBranch });
        addAssociation(h.store, A1, '/worktrees/a');
        let oldFinished = false;
        const oldRefresh = h.watch.refresh(A1).then(() => { oldFinished = true; });
        await flush();
        const newRefresh = h.watch.refresh(A1);
        oldBranch.resolve('stale/main');
        await flush();
        expect(oldFinished).toBe(false);
        newBranch.resolve('new/main');
        await Promise.all([oldRefresh, newRefresh]);
        expect(h.watch.statusFor(A1)).toEqual({ kind: 'dirty', changedFiles: 2, additions: 3, deletions: 4 });
        expect(h.store.getState().workspaces[0]?.repoAssociations[0]?.branchName).toBe('new/main');
        h.watch.dispose();
    });

    it('joins the refreshed provider generation after invalidation clears the old cache', async () => {
        const getStatus = vi.fn<AssociationGit['getStatus']>().mockResolvedValue({ kind: 'clean' });
        const h = harness({ getStatus, getCurrentBranch: async () => 'new/main' });
        addAssociation(h.store, A1, '/worktrees/a');
        h.watch.start();
        await flush();
        const oldStatus = deferred<RepoGitStatus>();
        const newStatus = deferred<RepoGitStatus>();
        getStatus.mockReturnValueOnce(oldStatus.promise).mockReturnValueOnce(newStatus.promise);
        let oldFinished = false;
        const oldRefresh = h.watch.refresh(A1).then(() => { oldFinished = true; });
        h.watch.invalidate();
        oldStatus.resolve({ kind: 'clean' });
        await flush();
        expect(oldFinished).toBe(false);
        expect(h.watch.statusFor(A1)).toEqual({ kind: 'unknown' });
        newStatus.resolve({ kind: 'dirty', changedFiles: 7, additions: 8, deletions: 9 });
        await oldRefresh;
        expect(h.watch.statusFor(A1)).toEqual({ kind: 'dirty', changedFiles: 7, additions: 8, deletions: 9 });
        h.watch.dispose();
    });

    it('follows successive refreshes without waiting for obsolete native reads to finish', async () => {
        const oldStatus = deferred<RepoGitStatus>();
        const middleStatus = deferred<RepoGitStatus>();
        const newStatus = deferred<RepoGitStatus>();
        const getStatus = vi.fn<AssociationGit['getStatus']>()
            .mockReturnValueOnce(oldStatus.promise)
            .mockReturnValueOnce(middleStatus.promise)
            .mockReturnValueOnce(newStatus.promise);
        const getCurrentBranch = vi.fn<AssociationGit['getCurrentBranch']>().mockResolvedValue('new/main');
        const h = harness({ getStatus, getCurrentBranch });
        addAssociation(h.store, A1, '/worktrees/a');
        let finished = 0;
        const oldRefresh = h.watch.refresh(A1).then(() => { finished += 1; });
        const middleRefresh = h.watch.refresh(A1).then(() => { finished += 1; });
        await flush();
        expect(finished).toBe(0);
        const newRefresh = h.watch.refresh(A1);
        newStatus.resolve({ kind: 'dirty', changedFiles: 3, additions: 4, deletions: 5 });
        await Promise.all([oldRefresh, middleRefresh, newRefresh]);
        expect(finished).toBe(2);
        expect(h.watch.statusFor(A1)).toEqual({ kind: 'dirty', changedFiles: 3, additions: 4, deletions: 5 });
        expect(getCurrentBranch).toHaveBeenCalledTimes(1);

        // Both superseded subprocesses can return after every current-data caller finished.
        oldStatus.resolve({ kind: 'clean' });
        middleStatus.resolve({ kind: 'unknown' });
        await flush();
        expect(h.watch.statusFor(A1)).toEqual({ kind: 'dirty', changedFiles: 3, additions: 4, deletions: 5 });
        expect(getCurrentBranch).toHaveBeenCalledTimes(1);
        h.watch.dispose();
    });

    it.each(['remove', 'rescope', 'dispose'] as const)('releases joined callers on %s without waiting for a retired read', async action => {
        const getStatus = vi.fn<AssociationGit['getStatus']>().mockResolvedValue({ kind: 'clean' });
        const h = harness({ getStatus, getCurrentBranch: async () => 'current/main' });
        addAssociation(h.store, A1, '/worktrees/a');
        h.watch.start();
        await flush();
        const oldStatus = deferred<RepoGitStatus>();
        const newStatus = deferred<RepoGitStatus>();
        const movedStatus = deferred<RepoGitStatus>();
        getStatus.mockReturnValueOnce(oldStatus.promise).mockReturnValueOnce(newStatus.promise).mockReturnValueOnce(movedStatus.promise);
        let finished = 0;
        const oldRefresh = h.watch.refresh(A1).then(() => { finished += 1; });
        const newRefresh = h.watch.refresh(A1).then(() => { finished += 1; });
        await flush();
        expect(finished).toBe(0);
        if (action === 'dispose') h.watch.dispose();
        else {
            h.store.dispatch({ type: 'remove-repo-association', workspaceID: W1, associationID: A1 });
            if (action === 'rescope') addAssociation(h.store, A1, '/worktrees/moved');
        }
        await Promise.all([oldRefresh, newRefresh]);
        expect(finished).toBe(2);
        expect(h.watch.statusFor(A1)).toEqual({ kind: 'unknown' });
        if (action === 'rescope') {
            movedStatus.resolve({ kind: 'dirty', changedFiles: 8, additions: 0, deletions: 0 });
            await flush();
        }
        oldStatus.resolve({ kind: 'clean' });
        newStatus.resolve({ kind: 'clean' });
        await flush();
        expect(h.watch.statusFor(A1)).toEqual(action === 'rescope'
            ? { kind: 'dirty', changedFiles: 8, additions: 0, deletions: 0 }
            : { kind: 'unknown' });
        h.watch.dispose();
    });

    it('does not revive the status of an association removed and recreated with the same id and path', async () => {
        const oldStatus = deferred<RepoGitStatus>();
        const getStatus = vi.fn<AssociationGit['getStatus']>()
            .mockImplementationOnce(() => oldStatus.promise)
            .mockResolvedValue({ kind: 'clean' });
        const h = harness({ getStatus, getCurrentBranch: async () => 'new/main' });
        addAssociation(h.store, A1, '/worktrees/a');
        h.watch.start();
        h.store.dispatch({ type: 'remove-repo-association', workspaceID: W1, associationID: A1 });
        expect(h.watch.statusFor(A1)).toEqual({ kind: 'unknown' });
        addAssociation(h.store, A1, '/worktrees/a');
        await flush();
        oldStatus.resolve({ kind: 'dirty', changedFiles: 5, additions: 6, deletions: 7 });
        await flush();
        expect(h.watch.statusFor(A1)).toEqual({ kind: 'clean' });
        expect(h.store.getState().workspaces[0]?.repoAssociations[0]?.branchName).toBe('new/main');
        h.watch.dispose();
    });

    it('retires pending reads at disposal and ignores subsequent refresh and invalidation', async () => {
        const oldStatus = deferred<RepoGitStatus>();
        const getStatus = vi.fn<AssociationGit['getStatus']>().mockReturnValue(oldStatus.promise);
        const getCurrentBranch = vi.fn<AssociationGit['getCurrentBranch']>().mockResolvedValue('stale/main');
        const h = harness({ getStatus, getCurrentBranch });
        addAssociation(h.store, A1, '/worktrees/a');
        h.watch.start();
        h.watch.dispose();
        oldStatus.resolve({ kind: 'clean' });
        await flush();
        await h.watch.refresh(A1);
        h.watch.invalidate();
        expect(h.watch.statusFor(A1)).toEqual({ kind: 'unknown' });
        expect(h.store.getState().workspaces[0]?.repoAssociations[0]?.branchName).toBeNull();
        expect(getStatus).toHaveBeenCalledTimes(1);
        expect(getCurrentBranch).not.toHaveBeenCalled();
        expect(h.headWatch.started).toHaveLength(1);
    });
});

/**
 * §GIT-086 / §9.3 — the polling backstop.
 *
 * The Swift's `refreshGitStatus` walks `workspace.repoAssociations` for the ACTIVE workspace
 * and re-reads status **and** branch for each, driven by a 30 s `clock.timer` and by the
 * inspector opening (`AppReducer+RepoGit.swift:398-435`). The port's poll is the same loop, and
 * until now nothing exercised it: every test in the file above passes `pollIntervalMs: 0`, so
 * the interval, the "every association" fan-out and the active-workspace scope were all
 * unproven. These drive the real timer.
 *
 * (The inspector-open half is the same fan-out one layer up — `workspace-repo-status` with
 * `refresh: true`, which `ws/repos.test.ts` covers and `client/src/app/inspector.ts` sends on
 * every open.)
 */
describe('the 30 s dirtiness poll (§GIT-086)', () => {
    const W2 = 'AAAAAAAA-0000-4000-8000-000000000002';
    const P2 = 'DDDDDDDD-0000-4000-8000-000000000002';
    const A3 = 'CCCCCCCC-0000-4000-8000-000000000003';
    const A4 = 'CCCCCCCC-0000-4000-8000-000000000004';

    afterEach(() => {
        vi.useRealTimers();
    });

    /** Fake timers fake `setImmediate` too, so `flush()` cannot be used here. */
    const settle = async (): Promise<void> => {
        for (let tick = 0; tick < 6; tick += 1) await vi.advanceTimersByTimeAsync(0);
    };

    it('is the shipped 30 seconds', () => {
        expect(GIT_STATUS_POLL_MS).toBe(30_000);
    });

    it('re-reads EVERY association of the active workspace on each tick, not just the first', async () => {
        vi.useFakeTimers();
        const statusReads: string[] = [];
        const branchReads: string[] = [];
        const h = harness(
            {
                getStatus: async (worktreePath) => {
                    statusReads.push(worktreePath);
                    // One association whose git is broken must not shorten the loop.
                    if (worktreePath === '/worktrees/b') throw new Error('not a checkout');
                    return { kind: 'clean' };
                },
                getCurrentBranch: async (worktreePath) => {
                    branchReads.push(worktreePath);
                    return 'main';
                }
            },
            { defaultPoll: true }
        );
        h.watch.start();
        addAssociation(h.store, A1, '/worktrees/a');
        addAssociation(h.store, A2, '/worktrees/b');
        addAssociation(h.store, A3, '/worktrees/c');
        await settle();
        // The arrival reads (§GIT-079) are a different claim; the poll starts from zero.
        statusReads.length = 0;
        branchReads.length = 0;

        // Asserted from BOTH sides of the interval, so this cannot pass on a timer that fires
        // immediately or on one that fires far too often.
        await vi.advanceTimersByTimeAsync(GIT_STATUS_POLL_MS - 100);
        expect(statusReads).toEqual([]);

        await vi.advanceTimersByTimeAsync(100);
        await settle();
        expect([...statusReads].sort()).toEqual(['/worktrees/a', '/worktrees/b', '/worktrees/c']);
        expect([...branchReads].sort()).toEqual(['/worktrees/a', '/worktrees/b', '/worktrees/c']);
        // The broken one degrades to `unknown` (the gray dot) rather than taking the tick down.
        expect(h.watch.statusFor(A2)).toEqual({ kind: 'unknown' });
        expect(h.watch.statusFor(A3)).toEqual({ kind: 'clean' });

        // It REPEATS: a second tick reads all three again.
        statusReads.length = 0;
        await vi.advanceTimersByTimeAsync(GIT_STATUS_POLL_MS);
        await settle();
        expect([...statusReads].sort()).toEqual(['/worktrees/a', '/worktrees/b', '/worktrees/c']);
        h.watch.dispose();
    });

    it('polls the ACTIVE workspace only', async () => {
        vi.useFakeTimers();
        const statusReads: string[] = [];
        const h = harness(
            {
                getStatus: async (worktreePath) => {
                    statusReads.push(worktreePath);
                    return { kind: 'clean' };
                }
            },
            { defaultPoll: true }
        );
        h.store.dispatch({ type: 'create-workspace', id: W2, paneID: P2, name: 'w2', now: NOW });
        h.watch.start();
        addAssociation(h.store, A1, '/worktrees/a');
        h.store.dispatch({
            type: 'add-repo-association',
            workspaceID: W2,
            association: {
                id: A4,
                repoID: R1,
                worktreePath: '/worktrees/background',
                branchName: null,
                isAutoDetected: false
            }
        });
        // Creating w2 made it active; hand the active workspace back to w1 the way a click does.
        h.store.dispatch({ type: 'set-active-workspace', id: W1, now: NOW });
        await settle();
        statusReads.length = 0;

        await vi.advanceTimersByTimeAsync(GIT_STATUS_POLL_MS);
        await settle();
        expect(statusReads).toEqual(['/worktrees/a']);

        // Switch workspaces and the poll follows: the background repo is now the polled one.
        h.store.dispatch({ type: 'set-active-workspace', id: W2, now: NOW });
        await settle();
        statusReads.length = 0;
        await vi.advanceTimersByTimeAsync(GIT_STATUS_POLL_MS);
        await settle();
        expect(statusReads).toEqual(['/worktrees/background']);
        h.watch.dispose();
    });

    it('a tick updates BOTH the dirtiness and the branch label', async () => {
        vi.useFakeTimers();
        let branch = 'main';
        let status: RepoGitStatus = { kind: 'clean' };
        const h = harness(
            {
                getStatus: async () => status,
                getCurrentBranch: async () => branch
            },
            { defaultPoll: true }
        );
        h.watch.start();
        addAssociation(h.store, A1, '/worktrees/a');
        await settle();
        expect(h.watch.statusFor(A1)).toEqual({ kind: 'clean' });

        // A commit + an edit made outside the app, touching neither HEAD nor the association.
        branch = 'feature/z';
        status = { kind: 'dirty', changedFiles: 2, additions: 5, deletions: 5 };
        await vi.advanceTimersByTimeAsync(GIT_STATUS_POLL_MS);
        await settle();
        expect(h.watch.statusFor(A1)).toEqual({
            kind: 'dirty',
            changedFiles: 2,
            additions: 5,
            deletions: 5
        });
        expect(
            h.store.getState().workspaces.find((workspace) => workspace.id === W1)
                ?.repoAssociations[0]?.branchName
        ).toBe('feature/z');
        h.watch.dispose();
    });

    it('stops with the service — no tick survives dispose', async () => {
        vi.useFakeTimers();
        const statusReads: string[] = [];
        const h = harness(
            {
                getStatus: async (worktreePath) => {
                    statusReads.push(worktreePath);
                    return { kind: 'clean' };
                }
            },
            { defaultPoll: true }
        );
        h.watch.start();
        addAssociation(h.store, A1, '/worktrees/a');
        await settle();
        h.watch.dispose();
        statusReads.length = 0;
        await vi.advanceTimersByTimeAsync(GIT_STATUS_POLL_MS * 3);
        await settle();
        expect(statusReads).toEqual([]);
    });
});
