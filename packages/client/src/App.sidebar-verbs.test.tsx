/**
 * Assembly tests for the four sidebar row/selection verbs whose *wiring* was the open half —
 * §WS-048 (a row's Color ▸), §WS-052 (Move to Group ▸ New Group…), §WS-054 (the active-agents
 * gate on a row delete) and §WS-062 (the bulk-delete confirmation).
 *
 * Each of them has a component test already (`Sidebar.test.tsx`, `sidebar-delete-gate.test.tsx`,
 * `Sidebar.bulk.test.tsx`), and a component test is exactly what could not settle them: they
 * assert that a callback fires, and the gap in every case was whether assembly passes a callback
 * at all and whether it reaches the daemon. So these drive the WHOLE client against a scripted
 * socket and assert the wire frame that comes out the other end — the same shape as
 * `App.openflow.test.tsx`.
 */

import type { JsonObject } from '@kelpi/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { completeHandshake, createFakeSocketFactory, type FakeWebSocket } from './connection';
import { createKelpiRuntime, createKelpiStore, type KelpiRuntime } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const W2 = 'AAAAAAAA-0000-4000-8000-000000000002';
const W3 = 'AAAAAAAA-0000-4000-8000-000000000003';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const PANE_B = 'DDDDDDDD-0000-4000-8000-000000000002';
const PANE_C = 'DDDDDDDD-0000-4000-8000-000000000003';
const NOW = 1_755_500_000_000;

const NEW_GROUP = 'CCCCCCCC-0000-4000-8000-000000000009';

/**
 * alpha (idle) · beta (one running agent) · gamma — enough for a gate, a bulk and a group.
 *
 * `group` adds the group the daemon would have broadcast, so a test can put the mirror in the
 * state the reply is about to refer to. (Pushed as a fresh `snapshot`, not a hand-built delta: a
 * delta the client cannot apply makes it resync, which drops the in-flight command with it.)
 */
function snapshotState(options: { group?: { id: string; name: string; members?: string[] } } = {}): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE_A, name: 'alpha', color: 'blue', now: NOW });
    store.dispatch({ type: 'create-workspace', id: W2, paneID: PANE_B, name: 'beta', color: 'green', now: NOW });
    store.dispatch({ type: 'create-workspace', id: W3, paneID: PANE_C, name: 'gamma', color: 'red', now: NOW });
    // §WS-054's precondition: beta has an agent mid-turn, which is what the gate counts.
    store.dispatch({
        type: 'pane-agent-event',
        paneID: PANE_B,
        workspaceID: W2,
        event: { type: 'agentStarted', agent: 'claude' },
        now: NOW
    });
    if (options.group !== undefined) {
        store.dispatch({
            type: 'create-group',
            id: options.group.id,
            name: options.group.name,
            now: NOW,
            initialWorkspaceIDs: options.group.members ?? []
        });
    }
    store.dispatch({ type: 'set-active-workspace', id: W1, now: NOW });
    return store.getState() as unknown as JsonObject;
}

interface Harness {
    readonly runtime: KelpiRuntime;
    socket(): FakeWebSocket;
    commands(): Record<string, unknown>[];
    lastCommand(name: string): Record<string, unknown> | undefined;
    /** Answer the newest in-flight command with `{ok:true, ...extra}`. */
    reply(extra: Record<string, unknown>): void;
}

function setup(): Harness {
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
        completeHandshake(sockets.last(), { state: snapshotState() });
    });

    const frames = (): Record<string, unknown>[] =>
        sockets
            .last()
            .messages()
            .filter((message) => message['type'] === 'command');
    return {
        runtime,
        socket: () => sockets.last(),
        commands: () => frames().map((message) => message['payload'] as Record<string, unknown>),
        lastCommand: (name) =>
            [...frames()]
                .reverse()
                .map((message) => message['payload'] as Record<string, unknown>)
                .find((payload) => payload['command'] === name),
        reply(extra) {
            const frame = [...frames()].reverse()[0];
            if (frame === undefined) throw new Error('no command in flight');
            act(() => {
                sockets.last().emit({ type: 'command-reply', id: frame['id'], reply: { ok: true, ...extra } });
            });
        }
    };
}

