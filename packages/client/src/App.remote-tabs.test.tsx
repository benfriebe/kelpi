/**
 * A paired daemon's tabs in this window's title bar (workspace-feature.md §12, §1.7).
 *
 * While a remote workspace fills the pane area, the bar draws THAT workspace's tabs from its
 * daemon's mirror, and every tab gesture (a click on a tab, a tab chord, a native menu row) goes
 * over that daemon's connection, never to this window's daemon and its hidden workspace.
 */

import type { JsonObject } from '@kelpi/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import type { RemoteDaemonEntry } from './app/remote-daemons';
import { createFakeSocketFactory, type FakeWebSocket } from './connection';
import { createKelpiRuntime, createKelpiStore, type KelpiRuntime } from './state';
import { createFakePhoneWindow, createFakePtyApi, createFakeRendererFactory, type FakePhoneWindow } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const REMOTE_WS = 'AAAAAAAA-0000-4000-8000-000000000099';
const REMOTE_P1 = 'DDDDDDDD-0000-4000-8000-000000000091';
const REMOTE_P2 = 'DDDDDDDD-0000-4000-8000-000000000092';
const REMOTE_T2 = 'FFFFFFFF-0000-4000-8000-000000000092';
const PANE_B = 'DDDDDDDD-0000-4000-8000-000000000002';
const LOCAL_T2 = 'FFFFFFFF-0000-4000-8000-000000000002';
const NOW = 1_755_500_000_000;
const PAIRING_URL = 'https://studio.tail.ts.net/?token=kd_secret';

function localState(twoTabs = false): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE_A, name: 'dev', color: 'blue', now: NOW });
    if (twoTabs) {
        store.dispatch({
            type: 'create-tab',
            workspaceID: W1,
            tabID: LOCAL_T2,
            focus: false,
            create: { type: 'create-pane', workspaceID: W1, paneID: PANE_B, now: NOW, workingDirectory: '/Users/test/api' }
        });
    }
    return store.getState() as unknown as JsonObject;
}

/** The paired daemon: one workspace with two tabs, the first on screen (or the second). */
function remoteState(showSecond = false): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/home/remote'));
    store.dispatch({ type: 'create-workspace', id: REMOTE_WS, paneID: REMOTE_P1, name: 'remote-ws', color: 'green', now: NOW });
    store.dispatch({
        type: 'create-tab',
        workspaceID: REMOTE_WS,
        tabID: REMOTE_T2,
        focus: false,
        create: { type: 'create-pane', workspaceID: REMOTE_WS, paneID: REMOTE_P2, now: NOW, workingDirectory: '/home/remote/api' }
    });
    if (showSecond) store.dispatch({ type: 'select-tab', workspaceID: REMOTE_WS, tabID: REMOTE_T2 });
    return store.getState() as unknown as JsonObject;
}

/** A paired daemon's runtime: its own mirror, a fake PTY, recorded commands, no socket. */
function fakeRemoteRuntime(target: string): { runtime: KelpiRuntime; sent: JsonObject[] } {
    const store = createKelpiStore();
    store.getState().applySnapshot(0, remoteState());
    store.getState().setConnectionStatus('connected');
    const sent: JsonObject[] = [];
    const runtime = {
        store,
        connection: { target, status: 'connected', isConnected: true, on: () => () => {} },
        pty: createFakePtyApi(),
        commands: {
            raw: vi.fn(async (input: JsonObject) => {
                if (input['command'] === 'plugin') {
                    if (input['action'] === 'identity') return { ok: true, result: { daemonID: 'remote-tabs-test' } };
                    return { ok: true, result: [] };
                }
                sent.push(input);
                return { ok: true };
            })
        },
        connect: vi.fn(),
        dispose: vi.fn(),
        activateWorkspace: vi.fn(),
        focusPane: vi.fn((workspaceID: string, paneID: string | null) => {
            store.getState().setFocusEcho(workspaceID, paneID);
        }),
        reportVisiblePanes: vi.fn(),
        reportObservedFocus: vi.fn(),
        setDocumentVisible: vi.fn()
    };
    return { runtime: runtime as unknown as KelpiRuntime, sent };
}

interface Harness {
    readonly socket: () => FakeWebSocket;
    /** Commands this window's own daemon received. */
    readonly localCommands: () => Record<string, unknown>[];
    /** Commands the paired daemon received (bar its plugin handshake). */
    readonly remoteCommands: () => JsonObject[];
    /** The paired daemon's runtime, once the window has made it. */
    readonly remote: () => KelpiRuntime | null;
}

