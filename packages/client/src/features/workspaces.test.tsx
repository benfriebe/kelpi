import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { DEFAULT_WS_SETTINGS } from '@kelpi/protocol';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommandReply } from '../connection';
import { createKelpiRuntime, createKelpiStore } from '../state';
import {
    WorkspacesFeatureView, useWorkspacesFeatureLifecycle, useWorkspacesFeatureModel,
    type WorkspacesFeatureViewProps
} from './workspaces';
import { createWorkspacesActions, type WorkspacesActionHost } from './workspaces-actions';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const W2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const W3 = 'aaaaaaaa-0000-4000-8000-000000000003';
const G1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const G2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const P1 = 'cccccccc-0000-4000-8000-000000000001';
const P2 = 'cccccccc-0000-4000-8000-000000000002';
const P3 = 'cccccccc-0000-4000-8000-000000000003';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

function fixture() {
    const daemon = createDaemonStore(emptyDaemonState('/home/test'));
    daemon.dispatch({ type: 'create-workspace', id: W1, paneID: P1, name: 'alpha', color: 'blue', now: 1 });
    daemon.dispatch({ type: 'create-workspace', id: W2, paneID: P2, name: 'beta', color: 'red', now: 2 });
    daemon.dispatch({ type: 'create-group', id: G1, name: 'squad', now: 3 });
    daemon.dispatch({ type: 'move-workspace-to-group', id: W2, groupID: G1 });
    const store = createKelpiStore();
    let seq = 0;
    const sync = () => store.getState().applySnapshot(seq++, JSON.parse(JSON.stringify(daemon.getState())));
    sync();
    store.getState().setActiveWorkspace(W1);
    return { daemon, store, sync };
}

type Commands = WorkspacesActionHost['commands'];
function commands() {
    return {
        addRepoAssociation: vi.fn<Commands['addRepoAssociation']>().mockResolvedValue({ ok: true }),
        createGroup: vi.fn<Commands['createGroup']>().mockResolvedValue({ ok: true }),
        createGroupForWorkspaces: vi.fn<Commands['createGroupForWorkspaces']>().mockResolvedValue({ ok: true }),
        createWorkspace: vi.fn<Commands['createWorkspace']>().mockResolvedValue({ ok: true }),
        deleteGroup: vi.fn<Commands['deleteGroup']>().mockResolvedValue({ ok: true }),
        deleteWorkspace: vi.fn<Commands['deleteWorkspace']>().mockResolvedValue({ ok: true }),
        labelWorkspace: vi.fn<Commands['labelWorkspace']>().mockResolvedValue({ ok: true }),
        moveWorkspace: vi.fn<Commands['moveWorkspace']>().mockResolvedValue({ ok: true }),
        moveWorkspaces: vi.fn<Commands['moveWorkspaces']>().mockResolvedValue({ ok: true }),
        renameGroup: vi.fn<Commands['renameGroup']>().mockResolvedValue({ ok: true }),
        renameWorkspace: vi.fn<Commands['renameWorkspace']>().mockResolvedValue({ ok: true }),
        setBulkColor: vi.fn<Commands['setBulkColor']>().mockResolvedValue({ ok: true }),
        setBulkLabel: vi.fn<Commands['setBulkLabel']>().mockResolvedValue({ ok: true }),
        setGroupCollapsed: vi.fn<Commands['setGroupCollapsed']>().mockResolvedValue({ ok: true }),
        setGroupColor: vi.fn<Commands['setGroupColor']>().mockResolvedValue({ ok: true }),
        setGroupIcon: vi.fn<Commands['setGroupIcon']>().mockResolvedValue({ ok: true }),
        setWorkspaceIcon: vi.fn<Commands['setWorkspaceIcon']>().mockResolvedValue({ ok: true }),
        setWorkspaceProfile: vi.fn<Commands['setWorkspaceProfile']>().mockResolvedValue({ ok: true })
    };
}