function row(name: string): HTMLElement {
    const found = screen.getAllByTestId('workspace-row').find((entry) => entry.textContent?.includes(name));
    if (found === undefined) throw new Error(`no sidebar row for "${name}"`);
    return found;
}

/** Right-click a row and hover a submenu parent, returning the submenu panel. */
function submenuOn(name: string, parent: string): HTMLElement {
    fireEvent.contextMenu(row(name));
    fireEvent.mouseEnter(screen.getByText(parent));
    return screen.getByTestId('context-submenu');
}

afterEach(cleanup);

describe('a row’s Color ▸ (§WS-048)', () => {
    it('reaches the daemon as one `set-bulk-color` naming just that workspace', () => {
        const h = setup();
        // M3: the row is `WorkspaceColor.displayName` — "Purple" — and the WIRE is unchanged.
        fireEvent.click(within(submenuOn('alpha', 'Color')).getByText('Purple'));
        expect(h.lastCommand('set-bulk-color')).toMatchObject({
            command: 'set-bulk-color',
            workspace_ids: [W1],
            color: 'purple'
        });
    });

    it('ticks the colour the workspace already has, rather than nothing', () => {
        setup();
        const submenu = submenuOn('beta', 'Color');
        const ticked = [...submenu.querySelectorAll('[data-menu-item]')].filter(
            (item) => item.getAttribute('data-checked') === 'true'
        );
        expect(ticked.map((item) => item.getAttribute('data-menu-item'))).toEqual(['color:green']);
    });
});

