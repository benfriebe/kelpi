import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import type { JsonObject, JsonValue } from '@kelpi/protocol';
import type { DocumentSnapshot } from '../../../plugin-sdk/documents';
import { createKelpiRuntime, createKelpiStore, type KelpiRuntime } from '../state';
import { completeHandshake, createFakeSocketFactory } from '../connection/testing';
import { createFakeContentApi } from '../content/testing';
import { clearDocumentDraft, getDocumentDraft, isRecoveredDocumentDraft, prepareDocumentViewsClose, registerDocumentCloseGuard, runDocumentEdit, stageDocumentDraft } from './document-drafts';

const { daemonIDs, request } = vi.hoisted(() => ({
    daemonIDs: new WeakMap<KelpiRuntime, string>(),
    request: vi.fn<(runtime: KelpiRuntime, action: string, input?: JsonObject) => Promise<JsonValue>>()
}));
vi.mock('./client', () => ({ getPluginDaemonID: (runtime: KelpiRuntime) => daemonIDs.get(runtime) ?? null, pluginRequest: request }));

const runtimes: KelpiRuntime[] = [];
const drafts: Array<{ runtime: KelpiRuntime; paneID: string }> = [];
const PANE = 'aaaaaaaa-2222-4333-8444-555555555555';
const OTHER = 'bbbbbbbb-2222-4333-8444-555555555555';
const PARKED = 'cccccccc-2222-4333-8444-555555555555';
const TERMINAL = 'dddddddd-2222-4333-8444-555555555555';

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: Error) => void;
    const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
    return { promise, resolve, reject };
}

function setup(daemonID?: string, url = `ws://${crypto.randomUUID()}.test/ws`) {
    const state = createDaemonStore(emptyDaemonState('/tmp'));
    state.dispatch({ type: 'create-workspace', id: 'W1', paneID: TERMINAL, name: 'Work', color: 'blue', now: 1 });
    state.dispatch({ type: 'create-scratchpad', workspaceID: 'W1', paneID: PANE, now: 2 });
    state.dispatch({ type: 'create-scratchpad', workspaceID: 'W1', paneID: PARKED, now: 3 });
    state.dispatch({ type: 'park-pane', workspaceID: 'W1', paneID: PARKED });
    state.dispatch({ type: 'create-workspace', id: 'W2', paneID: OTHER, name: 'Other', color: 'blue', now: 4 });
    const sockets = createFakeSocketFactory();
    const runtime = createKelpiRuntime({ store: createKelpiStore(), url, socketFactory: sockets.factory, notifications: null });
    runtimes.push(runtime);
    runtime.connect(); completeHandshake(sockets.last(), { state: JSON.parse(JSON.stringify(state.getState())) });
    if (daemonID) daemonIDs.set(runtime, daemonID);
    for (const paneID of [PANE, OTHER, PARKED]) drafts.push({ runtime, paneID });
    const frames = () => sockets.last().messages().filter(message => message['type'] === 'command');
    const answer = (): void => {
        const frame = frames().at(-1)!;
        sockets.last().emit({ type: 'command-reply', id: String(frame['id']), reply: { ok: true } });
    };
    return { runtime, state, frames, answer };
}

function snapshot(text: string, revision = 'source:2', dirty = false): JsonValue {
    const document: DocumentSnapshot = { paneID: PANE, workspaceID: 'W1', kind: 'scratchpad', mode: 'edit', path: '/tmp/note.md', text, revision, dirty, loaded: true, error: null };
    return { ...document };
}

beforeEach(() => { request.mockReset(); request.mockRejectedValue(new Error('unexpected document request')); });
afterEach(() => {
    vi.restoreAllMocks();
    for (const draft of drafts.splice(0)) clearDocumentDraft(draft.runtime, draft.paneID);
    for (const runtime of runtimes.splice(0)) runtime.dispose();
});

