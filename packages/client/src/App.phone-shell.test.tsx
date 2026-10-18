/**
 * The phone shell at the assembly (docs/MOBILE-PLAN.md B1 to B4, B6; the owner's layout toggle
 * and multi-host requests of 2026-09-08).
 *
 * Every phone behaviour here is driven through `formFactorWindow`, the seam `App` takes for a
 * jsdom test; the first block pins that a desktop window renders the tree it always has.
 */

import { DEFAULT_WS_SETTINGS, type JsonObject } from '@kelpi/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import type { StorageLike } from './app/config';
import type { RemoteDaemonEntry } from './app/remote-daemons';
import { modalPresenceCount } from './chrome/modal-presence';
import { completeHandshake, createFakeSocketFactory, type FakeWebSocket } from './connection';
import {
    ORIGIN_HOST_KEY,
    PHONE_HOST_EXPANSION_KEY,
    PHONE_HOSTS_KEY,
    PHONE_PLACE_KEY,
    PHONE_SHEET_HISTORY_STATE,
    PHONE_VIEW_MODE_KEY,
    QrCameraError,
    type QrCamera
} from './phone';
import { createFakePhoneWindow } from './phone/testing';
import { createKelpiRuntime, createKelpiStore, type KelpiRuntime } from './state';
import { registerTerminalPane, type TerminalPaneHandle } from './terminal';
import { createFakePtyApi, createFakeRendererFactory, type FakePtyApi, type FakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const PANE_B = 'DDDDDDDD-0000-4000-8000-000000000002';
const PANE_MD = 'DDDDDDDD-0000-4000-8000-000000000003';
const PANE_WEB = 'DDDDDDDD-0000-4000-8000-000000000004';
const WEB_TAB = 'CCCCCCCC-0000-4000-8000-000000000001';
const REMOTE_WS = 'AAAAAAAA-0000-4000-8000-000000000099';
const REMOTE_PANE = 'DDDDDDDD-0000-4000-8000-000000000099';
const REMOTE_NEW_WS = 'AAAAAAAA-0000-4000-8000-000000000098';
const W2 = 'AAAAAAAA-0000-4000-8000-000000000002';
const PANE_W2 = 'DDDDDDDD-0000-4000-8000-000000000005';
const G1 = 'BBBBBBBB-0000-4000-8000-000000000001';
const R1 = '99999999-0000-4000-8000-000000000001';
const NOW = 1_755_500_000_000;
const PAIRING_URL = 'https://studio.tail.ts.net/?token=kd_secret';

function snapshotState(): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE_A, name: 'dev', color: 'blue', now: NOW });
    // `paneID` is the NEW pane; `sourcePaneID` is the one being split.
    store.dispatch({ type: 'split-pane', workspaceID: W1, paneID: PANE_B, sourcePaneID: PANE_A, direction: 'horizontal', now: NOW });
    // The split focuses the new pane; the fixture starts on A so the tests read left to right.
    store.dispatch({ type: 'focus-pane', workspaceID: W1, paneID: PANE_A });
    return store.getState() as unknown as JsonObject;
}

/** B7's fixture: one workspace holding a terminal, a content pane and a web pane. */
function everyPaneTypeState(): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE_A, name: 'dev', color: 'blue', now: NOW });
    store.dispatch({ type: 'open-markdown-pane', workspaceID: W1, paneID: PANE_MD, filePath: '/Users/test/notes.md', now: NOW });
    store.dispatch({ type: 'open-web-pane', workspaceID: W1, paneID: PANE_WEB, tabID: WEB_TAB, url: 'https://example.test/docs', now: NOW });
    store.dispatch({ type: 'focus-pane', workspaceID: W1, paneID: PANE_A });
    return store.getState() as unknown as JsonObject;
}

/**
 * The New workspace fixture: `dev` (on screen) in the `Client` group, whose default repository is
 * `app` with its worktree switch on, and `docs` at top level.
 */
function groupedState(): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE_A, name: 'dev', color: 'blue', now: NOW });
    store.dispatch({ type: 'create-workspace', id: W2, paneID: PANE_W2, name: 'docs', color: 'green', now: NOW });
    store.dispatch({ type: 'create-group', id: G1, name: 'Client', now: NOW, initialWorkspaceIDs: [W1] });
    store.dispatch({
        type: 'add-repo',
        repo: { id: R1, path: '/Users/test/app', name: 'app', remoteURL: null, lastAccessedAt: 1, isAutoDiscovered: false }
    });
    store.dispatch({ type: 'set-group-repo', id: G1, repoID: R1, createWorktree: true });
    store.dispatch({ type: 'set-active-workspace', id: W1, now: NOW });
    return store.getState() as unknown as JsonObject;
}

const REGISTRY_REPLY: JsonObject = {
    ok: true,
    repos: [{ id: R1, name: 'app', path: '/Users/test/app', worktree_base: '/Users/test/worktrees' }]
};

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { readonly map: Map<string, string> } {
    const map = new Map(Object.entries(initial));
    return {
        map,
        getItem: (key) => map.get(key) ?? null,
        setItem: (key, value) => {
            map.set(key, value);
        },
        removeItem: (key) => {
            map.delete(key);
        }
    };
}

/** A remote host's runtime: its own mirror, a fake PTY, stubbed commands, no socket. */
function fakeRemoteRuntime(target: string): { runtime: KelpiRuntime; calls: string[] } {
    const store = createKelpiStore();
    store.getState().applySnapshot(0, {
        workspaces: [
            {
                id: REMOTE_WS,
                name: 'remote-ws',
                slug: 'remote-ws',
                color: 'green',
                icon: null,
                labels: [],
                profileName: null,
                repoAssociations: [],
                recentlyClosedCount: 0,
                webPanes: {},
                focusedPaneID: REMOTE_PANE,
                zoomedPaneID: null,
                isSyncInputActive: false,
                syncInputExcluded: [],
                parkedPaneIDs: [],
                panes: [
                    {
                        id: REMOTE_PANE,
                        type: 'shell',
                        label: null,
                        title: 'remote shell',
                        workingDirectory: '/home/remote',
                        gitBranch: null,
                        status: 'idle',
                        agentSessionID: null,
                        agentKind: null,
                        agentProfileName: null,
                        agentStartedAt: null,
                        backgroundTaskCount: 0
                    }
                ],
                layout: { kind: 'leaf', paneID: REMOTE_PANE }
            }
        ],
        groups: [],
        topLevelOrder: [{ kind: 'workspace', id: REMOTE_WS }],
        lastActiveWorkspaceID: REMOTE_WS,
        repos: [],
        labelPresets: []
    });
    store.getState().setConnectionStatus('connected');
    const calls: string[] = [];
    const runtime = {
        store,
        connection: { target, status: 'connected', isConnected: true, on: () => () => {} },
        pty: createFakePtyApi(),
        commands: {
            raw: vi.fn(async (input: JsonObject) => {
                if (input['command'] === 'plugin') {
                    if (input['action'] === 'list' || input['action'] === 'contributions') return { ok: true, result: [] };
                    if (input['action'] === 'identity') return { ok: true, result: { daemonID: 'phone-test-remote' } };
                }
                throw new Error(`Unexpected remote command: ${JSON.stringify(input)}`);
            }),
            createPane: vi.fn((input: { workspace: string }) => {
                calls.push(`create:${input.workspace}`);
                return Promise.resolve({ ok: true });
            }),
            closePane: vi.fn((input: { paneID: string }) => {
                calls.push(`close:${input.paneID}`);
                return Promise.resolve({ ok: true });
            }),
            renamePane: vi.fn((input: { paneID: string; name: string }) => {
                calls.push(`rename:${input.paneID}:${input.name}`);
                return Promise.resolve({ ok: true });
            }),
            setGroupCollapsed: vi.fn(() => Promise.resolve({ ok: true })),
            listRepos: vi.fn(() => Promise.resolve({ ok: true, repos: [] })),
            createWorkspace: vi.fn((input: JsonObject) => {
                calls.push(`workspace-create:${JSON.stringify(input)}`);
                return Promise.resolve({ ok: true, workspace_id: REMOTE_NEW_WS });
            }),
            setPaneFontSize: vi.fn((input: { paneID: string; size: number | null }) => {
                calls.push(`font-size:${input.paneID}:${String(input.size)}`);
                return Promise.resolve({ ok: true });
            })
        },
        connect: vi.fn(() => {
            calls.push('connect');
        }),
        dispose: vi.fn(() => {
            calls.push('dispose');
        }),
        activateWorkspace: vi.fn((workspaceID: string, visible?: readonly string[]) => {
            calls.push(`activate:${workspaceID}:${(visible ?? []).join('+')}`);
        }),
        focusPane: vi.fn((workspaceID: string, paneID: string | null) => {
            store.getState().setFocusEcho(workspaceID, paneID);
            calls.push(`focus:${workspaceID}:${String(paneID)}`);
        }),
        reportVisiblePanes: vi.fn(),
        setDocumentVisible: vi.fn()
    };
    return { runtime: runtime as unknown as KelpiRuntime, calls };
}

