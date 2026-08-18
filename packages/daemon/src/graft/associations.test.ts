import { describe, expect, it } from 'vitest';

import { stubGitService } from '../git/testing.js';
import { createStore, emptyDaemonState, type NexStore } from '../store/index.js';
import {
    createRepoAssociationWatch,
    type AssociationGit,
    type RepoAssociationWatchService
} from './associations.js';
import type { HeadWatchService } from './head-watcher.js';

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
    readonly store: NexStore;
    readonly watch: RepoAssociationWatchService;
    readonly headWatch: FakeHeadWatch;
    readonly forceStopped: string[];
}

function harness(git: Partial<AssociationGit> = {}): Harness {
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
        pollIntervalMs: 0
    });
    changed = (id) => {
        void service.refresh(id);
    };
    return { store, watch: service, headWatch, forceStopped };
}

function addAssociation(store: NexStore, id: string, worktreePath: string): void {
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
});
