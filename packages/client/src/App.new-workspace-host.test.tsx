/**
 * Issue #201: File ▸ New Workspace and ⌘N while a PLUGIN view occupies the Workspaces sidebar.
 *
 * `act.newWorkspace()` posts one `sidebarCreateRequest`, and the native `Sidebar` used to be its
 * only consumer. With a plugin view selected for `sidebar.primary` the sidebar is not mounted, so
 * the request was dropped: no sheet, no error, the caret where it was. Every route that raises the
 * sheet (the menu row, ⌘N, the palette's New Workspace row, the empty state's Create button) is
 * that one request, so all four went quiet together.
 *
 * The sheet is a window modal (`ContentView.swift:289-294`), so it is hosted at window level for
 * exactly the case the sidebar cannot cover, and nowhere else: with the bundled view drawing the
 * slot the sidebar keeps rendering its own, and there is still exactly ONE sheet on screen.
 *
 * The harness is `App.plugin-ui.test.tsx`'s: the whole client, its real workbench and its real
 * Settings window against a scripted daemon, with only the plugin's srcdoc iframe substituted.
 */

import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { decodePluginManifest, type JsonObject, type PluginInfo } from '@kelpi/protocol';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { completeHandshake, createFakeSocketFactory } from './connection';
import { createKelpiRuntime, createKelpiStore } from './state';
import { createFakeRendererFactory } from './terminal/testing';

vi.mock('./plugins/PluginView', async () => {
    const { createElement } = await import('react');
    return { PluginView: (props: { viewID: string }) =>
        createElement('div', { 'data-testid': 'plugin-sidebar-view' }, props.viewID) };
});

const WORKSPACE = 'AAAAAAAA-0000-4000-8000-000000000001';
const CREATED = 'AAAAAAAA-0000-4000-8000-000000000002';
const PANE = 'DDDDDDDD-0000-4000-8000-000000000001';
const CREATED_PANE = 'DDDDDDDD-0000-4000-8000-000000000002';
const VIEW = 'sample.board.view';
const LAYOUT = 'sample.board.layout';
const WRAPPED_SLOT = 'sample.board.main';

/**
 * The plugin in the issue's repro, plus the harder shape beside it: a CONTAINER that wraps the
 * bundled Workspaces view in one of its slots. A wrapped sidebar is still a mounted sidebar, so
 * the container case must stay the sidebar's to host (`features/registration.test.tsx` is where
 * the wrapping itself is pinned; what matters here is that the host stands down for it).
 */
const plugin: PluginInfo = {
    manifest: decodePluginManifest({ id: 'sample.board', name: 'Agent board', version: '1.0.0', apiVersion: 1, trust: 'full',
        contributes: {
            containers: [{ id: LAYOUT, title: 'Wrapped Workspaces', placements: ['sidebar.primary', 'sidebar.secondary'], layout: 'column', slots: [
                { id: WRAPPED_SLOT, title: 'Main', defaultView: 'kelpi.workspaces' },
                { id: 'sample.board.detail', title: 'Details', defaultView: VIEW }
            ] }],
            views: [{ id: VIEW, title: 'Agent board', entry: 'ui/index.html', placements: ['sidebar.primary', 'sidebar.secondary', 'sample.board.detail'] }]
        } }),
    enabled: true, status: 'running', instanceID: 'i1', revision: 'r1', error: null
};

function setup(options: { readonly workspaces?: boolean } = {}) {
    // Favicon painting is unrelated here and jsdom has no canvas backend.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const daemon = createDaemonStore(emptyDaemonState('/Users/test'));
    // `workspaces: false` is §APP-067's state: every workspace deleted, so the detail area is the
    // empty state and the key dispatcher has no active workspace to run a chord against.
    if (options.workspaces !== false) daemon.dispatch({ type: 'create-workspace', id: WORKSPACE, paneID: PANE, name: 'alpha', color: 'blue', now: 1 });
    const sockets = createFakeSocketFactory();
    const runtime = createKelpiRuntime({ store: createKelpiStore(), url: 'ws://sidebar.test/ws', socketFactory: sockets.factory,
        notifications: null, tokenStorage: null, heartbeatIntervalMs: 0 });
    const request = vi.spyOn(runtime.commands, 'raw').mockImplementation(async payload => {
        // The daemon names the workspace it created; §WS-123's activation rides the reply.
        if (payload['command'] === 'workspace-create') return { ok: true, workspace_id: CREATED, workspace_name: String(payload['name'] ?? '') } as never;
        if (payload['command'] !== 'plugin') return { ok: true };
        if (payload['action'] === 'list') return { ok: true, result: [plugin] as never };
        if (payload['action'] === 'identity') return { ok: true, result: { daemonID: 'sidebar-host-daemon' } };
        if (payload['action'] === 'contributions' || payload['action'] === 'services') return { ok: true, result: [] };
        return { ok: true, result: null };
    });
    render(<App runtime={runtime} createRenderer={createFakeRendererFactory().factory} />);
    act(() => completeHandshake(sockets.last(), { state: daemon.getState() as unknown as JsonObject }));
    return {
        runtime, daemon,
        creates: () => request.mock.calls.filter(([payload]) => payload['command'] === 'workspace-create').map(([payload]) => payload),
        menu: (command: string) => { act(() => { sockets.last().emit({ type: 'menu-command', command }); }); },
        /** A fresh mirror, the way the daemon pushes one after a create. */
        push: () => { act(() => { sockets.last().emit({ type: 'snapshot', seq: 1, state: daemon.getState() as unknown as JsonObject }); }); },
        sheets: () => screen.queryAllByTestId('new-workspace-form')
    };
}