interface Harness {
    readonly runtime: KelpiRuntime;
    readonly renderers: FakeRendererFactory;
    readonly hostStorage: ReturnType<typeof memoryStorage>;
    readonly remotes: Map<string, { entry: RemoteDaemonEntry; runtime: KelpiRuntime; calls: string[] }>;
    socket(): FakeWebSocket;
    sent(): Record<string, unknown>[];
    commands(): Record<string, unknown>[];
    lastOfType(type: string): Record<string, unknown> | undefined;
    /** Answer the last command of a given name, the way the daemon's async verbs do. */
    answer(command: string, reply: JsonObject): void;
}

/**
 * B7: the phone opens on the LANDING page when nothing is remembered, so a test about the
 * workspace screen has to say where the phone was put down, the same way the audit's
 * `emulatePhone` seeds it. `landing: true` is the first-open case, which the B7 block drives.
 */
function setup(
    options: {
        phone?: boolean;
        snapshot?: boolean;
        storage?: Record<string, string>;
        landing?: boolean;
        everyPaneType?: boolean;
        state?: JsonObject;
        qrCamera?: QrCamera;
    } = {}
): Harness {
    const sockets = createFakeSocketFactory();
    const store = createKelpiStore();
    const runtime = createKelpiRuntime({
        url: 'ws://daemon.test/ws',
        token: 'tok',
        socketFactory: sockets.factory,
        store,
        notifications: null,
        tokenStorage: null,
        heartbeatIntervalMs: 0,
        backoff: { initialMs: 10, maxMs: 10, factor: 1, jitter: 0 }
    });
    const renderers = createFakeRendererFactory();
    const hostStorage = memoryStorage({
        ...(options.landing === true ? {} : { [PHONE_PLACE_KEY]: JSON.stringify({ host: 'origin', workspaceID: W1 }) }),
        ...(options.storage ?? {})
    });
    const remotes = new Map<string, { entry: RemoteDaemonEntry; runtime: KelpiRuntime; calls: string[] }>();
    const factory = (entry: RemoteDaemonEntry): KelpiRuntime => {
        const fake = fakeRemoteRuntime(entry.url);
        remotes.set(entry.url, { entry, ...fake });
        return fake.runtime;
    };

    render(
        <App
            runtime={runtime}
            createRenderer={renderers.factory}
            formFactorWindow={options.phone === false ? undefined : createFakePhoneWindow()}
            phoneHostStorage={hostStorage}
            phoneRuntimeFactory={factory}
            phoneQrCamera={options.qrCamera}
        />
    );

    if (options.snapshot !== false) {
        act(() => {
            completeHandshake(sockets.last(), {
                state: options.state ?? (options.everyPaneType === true ? everyPaneTypeState() : snapshotState())
            });
        });
    }

    const sent = (): Record<string, unknown>[] => sockets.last().messages();
    return {
        runtime,
        renderers,
        hostStorage,
        remotes,
        socket: () => sockets.last(),
        sent,
        commands: () =>
            sent()
                .filter((message) => message['type'] === 'command')
                .map((message) => message['payload'] as Record<string, unknown>),
        lastOfType: (type) => [...sent()].reverse().find((message) => message['type'] === type),
        answer(command, reply) {
            const message = [...sent()]
                .reverse()
                .find((entry) => entry['type'] === 'command' && (entry['payload'] as Record<string, unknown>)['command'] === command);
            if (message === undefined) throw new Error(`no ${command} command was sent`);
            act(() => {
                sockets.last().emit({ type: 'command-reply', id: message['id'] as string, reply });
            });
        }
    };
}

function tap(testID: string): void {
    fireEvent.click(screen.getByTestId(testID));
}

afterEach(() => {
    cleanup();
    window.localStorage.removeItem(PHONE_VIEW_MODE_KEY);
});

describe('the root split', () => {
    it('renders the desktop tree, and no phone shell, for a desktop window', () => {
        setup({ phone: false });
        expect(screen.queryByTestId('phone-shell')).toBeNull();
        expect(screen.getByTestId('top-bar')).toBeTruthy();
        expect(screen.getByTestId('sidebar')).toBeTruthy();
        expect(screen.getByTestId('status-footer')).toBeTruthy();
        expect(screen.getByTestId('pane-grid')).toBeTruthy();
    });

    it('renders the phone shell instead of the title bar, sidebar, grid and footer for a phone', () => {
        setup();
        const shell = screen.getByTestId('phone-shell');
        expect(shell.getAttribute('data-phone-mode')).toBe('pane');
        expect(shell.getAttribute('data-phone-host')).toBe('origin');
        expect(screen.queryByTestId('top-bar')).toBeNull();
        expect(screen.queryByTestId('sidebar')).toBeNull();
        expect(screen.queryByTestId('status-footer')).toBeNull();
        expect(screen.queryByTestId('pane-grid')).toBeNull();
        // The shared overlays and the app root are still the same elements.
        expect(screen.getByTestId('kelpi-app')).toBeTruthy();
    });

    it('covers the content with the connection splash until the first snapshot lands', () => {
        setup({ snapshot: false });
        expect(screen.getByTestId('phone-shell')).toBeTruthy();
        expect(screen.getByTestId('connection-splash')).toBeTruthy();
        expect(screen.getByTestId('phone-title-workspace').textContent).toBe('Kelpi');
    });
});

describe('one pane at a time', () => {
    it('shows the focused pane alone, named in the header, and reports only it as visible', async () => {
        const h = setup();
        expect(screen.getByTestId(`pane-body-${PANE_A}`)).toBeTruthy();
        expect(screen.queryByTestId(`pane-body-${PANE_B}`)).toBeNull();
        expect(screen.getByTestId(`pane-header-${PANE_A}`).getAttribute('data-focused')).toBe('true');
        expect(screen.getByTestId('phone-title-workspace').textContent).toBe('dev');
        expect(screen.getByTestId('phone-pane-count').textContent).toBe('2');
        await waitFor(() => {
            expect(h.lastOfType('visibility-report')).toMatchObject({ workspaceID: W1, visiblePaneIDs: [PANE_A] });
        });
    });

    it('switches panes by FOCUSING from the pane sheet, and never touches zoom', async () => {
        const h = setup();
        tap('phone-open-panes');
        const sheet = screen.getByTestId('phone-pane-sheet');
        expect(within(sheet).getByTestId(`phone-pane-row-${PANE_A}`).getAttribute('data-shown')).toBe('true');
        expect(within(sheet).getByTestId(`phone-pane-row-${PANE_B}`).getAttribute('data-shown')).toBe('false');
        expect(modalPresenceCount()).toBeGreaterThan(0);

        tap(`phone-pane-show-${PANE_B}`);
        expect(screen.queryByTestId('phone-pane-sheet')).toBeNull();
        expect(screen.getByTestId(`pane-body-${PANE_B}`)).toBeTruthy();
        expect(screen.queryByTestId(`pane-body-${PANE_A}`)).toBeNull();
        await waitFor(() => {
            expect(h.lastOfType('focus-report')).toMatchObject({ workspaceID: W1, paneID: PANE_B });
            expect(h.lastOfType('visibility-report')).toMatchObject({ workspaceID: W1, visiblePaneIDs: [PANE_B] });
        });
        expect(h.commands().some((command) => String(command['command']).includes('zoom'))).toBe(false);
        expect(h.runtime.store.getState().daemon.state.workspaces[0]?.zoomedPaneID ?? null).toBeNull();
    });

    it('follows a focus the daemon moves (a split, the CLI, a notification)', () => {
        const h = setup();
        act(() => {
            const seq = h.runtime.store.getState().daemon.seq + 1;
            expect(h.runtime.store.getState().applyDelta(seq, [{ kind: 'focus-changed', workspaceID: W1, focusedPaneID: PANE_B, focusHistory: [PANE_B, PANE_A] }])).toBe(true);
        });
        expect(screen.getByTestId(`pane-body-${PANE_B}`)).toBeTruthy();
        expect(screen.queryByTestId(`pane-body-${PANE_A}`)).toBeNull();
    });
});

