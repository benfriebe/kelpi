import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { JsonObject } from '@kelpi/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChromePane } from '../chrome/types';
import type { CommandReply, KelpiConnection } from '../connection';
import { EMPTY_GRAFT_STATE } from '../state/graft';
import {
    createInspectorActions,
    bindInspectorFeature,
    InspectorFeatureView,
    useInspectorFeature,
    type InspectorActionCommands,
    type InspectorFeatureCommands,
    type InspectorFeatureLifecycle,
    type InspectorFeatureModel,
    type InspectorFeatureWorkspace,
    type InspectorViewActions
} from './inspector';

afterEach(() => { cleanup(); vi.useRealTimers(); });

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

function pane(id: string): ChromePane {
    return { id, type: 'shell', label: null, title: id, workingDirectory: '/repo', gitBranch: 'main',
        status: 'idle', agentSessionID: null, agentKind: null, agentStartedAt: null, backgroundTaskCount: 0 };
}

function workspace(id = 'w1', branchName = 'main'): InspectorFeatureWorkspace {
    return {
        id, name: id, color: 'blue', icon: null, labels: [], panes: [pane(`${id}-p1`), pane(`${id}-p2`)],
        repoAssociations: [{ id: `${id}-a1`, repoID: 'r1', worktreePath: '/repo', branchName, isAutoDetected: false }]
    };
}

function associationReply(workspaceID: string, branch = 'main'): CommandReply {
    return { ok: true, associations: [{ id: `${workspaceID}-a1`, repo_id: 'r1', repo_name: 'app', repo_path: '/repo',
        worktree_path: '/repo', branch, is_worktree: false,
        status: { kind: 'dirty', changed_files: 2, additions: 3, deletions: 4 } }] };
}

function commands() {
    return {
        listRepos: vi.fn<InspectorFeatureCommands['listRepos']>().mockResolvedValue({ ok: true, repos: [
            { id: 'r1', name: 'app', path: '/repo', worktree_base: '/worktrees' }
        ] }),
        workspaceRepoStatus: vi.fn<InspectorFeatureCommands['workspaceRepoStatus']>()
            .mockImplementation(async ({ workspaceID }) => associationReply(workspaceID)),
        graftList: vi.fn<InspectorFeatureCommands['graftList']>().mockResolvedValue({ ok: true, sessions: [], orphans: [] }),
        graftStart: vi.fn<InspectorFeatureCommands['graftStart']>().mockResolvedValue({ ok: true }),
        graftStop: vi.fn<InspectorFeatureCommands['graftStop']>().mockResolvedValue({ ok: true }),
        graftRecoverOrphan: vi.fn<InspectorFeatureCommands['graftRecoverOrphan']>().mockResolvedValue({ ok: true }),
        graftDismissOrphan: vi.fn<InspectorFeatureCommands['graftDismissOrphan']>().mockResolvedValue({ ok: true }),
        openDiff: vi.fn<InspectorActionCommands['openDiff']>().mockResolvedValue({ ok: true }),
        createPane: vi.fn<InspectorActionCommands['createPane']>().mockResolvedValue({ ok: true }),
        splitPane: vi.fn<InspectorActionCommands['splitPane']>().mockResolvedValue({ ok: true }),
        addRepoAssociation: vi.fn<InspectorActionCommands['addRepoAssociation']>().mockResolvedValue({ ok: true }),
        addWorktree: vi.fn<InspectorActionCommands['addWorktree']>().mockResolvedValue({ ok: true }),
        removeRepoAssociation: vi.fn<InspectorActionCommands['removeRepoAssociation']>().mockResolvedValue({ ok: true }),
        scanRepos: vi.fn<InspectorActionCommands['scanRepos']>().mockResolvedValue({ ok: true })
    };
}

