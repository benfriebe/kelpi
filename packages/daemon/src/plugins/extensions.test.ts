import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WS_PROTOCOL_VERSION, pluginObject, type JsonObject } from '@kelpi/protocol';
import { createDispatcher } from '../boot/dispatch.js';
import { dispatchWireLine } from '../control/server.js';
import { createStore } from '../store/store.js';
import { seededState, W1 } from '../store/testing.js';
import { createSyncHub, type SyncHub } from '../ws/sync.js';
import { recordingTransport } from '../ws/testing.js';
import type { CommandHandler, ReplyHandle } from '../seams.js';
import { PluginService } from './service.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function harness() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-extensions-'));
    const store = createStore(seededState());
    let hub: SyncHub;
    const calls = vi.fn();
    const options = { directory: path.join(root, 'installed'), store,
        broadcast: vi.fn(), command: (payload: JsonObject, context: Parameters<SyncHub['executeCommand']>[1], signal: AbortSignal) => hub.executeCommand(payload, context, signal) };
    const service = new PluginService(options);
    const dispatcher = createDispatcher({ ctx: {}, operations: service, tables: [new Map<string, CommandHandler<object>>([
        ['workspace-list', (_msg, _ctx, reply: ReplyHandle | null) => { calls('workspace-list'); reply?.send({ ok: true, value: store.getState().workspaces.length }); reply?.close(); }],
        ['ping', (_msg, _ctx, reply: ReplyHandle | null) => { calls('ping'); reply?.send({ ok: true }); reply?.close(); }],
        ['stop', () => { calls('stop'); }],
        ['session-start', () => { calls('session-start'); }]
    ])] });
    hub = createSyncHub({ store, dispatcher, plugins: service, daemon: { version: 'test', build: 'test' } });
    cleanups.push(async () => { hub.close(); await service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
    const install = async (id: string, contributes: JsonObject, backend: string, extra: JsonObject = {}) => {
        const source = path.join(root, id); fs.mkdirSync(source, { recursive: true });
        for (const view of (contributes['views'] ?? []) as JsonObject[]) {
            const entry = path.join(source, String(view['entry'])); fs.mkdirSync(path.dirname(entry), { recursive: true }); fs.writeFileSync(entry, '<h1>Plugin view</h1>');
        }
        fs.writeFileSync(path.join(source, 'kelpi.plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', apiVersion: 1, trust: 'full', activation: 'startup', backend: 'backend.mjs', contributes, ...extra }));
        fs.writeFileSync(path.join(source, 'backend.mjs'), backend);
        await service.install(source, true); return source;
    };
    const cli = (payload: JsonObject): Promise<JsonObject> => new Promise(resolve => {
        let closed = false;
        const reply: ReplyHandle = { get closed() { return closed; }, send: value => resolve(value as JsonObject), close: () => { closed = true; }, onDisconnect: () => {} };
        dispatchWireLine(JSON.stringify(payload), { dispatcher, allocateReply: () => reply });
    });
    const transport = recordingTransport(); const session = hub.createSession(transport);
    session.handleMessage(JSON.stringify({ type: 'hello', protocolVersion: WS_PROTOCOL_VERSION, client: { kind: 'browser', windowID: 'window-one' } }));
    let sequence = 0;
    const ui = async (payload: JsonObject) => {
        const id = `test-${++sequence}`;
        session.handleMessage(JSON.stringify({ type: 'command', id, payload }));
        let reply: JsonObject | undefined;
        await vi.waitFor(() => { reply = transport.json.find(row => row['type'] === 'command-reply' && row['id'] === id)?.['reply'] as JsonObject | undefined; expect(reply).toBeDefined(); });
        return reply!;
    };
    const storage = (id: string, key: string) => service.api(id, 'storage.get', { key }, { daemonID: service.daemonID });
    return { root, store, calls, service, options, hub, install, cli, ui, storage, dispatcher };
}
const before = (id: string, commands = ['workspace-list'], extra: JsonObject = {}) => ({ id, phase: 'before', commands, ...extra });
const provider = (id: string, extra: JsonObject = {}) => ({ id, title: id, service: 'kelpi.files', version: 1, methods: ['read', 'write'], ...extra });

