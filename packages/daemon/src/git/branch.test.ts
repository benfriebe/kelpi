import { describe, expect, it, vi } from 'vitest';

import { createStore, emptyDaemonState, type KelpiStore } from '../store/index.js';
import { createPaneBranchWatch, type BranchGit, type PaneBranchWatchService } from './branch.js';

const HOME = '/Users/test';
const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const P1 = 'DDDDDDDD-0000-4000-8000-000000000001';
const P2 = 'DDDDDDDD-0000-4000-8000-000000000002';
const NOW = 1_755_500_000_000;

interface Harness {
    readonly store: KelpiStore;
    readonly watch: PaneBranchWatchService;
    /** Every `git rev-parse` this run has made, in order. */
    readonly calls: readonly string[];
    /** Queue an answer for a directory (default: `main`). */
    setBranch(directory: string, branch: string | null): void;
    fail(directory: string): void;
    settle(): Promise<void>;
    branchOf(paneID: string): string | null;
}

function harness(options: { cacheTtlMs?: number; lookup?: BranchGit['getCurrentBranch'] } = {}): Harness {
    const store = createStore(emptyDaemonState(HOME));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: P1, name: 'w1', now: NOW });
    const branches = new Map<string, string | null>();
    const failures = new Set<string>();
    const calls: string[] = [];
    const watch = createPaneBranchWatch({
        store,
        git: {
            async getCurrentBranch(repoPath) {
                calls.push(repoPath);
                if (options.lookup !== undefined) return options.lookup(repoPath);
                if (failures.has(repoPath)) throw new Error('not a repo');
                return branches.has(repoPath) ? (branches.get(repoPath) ?? null) : 'main';
            }
        },
        debounceMs: 0,
        now: () => NOW,
        ...(options.cacheTtlMs !== undefined ? { cacheTtlMs: options.cacheTtlMs } : {})
    });
    return {
        store,
        watch,
        calls,
        setBranch(directory, branch) {
            branches.set(directory, branch);
        },
        fail(directory) {
            failures.add(directory);
        },
        async settle() {
            for (let pass = 0; pass < 3; pass += 1) {
                await new Promise<void>((resolve) => setTimeout(resolve, 1));
                await watch.idle();
            }
        },
        branchOf(paneID) {
            for (const workspace of store.getState().workspaces) {
                const pane = workspace.panes.find((entry) => entry.id === paneID);
                if (pane !== undefined) return pane.gitBranch ?? null;
            }
            return null;
        }
    };
}

function setDirectory(store: KelpiStore, paneID: string, directory: string): void {
    store.dispatch({ type: 'pane-directory-changed', paneID, directory, now: NOW });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

const flush = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
};

