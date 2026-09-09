import { StrictMode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKelpiStore, type KelpiRuntime } from '../state';
import type { RemoteDaemonRuntime } from '../app/remote-daemons';
import type { RemoteSelection } from '../app/RemoteDaemonSections';
import { requestHostUI } from './host-ui';
import { createPluginNavigation, createPluginNavigationFeed, type PluginNavigation, type PluginNavigationMessage, type PluginNavigationOptions } from './navigation';
import { usePluginNavigation } from './use-navigation';

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const W2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const G1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const P1 = 'cccccccc-0000-4000-8000-000000000001';
const P2 = 'cccccccc-0000-4000-8000-000000000002';

function runtime(name: string) {
    const daemon = createDaemonStore(emptyDaemonState('/private/home/secret'));
    daemon.dispatch({ type: 'create-workspace', id: W1, paneID: P1, name, color: 'blue', now: 1 });
    const store = createKelpiStore();
    const sync = (): void => store.getState().applySnapshot(0, JSON.parse(JSON.stringify(daemon.getState())));
    sync();
    store.getState().setConnectionStatus('connected');
    const call = vi.fn();
    const value = { store, commands: { request: call }, activateWorkspace: call } as unknown as KelpiRuntime;
    return { runtime: value, daemon, sync, call };
}
function fixture() {
    const local = runtime('Local workspace'), remote = runtime('Remote workspace');
    const held: RemoteDaemonRuntime = { name: 'Remote host', url: 'https://private.example.test/?token=DO_NOT_EXPOSE', runtime: remote.runtime };
    const remotes = new Map([[held.name, held]]);
    const activateLocalWorkspace = vi.fn(), selectRemoteWorkspace = vi.fn();
    const options: PluginNavigationOptions = { runtime: local.runtime, remotes, selection: null, activateLocalWorkspace, selectRemoteWorkspace };
    const model = createPluginNavigation(options);
    return { local, remote, held, remotes, options, model, activateLocalWorkspace, selectRemoteWorkspace };
}
afterEach(cleanup);