function eventSource() {
    const listeners = new Set<(message: JsonObject) => void>();
    const events: Pick<KelpiConnection, 'on'> = {
        on(event, listener) {
            if (event !== 'message') throw new Error(`unexpected feature event: ${event}`);
            const receive = listener as (message: JsonObject) => void;
            listeners.add(receive);
            return () => { listeners.delete(receive); };
        }
    };
    return { events, listeners, emit(message: JsonObject) { for (const listener of [...listeners]) listener(message); } };
}

const CLOSED: InspectorFeatureLifecycle = { visible: false, connection: 'connected' };

describe('bundled Inspector lifecycle', () => {
    it('keeps footer data, registry, and graft events live without mounting the Inspector view', async () => {
        const rpc = commands();
        const source = eventSource();
        const { result, unmount } = renderHook(() => useInspectorFeature({
            commands: rpc, events: source.events, workspace: workspace(), repos: [{ id: 'r1' }], lifecycle: CLOSED, pollMs: 0
        }));
        await waitFor(() => expect(result.current.associations).toHaveLength(1));
        expect(rpc.workspaceRepoStatus).toHaveBeenCalledWith({ workspaceID: 'w1', refresh: false });
        expect(result.current.associations[0]?.status).toEqual({ kind: 'dirty', changedFiles: 2, additions: 3, deletions: 4 });
        expect(result.current.repos[0]?.worktreeBase).toBe('/worktrees');
        expect(screen.queryByTestId('inspector')).toBeNull();

        act(() => source.emit({ type: 'graft-changed', sessions: [{ association_id: 'w1-a1', worktree_path: '/repo',
            parent_repo_root: '/parent', branch: 'main', status: 'watching', last_sync_at: null }] }));
        expect(result.current.graft.state.sessions['w1-a1']?.status).toBe('watching');
        unmount();
        expect(source.listeners.size).toBe(0);
    });

    it('reads only the registry with a closed empty workspace, and refreshes Git and graft on opening/reconnect', async () => {
        const rpc = commands();
        const source = eventSource();
        const empty = { ...workspace(), repoAssociations: [] };
        const { rerender } = renderHook((lifecycle: InspectorFeatureLifecycle) => useInspectorFeature({
            commands: rpc, events: source.events, workspace: empty, repos: [], lifecycle, pollMs: 0
        }), { initialProps: CLOSED });
        await waitFor(() => expect(rpc.graftList).toHaveBeenCalledTimes(1));
        expect(rpc.workspaceRepoStatus).not.toHaveBeenCalled();
        expect(rpc.listRepos).toHaveBeenCalledTimes(1);
        rerender({ ...CLOSED, visible: true });
        await waitFor(() => expect(rpc.workspaceRepoStatus).toHaveBeenCalledWith({ workspaceID: 'w1', refresh: true }));
        expect(rpc.graftList).toHaveBeenCalledTimes(2);
        rerender({ visible: true, connection: 'reconnecting' });
        await waitFor(() => expect(rpc.graftList).toHaveBeenCalledTimes(3));
        expect(rpc.graftList).toHaveBeenLastCalledWith({ refresh: true });
    });

    it('spends an activation refresh only on its destination and follows branch/registry changes', async () => {
        const rpc = commands();
        const source = eventSource();
        const forceRefreshFor = { workspaceID: 'w2', seq: 1 };
        const { rerender } = renderHook((input: { workspace: InspectorFeatureWorkspace; repos: { id: string }[] }) => useInspectorFeature({
            ...input, commands: rpc, events: source.events, lifecycle: { ...CLOSED, forceRefreshFor }, pollMs: 0
        }), { initialProps: { workspace: workspace(), repos: [{ id: 'r1' }] } });
        await waitFor(() => expect(rpc.workspaceRepoStatus).toHaveBeenCalledTimes(1));
        expect(rpc.workspaceRepoStatus).toHaveBeenLastCalledWith({ workspaceID: 'w1', refresh: false });
        rerender({ workspace: workspace('w2'), repos: [{ id: 'r1' }] });
        await waitFor(() => expect(rpc.workspaceRepoStatus).toHaveBeenLastCalledWith({ workspaceID: 'w2', refresh: true }));
        rerender({ workspace: workspace('w2', 'feature'), repos: [{ id: 'r1' }, { id: 'r2' }] });
        await waitFor(() => expect(rpc.workspaceRepoStatus).toHaveBeenLastCalledWith({ workspaceID: 'w2', refresh: false }));
        expect(rpc.workspaceRepoStatus).toHaveBeenCalledTimes(3);
        expect(rpc.listRepos).toHaveBeenCalledTimes(2);
    });

    it('forces fresh provider data while closed and drops a late reply from the previous workspace', async () => {
        const rpc = commands();
        const source = eventSource();
        const old = deferred<CommandReply>();
        rpc.workspaceRepoStatus.mockReturnValueOnce(old.promise);
        const { result, rerender } = renderHook((current: InspectorFeatureWorkspace) => useInspectorFeature({
            commands: rpc, events: source.events, workspace: current, repos: [], lifecycle: CLOSED, pollMs: 0
        }), { initialProps: workspace() });
        rerender(workspace('w2'));
        await waitFor(() => expect(result.current.associations[0]?.id).toBe('w2-a1'));
        await act(async () => old.resolve(associationReply('w1', 'stale')));
        expect(result.current.associations[0]?.id).toBe('w2-a1');
        act(() => source.emit({ type: 'plugin-event', event: { name: 'services.invalidated', data: ['kelpi.git@1'] } }));
        await waitFor(() => expect(rpc.workspaceRepoStatus).toHaveBeenLastCalledWith({ workspaceID: 'w2', refresh: true }));
    });

    it('releases its background poll when the feature host unmounts', async () => {
        vi.useFakeTimers();
        const rpc = commands();
        const source = eventSource();
        const { unmount } = renderHook(() => useInspectorFeature({
            commands: rpc, events: source.events, workspace: workspace(), repos: [], lifecycle: CLOSED, pollMs: 25
        }));
        await act(async () => { await vi.advanceTimersByTimeAsync(25); });
        expect(rpc.workspaceRepoStatus).toHaveBeenCalledTimes(2);
        unmount();
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
        expect(rpc.workspaceRepoStatus).toHaveBeenCalledTimes(2);
        expect(source.listeners.size).toBe(0);
    });
});