describe('the full layout', () => {
    it('toggles to the workspace grid, remembers the choice, and reports the layout’s visible set', async () => {
        const h = setup();
        tap('phone-view-toggle');
        expect(screen.getByTestId('phone-shell').getAttribute('data-phone-mode')).toBe('layout');
        expect(screen.getByTestId('pane-grid')).toBeTruthy();
        expect(screen.getByTestId(`pane-body-${PANE_A}`)).toBeTruthy();
        expect(screen.getByTestId(`pane-body-${PANE_B}`)).toBeTruthy();
        expect(window.localStorage.getItem(PHONE_VIEW_MODE_KEY)).toBe('layout');
        await waitFor(() => {
            expect(h.lastOfType('visibility-report')).toMatchObject({ workspaceID: W1, visiblePaneIDs: [PANE_A, PANE_B] });
        });
        tap('phone-view-toggle');
        expect(screen.getByTestId('phone-shell').getAttribute('data-phone-mode')).toBe('pane');
        expect(screen.queryByTestId('pane-grid')).toBeNull();
        expect(window.localStorage.getItem(PHONE_VIEW_MODE_KEY)).toBe('pane');
    });

    it('opens in the remembered mode', () => {
        window.localStorage.setItem(PHONE_VIEW_MODE_KEY, 'layout');
        setup();
        expect(screen.getByTestId('phone-shell').getAttribute('data-phone-mode')).toBe('layout');
        expect(screen.getByTestId('pane-grid')).toBeTruthy();
    });

    /*
     * B8 (issue #120) - the toggle MOVES the shown pane's terminal between the two views; it does
     * not build another one.
     *
     * Owner, real Android phone, device round 10: "there is still garbage landing into the console
     * when swapping between single and multi pane view." Measured in the harness on the base
     * commit, with a split workspace: `data-terminal-resizes` read 3 in `pane` mode, 0 with
     * `data-terminal-status="loading"` and no canvas 75 ms later, and 2 in `layout` mode - a count
     * that can only fall by remounting. Each toggle cost a `detach-pane`, an `attach-pane` at the
     * other view's grid, a fresh WASM terminal and a fresh server-side replay, and left the PTY
     * with nothing attached for ~75 ms.
     *
     * These pin the two halves of the fix at the protocol and at the instance:
     * `phone/PhoneShell.tsx` mounts the body ONCE into a DOM node it moves between the views.
     */
    it('moves the shown pane’s terminal between the views instead of rebuilding it', () => {
        const h = setup();
        const alive = (): FakeRendererFactory['instances'] => h.renderers.instances.filter((instance) => !instance.disposed);
        const engine = alive()[0];
        expect(engine).toBeTruthy();
        const from = h.sent().length;
        /** The attach protocol for one pane (`connection/pty.ts`), in order, since the mark. */
        const attaches = (paneID: string): string[] =>
            h
                .sent()
                .slice(from)
                .filter((message) => message['paneID'] === paneID && (message['type'] === 'attach-pane' || message['type'] === 'detach-pane'))
                .map((message) => String(message['type']));

        tap('phone-view-toggle');
        tap('phone-view-toggle');

        // The engine the pane started with is the engine it ends with, and it was never disposed.
        expect(alive()).toEqual([engine]);
        // …and the daemon was never told to let the pane's stream go, so it never re-snapshotted
        // and never replayed. On the base commit this read `detach-pane,attach-pane` twice over.
        expect(attaches(PANE_A)).toEqual([]);
        // The SIBLING is what comes and goes with the layout, which is the point of the toggle.
        expect(attaches(PANE_B)).toEqual(['attach-pane', 'detach-pane']);
    });

    it('keeps the shown pane’s terminal node across the toggle, in the grid’s cell and back', () => {
        setup();
        const node = (): Element | null => document.querySelector(`[data-pane-id="${PANE_A}"][data-terminal-status]`);
        const first = node();
        expect(first).not.toBeNull();
        // `pane` mode draws its own box; the grid draws a cell. Both hand the same node the body.
        expect(first?.closest('[data-testid="pane-grid"]')).toBeNull();

        tap('phone-view-toggle');
        expect(node()).toBe(first);
        expect(first?.closest(`[data-testid="pane-body-${PANE_A}"]`)).not.toBeNull();
        expect(first?.closest('[data-testid="pane-grid"]')).not.toBeNull();

        tap('phone-view-toggle');
        expect(node()).toBe(first);
        expect(first?.closest(`[data-testid="pane-body-${PANE_A}"]`)).not.toBeNull();
        expect(first?.closest('[data-testid="pane-grid"]')).toBeNull();
    });

    it('leaves the slot where it is when focus moves INSIDE the layout: the grid has a cell for every pane', () => {
        const h = setup();
        tap('phone-view-toggle');
        const alive = (): FakeRendererFactory['instances'] => h.renderers.instances.filter((instance) => !instance.disposed);
        const engines = alive();
        expect(engines).toHaveLength(2);
        const from = h.sent().length;

        act(() => {
            const seq = h.runtime.store.getState().daemon.seq + 1;
            expect(
                h.runtime.store
                    .getState()
                    .applyDelta(seq, [{ kind: 'focus-changed', workspaceID: W1, focusedPaneID: PANE_B, focusHistory: [PANE_B, PANE_A] }])
            ).toBe(true);
        });

        // Both panes are on screen in their own cells, so nothing has to move: a slot that chased
        // the focus would rebuild TWO engines to spare the toggle one.
        expect(alive()).toEqual(engines);
        expect(
            h
                .sent()
                .slice(from)
                .filter((message) => message['type'] === 'attach-pane' || message['type'] === 'detach-pane')
        ).toEqual([]);
        expect(screen.getByTestId(`pane-body-${PANE_A}`)).toBeTruthy();
        expect(screen.getByTestId(`pane-body-${PANE_B}`)).toBeTruthy();
    });

    it('unmounts the body when the shell leaves the origin’s workspace, and mounts one again on the way back', () => {
        const h = setup();
        const engine = h.renderers.last();
        // The landing page shows no pane at all (`phone/view.ts`), so there is nothing for the
        // slot to hold: the body unmounts exactly as it did before B8.
        tap('phone-open-landing');
        expect(screen.queryByTestId(`pane-body-${PANE_A}`)).toBeNull();
        expect(engine.disposed).toBe(true);

        // Back in through the landing page's own row. B9 made that page the whole host tree with
        // every section open, so the origin's workspace is ONE tap: there is no per-host drill-in
        // to go through first, and the row is read out of the origin's section rather than off the
        // page, so a second host's rows could never answer for it.
        fireEvent.click(
            within(screen.getByTestId(`phone-landing-host-${ORIGIN_HOST_KEY}`)).getByTestId('workspace-row')
        );
        expect(screen.getByTestId(`pane-body-${PANE_A}`)).toBeTruthy();
        expect(h.renderers.last()).not.toBe(engine);
        expect(h.renderers.last().disposed).toBe(false);
    });
});

describe('the workspace drawer', () => {
    it('opens by button with the origin’s rows, closes on the scrim, Escape and a row', () => {
        setup();
        tap('phone-open-workspaces');
        const drawer = screen.getByTestId('phone-workspace-drawer');
        expect(modalPresenceCount()).toBeGreaterThan(0);
        const origin = within(drawer).getByTestId('phone-host-origin');
        expect(origin.getAttribute('data-host-kind')).toBe('origin');
        const row = within(origin).getByTestId('workspace-row');
        expect(row.getAttribute('data-active')).toBe('true');
        expect(within(drawer).queryByTestId('phone-host-remove-origin')).toBeNull();

        fireEvent.click(screen.getByTestId('phone-workspace-drawer-scrim'));
        expect(screen.queryByTestId('phone-workspace-drawer')).toBeNull();
        expect(modalPresenceCount()).toBe(0);

        tap('phone-open-workspaces');
        fireEvent.keyDown(screen.getByTestId('phone-workspace-drawer-panel'), { key: 'Escape' });
        expect(screen.queryByTestId('phone-workspace-drawer')).toBeNull();

        tap('phone-open-workspaces');
        fireEvent.click(within(screen.getByTestId('phone-host-origin')).getByTestId('workspace-row'));
        expect(screen.queryByTestId('phone-workspace-drawer')).toBeNull();
    });

    it('does NOT open on an edge swipe (the edge is the phone\'s back gesture), and the back gesture closes an open sheet', () => {
        setup();
        const content = screen.getByTestId('phone-content');
        fireEvent.touchStart(content, { touches: [{ clientX: 8, clientY: 300 }] });
        fireEvent.touchMove(content, { touches: [{ clientX: 120, clientY: 305 }] });
        fireEvent.touchEnd(content, { touches: [] });
        expect(screen.queryByTestId('phone-workspace-drawer')).toBeNull();

        const depth = window.history.length;
        tap('phone-open-workspaces');
        expect(screen.getByTestId('phone-workspace-drawer')).toBeTruthy();
        expect(window.history.length).toBe(depth + 1);
        expect(window.history.state).toEqual({ [PHONE_SHEET_HISTORY_STATE]: true });
        // The system's back: the browser pops the entry and fires popstate.
        act(() => {
            window.dispatchEvent(new PopStateEvent('popstate'));
        });
        expect(screen.queryByTestId('phone-workspace-drawer')).toBeNull();
    });

    it('offers New workspace from its foot, as a sheet on the host on screen', () => {
        setup();
        tap('phone-open-workspaces');
        tap('phone-new-workspace');
        expect(screen.queryByTestId('phone-workspace-drawer')).toBeNull();
        expect(screen.getByTestId('phone-new-workspace-sheet')).toBeTruthy();
        // One host: where it goes needs no saying.
        expect(screen.queryByTestId('phone-new-workspace-host')).toBeNull();
    });
});