describe('window plugin navigation', () => {
    it('summarizes all hosts in sidebar order, including collapsed groups, without private state', () => {
        const h = fixture();
        h.local.daemon.dispatch({ type: 'create-workspace', id: W2, paneID: P2, name: 'Second', color: 'red', now: 2 });
        h.local.daemon.dispatch({ type: 'create-group', id: G1, name: 'Group', now: 3 });
        h.local.daemon.dispatch({ type: 'move-workspace-to-group', id: W1, groupID: G1 });
        h.local.daemon.dispatch({ type: 'set-group-collapsed', id: G1, collapsed: true });
        h.local.sync();
        const snapshot = h.model.getNavigation();
        expect(snapshot.hosts.map(host => ({ name: host.name, kind: host.kind, connection: host.connection }))).toEqual([
            { name: 'This daemon', kind: 'local', connection: 'connected' }, { name: 'Remote host', kind: 'remote', connection: 'connected' },
        ]);
        expect(snapshot.hosts[0]?.workspaces).toEqual([
            { id: W2, name: 'Second', color: 'red', paneCount: 1, group: null },
            { id: W1, name: 'Local workspace', color: 'blue', paneCount: 1, group: { id: G1, name: 'Group', color: null } },
        ]);
        expect(snapshot.active).toEqual({ hostID: snapshot.hosts[0]!.id, workspaceID: W1 });
        expect(snapshot.hosts[0]!.id).not.toBe(snapshot.hosts[1]!.id);
        const json = JSON.stringify(snapshot);
        for (const secret of ['private.example', 'DO_NOT_EXPOSE', '/private/home', 'url', 'token', 'cwd', 'panes']) expect(json).not.toContain(secret);
        expect(Object.isFrozen(snapshot.hosts[0]!.workspaces[0])).toBe(true);
        h.model.dispose();
    });

    it('validates host and workspace before either selection callback and never calls a daemon', () => {
        const h = fixture();
        const [local, remote] = h.model.getNavigation().hosts;
        h.model.selectWorkspace(local!.id, W1);
        h.model.selectWorkspace(remote!.id, W1); // Identical workspace IDs are scoped by host.
        expect(h.activateLocalWorkspace).toHaveBeenCalledExactlyOnceWith(W1);
        expect(h.selectRemoteWorkspace).toHaveBeenCalledExactlyOnceWith({ daemon: h.held.name, workspaceID: W1 });
        h.activateLocalWorkspace.mockClear(); h.selectRemoteWorkspace.mockClear();
        for (const pair of [[{}, W1], [local!.id, null], ['missing-host', W1], [local!.id, W2], [remote!.id, W2]]) {
            expect(() => h.model.selectWorkspace(pair[0], pair[1])).toThrow();
        }
        h.remote.runtime.store.getState().setConnectionStatus('reconnecting', 'private socket error');
        expect(() => h.model.selectWorkspace(remote!.id, W1)).toThrow('not connected and ready');
        h.local.runtime.store.setState(state => ({ daemon: { ...state.daemon, desynced: true } }));
        expect(() => h.model.selectWorkspace(local!.id, W1)).toThrow('not connected and ready');
        expect(h.activateLocalWorkspace).not.toHaveBeenCalled(); expect(h.selectRemoteWorkspace).not.toHaveBeenCalled();
        expect(h.local.call).not.toHaveBeenCalled(); expect(h.remote.call).not.toHaveBeenCalled();
        expect(JSON.stringify(h.model.getNavigation())).not.toContain('private socket error');
        h.model.dispose();
    });

    it('keeps IDs on reconnect, invalidates replacements/removal, and does not transfer an old active selection', () => {
        const h = fixture();
        const selection: RemoteSelection = { daemon: h.held.name, workspaceID: W1 };
        h.model.update({ remotes: h.remotes, selection });
        const remoteID = h.model.getNavigation().hosts[1]!.id;
        expect(h.model.getNavigation().active).toEqual({ hostID: remoteID, workspaceID: W1 });
        h.remote.runtime.store.getState().setConnectionStatus('closed');
        h.remote.runtime.store.getState().setConnectionStatus('connected');
        expect(h.model.getNavigation().hosts[1]!.id).toBe(remoteID);
        const replacement = new Map([[h.held.name, { ...h.held, url: 'https://replacement.invalid/?token=other' }]]);
        h.model.update({ remotes: replacement, selection });
        const replacementID = h.model.getNavigation().hosts[1]!.id;
        expect(replacementID).not.toBe(remoteID);
        expect(h.model.getNavigation().active).toBeNull();
        expect(() => h.model.selectWorkspace(remoteID, W1)).toThrow('no longer available');
        h.model.update({ remotes: replacement, selection: { ...selection } });
        expect(h.model.getNavigation().active?.hostID).toBe(replacementID);
        h.model.update({ remotes: new Map(), selection });
        expect(h.model.getNavigation().active).toBeNull();
        expect(() => h.model.selectWorkspace(replacementID, W1)).toThrow('no longer available');
        h.model.update({ remotes: replacement, selection });
        expect(h.model.getNavigation().hosts[1]!.id).not.toBe(replacementID);
        expect(h.model.getNavigation().active).toBeNull();
        const renamed = new Map([['Renamed', { ...h.held, name: 'Renamed' }]]);
        h.model.update({ remotes: renamed, selection });
        expect(h.model.getNavigation().hosts[1]!.id).not.toBe(remoteID);
        h.model.dispose();
    });

    it('updates from both stores and unsubscribes replaced runtime instances with the same configured identity', async () => {
        const h = fixture(), observed = vi.fn();
        const stop = h.model.subscribe(observed);
        const remoteID = h.model.getNavigation().hosts[1]!.id;
        h.remote.daemon.dispatch({ type: 'rename-workspace', id: W1, name: 'Renamed remote' }); h.remote.sync();
        await Promise.resolve();
        expect(observed).toHaveBeenLastCalledWith(expect.objectContaining({ hosts: expect.arrayContaining([expect.objectContaining({ workspaces: [expect.objectContaining({ name: 'Renamed remote' })] })]) }));
        const next = runtime('Next instance');
        h.model.update({ remotes: new Map([[h.held.name, { ...h.held, runtime: next.runtime }]]), selection: null });
        await Promise.resolve();
        expect(h.model.getNavigation().hosts[1]!.id).toBe(remoteID);
        const calls = observed.mock.calls.length;
        h.remote.runtime.store.getState().setConnectionStatus('closed');
        await Promise.resolve();
        expect(observed).toHaveBeenCalledTimes(calls);
        next.runtime.store.getState().setConnectionStatus('rejected');
        await Promise.resolve();
        expect(observed).toHaveBeenCalledTimes(calls + 1);
        h.local.daemon.dispatch({ type: 'rename-workspace', id: W1, name: 'Renamed local' }); h.local.sync();
        stop();
        await Promise.resolve();
        expect(observed).toHaveBeenCalledTimes(calls + 1);
        h.model.dispose();
    });

    it('isolates throwing subscribers and reports oversized snapshots explicitly, then recovers', async () => {
        const h = fixture(), observed = vi.fn(), errors = vi.fn();
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        h.model.subscribe(() => { throw new Error('author failure'); }, () => { throw new Error('error handler failure'); });
        h.model.subscribe(observed, errors);
        h.remote.daemon.dispatch({ type: 'rename-workspace', id: W1, name: '💠'.repeat(100_000) }); h.remote.sync();
        expect(() => h.model.getNavigation()).toThrow('exceeds 256 KiB');
        await Promise.resolve();
        expect(errors).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'Navigation snapshot is invalid or exceeds 256 KiB.' }));
        expect(observed).toHaveBeenCalledTimes(1);
        h.remote.daemon.dispatch({ type: 'rename-workspace', id: W1, name: 'Recovered' }); h.remote.sync();
        await Promise.resolve();
        expect(observed).toHaveBeenCalledTimes(2);
        expect(log).toHaveBeenCalled();
        h.model.dispose(); log.mockRestore();
    });

    it('releases every store subscription and rejects stale calls after window disposal', async () => {
        const h = fixture(), observed = vi.fn();
        const removals: Array<ReturnType<typeof vi.fn>> = [];
        for (const runtime of [h.local.runtime, h.remote.runtime]) {
            const original = runtime.store.subscribe;
            vi.spyOn(runtime.store, 'subscribe').mockImplementation(listener => {
                const remove = vi.fn(original(listener)); removals.push(remove); return remove;
            });
        }
        h.model.getNavigation();
        expect(removals).toHaveLength(0);
        const stop = h.model.subscribe(observed);
        expect(removals).toHaveLength(2);
        h.local.runtime.store.getState().setConnectionStatus('closed');
        const hostID = h.model.getNavigation().hosts[0]!.id;
        h.model.dispose(); stop();
        await Promise.resolve();
        for (const remove of removals) expect(remove).toHaveBeenCalledOnce();
        expect(observed).toHaveBeenCalledOnce();
        expect(() => h.model.getNavigation()).toThrow('disposal');
        expect(() => h.model.selectWorkspace(hostID, W1)).toThrow('disposal');
        expect(() => h.model.subscribe(observed)).toThrow('disposal');
    });

    it('keeps the existing owner-runtime guard for both navigation reads and selection', () => {
        const h = fixture();
        const request = vi.fn(() => null);
        const read = vi.spyOn(h.model, 'getNavigation'), select = vi.spyOn(h.model, 'selectWorkspace');
        const hostID = h.model.getNavigation().hosts[0]!.id; read.mockClear();
        const host = { runtime: h.local.runtime, request, navigation: h.model };
        for (const method of ['ui.getNavigation', 'ui.selectWorkspace']) {
            expect(() => requestHostUI(host, h.remote.runtime, method, {})).toThrow('unavailable');
            expect(read).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
            requestHostUI(host, h.local.runtime, method, { hostID, workspaceID: W1 });
            expect(method === 'ui.getNavigation' ? read : select).toHaveBeenCalledOnce();
            read.mockClear(); select.mockClear();
        }
        expect(request).not.toHaveBeenCalled();
        expect(h.activateLocalWorkspace).toHaveBeenCalledExactlyOnceWith(W1);
        h.model.dispose();
    });
});

