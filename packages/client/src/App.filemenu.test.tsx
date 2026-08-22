/**
 * §WS-151 — the shipped app's File menu, arriving as `menu-command`s.
 *
 * The shell's own rows are `shell/src/menu.test.ts`'s subject (labels, order, accelerators, the
 * relay). What is asserted HERE is the other end of the same wire: that each row reaches the
 * gesture it names, and reaches the SAME one its keybinding does — New Group is the ⌘⇧G mint,
 * New Web Pane the ⌘⇧O blank pane, Command Palette the ⌘P overlay, Switch to Workspace N the
 * ⌘1…⌘9 activation. (The keyboard halves themselves are `App.keyactions.test.tsx`'s; they were
 * already registered, and this file exists because the MENU halves were not.)
 *
 * The two rows with no keyboard half at all are the interesting ones: Select All / Deselect All
 * Workspaces are plain `Button`s in `NexCommands.swift:49-57`, outside the binding map, and the
 * selection they move is the sidebar's own client-local state. So they run through the sidebar's
 * published handle, and the count travels BACK to the shell as `workspace-selection` so the
 * Deselect All row can be greyed exactly as `.disabled(selectedWorkspaceIDs.isEmpty)` greys it.
 *
 * The harness is `App.openflow.test.tsx`'s: the whole client against a scripted daemon socket,
 * so what is asserted is the wire traffic and the DOM a gesture actually produces.
 */

import type { JsonObject } from '@nex/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@nex/daemon/store';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import {
    COMMAND_PALETTE_COMMAND,
    DESELECT_ALL_WORKSPACES_COMMAND,
    NEW_GROUP_COMMAND,
    NEW_WEB_PANE_COMMAND,
    SELECT_ALL_WORKSPACES_COMMAND,
    SWITCH_WORKSPACE_COMMAND_PREFIX,
    switchWorkspacePosition,
    workspaceSelectionReport
} from './app/file-menu';
import { completeHandshake, createFakeSocketFactory, type FakeWebSocket } from './connection';
import { createNexRuntime, createNexStore, type NexRuntime } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const W2 = 'AAAAAAAA-0000-4000-8000-000000000002';
const W3 = 'AAAAAAAA-0000-4000-8000-000000000003';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const PANE_B = 'DDDDDDDD-0000-4000-8000-000000000002';
const PANE_C = 'DDDDDDDD-0000-4000-8000-000000000003';
const NOW = 1_755_500_000_000;

/** Three top-level workspaces, so ⌘2's row is unambiguous and Select All has something to do. */
function snapshotState(): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE_A, name: 'alpha', color: 'blue', now: NOW });
    store.dispatch({ type: 'create-workspace', id: W2, paneID: PANE_B, name: 'beta', color: 'green', now: NOW });
    store.dispatch({ type: 'create-workspace', id: W3, paneID: PANE_C, name: 'gamma', color: 'red', now: NOW });
    // `create-workspace` activates the newest; put the user back on the first so a switch to
    // position 2 is a real move rather than a no-op that would pass either way.
    store.dispatch({ type: 'set-active-workspace', id: W1, now: NOW });
    return store.getState() as unknown as JsonObject;
}

interface Harness {
    readonly runtime: NexRuntime;
    socket(): FakeWebSocket;
    sent(): Record<string, unknown>[];
    commands(): Record<string, unknown>[];
    /** Every `workspace-selection` frame this client has put on the wire, in order. */
    selectionReports(): Record<string, unknown>[];
    /**
     * The `visibility-report`s that carry "this is the workspace I am looking at". There is no
     * dedicated activate message — a visibility report is the mechanism (`ws/sync.ts`).
     */
    activeReports(): Record<string, unknown>[];
    /** Fire one row exactly as `fileMenuTemplate`'s click does. */
    fire(command: string, windowID?: string): void;
}

