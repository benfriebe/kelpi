import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePluginManifest, type JsonObject, type PluginInfo } from '@kelpi/protocol';
import { createKelpiRuntime, createKelpiStore } from '../state';
import { createFakeSocketFactory, completeHandshake } from '../connection/testing';
import { PluginView } from './PluginView';
import { PluginHostUIContext } from './host-ui';
import { createUIServices } from './ui-services';
import type { InteractionPlacement } from '../interaction/contract';
import type { InteractionPresenterHost, InteractionPresenterSnapshot } from '../interaction/presenter';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** A window interaction host in the shape `PluginView` is granted, without mounting a window. */
function fakePresenter(placement: InteractionPlacement = 'interaction.prompts') {
    const listeners = new Set<(value: InteractionPresenterSnapshot) => void>();
    const calls: Array<{ method: string; args: JsonObject }> = [];
    let acknowledged = 0, disposed = 0;
    const snapshot = (query = ''): InteractionPresenterSnapshot => ({
        placement, formFactor: 'desktop', visible: true, paletteOpen: false,
        palette: placement === 'interaction.palette'
            ? { sessionID: 'session-1', query, scope: 'all', items: [], selectedID: null, remoteWorkspaceSelected: false } : null,
        prompt: null, queued: 0, notifications: [],
    });
    const host: InteractionPresenterHost = {
        placement,
        getInteraction: () => snapshot(),
        subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); },
        call(method, args) { calls.push({ method, args }); },
        noteAcknowledged() { acknowledged += 1; },
        refresh() {},
        dispose() { disposed += 1; },
    };
    return { host, calls, publish: (query: string) => { for (const listener of listeners) listener(snapshot(query)); },
        acknowledged: () => acknowledged, disposed: () => disposed };
}

