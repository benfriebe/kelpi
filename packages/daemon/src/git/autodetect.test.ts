import { describe, expect, it } from 'vitest';

import { createStore, emptyDaemonState, type NexStore } from '../store/index.js';
import { createRepoAutoDetect, isPathInside, type RepoAutoDetectService } from './autodetect.js';
import { stubGitService } from './testing.js';
import type { GitService } from './service.js';

const HOME = '/Users/test';
const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const W2 = 'AAAAAAAA-0000-4000-8000-000000000002';
const P1 = 'DDDDDDDD-0000-4000-8000-000000000001';
const P2 = 'DDDDDDDD-0000-4000-8000-000000000002';
const NOW = 1_755_500_000_000;

/** Deterministic ids so assertions can name them. */
function ids(): () => string {
    let n = 0;
    return () => {
        n += 1;
        return `EEEEEEEE-0000-4000-8000-${String(n).padStart(12, '0')}`;
    };
}

interface Harness {
    readonly store: NexStore;
    readonly detect: RepoAutoDetectService;
    readonly persists: () => number;
    setEnabled(value: boolean): void;
    /** Run the debounced link pass (timers are 0 ms here) and settle its async half. */
    settle(): Promise<void>;
}

function harness(git: Partial<GitService> = {}, options: { enabled?: boolean } = {}): Harness {
    const store = createStore(emptyDaemonState(HOME));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: P1, name: 'w1', now: NOW });
    let enabled = options.enabled ?? true;
    let persists = 0;
    const detect = createRepoAutoDetect({
        store,
        git: { ...stubGitService(), ...git },
        enabled: () => enabled,
        uuid: ids(),
        now: () => NOW,
        persist: () => {
            persists += 1;
        },
        linkDebounceMs: 0,
        unlinkDebounceMs: 0
    });
    return {
        store,
        detect,
        persists: () => persists,
        setEnabled(value) {
            enabled = value;
        },
        async settle() {
            // Let the 0 ms timers fire, then wait out the async git resolution they started.
            await new Promise<void>((resolve) => setTimeout(resolve, 1));
            await detect.idle();
            await new Promise<void>((resolve) => setTimeout(resolve, 1));
            await detect.idle();
        }
    };
}

function setPaneDirectory(store: NexStore, paneID: string, directory: string): void {
    store.dispatch({ type: 'pane-directory-changed', paneID, directory, now: NOW });
}

function associationsOf(store: NexStore, workspaceID = W1) {
    return store.getState().workspaces.find((workspace) => workspace.id === workspaceID)?.repoAssociations ?? [];
}

describe('isPathInside (§GIT-076/§GIT-080)', () => {
    it('matches the root exactly and anything under it, never a sibling with a shared prefix', () => {
        expect(isPathInside('/repo', '/repo')).toBe(true);
        expect(isPathInside('/repo/src/deep', '/repo')).toBe(true);
        expect(isPathInside('/repo-other/src', '/repo')).toBe(false);
        expect(isPathInside('/elsewhere', '/repo')).toBe(false);
        // Standardized on both sides: a trailing slash and a `..` hop are not differences.
        expect(isPathInside('/repo/src/..', '/repo/')).toBe(true);
    });
});

describe('auto-link (§GIT-075…§GIT-079)', () => {
    it('links the resolved worktree after the debounce, registering the parent as auto-discovered', async () => {
        const h = harness({
            resolveRepoRoot: async () => ({ worktreeRoot: '/work/wt', parentRepoRoot: '/work/repo' }),
            getRemoteURL: async () => 'git@example.invalid:acme/repo.git'
        });
        setPaneDirectory(h.store, P1, '/work/wt/src');
        h.detect.paneDirectoryChanged({ workspaceID: W1, paneID: P1, directory: '/work/wt/src' });
        await h.settle();

        const repos = h.store.getState().repos;
        expect(repos).toHaveLength(1);
        expect(repos[0]).toMatchObject({
            path: '/work/repo',
            name: 'repo',
            isAutoDiscovered: true,
            // §GIT-069/§GIT-077: the origin URL lands asynchronously on the same row.
            remoteURL: 'git@example.invalid:acme/repo.git'
        });
        const associations = associationsOf(h.store);
        expect(associations).toHaveLength(1);
        expect(associations[0]).toMatchObject({
            worktreePath: '/work/wt',
            isAutoDetected: true,
            // Left for the association watcher to back-fill (§GIT-079's downstream half).
            branchName: null
        });
        expect(h.persists()).toBeGreaterThan(0);
    });

    it('never creates a second association for a worktree the workspace already has (§GIT-078)', async () => {
        const h = harness({
            resolveRepoRoot: async () => ({ worktreeRoot: '/work/wt', parentRepoRoot: '/work/repo' })
        });
        setPaneDirectory(h.store, P1, '/work/wt');
        h.detect.paneDirectoryChanged({ workspaceID: W1, paneID: P1, directory: '/work/wt' });
        await h.settle();
        // A second pane, deeper in the same worktree.
        h.store.dispatch({ type: 'split-pane', workspaceID: W1, paneID: P2, direction: 'horizontal', now: NOW });
        setPaneDirectory(h.store, P2, '/work/wt/src');
        h.detect.paneDirectoryChanged({ workspaceID: W1, paneID: P2, directory: '/work/wt/src' });
        await h.settle();

        expect(associationsOf(h.store)).toHaveLength(1);
        expect(h.store.getState().repos).toHaveLength(1);
    });

    it('skips when the pane has already moved on by the time git answers (§GIT-076)', async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = () => {
                resolve();
            };
        });
        const h = harness({
            resolveRepoRoot: async () => {
                await gate;
                return { worktreeRoot: '/work/wt', parentRepoRoot: '/work/repo' };
            }
        });
        setPaneDirectory(h.store, P1, '/work/wt/src');
        h.detect.paneDirectoryChanged({ workspaceID: W1, paneID: P1, directory: '/work/wt/src' });
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        // The user `cd`-ed clean out of the worktree while git was still running.
        setPaneDirectory(h.store, P1, '/somewhere/else');
        release();
        await h.settle();

        expect(associationsOf(h.store)).toHaveLength(0);
        expect(h.store.getState().repos).toHaveLength(0);
    });

    it('does nothing at all while the setting is off (§GIT-074)', async () => {
        const h = harness(
            { resolveRepoRoot: async () => ({ worktreeRoot: '/work/wt', parentRepoRoot: '/work/repo' }) },
            { enabled: false }
        );
        setPaneDirectory(h.store, P1, '/work/wt');
        h.detect.paneDirectoryChanged({ workspaceID: W1, paneID: P1, directory: '/work/wt' });
        await h.settle();
        expect(associationsOf(h.store)).toHaveLength(0);
        expect(h.store.getState().repos).toHaveLength(0);
    });

    it('ignores a directory that is not inside any checkout', async () => {
        const h = harness({ resolveRepoRoot: async () => null });
        setPaneDirectory(h.store, P1, '/not/a/repo');
        h.detect.paneDirectoryChanged({ workspaceID: W1, paneID: P1, directory: '/not/a/repo' });
        await h.settle();
        expect(associationsOf(h.store)).toHaveLength(0);
    });
});

