import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePluginManifest, type PluginInfo } from '@kelpi/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { createKelpiRuntime, createKelpiStore } from '../state';
import { createFakeSocketFactory, completeHandshake } from '../connection/testing';
import { PluginView } from './PluginView';
import { PluginHostUIContext } from './host-ui';
import { createPluginNavigation } from './navigation';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('navigation through the isolated view bridge', () => {
    it('delivers current selection, coalesces unacknowledged updates, routes navigation locally and releases its feed on failure', async () => {
        vi.stubGlobal('MessageChannel', MessageChannel);
        const sockets = createFakeSocketFactory();
        const runtime = createKelpiRuntime({ store: createKelpiStore(), url: 'ws://navigation.test/ws', socketFactory: sockets.factory, notifications: null });
        const state = createDaemonStore(emptyDaemonState('/tmp'));
        for (const id of ['one', 'two', 'three']) state.dispatch({ type: 'create-workspace', id, paneID: `pane-${id}`, name: id, color: 'blue', now: 1 });
        runtime.connect(); completeHandshake(sockets.last(), { state: JSON.parse(JSON.stringify(state.getState())) });
        runtime.activateWorkspace('one');
        const activate = vi.fn((id: string) => runtime.activateWorkspace(id));
        const navigation = createPluginNavigation({ runtime, remotes: new Map(), selection: null, activateLocalWorkspace: activate, selectRemoteWorkspace: vi.fn() });
        const stops: Array<ReturnType<typeof vi.fn>> = [];
        const subscribe = navigation.subscribe;
        vi.spyOn(navigation, 'subscribe').mockImplementation((listener, onError) => {
            const stop = vi.fn(subscribe(listener, onError)); stops.push(stop); return stop;
        });
        const manifest = decodePluginManifest({ id: 'sample.navigation', version: '1.0.0', apiVersion: 1, trust: 'full', contributes: {
            views: [{ id: 'sample.navigation.view', title: 'Navigator', entry: 'ui/index.html', placements: ['pane'] }]
        } });
        const plugin: PluginInfo = { manifest, enabled: true, revision: 'r1', instanceID: 'i1', status: 'inactive', error: null };
        const requests = vi.spyOn(runtime.commands, 'raw').mockImplementation(async payload => payload['action'] === 'list'
            ? { ok: true, result: [plugin] as never }
            : payload['action'] === 'attach'
                ? { ok: true, result: { lease: 'lease', html: '<h1>Navigator</h1>', entry: 'ui/index.html', context: { daemonID: 'D' }, state: {}, stateVersion: 1 } }
                : { ok: true, result: null });
        let child: MessagePort | undefined;
        try {
            render(<PluginHostUIContext.Provider value={{ runtime, navigation, request: () => null }}>
                <PluginView runtime={runtime} pluginID={manifest.id} viewID={manifest.contributes.views[0]!.id} />
            </PluginHostUIContext.Provider>);
            await waitFor(() => expect(screen.getByTitle('Navigator').getAttribute('srcdoc')).toContain('kelpi-plugin-ready'));
            const frame = screen.getByTitle('Navigator') as HTMLIFrameElement;
            const nonce = /"nonce":"([^"]+)"/.exec(frame.srcdoc)![1];
            const send = vi.spyOn(frame.contentWindow!, 'postMessage');
            act(() => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'kelpi-plugin-ready', nonce } })));
            child = (send.mock.calls as unknown as Array<[unknown, unknown, MessagePort[]]>)[0]![2][0]!;
            const received: Array<{ type: string; sequence?: number; id?: string; result?: unknown; value?: { active: { hostID: string; workspaceID: string } } }> = [];
            child.on('message', message => received.push(message));
            await waitFor(() => expect(received.find(message => message.type === 'navigation')?.value?.active.workspaceID).toBe('one'));
            act(() => { runtime.activateWorkspace('two'); runtime.activateWorkspace('three'); });
            child.postMessage({ type: 'call', id: 'current', method: 'ui.getNavigation', args: {} });
            await waitFor(() => expect(received.find(message => message.id === 'current')?.result).toMatchObject({ active: { workspaceID: 'three' } }));
            expect(received.filter(message => message.type === 'navigation')).toHaveLength(1);
            child.postMessage({ type: 'navigation-ack', sequence: 1 });
            await waitFor(() => expect(received.filter(message => message.type === 'navigation')).toHaveLength(2));
            expect(received.find(message => message.sequence === 2)?.value?.active.workspaceID).toBe('three');
            const hostID = navigation.getNavigation().hosts[0]!.id;
            child.postMessage({ type: 'call', id: 'select', method: 'ui.selectWorkspace', args: { hostID, workspaceID: 'two' } });
            await waitFor(() => expect(activate).toHaveBeenCalledWith('two'));
            expect(requests.mock.calls.some(([payload]) => payload['action'] === 'api')).toBe(false);
            child.postMessage({ type: 'view-error', message: 'Example failed' });
            await screen.findByText('Example failed');
            expect(stops).toHaveLength(1);
            expect(stops[0]).toHaveBeenCalledOnce();
        } finally { cleanup(); child?.close(); navigation.dispose(); runtime.dispose(); }
    });
});
