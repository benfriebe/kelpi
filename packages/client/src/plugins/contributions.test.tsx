import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { decodePluginManifest, type PluginContributionInfo, type PluginInfo } from '@kelpi/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandReply } from '../connection';
import { completeHandshake, createFakeSocketFactory } from '../connection/testing';
import { createKelpiRuntime, createKelpiStore } from '../state';
import {
    contributionContext, getPluginContributionState, matchesWhen, resolveContributionItems,
    resolveContributionMenus, usePluginContributions
} from './contributions';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const ID = 'sample.ui';
function info(sequence = 1, instanceID = 'i1', ready = true): PluginContributionInfo {
    return { pluginID: ID, instanceID, sequence, state: { context: { ready }, items: {} } };
}
const plugin: PluginInfo = { manifest: decodePluginManifest({ id: ID, version: '1.0.0', apiVersion: 1, trust: 'full', backend: 'backend.mjs', contributes: {
    commands: [
        { id: `${ID}.run`, title: 'Run', menu: 'both', when: { 'workspace.exists': true }, enablement: { 'context.ready': true } },
        { id: `${ID}.plain`, title: 'Plain command' }
    ],
    menus: [
        { id: `${ID}.pane-menu`, command: `${ID}.run`, placement: 'pane', group: 'checks', order: -1, when: { 'context.show': true }, enablement: { 'pane.hasAgent': true } },
        { id: `${ID}.palette-menu`, command: `${ID}.run`, placement: 'palette', when: { 'context.show': true } }
    ],
    items: [{ id: `${ID}.status`, placement: 'pane.header', text: 'Run checks', command: `${ID}.run`, when: { 'pane.exists': true }, enablement: { 'pane.focused': true } }]
} }), enabled: true, revision: 'r1', instanceID: 'i1', status: 'running', error: null };

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
function setup(initial: readonly PluginContributionInfo[] = [info()]) {
    const sockets = createFakeSocketFactory();
    const runtime = createKelpiRuntime({ store: createKelpiStore(), url: 'ws://daemon.test/ws', socketFactory: sockets.factory, notifications: null });
    const request = vi.spyOn(runtime.commands, 'raw').mockResolvedValue({ ok: true, result: initial as never });
    runtime.connect(); completeHandshake(sockets.last());
    const emit = (entry: PluginContributionInfo, epoch = 'epoch-one', owner: string | null = entry.pluginID) => sockets.last().emit({ type: 'plugin-event', event: { epoch, sequence: entry.sequence, name: 'plugin.contributions.changed', ...(owner === null ? {} : { pluginID: owner }), data: entry } });
    return { runtime, sockets, request, emit };
}