describe('navigation frame feed', () => {
    it('keeps one frame outstanding and only the latest pending state until the matching ack', async () => {
        const h = fixture(), messages: PluginNavigationMessage[] = [];
        const feed = createPluginNavigationFeed(h.model, message => messages.push(message));
        expect(messages).toHaveLength(1);
        for (let index = 0; index < 25; index++) {
            h.local.daemon.dispatch({ type: 'rename-workspace', id: W1, name: `Update ${index}` }); h.local.sync();
            await Promise.resolve();
        }
        expect(messages).toHaveLength(1);
        feed.ack(2); feed.ack('1'); feed.ack(null);
        expect(messages).toHaveLength(1);
        feed.ack(1);
        expect(messages).toHaveLength(2);
        expect(messages[1]).toMatchObject({ type: 'navigation', sequence: 2, value: { hosts: [expect.objectContaining({ workspaces: [expect.objectContaining({ name: 'Update 24' })] }), expect.anything()] } });
        h.local.runtime.store.getState().setConnectionStatus('closed');
        await Promise.resolve();
        feed.dispose(); feed.ack(2);
        expect(messages).toHaveLength(2);
        h.model.dispose();
    });

    it('uses the same bounded acknowledgement path for oversized errors and recovery', async () => {
        const h = fixture(), messages: PluginNavigationMessage[] = [];
        const feed = createPluginNavigationFeed(h.model, message => messages.push(message));
        feed.ack(1);
        h.local.daemon.dispatch({ type: 'rename-workspace', id: W1, name: 'x'.repeat(300_000) }); h.local.sync();
        await Promise.resolve();
        expect(messages[1]).toEqual({ type: 'navigation-error', sequence: 2, error: 'Navigation snapshot is invalid or exceeds 256 KiB.' });
        h.local.daemon.dispatch({ type: 'rename-workspace', id: W1, name: 'Recovered' }); h.local.sync();
        await Promise.resolve();
        expect(messages).toHaveLength(2);
        feed.ack(2);
        expect(messages[2]).toMatchObject({ type: 'navigation', sequence: 3 });
        feed.dispose(); h.model.dispose();
    });
});