describe('Inspector repository actions', () => {
    function setup() {
        const rpc = commands();
        let current: InspectorFeatureWorkspace | null = workspace();
        let focused: string | null = 'w1-p2';
        const refresh = vi.fn();
        const run = vi.fn((_label: string, _command: Promise<CommandReply>) => true);
        const actions = createInspectorActions({ commands: rpc, activeWorkspace: () => current,
            focusedPaneID: () => focused, run, refresh });
        return { rpc, refresh, run, actions,
            select(next: InspectorFeatureWorkspace | null, paneID: string | null) { current = next; focused = paneID; } };
    }

    it('targets the live focused pane, then the current workspace fallback, then creates a first terminal', () => {
        const h = setup();
        h.actions.openRepoDiff('/first');
        expect(h.rpc.openDiff).toHaveBeenLastCalledWith({ repoPath: '/first', paneID: 'w1-p2' });
        h.select(workspace('w2'), null);
        h.actions.openRepoDiff('/second');
        h.actions.openTerminalAt('/second', { vertical: true });
        expect(h.rpc.openDiff).toHaveBeenLastCalledWith({ repoPath: '/second', paneID: 'w2-p1' });
        expect(h.rpc.splitPane).toHaveBeenLastCalledWith({ paneID: 'w2-p1', direction: 'vertical', path: '/second' });
        h.actions.openTerminalAt('/second', { vertical: false });
        expect(h.rpc.splitPane).toHaveBeenLastCalledWith({ paneID: 'w2-p1', direction: 'horizontal', path: '/second' });
        h.select({ ...workspace('w2'), panes: [] }, null);
        h.actions.openTerminalAt('/empty', { vertical: true });
        expect(h.rpc.createPane).toHaveBeenCalledWith({ workspace: 'w2', path: '/empty' });
        h.select(null, null);
        expect(h.actions.openTerminalAt('/none', { vertical: false })).toBe(false);
        expect(h.rpc.createPane).toHaveBeenCalledTimes(1);
    });

    it('refreshes only successful sheet mutations and returns daemon/transport errors inline', async () => {
        const h = setup();
        const add = deferred<CommandReply>();
        h.rpc.addRepoAssociation.mockReturnValueOnce(add.promise);
        const pending = h.actions.addRepoAssociation('/repo');
        expect(h.refresh).not.toHaveBeenCalled();
        h.select(workspace('w2'), null);
        add.resolve({ ok: true });
        expect(await pending).toBeNull();
        expect(h.rpc.addRepoAssociation).toHaveBeenCalledWith({ workspaceID: 'w1', path: '/repo' });
        expect(h.refresh).toHaveBeenCalledTimes(1);
        h.rpc.addRepoAssociation.mockResolvedValueOnce({ ok: false, error: 'not a checkout' });
        expect(await h.actions.addRepoAssociation('/bad')).toBe('not a checkout');
        h.rpc.addWorktree.mockRejectedValueOnce(new Error('connection lost'));
        const request = { repoID: 'r1', name: 'topic', branch: 'feature/topic', updateMain: true };
        expect(await h.actions.addWorktree(request)).toBe('connection lost');
        expect(h.refresh).toHaveBeenCalledTimes(1);
        expect(await h.actions.addWorktree(request)).toBeNull();
        expect(h.rpc.addWorktree).toHaveBeenLastCalledWith({ workspaceID: 'w2', ...request });
        expect(h.refresh).toHaveBeenCalledTimes(2);
        expect(h.run).not.toHaveBeenCalled();
        h.select(null, null);
        expect(await h.actions.addRepoAssociation('/repo')).toBe('no active workspace');
        expect(await h.actions.addWorktree(request)).toBe('no active workspace');
    });

    it('preserves immediate removal refresh, scan completion refresh, and shared command error handling', async () => {
        const h = setup();
        const remove = deferred<CommandReply>();
        h.rpc.removeRepoAssociation.mockReturnValueOnce(remove.promise);
        h.actions.removeRepoAssociation('a1', true);
        expect(h.rpc.removeRepoAssociation).toHaveBeenCalledWith({ workspaceID: 'w1', associationID: 'a1', deleteWorktree: true });
        expect(h.run).toHaveBeenLastCalledWith('Remove worktree', remove.promise);
        expect(h.refresh).toHaveBeenCalledTimes(1);
        remove.resolve({ ok: true });
        const scan = deferred<CommandReply>();
        h.rpc.scanRepos.mockReturnValueOnce(scan.promise);
        h.actions.scanForRepos('/scan');
        expect(h.refresh).toHaveBeenCalledTimes(1);
        scan.resolve({ ok: true });
        await h.run.mock.calls.at(-1)?.[1];
        expect(h.refresh).toHaveBeenCalledTimes(2);
        h.rpc.scanRepos.mockRejectedValueOnce(new Error('daemon stopped'));
        h.actions.scanForRepos('/scan');
        const failure = h.run.mock.calls.at(-1);
        expect(failure?.[0]).toBe('Scan repositories');
        await expect(failure?.[1]).rejects.toThrow('daemon stopped');
        expect(h.refresh).toHaveBeenCalledTimes(2);
    });
});

