/**
 * The four bindable actions the key registry used to advertise and not dispatch
 * (00-INDEX gap #6: `open_web_pane`, `rename_workspace`, `new_group`, `open_diff`).
 *
 * Each is catalogued, each round-trips through the config file and Settings ▸ Keybindings, and
 * before this file each one did nothing when pressed. Three of the four have a gesture
 * elsewhere (the header globe, the sidebar footer, the row context menu), so what is asserted
 * here is specifically the KEYBOARD half: the keystroke leaves as the same wire command the
 * gesture sends, or opens the same inline field the row menu opens.
 *
 * The harness is `App.settings.test.tsx`'s: a scripted daemon socket whose `welcome` carries
 * the settings payload, so `keybindLines` is how a default-unbound action (`open_diff`) gets a
 * trigger without reaching into the registry.
 */

import type { JsonObject } from '@kelpi/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { createFakeSocketFactory, type FakeWebSocket } from './connection';
import { createKelpiRuntime, createKelpiStore, type KelpiRuntime } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const GROUP_1 = 'CCCCCCCC-0000-4000-8000-000000000001';
const WEB_PANE = 'DDDDDDDD-0000-4000-8000-000000000009';
const WEB_TAB = 'EEEEEEEE-0000-4000-8000-000000000001';
const NOW = 1_755_500_000_000;

const WEB_TAB_2 = 'EEEEEEEE-0000-4000-8000-000000000002';

function snapshotState(options: { web?: boolean; tabs?: number } = {}): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({
        type: 'create-workspace',
        id: W1,
        paneID: PANE_A,
        name: 'dev',
        color: 'blue',
        now: NOW
    });
    if (options.web === true) {
        store.dispatch({
            type: 'open-web-pane',
            workspaceID: W1,
            paneID: WEB_PANE,
            tabID: WEB_TAB,
            url: 'https://example.com',
            now: NOW
        });
        if ((options.tabs ?? 1) > 1) {
            store.dispatch({
                type: 'web-tab-open',
                workspaceID: W1,
                paneID: WEB_PANE,
                tabID: WEB_TAB_2,
                url: 'https://second.example',
                makeActive: true
            });
        }
    }
    return store.getState() as unknown as JsonObject;
}

function settingsPayload(keybindLines: readonly string[]): Record<string, unknown> {
    return {
        keybindLines,
        general: { focusFollowsMouse: false, focusFollowsMouseDelay: 100, theme: null },
        appearance: {
            backgroundColor: '#0a0a0c',
            backgroundOpacity: 1,
            fontFamily: null,
            fontSize: null,
            isDark: true,
            theme: null
        }
    };
}

interface Harness {
    readonly runtime: KelpiRuntime;
    socket(): FakeWebSocket;
    sent(): Record<string, unknown>[];
    commands(): Record<string, unknown>[];
    /** The frame id of the last command with this name (for scripting its reply). */
    idOf(command: string): string | undefined;
}

function setup(
    keybindLines: readonly string[] = [],
    fixture: { web?: boolean; tabs?: number } = {}
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
    render(<App runtime={runtime} createRenderer={createFakeRendererFactory().factory} />);

    act(() => {
        const socket = sockets.last();
        socket.open();
        socket.emit({
            type: 'welcome',
            protocolVersion: 1,
            clientID: 'client-1',
            daemon: { version: '0.1.0', build: 'test', pid: 4242 },
            settings: settingsPayload(keybindLines)
        });
        socket.emit({ type: 'snapshot', seq: 0, state: snapshotState(fixture) });
    });

    const sent = (): Record<string, unknown>[] => sockets.last().messages();
    return {
        runtime,
        socket: () => sockets.last(),
        sent,
        commands: () =>
            sent()
                .filter((message) => message['type'] === 'command')
                .map((message) => message['payload'] as Record<string, unknown>),
        idOf: (command) =>
            [...sent()]
                .reverse()
                .find(
                    (message) =>
                        message['type'] === 'command' &&
                        (message['payload'] as Record<string, unknown>)['command'] === command
                )?.['id'] as string | undefined
    };
}

afterEach(() => {
    cleanup();
});

describe('open_web_pane (⌘⇧O)', () => {
    it('opens a blank web pane anchored on the focused pane', async () => {
        const h = setup();

        act(() => {
            fireEvent.keyDown(window, { code: 'KeyO', key: 'O', metaKey: true, shiftKey: true });
        });

        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({
                command: 'web-open',
                url: 'about:blank',
                private: false,
                pane_id: PANE_A
            });
        });
    });
});

describe('open_diff (default unbound)', () => {
    it('opens a diff for the focused pane’s working directory, unscoped', async () => {
        const h = setup(['ctrl+alt+d=open_diff']);

        act(() => {
            fireEvent.keyDown(window, { code: 'KeyD', key: 'd', ctrlKey: true, altKey: true });
        });

        await waitFor(() => {
            const diff = h.commands().at(-1);
            expect(diff).toMatchObject({ command: 'diff', pane_id: PANE_A });
            // Unscoped: the Swift menu item passes no target path.
            expect(diff?.['target_path']).toBeUndefined();
            expect(typeof diff?.['repo_path']).toBe('string');
        });
    });
});