describe('Move to Group ▸ New Group… (§WS-052)', () => {
    it('creates the group WITH the workspace in one command, not a create then a move', () => {
        const h = setup();
        fireEvent.click(within(submenuOn('alpha', 'Move to Group')).getByText('New Group…'));

        expect(h.lastCommand('create-group-for-workspaces')).toMatchObject({
            command: 'create-group-for-workspaces',
            name: 'New Group',
            workspace_ids: [W1]
        });
        // The half that would have shown the row jumping twice: no separate move goes out.
        expect(h.lastCommand('workspace-move')).toBeUndefined();
    });

    it('opens inline rename on the header the REPLY named', async () => {
        const h = setup();
        fireEvent.click(within(submenuOn('alpha', 'Move to Group')).getByText('New Group…'));

        // The daemon broadcasts the new group, then answers the command — in that order, which
        // is what makes the reply's id addressable at all.
        act(() => {
            h.socket().emit({
                type: 'snapshot',
                seq: 1,
                state: snapshotState({ group: { id: NEW_GROUP, name: 'New Group', members: [W1] } })
            });
        });
        h.reply({ group_id: NEW_GROUP, name: 'New Group', workspace_ids: [W1] });

        // The rename field opens on the new header — the id existed nowhere but the reply.
        await waitFor(() => {
            expect(screen.getByLabelText('Rename New Group')).toBeTruthy();
        });
    });

    it('mints "New Group 2" once the placeholder name is taken', () => {
        const h = setup();
        act(() => {
            h.socket().emit({
                type: 'snapshot',
                seq: 1,
                state: snapshotState({ group: { id: NEW_GROUP, name: 'New Group' } })
            });
        });
        fireEvent.click(within(submenuOn('alpha', 'Move to Group')).getByText('New Group…'));
        expect(h.lastCommand('create-group-for-workspaces')).toMatchObject({ name: 'New Group 2' });
    });

    /**
     * §WS-123 — the rename drop-in and the header reveal are ONE gesture, not two features.
     *
     * The Swift queues `scrollToTarget(.group(id))` in the same reducer branch that sets
     * `autoRename` (`AppReducer.swift:1762-1771`), because a rename field on a header that is
     * scrolled out of the sidebar is a keystroke the user cannot see. The sidebar's own reveal
     * is proven by `sidebar-polish.test.tsx` ("reveals a newly created GROUP by its header");
     * what only assembly can answer is whether the MENU paths ask for it at all — the id exists
     * nowhere but the reply, so this is the only place the request can be made.
     *
     * jsdom has no layout, so the reveal takes its no-box-model branch and hands the header to
     * `scrollIntoView` — the same observable end `App.reveal-paths.test.tsx` uses.
     */
    describe('queues the header reveal alongside the rename (§WS-123)', () => {
        let scrolled: Element[] = [];
        let original: () => void;

        beforeEach(() => {
            scrolled = [];
            original = Element.prototype.scrollIntoView;
            Element.prototype.scrollIntoView = function scrollIntoView(this: Element): void {
                scrolled.push(this);
            };
        });

        afterEach(() => {
            Element.prototype.scrollIntoView = original;
        });

        const revealedHeader = (): boolean =>
            scrolled.some((element) => element.getAttribute('data-testid') === 'group-header');

        const answer = (h: Harness): void => {
            act(() => {
                h.socket().emit({
                    type: 'snapshot',
                    seq: 1,
                    state: snapshotState({ group: { id: NEW_GROUP, name: 'New Group', members: [W1] } })
                });
            });
            scrolled.length = 0;
            h.reply({ group_id: NEW_GROUP, name: 'New Group', workspace_ids: [W1] });
        };

        it('from a row’s Move to Group ▸ New Group…', async () => {
            const h = setup();
            fireEvent.click(within(submenuOn('alpha', 'Move to Group')).getByText('New Group…'));
            answer(h);
            await waitFor(() => {
                expect(screen.getByLabelText('Rename New Group')).toBeTruthy();
            });
            expect(revealedHeader()).toBe(true);
        });

        /**
         * ⌘⇧G goes out as `create-group-for-workspaces` with NO workspaces, and the verb is
         * load-bearing: the rename and the reveal both need the new group's id, and the id only
         * exists in a reply. `group-create` is fire-and-forget (wire-protocol.md §7) and its ack
         * carries nothing — which is exactly how this path used to create a group and then do
         * neither. The assertion on the wire frame is what keeps it from regressing back.
         */
        it('from ⌘⇧G, which mints the placeholder name and never opens a form', async () => {
            const h = setup();
            act(() => {
                fireEvent.keyDown(window, { code: 'KeyG', key: 'G', metaKey: true, shiftKey: true });
            });
            expect(h.lastCommand('create-group-for-workspaces')).toMatchObject({
                command: 'create-group-for-workspaces',
                name: 'New Group',
                workspace_ids: []
            });
            expect(h.lastCommand('group-create')).toBeUndefined();
            answer(h);
            await waitFor(() => {
                expect(screen.getByLabelText('Rename New Group')).toBeTruthy();
            });
            expect(revealedHeader()).toBe(true);
        });

        /**
         * §WS-004's chevron menu — the third route, and the one that used to disagree with the
         * other two. The Swift footer's menu runs the same `createGroup(name:autoRename:)` the
         * chord and the File row do (`WorkspaceListView.swift:414-417`); the port's footer used
         * to open the New Group FORM instead, which is a different contract (a name up front, a
         * blank one refused, no reveal). Asserted at the wire, beside ⌘⇧G's own frame, so the
         * two cannot drift apart again.
         */
        it('from the footer chevron menu ▸ New Group, identically to ⌘⇧G', async () => {
            const h = setup();
            fireEvent.click(screen.getByTestId('sidebar-new-menu-toggle'));
            fireEvent.click(within(screen.getByTestId('context-menu')).getByText('New Group'));
            expect(h.lastCommand('create-group-for-workspaces')).toMatchObject({
                command: 'create-group-for-workspaces',
                name: 'New Group',
                workspace_ids: []
            });
            expect(h.lastCommand('group-create')).toBeUndefined();
            // Not the form: that is the divergence this menu closed.
            expect(screen.queryByTestId('new-group-form')).toBeNull();
            answer(h);
            await waitFor(() => {
                expect(screen.getByLabelText('Rename New Group')).toBeTruthy();
            });
            expect(revealedHeader()).toBe(true);
        });

        /**
         * …and the FOURTH route, which was the last one still disagreeing: the sidebar
         * background's own context menu. `WorkspaceListView.swift:347-350` makes the identical
         * `createGroup(name: placeholder, autoRename: true)` call the chevron does, so once the
         * New Workspace form became a modal sheet this was the only remaining place in the
         * client where a group was created by filling in a form. Asserted at the wire beside the
         * other three, for the same reason: four routes onto one contract, or they drift.
         */
        it('from the sidebar background menu ▸ New Group, identically to ⌘⇧G', async () => {
            const h = setup();
            fireEvent.contextMenu(screen.getByTestId('sidebar-spacer'));
            fireEvent.click(within(screen.getByTestId('context-menu')).getByText('New Group'));
            expect(h.lastCommand('create-group-for-workspaces')).toMatchObject({
                command: 'create-group-for-workspaces',
                name: 'New Group',
                workspace_ids: []
            });
            expect(h.lastCommand('group-create')).toBeUndefined();
            expect(screen.queryByTestId('new-group-sheet')).toBeNull();
            answer(h);
            await waitFor(() => {
                expect(screen.getByLabelText('Rename New Group')).toBeTruthy();
            });
            expect(revealedHeader()).toBe(true);
        });
    });
});

