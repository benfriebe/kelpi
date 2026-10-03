import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pluginObject, type JsonObject } from '../../protocol/src/index.js';
import { createKelpiAPI } from '../index.js';
import { createContentService } from '../../daemon/src/content/service.js';
import { PluginService } from '../../daemon/src/plugins/service.js';
import { PluginDocuments } from '../../daemon/src/plugins/documents.js';
import { harness, id, NOW, seededState, W1 } from '../../daemon/src/store/testing.js';
import { harness as paneHarness } from '../../daemon/src/handlers/pane/testing.js';

const MD = id('eeeeeeee', 1), SCRATCH = id('eeeeeeee', 2), DIFF = id('eeeeeeee', 3);
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-documents-'));
    const directory = path.join(root, 'notes'); fs.mkdirSync(directory);
    const file = path.join(directory, 'note.md'); fs.writeFileSync(file, '# Original\n');
    const state = harness(seededState());
    state.dispatch({ type: 'open-markdown-pane', workspaceID: W1, paneID: MD, filePath: file, now: NOW });
    state.dispatch({ type: 'create-scratchpad', workspaceID: W1, paneID: SCRATCH, now: NOW });
    state.dispatch({ type: 'open-diff-pane', workspaceID: W1, paneID: DIFF, repoPath: root, now: NOW });
    const content = createContentService({ store: state.store, watch: false, debounceMs: 60_000, git: { getDiff: async () => '@@ -1 +1 @@\n-before\n+after\n' } });
    const source = path.join(root, 'source'); fs.mkdirSync(path.join(source, 'ui'), { recursive: true });
    fs.writeFileSync(path.join(source, 'ui/index.html'), '<p>Documents</p>');
    fs.writeFileSync(path.join(source, 'kelpi.plugin.json'), JSON.stringify({ id: 'sample.documents', name: 'Documents', version: '1.0.0', apiVersion: 1, trust: 'full', contributes: { views: [{ id: 'sample.documents.view', title: 'Documents', entry: 'ui/index.html', placements: ['sidebar.primary'] }] } }));
    const broadcast = vi.fn();
    const host = new PluginService({ store: state.store, content, directory: path.join(root, 'installed'), command: async () => ({ ok: true }), broadcast });
    cleanups.push(async () => { await host.dispose(); content.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
    await host.install(source, true);
    const api = createKelpiAPI((method, args) => host.api('sample.documents', method, args as JsonObject, { daemonID: host.daemonID, paneID: SCRATCH }), () => ({ paneID: SCRATCH }));
    return { api, content, host, state, root, file, directory, broadcast };
}

describe('public document API over the authoritative daemon buffer', () => {
    it('shares native source, mode, autosave state and explicit saves without recreating a pane', async () => {
        const { api, content, file } = await fixture();
        const initial = await api.documents.get(MD);
        const editing = await api.documents.setMode(MD, 'edit', initial.revision);
        const changed = await api.documents.edit(MD, '# Changed\n', editing.revision);
        expect(changed).toMatchObject({ paneID: MD, text: '# Changed\n', dirty: true });
        expect((await content.state(MD)).text).toBe(changed.text);
        const saved = await api.documents.save(MD, changed.revision);
        expect(saved.dirty).toBe(false); expect(fs.readFileSync(file, 'utf8')).toBe('# Changed\n');
        expect((await api.documents.setMode(MD, 'view', saved.revision)).mode).toBe('view');
        expect((await api.documents.get()).paneID).toBe(SCRATCH);
    });

    it('rejects a competing edit before autosave, with an explicit conflict code and no retry', async () => {
        const { api, content } = await fixture();
        const initial = await api.documents.get(SCRATCH);
        const results = await Promise.allSettled([
            api.documents.edit(SCRATCH, 'first', initial.revision),
            api.documents.edit(SCRATCH, 'second', initial.revision)
        ]);
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'DOCUMENT_CONFLICT' } });
        expect((await content.state(SCRATCH)).text).toBe('first');
        await expect(api.documents.save(SCRATCH, initial.revision)).rejects.toMatchObject({ code: 'DOCUMENT_CONFLICT' });
    });

    it.each(['before editing', 'before saving'])('persists scratchpad edits when parked %s', async when => {
        const { api, state } = await fixture();
        const park = () => state.dispatch({ type: 'park-pane', workspaceID: W1, paneID: SCRATCH });
        if (when === 'before editing') park();
        const initial = await api.documents.get(SCRATCH);
        const edited = await api.documents.edit(SCRATCH, 'keep these parked notes', initial.revision);
        if (when === 'before saving') park();
        const saved = await api.documents.save(SCRATCH, edited.revision);
        expect(saved).toMatchObject({ text: 'keep these parked notes', dirty: false });
        expect(state.state().workspaces[0]!.parkedPanes.find(pane => pane.id === SCRATCH)?.scratchpadContent).toBe(saved.text);

        // Saving without a watch releases the edit buffer; reopening must read persisted text.
        state.dispatch({ type: 'unpark-pane', workspaceID: W1, paneID: SCRATCH });
        expect(await api.documents.get(SCRATCH)).toMatchObject({ text: saved.text, dirty: false });
    });

    it('detects native buffer changes and invalidates tokens after the content entry is released', async () => {
        const { api, content } = await fixture();
        const attached = await api.documents.watch(SCRATCH);
        await content.setText(SCRATCH, 'native edit');
        await expect(api.documents.edit(SCRATCH, 'stale plugin', attached.state.revision)).rejects.toMatchObject({ code: 'DOCUMENT_CONFLICT' });
        const current = await api.documents.get(SCRATCH);
        const saved = await api.documents.save(SCRATCH, current.revision);
        await api.documents.unwatch(attached.subscription);
        const reopened = await api.documents.get(SCRATCH);
        expect(reopened.text).toBe('native edit'); expect(reopened.revision).not.toBe(saved.revision);
        await expect(api.documents.edit(SCRATCH, 'old incarnation', saved.revision)).rejects.toMatchObject({ code: 'DOCUMENT_CONFLICT' });
    });

    it('preserves accepted edits and reports failed saves until storage is writable again', async () => {
        const { api, content, state, file, directory } = await fixture();
        const initial = await api.documents.get(MD), editing = await api.documents.setMode(MD, 'edit', initial.revision);
        const changed = await api.documents.edit(MD, 'must survive', editing.revision);
        fs.unlinkSync(file); fs.rmdirSync(directory); fs.writeFileSync(directory, 'not a directory');
        await expect(api.documents.save(MD, changed.revision)).rejects.toThrow();
        const failed = await api.documents.get(MD);
        expect(failed).toMatchObject({ text: 'must survive', dirty: true });
        await expect(api.documents.refresh(MD, failed.revision)).rejects.toThrow('pending');
        const pane = paneHarness(); Object.assign(pane.ctx, { store: state.store, prepareDocumentClose: (ids: readonly string[]) => content.prepareClose(ids) });
        expect(pane.run({ command: 'pane-close', target: MD }).only()).toMatchObject({ ok: false });
        expect(state.store.getState().workspaces[0]!.panes.some(pane => pane.id === MD)).toBe(true);
        fs.unlinkSync(directory); fs.mkdirSync(directory);
        const saved = await api.documents.save(MD, (await api.documents.get(MD)).revision);
        expect(saved.dirty).toBe(false); expect(fs.readFileSync(file, 'utf8')).toBe('must survive');
        expect(pane.run({ command: 'pane-close', target: MD }).only()).toMatchObject({ ok: true });
    });

    it('provides real diff source, refuses diff edits, and bounds edits before mutation', async () => {
        const { api } = await fixture();
        const diff = await api.documents.get(DIFF);
        expect(diff.text).toContain('+after'); expect(diff.kind).toBe('diff');
        await expect(api.documents.edit(DIFF, 'bad', diff.revision)).rejects.toThrow('read-only');
        const scratch = await api.documents.get(SCRATCH);
        await expect(api.documents.edit(SCRATCH, 'x'.repeat(200 * 1024), scratch.revision)).rejects.toThrow('192 KiB');
        expect((await api.documents.get(SCRATCH)).text).toBe('');
        await expect(api.call('documents.edit', { paneID: SCRATCH, text: 'unguarded' })).rejects.toThrow('revision');
    });

    it('owns subscriptions by view lease and releases them on disconnect and disable', async () => {
        const { host, content } = await fixture();
        const stopped = vi.fn(), subscribe = content.subscribe.bind(content);
        vi.spyOn(content, 'subscribe').mockImplementation(async (...args) => {
            const result = await subscribe(...args);
            return { ...result, unsubscribe() { stopped(); result.unsubscribe(); } };
        });
        const client = { daemonID: host.daemonID, clientID: 'client' };
        const attach = () => host.request('attach', { pluginID: 'sample.documents', viewID: 'sample.documents.view' }, client).then(pluginObject);
        const a = await attach(), b = await attach();
        const call = (lease: unknown, method: string, args: JsonObject) => host.request('api', { lease: String(lease), method, args }, client);
        const subscribed = pluginObject(await call(a['lease'], 'documents.watch', { paneID: SCRATCH }));
        await call(b['lease'], 'documents.unwatch', { subscription: subscribed['subscription']! });
        expect(stopped).not.toHaveBeenCalled();
        const snapshot = pluginObject(subscribed['state']);
        await call(a['lease'], 'documents.edit', { paneID: SCRATCH, text: 'retained', revision: snapshot['revision']! });
        host.releaseClient('client');
        expect(stopped).toHaveBeenCalledTimes(1);
        await expect(call(a['lease'], 'documents.get', { paneID: SCRATCH })).rejects.toThrow('expired');
        expect((await content.document(SCRATCH)).text).toBe('retained');
        await host.request('disable', { pluginID: 'sample.documents' });
        expect((await content.document(SCRATCH)).text).toBe('retained');
    });

    it('cancels pending subscriptions and edits without applying abandoned requests', async () => {
        const { content } = await fixture();
        const docs = new PluginDocuments(content, () => {}), abort = new AbortController();
        const initial = await content.document(SCRATCH);
        abort.abort();
        await expect(docs.call('edit', { paneID: SCRATCH, revision: initial.revision, text: 'abandoned' }, abort.signal)).rejects.toThrow('cancelled');
        await expect(docs.watch({ pluginID: 'sample.documents' }, { paneID: SCRATCH }, abort.signal)).rejects.toThrow('cancelled');
        expect((await content.document(SCRATCH)).text).toBe('');
        docs.release(() => true);
    });
});