describe('shared plugin contribution state', () => {
    it('shares a request and current-state getter across hosts, then releases all subscriptions', async () => {
        const h = setup();
        try {
            const first = renderHook(() => usePluginContributions(h.runtime));
            const second = renderHook(() => usePluginContributions(h.runtime));
            await waitFor(() => expect(first.result.current.states.get(ID)?.sequence).toBe(1));
            expect(h.request).toHaveBeenCalledTimes(1);
            expect(first.result.current).toBe(second.result.current);
            await act(async () => {
                h.emit(info(2, 'i1', false));
                // Retained command callbacks can see the new state before React renders.
                expect(getPluginContributionState(h.runtime, ID, 'i1').context['ready']).toBe(false);
                h.emit(info(3, 'i1', true));
            });
            expect(first.result.current.states.get(ID)?.sequence).toBe(3);
            expect(first.result.current).toBe(second.result.current);
            first.unmount();
            act(() => h.emit(info(4, 'i1', false)));
            await waitFor(() => expect(second.result.current.states.get(ID)?.sequence).toBe(4));
            second.unmount();
            expect(getPluginContributionState(h.runtime, ID, 'i1').context).toEqual({});
            h.sockets.last().emit({ type: 'plugins-changed', plugins: [plugin], epoch: 'epoch-one' });
            expect(h.request).toHaveBeenCalledTimes(1);
        } finally { cleanup(); h.runtime.dispose(); }
    });

    it('keeps a newer same-instance event when an old snapshot finishes afterward', async () => {
        const h = setup(), old = deferred<CommandReply>();
        h.request.mockReturnValueOnce(old.promise);
        try {
            const hook = renderHook(() => usePluginContributions(h.runtime));
            act(() => h.emit(info(9, 'i1', false)));
            await act(async () => old.resolve({ ok: true, result: [info(1)] as never }));
            expect(hook.result.current.states.get(ID)?.sequence).toBe(9);
            expect(getPluginContributionState(h.runtime, ID, 'i1').context['ready']).toBe(false);
            act(() => h.emit(info(8)));
            expect(getPluginContributionState(h.runtime, ID, 'i1').context['ready']).toBe(false);
        } finally { cleanup(); h.runtime.dispose(); }
    });

    it.each(['plugin.contributions', null])('rejects a contribution event from envelope owner %s before it can poison state or sequence merging', async owner => {
        const h = setup([info(1, 'i1', false)]);
        try {
            const hook = renderHook(() => usePluginContributions(h.runtime));
            await waitFor(() => expect(hook.result.current.states.get(ID)?.sequence).toBe(1));
            await act(async () => h.sockets.last().emit({ type: 'plugins-changed', plugins: [plugin], epoch: 'epoch-one' }));
            act(() => h.emit(info(2, 'i1', false)));
            const reads = h.request.mock.calls.length;
            await act(async () => h.emit(info(100, 'i1', true), 'forged-epoch', owner));
            expect(getPluginContributionState(h.runtime, ID, 'i1').context['ready']).toBe(false);
            expect(hook.result.current.states.get(ID)?.sequence).toBe(2);
            expect(h.request).toHaveBeenCalledTimes(reads);
            await act(async () => h.sockets.last().emit({ type: 'plugins-changed', plugins: [plugin], epoch: 'epoch-one' }));
            expect(hook.result.current.states.get(ID)?.sequence).toBe(2);
            act(() => h.emit(info(3, 'i1', true)));
            expect(getPluginContributionState(h.runtime, ID, 'i1').context['ready']).toBe(true);
            expect(getPluginContributionState(h.runtime, ID, 'retired').context).toEqual({});
            await waitFor(() => expect(hook.result.current.states.get(ID)?.sequence).toBe(3));
        } finally { cleanup(); h.runtime.dispose(); }
    });

    it('retires old instances synchronously and rejects their snapshots and late events', async () => {
        const h = setup(), pending = deferred<CommandReply>();
        try {
            const hook = renderHook(() => usePluginContributions(h.runtime));
            await waitFor(() => expect(hook.result.current.states.size).toBe(1));
            h.request.mockReturnValue(pending.promise);
            act(() => h.sockets.last().emit({ type: 'plugins-changed', plugins: [{ ...plugin, instanceID: 'i2' }], epoch: 'epoch-one' }));
            expect(getPluginContributionState(h.runtime, ID, 'i1').context).toEqual({});
            act(() => { h.emit(info(2, 'i1')); h.emit(info(3, 'i2', false)); });
            await act(async () => pending.resolve({ ok: true, result: [info(2, 'i1')] as never }));
            expect(hook.result.current.states.get(ID)?.instanceID).toBe('i2');
            expect(getPluginContributionState(h.runtime, ID, 'i2').context['ready']).toBe(false);
            act(() => h.sockets.last().emit({ type: 'plugins-changed', plugins: [{ ...plugin, instanceID: 'i2', enabled: false, status: 'disabled' }], epoch: 'epoch-one' }));
            expect(getPluginContributionState(h.runtime, ID, 'i2').context).toEqual({});
            await act(async () => h.emit(info(4, 'i2')));
            expect(hook.result.current.states.size).toBe(0);
        } finally { cleanup(); h.runtime.dispose(); }
    });

    it('invalidates gaps and reconnects, without letting an abandoned request repopulate data', async () => {
        const h = setup(), gapRead = deferred<CommandReply>();
        try {
            const hook = renderHook(() => usePluginContributions(h.runtime));
            await waitFor(() => expect(hook.result.current.states.size).toBe(1));
            h.request.mockReturnValueOnce(gapRead.promise);
            act(() => h.sockets.last().emit({ type: 'plugin-event', event: { epoch: 'epoch-one', sequence: 3, name: 'gap', data: null } }));
            expect(getPluginContributionState(h.runtime, ID, 'i1').context).toEqual({});
            expect(h.request).toHaveBeenCalledTimes(2);
            h.request.mockResolvedValue({ ok: true, result: [info(1, 'i2', false)] as never });
            act(() => { h.runtime.connection.resync('test reconnect'); completeHandshake(h.sockets.last()); });
            await waitFor(() => expect(hook.result.current.states.get(ID)?.instanceID).toBe('i2'));
            await act(async () => gapRead.resolve({ ok: true, result: [info(50, 'i1')] as never }));
            expect(hook.result.current.states.get(ID)?.instanceID).toBe('i2');
            act(() => h.emit(info(2, 'i2'), 'epoch-two'));
            expect(getPluginContributionState(h.runtime, ID, 'i2').context['ready']).toBe(true);
        } finally { cleanup(); h.runtime.dispose(); }
    });

    it('rejects malformed snapshots and isolates runtimes at the same daemon address', async () => {
        const first = setup(), second = setup([info(1, 'other', false)]);
        first.request.mockResolvedValue({ ok: true, result: [{ ...info(), state: { context: { ready: { injected: true } }, items: {} } }] as never });
        try {
            const a = renderHook(() => usePluginContributions(first.runtime));
            const b = renderHook(() => usePluginContributions(second.runtime));
            await waitFor(() => expect(a.result.current.error).toContain('Invalid plugin contribution context'));
            await waitFor(() => expect(b.result.current.states.size).toBe(1));
            expect(a.result.current.states.size).toBe(0);
            act(() => first.emit(info(2)));
            expect(getPluginContributionState(first.runtime, ID, 'i1').context['ready']).toBe(true);
            expect(getPluginContributionState(second.runtime, ID, 'other').context['ready']).toBe(false);
        } finally { cleanup(); first.runtime.dispose(); second.runtime.dispose(); }
    });

    it('honors an explicit gap at the last sequence and drops old instance restrictions on epoch changes', async () => {
        const h = setup(), pending = deferred<CommandReply>();
        try {
            const hook = renderHook(() => usePluginContributions(h.runtime));
            await waitFor(() => expect(hook.result.current.states.size).toBe(1));
            h.request.mockReturnValue(pending.promise);
            act(() => {
                h.sockets.last().emit({ type: 'plugins-changed', plugins: [plugin], epoch: 'epoch-one' });
                h.emit(info(2));
                h.sockets.last().emit({ type: 'plugin-event', event: { epoch: 'epoch-one', sequence: 2, name: 'gap', data: null } });
            });
            expect(getPluginContributionState(h.runtime, ID, 'i1').context).toEqual({});
            act(() => h.emit(info(1, 'new-daemon-instance', false), 'epoch-two'));
            expect(getPluginContributionState(h.runtime, ID, 'new-daemon-instance').context['ready']).toBe(false);
            await act(async () => pending.resolve({ ok: true, result: [info(1, 'new-daemon-instance', false)] as never }));
        } finally { cleanup(); h.runtime.dispose(); }
    });
});

