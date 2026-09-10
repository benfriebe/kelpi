import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocumentSnapshot, JsonObject, JsonValue } from '@kelpi/protocol';
import { KelpiError } from '../../../plugin-sdk/index.js';
import { createContentService } from '../../../daemon/src/content/service';
import { PluginDocuments } from '../../../daemon/src/plugins/documents';
import { harness, seededState, W1, W2, NOW } from '../../../daemon/src/store/testing';
import type { KelpiRuntime } from '../state';
import { clearDocumentDraft, getDocumentDraft, runDocumentEdit, stageDocumentDraft } from '../plugins/document-drafts';

const paneID = 'aaaaaaaa-2222-4333-8444-555555555555', viewID = 'example.document-lab.editor';
const source = fs.readFileSync(path.resolve('examples/plugins/document-lab/ui/editor.js'), 'utf8');
const html = fs.readFileSync(path.resolve('examples/plugins/document-lab/ui/index.html'), 'utf8');
const cleanups: (() => void)[] = [];
afterEach(() => {
    dispatchEvent(new Event('pagehide'));
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
    document.body.replaceWith(document.createElement('body'));
});

async function fixture(latency = 100, kind: 'scratchpad' | 'markdown' = 'scratchpad') {
    vi.useFakeTimers();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-document-lab-'));
    const store = harness(seededState());
    if (kind === 'markdown') {
        const file = path.join(directory, 'notes.md'); fs.writeFileSync(file, 'Original source\n');
        store.dispatch({ type: 'open-markdown-pane', workspaceID: W1, paneID, filePath: file, now: NOW });
    } else store.dispatch({ type: 'create-scratchpad', workspaceID: W1, paneID, now: NOW });
    const content = createContentService({ store: store.store, watch: false });
    if (kind === 'markdown') await content.setMode(paneID, 'edit');
    const listeners = new Map<string, (event: { data: JsonObject }) => unknown>();
    const methods = new PluginDocuments(content, (name, data) => {
        setTimeout(() => { void listeners.get(name)?.({ data }); }, latency);
    });
    const owner = { pluginID: 'example.document-lab', lease: 'document-view' };
    const runtime = { connection: { target: `ws://${crypto.randomUUID()}.test/ws` } } as KelpiRuntime;
    cleanups.push(() => {
        methods.release(() => true); content.dispose(); clearDocumentDraft(runtime, paneID);
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const delay = () => new Promise(resolve => setTimeout(resolve, latency));
    // Keep staging in the host window. Daemon requests, replies and watch invalidations
    // incur network latency, while the real content service uses its 500 ms autosave.
    const remote = async (method: string, args: JsonObject = {}): Promise<JsonValue> => {
        await delay();
        let result: JsonValue = null, failure: unknown;
        try { result = await methods.call(method, { paneID, ...args }); }
        catch (error) { failure = error; }
        await delay();
        if (failure) throw failure;
        return result;
    };
    const applyDraft = vi.fn(async (id: string, revision: string) => {
        const draft = getDocumentDraft(runtime, paneID);
        if (!draft || draft.id !== id) throw new KelpiError('A newer draft replaced this edit.', { code: 'DOCUMENT_DRAFT_SUPERSEDED' });
        try {
            return await runDocumentEdit(runtime, paneID, draft.text, revision, viewID,
                () => remote('edit', { text: draft.text, revision }), draft);
        } catch (error) {
            const message = (error as Error).message, code = message.split(':')[0];
            if (code === 'DOCUMENT_CONFLICT') throw new KelpiError(message, { code, method: 'documents.applyDraft', cause: error });
            throw error;
        }
    });
    const stage = vi.fn(async (text: string, revision: string) => {
        const draft = stageDocumentDraft(runtime, paneID, text, revision, viewID);
        return { id: draft.id };
    });
    vi.stubGlobal('kelpi', {
        ready: Promise.resolve(), state: {}, setState: async () => {},
        events: { on: (name: string, listener: (event: { data: JsonObject }) => unknown) => {
            listeners.set(name, listener); return () => listeners.delete(name);
        } },
        documents: {
            // Establish the initial subscription before simulating input on the connection.
            watch: () => methods.watch(owner, { paneID }),
            unwatch: async (subscription: string) => methods.unwatch(owner, subscription),
            get: () => remote('get'), stage, applyDraft,
        },
    });
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1]!;
    // Execute the shipped example itself, including its event handlers and asynchronous queue.
    await new Function(`return (async () => {\n${source}\n})();`)();
    expect(document.body.dataset['ready']).toBe('true');
    const editor = document.getElementById('editor') as HTMLTextAreaElement;
    return {
        store, content, applyDraft, stage, editor,
        draft: () => getDocumentDraft(runtime, paneID),
        snapshot: () => content.document(paneID),
        input(text: string) { editor.value = text; editor.dispatchEvent(new Event('input')); },
        async competingEdit(text: string) {
            const current = await content.document(paneID);
            return methods.call('edit', { paneID, text, revision: current.revision }) as unknown as Promise<DocumentSnapshot>;
        },
    };
}

function expectReady() {
    expect(document.getElementById('problem')!.textContent).toBe('');
    expect(document.body.dataset['pending']).toBe('false');
    expect(document.getElementById('status')!.textContent).toBe('Saved');
    expect((document.getElementById('editor') as HTMLTextAreaElement).readOnly).toBe(false);
}

describe('Document Lab guarded input', () => {
    it.each([{ latency: 600, secondInputAt: 300 }, { latency: 100, secondInputAt: 550 }])(
        'reconciles its own autosave at $latency ms one-way latency', async ({ latency, secondInputAt }) => {
            const f = await fixture(latency);
            f.input('first'); await vi.advanceTimersByTimeAsync(secondInputAt); f.input('second');
            await vi.advanceTimersByTimeAsync(8000);
            expectReady();
            expect(await f.snapshot()).toMatchObject({ text: 'second', dirty: false });
            expect(f.editor.value).toBe('second');
            expect(f.draft()).toMatchObject({ text: 'second', applied: true });
        });

    it('keeps a competing source and the local recovery draft when reconciliation finds different text', async () => {
        const f = await fixture();
        f.input('Local input'); await vi.advanceTimersByTimeAsync(50);
        await f.competingEdit('Other writer');
        await vi.advanceTimersByTimeAsync(1500);
        expect(await f.snapshot()).toMatchObject({ text: 'Other writer', dirty: false });
        expect(f.editor.value).toBe('Local input'); expect(f.editor.readOnly).toBe(true);
        expect(f.draft()).toMatchObject({ text: 'Local input', error: expect.stringContaining('DOCUMENT_CONFLICT') });
        expect(f.applyDraft).toHaveBeenCalledOnce();
    });

    it('refuses a concurrent source change after the reconciliation read instead of retrying again', async () => {
        const f = await fixture();
        f.input('first'); await vi.advanceTimersByTimeAsync(550); f.input('second');
        // The stale second write rejects at 750 ms; its same-source read returns at 950 ms.
        // A competing write at 1000 ms precedes the guarded retry arriving at 1050 ms.
        await vi.advanceTimersByTimeAsync(450); await f.competingEdit('Concurrent winner');
        await vi.advanceTimersByTimeAsync(1500);
        expect(await f.snapshot()).toMatchObject({ text: 'Concurrent winner', dirty: false });
        expect(f.editor.value).toBe('second'); expect(f.editor.readOnly).toBe(true);
        expect(f.draft()).toMatchObject({ text: 'second', error: expect.stringContaining('DOCUMENT_CONFLICT') });
        expect(f.applyDraft).toHaveBeenCalledTimes(3);
    });

    it('refuses a mode change even when the source is unchanged', async () => {
        const f = await fixture(100, 'markdown');
        const original = await f.snapshot();
        f.input('Local input'); await vi.advanceTimersByTimeAsync(50);
        await f.content.setMode(paneID, 'view', { revision: original.revision });
        await vi.advanceTimersByTimeAsync(1000);
        expect(await f.snapshot()).toMatchObject({ text: original.text, mode: 'view' });
        expect(f.editor.readOnly).toBe(true); expect(f.editor.value).toBe('Local input');
        expect(f.draft()?.text).toBe('Local input'); expect(f.applyDraft).toHaveBeenCalledOnce();
    });

    it('refuses a workspace change even when the source and mode are unchanged', async () => {
        const f = await fixture();
        const original = await f.snapshot();
        f.input('Local input'); await vi.advanceTimersByTimeAsync(50);
        f.store.dispatch({ type: 'create-workspace', id: W2, paneID: 'other-terminal', name: 'Other', now: NOW });
        f.store.dispatch({ type: 'move-pane-to-workspace', paneID, toWorkspaceID: W2 });
        await vi.advanceTimersByTimeAsync(1000);
        expect(await f.snapshot()).toMatchObject({ text: original.text, mode: 'edit', workspaceID: W2 });
        expect(f.editor.readOnly).toBe(true); expect(f.editor.value).toBe('Local input');
        expect(f.draft()?.text).toBe('Local input'); expect(f.applyDraft).toHaveBeenCalledOnce();
    });

    it('preserves and applies the newest staged input when it supersedes a reconciling draft', async () => {
        const f = await fixture();
        f.input('first'); await vi.advanceTimersByTimeAsync(550); f.input('second');
        // More input arrives while the rejected second write is reading a fresh snapshot.
        await vi.advanceTimersByTimeAsync(250);
        for (let i = 1; i <= 24; i++) f.input(`New input ${i}`);
        const newest = f.draft()!;
        await vi.advanceTimersByTimeAsync(2000);
        expectReady(); expect(await f.snapshot()).toMatchObject({ text: 'New input 24', dirty: false });
        expect(f.editor.value).toBe('New input 24');
        expect(f.draft()).toMatchObject({ id: newest.id, text: newest.text, applied: true });
        expect(f.stage).toHaveBeenCalledTimes(26);
    });
});
