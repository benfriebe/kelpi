import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePluginManifest, type JsonObject, type JsonValue, type PluginInfo } from '@kelpi/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { createKelpiRuntime, createKelpiStore } from '../state';
import { completeHandshake, createFakeSocketFactory } from '../connection/testing';
import { PluginView } from './PluginView';
import { usePlugins } from './client';
import { clearDocumentDraft, getDocumentDraft } from './document-drafts';

const PANE = 'aaaaaaaa-2222-4333-8444-555555555555';
const VIEW = 'document.test.editor';
interface Reply { readonly id: string; readonly result?: JsonValue; readonly error?: string }
function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: Error) => void;
    const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
    return { promise, resolve, reject };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function setup(kind: 'scratchpad' | 'diff' = 'scratchpad', placements = [`document.${kind}`]) {
    vi.stubGlobal('MessageChannel', MessageChannel);
    const sockets = createFakeSocketFactory();
    const runtime = createKelpiRuntime({ store: createKelpiStore(), url: `ws://${crypto.randomUUID()}.test/ws`, socketFactory: sockets.factory, notifications: null });
    const daemonID = `daemon-${crypto.randomUUID()}`;
    const state = createDaemonStore(emptyDaemonState('/tmp'));
    state.dispatch({ type: 'create-workspace', id: 'W', paneID: 'terminal', name: 'Work', color: 'blue', now: 1 });
    if (kind === 'scratchpad') state.dispatch({ type: 'create-scratchpad', workspaceID: 'W', paneID: PANE, now: 2 });
    else state.dispatch({ type: 'open-diff-pane', workspaceID: 'W', paneID: PANE, repoPath: '/tmp', now: 2 });
    runtime.connect(); completeHandshake(sockets.last(), { state: JSON.parse(JSON.stringify(state.getState())) });
    const manifest = decodePluginManifest({ id: 'document.test', name: 'Document Test', version: '1.0.0', apiVersion: 1, trust: 'full', contributes: {
        views: [{ id: VIEW, title: 'Document Test Editor', entry: 'ui/index.html', placements }]
    } });
    const plugin: PluginInfo = { manifest, enabled: true, revision: 'r1', instanceID: 'i1', status: 'inactive', error: null };
    const api = vi.fn<(input: JsonObject) => Promise<JsonValue>>().mockResolvedValue({ text: 'accepted', revision: 'source:2', dirty: true });
    const requests = vi.spyOn(runtime.commands, 'raw').mockImplementation(async payload => {
        if (payload['action'] === 'list') return { ok: true, result: [plugin] as never };
        if (payload['action'] === 'identity') return { ok: true, result: { daemonID } };
        if (payload['action'] === 'attach') return { ok: true, result: { lease: 'lease', html: '<textarea></textarea>', entry: 'ui/index.html', context: { daemonID, paneID: PANE, workspaceID: 'W' }, state: {}, stateVersion: 1 } };
        if (payload['action'] === 'api') return { ok: true, result: await api(JSON.parse(String(payload['text'])) as JsonObject) };
        return { ok: true, result: null };
    });
    // DocumentPane owns a catalog subscription outside the selected renderer, so the daemon
    // identity stays available when a failing renderer is released and replaced by native UI.
    const catalog = renderHook(() => usePlugins(runtime));
    const onError = vi.fn();
    const view = render(<PluginView runtime={runtime} pluginID={manifest.id} viewID={VIEW} paneID={PANE} workspaceID="W" onError={onError} />);
    await waitFor(() => expect(screen.getByTitle('Document Test Editor').getAttribute('srcdoc')).toContain('kelpi-plugin-ready'));
    const frame = screen.getByTitle('Document Test Editor') as HTMLIFrameElement;
    const nonce = /"nonce":"([^"]+)"/.exec(frame.srcdoc)![1];
    const send = vi.spyOn(frame.contentWindow!, 'postMessage');
    act(() => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'kelpi-plugin-ready', nonce } })));
    const child = (send.mock.calls as unknown as Array<[unknown, unknown, MessagePort[]]>)[0]![2][0]!;
    const replies: Reply[] = [];
    child.on('message', message => { if (message.type === 'reply') replies.push(message); });
    let sequence = 0;
    const post = (method: string, args: JsonObject = {}, id = `call-${++sequence}`): string => { child.postMessage({ type: 'call', id, method, args }); return id; };
    const reply = async (id: string): Promise<Reply> => {
        await waitFor(() => expect(replies.some(value => value.id === id)).toBe(true));
        return replies.find(value => value.id === id)!;
    };
    const call = (method: string, args: JsonObject = {}): Promise<Reply> => reply(post(method, args));
    return { runtime, api, requests, view, child, replies, call, post, reply, onError, dispose: () => {
        view.unmount(); clearDocumentDraft(runtime, PANE); catalog.unmount(); child.close(); runtime.dispose();
    } };
}

