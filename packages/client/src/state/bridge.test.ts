import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TOKEN_STORAGE_KEY, type StorageLike } from '../app/config';
import { KelpiConnection, completeHandshake, createFakeSocketFactory } from '../connection';
import { connectStore, createKelpiRuntime, isTokenRejection } from './bridge';
import { createNotificationManager } from './notifications';
import { createKelpiStore, type KelpiStoreApi } from './store';

const HOME = '/Users/test';
const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const P1 = 'dddddddd-0000-4000-8000-000000000001';
const P2 = 'dddddddd-0000-4000-8000-000000000002';
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

/** A `localStorage` stand-in, so a test never reaches jsdom's real one. */
function memoryStorage(initial: Record<string, string> = {}): StorageLike & { readonly data: Map<string, string> } {
    const data = new Map(Object.entries(initial));
    return {
        data,
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => {
            data.set(key, value);
        },
        removeItem: (key) => {
            data.delete(key);
        }
    };
}

function harness(store: KelpiStoreApi = createKelpiStore(), tokenStorage: StorageLike | null = null) {
    const sockets = createFakeSocketFactory();
    const connection = new KelpiConnection({
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
        tokenStorage,
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

    it('tracks the size-control owner (terminal-surface.md §5.1)', () => {
        const h = harness();
        h.connection.connect();
        completeHandshake(h.sockets.last(), { clientID: 'client-1', state: snapshotState() as never });
        expect(h.store.getState().daemon.sizeControlOwnerID).toBeNull();

        h.sockets.last().emit({ type: 'size-control', ownerClientID: 'client-2' });
        expect(h.store.getState().daemon.sizeControlOwnerID).toBe('client-2');

        // Null (or a junk value) means "no owner right now", never a stale claim.
        h.sockets.last().emit({ type: 'size-control', ownerClientID: null });
        expect(h.store.getState().daemon.sizeControlOwnerID).toBeNull();
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
            dedupeKey: `kelpi-${P1}`
        });

        expect(h.toasts).toEqual([`kelpi-${P1}`]);
    });

    /**
     * P0: a daemon whose database could not be written kept serving happily and lost everything
     * on restart. The daemon now broadcasts it; the user has to be able to SEE it.
     */
    it('surfaces a persistence-degraded broadcast as a standing warning', () => {
        const h = harness();
        h.connection.connect();
        completeHandshake(h.sockets.last(), { state: snapshotState() as never });

        h.sockets.last().emit({
            type: 'persistence-degraded',
            path: '/tmp/kelpid-dev.db',
            phase: 'open',
            error: "EPERM: operation not permitted, chmod '/tmp'",
            errno: 'EPERM',
            failedSaves: 0,
            lastSaveAt: null
        } as never);

        const toasts = h.store.getState().ui.toasts;
        expect(toasts).toHaveLength(1);
        expect(toasts[0]?.id).toBe('persistence-degraded');
        expect(toasts[0]?.title).toContain('not being saved');
        // Both the path and the reason reach the screen — that is what makes it actionable.
        expect(toasts[0]?.body).toContain('/tmp/kelpid-dev.db');
        expect(toasts[0]?.body).toContain('EPERM');

        // A repeat broadcast replaces rather than stacks.
        h.sockets.last().emit({
            type: 'persistence-degraded',
            path: '/tmp/kelpid-dev.db',
            phase: 'save',
            error: 'attempt to write a readonly database',
            errno: null,
            failedSaves: 2,
            lastSaveAt: null
        } as never);
        expect(h.store.getState().ui.toasts).toHaveLength(1);
    });

    it('makes a token rejection terminal, explains it, and forgets the stored token', () => {
        const storage = memoryStorage({ [TOKEN_STORAGE_KEY]: 'stale' });
        const h = harness(createKelpiStore(), storage);
        h.connection.connect();
        h.sockets.last().open();

        // Exactly what the daemon now sends when a hello cannot authenticate.
        h.sockets.last().emit({
            type: 'rejected',
            code: 'unauthorized',
            reason: 'bad-token',
            message: "invalid or missing daemon token - open the client via 'kelpid url'",
            protocolVersion: 1
        });
        h.sockets.last().serverClose(4003, 'bad-token');

        const state = h.store.getState();
        expect(state.ui.connection).toBe('rejected');
        // The daemon's own sentence reaches the UI, repair instructions included.
        expect(state.ui.connectionError).toContain('kelpid url');
        // No retry loop: this is the defect — a browser cannot see an upgrade's 401, so a
        // refusal that keeps redialling is both invisible and endless.
        vi.advanceTimersByTime(60_000);
        expect(h.sockets.sockets).toHaveLength(1);
        // And the remembered credential is gone, so the next visit is not wedged by it.
        expect(storage.data.has(TOKEN_STORAGE_KEY)).toBe(false);
    });

    it('connects again once a good token arrives', () => {
        const storage = memoryStorage({ [TOKEN_STORAGE_KEY]: 'stale' });
        const h = harness(createKelpiStore(), storage);
        h.connection.connect();
        h.sockets.last().open();
        h.sockets.last().emit({
            type: 'rejected',
            code: 'unauthorized',
            reason: 'bad-token',
            message: 'invalid or missing daemon token',
            protocolVersion: 1
        });
        h.sockets.last().serverClose(4003, 'bad-token');

        // What opening a fresh `kelpid url` link does.
        h.connection.connect(undefined, 'fresh');
        expect(h.sockets.sockets).toHaveLength(2);
        expect(h.sockets.last().url).toContain('token=fresh');
        completeHandshake(h.sockets.last(), { state: snapshotState() as never });
        expect(h.store.getState().ui.connection).toBe('connected');
        expect(h.store.getState().ui.connectionError).toBeNull();
    });

    it('keeps retrying a transient server-error rejection and keeps the token', () => {
        const storage = memoryStorage({ [TOKEN_STORAGE_KEY]: 'keep-me' });
        const h = harness(createKelpiStore(), storage);
        h.connection.connect();
        h.sockets.last().open();
        h.sockets.last().emit({
            type: 'rejected',
            code: 'server-error',
            reason: 'hello-timeout',
            message: 'no hello within 10000ms',
            protocolVersion: 1
        });
        h.sockets.last().serverClose(4500, 'hello-timeout');

        vi.advanceTimersByTime(50);
        expect(h.sockets.sockets).toHaveLength(2);
        expect(storage.data.get(TOKEN_STORAGE_KEY)).toBe('keep-me');
        // It never claimed to be terminal on the way there (the retry owns the status, and
        // the close that follows owns the error text).
        expect(h.store.getState().ui.connection).toBe('reconnecting');
    });

    it('classifies rejections the same way for old and new daemons', () => {
        expect(
            isTokenRejection({ type: 'rejected', code: 'unauthorized', reason: 'bad-token', message: '', protocolVersion: 1 })
        ).toBe(true);
        // A daemon that predates `reason` still says `unauthorized`.
        expect(isTokenRejection({ type: 'rejected', code: 'unauthorized', message: '', protocolVersion: 1 })).toBe(true);
        expect(
            isTokenRejection({ type: 'rejected', code: 'protocol-mismatch', reason: 'protocol-mismatch', message: '', protocolVersion: 1 })
        ).toBe(false);
        expect(isTokenRejection({ type: 'rejected', code: 'server-error', message: '', protocolVersion: 1 })).toBe(false);
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

describe('kelpi runtime', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    function runtimeHarness() {
        const sockets = createFakeSocketFactory();
        const store = createKelpiStore();
        const runtime = createKelpiRuntime({
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

    it('re-asserts the active workspace even when nothing changed', () => {
        // run-B L3: clicking the row you are already on was a total no-op — the store
        // short-circuits an unchanged id and the report deduped against its own last payload —
        // so once something else (a CLI `workspace create`) had moved the daemon's answer, no
        // click could pull it back and `kelpi workspace list` named the wrong one forever.
        const h = runtimeHarness();
        h.runtime.activateWorkspace(W1);
        h.runtime.activateWorkspace(W1);

        expect(reports(h.sockets.last(), 'visibility-report')).toEqual([
            { type: 'visibility-report', workspaceID: W1, visiblePaneIDs: [P1], documentVisible: true },
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

    /**
     * §N35 — the report's dedupe is against what this client SENT, and the daemon can move
     * focus without it: a split focuses the pane it made, the CLI focuses another, a second
     * client clicks. The next click back onto the pane this client last reported was swallowed
     * as a duplicate, so the daemon kept a focus nobody was in — invisible here, because the
     * echo above draws the ring where the user clicked, and fatal on a RELOAD, which restores
     * the daemon's answer.
     */
    it('re-reports a pane the DAEMON has since moved focus away from (N35)', () => {
        const h = runtimeHarness();
        h.runtime.focusPane(W1, P1);
        expect(reports(h.sockets.last(), 'focus-report')).toHaveLength(1);

        // The daemon moves focus on its own — a split, the CLI, another client.
        h.sockets.last().emit({
            type: 'delta',
            seq: 1,
            events: [{ kind: 'workspace-upserted', id: W1, workspace: { ...renamed('alpha'), focusedPaneID: P2 } }]
        });
        expect(
            h.store.getState().daemon.state.workspaces.find((workspace) => workspace.id === W1)?.focusedPaneID
        ).toBe(P2);

        // …and the user clicks back onto the pane this client last reported.
        h.runtime.focusPane(W1, P1);
        expect(reports(h.sockets.last(), 'focus-report')).toEqual([
            { type: 'focus-report', workspaceID: W1, paneID: P1 },
            { type: 'focus-report', workspaceID: W1, paneID: P1 }
        ]);
    });

    it('…and still says nothing when the daemon already agrees (N35)', () => {
        const h = runtimeHarness();
        h.runtime.focusPane(W1, P1);
        h.runtime.focusPane(W1, P1);
        expect(reports(h.sockets.last(), 'focus-report')).toHaveLength(1);
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