function nativeState() {
    const daemon = createDaemonStore(emptyDaemonState('/home/test'));
    daemon.dispatch({ type: 'create-workspace', id: 'w1', paneID: 'p1', name: 'One', color: 'blue', now: 1 });
    daemon.dispatch({ type: 'create-workspace', id: 'w2', paneID: 'p2', name: 'Two', color: 'blue', now: 2 });
    daemon.dispatch({ type: 'pane-agent-event', workspaceID: 'w2', paneID: 'p2', event: { type: 'agentStarted', agent: 'claude' }, now: 3 });
    const store = createKelpiStore(); store.getState().applySnapshot(0, JSON.parse(JSON.stringify(daemon.getState())));
    store.getState().setActiveWorkspace('w1'); store.getState().setFocusEcho('w1', 'p1');
    return store;
}

describe('contribution conditions and targeting', () => {
    it('compares scalar conjunctions without coercion, inheritance, or expression evaluation', () => {
        expect(matchesWhen({ 'context.ready': true, 'context.count': 0 }, { 'context.ready': true, 'context.count': 0 })).toBe(true);
        expect(matchesWhen({ 'context.count': 0 }, { 'context.count': '0' })).toBe(false);
        expect(matchesWhen({ 'context.missing': null }, {})).toBe(true);
        expect(matchesWhen({ 'context.ready': true }, Object.create({ 'context.ready': true }))).toBe(false);
        expect(matchesWhen({ 'context.ready': true }, { 'context.ready': 'true || globalThis.bad()' })).toBe(false);
    });

    it('uses the explicit pane owner, client focus, and agent identity without a fallback for invalid targets', () => {
        const store = nativeState();
        expect(contributionContext(store.getState(), {}, 'p1')).toMatchObject({ 'workspace.exists': true, 'pane.focused': true, 'pane.hasAgent': false });
        expect(contributionContext(store.getState(), {}, 'p2')).toMatchObject({ 'workspace.exists': true, 'pane.focused': false, 'pane.hasAgent': true });
        expect(contributionContext(store.getState(), {}, 'removed')).toMatchObject({ 'workspace.exists': false, 'pane.exists': false, 'pane.type': null });
        expect(contributionContext(store.getState(), {}, 'p2', 'w1')).toMatchObject({ 'workspace.exists': false, 'pane.exists': false });
        store.getState().setActiveWorkspace('w2');
        expect(contributionContext(store.getState(), {}, 'p2')['pane.focused']).toBe(true);
    });

    it('combines item and command conditions with instance-owned dynamic presentation', () => {
        const store = nativeState();
        const current = { ...info(), state: { context: { ready: true }, items: { [`${ID}.status`]: { text: 'Latest checks', badge: '2', tone: 'success' as const, enabled: true } } } };
        const states = new Map<string, PluginContributionInfo>([[ID, current]]);
        const item = resolveContributionItems([plugin], states, store.getState(), 'pane.header', 'p1')[0];
        expect(item).toMatchObject({ text: 'Latest checks', badge: '2', tone: 'success', enabled: true });
        expect(resolveContributionItems([plugin], states, store.getState(), 'pane.header', 'p2')[0]?.enabled).toBe(false);
        expect(resolveContributionItems([{ ...plugin, instanceID: 'new' }], states, store.getState(), 'pane.header', 'p1')[0]).toMatchObject({ text: 'Run checks', enabled: false });
        states.set(ID, { ...current, state: { ...current.state, items: { [`${ID}.status`]: { ...current.state.items[`${ID}.status`]!, visible: false } } } });
        expect(resolveContributionItems([plugin], states, store.getState(), 'pane.header', 'p1')).toEqual([]);
        expect(resolveContributionItems([{ ...plugin, enabled: false }], new Map(), store.getState(), 'pane.header', 'p1')).toEqual([]);
    });

    it('keeps default palette and legacy menus while explicit rules narrow their placement without duplicates', () => {
        const store = nativeState(), states = new Map([[ID, info()]]);
        expect(resolveContributionMenus([plugin], states, store.getState(), 'pane', 'p1')).toEqual([]);
        expect(resolveContributionMenus([plugin], states, store.getState(), 'palette').map(item => item.command)).toEqual([`${ID}.plain`]);
        expect(resolveContributionMenus([plugin], states, store.getState(), 'workspace')).toHaveLength(1);
        states.set(ID, { ...info(2), state: { context: { ready: true, show: true }, items: {} } });
        const menu = resolveContributionMenus([plugin], states, store.getState(), 'pane', 'p1');
        expect(menu).toHaveLength(1);
        expect(menu[0]).toMatchObject({ id: `${ID}.pane-menu`, group: 'checks', enabled: false });
        expect(resolveContributionMenus([plugin], states, store.getState(), 'pane', 'p2')[0]?.enabled).toBe(true);
        expect(resolveContributionMenus([plugin], states, store.getState(), 'palette')).toHaveLength(2);
    });
});