describe('New workspace', () => {
    function openSheet(): void {
        tap('phone-open-workspaces');
        tap('phone-new-workspace');
    }

    function created(h: Harness): Record<string, unknown> | undefined {
        return h.commands().find((command) => command['command'] === 'workspace-create');
    }

    function submit(): void {
        fireEvent.submit(screen.getByTestId('phone-new-workspace-form'));
    }

    /** The registry reply resolves a promise, so the sheet re-renders a tick after it lands. */
    async function answerRegistry(h: Harness): Promise<HTMLSelectElement> {
        h.answer('repo-registry', REGISTRY_REPLY);
        return waitFor(() => screen.getByTestId('phone-new-workspace-repo') as HTMLSelectElement);
    }

    it('creates by name on the origin, switches to it and closes', async () => {
        const h = setup();
        openSheet();
        const create = screen.getByTestId('phone-new-workspace-create') as HTMLButtonElement;
        expect(create.disabled).toBe(true);
        fireEvent.change(screen.getByTestId('phone-new-workspace-name'), { target: { value: 'api' } });
        expect(create.disabled).toBe(false);
        submit();
        expect(created(h)).toMatchObject({ name: 'api', group_defaults: false, focus: true });
        expect(created(h)).not.toHaveProperty('group');
        expect(created(h)).not.toHaveProperty('parent');
        expect(screen.getByTestId('phone-new-workspace-create').textContent).toBe('Creating…');
        h.answer('workspace-create', { ok: true, workspace_id: W1 });
        await waitFor(() => {
            expect(screen.queryByTestId('phone-new-workspace-sheet')).toBeNull();
        });
    });

    it('keeps the sheet open with the host’s refusal', async () => {
        const h = setup();
        openSheet();
        fireEvent.change(screen.getByTestId('phone-new-workspace-name'), { target: { value: 'api' } });
        submit();
        h.answer('workspace-create', { ok: false, error: 'a workspace named api already exists' });
        expect((await screen.findByTestId('phone-new-workspace-error')).textContent).toBe('a workspace named api already exists');
        expect((screen.getByTestId('phone-new-workspace-create') as HTMLButtonElement).disabled).toBe(false);
        // The refusal answered the draft that was sent; editing the draft clears it.
        fireEvent.change(screen.getByTestId('phone-new-workspace-name'), { target: { value: 'api2' } });
        expect(screen.queryByTestId('phone-new-workspace-error')).toBeNull();
    });

    it('opens in the on-screen workspace’s group, with the group’s repository and worktree switch, and the names following', async () => {
        const h = setup({ state: groupedState() });
        openSheet();
        const placement = screen.getByTestId('phone-new-workspace-placement') as HTMLSelectElement;
        expect(placement.value).toBe(`group:${G1}`);
        // Every group, and every workspace that can take a child.
        expect([...placement.options].map((option) => option.textContent)).toEqual(['No group', 'Client', 'docs', 'dev (Client)']);
        // The registry arrives after the sheet opened; the group's defaults land with it.
        expect((await answerRegistry(h)).value).toBe(R1);
        expect((screen.getByTestId('phone-new-workspace-worktree') as HTMLInputElement).checked).toBe(true);
        expect((screen.getByTestId('phone-new-workspace-update-main') as HTMLInputElement).checked).toBe(true);

        fireEvent.change(screen.getByTestId('phone-new-workspace-name'), { target: { value: 'Fix Login' } });
        expect((screen.getByTestId('phone-new-workspace-worktree-name') as HTMLInputElement).value).toBe('fix-login');
        expect((screen.getByTestId('phone-new-workspace-branch') as HTMLInputElement).value).toBe('fix-login');
        fireEvent.change(screen.getByTestId('phone-new-workspace-branch'), { target: { value: 'ben/fix-login' } });
        expect(screen.getByTestId('phone-new-workspace-preview').textContent).toContain('/Users/test/worktrees/fix-login');
        submit();
        expect(created(h)).toMatchObject({
            name: 'Fix Login',
            group: G1,
            repo: '/Users/test/app',
            worktree: 'fix-login',
            branch: 'ben/fix-login',
            update_main: true,
            group_defaults: false
        });
    });

    it('nests under a workspace with no group of its own, and takes the parent group’s defaults', async () => {
        const h = setup({ state: groupedState() });
        openSheet();
        await answerRegistry(h);
        fireEvent.change(screen.getByTestId('phone-new-workspace-placement'), { target: { value: `parent:${W2}` } });
        // `docs` is at top level, so nothing is prefilled.
        expect((screen.getByTestId('phone-new-workspace-repo') as HTMLSelectElement).value).toBe('');
        expect(screen.queryByTestId('phone-new-workspace-worktree')).toBeNull();
        fireEvent.change(screen.getByTestId('phone-new-workspace-placement'), { target: { value: `parent:${W1}` } });
        expect((screen.getByTestId('phone-new-workspace-repo') as HTMLSelectElement).value).toBe(R1);
        fireEvent.change(screen.getByTestId('phone-new-workspace-name'), { target: { value: 'child' } });
        submit();
        expect(created(h)).toMatchObject({ name: 'child', parent: W1, worktree: 'child' });
        expect(created(h)).not.toHaveProperty('group');
    });

    it('starts in a chosen repository without a worktree, and associates it once the workspace exists', async () => {
        const h = setup({ state: groupedState() });
        openSheet();
        await answerRegistry(h);
        fireEvent.change(screen.getByTestId('phone-new-workspace-placement'), { target: { value: 'top' } });
        fireEvent.change(screen.getByTestId('phone-new-workspace-repo'), { target: { value: R1 } });
        expect((screen.getByTestId('phone-new-workspace-worktree') as HTMLInputElement).checked).toBe(false);
        expect(screen.queryByTestId('phone-new-workspace-worktree-fields')).toBeNull();
        fireEvent.change(screen.getByTestId('phone-new-workspace-name'), { target: { value: 'notes' } });
        submit();
        expect(created(h)).toMatchObject({ name: 'notes', path: '/Users/test/app' });
        expect(created(h)).not.toHaveProperty('worktree');
        h.answer('workspace-create', { ok: true, workspace_id: W2 });
        await waitFor(() => {
            expect(h.commands().find((command) => command['command'] === 'add-repo-association')).toMatchObject({
                workspace_id: W2,
                path: '/Users/test/app'
            });
        });
    });

    it('creates on the remote host on screen, without moving that host’s own window, and shows it', async () => {
        const h = setup({
            storage: {
                [PHONE_HOSTS_KEY]: JSON.stringify([{ id: 'h1', name: 'studio', url: PAIRING_URL }]),
                [PHONE_PLACE_KEY]: JSON.stringify({ host: 'phone:h1', workspaceID: REMOTE_WS })
            }
        });
        openSheet();
        expect(screen.getByTestId('phone-new-workspace-host').textContent).toBe('On studio');
        const placement = screen.getByTestId('phone-new-workspace-placement') as HTMLSelectElement;
        expect([...placement.options].map((option) => option.textContent)).toEqual(['No group', 'remote-ws']);
        fireEvent.change(screen.getByTestId('phone-new-workspace-name'), { target: { value: 'remote-api' } });
        submit();
        await waitFor(() => {
            expect(screen.queryByTestId('phone-new-workspace-sheet')).toBeNull();
        });
        const calls = h.remotes.get(PAIRING_URL)?.calls ?? [];
        const create = calls.find((call) => call.startsWith('workspace-create:'));
        expect(JSON.parse(create?.slice('workspace-create:'.length) ?? '{}')).toEqual({ name: 'remote-api', groupDefaults: false, focus: false });
        expect(created(h)).toBeUndefined();
        expect(JSON.parse(h.hostStorage.map.get(PHONE_PLACE_KEY) ?? '{}')).toMatchObject({ host: 'phone:h1', workspaceID: REMOTE_NEW_WS });
    });

    /*
     * shell-ui.md §10.1's Agent row is the desktop sheet's: the phone's sheet has none, and the
     * `new-workspace-agent` default is NOT applied on its behalf (owner decision, phase 1).
     */
    it('starts no agent, whatever new-workspace-agent says', () => {
        const h = setup();
        act(() => {
            h.socket().emit({
                type: 'settings-changed',
                settings: {
                    ...DEFAULT_WS_SETTINGS,
                    general: { ...DEFAULT_WS_SETTINGS.general, newWorkspaceAgent: 'claude', newWorkspaceSendPrompt: true }
                }
            } as never);
        });
        expect(h.runtime.store.getState().settings.agentStart).toBe(true);
        openSheet();
        expect(screen.queryByTestId('new-workspace-agent')).toBeNull();
        fireEvent.change(screen.getByTestId('phone-new-workspace-name'), { target: { value: 'api' } });
        submit();
        const create = created(h);
        expect(create?.['name']).toBe('api');
        expect(Object.keys(create ?? {}).filter((key) => /agent|prompt/.test(key))).toEqual([]);
    });
});

