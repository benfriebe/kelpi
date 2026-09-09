import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { decodePluginManifest, type PluginContributionInfo, type PluginInfo } from '@kelpi/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { completeHandshake, createFakeSocketFactory } from '../connection/testing';
import { createKelpiRuntime, createKelpiStore } from '../state';
import { usePluginCommands } from './commands';

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

it('rechecks stale menus, items and shortcuts synchronously and targets the explicit pane owner', async () => {
    const manifest = decodePluginManifest({ id: 'sample.actions', version: '1.0.0', apiVersion: 1, trust: 'full', backend: 'backend.mjs', contributes: {
        commands: [{ id: 'sample.actions.run', title: 'Run', shortcut: 'ctrl+alt+b', enablement: { 'context.ready': true } }, { id: 'sample.actions.plain', title: 'Plain' }],
        menus: [{ id: 'sample.actions.menu', command: 'sample.actions.run', placement: 'pane', when: { 'pane.exists': true }, enablement: { 'context.menu': true } }],
        items: [{ id: 'sample.actions.item', command: 'sample.actions.run', placement: 'pane.header', text: 'Run', enablement: { 'context.item': true } }]
    } });
    const plugin: PluginInfo = { manifest, enabled: true, revision: 'r1', instanceID: 'i1', status: 'running', error: null };
    const sockets = createFakeSocketFactory();
    const runtime = createKelpiRuntime({ store: createKelpiStore(), url: 'ws://actions.test/ws', socketFactory: sockets.factory, notifications: null });
    const daemon = createDaemonStore(emptyDaemonState('/tmp'));
    for (const id of ['one', 'two']) daemon.dispatch({ type: 'create-workspace', id, paneID: `pane-${id}`, name: id, color: 'blue', now: 1 });
    let current: PluginContributionInfo = { pluginID: manifest.id, instanceID: 'i1', sequence: 1, state: { context: { ready: true, menu: true, item: true }, items: {} } };
    const calls = vi.spyOn(runtime.commands, 'raw').mockImplementation(async payload => ({ ok: true, result: (
        payload['action'] === 'list' ? [plugin] : payload['action'] === 'identity' ? { daemonID: 'actions' } : payload['action'] === 'contributions' ? [current] : null
    ) as never }));
    const update = (patch: Record<string, boolean>) => {
        current = { ...current, sequence: current.sequence + 1, state: { ...current.state, context: { ...current.state.context, ...patch } } };
        sockets.last().emit({ type: 'plugin-event', event: { epoch: 'actions', sequence: current.sequence, name: 'plugin.contributions.changed', data: current } });
    };
    runtime.connect(); completeHandshake(sockets.last(), { state: JSON.parse(JSON.stringify(daemon.getState())) });
    runtime.activateWorkspace('one');
    try {
        const hook = renderHook(() => usePluginCommands(runtime, []));
        await waitFor(() => expect(hook.result.current.chords).toEqual(['3/KeyB']));
        const menu = hook.result.current.menu('pane', 'pane-two')[0]!;
        const runItem = hook.result.current.runItem;
        expect(menu.enabled).toBe(true);
        expect(menu.run()).toBe(true);
        expect(JSON.parse(String(calls.mock.lastCall![0]['text']))).toMatchObject({ command: 'sample.actions.run', workspaceID: 'two', paneID: 'pane-two' });
        calls.mockClear();
        act(() => {
            // Invoke retained callbacks before React has a chance to update the painted controls.
            update({ menu: false, item: false });
            expect(menu.run()).toBe(false);
            expect(runItem('pane.header', 'sample.actions.item', 'pane-two')).toBe(false);
            update({ ready: false });
            const key = new KeyboardEvent('keydown', { code: 'KeyB', ctrlKey: true, altKey: true, cancelable: true });
            window.dispatchEvent(key);
            expect(key.defaultPrevented).toBe(false);
        });
        expect(calls.mock.calls.some(([payload]) => payload['action'] === 'run')).toBe(false);
        await waitFor(() => expect(hook.result.current.chords).toEqual([]));
        act(() => update({ ready: true, menu: true, item: true }));
        expect(menu.run()).toBe(true);
        expect(runItem('pane.header', 'sample.actions.item', 'removed-pane')).toBe(false);
        const retainedPlain = hook.result.current.menu('palette').find(item => item.command === 'sample.actions.plain')!;
        calls.mockClear();
        act(() => {
            const replacement = { ...plugin, instanceID: 'i2', manifest: { ...manifest, contributes: { ...manifest.contributes,
                commands: manifest.contributes.commands.map(command => ({ ...command, enablement: { 'context.replacementReady': true } }))
            } } };
            sockets.last().emit({ type: 'plugins-changed', plugins: [replacement] });
            expect(retainedPlain.run()).toBe(false);
        });
        expect(calls.mock.calls.some(([payload]) => payload['action'] === 'run')).toBe(false);
    } finally { cleanup(); runtime.dispose(); }
});