describe('document recovery drafts', () => {
    it('persists exact text before an edit starts and keeps it until a saved authoritative sample', async () => {
        const { runtime } = setup();
        const pending = deferred<JsonValue>();
        const invoke = vi.fn(() => {
            const draft = getDocumentDraft(runtime, PANE)!;
            expect(draft).toMatchObject({ text: 'latest\ntext', revision: 'source:1', viewID: 'custom.editor' });
            expect(isRecoveredDocumentDraft(draft)).toBe(false);
            expect(Object.values(localStorage).some(value => value.includes(draft.id))).toBe(true);
            return pending.promise;
        });
        const editing = runDocumentEdit(runtime, PANE, 'latest\ntext', 'source:1', 'custom.editor', invoke);
        expect(invoke).toHaveBeenCalledOnce();
        const staged = getDocumentDraft(runtime, PANE);
        pending.resolve(snapshot('latest\ntext', 'source:2', true));
        await editing;
        expect(getDocumentDraft(runtime, PANE)).toEqual({ ...staged, applied: true });
        request.mockResolvedValueOnce(snapshot('latest\ntext', 'source:2', true)).mockResolvedValueOnce(snapshot('latest\ntext', 'source:3'));
        await prepareDocumentViewsClose(runtime, [PANE]);
        expect(request.mock.calls).toEqual([
            [runtime, 'document', { method: 'get', args: { paneID: PANE } }],
            [runtime, 'document', { method: 'save', args: { paneID: PANE, revision: 'source:2' } }]
        ]);
        expect(getDocumentDraft(runtime, PANE)).toBeNull();
    });

    it.each(['resolve', 'reject'] as const)('keeps a newer staged draft when an older edit %ss', async settle => {
        const { runtime } = setup();
        const pending = deferred<JsonValue>();
        const first = stageDocumentDraft(runtime, PANE, 'first', 'source:1', 'custom.editor');
        const editing = runDocumentEdit(runtime, PANE, first.text, 'source:1', first.viewID, () => pending.promise, first);
        const result = editing.catch(error => error);
        const latest = stageDocumentDraft(runtime, PANE, 'second, still queued', 'source:1', 'custom.editor');
        if (settle === 'resolve') pending.resolve(snapshot('first', 'source:2', true));
        else pending.reject(new Error('DOCUMENT_CONFLICT: remote writer changed the document'));
        await result;
        expect(getDocumentDraft(runtime, PANE)).toEqual(latest);
        clearDocumentDraft(runtime, PANE, first.id);
        expect(getDocumentDraft(runtime, PANE)).toEqual(latest);
    });

    it('preserves the rejected edit and reason without retrying against a fresh revision', async () => {
        const { runtime } = setup();
        const invoke = vi.fn().mockRejectedValue(new Error('DOCUMENT_CONFLICT: stale revision'));
        await expect(runDocumentEdit(runtime, PANE, 'local changes', 'source:1', 'custom.editor', invoke)).rejects.toThrow('DOCUMENT_CONFLICT');
        expect(getDocumentDraft(runtime, PANE)).toMatchObject({ text: 'local changes', revision: 'source:1', error: 'DOCUMENT_CONFLICT: stale revision' });
        expect(invoke).toHaveBeenCalledOnce();
        expect(request).not.toHaveBeenCalled();
    });

    it('retains a visible volatile draft and refuses plugin mutation if durable storage fails', async () => {
        const { runtime } = setup();
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota exceeded', 'QuotaExceededError'); });
        const invoke = vi.fn().mockResolvedValue(snapshot('unsaved'));
        await expect(runDocumentEdit(runtime, PANE, 'unsaved', 'source:1', 'custom.editor', invoke)).rejects.toThrow('Recovery storage is unavailable');
        expect(getDocumentDraft(runtime, PANE)).toMatchObject({ text: 'unsaved', volatile: true, error: expect.stringContaining('only held in this window') });
        expect(invoke).not.toHaveBeenCalled();
    });

    it('separates daemon owners, shares a daemon across transports, and migrates the pre-identity key', () => {
        const identity = `daemon-${crypto.randomUUID()}`;
        const { runtime: first } = setup();
        const { runtime: second } = setup(`other-${crypto.randomUUID()}`);
        const { runtime: alias } = setup(identity);
        const fallback = stageDocumentDraft(first, PANE, 'before identity', 'source:1', 'custom.editor');
        expect(getDocumentDraft(second, PANE)).toBeNull();
        daemonIDs.set(first, identity);
        expect(getDocumentDraft(first, PANE)).toEqual(fallback);
        const migrated = stageDocumentDraft(first, PANE, 'after identity', 'source:2', 'custom.editor');
        expect(getDocumentDraft(alias, PANE)).toEqual(migrated);
        expect(getDocumentDraft(second, PANE)).toBeNull();
        const fallbackKey = Object.keys(localStorage).find(key => key.includes(new URL(first.connection.target).origin) && key.endsWith(PANE));
        expect(fallbackKey).toBeUndefined();
        stageDocumentDraft(second, PANE, 'other daemon', 'other:1', 'custom.editor');
        expect(getDocumentDraft(first, PANE)).toEqual(migrated);
    });

    it('recovers after reload while keeping two window recovery records independent', async () => {
        const { runtime } = setup(`window-daemon-${crypto.randomUUID()}`);
        const firstWindow = sessionStorage.getItem('kelpi.document.window.v1');
        const firstDraft = stageDocumentDraft(runtime, PANE, 'window one', 'source:1', 'custom.editor');
        vi.resetModules();
        const reloaded = await import('./document-drafts');
        expect(reloaded.getDocumentDraft(runtime, PANE)).toEqual(firstDraft);
        expect(reloaded.isRecoveredDocumentDraft(firstDraft)).toBe(true);
        sessionStorage.setItem('kelpi.document.window.v1', crypto.randomUUID());
        vi.resetModules();
        const otherWindow = await import('./document-drafts');
        try {
            expect(otherWindow.getDocumentDraft(runtime, PANE)).toBeNull();
            otherWindow.stageDocumentDraft(runtime, PANE, 'window two', 'source:1', 'custom.editor');
            expect(getDocumentDraft(runtime, PANE)).toEqual(firstDraft);
            expect(otherWindow.getDocumentDraft(runtime, PANE)?.text).toBe('window two');
        } finally {
            otherWindow.clearDocumentDraft(runtime, PANE);
            if (firstWindow) sessionStorage.setItem('kelpi.document.window.v1', firstWindow);
            else sessionStorage.removeItem('kelpi.document.window.v1');
        }
    });
});