describe('the overflow menu', () => {
    it('lists the phone’s verbs and routes each to the same daemon command', () => {
        const h = setup();
        tap('phone-more');
        const menu = screen.getByTestId('phone-menu');
        const labels = within(menu)
            .getAllByRole('button')
            .map((button) => button.getAttribute('data-testid'))
            .filter((id) => id !== null && id.startsWith('phone-menu-') && id !== 'phone-menu-header-close');
        expect(labels).toEqual([
            'phone-menu-new-pane',
            'phone-menu-rename-pane',
            'phone-menu-sync-input',
            'phone-menu-palette',
            'phone-menu-settings',
            'phone-menu-close-pane'
        ]);
        tap('phone-menu-new-pane');
        expect(screen.queryByTestId('phone-menu')).toBeNull();
        expect(h.commands().some((command) => command['command'] === 'pane-create')).toBe(true);

        tap('phone-more');
        tap('phone-menu-close-pane');
        expect(h.commands().some((command) => command['command'] === 'pane-close' && command['pane_id'] === PANE_A)).toBe(true);
    });

    it('offers Take size control only while another client owns the PTY (#166)', () => {
        /*
         * The phone's escape hatch from a mirror. A phone claims PTY sizing on its first
         * `attach-pane`, so it is normally the owner and this row is absent; once a desktop window
         * takes sizing back the phone renders that window's grid (the owner's screen, clipped at the
         * phone's edge - `terminal/TerminalPane.tsx`), and the desktop's way back is a top-bar chip
         * this shell replaces. Same rule as the chip: shown only to a client that knows somebody
         * else owns it.
         */
        const h = setup();
        tap('phone-more');
        expect(screen.queryByTestId('phone-menu-take-size-control')).toBeNull();
        tap('phone-menu-header-close');

        act(() => {
            h.socket().emit({ type: 'size-control', ownerClientID: 'another-window' });
        });
        tap('phone-more');
        tap('phone-menu-take-size-control');
        expect(h.lastOfType('take-size-control')).toEqual({ type: 'take-size-control' });

        // …and it goes away again the moment the daemon says this client owns sizing.
        act(() => {
            h.socket().emit({ type: 'size-control', ownerClientID: 'client-1' });
        });
        tap('phone-more');
        expect(screen.queryByTestId('phone-menu-take-size-control')).toBeNull();
    });

    it('counts the hidden cells on the Take size control row (#178)', () => {
        /*
         * The desktop puts this number in the chip's `title`, which a touch device can never show,
         * and the phone is the narrowest box an owner's grid is mirrored into - so the row that
         * undoes the clip carries the count itself.
         *
         * The clip is published by the panes on their registry handles (`terminal/pane-registry.ts`),
         * so a handle is registered here rather than a whole clipped phone pane being staged: what
         * this case is about is the shell reading that report and saying it, and the arithmetic
         * behind the report is pinned in `terminal/TerminalPane.mirror.test.tsx`.
         */
        const h = setup();
        act(() => {
            h.socket().emit({ type: 'size-control', ownerClientID: 'another-window' });
        });
        tap('phone-more');
        expect(screen.getByTestId('phone-menu-take-size-control').textContent).not.toContain('hidden');
        tap('phone-menu-header-close');

        const clipped: TerminalPaneHandle = {
            selection: () => '',
            write: () => undefined,
            root: () => null,
            dispatchKey: () => false,
            pasteText: () => false,
            showKeyboard: () => undefined,
            hideKeyboard: () => undefined,
            cellHeight: () => 0,
            focusedOnScreen: () => false,
            mirrorClip: () => ({ cols: 36, rows: 2 })
        };
        let release = (): void => undefined;
        act(() => {
            release = registerTerminalPane('clipped-pane', clipped);
        });
        try {
            tap('phone-more');
            expect(screen.getByTestId('phone-menu-take-size-control').textContent).toContain(
                '36 columns and 2 rows hidden'
            );
        } finally {
            act(() => {
                release();
            });
        }
    });

    it('renames through a prompt that shows the current name', () => {
        const h = setup();
        tap('phone-more');
        tap('phone-menu-rename-pane');
        const field = screen.getByTestId('phone-prompt-field') as HTMLInputElement;
        fireEvent.change(field, { target: { value: 'build' } });
        fireEvent.submit(screen.getByTestId('phone-prompt-submit').closest('form') as HTMLFormElement);
        expect(screen.queryByTestId('phone-prompt')).toBeNull();
        expect(h.commands().some((command) => command['command'] === 'pane-name' && command['name'] === 'build')).toBe(true);
    });

    it('opens Settings as the phone sheet and the palette as the phone sheet', () => {
        setup();
        tap('phone-more');
        tap('phone-menu-settings');
        expect(screen.getByTestId('settings-window').getAttribute('data-phone-sheet')).toBe('true');
        tap('settings-close');
        tap('phone-more');
        tap('phone-menu-palette');
        expect(screen.getByTestId('command-palette')).toBeTruthy();
    });
});

describe('hosts', () => {
    function addStudio(h: Harness): void {
        tap('phone-open-workspaces');
        tap('phone-add-host');
        expect(screen.queryByTestId('phone-workspace-drawer')).toBeNull();
        fireEvent.change(screen.getByTestId('phone-host-url'), { target: { value: PAIRING_URL } });
        fireEvent.submit(screen.getByTestId('phone-host-form'));
        expect(h.remotes.has(PAIRING_URL)).toBe(true);
    }

    it('refuses a line that is not a URL, in place', () => {
        setup();
        tap('phone-open-workspaces');
        tap('phone-add-host');
        fireEvent.change(screen.getByTestId('phone-host-url'), { target: { value: 'studio' } });
        fireEvent.submit(screen.getByTestId('phone-host-form'));
        expect(screen.getByTestId('phone-host-error').textContent).toBe('that is not a URL');
        expect(screen.getByTestId('phone-host-sheet')).toBeTruthy();
    });

    it('adds a host from a pasted pairing URL, dials it, names it after the machine, and remembers it', () => {
        const h = setup();
        addStudio(h);
        // Back on the drawer with the new section.
        const section = screen.getByTestId(/^phone-host-phone:/);
        expect(section.getAttribute('data-host-kind')).toBe('phone');
        expect(within(section).getByText('studio')).toBeTruthy();
        expect(within(section).getByTestId(/^phone-host-status-/).getAttribute('data-status')).toBe('connected');
        const remote = h.remotes.get(PAIRING_URL);
        expect(remote?.calls).toContain('connect');
        const stored = JSON.parse(h.hostStorage.map.get(PHONE_HOSTS_KEY) ?? '[]') as { name: string; url: string }[];
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({ name: 'studio', url: PAIRING_URL });
    });

    it('shows a remote workspace’s focused pane over that host’s own PTY, and reports it there', async () => {
        const h = setup();
        addStudio(h);
        const section = screen.getByTestId(/^phone-host-phone:/);
        // B9: the drawer is the whole tree, so a host you are not in arrives collapsed to its
        // header; its rows are one tap away and the workspace tap is the move.
        expect(section.getAttribute('data-expanded')).toBe('false');
        fireEvent.click(within(section).getByTestId(/^phone-host-toggle-/));
        fireEvent.click(within(section).getByTestId('workspace-row'));
        expect(screen.queryByTestId('phone-workspace-drawer')).toBeNull();

        const shell = screen.getByTestId('phone-shell');
        expect(shell.getAttribute('data-phone-host')).toMatch(/^phone:/);
        expect(screen.getByTestId('phone-title-workspace').textContent).toBe('studio · remote-ws');
        expect(screen.getByTestId(`pane-body-${REMOTE_PANE}`)).toBeTruthy();
        expect(screen.queryByTestId(`pane-body-${PANE_A}`)).toBeNull();
        const remote = h.remotes.get(PAIRING_URL);
        expect(remote?.calls).toContain(`activate:${REMOTE_WS}:${REMOTE_PANE}`);
        // The origin is told this client shows none of ITS panes.
        await waitFor(() => {
            expect(h.lastOfType('visibility-report')).toMatchObject({ workspaceID: W1, visiblePaneIDs: [] });
        });

        /*
         * #172/#170: one-pane mode renders `TerminalFeaturePane` itself rather than through the
         * grid, so it owes `editingShortcuts` the same way `RemoteWorkspaceView` does. The proof
         * is the byte and where it lands: ⌘⌫ on this pane's host puts `0x15` up the REMOTE host's
         * PTY, not the origin's. Without the prop the pane answers nothing and no byte is sent.
         */
        const remotePty = remote?.runtime.pty as unknown as FakePtyApi;
        const remoteHost = await waitFor(() => {
            const host = document.querySelector(`[data-terminal-pane="${REMOTE_PANE}"] [data-terminal-host]`);
            expect(host).toBeTruthy();
            return host as HTMLElement;
        });
        fireEvent.keyDown(remoteHost, { code: 'Backspace', metaKey: true });
        expect(remotePty.streams.flatMap((stream) => stream.input)).toEqual(['\x15']);
        expect(h.sent().some((frame) => frame['type'] === 'input')).toBe(false);
        /*
         * #267: ⌘= over the remote pane steps THAT host's pane, once, and never the origin's
         * hidden one: the window's text-size step declines for a phone remote host and the chord
         * falls through to the pane, which answers it against its own daemon.
         */
        act(() => {
            const current = remote!.runtime.store.getState().settings.value;
            remote!.runtime.store.getState().applySettings({ ...current, general: { ...current.general, fontSizeScope: 'pane' } });
        });
        const plus = new KeyboardEvent('keydown', { code: 'Equal', key: '=', metaKey: true, bubbles: true, cancelable: true });
        fireEvent(remoteHost, plus);
        expect(remote?.calls.filter((call) => call.startsWith('font-size:'))).toEqual([`font-size:${REMOTE_PANE}:14`]);
        expect(plus.defaultPrevented).toBe(true);
        expect(h.commands().filter((command) => ['pane-font-size', 'set-ghostty-setting'].includes(String(command['command'])))).toEqual([]);

        // The pane sheet and the menu act on the remote host's commands.
        tap('phone-more');
        tap('phone-menu-new-pane');
        expect(remote?.calls).toContain(`create:${REMOTE_WS}`);
        expect(h.commands().some((command) => command['command'] === 'pane-create')).toBe(false);

        // Layout mode draws the remote grid.
        tap('phone-view-toggle');
        expect(screen.getByTestId('pane-grid')).toBeTruthy();
        expect(screen.getByTestId(`pane-body-${REMOTE_PANE}`)).toBeTruthy();
        tap('phone-view-toggle');

        // Back to the origin from the drawer: it is the collapsed one now, so it opens first.
        tap('phone-open-workspaces');
        const originSection = screen.getByTestId('phone-host-origin');
        expect(originSection.getAttribute('data-expanded')).toBe('false');
        fireEvent.click(within(originSection).getByTestId('phone-host-toggle-origin'));
        fireEvent.click(within(originSection).getByTestId('workspace-row'));
        expect(screen.getByTestId('phone-shell').getAttribute('data-phone-host')).toBe('origin');
        expect(screen.getByTestId(`pane-body-${PANE_A}`)).toBeTruthy();
    });

    it('removes a host, disposing its runtime and falling back to the origin if it was on screen', () => {
        const h = setup();
        addStudio(h);
        const section = screen.getByTestId(/^phone-host-phone:/);
        fireEvent.click(within(section).getByTestId(/^phone-host-toggle-/));
        fireEvent.click(within(section).getByTestId('workspace-row'));
        expect(screen.getByTestId('phone-shell').getAttribute('data-phone-host')).toMatch(/^phone:/);

        tap('phone-open-workspaces');
        fireEvent.click(screen.getByTestId(/^phone-host-remove-phone:/));
        expect(screen.queryByTestId(/^phone-host-phone:/)).toBeNull();
        expect(h.remotes.get(PAIRING_URL)?.calls).toContain('dispose');
        expect(h.hostStorage.map.has(PHONE_HOSTS_KEY)).toBe(false);
        fireEvent.click(screen.getByTestId('phone-workspace-drawer-scrim'));
        expect(screen.getByTestId('phone-shell').getAttribute('data-phone-host')).toBe('origin');
        expect(screen.getByTestId(`pane-body-${PANE_A}`)).toBeTruthy();
    });

    it('dials the remembered hosts on load', () => {
        const h = setup({
            storage: { [PHONE_HOSTS_KEY]: JSON.stringify([{ id: 'h1', name: 'studio', url: PAIRING_URL }]) }
        });
        expect(h.remotes.get(PAIRING_URL)?.calls).toContain('connect');
        tap('phone-open-workspaces');
        expect(screen.getByTestId('phone-host-phone:h1')).toBeTruthy();
    });
});

