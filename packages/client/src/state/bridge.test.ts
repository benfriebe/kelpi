import { createStore as createDaemonStore, emptyDaemonState } from '@nex/daemon/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NexConnection, completeHandshake, createFakeSocketFactory } from '../connection';
import { connectStore, createNexRuntime } from './bridge';
import { createNotificationManager } from './notifications';
import { createNexStore, type NexStoreApi } from './store';

const HOME = '/Users/test';
const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const P1 = 'dddddddd-0000-4000-8000-000000000001';
const NOW = 1_755_500_000_000;

function snapshotState(): unknown {
    const store = createDaemonStore(emptyDaemonState(HOME));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: P1, name: 'alpha', color: 'blue', now: NOW });
    const state = store.getState();
    return JSON.parse(
        JSON.stringify({
            workspaces: state.workspaces.map((workspace) => {
                const { recentlyClosedPanes, ...rest } = workspace;
                return { ...rest, recentlyClosedCount: recentlyClosedPanes.length };
            }),
            groups: state.groups,
            topLevelOrder: state.topLevelOrder,
            lastActiveWorkspaceID: state.lastActiveWorkspaceID,
            repos: state.repos,
            labelPresets: state.labelPresets
        })
    );
}

function harness(store: NexStoreApi = createNexStore()) {
    const sockets = createFakeSocketFactory();
    const connection = new NexConnection({
        url: 'ws://daemon.test/ws',
        token: 't',
        socketFactory: sockets.factory,
        backoff: { initialMs: 10, maxMs: 10, factor: 1, jitter: 0 },
        heartbeatIntervalMs: 0
    });
    const toasts: string[] = [];
    const opened: string[] = [];
    const dispose = connectStore({
        store,
        connection,
        notifications: createNotificationManager({
            api: undefined,
            onToast: (toast) => toasts.push(toast.id),
            onOpen: (target) => opened.push(target.paneID)
        })
    });
    return { store, connection, sockets, toasts, opened, dispose };
}

describe('store bridge', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('mirrors status, identity and snapshot into the store', () => {
        const h = harness();
        h.connection.connect();
        completeHandshake(h.sockets.last(), { clientID: 'client-3', seq: 2, state: snapshotState() as never });

        const state = h.store.getState();
        expect(state.ui.connection).toBe('connected');
        expect(state.daemon.clientID).toBe('client-3');
        expect(state.daemon.info).toEqual({ version: '0.1.0', build: 'test', pid: 4242 });
        expect(state.daemon.seq).toBe(2);
        expect(state.daemon.state.workspaces).toHaveLength(1);
        expect(state.ui.activeWorkspaceID).toBe(W1);
    });

    it('applies deltas and redials on a seq gap so a fresh snapshot repairs the mirror', () => {
        const h = harness();
        h.connection.connect();
        completeHandshake(h.sockets.last(), { seq: 0, state: snapshotState() as never });

        h.sockets.last().emit({
            type: 'delta',
            seq: 1,
            events: [{ kind: 'workspace-upserted', id: W1, workspace: renamed('one') }]
        });
        expect(h.store.getState().daemon.state.workspaces[0]?.name).toBe('one');

        // seq 2 is missing.
        h.sockets.last().emit({
            type: 'delta',
            seq: 3,
            events: [{ kind: 'workspace-upserted', id: W1, workspace: renamed('three') }]
        });

        expect(h.store.getState().daemon.desynced).toBe(true);
        expect(h.sockets.sockets).toHaveLength(2);

        completeHandshake(h.sockets.last(), { seq: 7, state: snapshotState() as never });
        expect(h.store.getState().daemon.desynced).toBe(false);
        expect(h.store.getState().daemon.seq).toBe(7);
        expect(h.store.getState().daemon.state.workspaces[0]?.name).toBe('alpha');
    });

    it('renders daemon notifications through the manager', () => {
        const h = harness();
        h.connection.connect();
        completeHandshake(h.sockets.last(), { state: snapshotState() as never });

        h.sockets.last().emit({
            type: 'notification',
            kind: 'agent-waiting',
            paneID: P1,
            workspaceID: W1,
            title: 'alpha',
            body: 'Agent is waiting for input',
            dedupeKey: `nex-${P1}`
        });

        expect(h.toasts).toEqual([`nex-${P1}`]);
    });

    it('records socket errors as the connection error and stops on dispose', () => {
        const h = harness();
        h.connection.connect();
        completeHandshake(h.sockets.last(), { state: snapshotState() as never });

        h.sockets.last().serverClose(1006, 'gone');
        expect(h.store.getState().ui.connection).toBe('reconnecting');
        expect(h.store.getState().ui.connectionError).toContain('1006');

        h.dispose();
        vi.advanceTimersByTime(10);
        completeHandshake(h.sockets.last());
        expect(h.store.getState().ui.connection).toBe('reconnecting');
    });
});

