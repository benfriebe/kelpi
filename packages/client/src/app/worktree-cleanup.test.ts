/**
 * The window's half of worktree cleanup (graft-git.md §8.7): reading the daemon's plan and
 * results, the mirror-only "is there anything to ask" test, and spreading a choice over a
 * bulk delete.
 */

import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { DEFAULT_WS_SETTINGS } from '@kelpi/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { WorktreeCleanupCandidate } from '../chrome/WorktreeCleanupList';
import { createKelpiStore } from '../state';
import {
    createWorktreeCleanupSource,
    mayHaveLinkedWorktrees,
    parseWorktreeCleanupPreview,
    worktreeCleanupToasts
} from './worktree-cleanup';

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const W2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const W3 = 'aaaaaaaa-0000-4000-8000-000000000003';
const G1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const R1 = 'dddddddd-0000-4000-8000-000000000001';

function candidate(overrides: Partial<WorktreeCleanupCandidate> & { worktreePath: string }): WorktreeCleanupCandidate {
    return {
        repoPath: '/code/app',
        branch: 'feat',
        managed: true,
        changedFiles: 0,
        commitsOnlyHere: 0,
        blocked: null,
        forceable: false,
        recommended: true,
        branchDeletable: true,
        ...overrides
    };
}

/** W1 works in the main checkout, W2 in a linked worktree of it; W3 is in group G1 with W2. */
function mirror() {
    const daemon = createDaemonStore(emptyDaemonState('/home/me'));
    for (const [id, n] of [[W1, 1], [W2, 2], [W3, 3]] as const) {
        daemon.dispatch({ type: 'create-workspace', id, paneID: `cccccccc-0000-4000-8000-00000000000${String(n)}`, name: `w${String(n)}`, now: n });
    }
    daemon.dispatch({ type: 'create-group', id: G1, name: 'g', now: 4 });
    daemon.dispatch({ type: 'move-workspace-to-group', id: W2, groupID: G1 });
    daemon.dispatch({ type: 'move-workspace-to-group', id: W3, groupID: G1 });
    daemon.dispatch({
        type: 'add-repo',
        repo: { id: R1, path: '/code/app', name: 'app', remoteURL: null, lastAccessedAt: 0, isAutoDiscovered: false }
    });
    daemon.dispatch({
        type: 'add-repo-association',
        workspaceID: W1,
        association: { id: 'A-main', repoID: R1, worktreePath: '/code/app/', branchName: 'main', isAutoDetected: false }
    });
    daemon.dispatch({
        type: 'add-repo-association',
        workspaceID: W2,
        association: { id: 'A-wt', repoID: R1, worktreePath: '/home/me/kelpi/worktrees/app/feat', branchName: 'feat', isAutoDetected: false }
    });
    return daemon;
}

describe('parseWorktreeCleanupPreview', () => {
    it('reads the plan, and never recommends what the plan blocked', () => {
        const parsed = parseWorktreeCleanupPreview({
            ok: true,
            worktrees: [
                {
                    worktree_path: '/w/feat',
                    repo_path: '/code/app',
                    associations: [{ workspace_id: W2, association_id: 'A-wt' }, { junk: true }],
                    branch: 'feat',
                    managed: true,
                    changed_files: 0,
                    commits_only_here: 0,
                    blocked: null,
                    recommended: true,
                    branch_deletable: true
                },
                {
                    worktree_path: '/w/busy',
                    repo_path: '/code/app',
                    associations: [],
                    branch: null,
                    managed: true,
                    changed_files: 1,
                    commits_only_here: null,
                    blocked: { kind: 'dirty', reason: 'has 1 uncommitted change', changed_files: 1 },
                    forceable: true,
                    recommended: true,
                    branch_deletable: false
                },
                { worktree_path: '' },
                'nonsense'
            ]
        });
        expect(parsed).toEqual([
            candidate({ worktreePath: '/w/feat' }),
            candidate({
                worktreePath: '/w/busy',
                branch: null,
                changedFiles: 1,
                commitsOnlyHere: null,
                blocked: { kind: 'dirty', reason: 'has 1 uncommitted change' },
                forceable: true,
                recommended: false,
                branchDeletable: false
            })
        ]);
    });

    it('answers null for a failed reply', () => {
        expect(parseWorktreeCleanupPreview({ ok: false, error: 'no' })).toBeNull();
        expect(parseWorktreeCleanupPreview({ ok: true })).toBeNull();
    });
});

