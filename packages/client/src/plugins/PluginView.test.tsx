import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePluginManifest, type PluginInfo } from '@kelpi/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { createKelpiRuntime } from '../state/bridge';
import { createKelpiStore } from '../state/store';
import { createFakeSocketFactory, completeHandshake } from '../connection/testing';
import { PluginView } from './PluginView';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const manifest = decodePluginManifest({ id: 'sample.board', version: '1.0.0', apiVersion: 1, trust: 'full', contributes: { views: [{ id: 'sample.board.view', title: 'Board', entry: 'ui/index.html', placements: ['pane'] }] } });
const plugin: PluginInfo = { manifest, enabled: true, revision: 'r1', instanceID: 'i1', status: 'inactive', error: null };

describe('isolated plugin view host', () => {
    it('validates the full focus target before changing workspace or pane focus', async () => {
        vi.stubGlobal('MessageChannel', MessageChannel);
        const sockets = createFakeSocketFactory();
        const runtime = createKelpiRuntime({ store: createKelpiStore(), url: 'ws://focus.test/ws', socketFactory: sockets.factory, notifications: null });
        const state = createDaemonStore(emptyDaemonState('/tmp'));
        state.dispatch({ type: 'create-workspace', id: 'workspace-one', paneID: 'pane-one', name: 'One', color: 'blue', now: 1 });
        state.dispatch({ type: 'create-workspace', id: 'workspace-two', paneID: 'pane-two', name: 'Two', color: 'blue', now: 1 });
        runtime.connect(); completeHandshake(sockets.last(), { state: JSON.parse(JSON.stringify(state.getState())) });
        runtime.activateWorkspace('workspace-two');
        vi.spyOn(runtime.commands, 'raw').mockImplementation(async payload => payload['action'] === 'list'
            ? { ok: true, result: [plugin] as never }
            : payload['action'] === 'attach'
                ? { ok: true, result: { lease: 'lease', html: '<h1>Board</h1>', entry: 'ui/index.html', context: { daemonID: 'D' }, state: {}, stateVersion: 1 } }
                : { ok: true, result: null });
        const activate = vi.spyOn(runtime, 'activateWorkspace');
        const focus = vi.spyOn(runtime, 'focusPane');
        let child: MessagePort | undefined;
        try {
            const view = render(<PluginView runtime={runtime} pluginID={manifest.id} viewID={manifest.contributes.views[0]!.id} />);
            await waitFor(() => expect(screen.getByTitle('Board').getAttribute('srcdoc')).toContain('kelpi-plugin-ready'));
            const frame = screen.getByTitle('Board') as HTMLIFrameElement;
            const nonce = /"nonce":"([^"]+)"/.exec(frame.srcdoc)![1];
            const send = vi.spyOn(frame.contentWindow!, 'postMessage');
            act(() => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'kelpi-plugin-ready', nonce } })));
            child = (send.mock.calls as unknown as Array<[unknown, unknown, MessagePort[]]>)[0]![2][0]!;
            const replies: Array<{ id?: string; error?: string }> = [];
            child.on('message', message => replies.push(message));
            child.postMessage({ type: 'call', id: 'invalid', method: 'ui.focusPane', args: { workspaceID: 'workspace-one', paneID: 'pane-two' } });
            await waitFor(() => expect(replies.find(reply => reply.id === 'invalid')?.error).toContain('pane does not exist'));
            expect(activate).not.toHaveBeenCalled(); expect(focus).not.toHaveBeenCalled();
            expect(runtime.store.getState().ui.activeWorkspaceID).toBe('workspace-two');
            child.postMessage({ type: 'call', id: 'valid', method: 'ui.focusPane', args: { workspaceID: 'workspace-one', paneID: 'pane-one' } });
            await waitFor(() => expect(replies.find(reply => reply.id === 'valid')).toEqual(expect.objectContaining({ id: 'valid' })));
            expect(activate).toHaveBeenCalledWith('workspace-one'); expect(focus).toHaveBeenCalledWith('workspace-one', 'pane-one');
            view.unmount();
        } finally { child?.close(); runtime.dispose(); }
    });
    it('ignores keyboard and focus relays from a hidden retained frame, then re-enables them when shown', async () => {
        vi.stubGlobal('MessageChannel', MessageChannel);
        const sockets = createFakeSocketFactory();
        const runtime = createKelpiRuntime({ store: createKelpiStore(), url: 'ws://hidden.test/ws', socketFactory: sockets.factory, notifications: null });
        runtime.connect(); completeHandshake(sockets.last());
        vi.spyOn(runtime.commands, 'raw').mockImplementation(async payload => payload['action'] === 'list'
            ? { ok: true, result: [plugin] as never }
            : payload['action'] === 'attach'
                ? { ok: true, result: { lease: 'lease', html: '<h1>Board</h1>', entry: 'ui/index.html', context: { daemonID: 'D' }, state: {}, stateVersion: 1 } }
                : { ok: true, result: null });
        const focus = vi.spyOn(runtime, 'focusPane').mockImplementation(() => {});
        const key = vi.fn();
        window.addEventListener('keydown', key);
        let child: MessagePort | undefined;
        try {
            const props = { runtime, pluginID: manifest.id, viewID: manifest.contributes.views[0]!.id, paneID: 'pane', workspaceID: 'workspace', claimedChords: ['8/KeyD'] };
            const view = render(<PluginView {...props} visible={false} />);
            await waitFor(() => expect(screen.getByTitle('Board').getAttribute('srcdoc')).toContain('kelpi-plugin-ready'));
            const frame = screen.getByTitle('Board') as HTMLIFrameElement;
            const nonce = /"nonce":"([^"]+)"/.exec(frame.srcdoc)![1];
            const send = vi.spyOn(frame.contentWindow!, 'postMessage');
            act(() => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'kelpi-plugin-ready', nonce } })));
            child = (send.mock.calls as unknown as Array<[unknown, unknown, MessagePort[]]>)[0]![2][0]!;
            const received: Array<{ type?: string; id?: string; value?: unknown; error?: string }> = [];
            child.on('message', message => received.push(message));
            const relay = async (id: string): Promise<void> => {
                child!.postMessage({ type: 'focus' });
                child!.postMessage({ type: 'key', key: 'd', code: 'KeyD', metaKey: true });
                // The reply is a FIFO barrier: the host has processed both earlier relays.
                child!.postMessage({ type: 'call', id, method: 'ui.notify', args: { message: 'barrier' } });
                await waitFor(() => expect(received.some(message => message.type === 'reply' && message.id === id)).toBe(true));
            };
            await relay('hidden');
            expect(focus).not.toHaveBeenCalled();
            expect(key).not.toHaveBeenCalled();
            expect(received.some(message => message.type === 'context' && JSON.stringify(message.value).includes('"chords":[]'))).toBe(true);
            view.rerender(<PluginView {...props} visible />);
            await relay('visible');
            expect(focus).toHaveBeenCalledWith('workspace', 'pane');
            expect(key).toHaveBeenCalledOnce();
            child.postMessage({ type: 'call', id: 'no-workbench', method: 'ui.getWorkbench', args: {} });
            await waitFor(() => expect(received.find(message => message.id === 'no-workbench')?.error).toContain('unavailable for this daemon'));
            view.unmount();
        } finally { child?.close(); window.removeEventListener('keydown', key); runtime.dispose(); }
    });
    it('binds its bridge to the expected frame, keeps the owner token out, and releases access on unmount', async () => {
        vi.stubGlobal('MessageChannel', MessageChannel);
        const sockets = createFakeSocketFactory();
        const runtime = createKelpiRuntime({ store: createKelpiStore(), url: 'ws://daemon.test/ws', token: 'owner-secret', socketFactory: sockets.factory, notifications: null });
        runtime.connect(); completeHandshake(sockets.last());
        const requests = vi.spyOn(runtime.commands, 'raw').mockImplementation(async payload => {
            if (payload['action'] === 'list') return { ok: true, result: [plugin] as never };
            if (payload['action'] === 'attach') return { ok: true, result: { lease: 'lease', html: '<h1>Board</h1>', entry: 'ui/index.html', context: { daemonID: 'D' }, state: {}, stateVersion: 1 } };
            return { ok: true, result: null };
        });
        try {
            const view = render(<PluginView runtime={runtime} pluginID={manifest.id} viewID={manifest.contributes.views[0]!.id} />);
            await waitFor(() => expect(screen.getByTitle('Board').getAttribute('srcdoc')).toContain('kelpi-plugin-ready'));
            const frame = screen.getByTitle('Board') as HTMLIFrameElement;
            expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
            expect(frame.srcdoc).not.toContain('owner-secret');
            const nonce = /"nonce":"([^"]+)"/.exec(frame.srcdoc)![1];
            const send = vi.spyOn(frame.contentWindow!, 'postMessage');
            act(() => window.dispatchEvent(new MessageEvent('message', { source: window, data: { type: 'kelpi-plugin-ready', nonce } })));
            expect(send).not.toHaveBeenCalled();
            act(() => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'kelpi-plugin-ready', nonce } })));
            expect(send).toHaveBeenCalledOnce();
            view.unmount();
            expect(requests.mock.calls.some(([payload]) => payload['action'] === 'release' && JSON.parse(String(payload['text'])).lease === 'lease')).toBe(true);
            // The child side would own this port in Chromium; the test's postMessage spy retains it.
            (send.mock.calls as unknown as Array<[unknown, unknown, Array<{ close(): void }>]>)[0]?.[2]?.[0]?.close();
        } finally { runtime.dispose(); }
    });
    it('keeps a disabled pane recoverable and does not load code for it', async () => {
        const sockets = createFakeSocketFactory();
        const runtime = createKelpiRuntime({ store: createKelpiStore(), url: 'ws://remote.test/ws', socketFactory: sockets.factory, notifications: null });
        runtime.connect(); completeHandshake(sockets.last());
        const requests = vi.spyOn(runtime.commands, 'raw').mockResolvedValue({ ok: true, result: [{ ...plugin, enabled: false, status: 'disabled' }] as never });
        try {
            render(<PluginView runtime={runtime} pluginID={manifest.id} viewID={manifest.contributes.views[0]!.id} />);
            await screen.findByText('This plugin is disabled.');
            expect(screen.getByText('Your pane and its state are preserved.')).toBeDefined();
            expect(requests.mock.calls.every(([payload]) => ['list', 'identity'].includes(String(payload['action'])))).toBe(true);
        } finally { runtime.dispose(); }
    });
});
