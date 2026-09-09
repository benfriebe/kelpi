import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pluginObject, type JsonObject, type PluginContext } from '@kelpi/protocol';
import { createStore } from '../store/store.js';
import { seededState, W1 } from '../store/testing.js';
import { PluginService } from './service.js';
import { Hono } from 'hono';
import { pluginAssetsRoute } from './http.js';

const id = 'sample.board';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function harness(backend = `export async function activate(api) {
    let count = await api.storage.get('count') ?? 0;
    api.events.on('state.changed', async () => { await api.storage.set('count', ++count); });
    api.commands.register('sample.board.run', async (args, context) => args.open ? api.openView('sample.board.view') : { count, context, reply: await api.command({ command: 'workspace-list' }) });
}`) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-plugin-test-'));
    const source = path.join(root, 'source'); fs.mkdirSync(path.join(source, 'ui'), { recursive: true });
    const manifest = { id, name: 'Board', version: '1.0.0', apiVersion: 1, trust: 'full', activation: 'startup', backend: 'backend.mjs', contributes: { views: [{ id: `${id}.view`, title: 'Board', entry: 'ui/index.html', placements: ['pane', 'sidebar.primary'] }], commands: [{ id: `${id}.run`, title: 'Run' }], settings: { title: { title: 'Title', type: 'string', default: 'Board' } } } };
    fs.writeFileSync(path.join(source, 'kelpi.plugin.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(source, 'backend.mjs'), backend);
    fs.writeFileSync(path.join(source, 'ui', 'index.html'), '<h1>Board</h1>');
    fs.writeFileSync(path.join(source, 'ui', 'app.js'), 'window.rendered = true;');
    const store = createStore(seededState()); const command = vi.fn(async (_payload: JsonObject, _context: PluginContext, _signal: AbortSignal): Promise<JsonObject> => ({ ok: true })); const broadcast = vi.fn();
    const options = { directory: path.join(root, 'plugins'), store, command, broadcast };
    const service = new PluginService(options);
    cleanups.push(async () => { await service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
    return { root, source, store, command, broadcast, service, options, manifest };
}
describe('daemon plugin supervisor', () => {
    it('pins backend and managed subprocess CLI routing and refuses the default socket without a route', async () => {
        const h = harness(`export function activate(api) { api.commands.register('${id}.run', () => ({ route: process.env.KELPI_SOCKET, required: process.env.KELPI_REQUIRE_SOCKET })); }`);
        await h.service.install(h.source, true);
        expect(await h.service.request('run', { command: `${id}.run` })).toEqual({ route: '', required: '1' });
        await h.service.dispose();
        let route = 'tcp:127.0.0.1:65534';
        const next = new PluginService({ ...h.options, cliEnvironment: () => ({ KELPI_SOCKET: route }) }); cleanups.push(() => next.dispose());
        expect(await next.request('run', { command: `${id}.run` })).toEqual({ route, required: '1' });
        route = 'tcp:127.0.0.1:65533';
        const result = pluginObject(await next.api(id, 'process.exec', { file: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify({route:process.env.KELPI_SOCKET,required:process.env.KELPI_REQUIRE_SOCKET}))'], cwd: h.root }, { daemonID: next.daemonID }));
        expect(JSON.parse(String(result['stdout']))).toEqual({ route, required: '1' });
    });
    it('cancels a detached view command without stopping another view or the backend', async () => {
        const h = harness(); await h.service.install(h.source, true);
        const caller = { daemonID: h.service.daemonID, clientID: 'owner', paneID: 'focused-terminal' };
        const first = pluginObject(await h.service.request('attach', { pluginID: id, viewID: `${id}.view` }, caller));
        const second = pluginObject(await h.service.request('attach', { pluginID: id, viewID: `${id}.view` }, caller));
        expect(first['context']).not.toHaveProperty('paneID');
        h.command.mockImplementation((_payload, _context, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })));
        const pending = h.service.request('api', { lease: first['lease']!, method: 'command', args: { payload: { command: 'workspace-list' } } }, caller);
        const cancelled = expect(pending).rejects.toThrow('cancelled');
        await h.service.request('release', { lease: first['lease']! }, caller); await cancelled;
        expect(h.command.mock.calls[0]?.[2].aborted).toBe(true);
        expect(h.service.list()[0]?.status).toBe('running');
        expect(await h.service.request('api', { lease: second['lease']!, method: 'state.snapshot' }, caller)).toHaveProperty('epoch');
    });
    it('terminates an unresponsive backend on disable and can activate a healthy replacement', async () => {
        const h = harness(`export function activate(api) { api.commands.register('${id}.run', () => { while (true) {} }); }`);
        await h.service.install(h.source, true);
        const pending = h.service.request('run', { command: `${id}.run` });
        const stopped = expect(pending).rejects.toThrow('plugin stopped');
        await new Promise(resolve => setTimeout(resolve, 30));
        await h.service.request('disable', { pluginID: id }); await stopped;
        expect(h.service.list()[0]?.status).toBe('disabled');
        fs.writeFileSync(path.join(h.source, 'backend.mjs'), `export function activate(api) { api.commands.register('${id}.run', () => 'recovered'); }`);
        await h.service.install(h.source, true);
        expect(await h.service.request('run', { command: `${id}.run` })).toBe('recovered');
    });
    it('installs an immutable copy, starts a real child, carries command context, and records events without a UI', async () => {
        const h = harness();
        await expect(h.service.install(h.source, false)).rejects.toThrow('--trust');
        await h.service.install(h.source, true);
        expect(h.service.list()[0]?.status).toBe('running');
        fs.writeFileSync(path.join(h.source, 'backend.mjs'), 'throw new Error("source changed")');
        const result = pluginObject(await h.service.request('run', { command: `${id}.run`, workspaceID: W1 }, { daemonID: h.service.epoch, clientID: 'C', windowID: 'WIN' }));
        expect(result['context']).toMatchObject({ workspaceID: W1, clientID: 'C', windowID: 'WIN' });
        expect(h.command.mock.calls[0]?.[0]).toEqual({ command: 'workspace-list' });
        h.store.dispatch({ type: 'rename-workspace', id: W1, name: 'changed' });
        await vi.waitFor(async () => expect(pluginObject(await h.service.request('run', { command: `${id}.run` }))['count']).toBeGreaterThan(0));
        await h.service.request('reload', { pluginID: id });
        expect(pluginObject(await h.service.request('run', { command: `${id}.run` }))['count']).toBeGreaterThan(0);
    });
    it('opens real layout panes, binds UI access to its client, limits HTTP to ui assets and revokes on disconnect/disable', async () => {
        const h = harness(); await h.service.install(h.source, true);
        const opened = pluginObject(await h.service.request('run', { command: `${id}.run`, args: { open: true }, workspaceID: W1 }));
        const paneID = String(opened['paneID']);
        expect(h.store.getState().workspaces[0]?.panes.find(pane => pane.id === paneID)?.plugin).toMatchObject({ viewID: `${id}.view`, stateVersion: 1 });
        const context = { daemonID: h.service.epoch, clientID: 'owner', workspaceID: W1 };
        const attached = pluginObject(await h.service.request('attach', { pluginID: id, viewID: `${id}.view`, paneID }, context));
        const request = { lease: attached['lease']!, method: 'views.setState', args: { state: { filter: 'running' } } };
        await expect(h.service.request('api', request, { ...context, clientID: 'other' })).rejects.toThrow('another client');
        await h.service.request('api', request, context);
        expect(h.store.getState().workspaces[0]?.panes.find(pane => pane.id === paneID)?.plugin?.state).toEqual({ filter: 'running' });
        const app = new Hono(); pluginAssetsRoute(h.service)(app);
        expect((await app.request(`/plugin-assets/${attached['lease']}/ui/app.js`)).status).toBe(200);
        expect((await app.request(`/plugin-assets/${attached['lease']}/backend.mjs`)).status).toBe(404);
        expect((await app.request(`/plugin-assets/${attached['lease']}/ui/%2e%2e/backend.mjs`)).status).toBe(404);
        h.service.releaseClient('owner');
        expect((await app.request(`/plugin-assets/${attached['lease']}/ui/app.js`)).status).toBe(404);
        await h.service.request('disable', { pluginID: id });
        await expect(h.service.request('run', { command: `${id}.run` })).rejects.toThrow('disabled');
        expect(h.store.getState().workspaces[0]?.panes.find(pane => pane.id === paneID)?.plugin?.state).toEqual({ filter: 'running' });
    });
    it('preserves installations, settings and storage across daemon restarts', async () => {
        const h = harness(); await h.service.install(h.source, true);
        await h.service.api(id, 'storage.set', { key: 'answer', value: 42 }, { daemonID: h.service.epoch });
        await h.service.request('settings', { pluginID: id, key: 'title', value: 'Mine' });
        await h.service.dispose();
        const restarted = new PluginService(h.options); cleanups.push(() => restarted.dispose());
        expect(restarted.epoch).not.toBe(h.service.epoch);
        expect(restarted.daemonID).toBe(h.service.daemonID);
        expect(await restarted.api(id, 'storage.get', { key: 'answer' }, { daemonID: restarted.epoch })).toBe(42);
        expect(await restarted.request('settings', { pluginID: id })).toEqual({ title: 'Mine' });
    });
    it('contains activation failures and can recover from a corrected installation', async () => {
        const h = harness('export function activate() { throw new Error("broken activation"); }');
        await expect(h.service.install(h.source, true)).rejects.toThrow('broken activation');
        expect(h.service.list()[0]).toMatchObject({ status: 'failed', error: 'broken activation' });
        fs.writeFileSync(path.join(h.source, 'backend.mjs'), `export function activate(api) { api.commands.register('${id}.run', () => 7); }`);
        await h.service.install(h.source, true);
        expect(await h.service.request('run', { command: `${id}.run` })).toBe(7);
    });
    it('rejects package symlinks and preserves a corrupt registry instead of overwriting it', async () => {
        const h = harness(); fs.symlinkSync('/etc/hosts', path.join(h.source, 'ui', 'outside'));
        await expect(h.service.install(h.source, true)).rejects.toThrow('symlinks');
        await h.service.dispose();
        fs.writeFileSync(path.join(h.options.directory, 'installed.json'), '{broken');
        const next = new PluginService(h.options); cleanups.push(() => next.dispose());
        await expect(next.request('list', {})).rejects.toThrow('Plugin registry');
        await expect(next.install(h.source, true)).rejects.toThrow('Plugin registry');
        expect(fs.readFileSync(path.join(h.options.directory, 'installed.json'), 'utf8')).toBe('{broken');
    });
    it('serializes administrative mutations so a simultaneous disable wins after install', async () => {
        const h = harness();
        const installing = h.service.install(h.source, true);
        await installing;
        const reload = h.service.request('reload', { pluginID: id });
        const disable = h.service.request('disable', { pluginID: id });
        await Promise.all([reload, disable]);
        expect(h.service.list()[0]?.status).toBe('disabled');
    });
});
