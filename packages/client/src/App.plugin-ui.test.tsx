import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { decodePluginManifest, type JsonObject, type PluginInfo } from '@kelpi/protocol';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { SHELL_CLOSE_GLOBAL } from './app/shell-close';
import { modalPresenceCount } from './chrome/modal-presence';
import { completeHandshake, createFakeSocketFactory } from './connection';
import type { PluginViewProps } from './plugins/PluginView';
import type { UIServiceScope } from './plugins/ui-services';
import { createKelpiRuntime, createKelpiStore } from './state';
import { createFakeRendererFactory } from './terminal/testing';

// Keep the App-owned model, workbench context, prompt host, and dispatchers real. The
// view substitutes only for jsdom's non-executing srcdoc/MessagePort boundary.
const bridge = vi.hoisted(() => ({ scope: null as UIServiceScope | null }));
vi.mock('./plugins/PluginView', async () => {
    const { useContext, useEffect, createElement } = await import('react');
    const { PluginHostUIContext } = await import('./plugins/host-ui');
    return { PluginView(props: PluginViewProps) {
        const host = useContext(PluginHostUIContext);
        useEffect(() => {
            if (host?.runtime !== props.runtime || !host.services) return;
            const scope = host.services.createScope({ id: 'test-view-lease', pluginID: props.pluginID, pluginName: 'Prompt example' });
            bridge.scope = scope;
            return () => { scope.dispose(); if (bridge.scope === scope) bridge.scope = null; };
        }, [host?.runtime, host?.services, props.runtime, props.pluginID]);
        return createElement('div', { 'data-testid': 'test-plugin-view', 'data-pane-surface': props.paneID }, 'Plugin view');
    } };
});

const WORKSPACE = 'AAAAAAAA-0000-4000-8000-000000000001';
const TERMINAL = 'DDDDDDDD-0000-4000-8000-000000000001';
const PLUGIN_PANE = 'DDDDDDDD-0000-4000-8000-000000000002';
const plugin: PluginInfo = { manifest: decodePluginManifest({ id: 'sample.prompt', name: 'Prompt example', version: '1.0.0', apiVersion: 1,
    trust: 'full', backend: 'backend.mjs', contributes: {
        views: [{ id: 'sample.prompt.view', title: 'Prompt example', entry: 'ui/index.html', placements: ['pane'] }],
        commands: [{ id: 'sample.prompt.run', title: 'Run prompt example', shortcut: 'ctrl+alt+b' }]
    } }), enabled: true, status: 'running', instanceID: 'i1', revision: 'r1', error: null };

function setup() {
    // Favicon painting is unrelated to prompt ownership and jsdom has no canvas backend.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const daemon = createDaemonStore(emptyDaemonState('/Users/test'));
    daemon.dispatch({ type: 'create-workspace', id: WORKSPACE, paneID: TERMINAL, name: 'Prompt tests', color: 'blue', now: 1 });
    daemon.dispatch({ type: 'create-plugin-pane', workspaceID: WORKSPACE, paneID: PLUGIN_PANE, title: 'Prompt example', now: 2,
        plugin: { pluginID: 'sample.prompt', viewID: 'sample.prompt.view', state: {}, stateVersion: 1 } });
    daemon.dispatch({ type: 'focus-pane', workspaceID: WORKSPACE, paneID: TERMINAL });
    const sockets = createFakeSocketFactory();
    const runtime = createKelpiRuntime({ store: createKelpiStore(), url: 'ws://prompt.test/ws', socketFactory: sockets.factory,
        notifications: null, tokenStorage: null, heartbeatIntervalMs: 0 });
    const request = vi.spyOn(runtime.commands, 'raw').mockImplementation(async payload => {
        if (payload['command'] !== 'plugin') return { ok: true };
        if (payload['action'] === 'list') return { ok: true, result: [plugin] as never };
        if (payload['action'] === 'identity') return { ok: true, result: { daemonID: 'prompt-test-daemon' } };
        if (payload['action'] === 'contributions' || payload['action'] === 'services') return { ok: true, result: [] };
        return { ok: true, result: null };
    });
    render(<App runtime={runtime} createRenderer={createFakeRendererFactory().factory} />);
    act(() => completeHandshake(sockets.last(), { state: daemon.getState() as unknown as JsonObject }));
    const commands = (command: string) => request.mock.calls.filter(([payload]) => payload['command'] === command);
    const pluginRuns = () => request.mock.calls.filter(([payload]) => payload['command'] === 'plugin' && payload['action'] === 'run');
    const menu = (command: string) => act(() => sockets.last().emit({ type: 'menu-command', command }));
    return { runtime, request, commands, pluginRuns, menu };
}

afterEach(() => { cleanup(); bridge.scope = null; localStorage.clear(); vi.restoreAllMocks(); });