function setup() {
    const data = fixture();
    const rpc = commands();
    const lifecycle = renderHook(useWorkspacesFeatureLifecycle);
    const activate = vi.fn();
    const notifyFailure = vi.fn();
    const setVisible = vi.fn<WorkspacesActionHost['setSidebarVisible']>();
    const run = vi.fn((_label: string, _command: Promise<CommandReply>) => true);
    // Retain this action object while the mirror and hook state change, as App does.
    const actions = createWorkspacesActions({ store: data.store, commands: rpc, run,
        notifyFailure, activateWorkspaceAndReveal: activate, setSidebarVisible: setVisible,
        lifecycle: lifecycle.result.current });
    return { ...data, rpc, lifecycle, activate, notifyFailure, setVisible, run, actions };
}

function viewProps(h: ReturnType<typeof setup>): WorkspacesFeatureViewProps {
    const model = renderHook(() => useWorkspacesFeatureModel(h.store.getState())).result.current;
    return { model, actions: h.actions, lifecycle: h.lifecycle.result.current, store: h.store,
        repos: [], remotes: new Map(), remoteSelection: null, selectRemote: vi.fn(), bucket: 'dark',
        reportSelection: vi.fn(), suppressDeleteConfirm: vi.fn(), openSettings: vi.fn(), reportFailure: h.notifyFailure };
}

describe('bundled Workspaces lifecycle and model', () => {
    it('drains Select All on a hidden view mounting, including collapsed members, only once', () => {
        const h = setup();
        h.daemon.dispatch({ type: 'set-group-collapsed', id: G1, collapsed: true });
        h.sync();
        expect(h.actions.selectAllWorkspaces()).toBe(true);
        expect(h.setVisible).toHaveBeenCalledWith(true);
        expect(h.lifecycle.result.current.pendingSelectAllRef.current).toBe(true);
        const props = viewProps(h);
        const view = render(<WorkspacesFeatureView {...props} />);
        expect(props.reportSelection).toHaveBeenLastCalledWith(new Set([W1, W2]));
        expect(h.lifecycle.result.current.pendingSelectAllRef.current).toBe(false);
        // Updating selection republishes the handle. That must not replay the queued action.
        act(() => { expect(h.actions.deselectAllWorkspaces()).toBe(true); });
        expect(props.reportSelection).toHaveBeenLastCalledWith(new Set());
        expect(h.actions.deselectAllWorkspaces()).toBe(false);
        act(() => { expect(h.actions.selectAllWorkspaces()).toBe(true); });
        view.unmount();
        expect(props.reportSelection).toHaveBeenLastCalledWith(new Set());
        expect(h.lifecycle.result.current.sidebarSelectionRef.current).toBeNull();
        expect(h.lifecycle.result.current.sidebarEscapeRef.current).toBeNull();
        render(<WorkspacesFeatureView {...props} />);
        expect(screen.getAllByTestId('workspace-row').every(row => row.dataset['selected'] !== 'true')).toBe(true);
    });

    it('keeps repeated create requests distinct and leaves group inheritance to current settings', () => {
        const h = setup();
        act(() => { h.actions.newWorkspace(); h.actions.newWorkspace(); });
        expect(h.lifecycle.result.current.sidebarCreateRequest).toEqual({ kind: 'workspace', groupID: null, seq: 2 });
        expect(h.rpc.createWorkspace).not.toHaveBeenCalled();
        h.store.getState().setActiveWorkspace(W2);
        h.store.getState().applySettings({ ...DEFAULT_WS_SETTINGS,
            profiles: [{ name: 'work', env: {} }], remoteDaemons: [{ name: 'lab', url: 'http://lab' }],
            general: { ...DEFAULT_WS_SETTINGS.general, inheritGroupOnNewWorkspace: true } });
        const model = renderHook(() => useWorkspacesFeatureModel(h.store.getState()));
        expect(model.result.current.inheritGroupID).toBe(G1);
        expect(model.result.current.profiles).toEqual(['work']);
        expect(model.result.current.remoteNames).toEqual(['lab']);
        h.store.getState().applySettings({ ...h.store.getState().settings.value,
            general: { ...h.store.getState().settings.value.general, inheritGroupOnNewWorkspace: false } });
        model.rerender();
        expect(model.result.current.inheritGroupID).toBeNull();
        act(() => h.lifecycle.result.current.setSidebarCreateRequest(null));
        const props = { ...viewProps(h), model: model.result.current };
        render(<WorkspacesFeatureView {...props} />);
        fireEvent.change(screen.getByTestId('sidebar-filter'), { target: { value: 'beta' } });
        expect(h.store.getState().ui.sidebarFilter).toBe('beta');
        model.rerender();
        expect(model.result.current.entries).toHaveLength(1);
        expect(model.result.current.entries[0]?.kind).toBe('group');
    });
});