describe('nex runtime', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    function runtimeHarness() {
        const sockets = createFakeSocketFactory();
        const store = createNexStore();
        const runtime = createNexRuntime({
            url: 'ws://daemon.test/ws',
            token: 't',
            socketFactory: sockets.factory,
            heartbeatIntervalMs: 0,
            store,
            notifications: null
        });
        runtime.connect();
        completeHandshake(sockets.last(), { state: snapshotState() as never });
        return {
            runtime,
            store,
            sockets,
            connectionClosed: (): boolean => sockets.last().closes.length > 0
        };
    }

    function reports(socket: ReturnType<typeof createFakeSocketFactory>['sockets'][number], type: string) {
        return socket.messages().filter((message) => message['type'] === type);
    }

    it('activates a workspace locally and reports it to the daemon', () => {
        const h = runtimeHarness();
        h.runtime.activateWorkspace(W1);

        expect(h.store.getState().ui.activeWorkspaceID).toBe(W1);
        expect(reports(h.sockets.last(), 'visibility-report')).toEqual([
            { type: 'visibility-report', workspaceID: W1, visiblePaneIDs: [P1], documentVisible: true }
        ]);
    });

    it('echoes focus locally before the daemon confirms it', () => {
        const h = runtimeHarness();
        h.runtime.focusPane(W1, P1);

        expect(h.store.getState().ui.focusEcho).toEqual({ workspaceID: W1, paneID: P1 });
        expect(reports(h.sockets.last(), 'focus-report')).toEqual([
            { type: 'focus-report', workspaceID: W1, paneID: P1 }
        ]);
    });

    it('re-reports visibility when the document is hidden', () => {
        const h = runtimeHarness();
        h.runtime.activateWorkspace(W1);
        h.runtime.setDocumentVisible(false);

        expect(h.store.getState().ui.documentVisible).toBe(false);
        const visibility = reports(h.sockets.last(), 'visibility-report');
        expect(visibility[visibility.length - 1]).toEqual({
            type: 'visibility-report',
            workspaceID: W1,
            visiblePaneIDs: [P1],
            documentVisible: false
        });
    });

    it('dispose closes the socket and stops mirroring', () => {
        const h = runtimeHarness();
        h.runtime.dispose();

        expect(h.connectionClosed()).toBe(true);
        expect(h.store.getState().ui.connection).toBe('closed');
    });
});

/** A `workspace-upserted` envelope carrying just the field under test. */
function renamed(name: string): Record<string, unknown> {
    return {
        id: W1,
        name,
        slug: name,
        color: 'blue',
        icon: null,
        profileName: null,
        repoAssociations: [],
        recentlyClosedCount: 0,
        webPanes: {},
        searchingPaneID: null,
        searchNeedle: '',
        searchTotal: null,
        searchSelected: null,
        createdAt: 1,
        lastAccessedAt: 1,
        labels: []
    };
}