describe('preparing document views to close', () => {
    it('waits for accepted edits before reading and saving the daemon buffer', async () => {
        const { runtime } = setup();
        const pending = deferred<JsonValue>();
        const editing = runDocumentEdit(runtime, PANE, 'pending', 'source:1', 'custom.editor', () => pending.promise);
        request.mockResolvedValueOnce(snapshot('pending', 'source:2', true)).mockResolvedValueOnce(snapshot('pending', 'source:3'));
        const closing = prepareDocumentViewsClose(runtime, [PANE]);
        await Promise.resolve();
        expect(request).not.toHaveBeenCalled();
        pending.resolve(snapshot('pending', 'source:2', true));
        await Promise.all([editing, closing]);
        expect(getDocumentDraft(runtime, PANE)).toBeNull();
    });

    it('refuses close after a rejected edit leaves source text unapplied', async () => {
        const { runtime } = setup();
        const pending = deferred<JsonValue>();
        const editing = runDocumentEdit(runtime, PANE, 'local pending', 'source:1', 'custom.editor', () => pending.promise).catch(error => error);
        request.mockResolvedValue(snapshot('another writer', 'source:2'));
        const closing = prepareDocumentViewsClose(runtime, [PANE]);
        const rejection = expect(closing).rejects.toThrow('unapplied local edits');
        pending.reject(new Error('DOCUMENT_CONFLICT: stale revision'));
        await editing; await rejection;
        expect(request).toHaveBeenCalledOnce();
        expect(getDocumentDraft(runtime, PANE)).toMatchObject({ text: 'local pending', error: 'DOCUMENT_CONFLICT: stale revision' });
    });

    it('preserves the recovery record and refuses close on a failed save', async () => {
        const { runtime } = setup();
        const draft = stageDocumentDraft(runtime, PANE, 'accepted but unsaved', 'source:1', 'custom.editor');
        request.mockResolvedValueOnce(snapshot(draft.text, 'source:2', true)).mockRejectedValueOnce(new Error('disk is full'));
        await expect(prepareDocumentViewsClose(runtime, [PANE])).rejects.toThrow('disk is full');
        expect(getDocumentDraft(runtime, PANE)).toEqual(draft);
        request.mockResolvedValueOnce(snapshot(draft.text, 'source:2', true)).mockResolvedValueOnce(snapshot(draft.text, 'source:3', true));
        await expect(prepareDocumentViewsClose(runtime, [PANE])).rejects.toThrow(/save|unsaved|dirty/i);
        expect(getDocumentDraft(runtime, PANE)).toEqual(draft);
    });

    it('refuses close if another local edit is staged while save is in flight', async () => {
        const { runtime } = setup();
        const first = stageDocumentDraft(runtime, PANE, 'first', 'source:1', 'custom.editor');
        const saving = deferred<JsonValue>();
        request.mockResolvedValueOnce(snapshot(first.text, 'source:2', true)).mockReturnValueOnce(saving.promise);
        const closing = prepareDocumentViewsClose(runtime, [PANE]);
        const rejection = expect(closing).rejects.toThrow('changed while preparing to close');
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
        const latest = stageDocumentDraft(runtime, PANE, 'newer local changes', 'source:2', 'custom.editor');
        saving.resolve(snapshot(first.text, 'source:3'));
        await rejection;
        expect(getDocumentDraft(runtime, PANE)).toEqual(latest);
    });
});