function setup(): Harness {
    const sockets = createFakeSocketFactory();
    const store = createNexStore();
    const runtime = createNexRuntime({
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
        completeHandshake(sockets.last(), { state: snapshotState() });
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
        selectionReports: () => sent().filter((message) => message['type'] === 'workspace-selection'),
        activeReports: () => sent().filter((message) => message['type'] === 'visibility-report'),
        fire: (command, windowID) => {
            act(() => {
                sockets.last().emit({
                    type: 'menu-command',
                    command,
                    ...(windowID === undefined ? {} : { windowID })
                });
            });
        }
    };
}

const rows = (): HTMLElement[] => screen.queryAllByTestId('workspace-row');
const activeID = (): string | null =>
    rows()
        .find((row) => row.getAttribute('data-active') === 'true')
        ?.getAttribute('data-workspace-id') ?? null;
const selectedIDs = (): string[] =>
    rows()
        .filter((row) => row.getAttribute('data-selected') === 'true')
        .map((row) => row.getAttribute('data-workspace-id') ?? '');

afterEach(cleanup);

describe('File ▸ New Group (§WS-151 / §SET-144)', () => {
    /**
     * The same `act.newGroupWithRename()` ⌘⇧G runs — so the row mints `New Group` immediately
     * and drops into inline rename, rather than opening the footer's New Group *form*. That is
     * the shipped app's own behaviour (`NexCommands.swift:15-21` sends `createGroup(autoRename:)`
     * with a placeholder), and it is why the verb is `create-group-for-workspaces` with no
     * workspaces: both the rename and the reveal need an id only a REPLY carries (§WS-123).
     */
    it('mints a uniquely named group through the same verb the chord uses', async () => {
        const h = setup();
        h.fire(NEW_GROUP_COMMAND);

        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({
                command: 'create-group-for-workspaces',
                name: 'New Group',
                workspace_ids: []
            });
        });
        // Not the form: the footer's field asks for a name up front, and this gesture does not.
        expect(screen.queryByLabelText('Group name')).toBeNull();
    });

    it('ignores a New Group relay addressed to a different shell window', () => {
        const h = setup();
        h.fire(NEW_GROUP_COMMAND, 'someone-elses-window');
        expect(
            h.commands().some((payload) => payload['command'] === 'create-group-for-workspaces')
        ).toBe(false);
    });
});

describe('File ▸ New Web Pane (§WS-151 / §SET-145)', () => {
    it('opens a blank web pane anchored on the focused pane, as ⌘⇧O does', async () => {
        const h = setup();
        h.fire(NEW_WEB_PANE_COMMAND);

        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({
                command: 'web-open',
                url: 'about:blank',
                private: false,
                pane_id: PANE_A
            });
        });
    });

    it('ignores a New Web Pane relay addressed to a different shell window', () => {
        const h = setup();
        h.fire(NEW_WEB_PANE_COMMAND, 'someone-elses-window');
        expect(h.commands().some((payload) => payload['command'] === 'web-open')).toBe(false);
    });
});

describe('File ▸ Command Palette (§WS-151)', () => {
    it('opens the palette, and firing again closes it', async () => {
        const h = setup();
        expect(screen.queryByTestId('command-palette')).toBeNull();

        h.fire(COMMAND_PALETTE_COMMAND);
        await waitFor(() => {
            expect(screen.getByTestId('command-palette')).toBeTruthy();
        });

        // It is a TOGGLE, exactly as ⌘P is — the Swift row sends `toggleCommandPalette`.
        h.fire(COMMAND_PALETTE_COMMAND);
        await waitFor(() => {
            expect(screen.queryByTestId('command-palette')).toBeNull();
        });
    });

    it('ignores a palette relay addressed to a different shell window', () => {
        const h = setup();
        h.fire(COMMAND_PALETTE_COMMAND, 'someone-elses-window');
        expect(screen.queryByTestId('command-palette')).toBeNull();
    });
});