describe('Inspector feature view binding', () => {
    it('renders the existing Inspector and binds workspace, pane, repo, and graft gestures', () => {
        const rpc = commands();
        const refresh = vi.fn();
        const actions: InspectorViewActions = {
            ...createInspectorActions({ commands: rpc, activeWorkspace: () => workspace(), focusedPaneID: () => 'w1-p2', run: () => true, refresh }),
            toggleInspector: vi.fn(), renameWorkspace: vi.fn(), setWorkspaceColor: vi.fn(), setWorkspaceProfile: vi.fn(),
            focusPane: vi.fn(), closePane: vi.fn()
        };
        const controller = { toggle: vi.fn().mockResolvedValue(undefined), confirmSwap: vi.fn().mockResolvedValue(undefined),
            cancelSwap: vi.fn(), recoverOrphan: vi.fn().mockResolvedValue(undefined), dismissOrphan: vi.fn().mockResolvedValue(undefined),
            sync: vi.fn().mockResolvedValue(undefined) };
        const model: InspectorFeatureModel = { workspace: workspace(), repos: [], associations: [{ id: 'a1', repoID: 'r1', repoName: 'app',
            repoPath: '/parent', worktreePath: '/repo', branch: 'main', isWorktree: true,
            status: { kind: 'clean', changedFiles: 0, additions: 0, deletions: 0 } }], refreshing: false, refresh,
            graft: { state: EMPTY_GRAFT_STATE, controller } };
        const binding = bindInspectorFeature({ model, actions, focusedPaneID: 'w1-p2',
            profiles: [{ name: 'work' }], labelPresets: [], bucket: 'dark' });
        expect(binding.definition.id).toBe('kelpi.inspector');
        const { rerender } = render(<>{binding.render({ visible: true, trafficLightInset: 0, side: 'left', viewPicker: <span>Pick a view</span> })}</>);
        expect(screen.getByTestId('inspector').className).toContain('border-r');
        expect(screen.getByText('Pick a view')).toBeTruthy();
        fireEvent.click(screen.getByTestId('inspector-close'));
        expect(actions.toggleInspector).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByTestId('inspector-workspace-name'));
        fireEvent.change(screen.getByTestId('inspector-rename-input'), { target: { value: 'Renamed' } });
        fireEvent.keyDown(screen.getByTestId('inspector-rename-input'), { key: 'Enter' });
        expect(actions.renameWorkspace).toHaveBeenCalledWith('w1', 'Renamed');
        fireEvent.click(screen.getByTestId('inspector-color-purple'));
        expect(actions.setWorkspaceColor).toHaveBeenCalledWith('w1', 'purple');
        fireEvent.change(screen.getByTestId('inspector-profile'), { target: { value: 'work' } });
        expect(actions.setWorkspaceProfile).toHaveBeenCalledWith('w1', 'work');
        fireEvent.click(within(screen.getByTestId('inspector-pane-w1-p1')).getByRole('button', { name: 'w1-p1' }));
        expect(actions.focusPane).toHaveBeenCalledWith('w1-p1');
        fireEvent.click(screen.getByTestId('inspector-close-pane-w1-p1'));
        expect(actions.closePane).toHaveBeenCalledWith('w1-p1');
        fireEvent.click(screen.getByTestId('inspector-diff-a1'));
        expect(rpc.openDiff).toHaveBeenCalledWith({ repoPath: '/repo', paneID: 'w1-p2' });
        fireEvent.click(screen.getByTestId('inspector-terminal-a1'), { shiftKey: true });
        expect(rpc.splitPane).toHaveBeenCalledWith({ paneID: 'w1-p2', direction: 'vertical', path: '/repo' });
        fireEvent.click(screen.getByTestId('graft-toggle-a1'));
        expect(controller.toggle).toHaveBeenCalledWith({ id: 'a1', worktreePath: '/repo', branch: 'main' });
        rerender(<InspectorFeatureView model={{ ...model, workspace: null }} actions={actions} focusedPaneID={null}
            profiles={[]} labelPresets={[]} bucket="dark" />);
        expect(screen.queryByTestId('inspector')).toBeNull();
    });
});