describe('createPaneBranchWatch (§GIT-091 / §TERM-145)', () => {
    it('resolves a branch for the panes already in state when it starts', async () => {
        const h = harness();
        setDirectory(h.store, P1, '/repo');
        h.watch.start();
        await h.settle();
        expect(h.branchOf(P1)).toBe('main');
        h.watch.dispose();
    });

    it('chains a lookup off every working-directory change (the OSC 7 path)', async () => {
        const h = harness();
        h.watch.start();
        h.setBranch('/repo', 'main');
        setDirectory(h.store, P1, '/repo');
        await h.settle();
        expect(h.branchOf(P1)).toBe('main');

        h.setBranch('/other', 'feature/x');
        setDirectory(h.store, P1, '/other');
        await h.settle();
        expect(h.branchOf(P1)).toBe('feature/x');
        h.watch.dispose();
    });

    it('keeps git’s literal "HEAD" for a detached checkout', async () => {
        const h = harness();
        h.watch.start();
        h.setBranch('/detached', 'HEAD');
        setDirectory(h.store, P1, '/detached');
        await h.settle();
        expect(h.branchOf(P1)).toBe('HEAD');
        h.watch.dispose();
    });

    it('leaves the branch null outside a checkout, and when git fails outright', async () => {
        const h = harness();
        h.watch.start();
        h.setBranch('/plain', null);
        setDirectory(h.store, P1, '/plain');
        await h.settle();
        expect(h.branchOf(P1)).toBeNull();

        h.fail('/broken');
        setDirectory(h.store, P1, '/broken');
        await h.settle();
        expect(h.branchOf(P1)).toBeNull();
        h.watch.dispose();
    });

    it('caches per directory, so two panes in one repo cost one rev-parse', async () => {
        const h = harness();
        h.watch.start();
        h.store.dispatch({
            type: 'split-pane',
            workspaceID: W1,
            sourcePaneID: P1,
            paneID: P2,
            direction: 'horizontal',
            now: NOW
        });
        setDirectory(h.store, P1, '/repo');
        setDirectory(h.store, P2, '/repo');
        await h.settle();
        expect(h.branchOf(P1)).toBe('main');
        expect(h.branchOf(P2)).toBe('main');
        expect(h.calls.filter((call) => call === '/repo')).toHaveLength(1);
        h.watch.dispose();
    });

    it('does not re-dispatch when the answer has not changed', async () => {
        const h = harness({ cacheTtlMs: 0 });
        h.watch.start();
        setDirectory(h.store, P1, '/repo');
        await h.settle();
        let events = 0;
        const off = h.store.subscribe(() => {
            events += 1;
        });
        await h.watch.refresh(P1);
        await h.settle();
        off();
        expect(events).toBe(0);
        h.watch.dispose();
    });

    it('re-resolves the panes inside a worktree whose HEAD moved', async () => {
        const h = harness({ cacheTtlMs: 60_000 });
        h.watch.start();
        setDirectory(h.store, P1, '/repo/src');
        await h.settle();
        expect(h.branchOf(P1)).toBe('main');

        // A checkout: the directory has not changed, only what git says about it.
        h.setBranch('/repo/src', 'release');
        h.watch.repoChanged('/repo');
        await h.settle();
        expect(h.branchOf(P1)).toBe('release');
        h.watch.dispose();
    });

    it('ignores a HEAD change in an unrelated tree', async () => {
        const h = harness({ cacheTtlMs: 60_000 });
        h.watch.start();
        setDirectory(h.store, P1, '/repo/src');
        await h.settle();
        const before = h.calls.length;
        h.watch.repoChanged('/repo-other');
        await h.settle();
        expect(h.calls.length).toBe(before);
        h.watch.dispose();
    });

    it('stops touching a pane that is gone', async () => {
        const h = harness();
        h.watch.start();
        setDirectory(h.store, P1, '/repo');
        await h.settle();
        const before = h.calls.length;
        h.store.dispatch({ type: 'close-pane', workspaceID: W1, paneID: P1 });
        await h.settle();
        expect(h.calls.length).toBe(before);
        h.watch.dispose();
    });

    it('immediately clears old provider branches and refreshes every live directory', async () => {
        const h = harness({ cacheTtlMs: 60_000 });
        h.store.dispatch({
            type: 'split-pane', workspaceID: W1, sourcePaneID: P1, paneID: P2,
            direction: 'horizontal', now: NOW
        });
        setDirectory(h.store, P1, '/repo');
        setDirectory(h.store, P2, '/other');
        h.watch.start();
        await h.settle();
        h.setBranch('/repo', 'provider/one');
        h.setBranch('/other', 'provider/two');
        h.watch.invalidate();
        expect(h.branchOf(P1)).toBeNull();
        expect(h.branchOf(P2)).toBeNull();
        await h.settle();
        expect(h.branchOf(P1)).toBe('provider/one');
        expect(h.branchOf(P2)).toBe('provider/two');
        expect(h.calls.filter((path) => path === '/repo')).toHaveLength(2);
        expect(h.calls.filter((path) => path === '/other')).toHaveLength(2);
        h.watch.dispose();
    });

    it('shares a pending branch read between panes in the same directory', async () => {
        const answer = deferred<string | null>();
        const h = harness({ lookup: () => answer.promise });
        h.store.dispatch({
            type: 'split-pane', workspaceID: W1, sourcePaneID: P1, paneID: P2,
            direction: 'horizontal', now: NOW
        });
        setDirectory(h.store, P1, '/repo');
        setDirectory(h.store, P2, '/repo');
        h.watch.start();
        const first = h.watch.refresh(P1);
        const second = h.watch.refresh(P2);
        await flush();
        expect(h.calls).toEqual(['/repo']);
        answer.resolve('shared/main');
        await Promise.all([first, second]);
        expect(h.branchOf(P1)).toBe('shared/main');
        expect(h.branchOf(P2)).toBe('shared/main');
        h.watch.dispose();
    });

    it.each(['provider', 'HEAD'] as const)('retires a pending read and its cache after a %s change', async (change) => {
        const oldBranch = deferred<string | null>();
        const lookup = vi.fn<BranchGit['getCurrentBranch']>()
            .mockReturnValueOnce(oldBranch.promise)
            .mockResolvedValue('new/main');
        const h = harness({ lookup, cacheTtlMs: 60_000 });
        setDirectory(h.store, P1, '/repo');
        h.watch.start();
        const oldRead = h.watch.refresh(P1);
        await flush();
        if (change === 'provider') h.watch.invalidate();
        else {
            h.watch.repoChanged('/repo');
            await h.watch.refresh(P1);
        }
        await flush();
        expect(h.branchOf(P1)).toBe('new/main');
        oldBranch.resolve('stale/main');
        await oldRead;
        await h.watch.refresh(P1);
        expect(h.branchOf(P1)).toBe('new/main');
        expect(h.calls).toEqual(['/repo', '/repo']);
        h.watch.dispose();
    });

    it('does not apply an old directory answer after the pane moved', async () => {
        const oldBranch = deferred<string | null>();
        const h = harness({ lookup: async (path) => path === '/repo' ? oldBranch.promise : 'other/main' });
        setDirectory(h.store, P1, '/repo');
        h.watch.start();
        const oldRead = h.watch.refresh(P1);
        await flush();
        setDirectory(h.store, P1, '/other');
        await h.watch.refresh(P1);
        oldBranch.resolve('stale/main');
        await oldRead;
        expect(h.branchOf(P1)).toBe('other/main');
        h.watch.dispose();
    });

    it('ignores pending reads and invalidation after disposal', async () => {
        const oldBranch = deferred<string | null>();
        const h = harness({ lookup: () => oldBranch.promise });
        setDirectory(h.store, P1, '/repo');
        h.watch.start();
        const oldRead = h.watch.refresh(P1);
        await flush();
        h.watch.dispose();
        oldBranch.resolve('stale/main');
        await oldRead;
        h.watch.invalidate();
        await h.watch.refresh(P1);
        expect(h.branchOf(P1)).toBeNull();
        expect(h.calls).toEqual(['/repo']);
    });
});