function setup(
    keybindLines: readonly string[] = [],
    options: { readonly formFactorWindow?: FakePhoneWindow; readonly localTwoTabs?: boolean } = {}
): Harness {
    const sockets = createFakeSocketFactory();
    const runtime = createKelpiRuntime({
        url: 'ws://daemon.test/ws',
        token: 'tok',
        socketFactory: sockets.factory,
        store: createKelpiStore(),
        notifications: null,
        tokenStorage: null,
        heartbeatIntervalMs: 0,
        backoff: { initialMs: 10, maxMs: 10, factor: 1, jitter: 0 }
    });
    let remote: { runtime: KelpiRuntime; sent: JsonObject[] } | null = null;
    const factory = (entry: RemoteDaemonEntry): KelpiRuntime => {
        remote = fakeRemoteRuntime(entry.url);
        return remote.runtime;
    };
    render(
        <App
            runtime={runtime}
            createRenderer={createFakeRendererFactory().factory}
            remoteRuntimeFactory={factory}
            {...(options.formFactorWindow === undefined ? {} : { formFactorWindow: options.formFactorWindow })}
        />
    );
    act(() => {
        const socket = sockets.last();
        socket.open();
        socket.emit({
            type: 'welcome',
            protocolVersion: 4,
            clientID: 'client-1',
            daemon: { version: '0.1.0', build: 'test', pid: 4242 },
            settings: {
                keybindLines,
                remoteDaemons: [{ name: 'studio', url: PAIRING_URL }],
                general: { focusFollowsMouse: false, focusFollowsMouseDelay: 100, theme: null },
                appearance: { backgroundColor: '#0a0a0c', backgroundOpacity: 1, fontFamily: null, fontSize: null, isDark: true, theme: null }
            }
        });
        socket.emit({ type: 'snapshot', seq: 0, state: localState(options.localTwoTabs === true) });
    });
    return {
        socket: () => sockets.last(),
        localCommands: () =>
            sockets
                .last()
                .messages()
                .filter((message) => message['type'] === 'command')
                .map((message) => message['payload'] as Record<string, unknown>),
        remoteCommands: () => (remote as { sent: JsonObject[] } | null)?.sent ?? [],
        remote: () => (remote as { runtime: KelpiRuntime } | null)?.runtime ?? null
    };
}

/** Choose the paired daemon's workspace in the sidebar, as a click on its row does. */
async function selectRemoteWorkspace(): Promise<void> {
    const sections = await screen.findByTestId('remote-daemon-sections');
    const row = await waitFor(() => {
        const found = within(sections)
            .getAllByTestId('workspace-row')
            .find((element) => element.getAttribute('data-workspace-id') === REMOTE_WS);
        if (found === undefined) throw new Error('no remote row yet');
        return found;
    });
    act(() => {
        fireEvent.click(row);
    });
}

const tabIDs = (): (string | null)[] =>
    [...document.querySelectorAll('[data-testid="workspace-tabs"] [role="tab"]')].map((tab) => tab.getAttribute('data-workspace-tab-id'));

const tabCommands = (commands: readonly Record<string, unknown>[]): Record<string, unknown>[] =>
    commands.filter((command) => String(command['command']).startsWith('workspace-tab-'));

afterEach(() => {
    cleanup();
});