describe('plugin command policies', () => {
    it('observes CLI, UI and backend operations exactly once with context and completion results', async () => {
        const h = harness();
        await h.install('sample.policy', { hooks: [before('sample.policy.before'), { id: 'sample.policy.after', phase: 'after', commands: ['workspace-list'] }], commands: [{ id: 'sample.policy.run', title: 'Run' }] }, `export function activate(api) {
            api.hooks.register('sample.policy.before', async op => { await api.storage.set('before', [...await api.storage.get('before') ?? [], op]); return {allow:true}; });
            api.hooks.register('sample.policy.after', async op => { await api.storage.set('after', [...await api.storage.get('after') ?? [], op]); });
            api.commands.register('sample.policy.run', () => api.command({command:'workspace-list'}));
        }`);
        expect(await h.cli({ command: 'workspace-list' })).toMatchObject({ ok: true });
        expect(await h.ui({ command: 'workspace-list' })).toMatchObject({ ok: true });
        expect(await h.service.request('run', { command: 'sample.policy.run', workspaceID: W1 })).toMatchObject({ ok: true });
        await vi.waitFor(async () => expect(await h.storage('sample.policy', 'after')).toHaveLength(3));
        const beforeEvents = await h.storage('sample.policy', 'before') as JsonObject[];
        expect(beforeEvents.map(event => event['source'])).toEqual(['cli', 'ui', 'plugin']);
        expect(beforeEvents[1]?.['context']).toMatchObject({ windowID: 'window-one' });
        expect(beforeEvents[2]?.['context']).toMatchObject({ workspaceID: W1 });
        const afterEvents = await h.storage('sample.policy', 'after') as JsonObject[];
        expect(afterEvents.every(event => pluginObject(event['result'])['ok'] === true)).toBe(true);
        expect(h.calls).toHaveBeenCalledTimes(3);
    });

    it('vetoes both transport families and leaves recovery traffic available', async () => {
        const h = harness();
        await h.install('sample.policy', { hooks: [before('sample.policy.check', ['*'])] }, `export function activate(api) { api.hooks.register('sample.policy.check', () => ({allow:false,reason:'Workspace is locked'})); }`);
        expect(await h.cli({ command: 'workspace-list' })).toMatchObject({ ok: false, code: 'PLUGIN_VETO', error: 'Workspace is locked' });
        expect(await h.ui({ command: 'rename-workspace', workspace_id: W1, name: 'blocked' })).toMatchObject({ code: 'PLUGIN_VETO' });
        expect(h.store.getState().workspaces[0]?.name).not.toBe('blocked');
        expect(await h.cli({ command: 'ping' })).toMatchObject({ ok: true });
        expect(await h.ui({ command: 'plugin', action: 'list', text: '{}' })).toMatchObject({ ok: true });
        await h.service.request('disable', { pluginID: 'sample.policy' });
        expect(await h.ui({ command: 'rename-workspace', workspace_id: W1, name: 'allowed' })).toMatchObject({ ok: true });
        expect(h.store.getState().workspaces[0]?.name).toBe('allowed');
    });

    it('runs hooks in stable priority and identity order, independent of installation order', async () => {
        const h = harness(); const log = path.join(h.root, 'order');
        for (const [id, priority] of [['sample.zulu', 0], ['sample.alpha', 0], ['sample.first', -1]] as const) {
            await h.install(id, { hooks: [before(`${id}.hook`, undefined, { priority })] }, `import fs from 'node:fs'; export function activate(api) { api.hooks.register('${id}.hook', () => { fs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(`${id}\n`)}); return {allow:true}; }); }`);
        }
        await h.cli({ command: 'workspace-list' });
        expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual(['sample.first', 'sample.alpha', 'sample.zulu']);
    });

    it('revalidates the native command after an asynchronous hook changes the workspace', async () => {
        const h = harness();
        await h.install('sample.policy', { hooks: [before('sample.policy.check', ['rename-workspace'])] }, `export function activate(api) { api.hooks.register('sample.policy.check', async () => { await api.storage.set('entered', true); while (!await api.storage.get('proceed')) await new Promise(r => setTimeout(r,10)); return {allow:true}; }); }`);
        const pending = h.ui({ command: 'rename-workspace', workspace_id: W1, name: 'stale' });
        await vi.waitFor(async () => expect(await h.storage('sample.policy', 'entered')).toBe(true));
        h.store.dispatch({ type: 'delete-workspace', id: W1 });
        await h.service.api('sample.policy', 'storage.set', { key: 'proceed', value: true }, { daemonID: h.service.daemonID });
        expect(await pending).toMatchObject({ ok: false });
        expect(h.store.getState().workspaces.some(workspace => workspace.id === W1)).toBe(false);
    });

    it('contains an unresponsive hook, fails its current request, and can recover on reload', async () => {
        const h = harness();
        const source = await h.install('sample.policy', { hooks: [before('sample.policy.check', undefined, { timeoutMs: 50 })] }, `export function activate(api) { api.hooks.register('sample.policy.check', () => { while(true) {} }); }`);
        expect(await h.cli({ command: 'workspace-list' })).toMatchObject({ ok: false, code: 'PLUGIN_HOOK_FAILED' });
        expect(h.calls).not.toHaveBeenCalled();
        expect(h.service.list()[0]?.status).toBe('failed');
        expect(await h.cli({ command: 'workspace-list' })).toMatchObject({ ok: true });
        fs.writeFileSync(path.join(source, 'backend.mjs'), `export function activate(api) { api.hooks.register('sample.policy.check', () => ({allow:true})); }`);
        await h.service.install(source, true);
        expect(await h.cli({ command: 'workspace-list' })).toMatchObject({ ok: true });
        expect(h.service.list()[0]?.status).toBe('running');
    });

    it('rejects malformed decisions instead of silently allowing an operation', async () => {
        const h = harness();
        await h.install('sample.policy', { hooks: [before('sample.policy.check')] }, `export function activate(api) { api.hooks.register('sample.policy.check', () => undefined); }`);
        expect(await h.cli({ command: 'workspace-list' })).toMatchObject({ code: 'PLUGIN_HOOK_FAILED' });
        expect(h.calls).not.toHaveBeenCalled();
    });

    it('carries recursion guards across backend IPC without skipping unrelated operations', async () => {
        const h = harness();
        await h.install('sample.policy', { hooks: [before('sample.policy.check')] }, `export function activate(api) { api.hooks.register('sample.policy.check', async () => { await api.command({command:'workspace-list'}); await api.storage.set('calls', (await api.storage.get('calls') ?? 0) + 1); return {allow:true}; }); }`);
        expect(await h.cli({ command: 'workspace-list' })).toMatchObject({ ok: true });
        expect(h.calls).toHaveBeenCalledTimes(2);
        expect(await h.storage('sample.policy', 'calls')).toBe(1);
        expect(await h.cli({ command: 'workspace-list' })).toMatchObject({ ok: true });
        expect(await h.storage('sample.policy', 'calls')).toBe(2);
    });

    it('keeps no-reply CLI verbs silent and labels their observation as dispatched', async () => {
        const h = harness();
        await h.install('sample.policy', { hooks: [{ id: 'sample.policy.after', phase: 'after', commands: ['stop'] }] }, `export function activate(api) { api.hooks.register('sample.policy.after', op => api.storage.set('after', op)); }`);
        const allocateReply = vi.fn(() => { throw new Error('must remain silent'); });
        dispatchWireLine(JSON.stringify({ command: 'stop', pane_id: W1 }), { dispatcher: h.dispatcher, allocateReply });
        await vi.waitFor(async () => expect(await h.storage('sample.policy', 'after')).toMatchObject({ result: { ok: true, completion: 'dispatched' } }));
        expect(allocateReply).not.toHaveBeenCalled();
        expect(h.calls).toHaveBeenCalledWith('stop');
    });

    it('does not let failing after observers change the completed operation', async () => {
        const h = harness();
        await h.install('sample.policy', { hooks: [{ id: 'sample.policy.after', phase: 'after', commands: ['workspace-list'] }] }, `export function activate(api) { api.hooks.register('sample.policy.after', () => { throw new Error('observer failed'); }); }`);
        expect(await h.cli({ command: 'workspace-list' })).toMatchObject({ ok: true });
        await vi.waitFor(async () => expect(await h.service.request('logs', { pluginID: 'sample.policy' })).toEqual(expect.arrayContaining([expect.stringContaining('observer failed')])));
    });

    it('bounds after-hook IPC without changing a large native operation result', async () => {
        const h = harness();
        await h.install('sample.policy', { hooks: [{ id: 'sample.policy.after', phase: 'after', commands: ['workspace-list'] }] }, `export function activate(api) { api.hooks.register('sample.policy.after', ()=>api.storage.set('seen',true)); }`);
        const result = { ok: true, content: 'x'.repeat(300 * 1024) };
        expect(await h.service.interceptOperation({ command: 'workspace-list' }, {}, 'cli', async () => result)).toEqual(result);
        await vi.waitFor(async () => expect(await h.service.request('logs', { pluginID: 'sample.policy' })).toEqual(expect.arrayContaining([expect.stringContaining('256 KiB')])));
        expect(await h.storage('sample.policy', 'seen')).toBe(null);
        expect(h.service.list()[0]?.status).toBe('running');
    });

    it('keeps delayed CLI dual-fire messages in order and suppresses their entire batch on veto', async () => {
        const h = harness();
        await h.install('sample.policy', { hooks: [before('sample.policy.before', ['stop']), { id: 'sample.policy.after', phase: 'after', commands: ['stop'] }] }, `export function activate(api) {
            api.hooks.register('sample.policy.before', async () => { await api.storage.set('entered',true); while (!await api.storage.get('proceed')) await new Promise(r => setTimeout(r,10)); return await api.storage.get('deny') ? {allow:false,reason:'blocked'} : {allow:true}; });
            api.hooks.register('sample.policy.after', op => api.storage.set('completion',op.result));
        }`);
        const payload = { command: 'stop', pane_id: W1, session_id: 'test-session', agent: 'codex' };
        const allocateReply = vi.fn(() => { throw new Error('fire-and-forget must be silent'); });
        dispatchWireLine(JSON.stringify(payload), { dispatcher: h.dispatcher, allocateReply });
        await vi.waitFor(async () => expect(await h.storage('sample.policy', 'entered')).toBe(true));
        expect(h.calls).not.toHaveBeenCalled();
        await h.service.api('sample.policy', 'storage.set', { key: 'proceed', value: true }, { daemonID: h.service.daemonID });
        await vi.waitFor(() => expect(h.calls.mock.calls.map(row => row[0])).toEqual(['stop', 'session-start']));
        await vi.waitFor(async () => expect(await h.storage('sample.policy', 'completion')).toMatchObject({ ok: true }));
        h.calls.mockClear();
        await h.service.api('sample.policy', 'storage.set', { key: 'deny', value: true }, { daemonID: h.service.daemonID });
        dispatchWireLine(JSON.stringify(payload), { dispatcher: h.dispatcher, allocateReply });
        await vi.waitFor(async () => expect(await h.storage('sample.policy', 'completion')).toMatchObject({ code: 'PLUGIN_VETO' }));
        expect(h.calls).not.toHaveBeenCalled();
        expect(await h.ui(payload)).toMatchObject({ code: 'PLUGIN_VETO' });
        expect(h.calls).not.toHaveBeenCalled();
        expect(allocateReply).not.toHaveBeenCalled();
    });

    it('cancels a detached view command without failing a shared before-hook plugin', async () => {
        const h = harness();
        await h.install('sample.policy', { hooks: [before('sample.policy.before')] }, `export function activate(api) { api.hooks.register('sample.policy.before', async op => { await api.storage.set('context',op.context); await api.storage.set('entered',true); await new Promise(r => setTimeout(r,150)); return {allow:true}; }); }`);
        await h.install('sample.view', { views: [{ id: 'sample.view.pane', title: 'View', entry: 'ui/index.html', placements: ['pane'] }] }, 'export function activate() {}');
        const context = { daemonID: h.service.daemonID, clientID: 'original-client' };
        const view = pluginObject(await h.service.request('attach', { pluginID: 'sample.view', viewID: 'sample.view.pane' }, context));
        const pending = h.service.request('api', { lease: view['lease']!, method: 'command', args: { payload: { command: 'workspace-list' } } }, context);
        const cancelled = expect(pending).rejects.toThrow('cancelled');
        await vi.waitFor(async () => expect(await h.storage('sample.policy', 'entered')).toBe(true));
        expect(await h.storage('sample.policy', 'context')).toMatchObject({ clientID: 'original-client' });
        await h.service.request('release', { lease: view['lease']! }, context); await cancelled;
        await new Promise(resolve => setTimeout(resolve, 170));
        expect(h.service.list().find(item => item.manifest.id === 'sample.policy')?.status).toBe('running');
        expect(h.calls).not.toHaveBeenCalled();
        expect(await h.cli({ command: 'workspace-list' })).toMatchObject({ ok: true });
    });
});