describe('auto-unlink + GC (§GIT-080/§GIT-081)', () => {
    it('drops an auto-detected association once no pane is inside it, and GCs its auto-discovered repo', async () => {
        const h = harness({
            resolveRepoRoot: async () => ({ worktreeRoot: '/work/wt', parentRepoRoot: '/work/repo' })
        });
        setPaneDirectory(h.store, P1, '/work/wt');
        h.detect.paneDirectoryChanged({ workspaceID: W1, paneID: P1, directory: '/work/wt' });
        await h.settle();
        expect(associationsOf(h.store)).toHaveLength(1);

        setPaneDirectory(h.store, P1, '/elsewhere');
        h.detect.paneDirectoryChanged({ workspaceID: W1, paneID: P1, directory: '/elsewhere' });
        await h.settle();

        expect(associationsOf(h.store)).toHaveLength(0);
        expect(h.store.getState().repos).toHaveLength(0);
    });

    it('never removes a manually added association, and never GCs a manual repo', async () => {
        const h = harness();
        h.store.dispatch({
            type: 'add-repo',
            repo: {
                id: 'BBBBBBBB-0000-4000-8000-000000000001',
                path: '/manual/repo',
                name: 'repo',
                remoteURL: null,
                lastAccessedAt: NOW / 1000,
                isAutoDiscovered: false
            }
        });
        h.store.dispatch({
            type: 'add-repo-association',
            workspaceID: W1,
            association: {
                id: 'CCCCCCCC-0000-4000-8000-000000000001',
                repoID: 'BBBBBBBB-0000-4000-8000-000000000001',
                worktreePath: '/manual/repo',
                branchName: 'main',
                isAutoDetected: false
            }
        });
        setPaneDirectory(h.store, P1, '/elsewhere');
        h.detect.paneDirectoryChanged({ workspaceID: W1, paneID: P1, directory: '/elsewhere' });
        await h.settle();

        expect(associationsOf(h.store)).toHaveLength(1);
        expect(h.store.getState().repos).toHaveLength(1);
    });

    it('keeps a repo that another workspace still associates', async () => {
        const h = harness({
            resolveRepoRoot: async () => ({ worktreeRoot: '/work/wt', parentRepoRoot: '/work/repo' })
        });
        setPaneDirectory(h.store, P1, '/work/wt');
        h.detect.paneDirectoryChanged({ workspaceID: W1, paneID: P1, directory: '/work/wt' });
        await h.settle();
        const repoID = h.store.getState().repos[0]?.id ?? '';

        // A second workspace linking the same repo by hand.
        h.store.dispatch({ type: 'create-workspace', id: W2, paneID: P2, name: 'w2', now: NOW });
        h.store.dispatch({
            type: 'add-repo-association',
            workspaceID: W2,
            association: {
                id: 'CCCCCCCC-0000-4000-8000-000000000009',
                repoID,
                worktreePath: '/work/repo',
                branchName: 'main',
                isAutoDetected: false
            }
        });

        setPaneDirectory(h.store, P1, '/elsewhere');
        h.detect.paneDirectoryChanged({ workspaceID: W1, paneID: P1, directory: '/elsewhere' });
        await h.settle();

        expect(associationsOf(h.store, W1)).toHaveLength(0);
        expect(h.store.getState().repos.map((repo) => repo.id)).toEqual([repoID]);
    });

    it('leaves the association alone while a parked pane is still inside the worktree', async () => {
        const h = harness({
            resolveRepoRoot: async () => ({ worktreeRoot: '/work/wt', parentRepoRoot: '/work/repo' })
        });
        setPaneDirectory(h.store, P1, '/work/wt');
        h.detect.paneDirectoryChanged({ workspaceID: W1, paneID: P1, directory: '/work/wt' });
        await h.settle();

        // Park the pane (an `open --here` source keeps its PTY and its directory).
        h.store.dispatch({ type: 'park-pane', workspaceID: W1, paneID: P1 });
        h.detect.paneDirectoryChanged({ workspaceID: W1, paneID: P1, directory: '/work/wt' });
        await h.settle();

        expect(associationsOf(h.store)).toHaveLength(1);
    });
});