/**
 * B7 - the landing page (owner request 2026-09-08, after driving the B1 shell on a real Android
 * phone). The shell's third top-level state: where the phone starts, what it remembers, and the
 * two ways back to it.
 */
describe('the landing page', () => {
    it('is the first screen when nothing is remembered, with a card per host and nothing streaming', async () => {
        const h = setup({ landing: true });
        const shell = screen.getByTestId('phone-shell');
        expect(shell.getAttribute('data-phone-screen')).toBe('landing');
        // Still a `pane` VIEW mode underneath: the landing page is a screen, not a mode.
        expect(shell.getAttribute('data-phone-mode')).toBe('pane');
        expect(screen.getByTestId('phone-landing')).toBeTruthy();
        expect(screen.queryByTestId(`pane-body-${PANE_A}`)).toBeNull();

        const card = screen.getByTestId('phone-landing-host-origin');
        expect(card.getAttribute('data-host-kind')).toBe('origin');
        expect(within(card).getByTestId('phone-landing-status-origin').getAttribute('data-status')).toBe('connected');
        expect(within(card).getByTestId('phone-landing-summary-origin').textContent).toBe('1 workspace');
        expect(screen.getByTestId('phone-landing-add-host')).toBeTruthy();
        // B9: the card is a section HEADER now, and the landing page opens every section, so the
        // host's workspaces are under it without a drill-in.
        expect(card.getAttribute('data-expanded')).toBe('true');
        expect(within(card).getByTestId('workspace-row').getAttribute('data-workspace-id')).toBe(W1);

        // Not an overlay: it registers no modal presence, so a live web pane is not parked by it.
        expect(modalPresenceCount()).toBe(0);
        // The daemon is told this client shows none of its panes.
        await waitFor(() => {
            expect(h.lastOfType('visibility-report')).toMatchObject({ workspaceID: W1, visiblePaneIDs: [] });
        });
    });

    it('counts the agents on a host card, and says so instead of a zero before the snapshot lands', () => {
        setup({ landing: true, snapshot: false });
        expect(screen.getByTestId('phone-landing-summary-origin').textContent).toBe('connecting…');
    });

    it('opens a workspace straight off the page, and remembers where that was', async () => {
        const h = setup({ landing: true });
        const landing = screen.getByTestId('phone-landing');
        const row = within(landing).getByTestId('workspace-row');
        expect(row.getAttribute('data-workspace-id')).toBe(W1);

        fireEvent.click(row);
        expect(screen.getByTestId('phone-shell').getAttribute('data-phone-screen')).toBe('pane');
        expect(screen.queryByTestId('phone-landing')).toBeNull();
        expect(screen.getByTestId(`pane-body-${PANE_A}`)).toBeTruthy();
        expect(JSON.parse(h.hostStorage.map.get(PHONE_PLACE_KEY) ?? 'null')).toEqual({ host: 'origin', workspaceID: W1 });
        await waitFor(() => {
            expect(h.lastOfType('visibility-report')).toMatchObject({ workspaceID: W1, visiblePaneIDs: [PANE_A] });
        });
    });

    it('goes back from the header button, forgetting the place, and the drawer keeps no way of its own', () => {
        const h = setup();
        expect(screen.getByTestId(`pane-body-${PANE_A}`)).toBeTruthy();

        tap('phone-open-landing');
        expect(screen.getByTestId('phone-shell').getAttribute('data-phone-screen')).toBe('landing');
        expect(h.hostStorage.map.has(PHONE_PLACE_KEY)).toBe(false);
        // Nothing pane-shaped in the header while the host list is up.
        expect(screen.queryByTestId('phone-view-toggle')).toBeNull();
        expect(screen.queryByTestId('phone-open-panes')).toBeNull();
        expect(screen.getByTestId('phone-title-workspace').textContent).toBe('Hosts');

        // Back into the workspace off the page's own row. B9 took the drawer's `All hosts` row
        // away: the drawer IS all hosts, so the header button is the one way back.
        fireEvent.click(within(screen.getByTestId('phone-landing')).getByTestId('workspace-row'));
        tap('phone-open-workspaces');
        expect(screen.queryByTestId('phone-drawer-landing')).toBeNull();
        expect(screen.getByTestId('phone-host-origin')).toBeTruthy();
        fireEvent.click(screen.getByTestId('phone-workspace-drawer-scrim'));
        tap('phone-open-landing');
        expect(screen.getByTestId('phone-shell').getAttribute('data-phone-screen')).toBe('landing');
    });

    it('reopens where the person was, on the origin', () => {
        setup({ storage: { [PHONE_PLACE_KEY]: JSON.stringify({ host: 'origin', workspaceID: W1 }) } });
        expect(screen.queryByTestId('phone-landing')).toBeNull();
        expect(screen.getByTestId(`pane-body-${PANE_A}`)).toBeTruthy();
    });

    it('reopens where the person was, on a remote host, without dropping the selection while it dials', () => {
        const h = setup({
            storage: {
                [PHONE_HOSTS_KEY]: JSON.stringify([{ id: 'h1', name: 'studio', url: PAIRING_URL }]),
                [PHONE_PLACE_KEY]: JSON.stringify({ host: 'phone:h1', workspaceID: REMOTE_WS })
            }
        });
        expect(h.remotes.get(PAIRING_URL)?.calls).toContain('connect');
        expect(screen.getByTestId('phone-shell').getAttribute('data-phone-host')).toBe('phone:h1');
        expect(screen.getByTestId('phone-title-workspace').textContent).toBe('studio · remote-ws');
        expect(screen.getByTestId(`pane-body-${REMOTE_PANE}`)).toBeTruthy();
    });

    it('falls back to the origin when the remembered host is gone from the phone’s list', () => {
        setup({ storage: { [PHONE_PLACE_KEY]: JSON.stringify({ host: 'phone:gone', workspaceID: 'w' }) } });
        expect(screen.getByTestId('phone-shell').getAttribute('data-phone-host')).toBe('origin');
        expect(screen.getByTestId(`pane-body-${PANE_A}`)).toBeTruthy();
    });

    it('adds a host from the landing page and lands back on it', () => {
        const h = setup({ landing: true });
        tap('phone-landing-add-host');
        fireEvent.change(screen.getByTestId('phone-host-url'), { target: { value: PAIRING_URL } });
        fireEvent.submit(screen.getByTestId('phone-host-form'));
        expect(h.remotes.has(PAIRING_URL)).toBe(true);
        expect(screen.queryByTestId('phone-host-sheet')).toBeNull();
        expect(screen.getByTestId('phone-landing')).toBeTruthy();
        expect(screen.getByTestId(/^phone-landing-host-phone:/)).toBeTruthy();
    });

    it('touches none of the phone’s storage on a desktop window', () => {
        const h = setup({ phone: false, landing: true });
        expect(screen.queryByTestId('phone-landing')).toBeNull();
        expect(screen.getByTestId('pane-grid')).toBeTruthy();
        // Not the place, not the host list, and not B9's expansion: a desktop window is not a
        // phone and writes none of a phone's memory.
        expect(h.hostStorage.map.size).toBe(0);
        expect(h.hostStorage.map.has(PHONE_HOST_EXPANSION_KEY)).toBe(false);
    });
});