describe('versioned service providers', () => {
    it('selects a provider across backend, view and CLI calls and persists the choice', async () => {
        const h = harness(); const file = path.join(h.root, 'notes'); fs.writeFileSync(file, 'native');
        await h.install('sample.files', { providers: [provider('sample.files.custom')], commands: [{ id: 'sample.files.read', title: 'Read' }], views: [{ id: 'sample.files.view', title: 'View', entry: 'ui/index.html', placements: ['pane'] }] }, `export function activate(api) {
            api.providers.register('sample.files.custom', {read: async args => 'custom:' + await api.services.call('kelpi.files',1,'read',args,{provider:'bundled'}), write: async args => { await api.services.call('kelpi.files',1,'write',args,{provider:'bundled'}); return null; }});
            api.commands.register('sample.files.read', args => api.files.read(args.path));
        }`, { activation: 'on-demand' });
        const call = { service: 'kelpi.files', version: 1, method: 'read', args: { path: file } };
        expect(await h.service.request('service-call', call)).toBe('native');
        await h.service.request('service-select', { service: 'kelpi.files', version: 1, providerID: 'sample.files.custom' });
        expect(await h.service.request('service-call', call)).toBe('custom:native');
        expect(await h.service.request('run', { command: 'sample.files.read', args: { path: file } })).toBe('custom:native');
        const caller = { daemonID: h.service.daemonID, clientID: 'view-owner' };
        const attached = pluginObject(await h.service.request('attach', { pluginID: 'sample.files', viewID: 'sample.files.view' }, caller));
        expect(await h.service.request('api', { lease: attached['lease']!, method: 'files.read', args: { path: file } }, caller)).toBe('custom:native');
        await h.service.dispose();
        const restarted = new PluginService(h.options); cleanups.push(() => restarted.dispose());
        expect(restarted.services()[0]).toMatchObject({ selectedProviderID: 'sample.files.custom', activeProviderID: 'sample.files.custom' });
        expect(await restarted.request('service-call', call)).toBe('custom:native');
    });

    it('falls back on disable/failure without forgetting selection or retrying failed writes', async () => {
        const h = harness(); const file = path.join(h.root, 'written');
        await h.install('sample.files', { providers: [provider('sample.files.custom')] }, `export function activate(api) { api.providers.register('sample.files.custom', {read: () => 'custom', write: () => { process.exit(7); }}); }`);
        await h.service.request('service-select', { service: 'kelpi.files', version: 1, providerID: 'sample.files.custom' });
        await expect(h.service.request('service-call', { service: 'kelpi.files', version: 1, method: 'write', args: { path: file, text: 'must not retry' } })).rejects.toThrow('exited');
        expect(fs.existsSync(file)).toBe(false);
        expect(h.service.services()[0]).toMatchObject({ selectedProviderID: 'sample.files.custom', activeProviderID: 'kelpi.files.bundled' });
        await h.service.request('reload', { pluginID: 'sample.files' });
        expect(h.service.services()[0]).toMatchObject({ activeProviderID: 'sample.files.custom' });
        await h.service.request('disable', { pluginID: 'sample.files' });
        expect(h.service.services()[0]).toMatchObject({ selectedProviderID: 'sample.files.custom', activeProviderID: 'kelpi.files.bundled' });
        await expect(h.service.request('service-call', { service: 'kelpi.files', version: 1, method: 'read', args: { path: file }, provider: 'sample.files.custom' })).rejects.toThrow('unavailable');
    });

    it('requires explicit custom service selection and validates versions and declared methods', async () => {
        const h = harness();
        await h.install('sample.lookup', { services: [{ id: 'sample.lookup.catalog', title: 'Catalog', version: 2, methods: ['find'] }], providers: [{ id: 'sample.lookup.local', title: 'Local', service: 'sample.lookup.catalog', version: 2, methods: ['find'] }] }, `export function activate(api) { api.providers.register('sample.lookup.local', {find: args => ({found:args.name})}); }`);
        const call = { service: 'sample.lookup.catalog', version: 2, method: 'find', args: { name: 'Kelpi' } };
        await expect(h.service.request('service-call', call)).rejects.toThrow('unavailable');
        await expect(h.service.request('service-call', { ...call, version: 1 })).rejects.toThrow('unavailable');
        await expect(h.service.request('service-call', { ...call, method: 'remove' })).rejects.toThrow('unknown service method');
        await h.service.request('service-select', { service: 'sample.lookup.catalog', version: 2, providerID: 'sample.lookup.local' });
        expect(await h.service.request('service-call', call)).toEqual({ found: 'Kelpi' });
    });

    it('rejects provider recursion while permitting explicit bundled delegation', async () => {
        const h = harness();
        await h.install('sample.files', { providers: [provider('sample.files.custom')] }, `export function activate(api) { api.providers.register('sample.files.custom', {read: args => api.files.read(args.path), write: () => null}); }`);
        await h.service.request('service-select', { service: 'kelpi.files', version: 1, providerID: 'sample.files.custom' });
        await expect(h.service.request('service-call', { service: 'kelpi.files', version: 1, method: 'read', args: { path: '/not-read' } })).rejects.toThrow('recursive plugin invocation');
    });

    it('bounds an unresponsive provider and falls back on its next call', async () => {
        const h = harness(); const file = path.join(h.root, 'readable'); fs.writeFileSync(file, 'native');
        await h.install('sample.files', { providers: [provider('sample.files.custom', { timeoutMs: 50 })] }, `export function activate(api) { api.providers.register('sample.files.custom', {read: () => { while(true) {} }, write: () => null}); }`);
        await h.service.request('service-select', { service: 'kelpi.files', version: 1, providerID: 'sample.files.custom' });
        const call = { service: 'kelpi.files', version: 1, method: 'read', args: { path: file } };
        await expect(h.service.request('service-call', call)).rejects.toThrow('timed out');
        expect(await h.service.request('service-call', call)).toBe('native');
    });

    it('checks backend registrations against provider and hook declarations', async () => {
        const h = harness();
        await expect(h.install('sample.bad', { hooks: [before('sample.bad.check')] }, 'export function activate() {}')).rejects.toThrow('hooks registrations');
        await expect(h.install('sample.files', { providers: [provider('sample.files.custom')] }, `export function activate(api) { api.providers.register('sample.files.custom', {read:()=>''}); }`)).rejects.toThrow('provider methods');
    });

    it('cancels a detached view service call without stopping a shared provider', async () => {
        const h = harness();
        await h.install('sample.files', { providers: [provider('sample.files.custom')] }, `export function activate(api) { api.providers.register('sample.files.custom', {read: async () => { await api.storage.set('entered', true); await new Promise(r => setTimeout(r,100)); try { await api.storage.set('late', true); } catch {} return 'late'; }, write:()=>null}); }`);
        await h.install('sample.view', { views: [{ id: 'sample.view.pane', title: 'View', entry: 'ui/index.html', placements: ['pane'] }] }, 'export function activate() {}');
        await h.service.request('service-select', { service: 'kelpi.files', version: 1, providerID: 'sample.files.custom' });
        const context = { daemonID: h.service.daemonID, clientID: 'view-client' };
        const view = pluginObject(await h.service.request('attach', { pluginID: 'sample.view', viewID: 'sample.view.pane' }, context));
        const pending = h.service.request('api', { lease: view['lease']!, method: 'files.read', args: { path: 'ignored' } }, context);
        const cancelled = expect(pending).rejects.toThrow('cancelled');
        await vi.waitFor(async () => expect(await h.storage('sample.files', 'entered')).toBe(true));
        await h.service.request('release', { lease: view['lease']! }, context); await cancelled;
        await new Promise(resolve => setTimeout(resolve, 120));
        expect(await h.storage('sample.files', 'late')).toBe(null);
        expect(h.service.list().find(item => item.manifest.id === 'sample.files')?.status).toBe('running');
    });

    it('revokes pending calls when providers reload, without accepting late replies', async () => {
        const h = harness();
        await h.install('sample.files', { providers: [provider('sample.files.custom')] }, `export function activate(api) { api.providers.register('sample.files.custom', {read: async () => { await api.storage.set('entered',true); await new Promise(r => setTimeout(r,100)); return 'old'; },write:()=>null}); }`);
        await h.service.request('service-select', { service: 'kelpi.files', version: 1, providerID: 'sample.files.custom' });
        const pending = h.service.request('service-call', { service: 'kelpi.files', version: 1, method: 'read', args: { path: 'ignored' } });
        const stopped = expect(pending).rejects.toThrow('stopped');
        await vi.waitFor(async () => expect(await h.storage('sample.files', 'entered')).toBe(true));
        await h.service.request('reload', { pluginID: 'sample.files' }); await stopped;
        expect(h.service.list()[0]?.status).toBe('running');
    });

    it('publishes a new instance after lifecycle completion so a transition-time view attach can retry', async () => {
        const h = harness();
        await h.install('sample.view', { views: [{ id: 'sample.view.pane', title: 'View', entry: 'ui/index.html', placements: ['pane'] }] }, 'export function activate() {}');
        let transitionInstance: string | undefined;
        let attachment: Promise<unknown> | undefined;
        h.options.broadcast.mockImplementation(event => {
            if (attachment || event['type'] !== 'plugins-changed') return;
            const plugin = (event['plugins'] as JsonObject[]).find(plugin => pluginObject(plugin['manifest'])['id'] === 'sample.view');
            if (plugin?.['status'] !== 'running') return;
            transitionInstance = String(plugin['instanceID']);
            attachment = h.service.request('attach', { pluginID: 'sample.view', viewID: 'sample.view.pane' }).catch(error => error);
        });
        await h.service.request('reload', { pluginID: 'sample.view' });
        expect(await attachment).toBeInstanceOf(Error);
        expect(h.service.list()[0]?.instanceID).not.toBe(transitionInstance);
        expect(await h.service.request('attach', { pluginID: 'sample.view', viewID: 'sample.view.pane' })).toHaveProperty('lease');
    });

    it('pins invocation generation across on-demand activation and a concurrent reload', async () => {
        const h = harness(); const log = path.join(h.root, 'invocations');
        await h.install('sample.files', { providers: [provider('sample.files.custom')] }, `import fs from 'node:fs'; export function activate(api) { api.providers.register('sample.files.custom', {read: () => { fs.appendFileSync(${JSON.stringify(log)}, 'called'); return 'value'; },write:()=>null}); }`, { activation: 'on-demand' });
        await h.service.request('service-select', { service: 'kelpi.files', version: 1, providerID: 'sample.files.custom' });
        let reload: Promise<unknown> | undefined;
        h.options.broadcast.mockImplementation(event => {
            if (!reload && event['type'] === 'plugins-changed' && (event['plugins'] as JsonObject[]).some(item => item['status'] === 'running')) reload = h.service.request('reload', { pluginID: 'sample.files' });
        });
        await expect(h.service.request('service-call', { service: 'kelpi.files', version: 1, method: 'read', args: { path: 'ignored' } })).rejects.toThrow(/changed|stopped|stopping/);
        await reload;
        expect(fs.existsSync(log)).toBe(false);
        expect(h.service.list()[0]?.status).toBe('running');
    });

    it('rejects contributions stolen through nested plugin namespaces before altering either installation', async () => {
        const h = harness();
        await h.install('sample.parent', { commands: [{ id: 'sample.parent.child.run', title: 'Run' }] }, `export function activate(api) { api.commands.register('sample.parent.child.run', ()=>'original'); }`);
        await expect(h.install('sample.parent.child', { commands: [{ id: 'sample.parent.child.run', title: 'Stolen' }] }, `export function activate(api) { api.commands.register('sample.parent.child.run', ()=>'stolen'); }`)).rejects.toThrow('already owned');
        expect(await h.service.request('run', { command: 'sample.parent.child.run' })).toBe('original');
        expect(h.service.list()).toHaveLength(1);
    });
});

