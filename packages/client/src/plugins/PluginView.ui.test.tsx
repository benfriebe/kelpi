import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePluginManifest, type PluginInfo } from '@kelpi/protocol';
import { createKelpiRuntime, createKelpiStore } from '../state';
import { createFakeSocketFactory, completeHandshake } from '../connection/testing';
import { PluginView } from './PluginView';
import { PluginHostUIContext } from './host-ui';
import { createUIServices } from './ui-services';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function setup(crossRuntime = false, disposedServices = false) {
    vi.stubGlobal('MessageChannel', MessageChannel);
    const sockets = createFakeSocketFactory();
    const runtime = createKelpiRuntime({ store: createKelpiStore(), url: 'ws://ui.test/ws', socketFactory: sockets.factory, notifications: null });
    const other = createKelpiRuntime({ store: createKelpiStore(), url: 'ws://other.test/ws', socketFactory: createFakeSocketFactory().factory, notifications: null });
    runtime.connect(); completeHandshake(sockets.last());
    const manifest = decodePluginManifest({ id: 'sample.prompts', name: 'Prompt Plugin', version: '1.0.0', apiVersion: 1, trust: 'full', contributes: {
        views: [{ id: 'sample.prompts.view', title: 'Prompt View', entry: 'ui/index.html', placements: ['pane'] }]
    } });
    const plugin: PluginInfo = { manifest, enabled: true, revision: 'r1', instanceID: 'i1', status: 'inactive', error: null };
    const requests = vi.spyOn(runtime.commands, 'raw').mockImplementation(async payload => payload['action'] === 'list'
        ? { ok: true, result: [plugin] as never }
        : payload['action'] === 'attach'
            ? { ok: true, result: { lease: 'lease', html: '<p>Prompts</p>', entry: 'ui/index.html', context: { daemonID: 'D' }, state: {}, stateVersion: 1 } }
            : { ok: true, result: null });
    const services = createUIServices();
    if (disposedServices) services.dispose();
    const view = render(<PluginHostUIContext.Provider value={{ runtime: crossRuntime ? other : runtime, services, request: () => null }}>
        <PluginView runtime={runtime} pluginID={manifest.id} viewID={manifest.contributes.views[0]!.id} />
    </PluginHostUIContext.Provider>);
    await waitFor(() => expect(screen.getByTitle('Prompt View').getAttribute('srcdoc')).toContain('kelpi-plugin-ready'));
    const frame = screen.getByTitle('Prompt View') as HTMLIFrameElement;
    const nonce = /"nonce":"([^"]+)"/.exec(frame.srcdoc)![1];
    const send = vi.spyOn(frame.contentWindow!, 'postMessage');
    act(() => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'kelpi-plugin-ready', nonce } })));
    const child = (send.mock.calls as unknown as Array<[unknown, unknown, MessagePort[]]>)[0]?.[2][0];
    const replies: Array<{ id: string; result?: unknown; error?: string }> = [];
    child?.on('message', message => { if (message.type === 'reply') replies.push(message); });
    return { view, services, requests, child, replies, dispose: () => { cleanup(); child?.close(); services.dispose(); runtime.dispose(); other.dispose(); } };
}

describe('shared UI through the isolated view bridge', () => {
    it('routes prompts locally, answers through the private channel and cancels the owner on detach', async () => {
        const h = await setup();
        try {
            h.child!.postMessage({ type: 'call', id: 'input', method: 'ui.showInput', args: { title: 'A label' } });
            await waitFor(() => expect(h.services.getSnapshot().active?.kind).toBe('input'));
            expect(h.services.getSnapshot().active?.owner).toMatchObject({ pluginID: 'sample.prompts', pluginName: 'Prompt Plugin' });
            h.services.answer(h.services.getSnapshot().active!.id, 'Entered value');
            await waitFor(() => expect(h.replies.find(reply => reply.id === 'input')?.result).toBe('Entered value'));
            h.child!.postMessage({ type: 'call', id: 'dialog', method: 'ui.showDialog', args: { title: 'Confirm', message: 'Continue?', actions: [{ id: 'yes', label: 'Yes' }] } });
            h.child!.postMessage({ type: 'call', id: 'queued', method: 'ui.showInput', args: { title: 'Queued' } });
            h.child!.postMessage({ type: 'call', id: 'notification', method: 'ui.showNotification', args: { message: 'Working' } });
            await waitFor(() => expect(h.services.getSnapshot()).toMatchObject({ queued: 1, notifications: [expect.anything()] }));
            h.view.unmount();
            expect(h.services.getSnapshot()).toEqual({ active: null, queued: 0, notifications: [] });
            expect(h.requests.mock.calls.some(([payload]) => payload['action'] === 'api')).toBe(false);
            expect(h.requests.mock.calls.some(([payload]) => payload['action'] === 'release' && JSON.parse(String(payload['text'])).lease === 'lease')).toBe(true);
        } finally { h.dispose(); }
    });

    it('rejects another daemon’s view without forwarding a window prompt to either daemon', async () => {
        const h = await setup(true);
        try {
            h.child!.postMessage({ type: 'call', id: 'input', method: 'ui.showInput', args: { title: 'Wrong owner' } });
            await waitFor(() => expect(h.replies.find(reply => reply.id === 'input')?.error).toContain('unavailable for this daemon'));
            expect(h.services.getSnapshot().active).toBeNull();
            expect(h.requests.mock.calls.some(([payload]) => payload['action'] === 'api')).toBe(false);
        } finally { h.dispose(); }
    });

    it('turns a disposed service into a recoverable view error during channel setup', async () => {
        const h = await setup(false, true);
        try {
            expect(await screen.findByText('Window UI has been disposed.')).toBeDefined();
            expect(h.child).toBeUndefined();
            expect(h.requests.mock.calls.some(([payload]) => payload['action'] === 'release' && JSON.parse(String(payload['text'])).lease === 'lease')).toBe(true);
        } finally { h.dispose(); }
    });
});