describe('retained Workspaces actions', () => {
    it('uses the latest active workspace and visible order for switching and rename requests', () => {
        const h = setup();
        h.actions.switchRelative(1);
        expect(h.activate).toHaveBeenLastCalledWith(W2);
        h.store.getState().setActiveWorkspace(W2);
        h.actions.switchRelative(1);
        expect(h.activate).toHaveBeenLastCalledWith(W1);
        act(() => { expect(h.actions.beginRenameActiveWorkspace()).toBe(true); });
        expect(h.lifecycle.result.current.sidebarRenameRequest).toEqual({ kind: 'workspace', id: W2 });
        expect(h.setVisible).toHaveBeenCalledWith(true);
        h.daemon.dispatch({ type: 'set-group-collapsed', id: G1, collapsed: true });
        h.daemon.dispatch({ type: 'create-workspace', id: W3, paneID: P3, name: 'gamma', color: 'green', now: 4 });
        h.sync();
        expect(h.actions.switchRelative(1)).toBe(false);
        expect(h.actions.switchToIndex(1)).toBe(true);
        expect(h.activate).toHaveBeenLastCalledWith(W3);
        expect(h.actions.switchToIndex(2)).toBe(false);
        expect(h.actions.renameWorkspace(W2, '   ')).toBe(false);
        expect(h.rpc.renameWorkspace).not.toHaveBeenCalled();
        expect(h.actions.renameWorkspace(W2, '  revised name  ')).toBe(true);
        expect(h.rpc.renameWorkspace).toHaveBeenCalledWith({ workspaceID: W2, name: 'revised name' });
        h.store.getState().setActiveWorkspace('removed-workspace');
        expect(h.actions.beginRenameActiveWorkspace()).toBe(false);
    });

    it('uniquifies group names from the current mirror and reveals the group named by the reply', async () => {
        const h = setup();
        h.daemon.dispatch({ type: 'rename-group', id: G1, name: 'New Group' });
        h.sync();
        const reply = deferred<CommandReply>();
        h.rpc.createGroupForWorkspaces.mockReturnValueOnce(reply.promise);
        expect(h.actions.newGroupWithRename()).toBe(true);
        expect(h.rpc.createGroupForWorkspaces).toHaveBeenCalledWith({ name: 'New Group 2', workspaceIDs: [] });
        expect(h.lifecycle.result.current.sidebarRenameRequest).toBeNull();
        expect(h.setVisible).not.toHaveBeenCalled();
        await act(async () => reply.resolve({ ok: true, group_id: G2 }));
        expect(h.lifecycle.result.current.scrollToGroupID).toBe(G2);
        expect(h.lifecycle.result.current.sidebarRenameRequest).toEqual({ kind: 'group', id: G2 });
        expect(h.setVisible).toHaveBeenCalledWith(true);
        h.daemon.dispatch({ type: 'create-group', id: G2, name: 'New Group 2', now: 5 });
        h.sync();
        h.actions.newGroupForWorkspace(W2);
        expect(h.rpc.createGroupForWorkspaces).toHaveBeenLastCalledWith({ name: 'New Group 3', workspaceIDs: [W2] });
        act(() => h.lifecycle.result.current.setSidebarRenameRequest(null));
        h.rpc.createGroupForWorkspaces.mockResolvedValueOnce({ ok: true, group_id: 'named-group' });
        await act(async () => { h.actions.createGroupForWorkspaces('  releases  ', [W1, W2], 'green'); });
        expect(h.rpc.createGroupForWorkspaces).toHaveBeenLastCalledWith({ name: 'releases', workspaceIDs: [W1, W2], color: 'green' });
        expect(h.lifecycle.result.current.scrollToGroupID).toBe('named-group');
        expect(h.lifecycle.result.current.sidebarRenameRequest).toBeNull();
    });

    it('reports rejected group creation without scheduling a reveal or inline rename', async () => {
        const h = setup();
        h.rpc.createGroup.mockResolvedValueOnce({ ok: false, error: 'group already exists' });
        h.rpc.createGroupForWorkspaces.mockRejectedValueOnce(new Error('connection lost'));
        await act(async () => { h.actions.createGroup('squad'); h.actions.newGroupWithRename(); });
        expect(h.notifyFailure).toHaveBeenCalledWith('New group', 'group already exists');
        expect(h.notifyFailure).toHaveBeenCalledWith('New group', 'connection lost');
        expect(h.lifecycle.result.current.scrollToGroupID).toBeNull();
        expect(h.lifecycle.result.current.sidebarRenameRequest).toBeNull();
        expect(h.setVisible).not.toHaveBeenCalled();
    });

    it('targets delayed workspace creation and repository associations at the returned ID', async () => {
        const h = setup();
        const reply = deferred<CommandReply>();
        h.rpc.createWorkspace.mockReturnValueOnce(reply.promise);
        h.rpc.addRepoAssociation.mockResolvedValueOnce({ ok: false, error: 'not a repository' });
        h.rpc.addRepoAssociation.mockRejectedValueOnce(new Error('repository offline'));
        expect(h.actions.createWorkspace('  new task  ', G1, { color: 'green', profile: 'default', repoPaths: ['/repo/one', '/repo/two'] })).toBe(true);
        expect(h.rpc.createWorkspace).toHaveBeenCalledWith({ name: 'new task', group: G1, color: 'green' });
        expect(h.activate).not.toHaveBeenCalled();
        expect(h.rpc.addRepoAssociation).not.toHaveBeenCalled();
        h.store.getState().setActiveWorkspace(W2);
        await act(async () => reply.resolve({ ok: true, workspace_id: W3 }));
        expect(h.activate).toHaveBeenCalledExactlyOnceWith(W3);
        expect(h.rpc.addRepoAssociation.mock.calls).toEqual([
            [{ workspaceID: W3, path: '/repo/one' }], [{ workspaceID: W3, path: '/repo/two' }]
        ]);
        expect(h.notifyFailure).toHaveBeenCalledWith('Add repository', 'not a repository');
        expect(h.notifyFailure).toHaveBeenCalledWith('Add repository', 'repository offline');
    });

    it('opens the first pane in the one chosen repository, and at home for none or several (#38)', async () => {
        const h = setup();
        h.rpc.createWorkspace.mockResolvedValueOnce({ ok: true, workspace_id: W3 });
        await act(async () => { h.actions.createWorkspace('solo', G1, { repoPaths: ['/repo/one'] }); });
        expect(h.rpc.createWorkspace).toHaveBeenLastCalledWith({ name: 'solo', path: '/repo/one', group: G1 });
        // The repo is still associated the same way; `path` only places the first pane.
        expect(h.rpc.addRepoAssociation).toHaveBeenCalledExactlyOnceWith({ workspaceID: W3, path: '/repo/one' });
        h.actions.createWorkspace('none', null, { repoPaths: [] });
        expect(h.rpc.createWorkspace).toHaveBeenLastCalledWith({ name: 'none' });
        h.actions.createWorkspace('pair', null, { repoPaths: ['/repo/one', '/repo/two'] });
        expect(h.rpc.createWorkspace).toHaveBeenLastCalledWith({ name: 'pair' });
    });

    it('keeps workspace create errors visible and worktree failures inline without activation', async () => {
        const h = setup();
        h.rpc.createWorkspace.mockResolvedValueOnce({ ok: false, error: 'profile not found' });
        h.rpc.createWorkspace.mockRejectedValueOnce(new Error('disconnected'));
        await act(async () => { h.actions.createWorkspace('one', null); h.actions.createWorkspace('two', null); });
        expect(h.notifyFailure).toHaveBeenCalledWith('New workspace', 'profile not found');
        expect(h.notifyFailure).toHaveBeenCalledWith('New workspace', 'disconnected');
        expect(h.activate).not.toHaveBeenCalled();
        const worktree = { repoID: 'r1', name: 'task', branch: 'topic/task', updateMain: true };
        h.rpc.createWorkspace.mockResolvedValueOnce({ ok: false, error: 'branch exists' });
        expect(await h.actions.createWorkspaceWithWorktree('task', null, worktree, '/repo')).toBe('branch exists');
        h.rpc.createWorkspace.mockRejectedValueOnce(new Error('worktree permission denied'));
        expect(await h.actions.createWorkspaceWithWorktree('task', null, worktree, '/repo')).toBe('worktree permission denied');
        expect(h.activate).not.toHaveBeenCalled();
        h.rpc.createWorkspace.mockResolvedValueOnce({ ok: true, workspace_id: W3 });
        expect(await h.actions.createWorkspaceWithWorktree('  task  ', G1, worktree, '/repo', { profile: 'work', color: 'purple' })).toBeNull();
        expect(h.rpc.createWorkspace).toHaveBeenLastCalledWith({ name: 'task', group: G1, repo: '/repo', worktree: 'task', branch: 'topic/task', updateMain: true, profile: 'work', color: 'purple' });
        expect(h.activate).toHaveBeenCalledExactlyOnceWith(W3);
    });
});