describe('File ▸ Switch to Workspace 1…9 (§WS-151)', () => {
    it('activates the workspace at that 1-based sidebar position', async () => {
        const h = setup();
        expect(activeID()).toBe(W1);

        h.fire(`${SWITCH_WORKSPACE_COMMAND_PREFIX}2`);
        await waitFor(() => {
            expect(activeID()).toBe(W2);
        });
        // …and the daemon is told, on the same report a sidebar click sends.
        expect(h.activeReports().at(-1)).toMatchObject({ workspaceID: W2 });

        h.fire(`${SWITCH_WORKSPACE_COMMAND_PREFIX}3`);
        await waitFor(() => {
            expect(activeID()).toBe(W3);
        });
    });

    it('does nothing for a position past the end, and never for a malformed one', async () => {
        const h = setup();
        const before = h.activeReports().length;

        // Position 9 of three workspaces: `switchToIndex` finds no id and declines.
        h.fire(`${SWITCH_WORKSPACE_COMMAND_PREFIX}9`);
        h.fire(`${SWITCH_WORKSPACE_COMMAND_PREFIX}0`);
        h.fire(`${SWITCH_WORKSPACE_COMMAND_PREFIX}10`);
        h.fire(SWITCH_WORKSPACE_COMMAND_PREFIX);

        await waitFor(() => {
            expect(h.activeReports().length).toBe(before);
        });
        expect(activeID()).toBe(W1);
        // …and the parser the client uses is the one whose format the shell's own is pinned to.
        expect(switchWorkspacePosition('switch-workspace-4')).toBe(4);
        expect(switchWorkspacePosition('switch-workspace-10')).toBeNull();
    });
});

/**
 * §WS-151's two menu-only rows, and the state under them.
 *
 * "Select All Workspaces / Deselect All Workspaces (the latter disabled with an empty
 * selection)". Both halves are here: the rows move the sidebar's selection, and the selection
 * moves the report the shell greys its row from.
 */
describe('File ▸ Select All / Deselect All Workspaces (§WS-151)', () => {
    it('selects every workspace, then clears them', async () => {
        const h = setup();
        expect(selectedIDs()).toEqual([]);

        h.fire(SELECT_ALL_WORKSPACES_COMMAND);
        await waitFor(() => {
            expect(selectedIDs().sort()).toEqual([W1, W2, W3].sort());
        });

        h.fire(DESELECT_ALL_WORKSPACES_COMMAND);
        await waitFor(() => {
            expect(selectedIDs()).toEqual([]);
        });
    });

    it('reports the count to the shell, deduped, starting from the 0 it states on mount', async () => {
        const h = setup();
        // The mount-time 0: a reloaded page must be able to correct a shell whose menu still
        // carries the selection the previous page reported before it went away.
        await waitFor(() => {
            expect(h.selectionReports()[0]).toMatchObject({ type: 'workspace-selection', selected: 0 });
        });
        const afterMount = h.selectionReports().length;

        h.fire(SELECT_ALL_WORKSPACES_COMMAND);
        await waitFor(() => {
            expect(h.selectionReports().at(-1)).toMatchObject({ selected: 3 });
        });

        // Selecting all again changes nothing, and must therefore say nothing.
        const afterSelect = h.selectionReports().length;
        h.fire(SELECT_ALL_WORKSPACES_COMMAND);
        await Promise.resolve();
        expect(h.selectionReports().length).toBe(afterSelect);

        h.fire(DESELECT_ALL_WORKSPACES_COMMAND);
        await waitFor(() => {
            expect(h.selectionReports().at(-1)).toMatchObject({ selected: 0 });
        });
        expect(h.selectionReports().length).toBeGreaterThan(afterMount);
    });

    it('reports 0 when the sidebar goes away with a selection in it', async () => {
        const h = setup();
        h.fire(SELECT_ALL_WORKSPACES_COMMAND);
        await waitFor(() => {
            expect(h.selectionReports().at(-1)).toMatchObject({ selected: 3 });
        });

        // §WS-001's toggle unmounts the sidebar, and the selection lives in it — so it really is
        // gone, and a shell left believing in it would offer a Deselect All that clears nothing.
        h.fire('toggle-sidebar');
        await waitFor(() => {
            expect(screen.queryByTestId('sidebar-slot')).toBeNull();
        });
        expect(h.selectionReports().at(-1)).toMatchObject({ selected: 0 });
    });

    it('Select All shows the sidebar first when it is hidden, and still selects', async () => {
        const h = setup();
        h.fire('toggle-sidebar');
        await waitFor(() => {
            expect(screen.queryByTestId('sidebar-slot')).toBeNull();
        });

        h.fire(SELECT_ALL_WORKSPACES_COMMAND);
        await waitFor(() => {
            expect(selectedIDs().sort()).toEqual([W1, W2, W3].sort());
        });
    });

    it('Deselect All with nothing selected changes nothing and says nothing', async () => {
        const h = setup();
        await waitFor(() => {
            expect(h.selectionReports().length).toBeGreaterThan(0);
        });
        const before = h.selectionReports().length;

        h.fire(DESELECT_ALL_WORKSPACES_COMMAND);
        await Promise.resolve();

        expect(selectedIDs()).toEqual([]);
        expect(h.selectionReports().length).toBe(before);
    });

    it('ignores both rows when they are addressed to a different shell window', async () => {
        const h = setup();
        h.fire(SELECT_ALL_WORKSPACES_COMMAND, 'someone-elses-window');
        await Promise.resolve();
        expect(selectedIDs()).toEqual([]);
    });

    it('builds the report frame the daemon relays and the shell reads', () => {
        expect(workspaceSelectionReport(2, 'WIN-1')).toEqual({
            type: 'workspace-selection',
            selected: 2,
            windowID: 'WIN-1'
        });
        // A browser tab has no shell window, and must not invent one — an unscoped report is
        // every shell's, which is the single-window case.
        expect(workspaceSelectionReport(0, null)).toEqual({ type: 'workspace-selection', selected: 0 });
    });
});

