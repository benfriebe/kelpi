import {
    applyDomainEvents,
    createStore as createDaemonStore,
    emptyDaemonState,
    type DaemonState,
    type DomainEvent
} from '@kelpi/daemon/store';
import { describe, expect, it } from 'vitest';

import { createKelpiStore, hydrateDomainEvents, hydrateSnapshotState, recentlyClosedCount } from './store';

const HOME = '/Users/test';
const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const W2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const G1 = 'cccccccc-0000-4000-8000-000000000001';
const P1 = 'dddddddd-0000-4000-8000-000000000001';
const P2 = 'dddddddd-0000-4000-8000-000000000002';
const NOW = 1_755_500_000_000;

// ── the daemon's `ws/serialize.ts`, reproduced so the test drives the REAL wire shape ──
// (that module lives behind the daemon's internal path; the two stripped fields are the
// whole contract — `homeDirectory` and each workspace's `recentlyClosedPanes`.)

function serializeWorkspace(workspace: Record<string, unknown>): Record<string, unknown> {
    const { recentlyClosedPanes, ...rest } = workspace as { recentlyClosedPanes: unknown[] };
    return { ...rest, recentlyClosedCount: recentlyClosedPanes.length };
}

function serializeState(state: DaemonState): unknown {
    return JSON.parse(
        JSON.stringify({
            workspaces: state.workspaces.map((workspace) =>
                serializeWorkspace(workspace as unknown as Record<string, unknown>)
            ),
            groups: state.groups,
            topLevelOrder: state.topLevelOrder,
            lastActiveWorkspaceID: state.lastActiveWorkspaceID,
            repos: state.repos,
            labelPresets: state.labelPresets
        })
    );
}

function serializeEvents(events: readonly DomainEvent[]): unknown {
    return JSON.parse(
        JSON.stringify(
            events.map((event) =>
                event.kind === 'workspace-upserted'
                    ? { ...event, workspace: serializeWorkspace(event.workspace as unknown as Record<string, unknown>) }
                    : event
            )
        )
    );
}

/** Comparable projection: drop the fields that legitimately differ across the wire. */
function comparable(state: DaemonState): unknown {
    return JSON.parse(
        JSON.stringify({
            workspaces: state.workspaces.map((workspace) => {
                const record = { ...(workspace as unknown as Record<string, unknown>) };
                delete record['recentlyClosedPanes'];
                delete record['recentlyClosedCount'];
                return record;
            }),
            groups: state.groups,
            topLevelOrder: state.topLevelOrder,
            lastActiveWorkspaceID: state.lastActiveWorkspaceID,
            repos: state.repos,
            labelPresets: state.labelPresets
        })
    );
}

function seededDaemon(): { store: ReturnType<typeof createDaemonStore>; batches: DomainEvent[][] } {
    const store = createDaemonStore(emptyDaemonState(HOME));
    const batches: DomainEvent[][] = [];
    store.subscribe((batch) => batches.push([...batch]));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: P1, name: 'alpha', color: 'blue', now: NOW });
    batches.length = 0;
    return { store, batches };
}

describe('snapshot hydration', () => {
    it('fills in the server-only fields the daemon strips', () => {
        const { store } = seededDaemon();
        const hydrated = hydrateSnapshotState(serializeState(store.getState()));

        expect(hydrated.homeDirectory).toBe('');
        expect(hydrated.workspaces[0]?.recentlyClosedPanes).toEqual([]);
        expect(recentlyClosedCount(hydrated.workspaces[0])).toBe(0);
        expect(comparable(hydrated)).toEqual(comparable(store.getState()));
    });

    it('survives a junk payload rather than blanking the app', () => {
        expect(hydrateSnapshotState(null).workspaces).toEqual([]);
        expect(hydrateSnapshotState({ workspaces: 'nope' }).workspaces).toEqual([]);
    });

    it('drops delta events the client does not know how to replay', () => {
        const events = hydrateDomainEvents([
            { kind: 'focus-changed', workspaceID: W1, focusedPaneID: P1, focusHistory: [P1] },
            { kind: 'from-the-future', payload: 1 },
            'not an object'
        ]);
        expect(events.map((event) => event.kind)).toEqual(['focus-changed']);
    });
});

