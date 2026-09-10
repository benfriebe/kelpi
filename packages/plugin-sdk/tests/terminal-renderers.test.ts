import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pluginObject, type JsonObject, type PluginContext } from '../../protocol/src/index.js';
import { createKelpiAPI } from '../index.js';
import { inOperationScope } from '../../daemon/src/plugins/operations.js';
import { PluginService } from '../../daemon/src/plugins/service.js';
import { harness, id, NOW, seededState, W1, W2 } from '../../daemon/src/store/testing.js';
import { stubPty } from '../../daemon/src/ws/testing.js';

const PLUGIN = 'sample.terminal-renderers';
const P1 = id('dddddddd', 1), P2 = id('dddddddd', 2);
const EDITOR = id('eeeeeeee', 1), MD = id('eeeeeeee', 2), SCRATCH = id('eeeeeeee', 3), DIFF = id('eeeeeeee', 4), WEB = id('eeeeeeee', 5);
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function fixture(gated = false) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-terminal-renderers-'));
    const file = path.join(root, 'note.md'); fs.writeFileSync(file, '# Native document\n');
    const state = harness(seededState(W1, P1));
    state.dispatch(
        { type: 'split-pane', workspaceID: W1, paneID: P2, direction: 'horizontal', now: NOW },
        { type: 'open-markdown-pane', workspaceID: W1, paneID: EDITOR, filePath: file, now: NOW },
        { type: 'set-markdown-editing', workspaceID: W1, paneID: EDITOR, editing: true, externalEditorCommand: `vim ${file}` },
        { type: 'open-markdown-pane', workspaceID: W1, paneID: MD, filePath: path.join(root, 'other.md'), now: NOW },
        { type: 'create-scratchpad', workspaceID: W1, paneID: SCRATCH, now: NOW },
        { type: 'open-diff-pane', workspaceID: W1, paneID: DIFF, repoPath: root, now: NOW },
        { type: 'open-web-pane', workspaceID: W1, paneID: WEB, tabID: id('ffffffff', 1), url: 'https://example.com', now: NOW }
    );
    const pty = stubPty();
    for (const paneID of [P1, P2, EDITOR]) pty.manager.spawn({ paneID, cwd: root, env: [], cols: 80, rows: 24 });
    const kill = vi.spyOn(pty.manager, 'kill'), killAll = vi.spyOn(pty.manager, 'killAll');
    const source = path.join(root, 'source'); fs.mkdirSync(path.join(source, 'ui'), { recursive: true });
    fs.writeFileSync(path.join(source, 'ui/index.html'), '<p>Terminal renderer</p>');
    const views = [
        { id: `${PLUGIN}.terminal`, title: 'Terminal', entry: 'ui/index.html', placements: ['terminal'], stateVersion: 2 },
        { id: `${PLUGIN}.alternate`, title: 'Alternate terminal', entry: 'ui/index.html', placements: ['terminal'], stateVersion: 1 },
        { id: `${PLUGIN}.document`, title: 'Document', entry: 'ui/index.html', placements: ['document.markdown'], stateVersion: 1 },
        { id: `${PLUGIN}.pane`, title: 'Plugin pane', entry: 'ui/index.html', placements: ['pane'], stateVersion: 1 },
        { id: `${PLUGIN}.other-pane`, title: 'Other plugin pane', entry: 'ui/index.html', placements: ['pane'], stateVersion: 1 },
        { id: `${PLUGIN}.sidebar`, title: 'Sidebar', entry: 'ui/index.html', placements: ['sidebar.primary'], stateVersion: 1 }
    ];
    const manifest = { id: PLUGIN, name: 'Terminal renderers', version: '1.0.0', apiVersion: 1, trust: 'full', activation: 'on-demand', ...(gated ? { backend: 'backend.mjs' } : {}), contributes: { views } };
    fs.writeFileSync(path.join(source, 'kelpi.plugin.json'), JSON.stringify(manifest));
    if (gated) fs.writeFileSync(path.join(source, 'backend.mjs'), `export async function activate(api) {
        await api.storage.set('activation-entered', true);
        while (!await api.storage.get('activation-continue')) await new Promise(resolve => setTimeout(resolve, 10));
    }`);
    const command = vi.fn(async () => ({ ok: true }));
    const options = { store: state.store, pty: pty.manager, directory: path.join(root, 'installed'), command, broadcast: vi.fn() };
    const host = new PluginService(options);
    cleanups.push(async () => { await host.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
    await host.install(source, true);
    const client = { daemonID: host.daemonID, clientID: 'terminal-window', windowID: 'terminal-window', workspaceID: W1 };
    const attach = (paneID = P1, kind = 'terminal', service = host) => service.request('attach', { pluginID: PLUGIN, viewID: `${PLUGIN}.${kind}`, paneID }, client).then(pluginObject);
    const api = (attached: JsonObject, service = host) => createKelpiAPI(
        (method, args) => service.request('api', { lease: attached['lease']!, method, args: args as JsonObject }, client),
        () => ({ paneID: String(pluginObject(attached['context'])['paneID']) })
    );
    const pane = (paneID: string) => state.state().workspaces.flatMap(workspace => workspace.panes).find(pane => pane.id === paneID)!;
    const entered = () => vi.waitFor(async () => expect(await host.api(PLUGIN, 'storage.get', { key: 'activation-entered' }, client)).toBe(true));
    const proceed = () => host.api(PLUGIN, 'storage.set', { key: 'activation-continue', value: true }, client);
    return { root, file, source, manifest, host, options, state, client, attach, api, pane, entered, proceed, pty, kill, killAll, command };
}

describe('native terminal renderer attachment', () => {
    it('attaches only terminal placements to shells and active external editor panes without changing native ownership', async () => {
        const h = await fixture();
        for (const paneID of [P1, P2, EDITOR]) {
            const native = structuredClone(h.pane(paneID));
            expect(await h.attach(paneID)).toMatchObject({ state: {}, stateVersion: 2, context: { paneID, workspaceID: W1, viewID: `${PLUGIN}.terminal` } });
            expect(h.pane(paneID)).toEqual(native);
            expect(h.pane(paneID).plugin).toBeUndefined();
            for (const view of ['pane', 'sidebar']) await expect(h.attach(paneID, view)).rejects.toThrow('does not own');
        }
        for (const paneID of [MD, SCRATCH, DIFF, WEB]) await expect(h.attach(paneID)).rejects.toThrow('does not own');
        // Document APIs and replacement registrations remain usable during external edits.
        expect(await h.attach(EDITOR, 'document')).toHaveProperty('lease');
        expect(h.pty.spawns).toHaveLength(3);
        expect(h.kill).not.toHaveBeenCalled(); expect(h.killAll).not.toHaveBeenCalled(); expect(h.command).not.toHaveBeenCalled();
    });

    it('keeps plugin pane attachment and state writes bound to the exact registered descriptor', async () => {
        const h = await fixture();
        const opened = pluginObject(await h.host.request('open', { pluginID: PLUGIN, viewID: `${PLUGIN}.pane` }, h.client));
        const paneID = String(opened['paneID']), attached = await h.attach(paneID, 'pane');
        await expect(h.attach(paneID)).rejects.toThrow('does not own');
        h.state.dispatch({ type: 'set-plugin-pane-state', paneID, plugin: { pluginID: PLUGIN, viewID: `${PLUGIN}.other-pane`, stateVersion: 1, state: { owner: 'other' } } });
        await expect(h.api(attached).call('views.setState', { state: { overwritten: true } })).rejects.toThrow('does not own');
        expect(h.pane(paneID).plugin?.state).toEqual({ owner: 'other' });
        expect(await h.attach(paneID, 'other-pane')).toMatchObject({ state: { owner: 'other' } });
    });

    it('persists independent UI state per pane and renderer across detach and restart while preserving process and document state', async () => {
        const h = await fixture(), native = structuredClone(h.pane(EDITOR));
        const terminal = await h.attach(EDITOR), alternate = await h.attach(EDITOR, 'alternate');
        await h.api(terminal).call('views.setState', { state: { selection: [2, 8], scroll: 64 } });
        await h.api(alternate).call('views.setState', { state: { font: 15 } });
        expect(h.pane(EDITOR)).toEqual(native);
        expect(fs.readFileSync(h.file, 'utf8')).toBe('# Native document\n');
        expect((await h.attach(P1))['state']).toEqual({});
        h.host.releaseClient(h.client.clientID);
        expect(await h.attach(EDITOR)).toMatchObject({ stateVersion: 2, state: { selection: [2, 8], scroll: 64 } });
        expect(await h.attach(EDITOR, 'alternate')).toMatchObject({ stateVersion: 1, state: { font: 15 } });
        await h.host.dispose();
        const restarted = new PluginService(h.options); cleanups.push(() => restarted.dispose());
        expect(await h.attach(EDITOR, 'terminal', restarted)).toMatchObject({ stateVersion: 2, state: { selection: [2, 8], scroll: 64 } });
        expect(h.pane(EDITOR)).toEqual(native);
        for (const paneID of [P1, P2, EDITOR]) expect(h.pty.manager.has(paneID)).toBe(true);
        expect(h.pty.spawns).toHaveLength(3);
        expect(h.pty.writes).toEqual([]); expect(h.pty.resizes).toEqual([]);
        expect(h.kill).not.toHaveBeenCalled(); expect(h.killAll).not.toHaveBeenCalled();
    });

    it('returns the saved version to a replacement plugin so it can migrate UI state explicitly', async () => {
        const h = await fixture(), attached = await h.attach();
        await h.api(attached).call('views.setState', { state: { scroll: 12 } });
        h.manifest.contributes.views[0]!.stateVersion = 3;
        fs.writeFileSync(path.join(h.source, 'kelpi.plugin.json'), JSON.stringify(h.manifest));
        await h.host.install(h.source, true);
        await expect(h.api(attached).call('views.setState', { state: { stale: true } })).rejects.toThrow('expired');
        const updated = await h.attach();
        expect(updated).toMatchObject({ stateVersion: 2, state: { scroll: 12 } });
        await h.api(updated).call('views.setState', { state: { viewport: { scroll: 12 } } });
        expect(await h.attach()).toMatchObject({ stateVersion: 3, state: { viewport: { scroll: 12 } } });
    });

    it('scopes state writes and release to the exact attached view without allowing a stale lease to redirect state', async () => {
        const h = await fixture(), first = await h.attach(), second = await h.attach(P2);
        const request = { lease: first['lease']!, method: 'views.setState', args: { state: { scroll: 7 } } };
        await expect(h.host.request('api', request, { ...h.client, clientID: 'other-window' })).rejects.toThrow('another client');
        const context = pluginObject(first['context']) as unknown as PluginContext;
        await expect(h.host.api(PLUGIN, 'views.setState', request.args, { ...context, paneID: P2 }, String(first['lease']))).rejects.toThrow('expired');
        await expect(h.host.api(PLUGIN, 'views.setState', request.args, context)).rejects.toThrow('attached view');
        const abort = new AbortController(); abort.abort();
        await expect(inOperationScope({ trace: [], signal: abort.signal }, () => h.host.request('api', request, h.client))).rejects.toThrow('cancelled');
        await h.host.request('release', { lease: first['lease']! }, h.client);
        await expect(h.host.api(PLUGIN, 'views.setState', request.args, context, String(first['lease']))).rejects.toThrow('expired');
        await h.api(second).call('views.setState', { state: { scroll: 9 } });
        expect((await h.attach())['state']).toEqual({});
        expect((await h.attach(P2))['state']).toEqual({ scroll: 9 });
    });

    it.each(['parked', 'closed', 'editor-ended'] as const)('expires a renderer when its terminal becomes %s and requires a fresh attachment after returning', async change => {
        const h = await fixture(), paneID = change === 'editor-ended' ? EDITOR : P1;
        const attached = await h.attach(paneID), api = h.api(attached);
        await api.call('views.setState', { state: { retained: true } });
        if (change === 'editor-ended') h.state.dispatch({ type: 'set-markdown-editing', workspaceID: W1, paneID, editing: false });
        else h.state.dispatch({ type: change === 'parked' ? 'park-pane' : 'close-pane', workspaceID: W1, paneID });
        await expect(api.call('views.setState', { state: { stale: true } })).rejects.toThrow('expired');
        await expect(h.attach(paneID)).rejects.toThrow('does not own');
        if (change === 'parked') h.state.dispatch({ type: 'unpark-pane', workspaceID: W1, paneID });
        else if (change === 'closed') h.state.dispatch({ type: 'reopen-closed-pane', workspaceID: W1, paneID, now: NOW + 1000 });
        else h.state.dispatch({ type: 'set-markdown-editing', workspaceID: W1, paneID, editing: true, externalEditorCommand: `vim ${h.file}` });
        await expect(api.call('state.snapshot')).rejects.toThrow('expired');
        expect(await h.attach(paneID)).toMatchObject({ state: { retained: true } });
        expect(h.kill).not.toHaveBeenCalled(); expect(h.killAll).not.toHaveBeenCalled();
    });

    it('revokes on disconnect, reload, disable, and removal without touching native processes', async () => {
        const h = await fixture();
        for (const action of ['disconnect', 'reload', 'disable', 'remove'] as const) {
            const attached = await h.attach(), api = h.api(attached);
            await api.call('views.setState', { state: { lastAction: action } });
            if (action === 'disconnect') h.host.releaseClient(h.client.clientID);
            else await h.host.request(action, { pluginID: PLUGIN });
            await expect(api.call('state.snapshot')).rejects.toThrow('expired');
            expect(h.pane(P1)).toMatchObject({ id: P1, type: 'shell' });
            expect(h.pane(P1).plugin).toBeUndefined();
            expect(h.pty.manager.has(P1)).toBe(true);
            if (action === 'disable') await h.host.request('enable', { pluginID: PLUGIN });
            if (action === 'remove') await h.host.install(h.source, true);
            expect((await h.attach())['state']).toEqual({ lastAction: action });
        }
        expect(h.kill).not.toHaveBeenCalled(); expect(h.killAll).not.toHaveBeenCalled();
    });

    it.each(['closed', 'parked', 'retyped', 'recreated', 'editor-ended', 'editor-replaced'] as const)('rechecks terminal identity after it is %s during backend activation', async change => {
        const h = await fixture(true), paneID = change.startsWith('editor-') ? EDITOR : P1;
        const result = h.attach(paneID).catch(error => error as Error);
        await h.entered();
        if (change === 'editor-ended' || change === 'editor-replaced') h.state.dispatch({ type: 'set-markdown-editing', workspaceID: W1, paneID, editing: change === 'editor-replaced', externalEditorCommand: `nvim ${h.file}` });
        else if (change === 'parked') h.state.dispatch({ type: 'park-pane', workspaceID: W1, paneID });
        else {
            h.state.dispatch({ type: 'close-pane', workspaceID: W1, paneID });
            if (change === 'retyped') h.state.dispatch(
                { type: 'open-markdown-pane', workspaceID: W1, paneID, filePath: path.join(h.root, 'reused.md'), now: NOW + 1000 },
                { type: 'set-markdown-editing', workspaceID: W1, paneID, editing: true, externalEditorCommand: 'vim reused.md' }
            );
            if (change === 'recreated') h.state.dispatch({ type: 'split-pane', workspaceID: W1, paneID, direction: 'horizontal', now: NOW + 1000 });
        }
        await h.proceed();
        expect(await result).toEqual(expect.objectContaining({ message: expect.stringContaining('does not own') }));
        expect(h.host.list()[0]?.status).toBe('running');
        expect(await h.attach(P2)).toHaveProperty('lease');
    });

    it('uses the new owning workspace after movement during activation and keeps the terminal lease valid', async () => {
        const h = await fixture(true);
        h.state.dispatch({ type: 'create-workspace', id: W2, paneID: id('ffffffff', 2), name: 'other', color: 'red', now: NOW });
        const attached = h.attach(); await h.entered();
        h.state.dispatch({ type: 'move-pane-to-workspace', paneID: P1, toWorkspaceID: W2 });
        await h.proceed();
        expect(await attached).toMatchObject({ context: { paneID: P1, workspaceID: W2 } });
        await h.api(await attached).call('views.setState', { state: { moved: true } });
        expect((await h.attach())['state']).toEqual({ moved: true });
    });

    it('cancels one pending renderer attachment without cancelling another waiting on the same backend', async () => {
        const h = await fixture(true), abort = new AbortController();
        const cancelled = inOperationScope({ trace: [], signal: abort.signal }, () => h.attach()).catch(error => error as Error);
        const surviving = h.attach(P2); await h.entered(); abort.abort();
        expect(await cancelled).toEqual(expect.objectContaining({ message: expect.stringContaining('cancelled') }));
        await h.proceed(); expect(await surviving).toHaveProperty('lease');
        expect(await h.attach()).toHaveProperty('lease');
    });

    it('does not leak attachment capacity when persisted renderer state cannot be decoded', async () => {
        const h = await fixture();
        const file = path.join(h.options.directory, 'data', PLUGIN, 'documents.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ [`${P1}:${PLUGIN}.terminal`]: { stateVersion: 2, state: 'invalid' } }));
        for (let attempt = 0; attempt < 130; attempt++) await expect(h.attach()).rejects.toThrow('JSON object');
        expect(await h.attach(P2)).toHaveProperty('lease');
    });
});
