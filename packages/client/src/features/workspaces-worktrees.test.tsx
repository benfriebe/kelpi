/**
 * The workspaces actions' worktree cleanup (graft-git.md §8.7): which delete carries which
 * worktree, what the `remove` setting does without a dialog, how a group cascade carries them,
 * and what the user is told afterwards.
 */

import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { DEFAULT_WS_SETTINGS } from '@kelpi/protocol';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorktreeCleanupCandidate } from '../chrome/WorktreeCleanupList';
import type { CommandReply } from '../connection';
import { createKelpiStore } from '../state';
import { useWorkspacesFeatureLifecycle } from './workspaces';
import { createWorkspacesActions, type WorkspacesActionHost } from './workspaces-actions';

afterEach(() => { vi.restoreAllMocks(); });

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const W2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const W3 = 'aaaaaaaa-0000-4000-8000-000000000003';
const G1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const R1 = 'dddddddd-0000-4000-8000-000000000001';

const SHARED: WorktreeCleanupCandidate = {
    worktreePath: '/home/test/kelpi/worktrees/app/shared',
    repoPath: '/home/test/code/app',
    branch: 'shared',
    managed: true,
    changedFiles: 0,
    commitsOnlyHere: 0,
    blocked: null,
    forceable: false,
    recommended: true,
    branchDeletable: true
};

type Commands = WorkspacesActionHost['commands'];

function setup(mode: 'ask' | 'remove' | 'keep' = 'ask') {
    const daemon = createDaemonStore(emptyDaemonState('/home/test'));
    daemon.dispatch({ type: 'create-workspace', id: W1, paneID: 'cccccccc-0000-4000-8000-000000000001', name: 'alpha', now: 1 });
    daemon.dispatch({ type: 'create-workspace', id: W2, paneID: 'cccccccc-0000-4000-8000-000000000002', name: 'beta', now: 2 });
    daemon.dispatch({ type: 'create-workspace', id: W3, paneID: 'cccccccc-0000-4000-8000-000000000003', name: 'gamma', now: 3 });
    daemon.dispatch({ type: 'create-group', id: G1, name: 'squad', now: 4 });
    daemon.dispatch({ type: 'move-workspace-to-group', id: W1, groupID: G1 });
    daemon.dispatch({ type: 'move-workspace-to-group', id: W2, groupID: G1 });
    daemon.dispatch({
        type: 'add-repo',
        repo: { id: R1, path: '/home/test/code/app', name: 'app', remoteURL: null, lastAccessedAt: 0, isAutoDiscovered: false }
    });
    for (const [workspaceID, id] of [[W1, 'S1'], [W2, 'S2']] as const) {
        daemon.dispatch({
            type: 'add-repo-association',
            workspaceID,
            association: { id, repoID: R1, worktreePath: SHARED.worktreePath, branchName: 'shared', isAutoDetected: false }
        });
    }
    const store = createKelpiStore();
    store.getState().applySnapshot(0, JSON.parse(JSON.stringify(daemon.getState())));
    store.getState().applySettings({
        ...DEFAULT_WS_SETTINGS,
        general: { ...DEFAULT_WS_SETTINGS.general, workspaceDeleteWorktrees: mode, workspaceDeleteBranches: true }
    });
    const deleteReply = vi.fn<(input: Parameters<Commands['deleteWorkspace']>[0]) => CommandReply>(() => ({ ok: true }));
    const rpc = {
        deleteWorkspace: vi.fn<Commands['deleteWorkspace']>(async (input) => deleteReply(input)),
        deleteGroup: vi.fn<Commands['deleteGroup']>().mockResolvedValue({ ok: true })
    };
    const lifecycle = renderHook(useWorkspacesFeatureLifecycle);
    const notifyFailure = vi.fn();
    const run = vi.fn((_label: string, command: Promise<CommandReply>) => { void command; return true as const; });
    const actions = createWorkspacesActions({
        store,
        commands: rpc as unknown as Commands,
        run,
        notifyFailure,
        activateWorkspaceAndReveal: vi.fn(),
        setSidebarVisible: vi.fn(),
        lifecycle: lifecycle.result.current
    });
    return { store, rpc, deleteReply, notifyFailure, run, actions };
}