describe('rename_workspace (⌘⇧R)', () => {
    it('opens the sidebar’s inline rename field on the active workspace', async () => {
        setup();
        expect(screen.queryByLabelText('Rename dev')).toBeNull();

        act(() => {
            fireEvent.keyDown(window, { code: 'KeyR', key: 'R', metaKey: true, shiftKey: true });
        });

        const field = await screen.findByLabelText('Rename dev');
        expect((field as HTMLInputElement).value).toBe('dev');
    });

    it('commits through the same rename command the row menu uses', async () => {
        const h = setup();
        act(() => {
            fireEvent.keyDown(window, { code: 'KeyR', key: 'R', metaKey: true, shiftKey: true });
        });
        const field = await screen.findByLabelText('Rename dev');

        act(() => {
            fireEvent.change(field, { target: { value: 'renamed' } });
            fireEvent.keyDown(field, { key: 'Enter', code: 'Enter' });
        });

        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({
                command: 'rename-workspace',
                workspace_id: W1,
                name: 'renamed'
            });
        });
    });
});

describe('new_group (⌘⇧G)', () => {
    /**
     * The verb is `create-group-for-workspaces` with NO workspaces, and that matters (§WS-123).
     *
     * Both halves of this gesture — the inline rename and the header's scroll-into-view — need
     * the new group's id, and the id only exists in a reply. The wire's `group-create` is
     * fire-and-forget (wire-protocol.md §7) and its ack carries nothing, so while this path used
     * it the chord created a group and then did neither; the audit's `workspace-edges` flow
     * found it by timing out on a rename field that never opened.
     */
    it('mints a uniquely named group immediately instead of opening the form', async () => {
        const h = setup();

        act(() => {
            fireEvent.keyDown(window, { code: 'KeyG', key: 'G', metaKey: true, shiftKey: true });
        });

        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({
                command: 'create-group-for-workspaces',
                name: 'New Group',
                workspace_ids: []
            });
        });
        // The form is NOT what opened: no name field asking for one up front.
        expect(screen.queryByLabelText('Group name')).toBeNull();
    });

    it('drops into inline rename on the group the daemon just created', async () => {
        const h = setup();
        act(() => {
            fireEvent.keyDown(window, { code: 'KeyG', key: 'G', metaKey: true, shiftKey: true });
        });
        await waitFor(() => {
            expect(h.idOf('create-group-for-workspaces')).toBeDefined();
        });

        // The reply names the group; the delta is what puts its row on screen.
        const store = createDaemonStore(emptyDaemonState('/Users/test'));
        store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE_A, name: 'dev', color: 'blue', now: NOW });
        store.dispatch({ type: 'create-group', id: GROUP_1, name: 'New Group', now: NOW });
        await act(async () => {
            h.socket().emit({
                type: 'command-reply',
                id: h.idOf('create-group-for-workspaces') as string,
                reply: { ok: true, group_id: GROUP_1, group_name: 'New Group' }
            });
            h.socket().emit({ type: 'snapshot', seq: 1, state: store.getState() as unknown as JsonObject });
            await Promise.resolve();
        });

        const field = await screen.findByLabelText('Rename New Group');
        expect((field as HTMLInputElement).value).toBe('New Group');
    });
});

describe('web_tab_close on the only tab (§WEB-013)', () => {
    it('closes the PANE rather than refusing, the way the Swift reducer does', async () => {
        const h = setup(['ctrl+alt+w=web_tab_close'], { web: true });
        // The web pane is the focused one (the daemon focuses what it just opened).
        await waitFor(() => {
            expect(screen.getByTestId(`web-pane-${WEB_PANE}`)).toBeTruthy();
        });

        act(() => {
            fireEvent.keyDown(window, { code: 'KeyW', key: 'w', ctrlKey: true, altKey: true });
        });

        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({ command: 'pane-close', pane_id: WEB_PANE });
        });
        // And NOT the tab verb, which the wire refuses for a single tab by design.
        expect(h.commands().some((command) => command['command'] === 'web-tab-close')).toBe(false);
    });

    /**
     * The gesture a default install actually has — and the one Swift has (§WEB-013).
     *
     * `web_tab_close` ships UNBOUND in both apps, and neither draws a ✕ for a lone tab (the
     * strip is hidden below two tabs, §WEB-018). So the keystroke that closes the last tab is
     * plain ⌘W: the web-pane priority layer claims ⌘W only while there are ≥2 tabs and returns
     * `null` otherwise, which drops the chord into the normal binding map where ⌘W is
     * `close_pane`. The tab and the pane die together, exactly as
     * `NexCommands.swift:300-307`'s `guard … webState.tabs.count > 1 … else { return nil }`
     * arranges it.
     */
    it('⌘W on a lone tab falls through the priority layer to close_pane', async () => {
        const h = setup([], { web: true });
        await waitFor(() => {
            expect(screen.getByTestId(`web-pane-${WEB_PANE}`)).toBeTruthy();
        });

        act(() => {
            fireEvent.keyDown(window, { code: 'KeyW', key: 'w', metaKey: true });
        });

        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({ command: 'pane-close', pane_id: WEB_PANE });
        });
        expect(h.commands().some((command) => command['command'] === 'web-tab-close')).toBe(false);
    });

    it('…and with a SECOND tab the same ⌘W closes the tab instead, leaving the pane alone', async () => {
        const h = setup([], { web: true, tabs: 2 });
        await waitFor(() => {
            expect(screen.getByTestId(`web-pane-${WEB_PANE}`)).toBeTruthy();
        });

        act(() => {
            fireEvent.keyDown(window, { code: 'KeyW', key: 'w', metaKey: true });
        });

        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({ command: 'web-tab-close', pane_id: WEB_PANE });
        });
        expect(h.commands().some((command) => command['command'] === 'pane-close')).toBe(false);
    });
});