describe('App ownership of plugin prompts', () => {
    it('queues a view prompt behind Settings, then shows and focuses it after Settings closes', async () => {
        const h = setup();
        try {
            await waitFor(() => expect(bridge.scope).not.toBeNull());
            fireEvent.keyDown(window, { code: 'Comma', key: ',', metaKey: true });
            expect(screen.getByTestId('settings-close')).toBeTruthy();
            expect(modalPresenceCount()).toBeGreaterThan(0);
            let result!: Promise<unknown>;
            act(() => { result = bridge.scope!.request('ui.showInput', { title: 'Queued plugin prompt', value: 'initial' }); });
            expect(screen.queryByRole('dialog', { name: 'Queued plugin prompt' })).toBeNull();
            expect(screen.getByTestId('plugin-ui-backdrop').hidden).toBe(true);
            expect(screen.getByTestId('settings-close')).toBeTruthy();

            fireEvent.click(screen.getByTestId('settings-close'));
            const field = await screen.findByRole('textbox', { name: 'Queued plugin prompt' });
            expect(screen.getByRole('dialog', { name: 'Queued plugin prompt' })).toBeTruthy();
            expect(screen.getByTestId('plugin-ui-backdrop').hidden).toBe(false);
            expect(document.activeElement).toBe(field);
            expect(modalPresenceCount()).toBe(1);
            fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
            await expect(result).resolves.toBeNull();
            expect(modalPresenceCount()).toBe(0);
            expect(screen.getByTestId(`pane-${TERMINAL}`)).toBeTruthy();
            expect(screen.getByTestId(`pane-${PLUGIN_PANE}`)).toBeTruthy();
        } finally { cleanup(); h.runtime.dispose(); }
    });

    it('blocks native/plugin shortcuts and menu relays; Cmd+W cancels only the prompt and consumes shell fallback', async () => {
        const h = setup();
        try {
            await waitFor(() => expect(bridge.scope).not.toBeNull());
            // Positive controls: these exact dispatch paths work before the prompt owns input.
            fireEvent.keyDown(window, { code: 'KeyD', key: 'd', metaKey: true });
            await waitFor(() => expect(h.commands('pane-split')).toHaveLength(1));
            fireEvent.keyDown(window, { code: 'KeyB', key: 'b', ctrlKey: true, altKey: true });
            await waitFor(() => expect(h.pluginRuns()).toHaveLength(1));

            let result!: Promise<unknown>;
            act(() => { result = bridge.scope!.request('ui.showInput', { title: 'Plugin owns input' }); });
            const field = screen.getByRole('textbox', { name: 'Plugin owns input' });
            fireEvent.keyDown(field, { code: 'KeyD', key: 'd', metaKey: true });
            fireEvent.keyDown(field, { code: 'KeyB', key: 'b', ctrlKey: true, altKey: true });
            h.menu('web-chord:KeyD');
            h.menu('web-chord:KeyB:ctrl:alt');
            h.menu('new-workspace');
            h.menu('help');
            h.menu('settings');
            expect(h.commands('pane-split')).toHaveLength(1);
            expect(h.pluginRuns()).toHaveLength(1);
            expect(screen.queryByTestId('new-workspace-sheet')).toBeNull();
            expect(screen.queryByTestId('settings-close')).toBeNull();
            expect(screen.queryByTestId('help-overlay')).toBeNull();
            expect(screen.getByRole('dialog', { name: 'Plugin owns input' })).toBeTruthy();

            expect(fireEvent.keyDown(field, { code: 'KeyW', key: 'w', metaKey: true })).toBe(false);
            await expect(result).resolves.toBeNull();
            expect(screen.queryByRole('dialog', { name: 'Plugin owns input' })).toBeNull();
            expect(h.commands('pane-close')).toHaveLength(0);
            expect(h.commands('workspace-delete')).toHaveLength(0);
            // Electron closes the window only if this assembly-owned bridge answers false.
            const close = (globalThis as unknown as Record<string, unknown>)[SHELL_CLOSE_GLOBAL] as () => boolean;
            expect(close()).toBe(true);
            expect(h.commands('pane-close')).toHaveLength(0);
            expect(screen.getByTestId(`pane-${TERMINAL}`)).toBeTruthy();
            expect(screen.getByTestId(`pane-${PLUGIN_PANE}`)).toBeTruthy();

            fireEvent.keyDown(window, { code: 'KeyD', key: 'd', metaKey: true });
            fireEvent.keyDown(window, { code: 'KeyB', key: 'b', ctrlKey: true, altKey: true });
            await waitFor(() => { expect(h.commands('pane-split')).toHaveLength(2); expect(h.pluginRuns()).toHaveLength(2); });
            h.menu('new-workspace');
            expect(screen.getByTestId('new-workspace-sheet')).toBeTruthy();
            fireEvent.click(screen.getByTestId('new-workspace-cancel'));
        } finally { cleanup(); h.runtime.dispose(); }
    });
});