describe('snapshot → delta convergence', () => {
    it('matches applyDomainEvents replayed over the same batches', () => {
        const { store: daemon, batches } = seededDaemon();
        const before = daemon.getState();

        const client = createKelpiStore();
        client.getState().applySnapshot(0, serializeState(before));

        daemon.dispatch({ type: 'split-pane', workspaceID: W1, paneID: P2, direction: 'vertical', now: NOW + 1 });
        daemon.dispatch({ type: 'focus-pane', workspaceID: W1, paneID: P2 });
        daemon.dispatch({ type: 'set-pane-label', workspaceID: W1, paneID: P2, label: 'worker' });
        daemon.dispatch({ type: 'rename-workspace', id: W1, name: 'renamed' });
        daemon.dispatch({ type: 'create-group', id: G1, name: 'squad', now: NOW + 2 });
        daemon.dispatch({ type: 'move-workspace-to-group', id: W1, groupID: G1 });
        daemon.dispatch({ type: 'toggle-sync-input', workspaceID: W1 });
        daemon.dispatch({
            type: 'pane-agent-event',
            paneID: P2,
            event: { type: 'agentStarted', agent: 'claude' },
            now: NOW + 3,
            workspaceID: W1
        });
        daemon.dispatch({ type: 'create-workspace', id: W2, paneID: 'dddddddd-0000-4000-8000-000000000003', name: 'beta', color: 'red', now: NOW + 4 });
        daemon.dispatch({ type: 'set-active-workspace', id: W2, now: NOW + 5 });

        expect(batches.length).toBeGreaterThan(5);
        batches.forEach((batch, index) => {
            expect(client.getState().applyDelta(index + 1, serializeEvents(batch))).toBe(true);
        });

        const reference = applyDomainEvents(before, batches.flat());
        expect(comparable(client.getState().daemon.state)).toEqual(comparable(reference));
        // …and the reference is itself the daemon's own state (the event stream is complete).
        expect(comparable(reference)).toEqual(comparable(daemon.getState()));
        expect(client.getState().daemon.seq).toBe(batches.length);
        expect(client.getState().daemon.desynced).toBe(false);
    });

    it('flags a seq gap instead of splicing a hole into the mirror', () => {
        const { store: daemon, batches } = seededDaemon();
        const client = createKelpiStore();
        client.getState().applySnapshot(0, serializeState(daemon.getState()));

        daemon.dispatch({ type: 'rename-workspace', id: W1, name: 'one' });
        daemon.dispatch({ type: 'rename-workspace', id: W1, name: 'two' });

        expect(client.getState().applyDelta(1, serializeEvents(batches[0] as DomainEvent[]))).toBe(true);
        // seq 2 never arrives.
        expect(client.getState().applyDelta(3, serializeEvents(batches[1] as DomainEvent[]))).toBe(false);
        expect(client.getState().daemon.desynced).toBe(true);
        expect(client.getState().daemon.state.workspaces[0]?.name).toBe('one');
    });

    it('ignores deltas that arrive before any snapshot', () => {
        const client = createKelpiStore();
        expect(client.getState().applyDelta(1, [{ kind: 'active-workspace-changed', workspaceID: W1 }])).toBe(false);
        expect(client.getState().daemon.hasSnapshot).toBe(false);
    });

    it('replaces the mirror wholesale on a re-snapshot', () => {
        const { store: daemon } = seededDaemon();
        const client = createKelpiStore();
        client.getState().applySnapshot(0, serializeState(daemon.getState()));
        expect(client.getState().daemon.state.workspaces).toHaveLength(1);

        client.getState().applySnapshot(9, serializeState(emptyDaemonState(HOME)));
        expect(client.getState().daemon.state.workspaces).toEqual([]);
        expect(client.getState().daemon.seq).toBe(9);
    });
});

