import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pluginObject, type JsonObject } from '../../protocol/src/index.js';
import { createKelpiAPI } from '../index.js';
import { createContentService } from '../../daemon/src/content/service.js';
import { inOperationScope } from '../../daemon/src/plugins/operations.js';
import { PluginService } from '../../daemon/src/plugins/service.js';
import { harness, id, NOW, seededState, W1, W2 } from '../../daemon/src/store/testing.js';

const PLUGIN = 'sample.document-renderers';
const MD = id('eeeeeeee', 11), SCRATCH = id('eeeeeeee', 12), DIFF = id('eeeeeeee', 13);
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function fixture(gated = false) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-document-renderers-'));
    const file = path.join(root, 'note.md'); fs.writeFileSync(file, '# Native source\n');
    const state = harness(seededState());
    state.dispatch(
        { type: 'open-markdown-pane', workspaceID: W1, paneID: MD, filePath: file, now: NOW },
        { type: 'create-scratchpad', workspaceID: W1, paneID: SCRATCH, now: NOW },
        { type: 'open-diff-pane', workspaceID: W1, paneID: DIFF, repoPath: root, now: NOW }
    );
    const content = createContentService({ store: state.store, watch: false, debounceMs: 60_000, git: { getDiff: async () => '@@ -1 +1 @@\n-before\n+after\n' } });
    const source = path.join(root, 'source'); fs.mkdirSync(path.join(source, 'ui'), { recursive: true });
    fs.writeFileSync(path.join(source, 'ui/index.html'), '<p>Document renderer</p>');
    const views = [
        ...(['markdown', 'scratchpad', 'diff'] as const).map(kind => ({ id: `${PLUGIN}.${kind}`, title: kind, entry: 'ui/index.html', placements: [`document.${kind}`], stateVersion: 2 })),
        { id: `${PLUGIN}.all`, title: 'All documents', entry: 'ui/index.html', placements: ['document.markdown', 'document.scratchpad', 'document.diff'], stateVersion: 1 },
        { id: `${PLUGIN}.pane`, title: 'Plugin pane', entry: 'ui/index.html', placements: ['pane'], stateVersion: 1 },
        { id: `${PLUGIN}.sidebar`, title: 'Sidebar', entry: 'ui/index.html', placements: ['sidebar.primary'], stateVersion: 1 }
    ];
    const manifest = { id: PLUGIN, name: 'Document renderers', version: '1.0.0', apiVersion: 1, trust: 'full', activation: 'on-demand', ...(gated ? { backend: 'backend.mjs' } : {}), contributes: { views } };
    fs.writeFileSync(path.join(source, 'kelpi.plugin.json'), JSON.stringify(manifest));
    if (gated) fs.writeFileSync(path.join(source, 'backend.mjs'), `export async function activate(api) {
        await api.storage.set('activation-entered', true);
        while (!await api.storage.get('activation-continue')) await new Promise(resolve => setTimeout(resolve, 10));
    }`);
    const options = { store: state.store, content, directory: path.join(root, 'installed'), command: async () => ({ ok: true }), broadcast: vi.fn() };
    const host = new PluginService(options);
    cleanups.push(async () => { await host.dispose(); content.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
    await host.install(source, true);
    const client = { daemonID: host.daemonID, clientID: 'document-window', windowID: 'document-window', workspaceID: W1 };
    const attach = (paneID: string, kind: string, service = host) => service.request('attach', { pluginID: PLUGIN, viewID: `${PLUGIN}.${kind}`, paneID }, client).then(pluginObject);
    const api = (attached: JsonObject, service = host) => createKelpiAPI(
        (method, args) => service.request('api', { lease: attached['lease']!, method, args: args as JsonObject }, client),
        () => ({ paneID: String(pluginObject(attached['context'])['paneID']) })
    );
    const pane = (paneID: string) => state.state().workspaces.flatMap(workspace => workspace.panes).find(pane => pane.id === paneID)!;
    const entered = () => vi.waitFor(async () => expect(await host.api(PLUGIN, 'storage.get', { key: 'activation-entered' }, client)).toBe(true));
    const proceed = () => host.api(PLUGIN, 'storage.set', { key: 'activation-continue', value: true }, client);
    return { root, file, source, manifest, host, options, state, content, client, attach, api, pane, entered, proceed };
}

describe('native document renderer attachment', () => {
    it('requires the exact document placement and preserves ordinary plugin pane ownership', async () => {
        const h = await fixture();
        for (const [kind, paneID] of [['markdown', MD], ['scratchpad', SCRATCH], ['diff', DIFF]] as const) {
            const attached = await h.attach(paneID, kind);
            expect(attached).toMatchObject({ state: {}, stateVersion: 2, context: { paneID, workspaceID: W1, viewID: `${PLUGIN}.${kind}` } });
            expect(h.pane(paneID)).toMatchObject({ id: paneID, type: kind });
            expect(h.pane(paneID).plugin).toBeUndefined();
            expect(await h.api(attached).documents.get()).toMatchObject({ paneID, kind });
            await expect(h.attach(paneID, 'pane')).rejects.toThrow('does not own');
            await expect(h.attach(paneID, 'sidebar')).rejects.toThrow('does not own');
        }
        await expect(h.attach(SCRATCH, 'markdown')).rejects.toThrow('does not own');
        await expect(h.attach(h.state.state().workspaces[0]!.panes[0]!.id, 'all')).rejects.toThrow('does not own');
        const opened = pluginObject(await h.host.request('open', { pluginID: PLUGIN, viewID: `${PLUGIN}.pane` }, h.client));
        const ownedPaneID = String(opened['paneID']);
        await h.attach(ownedPaneID, 'pane');
        await expect(h.attach(ownedPaneID, 'all')).rejects.toThrow('does not own');
    });

    it('stores renderer state independently of native source, pane descriptors, and other renderers', async () => {
        const h = await fixture();
        const attached = await h.attach(SCRATCH, 'scratchpad'), api = h.api(attached);
        const document = await api.documents.get();
        const edited = await api.documents.edit(SCRATCH, 'accepted native buffer', document.revision);
        const nativePane = structuredClone(h.pane(SCRATCH));
        await api.call('views.setState', { state: { selection: [2, 5], scrollTop: 80 } });
        expect(h.pane(SCRATCH)).toEqual(nativePane);
        expect(await api.documents.get()).toEqual(edited);
        expect(h.pane(SCRATCH).plugin).toBeUndefined();
        h.host.releaseClient(h.client.clientID);
        const restored = await h.attach(SCRATCH, 'scratchpad');
        expect(restored).toMatchObject({ stateVersion: 2, state: { selection: [2, 5], scrollTop: 80 } });
        const alternate = await h.attach(SCRATCH, 'all');
        expect(alternate['state']).toEqual({});
        await h.api(alternate).call('views.setState', { state: { preview: false } });
        expect((await h.attach(SCRATCH, 'scratchpad'))['state']).toEqual({ selection: [2, 5], scrollTop: 80 });
        expect((await h.attach(MD, 'all'))['state']).toEqual({});
        await h.host.dispose();
        const restarted = new PluginService(h.options); cleanups.push(() => restarted.dispose());
        expect(await h.attach(SCRATCH, 'scratchpad', restarted)).toMatchObject({ stateVersion: 2, state: { selection: [2, 5], scrollTop: 80 } });
        expect((await h.content.document(SCRATCH)).text).toBe('accepted native buffer');
        expect(h.pane(SCRATCH)).toEqual(nativePane);
    });

    it('retains a previous state version so an updated renderer can migrate its own UI state', async () => {
        const h = await fixture();
        const attached = await h.attach(MD, 'markdown');
        await h.api(attached).call('views.setState', { state: { cursor: 9 } });
        h.manifest.contributes.views.find(view => view.id === `${PLUGIN}.markdown`)!.stateVersion = 3;
        fs.writeFileSync(path.join(h.source, 'kelpi.plugin.json'), JSON.stringify(h.manifest));
        await h.host.install(h.source, true);
        await expect(h.api(attached).documents.get()).rejects.toThrow('expired');
        const updated = await h.attach(MD, 'markdown');
        expect(updated).toMatchObject({ stateVersion: 2, state: { cursor: 9 } });
        await h.api(updated).call('views.setState', { state: { selection: { from: 9, to: 9 } } });
        expect(await h.attach(MD, 'markdown')).toMatchObject({ stateVersion: 3, state: { selection: { from: 9, to: 9 } } });
    });

    it('revokes renderer access on disconnect, disable, and removal while keeping native documents usable', async () => {
        const h = await fixture();
        for (const action of ['disconnect', 'disable', 'remove'] as const) {
            const attached = await h.attach(SCRATCH, 'scratchpad'), api = h.api(attached);
            const initial = await api.documents.watch();
            await api.documents.edit(SCRATCH, `buffer before ${action}`, initial.state.revision);
            await api.call('views.setState', { state: { lastAction: action } });
            if (action === 'disconnect') h.host.releaseClient(h.client.clientID);
            else await h.host.request(action, { pluginID: PLUGIN });
            await expect(api.documents.get()).rejects.toThrow('expired');
            await expect(api.call('views.setState', { state: { lost: true } })).rejects.toThrow('expired');
            expect((await h.content.document(SCRATCH)).text).toBe(`buffer before ${action}`);
            expect(h.pane(SCRATCH)).toMatchObject({ id: SCRATCH, type: 'scratchpad' });
            expect(h.pane(SCRATCH).plugin).toBeUndefined();
            await h.content.setText(SCRATCH, `native after ${action}`);
            expect((await h.content.document(SCRATCH)).text).toBe(`native after ${action}`);
            if (action === 'disable') await h.host.request('enable', { pluginID: PLUGIN });
            if (action === 'remove') await h.host.install(h.source, true);
            expect((await h.attach(SCRATCH, 'scratchpad'))['state']).toEqual({ lastAction: action });
        }
    });

    it.each(['closed', 'parked', 'reused'] as const)('rejects a document pane that was %s during backend activation', async change => {
        const h = await fixture(true);
        const result = h.attach(MD, 'markdown').catch(error => error as Error);
        await h.entered();
        if (change === 'parked') h.state.dispatch({ type: 'park-pane', workspaceID: W1, paneID: MD });
        else {
            h.state.dispatch({ type: 'close-pane', workspaceID: W1, paneID: MD });
            if (change === 'reused') h.state.dispatch({ type: 'create-scratchpad', workspaceID: W1, paneID: MD, now: NOW + 1 });
        }
        await h.proceed();
        expect(await result).toEqual(expect.objectContaining({ message: expect.stringContaining('does not own') }));
        expect(h.host.list()[0]?.status).toBe('running');
        expect(await h.attach(SCRATCH, 'scratchpad')).toHaveProperty('lease');
    });

    it('rechecks plugin pane view ownership after backend activation', async () => {
        const h = await fixture(true);
        const opened = pluginObject(await h.host.request('open', { pluginID: PLUGIN, viewID: `${PLUGIN}.pane` }, h.client));
        const paneID = String(opened['paneID']);
        const result = h.attach(paneID, 'pane').catch(error => error as Error);
        await h.entered();
        h.state.dispatch({ type: 'set-plugin-pane-state', paneID, plugin: { pluginID: 'another.owner', viewID: 'another.owner.pane', stateVersion: 1, state: {} } });
        await h.proceed();
        expect(await result).toEqual(expect.objectContaining({ message: expect.stringContaining('does not own') }));
    });

    it('uses the current owning workspace when a document moves while its renderer activates', async () => {
        const h = await fixture(true);
        h.state.dispatch({ type: 'create-workspace', id: W2, paneID: id('dddddddd', 14), name: 'other', color: 'red', now: NOW });
        const attached = h.attach(MD, 'markdown');
        await h.entered();
        h.state.dispatch({ type: 'move-pane-to-workspace', paneID: MD, toWorkspaceID: W2 });
        await h.proceed();
        expect(await attached).toMatchObject({ context: { paneID: MD, workspaceID: W2 } });
    });

    it('cancels attachment immediately without interrupting another view awaiting the same backend', async () => {
        const h = await fixture(true), abort = new AbortController();
        const cancelled = inOperationScope({ trace: [], signal: abort.signal }, () => h.attach(MD, 'markdown')).catch(error => error as Error);
        const surviving = h.attach(SCRATCH, 'scratchpad');
        await h.entered();
        abort.abort();
        expect(await cancelled).toEqual(expect.objectContaining({ message: expect.stringContaining('cancelled') }));
        expect(h.host.list()[0]?.status).toBe('starting');
        await h.proceed();
        expect(await surviving).toMatchObject({ context: { paneID: SCRATCH } });
        expect(h.host.list()[0]?.status).toBe('running');
        expect(await h.attach(MD, 'markdown')).toHaveProperty('lease');
    });

    it('rejects cancelled state writes and requests from a different client before changing persisted state', async () => {
        const h = await fixture(), attached = await h.attach(MD, 'markdown');
        const request = { lease: attached['lease']!, method: 'views.setState', args: { state: { selection: 100 } } };
        const abort = new AbortController(); abort.abort();
        await expect(inOperationScope({ trace: [], signal: abort.signal }, () => h.host.request('api', request, h.client))).rejects.toThrow('cancelled');
        await expect(h.host.request('api', request, { ...h.client, clientID: 'another-window' })).rejects.toThrow('another client');
        expect((await h.attach(MD, 'markdown'))['state']).toEqual({});
        await h.host.request('api', request, h.client);
        expect((await h.attach(MD, 'markdown'))['state']).toEqual({ selection: 100 });
    });

    it('does not allocate leases when saved renderer state is malformed', async () => {
        const h = await fixture();
        const file = path.join(h.options.directory, 'data', PLUGIN, 'documents.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ [`${MD}:${PLUGIN}.markdown`]: { stateVersion: 2, state: 'malformed' } }));
        // Failed reloads must not exhaust the shared limit and block unrelated views.
        for (let attempt = 0; attempt < 130; attempt++) await expect(h.attach(MD, 'markdown')).rejects.toThrow('JSON object');
        expect(await h.attach(SCRATCH, 'scratchpad')).toHaveProperty('lease');
        fs.writeFileSync(file, JSON.stringify({ [`${MD}:${PLUGIN}.markdown`]: { stateVersion: 2, state: { recovered: true } } }));
        expect(await h.attach(MD, 'markdown')).toMatchObject({ stateVersion: 2, state: { recovered: true } });
    });
});
