import { createStore as createDaemonStore, emptyDaemonState, type DaemonState } from '@kelpi/daemon/store';
import { describe, expect, it } from 'vitest';

import {
    selectActivePanes,
    selectActiveWorkspace,
    selectAgentSummary,
    selectFilteredSidebarEntries,
    selectFocusedPaneID,
    selectSidebarEntries,
    selectSyncedPaneIDs,
    selectVisibleWorkspaceIDs,
    selectWorkspaceAgentCount
} from './selectors';
import { createKelpiStore, type KelpiStoreApi } from './store';

const HOME = '/Users/test';
const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const W2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const G1 = 'cccccccc-0000-4000-8000-000000000001';
const P1 = 'dddddddd-0000-4000-8000-000000000001';
const P2 = 'dddddddd-0000-4000-8000-000000000002';
const P3 = 'dddddddd-0000-4000-8000-000000000003';
const NOW = 1_755_500_000_000;

function daemonState(): DaemonState {
    const store = createDaemonStore(emptyDaemonState(HOME));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: P1, name: 'alpha', color: 'blue', now: NOW });
    store.dispatch({ type: 'split-pane', workspaceID: W1, paneID: P2, direction: 'vertical', now: NOW + 1 });
    store.dispatch({ type: 'create-workspace', id: W2, paneID: P3, name: 'beta-graft', color: 'red', now: NOW + 2 });
    store.dispatch({ type: 'create-group', id: G1, name: 'squad', now: NOW + 3 });
    store.dispatch({ type: 'move-workspace-to-group', id: W2, groupID: G1 });
    store.dispatch({ type: 'focus-pane', workspaceID: W1, paneID: P2 });
    store.dispatch({
        type: 'pane-agent-event',
        paneID: P2,
        event: { type: 'agentStarted', agent: 'claude' },
        now: NOW + 4,
        workspaceID: W1
    });
    store.dispatch({ type: 'set-active-workspace', id: W1, now: NOW + 5 });
    return store.getState();
}

function seeded(): KelpiStoreApi {
    const client = createKelpiStore();
    // The mirror is plain data; the store's own hydration handles the wire shape elsewhere.
    client.getState().applySnapshot(0, JSON.parse(JSON.stringify(daemonState())));
    return client;
}

describe('sidebar selectors', () => {
    it('renders top-level entries in daemon order with group membership', () => {
        const entries = selectSidebarEntries(seeded().getState());
        expect(entries.map((entry) => (entry.kind === 'group' ? `group:${entry.group.name}` : entry.workspace.name))).toEqual([
            'alpha',
            'group:squad'
        ]);
        const group = entries[1];
        expect(group?.kind === 'group' && group.workspaces.map((workspace) => workspace.id)).toEqual([W2]);
    });

    it('memoizes on the mirror so components can select arrays directly', () => {
        const client = seeded();
        const first = selectSidebarEntries(client.getState());
        expect(selectSidebarEntries(client.getState())).toBe(first);

        client.getState().applySnapshot(1, JSON.parse(JSON.stringify(daemonState())));
        expect(selectSidebarEntries(client.getState())).not.toBe(first);
    });

    it('excludes collapsed group members from the ⌘1..9 order', () => {
        const client = seeded();
        expect(selectVisibleWorkspaceIDs(client.getState())).toEqual([W1, W2]);

        const store = createDaemonStore(daemonState());
        store.dispatch({ type: 'set-group-collapsed', id: G1, collapsed: true });
        client.getState().applySnapshot(1, JSON.parse(JSON.stringify(store.getState())));

        expect(selectVisibleWorkspaceIDs(client.getState())).toEqual([W1]);
        // …but the group itself still renders.
        expect(selectSidebarEntries(client.getState())).toHaveLength(2);
    });

    it('filters workspaces (and keeps a group when a member matches)', () => {
        const client = seeded();
        client.getState().setSidebarFilter('graft');
        const entries = selectFilteredSidebarEntries(client.getState());
        expect(entries).toHaveLength(1);
        expect(entries[0]?.kind).toBe('group');
    });
});

describe('active workspace selectors', () => {
    it('reads panes and layout of the client-active workspace', () => {
        const client = seeded();
        expect(selectActiveWorkspace(client.getState())?.id).toBe(W1);
        expect(selectActivePanes(client.getState()).map((pane) => pane.id)).toEqual([P1, P2]);
    });

    it('prefers the local focus echo over the mirrored value for the active workspace', () => {
        const client = seeded();
        expect(selectFocusedPaneID(client.getState())).toBe(P2);

        client.getState().setFocusEcho(W1, P1);
        expect(selectFocusedPaneID(client.getState())).toBe(P1);

        // An echo for another workspace never leaks into this one.
        client.getState().setFocusEcho(W2, P3);
        expect(selectFocusedPaneID(client.getState())).toBe(P2);
    });

    it('reports the sync broadcast group only when the daemon would', () => {
        const client = seeded();
        expect(selectSyncedPaneIDs(client.getState(), W1)).toEqual([]);

        const store = createDaemonStore(daemonState());
        store.dispatch({ type: 'toggle-sync-input', workspaceID: W1 });
        client.getState().applySnapshot(1, JSON.parse(JSON.stringify(store.getState())));
        expect(selectSyncedPaneIDs(client.getState(), W1)).toEqual([P1, P2]);
        // A lone shell never syncs to itself.
        expect(selectSyncedPaneIDs(client.getState(), W2)).toEqual([]);
    });
});

describe('agent summary', () => {
    it('counts running/waiting/inactive panes and the workspaces holding them', () => {
        const client = seeded();
        expect(selectAgentSummary(client.getState())).toEqual({
            running: 1,
            waiting: 0,
            inactive: 0,
            agentCount: 1,
            workspaceCount: 1
        });
        expect(selectWorkspaceAgentCount(client.getState(), W1)).toBe(1);
        expect(selectWorkspaceAgentCount(client.getState(), W2)).toBe(0);
    });
});
