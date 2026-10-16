import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { decodePluginManifest, type PluginContributionInfo, type PluginInfo } from '@kelpi/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { completeHandshake, createFakeSocketFactory } from '../connection/testing';
import { createKelpiRuntime, createKelpiStore } from '../state';
import { usePluginCommands } from './commands';

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); window.history.replaceState(null, '', '/'); });

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
        sockets.last().emit({ type: 'plugin-event', event: { epoch: 'actions', sequence: current.sequence, name: 'plugin.contributions.changed', pluginID: current.pluginID, data: current } });
    };
    runtime.connect(); completeHandshake(sockets.last(), { state: JSON.parse(JSON.stringify(daemon.getState())) });
    runtime.activateWorkspace('one');
    try {
        const hook = renderHook(() => usePluginCommands(runtime, []));
        await waitFor(() => expect(hook.result.current.chords).toEqual(['3/KeyB']));
        const menu = hook.result.current.menu('pane', 'pane-two')[0]!;
        const runItem = hook.result.current.runItem;
        expect(menu.enabled).toBe(true);
        const sent = () => JSON.parse(String(calls.mock.lastCall![0]['text']));
        expect(menu.run()).toBe(true);
        expect(sent()).toMatchObject({ command: 'sample.actions.run', workspaceID: 'two', paneID: 'pane-two' });
        expect(sent()).not.toHaveProperty('windowID');
        // Inside a shell window the run names it, since a renderer's connection declares none (#389).
        window.history.replaceState(null, '', '/?shellWindow=WIN');
        expect(menu.run()).toBe(true);
        expect(sent()).toEqual({ command: 'sample.actions.run', windowID: 'WIN', workspaceID: 'two', paneID: 'pane-two' });
        window.history.replaceState(null, '', '/');
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

// #245: plugin command shortcuts are matched by the same key identity as the binding map (the
// window listener reads `chordKey`), so a plugin's ⌃⇧- runs from the key that types `_` on a
// German layout (physically Slash), and not from the physical `-` key, which types `?` there.
it('matches a plugin shortcut with the binding map’s key identity', async () => {
    const manifest = decodePluginManifest({ id: 'sample.layout', version: '1.0.0', apiVersion: 1, trust: 'full', backend: 'backend.mjs', contributes: {
        commands: [{ id: 'sample.layout.run', title: 'Run', shortcut: 'ctrl+shift+-' }]
    } });
    const plugin: PluginInfo = { manifest, enabled: true, revision: 'r1', instanceID: 'i1', status: 'running', error: null };
    const sockets = createFakeSocketFactory();
    const runtime = createKelpiRuntime({ store: createKelpiStore(), url: 'ws://layout.test/ws', socketFactory: sockets.factory, notifications: null });
    const daemon = createDaemonStore(emptyDaemonState('/tmp'));
    daemon.dispatch({ type: 'create-workspace', id: 'one', paneID: 'pane-one', name: 'one', color: 'blue', now: 1 });
    const calls = vi.spyOn(runtime.commands, 'raw').mockImplementation(async payload => ({ ok: true, result: (
        payload['action'] === 'list' ? [plugin] : payload['action'] === 'identity' ? { daemonID: 'layout' } : payload['action'] === 'contributions' ? [] : null
    ) as never }));
    runtime.connect(); completeHandshake(sockets.last(), { state: JSON.parse(JSON.stringify(daemon.getState())) });
    runtime.activateWorkspace('one');
    try {
        const hook = renderHook(() => usePluginCommands(runtime, []));
        await waitFor(() => expect(hook.result.current.chords).toEqual(['5/Minus', '5/NumpadSubtract']));
        calls.mockClear();
        // German: `_` (⇧-) is typed on the Slash key. Matched as the US ⇧- keystroke.
        const german = new KeyboardEvent('keydown', { code: 'Slash', key: '_', ctrlKey: true, shiftKey: true, cancelable: true });
        act(() => { window.dispatchEvent(german); });
        expect(german.defaultPrevented).toBe(true);
        // The physical ⌃⇧/ on the same keyboard types `?`, a different key, and does not run it.
        const slash = new KeyboardEvent('keydown', { code: 'Minus', key: '?', ctrlKey: true, shiftKey: true, cancelable: true });
        act(() => { window.dispatchEvent(slash); });
        expect(slash.defaultPrevented).toBe(false);
    } finally { cleanup(); runtime.dispose(); }
});