describe('navigation React lifetime', () => {
    it('survives StrictMode setup/cleanup, retains identities on committed updates and disposes on unmount', async () => {
        const h = fixture(); h.model.dispose();
        let current: PluginNavigation | null = null;
        function Harness({ options }: { options: PluginNavigationOptions }): null { current = usePluginNavigation(options); return null; }
        const mounted = render(<StrictMode><Harness options={h.options} /></StrictMode>);
        const first = current! as PluginNavigation;
        const ids = first.getNavigation().hosts.map(host => host.id);
        mounted.rerender(<StrictMode><Harness options={{ ...h.options, selection: { daemon: h.held.name, workspaceID: W1 } }} /></StrictMode>);
        expect(current).toBe(first);
        expect(first.getNavigation().hosts.map(host => host.id)).toEqual(ids);
        expect(first.getNavigation().active?.hostID).toBe(ids[1]);
        const replacement = runtime('New primary');
        mounted.rerender(<StrictMode><Harness options={{ ...h.options, runtime: replacement.runtime }} /></StrictMode>);
        expect(current).not.toBe(first);
        expect(() => first.getNavigation()).toThrow('disposal');
        const latest = current! as PluginNavigation;
        const observed = vi.fn(); latest.subscribe(observed);
        act(() => { replacement.runtime.store.getState().setConnectionStatus('closed'); mounted.unmount(); });
        await Promise.resolve();
        expect(observed).toHaveBeenCalledOnce();
        expect(() => latest.getNavigation()).toThrow('disposal');
    });
});