describe('document command close guards', () => {
    it('flushes native input before any close frame and rejects an unapplied plugin draft', async () => {
        const h = setup();
        const content = createFakeContentApi();
        const flush = deferred<void>();
        vi.spyOn(content, 'flush').mockReturnValue(flush.promise);
        const remove = registerDocumentCloseGuard(h.runtime, content);
        stageDocumentDraft(h.runtime, PANE, 'still local', 'source:1', 'custom.editor');
        request.mockResolvedValue(snapshot('daemon version'));
        const closing = h.runtime.commands.closePane({ target: PANE });
        const rejection = expect(closing).rejects.toThrow('unapplied local edits');
        expect(content.flush).toHaveBeenCalledWith(PANE);
        expect(h.frames()).toHaveLength(0);
        expect(request).not.toHaveBeenCalled();
        flush.resolve(); await rejection;
        expect(h.frames()).toHaveLength(0);
        remove();
        const unguarded = h.runtime.commands.closePane({ target: PANE });
        expect(h.frames()).toHaveLength(1);
        h.answer(); await unguarded;
    });

    it('covers SDK command envelopes and workspace deletion including parked documents', async () => {
        const h = setup();
        const content = createFakeContentApi();
        const remove = registerDocumentCloseGuard(h.runtime, content);
        const sdk = h.runtime.commands.raw({ command: 'plugin', action: 'api', text: JSON.stringify({ lease: 'lease', method: 'command', args: { payload: { command: 'pane-close', target: PANE.toUpperCase(), workspace: 'Work' } } }) });
        await vi.waitFor(() => expect(h.frames()).toHaveLength(1));
        expect(content.flushes).toEqual([PANE]); h.answer(); await sdk;
        const deleting = h.runtime.commands.raw({ command: 'delete-workspace', workspace_id: 'w1' });
        await vi.waitFor(() => expect(h.frames()).toHaveLength(2));
        expect(content.flushes).toEqual([PANE, PANE, PARKED]); h.answer(); await deleting;
        remove();
    });

    it('keeps remote pane guards scoped and leaves terminal commands synchronous', async () => {
        const h = setup();
        const content = createFakeContentApi();
        const remove = registerDocumentCloseGuard(h.runtime, content, PANE);
        const terminal = h.runtime.commands.closePane({ target: TERMINAL });
        expect(h.frames()).toHaveLength(1); expect(content.flushes).toEqual([]); h.answer(); await terminal;
        const otherPane = h.runtime.commands.closePane({ target: PARKED });
        expect(h.frames()).toHaveLength(2); expect(content.flushes).toEqual([]); h.answer(); await otherPane;
        const deleting = h.runtime.commands.raw({ command: 'workspace-delete', name: 'Work' });
        await vi.waitFor(() => expect(h.frames()).toHaveLength(3));
        expect(content.flushes).toEqual([PANE]); h.answer(); await deleting;
        remove();
    });

    it('guards only cascade-deleted group members and protects their parked recovery drafts', async () => {
        const h = setup();
        h.state.dispatch({ type: 'create-group', id: 'group-one', name: 'Development', initialWorkspaceIDs: ['W1'], now: 5 });
        h.state.dispatch({ type: 'create-scratchpad', workspaceID: 'W2', paneID: 'outside-document', now: 6 });
        h.runtime.store.getState().applySnapshot(2, JSON.parse(JSON.stringify(h.state.getState())));
        const content = createFakeContentApi();
        const remove = registerDocumentCloseGuard(h.runtime, content);
        const keepingWorkspaces = h.runtime.commands.raw({ command: 'group-delete', name: 'Development' });
        expect(h.frames()).toHaveLength(1); expect(content.flushes).toEqual([]); h.answer(); await keepingWorkspaces;
        const deleting = h.runtime.commands.raw({ command: 'group-delete', name: 'GROUP-ONE', cascade: true });
        await vi.waitFor(() => expect(h.frames()).toHaveLength(2));
        expect(content.flushes).toEqual([PANE, PARKED]); h.answer(); await deleting;
        stageDocumentDraft(h.runtime, PARKED, 'unapplied parked edits', 'source:1', 'custom.editor');
        request.mockResolvedValue(snapshot('daemon source'));
        await expect(h.runtime.commands.raw({ command: 'group-delete', name: 'Development', cascade: true })).rejects.toThrow('unapplied local edits');
        expect(h.frames()).toHaveLength(2);
        expect(content.flushes).toEqual([PANE, PARKED, PANE, PARKED]);
        expect(request).toHaveBeenLastCalledWith(h.runtime, 'document', { method: 'get', args: { paneID: PARKED } });
        remove();
    });
});