/** A camera that reads whatever the test holds up to it. */
function fakeQrCamera(options: { refuse?: QrCameraError } = {}): {
    camera: QrCamera;
    show(text: string): void;
    live(): boolean;
    stops(): number;
} {
    let onText: ((text: string) => void) | null = null;
    let stops = 0;
    const camera: QrCamera = {
        start(_video, report) {
            if (options.refuse !== undefined) return Promise.reject(options.refuse);
            onText = report;
            return Promise.resolve(() => {
                stops += 1;
                onText = null;
            });
        }
    };
    return {
        camera,
        show(text) {
            act(() => onText?.(text));
        },
        live: () => onText !== null,
        stops: () => stops
    };
}

describe('scanning a pairing code', () => {
    it('reads the code into Add host from its Scan button, stops the camera, and adds the host', async () => {
        const qr = fakeQrCamera();
        const h = setup({ qrCamera: qr.camera });
        tap('phone-open-workspaces');
        tap('phone-add-host');
        tap('phone-host-scan');
        expect(screen.getByTestId('phone-qr-sheet')).toBeTruthy();
        await waitFor(() => expect(qr.live()).toBe(true));

        qr.show(PAIRING_URL);
        expect(screen.queryByTestId('phone-qr-sheet')).toBeNull();
        expect(qr.stops()).toBe(1);
        expect((screen.getByTestId('phone-host-url') as HTMLInputElement).value).toBe(PAIRING_URL);

        fireEvent.submit(screen.getByTestId('phone-host-form'));
        expect(h.remotes.has(PAIRING_URL)).toBe(true);
        expect(within(screen.getByTestId(/^phone-host-phone:/)).getByText('studio')).toBeTruthy();
    });

    it('opens straight onto the camera from the landing page', async () => {
        const qr = fakeQrCamera();
        const h = setup({ landing: true, qrCamera: qr.camera });
        tap('phone-landing-scan-host-header');
        expect(screen.getByTestId('phone-host-sheet')).toBeTruthy();
        expect(screen.getByTestId('phone-qr-sheet')).toBeTruthy();
        await waitFor(() => expect(qr.live()).toBe(true));

        qr.show(PAIRING_URL);
        fireEvent.submit(screen.getByTestId('phone-host-form'));
        expect(h.remotes.has(PAIRING_URL)).toBe(true);
        expect(screen.queryByTestId('phone-host-sheet')).toBeNull();
        expect(screen.getByTestId(/^phone-landing-host-phone:/)).toBeTruthy();
    });

    it('says so and keeps looking when the code is not a pairing link', async () => {
        const qr = fakeQrCamera();
        setup({ qrCamera: qr.camera });
        tap('phone-open-workspaces');
        tap('phone-add-host');
        tap('phone-host-scan');
        await waitFor(() => expect(qr.live()).toBe(true));

        // A URL with no token is a web page, not a pairing link; plain text is neither.
        qr.show('https://example.test/menu');
        expect(screen.getByTestId('phone-qr-hint').textContent).toBe('that code is not a Kelpi pairing link');
        qr.show('WIFI:S:cafe;;');
        expect(screen.getByTestId('phone-qr-sheet')).toBeTruthy();
        expect(qr.live()).toBe(true);

        qr.show(PAIRING_URL);
        expect(screen.queryByTestId('phone-qr-sheet')).toBeNull();
        expect((screen.getByTestId('phone-host-url') as HTMLInputElement).value).toBe(PAIRING_URL);
    });

    it('shows why the camera did not start, with the URL field still behind it', async () => {
        const qr = fakeQrCamera({ refuse: new QrCameraError('denied') });
        setup({ qrCamera: qr.camera });
        tap('phone-open-workspaces');
        tap('phone-add-host');
        tap('phone-host-scan');
        await waitFor(() => expect(screen.getByTestId('phone-qr-error').textContent).toBe('camera access was refused - allow it in the browser settings, or paste the link'));

        tap('phone-qr-sheet-header-close');
        expect(screen.queryByTestId('phone-qr-sheet')).toBeNull();
        expect(screen.getByTestId('phone-host-url')).toBeTruthy();
    });

    it('stops the camera when the scanner, or the sheet under it, closes', async () => {
        const qr = fakeQrCamera();
        setup({ qrCamera: qr.camera });
        tap('phone-open-workspaces');
        tap('phone-add-host');
        tap('phone-host-scan');
        await waitFor(() => expect(qr.live()).toBe(true));
        tap('phone-qr-sheet-header-close');
        expect(qr.stops()).toBe(1);
        expect(screen.getByTestId('phone-host-sheet')).toBeTruthy();

        tap('phone-host-scan');
        await waitFor(() => expect(qr.live()).toBe(true));
        tap('phone-host-sheet-header-close');
        expect(qr.stops()).toBe(2);
        expect(screen.queryByTestId('phone-qr-sheet')).toBeNull();
    });
});

/**
 * B9 - ONE hierarchy, shown in two places (`phone/PhoneHostTree.tsx`).
 *
 * Owner, on a real Android phone, 2026-09-08 (device round 11): *"It does look weird with one
 * sidebar showing all hosts, and one showing only workspaces from one host."* What is pinned here
 * is that the drawer and the landing page render the SAME model - the same hosts, the same counts,
 * the same rows under them - and differ only in which sections start open.
 */