async function setup(options: {
    crossRuntime?: boolean; disposedServices?: boolean;
    presenter?: InteractionPresenterHost; placements?: readonly string[];
} = {}) {
    vi.stubGlobal('MessageChannel', MessageChannel);
    const sockets = createFakeSocketFactory();
    const runtime = createKelpiRuntime({ store: createKelpiStore(), url: 'ws://ui.test/ws', socketFactory: sockets.factory, notifications: null });
    const other = createKelpiRuntime({ store: createKelpiStore(), url: 'ws://other.test/ws', socketFactory: createFakeSocketFactory().factory, notifications: null });
    runtime.connect(); completeHandshake(sockets.last());
    const manifest = decodePluginManifest({ id: 'sample.prompts', name: 'Prompt Plugin', version: '1.0.0', apiVersion: 1, trust: 'full', contributes: {
        views: [{ id: 'sample.prompts.view', title: 'Prompt View', entry: 'ui/index.html', placements: options.placements ?? ['pane'] }]
    } });
    const plugin: PluginInfo = { manifest, enabled: true, revision: 'r1', instanceID: 'i1', status: 'inactive', error: null };
    const requests = vi.spyOn(runtime.commands, 'raw').mockImplementation(async payload => payload['action'] === 'list'
        ? { ok: true, result: [plugin] as never }
        : payload['action'] === 'attach'
            ? { ok: true, result: { lease: 'lease', html: '<p>Prompts</p>', entry: 'ui/index.html', context: { daemonID: 'D' }, state: {}, stateVersion: 1 } }
            : { ok: true, result: null });
    const services = createUIServices();
    if (options.disposedServices) services.dispose();
    const view = render(<PluginHostUIContext.Provider value={{ runtime: options.crossRuntime ? other : runtime, services, request: () => null }}>
        <PluginView runtime={runtime} pluginID={manifest.id} viewID={manifest.contributes.views[0]!.id} presenter={options.presenter} />
    </PluginHostUIContext.Provider>);
    await waitFor(() => expect(screen.getByTitle('Prompt View').getAttribute('srcdoc')).toContain('kelpi-plugin-ready'));
    const frame = screen.getByTitle('Prompt View') as HTMLIFrameElement;
    const nonce = /"nonce":"([^"]+)"/.exec(frame.srcdoc)![1];
    const send = vi.spyOn(frame.contentWindow!, 'postMessage');
    act(() => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'kelpi-plugin-ready', nonce } })));
    const child = (send.mock.calls as unknown as Array<[unknown, unknown, MessagePort[]]>)[0]?.[2][0];
    const replies: Array<{ id: string; result?: unknown; error?: string }> = [];
    const frames: Array<{ type: string; sequence: number; value?: InteractionPresenterSnapshot }> = [];
    child?.on('message', message => {
        if (message.type === 'reply') replies.push(message);
        else if (String(message.type).startsWith('interaction')) frames.push(message);
    });
    return { view, services, requests, child, replies, frames, dispose: () => { cleanup(); child?.close(); services.dispose(); runtime.dispose(); other.dispose(); } };
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
        const h = await setup({ crossRuntime: true });
        try {
            h.child!.postMessage({ type: 'call', id: 'input', method: 'ui.showInput', args: { title: 'Wrong owner' } });
            await waitFor(() => expect(h.replies.find(reply => reply.id === 'input')?.error).toContain('unavailable for this daemon'));
            expect(h.services.getSnapshot().active).toBeNull();
            expect(h.requests.mock.calls.some(([payload]) => payload['action'] === 'api')).toBe(false);
        } finally { h.dispose(); }
    });

    it('turns a disposed service into a recoverable view error during channel setup', async () => {
        const h = await setup({ disposedServices: true });
        try {
            expect(await screen.findByText('Window UI has been disposed.')).toBeDefined();
            expect(h.child).toBeUndefined();
            expect(h.requests.mock.calls.some(([payload]) => payload['action'] === 'release' && JSON.parse(String(payload['text'])).lease === 'lease')).toBe(true);
        } finally { h.dispose(); }
    });

    it('refuses presenter calls from a view that was granted nothing, without reaching the daemon', async () => {
        const h = await setup();
        try {
            h.child!.postMessage({ type: 'call', id: 'query', method: 'ui.setPaletteQuery', args: { sessionID: 'session-1', text: 'tests' } });
            await waitFor(() => expect(h.replies.find(reply => reply.id === 'query')?.error).toBe('Interaction presentation is unavailable for this view.'));
            expect(h.frames).toEqual([]);
            expect(h.requests.mock.calls.some(([payload]) => payload['action'] === 'api')).toBe(false);
        } finally { h.dispose(); }
    });

    it('refuses a granted presenter whose manifest does not declare the placement', async () => {
        const presenter = fakePresenter();
        const h = await setup({ presenter: presenter.host });
        try {
            h.child!.postMessage({ type: 'call', id: 'respond', method: 'ui.respondInteraction', args: { requestID: 'request-1', value: null } });
            await waitFor(() => expect(h.replies.find(reply => reply.id === 'respond')?.error).toBe('Interaction presentation is unavailable for this view.'));
            expect(presenter.calls).toEqual([]);
            expect(h.frames).toEqual([]);
        } finally { h.dispose(); }
    });

    it('treats only the outstanding frame’s acknowledgement as presenter liveness', async () => {
        const presenter = fakePresenter();
        const h = await setup({ presenter: presenter.host, placements: ['pane', 'interaction.prompts'] });
        try {
            await waitFor(() => expect(h.frames).toHaveLength(1));
            h.child!.postMessage({ type: 'interaction-ack', sequence: 9 });
            h.child!.postMessage({ type: 'interaction-ack', sequence: '1' });
            await new Promise(resolve => setTimeout(resolve, 20));
            expect(presenter.acknowledged()).toBe(0);
            h.child!.postMessage({ type: 'interaction-ack', sequence: 1 });
            await waitFor(() => expect(presenter.acknowledged()).toBe(1));
            // The replayed ack belongs to a frame already released; a wedged presenter cannot
            // keep its watchdog quiet by repeating it.
            presenter.publish('second');
            await waitFor(() => expect(h.frames).toHaveLength(2));
            h.child!.postMessage({ type: 'interaction-ack', sequence: 1 });
            await new Promise(resolve => setTimeout(resolve, 20));
            expect(presenter.acknowledged()).toBe(1);
            h.child!.postMessage({ type: 'interaction-ack', sequence: 2 });
            await waitFor(() => expect(presenter.acknowledged()).toBe(2));
        } finally { h.dispose(); }
    });

    it('feeds, acknowledges and routes the selected presenter, then disposes the feed on a view error', async () => {
        const presenter = fakePresenter();
        const h = await setup({ presenter: presenter.host, placements: ['pane', 'interaction.prompts'] });
        try {
            await waitFor(() => expect(h.frames).toHaveLength(1));
            expect(h.frames[0]).toMatchObject({ type: 'interaction', sequence: 1, value: { placement: 'interaction.prompts', palette: null } });
            h.child!.postMessage({ type: 'call', id: 'read', method: 'ui.getInteraction', args: {} });
            await waitFor(() => expect(h.replies.find(reply => reply.id === 'read')?.result).toMatchObject({ placement: 'interaction.prompts', queued: 0 }));
            h.child!.postMessage({ type: 'call', id: 'respond', method: 'ui.respondInteraction', args: { requestID: 'request-1', value: 'yes' } });
            await waitFor(() => expect(presenter.calls).toEqual([{ method: 'ui.respondInteraction', args: { requestID: 'request-1', value: 'yes' } }]));
            expect(h.replies.find(reply => reply.id === 'respond')).toMatchObject({ result: null });
            // One outstanding frame: the next waits for this acknowledgement, which is also the
            // liveness signal the placement watchdog reads.
            presenter.publish('held');
            expect(h.frames).toHaveLength(1);
            h.child!.postMessage({ type: 'interaction-ack', sequence: 1 });
            await waitFor(() => expect(presenter.acknowledged()).toBe(1));
            await waitFor(() => expect(h.frames).toHaveLength(2));
            h.child!.postMessage({ type: 'view-error', message: 'Presenter crashed' });
            await waitFor(() => expect(screen.getByText('Presenter crashed')).toBeDefined());
            presenter.publish('after failure');
            expect(h.frames).toHaveLength(2);
            expect(h.requests.mock.calls.some(([payload]) => payload['action'] === 'api')).toBe(false);
        } finally { h.dispose(); }
    });
});