describe('the row delete’s active-agents gate (§WS-054 / §WS-108)', () => {
    it('names the running agent before deleting a busy workspace', async () => {
        const h = setup();
        fireEvent.contextMenu(row('beta'));
        fireEvent.click(screen.getByText('Delete'));

        const dialog = screen.getByTestId('confirm-dialog');
        expect(dialog.getAttribute('data-active-agents')).toBe('1');
        expect(dialog.textContent).toContain('This workspace has 1 active agent');
        // Nothing has gone out yet: the gate is a gate, not a notice.
        expect(h.lastCommand('workspace-delete')).toBeUndefined();

        fireEvent.click(within(dialog).getByText('Delete'));
        await waitFor(() => {
            expect(h.lastCommand('workspace-delete')).toMatchObject({
                command: 'workspace-delete',
                name: W2,
                // The sidebar's own gate has already asked; the wire guard would ask twice.
                force: true
            });
        });
    });

    it('shows the plain confirmation for an idle workspace', () => {
        setup();
        fireEvent.contextMenu(row('alpha'));
        fireEvent.click(screen.getByText('Delete'));
        const dialog = screen.getByTestId('confirm-dialog');
        expect(dialog.getAttribute('data-active-agents')).toBe('0');
        expect(dialog.textContent).not.toContain('active agent');
    });

    /**
     * §WS-110 — the flag is ONE value, and the daemon's broadcast is the only thing that moves
     * it.
     *
     * The Swift shares it through a `UserDefaults` key plus a change notification, so the alert
     * and the Settings toggle can never disagree. The port's equivalent is the daemon's
     * `confirm-workspace-delete` config key plus the `settings-changed` broadcast — and this is
     * the half no component test can see: nothing is written locally here and no gesture is made
     * in Settings, yet the gate in front of a workspace with a running agent changes shape,
     * because a broadcast arrived from outside this client (another window's toggle, a
     * hand-edited config file, `kelpi` writing the file).
     */
    it('follows the daemon’s `settings-changed` broadcast, with no local write (§WS-110)', () => {
        const h = setup();
        const broadcast = (confirm: boolean): void => {
            act(() => {
                h.socket().emit({
                    type: 'settings-changed',
                    settings: { general: { confirmWorkspaceDeleteWhenActive: confirm } }
                });
            });
        };
        const openDelete = (): HTMLElement => {
            fireEvent.contextMenu(row('beta'));
            fireEvent.click(screen.getByText('Delete'));
            return screen.getByTestId('confirm-dialog');
        };

        // Off: beta still has its running agent, but the dialog is the plain one — no count, no
        // suppression checkbox. The setting is the only thing that changed.
        broadcast(false);
        const suppressed = openDelete();
        expect(suppressed.getAttribute('data-active-agents')).toBe('0');
        expect(suppressed.textContent).not.toContain('active agent');
        expect(within(suppressed).queryByTestId('confirm-suppress')).toBeNull();
        fireEvent.click(within(suppressed).getByTestId('confirm-cancel'));

        // …and back on, through the same one path: the alert returns with its count.
        broadcast(true);
        const restored = openDelete();
        expect(restored.getAttribute('data-active-agents')).toBe('1');
        expect(restored.textContent).toContain('This workspace has 1 active agent');
        expect(within(restored).getByTestId('confirm-suppress')).toBeTruthy();
        fireEvent.click(within(restored).getByTestId('confirm-cancel'));

        // No client-side write took part in any of it: the value only ever came from the daemon.
        expect(h.commands().some((payload) => payload['command'] === 'set-general-setting')).toBe(false);
    });

    it('“Don’t ask again” writes the shared `confirm-workspace-delete` setting (§WS-110)', async () => {
        const h = setup();
        fireEvent.contextMenu(row('beta'));
        fireEvent.click(screen.getByText('Delete'));
        const dialog = screen.getByTestId('confirm-dialog');
        fireEvent.click(within(dialog).getByTestId('confirm-suppress'));
        fireEvent.click(within(dialog).getByText('Delete'));

        await waitFor(() => {
            expect(h.commands().some((payload) => payload['command'] === 'set-general-setting')).toBe(true);
        });
        expect(
            h
                .commands()
                .filter((payload) => payload['command'] === 'set-general-setting')
                .at(-1)
        ).toMatchObject({ key: 'confirm-workspace-delete', value: 'false' });
    });
});