describe('one host tree, in two places', () => {
    const TWO_HOSTS = { [PHONE_HOSTS_KEY]: JSON.stringify([{ id: 'h1', name: 'studio', url: PAIRING_URL }]) };

    /** Whatever tree is on screen, as a person reads it: every host, open or shut, and its rows. */
    function readTree(): { key: string; kind: string; expanded: string; summary: string; rows: string[] }[] {
        return Array.from(document.querySelectorAll('[data-testid][data-host-kind]')).map((section) => ({
            key: (section.getAttribute('data-testid') ?? '').replace(/^phone-(?:landing-)?host-/, ''),
            kind: section.getAttribute('data-host-kind') ?? '',
            expanded: section.getAttribute('data-expanded') ?? '',
            summary: (
                section.querySelector('[data-testid^="phone-host-summary-"], [data-testid^="phone-landing-summary-"]')?.textContent ?? ''
            ).trim(),
            rows: Array.from(section.querySelectorAll('[data-testid="workspace-row"]')).map(
                (row) => row.getAttribute('data-workspace-id') ?? ''
            )
        }));
    }

    it('draws the same hosts, counts and rows on the landing page and in the drawer', () => {
        setup({ landing: true, storage: TWO_HOSTS });
        const onLanding = readTree();
        expect(onLanding.map((host) => host.key)).toEqual([ORIGIN_HOST_KEY, 'phone:h1']);
        expect(onLanding.map((host) => host.expanded)).toEqual(['true', 'true']);
        expect(onLanding.map((host) => host.summary)).toEqual(['1 workspace', '1 workspace']);
        expect(onLanding.map((host) => host.rows.join(','))).toEqual([W1, REMOTE_WS]);
        expect(screen.getByTestId('phone-landing-add-host')).toBeTruthy();

        // Into a workspace, then the drawer: the same tree, once the drawer's own default (the
        // host you are in, alone) is opened out. Add host is at the end of both.
        fireEvent.click(within(screen.getByTestId('phone-landing-host-origin')).getByTestId('workspace-row'));
        tap('phone-open-workspaces');
        fireEvent.click(screen.getByTestId('phone-host-toggle-phone:h1'));
        expect(readTree()).toEqual(onLanding);
        expect(screen.getByTestId('phone-add-host')).toBeTruthy();
    });

    it('opens the host you are in, shuts the others, and puts their counts on them anyway', () => {
        const h = setup({ storage: TWO_HOSTS });
        tap('phone-open-workspaces');
        const origin = screen.getByTestId('phone-host-origin');
        const studio = screen.getByTestId('phone-host-phone:h1');
        expect(origin.getAttribute('data-expanded')).toBe('true');
        expect(within(origin).getAllByTestId('workspace-row')).toHaveLength(1);
        expect(studio.getAttribute('data-expanded')).toBe('false');
        expect(within(studio).queryByTestId('workspace-row')).toBeNull();
        // A shut host still answers what a person picks a host BY: reachable, and how much is on it.
        expect(within(studio).getByTestId('phone-host-status-phone:h1').getAttribute('data-status')).toBe('connected');
        expect(within(studio).getByTestId('phone-host-summary-phone:h1').textContent).toBe('1 workspace');
        // That is the DEFAULT, so nothing is remembered until somebody taps a header.
        expect(h.hostStorage.map.has(PHONE_HOST_EXPANSION_KEY)).toBe(false);
    });

    it('remembers the sections a person opened or shut, and reads them back on the next open', () => {
        const h = setup({ storage: TWO_HOSTS });
        const stored = (): unknown => JSON.parse(h.hostStorage.map.get(PHONE_HOST_EXPANSION_KEY) ?? 'null');
        tap('phone-open-workspaces');
        fireEvent.click(screen.getByTestId('phone-host-toggle-phone:h1'));
        expect(screen.getByTestId('phone-host-phone:h1').getAttribute('data-expanded')).toBe('true');
        expect(stored()).toEqual({ 'phone:h1': true });
        // Shutting the one that was open by default is remembered too: the tap outranks the rule.
        fireEvent.click(screen.getByTestId('phone-host-toggle-origin'));
        expect(screen.getByTestId('phone-host-origin').getAttribute('data-expanded')).toBe('false');
        expect(stored()).toEqual({ 'phone:h1': true, origin: false });

        cleanup();
        setup({ landing: true, storage: { ...TWO_HOSTS, [PHONE_HOST_EXPANSION_KEY]: JSON.stringify({ 'phone:h1': false }) } });
        // The landing page opens everything, but a remembered tap still rules it.
        expect(screen.getByTestId('phone-landing-host-origin').getAttribute('data-expanded')).toBe('true');
        expect(screen.getByTestId('phone-landing-host-phone:h1').getAttribute('data-expanded')).toBe('false');
    });

    it('switches host and workspace in ONE move from a host that was shut', () => {
        const h = setup({ storage: TWO_HOSTS });
        expect(screen.getByTestId('phone-shell').getAttribute('data-phone-host')).toBe(ORIGIN_HOST_KEY);
        tap('phone-open-workspaces');
        fireEvent.click(screen.getByTestId('phone-host-toggle-phone:h1'));
        // One tap on the row - there is no "switch host" step in front of it.
        fireEvent.click(within(screen.getByTestId('phone-host-phone:h1')).getByTestId('workspace-row'));

        expect(screen.getByTestId('phone-shell').getAttribute('data-phone-host')).toBe('phone:h1');
        expect(screen.getByTestId('phone-title-workspace').textContent).toBe('studio · remote-ws');
        expect(screen.getByTestId(`pane-body-${REMOTE_PANE}`)).toBeTruthy();
        expect(screen.queryByTestId('phone-workspace-drawer')).toBeNull();
        expect(JSON.parse(h.hostStorage.map.get(PHONE_PLACE_KEY) ?? 'null')).toEqual({ host: 'phone:h1', workspaceID: REMOTE_WS });
    });

    it('takes the drawer’s All hosts row away, because the drawer IS all hosts', () => {
        setup({ storage: TWO_HOSTS });
        tap('phone-open-workspaces');
        expect(screen.queryByTestId('phone-drawer-landing')).toBeNull();
        expect(screen.getByTestId('phone-host-origin')).toBeTruthy();
        expect(screen.getByTestId('phone-host-phone:h1')).toBeTruthy();
        // The header's Hosts button is the way to the page, and it still is.
        expect(screen.getByTestId('phone-open-landing')).toBeTruthy();
    });
});

/**
 * B7 - every pane type through the shell. The origin's panes are drawn by assembly's own
 * `renderPane`, so what is pinned here is that the shell filters NOTHING by type on the way in,
 * and that the one type it answers itself (a web pane, MOBILE-PLAN.md §9) is a card in both modes.
 */
describe('every pane type', () => {
    it('lists a terminal, a content pane and a web pane in the sheet, each with its own glyph', () => {
        setup({ everyPaneType: true });
        expect(screen.getByTestId('phone-pane-count').textContent).toBe('3');
        tap('phone-open-panes');
        const sheet = screen.getByTestId('phone-pane-sheet');
        const glyph = (paneID: string): string | null =>
            within(sheet).getByTestId(`phone-pane-show-${paneID}`).querySelector('svg[data-icon]')?.getAttribute('data-icon') ?? null;
        expect(glyph(PANE_A)).toBe('terminal');
        expect(glyph(PANE_MD)).toBe('document');
        expect(glyph(PANE_WEB)).toBe('globe');
    });

    it('renders a content pane with the desktop’s own component, and reports it visible', async () => {
        const h = setup({ everyPaneType: true });
        tap('phone-open-panes');
        tap(`phone-pane-show-${PANE_MD}`);
        expect(screen.getByTestId(`pane-body-${PANE_MD}`)).toBeTruthy();
        // `MarkdownPane`'s own body, unchanged from the desktop; no phone-shaped stand-in.
        expect(screen.getByTestId(`content-status-${PANE_MD}`)).toBeTruthy();
        expect(screen.queryByTestId(`phone-web-card-${PANE_MD}`)).toBeNull();
        expect(screen.queryByTestId(`pane-body-${PANE_A}`)).toBeNull();
        await waitFor(() => {
            expect(h.lastOfType('visibility-report')).toMatchObject({ workspaceID: W1, visiblePaneIDs: [PANE_MD] });
        });
    });

    it('renders a web pane as a card that says so, never the desktop’s browser chrome', async () => {
        const h = setup({ everyPaneType: true });
        tap('phone-open-panes');
        tap(`phone-pane-show-${PANE_WEB}`);
        expect(screen.getByTestId(`pane-body-${PANE_WEB}`)).toBeTruthy();
        const card = screen.getByTestId(`phone-web-card-${PANE_WEB}`);
        expect(within(card).getByTestId(`phone-web-card-url-${PANE_WEB}`).textContent).toBe('https://example.test/docs');
        expect(card.textContent).toContain('does not host a browser view on a phone');
        expect(screen.getByTestId(`phone-web-card-open-${PANE_WEB}`).getAttribute('href')).toBe('https://example.test/docs');
        // The desktop's WebPane is not mounted at all, so nothing reports geometry for a native
        // view the phone has no shell to composite.
        expect(screen.queryByTestId(`web-pane-${PANE_WEB}`)).toBeNull();
        await waitFor(() => {
            expect(h.lastOfType('visibility-report')).toMatchObject({ workspaceID: W1, visiblePaneIDs: [PANE_WEB] });
        });
    });

    it('shows all three in layout mode, the web pane still a card', () => {
        setup({ everyPaneType: true });
        tap('phone-view-toggle');
        expect(screen.getByTestId('pane-grid')).toBeTruthy();
        expect(screen.getByTestId(`pane-body-${PANE_A}`)).toBeTruthy();
        expect(screen.getByTestId(`pane-body-${PANE_MD}`)).toBeTruthy();
        expect(screen.getByTestId(`phone-web-card-${PANE_WEB}`)).toBeTruthy();
        expect(screen.queryByTestId(`web-pane-${PANE_WEB}`)).toBeNull();
    });

    it('keeps the key bar for a terminal and takes it away for a web or content pane (C9)', async () => {
        setup({ everyPaneType: true });
        // The bar's mount condition is the pane REGISTRY's (`terminal/pane-registry.ts` is the
        // pane-type test: a handle exists only for a live terminal renderer), and a renderer
        // registers inside its own mount effect, one tick after the commit that rendered it.
        const bar = (): Element | null => document.querySelector('[data-terminal-key-bar]');
        await waitFor(() => {
            expect(bar()).not.toBeNull();
        });

        tap('phone-open-panes');
        tap(`phone-pane-show-${PANE_MD}`);
        await waitFor(() => {
            expect(bar()).toBeNull();
        });

        tap('phone-open-panes');
        tap(`phone-pane-show-${PANE_WEB}`);
        await waitFor(() => {
            expect(bar()).toBeNull();
        });

        tap('phone-open-panes');
        tap(`phone-pane-show-${PANE_A}`);
        await waitFor(() => {
            expect(bar()).not.toBeNull();
        });
    });
});