describe('mayHaveLinkedWorktrees', () => {
    it('is false for a workspace that only works in a main checkout (trailing slash and all)', () => {
        const state = mirror().getState();
        expect(mayHaveLinkedWorktrees(state, [W1])).toBe(false);
        expect(mayHaveLinkedWorktrees(state, [W3])).toBe(false);
        expect(mayHaveLinkedWorktrees(state, [W1, W2])).toBe(true);
    });

    it('asks about a row whose repo left the registry: only git can say what it is', () => {
        const daemon = mirror();
        daemon.dispatch({
            type: 'add-repo-association',
            workspaceID: W3,
            association: { id: 'A-orphan', repoID: 'gone', worktreePath: '/elsewhere', branchName: null, isAutoDetected: true }
        });
        expect(mayHaveLinkedWorktrees(daemon.getState(), [W3])).toBe(true);
    });
});

describe('worktreeCleanupToasts', () => {
    it('says how many uncommitted changes a forced removal took with it', () => {
        const [toast] = worktreeCleanupToasts(
            { ok: true, worktrees: [{ worktree_path: '/home/me/w/a', branch: 'a', removed: true, discarded_changes: 3, branch_deleted: true }] },
            '/home/me'
        );
        expect(toast).toEqual({ title: 'Removed worktree', body: '~/w/a (and branch a, 3 uncommitted changes)', sticky: false });
    });

    it('reports what went (auto-dismissed) and what stayed (sticky), home-abbreviated', () => {
        const toasts = worktreeCleanupToasts(
            {
                ok: true,
                worktrees: [
                    { association_id: 'A', worktree_path: '/home/me/w/a', branch: 'a', removed: true, branch_deleted: true },
                    { association_id: 'B', worktree_path: '/home/me/w/b', branch: 'b', removed: true, branch_deleted: false, branch_error: '2 commits no other branch or remote has' },
                    { worktree_path: '/home/me/w/c', branch: 'c', removed: false, blocked: 'dirty', error: 'has 1 uncommitted change' }
                ]
            },
            '/home/me'
        );
        expect(toasts).toEqual([
            { title: 'Removed 2 worktrees', body: '~/w/a (and branch a), ~/w/b', sticky: false },
            {
                title: 'Kept on disk',
                body: 'branch b: 2 commits no other branch or remote has; ~/w/c: has 1 uncommitted change',
                sticky: true
            }
        ]);
        expect(worktreeCleanupToasts({ ok: true, workspace_id: W1 }, '/home/me')).toEqual([]);
    });
});

describe('createWorktreeCleanupSource', () => {
    function setup(mode: 'ask' | 'remove' | 'keep') {
        const daemon = mirror();
        const store = createKelpiStore();
        store.getState().applySnapshot(0, JSON.parse(JSON.stringify(daemon.getState())));
        store.getState().applySettings({
            ...DEFAULT_WS_SETTINGS,
            general: { ...DEFAULT_WS_SETTINGS.general, workspaceDeleteWorktrees: mode, workspaceDeleteBranches: false }
        });
        const preview = vi.fn(async (_ids: readonly string[]) => ({
            ok: true,
            worktrees: [{ worktree_path: '/w/feat', repo_path: '/code/app', associations: [], recommended: true }]
        }));
        const remember = vi.fn();
        return { source: createWorktreeCleanupSource({ store, preview, remember }), preview, remember };
    }

    it('asks git only in `ask` mode, only for workspaces that could have a linked worktree', async () => {
        const { source, preview } = setup('ask');
        expect(source.preview({ workspaceIDs: [W1] })).toBeNull();
        expect(preview).not.toHaveBeenCalled();

        const planned = await source.preview({ groupID: G1 });
        // A group's plan covers ALL of its members, as the cascade deletes all of them.
        expect(preview).toHaveBeenCalledWith([W2, W3]);
        expect(planned?.map((entry) => entry.worktreePath)).toEqual(['/w/feat']);
        expect(source.deleteBranchesDefault).toBe(false);
        expect(source.automaticNote?.({ workspaceIDs: [W2] })).toBeNull();
    });

    it('lists nothing in `remove` or `keep` mode, and only `remove` says what will happen', () => {
        const remove = setup('remove');
        expect(remove.source.preview({ workspaceIDs: [W2] })).toBeNull();
        expect(remove.source.automaticNote?.({ workspaceIDs: [W2] })).toContain('removed too');
        expect(remove.source.automaticNote?.({ workspaceIDs: [W1] })).toBeNull();

        const keep = setup('keep');
        expect(keep.source.preview({ workspaceIDs: [W2] })).toBeNull();
        expect(keep.source.automaticNote?.({ workspaceIDs: [W2] })).toBeNull();
    });

    it('turns a failed preview into a rejection the dialog shows', async () => {
        const { source, preview } = setup('ask');
        preview.mockResolvedValueOnce({ ok: false, error: 'daemon too old' } as never);
        await expect(source.preview({ workspaceIDs: [W2] })).rejects.toThrow('daemon too old');
    });
});