describe('ui slice', () => {
    it('seeds the active workspace from the daemon last-active and keeps it valid', () => {
        const { store: daemon } = seededDaemon();
        daemon.dispatch({ type: 'create-workspace', id: W2, paneID: P2, name: 'beta', color: 'red', now: NOW + 1 });
        daemon.dispatch({ type: 'set-active-workspace', id: W2, now: NOW + 2 });

        const client = createKelpiStore();
        client.getState().applySnapshot(0, serializeState(daemon.getState()));
        expect(client.getState().ui.activeWorkspaceID).toBe(W2);

        // A client that has picked its own workspace keeps it (active workspace is per client).
        client.getState().setActiveWorkspace(W1);
        client.getState().applySnapshot(1, serializeState(daemon.getState()));
        expect(client.getState().ui.activeWorkspaceID).toBe(W1);

        // …unless it disappears, in which case it falls back to a workspace that exists.
        daemon.dispatch({ type: 'delete-workspace', id: W1 });
        client.getState().applySnapshot(2, serializeState(daemon.getState()));
        expect(client.getState().ui.activeWorkspaceID).toBe(W2);
    });

    it('drops the focus echo when the daemon moves focus itself (a ⌘D split)', () => {
        // run-B L7: `selectFocusedPaneID` prefers the echo for the active workspace, and the
        // echo used to outlive everything — so after a split the daemon focused the NEW pane
        // and the client kept drawing the ring (and holding the caret) on the old one.
        const { store: daemon, batches } = seededDaemon();
        const client = createKelpiStore();
        client.getState().applySnapshot(0, serializeState(daemon.getState()));
        client.getState().setFocusEcho(W1, P1);

        daemon.dispatch({ type: 'split-pane', workspaceID: W1, paneID: P2, direction: 'horizontal', now: NOW + 1 });
        batches.forEach((batch, index) => {
            client.getState().applyDelta(index + 1, serializeEvents(batch));
        });

        expect(client.getState().daemon.state.workspaces[0]?.focusedPaneID).toBe(P2);
        expect(client.getState().ui.focusEcho).toBeNull();
    });

    it('keeps the focus echo while the daemon says nothing about focus', () => {
        const { store: daemon, batches } = seededDaemon();
        const client = createKelpiStore();
        client.getState().applySnapshot(0, serializeState(daemon.getState()));
        client.getState().setFocusEcho(W1, P1);

        daemon.dispatch({ type: 'rename-workspace', id: W1, name: 'renamed' });
        batches.forEach((batch, index) => {
            client.getState().applyDelta(index + 1, serializeEvents(batch));
        });

        expect(client.getState().ui.focusEcho).toEqual({ workspaceID: W1, paneID: P1 });
    });

    it('tracks connection status, palette, filter and focus echo', () => {
        const client = createKelpiStore();
        const state = () => client.getState().ui;

        client.getState().setConnectionStatus('reconnecting', 'socket closed (1006)');
        expect(state().connection).toBe('reconnecting');
        expect(state().connectionError).toBe('socket closed (1006)');
        client.getState().setConnectionStatus('connected', null);
        expect(state().connectionError).toBeNull();

        client.getState().setPaletteQuery('w:alpha');
        client.getState().togglePalette();
        expect(state().palette).toEqual({ open: true, query: 'w:alpha' });
        client.getState().togglePalette();
        expect(state().palette).toEqual({ open: false, query: '' });

        client.getState().setSidebarFilter('graft');
        expect(state().sidebarFilter).toBe('graft');

        client.getState().setFocusEcho(W1, P2);
        expect(state().focusEcho).toEqual({ workspaceID: W1, paneID: P2 });
        client.getState().clearFocusEcho();
        expect(state().focusEcho).toBeNull();
    });

    it('replaces toasts by id and drops them per pane', () => {
        const client = createKelpiStore();
        const toast = (id: string, paneID: string, title: string) => ({
            id,
            kind: 'agent-waiting' as const,
            title,
            body: 'Agent is waiting for input',
            paneID,
            workspaceID: W1,
            createdAt: 1
        });

        client.getState().pushToast(toast(`kelpi-${P1}`, P1, 'first'));
        client.getState().pushToast(toast(`kelpi-${P1}`, P1, 'second'));
        expect(client.getState().ui.toasts).toHaveLength(1);
        expect(client.getState().ui.toasts[0]?.title).toBe('second');

        client.getState().pushToast(toast(`kelpi-${P2}`, P2, 'other'));
        client.getState().dismissPaneToasts(P1);
        expect(client.getState().ui.toasts.map((entry) => entry.paneID)).toEqual([P2]);

        client.getState().clearToasts();
        expect(client.getState().ui.toasts).toEqual([]);
    });
});