describe('Workspaces remote group errors', () => {
    it.each(['reply', 'transport'] as const)('reports %s failure from the selected remote without a local create', async failure => {
        const h = setup();
        const runtime = createKelpiRuntime({ store: createKelpiStore(), url: 'ws://lab.invalid', notifications: null, tokenStorage: null });
        const remoteCreate = vi.spyOn(runtime.commands, 'createGroup');
        if (failure === 'reply') remoteCreate.mockResolvedValue({ ok: false, error: 'remote group refused' });
        else remoteCreate.mockRejectedValue(new Error('remote connection lost'));
        try {
            h.store.getState().applySettings({ ...DEFAULT_WS_SETTINGS, remoteDaemons: [{ name: 'lab', url: 'http://lab.invalid' }] });
            act(() => h.lifecycle.result.current.setSidebarCreateRequest({ kind: 'group', groupID: null, seq: 1 }));
            render(<WorkspacesFeatureView {...viewProps(h)} remotes={new Map([['lab', { name: 'lab', url: 'http://lab.invalid', runtime }]])} />);
            fireEvent.change(screen.getByLabelText('New group name'), { target: { value: 'Remote task' } });
            fireEvent.change(screen.getByLabelText('Runs on'), { target: { value: 'lab' } });
            fireEvent.submit(screen.getByTestId('new-group-form'));
            await waitFor(() => expect(h.notifyFailure).toHaveBeenCalledWith('New remote group', failure === 'reply' ? 'remote group refused' : 'remote connection lost'));
            expect(remoteCreate).toHaveBeenCalledExactlyOnceWith({ name: 'Remote task' });
            expect(h.rpc.createGroup).not.toHaveBeenCalled();
            expect(h.rpc.createGroupForWorkspaces).not.toHaveBeenCalled();
            expect(h.activate).not.toHaveBeenCalled();
        } finally {
            cleanup();
            runtime.dispose();
        }
    });
});