/** Settings ▸ Plugins ▸ the placement selects, the route the issue's repro takes by hand. */
async function chooseViews(...picks: readonly (readonly [slot: string, viewID: string])[]): Promise<void> {
    fireEvent.keyDown(window, { code: 'Comma', key: ',', metaKey: true });
    fireEvent.click(await screen.findByTestId('settings-tab-button-plugins'));
    for (const [slot, viewID] of picks) {
        const select = await screen.findByLabelText(slot);
        act(() => { fireEvent.change(select, { target: { value: viewID } }); });
    }
    fireEvent.click(screen.getByTestId('settings-close'));
    await waitFor(() => { expect(screen.queryByTestId('settings-close')).toBeNull(); });
}

const chooseSidebarView = (viewID: string): Promise<void> => chooseViews(['sidebar.primary', viewID]);

/** Rows drawn by the native `Sidebar`, wherever it happens to be mounted. */
const rows = (): HTMLElement[] => screen.queryAllByTestId('workspace-row');

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

describe('the New Workspace sheet, whatever occupies the sidebar (issue #201)', () => {
    it('draws the sheet for the menu row and for ⌘N while a plugin view replaces Workspaces', async () => {
        const h = setup();
        await chooseSidebarView(VIEW);
        // The premise: the plugin is drawing the slot, so the native sidebar is not mounted.
        await waitFor(() => { expect(screen.getByTestId('plugin-sidebar-view')).toBeTruthy(); });
        expect(screen.queryAllByTestId('workspace-row')).toHaveLength(0);

        h.menu('new-workspace');
        await waitFor(() => { expect(h.sheets()).toHaveLength(1); });
        expect(screen.getByLabelText('New workspace name')).toBeTruthy();

        // Escape still closes it: the sheet takes the key on the window, in capture.
        fireEvent.keyDown(window, { key: 'Escape' });
        await waitFor(() => { expect(h.sheets()).toHaveLength(0); });

        fireEvent.keyDown(window, { code: 'KeyN', key: 'n', metaKey: true });
        await waitFor(() => { expect(h.sheets()).toHaveLength(1); });
        // Twice in a row: the request is one-shot, so the second press re-opens rather than
        // being swallowed as a no-change prop.
        fireEvent.keyDown(window, { key: 'Escape' });
        await waitFor(() => { expect(h.sheets()).toHaveLength(0); });
        fireEvent.keyDown(window, { code: 'KeyN', key: 'n', metaKey: true });
        await waitFor(() => { expect(h.sheets()).toHaveLength(1); });
    });

    it('creates what the sheet collected, and the row is there when Workspaces comes back', async () => {
        const h = setup();
        await chooseSidebarView(VIEW);
        await waitFor(() => { expect(screen.getByTestId('plugin-sidebar-view')).toBeTruthy(); });

        h.menu('new-workspace');
        const form = await screen.findByTestId('new-workspace-form');
        fireEvent.change(screen.getByLabelText('New workspace name'), { target: { value: 'built' } });
        fireEvent.submit(form);

        await waitFor(() => { expect(h.creates()).toHaveLength(1); });
        expect(h.creates()[0]).toMatchObject({ command: 'workspace-create', name: 'built' });
        // The sheet closes on the create, and the client follows the workspace it made.
        await waitFor(() => { expect(h.sheets()).toHaveLength(0); });
        expect(h.runtime.store.getState().ui.activeWorkspaceID).toBe(CREATED);

        h.daemon.dispatch({ type: 'create-workspace', id: CREATED, paneID: CREATED_PANE, name: 'built', color: 'green', now: 2 });
        h.push();
        await chooseSidebarView('kelpi.workspaces');
        await waitFor(() => {
            expect(rows().map(row => row.getAttribute('data-workspace-id'))).toContain(CREATED);
        });
    });

    it('leaves the bundled sidebar to draw its own sheet: one, not two', async () => {
        const h = setup();
        // No selection at all: `kelpi.workspaces` is the sidebar, as it ships.
        await waitFor(() => { expect(rows().length).toBeGreaterThan(0); });

        h.menu('new-workspace');
        await waitFor(() => { expect(h.sheets()).toHaveLength(1); });
        fireEvent.keyDown(window, { key: 'Escape' });
        await waitFor(() => { expect(h.sheets()).toHaveLength(0); });

        fireEvent.keyDown(window, { code: 'KeyN', key: 'n', metaKey: true });
        await waitFor(() => { expect(h.sheets()).toHaveLength(1); });
    });

    /**
     * The case a selection test alone would get wrong: `sidebar.primary` names a PLUGIN, and the
     * bundled sidebar is mounted all the same, inside that plugin's container. The host's branch
     * is the composition walk rather than "is the selection a plugin?", so it stands down here.
     */
    it('stands down for a plugin container that wraps the bundled sidebar', async () => {
        const h = setup();
        await chooseSidebarView(LAYOUT);
        const wrapper = await waitFor(() => {
            const found = document.querySelector(`[data-workbench-container="${LAYOUT}"]`);
            expect(found).not.toBeNull();
            return found as HTMLElement;
        });
        // The premise: the container is drawing, and the native sidebar is drawing INSIDE it.
        expect(screen.getByTestId('plugin-sidebar-view')).toBeTruthy();
        expect(wrapper.querySelectorAll('[data-testid="workspace-row"]').length).toBeGreaterThan(0);

        h.menu('new-workspace');
        await waitFor(() => { expect(h.sheets()).toHaveLength(1); });

        /*
         * And the one sheet standing is the SIDEBAR's, not a second copy from the host: emptying
         * the container's slot unmounts the native sidebar and takes its sheet with it. A
         * host-owned sheet would still be up, because the host outlives the slot.
         */
        act(() => { fireEvent.change(screen.getByLabelText('Main view'), { target: { value: '' } }); });
        await waitFor(() => { expect(rows()).toHaveLength(0); });
        expect(h.sheets()).toHaveLength(0);
    });

    /**
     * §WS-001's swap: Workspaces moves to `sidebar.secondary` and the plugin takes the primary
     * slot. The host is keyed on the placement the BUNDLED view occupies, not on a fixed side, so
     * a swapped window is still the sidebar's to host.
     */
    it('stands down when the bundled sidebar has swapped to the other placement', async () => {
        const h = setup();
        await chooseViews(['sidebar.secondary', 'kelpi.workspaces'], ['sidebar.primary', VIEW]);
        await waitFor(() => { expect(screen.getByTestId('sidebar-slot').dataset['sidebarSide']).toBe('right'); });
        // The native sidebar is still mounted, at the placement it swapped to.
        expect(rows().length).toBeGreaterThan(0);

        h.menu('new-workspace');
        await waitFor(() => { expect(h.sheets()).toHaveLength(1); });
        fireEvent.keyDown(window, { key: 'Escape' });
        await waitFor(() => { expect(h.sheets()).toHaveLength(0); });

        fireEvent.keyDown(window, { code: 'KeyN', key: 'n', metaKey: true });
        await waitFor(() => { expect(h.sheets()).toHaveLength(1); });
    });

    /**
     * §APP-067's empty state, with a plugin in the sidebar: the dead end the button exists to
     * prevent, in the one configuration where the request had no consumer at all.
     *
     * ⌘N is declined here before any binding is consulted: `createKeyDispatcher`'s
     * `hasActiveWorkspace` gate stands down the whole keymap while no workspace is active
     * (`chrome/keys.ts`), which is why the Swift put a BUTTON in this state. So the button is the
     * route that has to work, and with a plugin drawing the sidebar it is this host that answers.
     */
    it('draws the sheet from the empty state’s button, the route ⌘N cannot be', async () => {
        const h = setup({ workspaces: false });
        await chooseSidebarView(VIEW);
        await waitFor(() => { expect(screen.getByTestId('plugin-sidebar-view')).toBeTruthy(); });
        expect(screen.getByTestId('no-workspace-empty')).toBeTruthy();
        expect(rows()).toHaveLength(0);

        fireEvent.keyDown(window, { code: 'KeyN', key: 'n', metaKey: true });
        await waitFor(() => { expect(screen.getByTestId('no-workspace-create')).toBeTruthy(); });
        expect(h.sheets()).toHaveLength(0);

        fireEvent.click(screen.getByTestId('no-workspace-create'));
        await waitFor(() => { expect(h.sheets()).toHaveLength(1); });
        expect(screen.getByLabelText('New workspace name')).toBeTruthy();
        // Still the sheet, not a bare create: §APP-018 is a form, not a command.
        expect(h.creates()).toHaveLength(0);
    });
});