/**
 * The literals, pinned on this side too.
 *
 * The shell and the client do not share a module for menu command names (`app/file-menu.ts`
 * says why), so a rename on either side has to fail on the other. `shell/src/menu.test.ts`
 * asserts the same six strings.
 */
describe('the `menu-command` names', () => {
    it('are the ones `shell/src/menu.ts` relays', () => {
        expect(NEW_GROUP_COMMAND).toBe('new-group');
        expect(NEW_WEB_PANE_COMMAND).toBe('new-web-pane');
        expect(COMMAND_PALETTE_COMMAND).toBe('command-palette');
        expect(SELECT_ALL_WORKSPACES_COMMAND).toBe('select-all-workspaces');
        expect(DESELECT_ALL_WORKSPACES_COMMAND).toBe('deselect-all-workspaces');
        expect(SWITCH_WORKSPACE_COMMAND_PREFIX).toBe('switch-workspace-');
    });

    it('leave an unknown command to the chord replay, unchanged', () => {
        const h = setup();
        // `web-chord:` is the only other thing a `menu-command` can be; a File row that does not
        // exist must not be swallowed by one of the branches above.
        expect(() => {
            h.fire('no-such-row');
        }).not.toThrow();
        expect(selectedIDs()).toEqual([]);
        expect(screen.queryByTestId('command-palette')).toBeNull();
    });
});

/**
 * The keyboard halves of the two rows that HAVE one, re-asserted here beside the menu halves.
 *
 * `App.keyactions.test.tsx` owns them in depth (it is where they were added); what this pins is
 * the §WS-151 clause itself — that the row and the chord are one gesture by two routes — so a
 * change that moved one without the other fails in the file that claims they agree.
 */
describe('the same two gestures from the keyboard', () => {
    it('⌘⇧G mints the group the New Group row mints', async () => {
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
    });

    it('⌘⇧O opens the blank web pane the New Web Pane row opens', async () => {
        const h = setup();
        act(() => {
            fireEvent.keyDown(window, { code: 'KeyO', key: 'O', metaKey: true, shiftKey: true });
        });
        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({
                command: 'web-open',
                url: 'about:blank',
                pane_id: PANE_A
            });
        });
    });
});