describe('workspace delete worktree cleanup', () => {
    it("a bulk delete sends the cleanup on its last delete, after the others replied, naming them", async () => {
        const h = setup();
        h.actions.deleteWorkspaces([W1, W2], { candidates: [SHARED], deleteBranches: true });
        expect(h.rpc.deleteWorkspace.mock.calls.map(([input]) => input)).toEqual([{ workspace: W1, force: true }]);
        await waitFor(() => expect(h.rpc.deleteWorkspace).toHaveBeenCalledTimes(2));
        expect(h.rpc.deleteWorkspace.mock.calls[1]?.[0]).toEqual({
            workspace: W2,
            force: true,
            worktreePaths: [SHARED.worktreePath],
            deleteBranches: true,
            batchIDs: [W1]
        });
    });

    it('a refused member is left out of the batch, and a refused carrier says nothing was removed', async () => {
        const h = setup();
        h.deleteReply.mockImplementation((input) =>
            input.workspace === W1 ? { ok: false, error: 'vetoed by a plugin' } : { ok: true }
        );
        h.actions.deleteWorkspaces([W1, W2], { candidates: [SHARED], deleteBranches: false });
        await waitFor(() => expect(h.rpc.deleteWorkspace).toHaveBeenCalledTimes(2));
        expect(h.rpc.deleteWorkspace.mock.calls[1]?.[0]).toEqual({
            workspace: W2,
            force: true,
            worktreePaths: [SHARED.worktreePath],
            deleteBranches: false
        });

        const carrier = setup();
        carrier.deleteReply.mockImplementation((input) =>
            input.workspace === W2 ? { ok: false, error: 'vetoed by a plugin' } : { ok: true }
        );
        carrier.actions.deleteWorkspaces([W1, W2], { candidates: [SHARED], deleteBranches: false });
        await waitFor(() => expect(carrier.notifyFailure).toHaveBeenCalledWith('Worktrees kept', expect.stringContaining('refused')));
    });

    it('a ticked dirty worktree is sent as forced; nothing else ever is', () => {
        const h = setup();
        const dirty: WorktreeCleanupCandidate = {
            ...SHARED,
            worktreePath: '/home/test/kelpi/worktrees/app/dirty',
            changedFiles: 3,
            blocked: { kind: 'dirty', reason: 'has 3 uncommitted changes' },
            forceable: true,
            recommended: false
        };
        h.actions.deleteWorkspace(W2, { cleanup: { candidates: [SHARED, dirty], deleteBranches: true } });
        expect(h.rpc.deleteWorkspace).toHaveBeenCalledWith({
            workspace: W2,
            force: true,
            worktreePaths: [SHARED.worktreePath, dirty.worktreePath],
            forceWorktreePaths: [dirty.worktreePath],
            deleteBranches: true
        });
    });

    it('a single delete with a choice goes out at once, carrying the paths', () => {
        const h = setup();
        h.actions.deleteWorkspace(W2, { allowLast: true, cleanup: { candidates: [SHARED], deleteBranches: false } });
        expect(h.rpc.deleteWorkspace).toHaveBeenCalledWith({
            workspace: W2,
            force: true,
            allowLast: true,
            worktreePaths: [SHARED.worktreePath],
            deleteBranches: false
        });
    });

    it('in `ask` mode, a delete the dialog had no list for touches no worktree', () => {
        const h = setup('ask');
        h.actions.deleteWorkspace(W2);
        expect(h.rpc.deleteWorkspace).toHaveBeenCalledWith({ workspace: W2, force: true });
    });

    it('in `remove` mode, a delete asks the daemon to prune what Kelpi made, without a preview', () => {
        const h = setup('remove');
        h.actions.deleteWorkspace(W2, { allowLast: true });
        expect(h.rpc.deleteWorkspace).toHaveBeenCalledWith({
            workspace: W2,
            force: true,
            allowLast: true,
            pruneWorktrees: true,
            deleteBranches: true
        });
    });

    it('an explicit null (the list never arrived) keeps every worktree even in `remove` mode', () => {
        const h = setup('remove');
        h.actions.deleteWorkspace(W2, { cleanup: null });
        expect(h.rpc.deleteWorkspace).toHaveBeenCalledWith({ workspace: W2, force: true });
    });

    it('a group cascade with worktrees deletes its members, then the empty group', async () => {
        const h = setup();
        h.actions.deleteGroup(G1, true, { candidates: [SHARED], deleteBranches: false });
        await waitFor(() => expect(h.rpc.deleteGroup).toHaveBeenCalled());
        expect(h.rpc.deleteWorkspace.mock.calls.map(([input]) => input)).toEqual([
            { workspace: W1, force: true, allowLast: true },
            { workspace: W2, force: true, allowLast: true, worktreePaths: [SHARED.worktreePath], deleteBranches: false, batchIDs: [W1] }
        ]);
        expect(h.rpc.deleteGroup).toHaveBeenCalledWith({ group: G1, cascade: false });

        const plain = setup();
        plain.actions.deleteGroup(G1, true, { candidates: [], deleteBranches: true });
        expect(plain.rpc.deleteWorkspace).not.toHaveBeenCalled();
        expect(plain.rpc.deleteGroup).toHaveBeenCalledWith({ group: G1, cascade: true });
    });

    it('reports what each delete removed and kept', async () => {
        const h = setup();
        h.deleteReply.mockReturnValueOnce({
            ok: true,
            workspace_id: W2,
            workspace_name: 'beta',
            worktrees: [{ worktree_path: SHARED.worktreePath, branch: 'shared', removed: false, blocked: 'dirty', error: 'has 1 uncommitted change' }]
        });
        h.actions.deleteWorkspace(W2, { cleanup: { candidates: [SHARED], deleteBranches: true } });
        await waitFor(() => expect(h.store.getState().ui.toasts).toHaveLength(1));
        expect(h.store.getState().ui.toasts[0]).toMatchObject({ title: 'Kept on disk' });
        expect(h.store.getState().ui.toasts[0]?.body).toContain('has 1 uncommitted change');
    });

    it('a refused delete is a failure toast, as before', async () => {
        const h = setup();
        h.deleteReply.mockReturnValueOnce({ ok: false, error: 'refusing to delete the last workspace' });
        h.actions.deleteWorkspace(W2);
        await waitFor(() => expect(h.notifyFailure).toHaveBeenCalledWith('Delete workspace', 'refusing to delete the last workspace'));
    });
});