describe('plugin dependency activation and cleanup', () => {
    it('activates required dependencies first and stops dependent views/providers on disable', async () => {
        const h = harness(); const log = path.join(h.root, 'activation');
        await h.install('sample.base', {}, `import fs from 'node:fs'; export function activate() { fs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify('base\n')}); }`, { activation: 'on-demand' });
        await h.install('sample.child', { providers: [provider('sample.child.files')] }, `import fs from 'node:fs'; export function activate(api) { fs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify('child\n')}); api.providers.register('sample.child.files', {read:()=> 'child',write:()=>null}); }`, { dependencies: [{ pluginID: 'sample.base', version: '^1.0.0' }] });
        expect(fs.readFileSync(log, 'utf8')).toBe('base\nchild\n');
        await h.service.request('service-select', { service: 'kelpi.files', version: 1, providerID: 'sample.child.files' });
        await h.service.request('disable', { pluginID: 'sample.base' });
        expect(h.service.list().find(item => item.manifest.id === 'sample.child')).toMatchObject({ status: 'failed', error: expect.stringContaining('disabled') });
        expect(h.service.services()[0]).toMatchObject({ activeProviderID: 'kelpi.files.bundled', selectedProviderID: 'sample.child.files' });
        await h.service.request('enable', { pluginID: 'sample.base' });
        await vi.waitFor(() => expect(h.service.list().find(item => item.manifest.id === 'sample.child')?.status).toBe('running'));
        expect(h.service.services()[0]).toMatchObject({ activeProviderID: 'sample.child.files' });
    });

    it('keeps missing dependencies actionable and recovers when they are installed', async () => {
        const h = harness();
        await h.install('sample.child', { commands: [{ id: 'sample.child.run', title: 'Run' }] }, `export function activate(api) { api.commands.register('sample.child.run', ()=>true); }`, { activation: 'on-demand', dependencies: [{ pluginID: 'sample.base', version: '~1.0.0' }] });
        expect(h.service.list()[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('not installed') });
        await expect(h.service.request('run', { command: 'sample.child.run' })).rejects.toThrow('not installed');
        await h.install('sample.base', {}, 'export function activate() {}');
        expect(await h.service.request('run', { command: 'sample.child.run' })).toBe(true);
    });

    it('stops dependents when a required backend fails and prevents activation during its reload', async () => {
        const h = harness();
        await h.install('sample.base', { commands: [{ id: 'sample.base.crash', title: 'Crash' }] }, `export function activate(api) { api.commands.register('sample.base.crash', () => process.exit(9)); return () => new Promise(r => setTimeout(r,100)); }`);
        await h.install('sample.child', { commands: [{ id: 'sample.child.run', title: 'Run' }] }, `export function activate(api) { api.commands.register('sample.child.run', ()=>true); }`, { dependencies: [{ pluginID: 'sample.base', version: '*' }] });
        await expect(h.service.request('run', { command: 'sample.base.crash' })).rejects.toThrow('exited');
        expect(h.service.list().find(item => item.manifest.id === 'sample.child')).toMatchObject({ status: 'failed', error: expect.stringContaining('failed') });
        await expect(h.service.request('run', { command: 'sample.child.run' })).rejects.toThrow('failed');
        await h.service.request('reload', { pluginID: 'sample.base' });
        await vi.waitFor(() => expect(h.service.list().find(item => item.manifest.id === 'sample.child')?.status).toBe('running'));
        const reload = h.service.request('reload', { pluginID: 'sample.base' });
        await vi.waitFor(() => expect(h.service.list().find(item => item.manifest.id === 'sample.child')?.error).toContain('disabled'));
        await expect(h.service.request('run', { command: 'sample.child.run' })).rejects.toThrow('disabled');
        await reload;
        expect(await h.service.request('run', { command: 'sample.child.run' })).toBe(true);
    });

    it('stops diamond dependents before either of their required parents', async () => {
        const h = harness(); const log = path.join(h.root, 'stops');
        for (const [id, dependencies] of [['sample.base', []], ['sample.alpha', ['sample.base']], ['sample.beta', ['sample.base']], ['sample.child', ['sample.alpha', 'sample.beta']]] as const) {
            await h.install(id, {}, `import fs from 'node:fs'; export function activate() { return () => fs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(`${id}\n`)}); }`, { dependencies: dependencies.map(pluginID => ({ pluginID, version: '*' })) });
        }
        await h.service.request('disable', { pluginID: 'sample.base' });
        const order = fs.readFileSync(log, 'utf8').trim().split('\n');
        expect(order.indexOf('sample.child')).toBeLessThan(order.indexOf('sample.alpha'));
        expect(order.indexOf('sample.child')).toBeLessThan(order.indexOf('sample.beta'));
        expect(order.at(-1)).toBe('sample.base');
    });

    it('continues root activation when an optional dependency fails to activate', async () => {
        const h = harness();
        await h.install('sample.optional', {}, `export function activate() { throw new Error('optional failed'); }`, { activation: 'on-demand' });
        await h.install('sample.root', { commands: [{ id: 'sample.root.run', title: 'Run' }] }, `export function activate(api) { api.commands.register('sample.root.run',()=>true); }`, { dependencies: [{ pluginID: 'sample.optional', version: '*', optional: true }] });
        expect(h.service.list().find(item => item.manifest.id === 'sample.optional')?.status).toBe('failed');
        expect(h.service.list().find(item => item.manifest.id === 'sample.root')?.status).toBe('running');
        expect(await h.service.request('run', { command: 'sample.root.run' })).toBe(true);
    });
});