describe('the bulk-delete confirmation (§WS-062 / §WS-060)', () => {
    it('raises ONE dialog for the selection and then deletes every row in it', async () => {
        const h = setup();
        // ⌘-click builds the selection; alpha + beta, leaving gamma so the guard is not tripped.
        fireEvent.click(row('alpha'), { metaKey: true });
        fireEvent.click(row('beta'), { metaKey: true });

        fireEvent.contextMenu(row('alpha'));
        fireEvent.click(screen.getByText('Delete 2 Workspaces…'));

        const dialogs = screen.getAllByTestId('confirm-dialog');
        expect(dialogs.length).toBe(1);
        expect(dialogs[0]?.textContent).toContain('Delete 2 workspaces?');
        expect(dialogs[0]?.textContent).toContain('This cannot be undone.');
        expect(h.lastCommand('workspace-delete')).toBeUndefined();

        fireEvent.click(within(dialogs[0] as HTMLElement).getByText('Delete'));
        await waitFor(() => {
            expect(
                h.commands().filter((payload) => payload['command'] === 'workspace-delete').length
            ).toBe(2);
        });
        expect(
            h
                .commands()
                .filter((payload) => payload['command'] === 'workspace-delete')
                .map((payload) => payload['name'])
        ).toEqual([W1, W2]);
        // And the prompt is gone rather than left standing over an already-deleted selection.
        expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    });

    it('refuses a selection that is every workspace (§WS-060’s guard)', () => {
        setup();
        fireEvent.click(row('alpha'), { metaKey: true });
        fireEvent.click(row('beta'), { metaKey: true });
        fireEvent.click(row('gamma'), { metaKey: true });
        fireEvent.contextMenu(row('alpha'));
        const item = screen.getByText('Delete 3 Workspaces…').closest('[data-menu-item]') as HTMLElement;
        expect(item.getAttribute('aria-disabled')).toBe('true');
    });
});
