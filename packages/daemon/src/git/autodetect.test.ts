import { describe, expect, it } from 'vitest';

import { createStore, emptyDaemonState, type KelpiStore } from '../store/index.js';
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
    readonly store: KelpiStore;
    readonly detect: RepoAutoDetectService;
    readonly persists: () => number;
    /** Every `refreshAssociation` call, in order (#48's directory-change fast path). */
    readonly refreshes: string[];
    setEnabled(value: boolean): void;
    /** Run the debounced link pass (timers are 0 ms here) and settle its async half. */
    settle(): Promise<void>;
}

function harness(
    git: Partial<GitService> = {},
    options: { enabled?: boolean; paneDirectory?: string; start?: boolean } = {}
): Harness {
    const store = createStore(emptyDaemonState(HOME));
    store.dispatch({
        type: 'create-workspace',
        id: W1,
        paneID: P1,
        name: 'w1',
        now: NOW,
        ...(options.paneDirectory !== undefined ? { workingDirectory: options.paneDirectory } : {})
    });
    let enabled = options.enabled ?? true;
    let persists = 0;
    const refreshes: string[] = [];
    const detect = createRepoAutoDetect({
        store,
        git: { ...stubGitService(), ...git },
        enabled: () => enabled,
        uuid: ids(),
        now: () => NOW,
        persist: () => {
            persists += 1;
        },
        refreshAssociation: (associationID) => {
            refreshes.push(associationID);
        },
        linkDebounceMs: 0,
        unlinkDebounceMs: 0
    });
    // The store subscription is what production runs (#48); the explicit
    // `paneDirectoryChanged` calls in the older tests below are then a harmless double-arm of
    // the same debounce, and they keep pinning the explicit seam.
    if (options.start ?? true) detect.start();
    return {
        store,
        detect,
        persists: () => persists,
        refreshes,
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

function setPaneDirectory(store: KelpiStore, paneID: string, directory: string): void {
    store.dispatch({ type: 'pane-directory-changed', paneID, directory, now: NOW });
}

function associationsOf(store: KelpiStore, workspaceID = W1) {
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

describe('store-driven triggers (issue #48: graft-git.md §8.9, app-state-core.md §7.7)', () => {
    const inRepo = {
        resolveRepoRoot: async () => ({ worktreeRoot: '/work/wt', parentRepoRoot: '/work/repo' })
    };

    it('auto-links a pane created inside a checkout that never reports a cwd (graft-07)', async () => {
        const h = harness(inRepo);
        // `kelpi pane create --cwd ~/code/repo`: the pane is born in the tree, and the shell's
        // first OSC 7 repeats that directory, which compose.ts drops as unchanged.
        h.store.dispatch({
            type: 'create-pane',
            workspaceID: W1,
            paneID: P2,
            now: NOW,
            workingDirectory: '/work/wt/src'
        });
        await h.settle();

        expect(associationsOf(h.store)).toHaveLength(1);
        expect(associationsOf(h.store)[0]).toMatchObject({ worktreePath: '/work/wt', isAutoDetected: true });
        expect(h.store.getState().repos).toHaveLength(1);
    });

    it('auto-links a restored pane already in the store when the reconciler starts (graft-07)', async () => {
        const h = harness(inRepo, { paneDirectory: '/work/wt', start: false });
        await h.settle();
        expect(associationsOf(h.store)).toHaveLength(0);

        h.detect.start();
        await h.settle();
        expect(associationsOf(h.store)).toHaveLength(1);
        // A restore's associations are read by the association watcher's own start, so the
        // seeding pass must not double that read through the fast path.
        expect(h.refreshes).toEqual([]);
    });

    it('schedules auto-unlink when the last pane inside the worktree is closed (graft-26, asc-15)', async () => {
        const h = harness(inRepo);
        setPaneDirectory(h.store, P1, '/work/wt');
        await h.settle();
        expect(associationsOf(h.store)).toHaveLength(1);

        // A second pane elsewhere keeps the workspace alive once P1 goes.
        h.store.dispatch({ type: 'create-pane', workspaceID: W1, paneID: P2, now: NOW, workingDirectory: '/elsewhere' });
        await h.settle();
        h.store.dispatch({ type: 'close-pane', workspaceID: W1, paneID: P1 });
        await h.settle();

        expect(associationsOf(h.store)).toHaveLength(0);
        expect(h.store.getState().repos).toHaveLength(0);
    });

    it('schedules auto-unlink when the shell inside the worktree exits (asc-15)', async () => {
        const h = harness(inRepo);
        h.store.dispatch({ type: 'create-pane', workspaceID: W1, paneID: P2, now: NOW, workingDirectory: '/work/wt' });
        await h.settle();
        expect(associationsOf(h.store)).toHaveLength(1);

        h.store.dispatch({ type: 'pane-process-terminated', paneID: P2 });
        await h.settle();

        expect(associationsOf(h.store)).toHaveLength(0);
        expect(h.store.getState().repos).toHaveLength(0);
    });

    it('keeps the association while another pane in the workspace is still inside (§GIT-080)', async () => {
        const h = harness(inRepo);
        setPaneDirectory(h.store, P1, '/work/wt');
        h.store.dispatch({ type: 'create-pane', workspaceID: W1, paneID: P2, now: NOW, workingDirectory: '/work/wt/src' });
        await h.settle();
        expect(associationsOf(h.store)).toHaveLength(1);

        h.store.dispatch({ type: 'close-pane', workspaceID: W1, paneID: P2 });
        await h.settle();

        expect(associationsOf(h.store)).toHaveLength(1);
    });

    it('does not arm a link for a pane created while the setting is off (§GIT-074)', async () => {
        const h = harness(inRepo, { enabled: false });
        h.store.dispatch({ type: 'create-pane', workspaceID: W1, paneID: P2, now: NOW, workingDirectory: '/work/wt' });
        await h.settle();
        expect(associationsOf(h.store)).toHaveLength(0);
    });
});

describe('directory-change fast path (issue #48: app-state-core.md §7.8, terminal-surface.md §7.2)', () => {
    const MANUAL_REPO = 'BBBBBBBB-0000-4000-8000-000000000001';
    const MANUAL_ASSOCIATION = 'CCCCCCCC-0000-4000-8000-000000000001';

    function withManualAssociation(h: Harness): void {
        h.store.dispatch({
            type: 'add-repo',
            repo: {
                id: MANUAL_REPO,
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
                id: MANUAL_ASSOCIATION,
                repoID: MANUAL_REPO,
                worktreePath: '/manual/repo',
                branchName: 'main',
                isAutoDetected: false
            }
        });
    }

    it('refreshes every association whose worktree contains the new pwd, and no other (asc-16, tsurf-27)', () => {
        const h = harness();
        withManualAssociation(h);
        setPaneDirectory(h.store, P1, '/manual/repo/src/deep');
        expect(h.refreshes).toEqual([MANUAL_ASSOCIATION]);

        // `cd` out again: nothing contains the new pwd, so nothing is re-read.
        setPaneDirectory(h.store, P1, '/elsewhere');
        expect(h.refreshes).toEqual([MANUAL_ASSOCIATION]);
        // A sibling that merely shares a prefix is not inside.
        setPaneDirectory(h.store, P1, '/manual/repo-other');
        expect(h.refreshes).toEqual([MANUAL_ASSOCIATION]);
    });

    it('is not gated on the auto-detect setting: a manual association still refreshes', () => {
        const h = harness({}, { enabled: false });
        withManualAssociation(h);
        setPaneDirectory(h.store, P1, '/manual/repo');
        expect(h.refreshes).toEqual([MANUAL_ASSOCIATION]);
    });

    it('fires on a pwd change, not on pane creation', () => {
        const h = harness();
        withManualAssociation(h);
        h.store.dispatch({ type: 'create-pane', workspaceID: W1, paneID: P2, now: NOW, workingDirectory: '/manual/repo' });
        expect(h.refreshes).toEqual([]);
    });
});