describe('document drafts through the isolated renderer bridge', () => {
    it('stages each input locally, applies the exact draft once, and preserves newer queued input', async () => {
        const h = await setup();
        try {
            const first = await h.call('documents.stage', { text: 'first input', revision: 'source:1' });
            expect(first.error).toBeUndefined();
            const firstID = (first.result as JsonObject)['id'];
            expect(getDocumentDraft(h.runtime, PANE)).toMatchObject({ id: firstID, text: 'first input', viewID: VIEW });
            expect(h.api).not.toHaveBeenCalled();
            const pending = deferred<JsonValue>();
            h.api.mockReturnValueOnce(pending.promise);
            const applying = h.post('documents.applyDraft', { id: firstID!, revision: 'source:1' });
            await waitFor(() => expect(h.api).toHaveBeenCalledOnce());
            expect(h.api).toHaveBeenLastCalledWith({ lease: 'lease', method: 'documents.edit', args: { paneID: PANE, text: 'first input', revision: 'source:1' } });
            const latest = await h.call('documents.stage', { text: 'latest input while saving', revision: 'source:1' });
            const latestID = (latest.result as JsonObject)['id'];
            expect(latestID).not.toBe(firstID);
            expect((await h.call('documents.applyDraft', { id: firstID!, revision: 'source:1' })).error).toContain('DOCUMENT_DRAFT_SUPERSEDED');
            expect(h.api).toHaveBeenCalledOnce();
            pending.resolve({ text: 'first input', revision: 'source:2', dirty: true });
            expect((await h.reply(applying)).error).toBeUndefined();
            expect(getDocumentDraft(h.runtime, PANE)).toMatchObject({ id: latestID, text: 'latest input while saving' });
            expect((await h.call('documents.applyDraft', { id: latestID!, revision: 'source:2' })).error).toBeUndefined();
            expect(h.api).toHaveBeenLastCalledWith({ lease: 'lease', method: 'documents.edit', args: { paneID: PANE, text: 'latest input while saving', revision: 'source:2' } });
            expect(getDocumentDraft(h.runtime, PANE)?.id).toBe(latestID);
        } finally { h.dispose(); }
    });

    it('persists standard documents.edit before invoking the daemon and returns conflicts without retrying', async () => {
        const h = await setup();
        try {
            h.api.mockImplementation(async () => {
                expect(getDocumentDraft(h.runtime, PANE)).toMatchObject({ text: 'unaccepted text', revision: 'source:1' });
                throw new Error('DOCUMENT_CONFLICT: another writer changed this pane');
            });
            const result = await h.call('documents.edit', { text: 'unaccepted text', revision: 'source:1' });
            expect(result.error).toContain('DOCUMENT_CONFLICT');
            expect(getDocumentDraft(h.runtime, PANE)).toMatchObject({ text: 'unaccepted text', error: 'DOCUMENT_CONFLICT: another writer changed this pane' });
            expect(h.api).toHaveBeenCalledOnce();
            expect(h.onError).not.toHaveBeenCalled();
            expect(screen.getByTitle('Document Test Editor')).toBeDefined();
        } finally { h.dispose(); }
    });

    it('releases a detached view while retaining the newest input across cancellation of an older edit', async () => {
        const h = await setup();
        try {
            const first = await h.call('documents.stage', { text: 'in flight', revision: 'source:1' });
            const pending = deferred<JsonValue>();
            h.api.mockReturnValueOnce(pending.promise);
            const applying = h.post('documents.applyDraft', { id: (first.result as JsonObject)['id']!, revision: 'source:1' });
            await waitFor(() => expect(h.api).toHaveBeenCalledOnce());
            await h.call('documents.stage', { text: 'newest input', revision: 'source:1' });
            const latest = getDocumentDraft(h.runtime, PANE);
            h.view.unmount();
            expect(h.requests.mock.calls.some(([payload]) => payload['action'] === 'release' && JSON.parse(String(payload['text'])).lease === 'lease')).toBe(true);
            pending.reject(new Error('operation cancelled by lease release'));
            await act(async () => { await pending.promise.catch(() => {}); });
            expect(getDocumentDraft(h.runtime, PANE)).toEqual(latest);
            expect(h.replies.some(reply => reply.id === applying)).toBe(false);
        } finally { h.dispose(); }
    });

    it('retains staged input when a renderer fails and reports the failure to its native host', async () => {
        const h = await setup();
        try {
            await h.call('documents.stage', { text: 'survives renderer failure', revision: 'source:1' });
            const staged = getDocumentDraft(h.runtime, PANE);
            h.child.postMessage({ type: 'view-error', message: 'renderer crashed' });
            await waitFor(() => expect(h.onError).toHaveBeenCalledWith('renderer crashed'));
            expect(getDocumentDraft(h.runtime, PANE)).toEqual(staged);
            expect(h.requests.mock.calls.some(([payload]) => payload['action'] === 'release')).toBe(true);
            expect(h.api).not.toHaveBeenCalled();
            expect(screen.getByText('renderer crashed')).toBeDefined();
        } finally { h.dispose(); }
    });

    it.each([
        { kind: 'scratchpad' as const, placements: ['pane'] },
        { kind: 'diff' as const, placements: ['document.diff'] }
    ])('refuses drafts for $kind views without an editable document placement', async ({ kind, placements }) => {
        const h = await setup(kind, placements);
        try {
            const staged = await h.call('documents.stage', { text: 'invalid', revision: 'source:1' });
            expect(staged.error).toContain('editable document renderer');
            const applied = await h.call('documents.applyDraft', { id: 'unknown', revision: 'source:1' });
            expect(applied.error).toContain('editable document renderer');
            expect(getDocumentDraft(h.runtime, PANE)).toBeNull();
            expect(h.api).not.toHaveBeenCalled();
        } finally { h.dispose(); }
    });

    it('keeps storage failures visible in the host and rejects the view request before mutation', async () => {
        const h = await setup();
        try {
            vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota exceeded', 'QuotaExceededError'); });
            const result = await h.call('documents.stage', { text: 'volatile input', revision: 'source:1' });
            expect(result.error).toContain('Recovery storage is unavailable');
            expect(getDocumentDraft(h.runtime, PANE)).toMatchObject({ text: 'volatile input', volatile: true, error: expect.stringContaining('only held in this window') });
            expect(h.api).not.toHaveBeenCalled();
            expect(h.onError).not.toHaveBeenCalled();
        } finally { h.dispose(); }
    });
});