describe('a paired daemon\'s workspace in the title bar (§12, §1.7)', () => {
    it('draws that workspace\'s tabs in place of this window\'s', async () => {
        setup();
        expect(tabIDs()).toEqual([W1]);
        await selectRemoteWorkspace();
        await waitFor(() => expect(tabIDs()).toEqual([REMOTE_WS, REMOTE_T2]));
        expect(screen.queryByTestId('top-bar-identity')).toBeNull();
    });

    it('sends a click on a tab, and Duplicate Tab, to that daemon, never to this one', async () => {
        const h = setup();
        await selectRemoteWorkspace();
        await waitFor(() => expect(tabIDs()).toEqual([REMOTE_WS, REMOTE_T2]));

        fireEvent.click(screen.getByTestId(`workspace-tab-${REMOTE_T2}`));
        await waitFor(() =>
            expect(h.remoteCommands()).toContainEqual(expect.objectContaining({ command: 'workspace-tab-select', workspace_id: REMOTE_WS, tab_id: REMOTE_T2 }))
        );

        fireEvent.contextMenu(screen.getByTestId(`workspace-tab-${REMOTE_WS}`));
        fireEvent.click(await screen.findByText('Duplicate Tab'));
        await waitFor(() =>
            expect(h.remoteCommands()).toContainEqual(expect.objectContaining({ command: 'workspace-tab-duplicate', workspace_id: REMOTE_WS, tab_id: REMOTE_WS }))
        );
        expect(tabCommands(h.localCommands())).toEqual([]);
    });

    it('tells that daemon what this window shows, and where it is, when its tab on screen changes', async () => {
        const h = setup();
        await selectRemoteWorkspace();
        await waitFor(() => expect(tabIDs()).toEqual([REMOTE_WS, REMOTE_T2]));
        const remote = h.remote() as KelpiRuntime;
        await waitFor(() => expect(remote.reportVisiblePanes).toHaveBeenLastCalledWith(REMOTE_WS, [REMOTE_P1]));
        act(() => {
            remote.store.getState().applySnapshot(1, remoteState(true));
        });
        await waitFor(() => expect(remote.reportVisiblePanes).toHaveBeenLastCalledWith(REMOTE_WS, [REMOTE_P2]));
        // Record-only: the daemon already moved the tab, so this report can move nobody.
        expect(remote.reportObservedFocus).toHaveBeenLastCalledWith(REMOTE_WS, REMOTE_P2);
        expect(remote.focusPane).not.toHaveBeenCalledWith(REMOTE_WS, REMOTE_P2);
    });

    it('lets the tab chords act on that workspace, the window\'s own pane chords still standing down', async () => {
        const h = setup(['ctrl+alt+t=new_tab', 'ctrl+alt+2=go_to_tab_2']);
        await selectRemoteWorkspace();
        await waitFor(() => expect(tabIDs()).toEqual([REMOTE_WS, REMOTE_T2]));

        act(() => {
            fireEvent.keyDown(window, { code: 'Digit2', key: '2', ctrlKey: true, altKey: true });
            fireEvent.keyDown(window, { code: 'KeyT', key: 't', ctrlKey: true, altKey: true });
        });
        await waitFor(() => {
            expect(h.remoteCommands()).toContainEqual(expect.objectContaining({ command: 'workspace-tab-select', workspace_id: REMOTE_WS, tab_id: REMOTE_T2 }));
            expect(h.remoteCommands()).toContainEqual(expect.objectContaining({ command: 'workspace-tab-new', workspace_id: REMOTE_WS }));
        });
        expect(tabCommands(h.localCommands())).toEqual([]);
    });

    it('routes the native menu\'s tab rows there too, not to the hidden workspace behind it', async () => {
        const h = setup();
        await selectRemoteWorkspace();
        await waitFor(() => expect(tabIDs()).toEqual([REMOTE_WS, REMOTE_T2]));

        act(() => {
            h.socket().emit({ type: 'menu-command', command: 'new-tab' });
        });
        await waitFor(() =>
            expect(h.remoteCommands()).toContainEqual(expect.objectContaining({ command: 'workspace-tab-new', workspace_id: REMOTE_WS }))
        );
        expect(tabCommands(h.localCommands())).toEqual([]);
    });
});

describe('the phone layout and a desktop selection left behind (§12)', () => {
    it('acts on this window\'s own workspace, not on the paired one the desktop layout had selected', async () => {
        // An iPad with a mouse: the desktop layout, where a paired daemon's workspace is chosen.
        const phone = createFakePhoneWindow({ coarse: false });
        const h = setup(['ctrl+alt+2=go_to_tab_2'], { formFactorWindow: phone, localTwoTabs: true });
        await selectRemoteWorkspace();
        await waitFor(() => expect(tabIDs()).toEqual([REMOTE_WS, REMOTE_T2]));
        // The mouse goes: the phone layout, which answers to its own host, not the desktop's
        // selection (still set: nothing on the phone has picked a workspace yet).
        act(() => {
            phone.setPointer(true);
        });
        await screen.findByTestId('phone-shell');
        act(() => {
            fireEvent.keyDown(window, { code: 'Digit2', key: '2', ctrlKey: true, altKey: true });
        });
        await waitFor(() =>
            expect(h.localCommands()).toContainEqual(expect.objectContaining({ command: 'workspace-tab-select', workspace_id: W1, tab_id: LOCAL_T2 }))
        );
        expect(tabCommands(h.remoteCommands())).toEqual([]);

        // ...and its tab chips, once the local workspace is open, go the same way.
        act(() => {
            fireEvent.click(screen.getByTestId(`phone-home-workspace-${W1}`));
        });
        const chip = await screen.findByTestId(`phone-tab-chip-${LOCAL_T2}`);
        act(() => {
            fireEvent.click(chip);
        });
        await waitFor(() =>
            expect(tabCommands(h.localCommands()).filter((command) => command['tab_id'] === LOCAL_T2)).toHaveLength(2)
        );
        expect(tabCommands(h.remoteCommands())).toEqual([]);
    });
});