describe('csv table documents API (#324)', () => {
    function stub(reply: (method: string, args: JsonObject) => unknown = () => ({ ok: true })) {
        const calls: { method: string; args: JsonObject }[] = [];
        const api = createKelpiAPI(async (method, args) => { calls.push({ method, args: args as JsonObject }); return reply(method, args as JsonObject); }, () => ({ paneID: 'context-pane' }));
        return { api, calls };
    }

    it('maps every csv call to its documents method with camelCase arguments', async () => {
        const { api, calls } = stub();
        await api.documents.csv.state();
        await api.documents.csv.state('P');
        await api.documents.csv.rows('P', { start: 10, count: 50 });
        await api.documents.csv.rows('P', { start: 0, count: 5, columnStart: 2, columnCount: 3 });
        await api.documents.csv.edit('P', 'i:3', [{ op: 'set-cell', row: 1, column: 0, value: 'x' }, { op: 'undo' }]);
        await api.documents.csv.sort('P', 4, 'desc');
        await api.documents.csv.sort('P', null);
        await api.documents.csv.find('P', 'needle');
        await api.documents.csv.findStep('P', 'needle', 'previous', { view: 3, column: 1 });
        await api.documents.csv.findStep('P', 'needle', 'next');
        await api.documents.csv.setHeaderRow('P', false);
        await api.documents.csv.discard('P');
        expect(calls).toEqual([
            { method: 'documents.csv-state', args: { paneID: 'context-pane' } },
            { method: 'documents.csv-state', args: { paneID: 'P' } },
            { method: 'documents.csv-rows', args: { paneID: 'P', start: 10, count: 50 } },
            { method: 'documents.csv-rows', args: { paneID: 'P', start: 0, count: 5, columnStart: 2, columnCount: 3 } },
            { method: 'documents.csv-edit', args: { paneID: 'P', generation: 'i:3', ops: [{ op: 'set-cell', row: 1, column: 0, value: 'x' }, { op: 'undo' }] } },
            { method: 'documents.csv-sort', args: { paneID: 'P', column: 4, direction: 'desc' } },
            // `null` clears the sort, so it is sent rather than dropped like an absent option.
            { method: 'documents.csv-sort', args: { paneID: 'P', column: null } },
            { method: 'documents.csv-find', args: { paneID: 'P', query: 'needle' } },
            { method: 'documents.csv-find-step', args: { paneID: 'P', query: 'needle', direction: 'previous', from: { view: 3, column: 1 } } },
            { method: 'documents.csv-find-step', args: { paneID: 'P', query: 'needle', direction: 'next' } },
            { method: 'documents.csv-header-row', args: { paneID: 'P', on: false } },
            { method: 'documents.csv-discard', args: { paneID: 'P' } }
        ]);
    });

    it.each(['CSV_STALE', 'CSV_GONE', 'CSV_READ_ONLY', 'CSV_BUSY', 'CSV_INVALID', 'DOCUMENT_CONFLICT'])('surfaces a %s daemon error as a KelpiError code', async code => {
        const { api } = stub(() => { throw new Error(`${code}: the daemon said no`); });
        await expect(api.documents.csv.edit('P', 'i:0', [{ op: 'undo' }])).rejects.toMatchObject({ name: 'KelpiError', code, method: 'documents.csv-edit', message: `${code}: the daemon said no` });
    });

    it('keeps other failures as transport errors', async () => {
        const { api } = stub(() => { throw new Error('CSV_SOMETHING: not a known code'); });
        await expect(api.documents.csv.rows('P', { start: 0, count: 1 })).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' });
    });
});
