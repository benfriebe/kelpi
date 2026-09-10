import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pluginObject, type JsonObject } from '@kelpi/protocol';
import { PluginService } from './service.js';
import { attachFakeHost, flush, NOW, SHELL_PANE, WEB_PANE, WEB_TAB, webHarness, WORKSPACE } from '../webpane/testing.js';

const PLUGIN = 'sample.browser', VIEW = `${PLUGIN}.chrome`;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of cleanups.splice(0).reverse()) await stop(); });
async function harness(backend?: string) {
    const h = webHarness(), broadcast = vi.fn(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-browser-plugin-'));
    const source = path.join(root, 'source'); fs.mkdirSync(path.join(source, 'ui'), { recursive: true });
    fs.writeFileSync(path.join(source, 'ui', 'index.html'), '<main>Browser</main>');
    fs.writeFileSync(path.join(source, 'kelpi.plugin.json'), JSON.stringify({ id: PLUGIN, version: '1.0.0', apiVersion: 1, trust: 'full',
        ...(backend ? { backend: 'backend.mjs' } : {}), contributes: { views: [{ id: VIEW, title: 'Custom browser', entry: 'ui/index.html', placements: ['browser'] }],
            ...(backend ? { commands: [{ id: `${PLUGIN}.run`, title: 'Get browser' }] } : {}) } }));
    if (backend) fs.writeFileSync(path.join(source, 'backend.mjs'), backend);
    const options = { directory: path.join(root, 'installed'), store: h.store, webPanes: h.service, broadcast, command: async (): Promise<JsonObject> => ({ ok: true }) };
    const plugins = new PluginService(options);
    cleanups.push(async () => { await plugins.dispose(); h.service.close(); fs.rmSync(root, { recursive: true, force: true }); });
    await plugins.install(source, true);
    const caller = { daemonID: plugins.daemonID, clientID: 'window-client', windowID: 'shell-window' };
    const attach = () => plugins.request('attach', { pluginID: PLUGIN, viewID: VIEW, paneID: WEB_PANE }, caller).then(pluginObject);
    const api = (lease: string, method: string, args: JsonObject = {}) => plugins.request('api', { lease, method, args }, caller);
    return { ...h, root, source, options, plugins, caller, attach, api, broadcast };
}
async function policy(h: Awaited<ReturnType<typeof harness>>, before: string) {
    const pluginID = 'sample.browser-policy', source = path.join(h.root, 'policy');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'kelpi.plugin.json'), JSON.stringify({ id: pluginID, version: '1.0.0', apiVersion: 1, trust: 'full', backend: 'backend.mjs',
        contributes: { hooks: [{ id: `${pluginID}.before`, phase: 'before', commands: ['web-navigate'], timeoutMs: 2000 }, { id: `${pluginID}.after`, phase: 'after', commands: ['web-navigate'] }] } }));
    fs.writeFileSync(path.join(source, 'backend.mjs'), `export function activate(api) {
        api.hooks.register('${pluginID}.before', async operation => {
            await api.storage.set('before', {operation, count:(await api.storage.get('before'))?.count + 1 || 1});
            ${before}
        });
        api.hooks.register('${pluginID}.after', async operation => { await api.storage.set('after', {operation, count:(await api.storage.get('after'))?.count + 1 || 1}); });
    }`);
    await h.plugins.install(source, true);
    const context = { daemonID: h.plugins.daemonID };
    return { pluginID, get: (key: string) => h.plugins.api(pluginID, 'storage.get', { key }, context), set: (key: string, value: JsonObject[string]) => h.plugins.api(pluginID, 'storage.set', { key, value }, context) };
}

describe('browser renderer view leases', () => {
    it('attaches renderer state independently of native tabs, private partitions and host lifecycle', async () => {
        const h = await harness(), host = attachFakeHost(h.service);
        await h.plugins.request('browser', { method: 'setPrivate', args: { paneID: WEB_PANE, isPrivate: true } });
        const before = h.state(), notifications = host.notifies.length, first = await h.attach();
        expect(first['context']).toMatchObject({ daemonID: h.plugins.daemonID, paneID: WEB_PANE, workspaceID: WORKSPACE, viewID: VIEW, windowID: h.caller.windowID });
        await h.api(String(first['lease']), 'views.setState', { state: { compact: true, accent: 'blue' } });
        expect(h.state()).toBe(before);
        expect(h.state().workspaces[0]?.panes.find(pane => pane.id === WEB_PANE)?.plugin).toBeUndefined();
        await h.plugins.request('release', { lease: first['lease']! }, h.caller);
        const next = await h.attach();
        expect(next['state']).toEqual({ compact: true, accent: 'blue' });
        expect(await h.api(String(next['lease']), 'browser.get')).toMatchObject({ activeTabID: WEB_TAB, isPrivate: true, host: { available: true } });
        expect(host.notifies).toHaveLength(notifications);
        await expect(h.plugins.api(PLUGIN, 'views.setState', { state: {} }, { daemonID: h.plugins.daemonID, paneID: WEB_PANE, viewID: VIEW })).rejects.toThrow('requires an attached view');
    });

    it('only attaches browser replacements to visible native browsers and revokes a closed incarnation', async () => {
        const h = await harness();
        await expect(h.plugins.request('attach', { pluginID: PLUGIN, viewID: VIEW, paneID: SHELL_PANE }, h.caller)).rejects.toThrow('does not own');
        const first = await h.attach();
        await expect(h.api(String(first['lease']), 'browser.tabs.select')).rejects.toThrow('tabID');
        await expect(h.api(String(first['lease']), 'browser.tabs.close')).rejects.toThrow('tabID');
        await expect(h.api(String(first['lease']), 'browser.find', { action: 'search' })).rejects.toThrow('tabID');
        await expect(h.api(String(first['lease']), 'browser.zoom', { direction: 'in' })).rejects.toThrow('tabID');
        h.store.dispatch({ type: 'park-pane', workspaceID: WORKSPACE, paneID: WEB_PANE });
        await expect(h.api(String(first['lease']), 'browser.get')).rejects.toThrow('expired');
        await expect(h.attach()).rejects.toThrow('does not own');
        h.store.dispatch({ type: 'unpark-pane', workspaceID: WORKSPACE, paneID: WEB_PANE });
        const current = await h.attach();
        expect(current['lease']).not.toBe(first['lease']);
        expect(await h.api(String(current['lease']), 'browser.get')).toMatchObject({ paneID: WEB_PANE });
    });

    it('rechecks the pane after asynchronous view activation', async () => {
        const h = await harness();
        const pending = h.attach();
        h.store.dispatch({ type: 'park-pane', workspaceID: WORKSPACE, paneID: WEB_PANE });
        await expect(pending).rejects.toThrow('does not own');
    });

    it('cancels only the released view host waits and requires the owning client', async () => {
        const h = await harness(), host = attachFakeHost(h.service), first = await h.attach(), second = await h.attach();
        const pending = h.api(String(first['lease']), 'browser.exec', { script: 'pending()' }), healthy = h.api(String(second['lease']), 'browser.capture', { mode: 'text' });
        const cancelled = expect(pending).rejects.toThrow('cancelled');
        await expect(h.plugins.request('api', { lease: first['lease']!, method: 'browser.get', args: {} }, { ...h.caller, clientID: 'foreign-client' })).rejects.toThrow('another client');
        await h.plugins.request('release', { lease: first['lease']! }, h.caller); await cancelled;
        expect(h.service.host.pending).toBe(1);
        host.answer({ ok: true, result: 'late' }, 'exec');
        host.answer({ ok: true, text: 'same page' }, 'capture');
        expect(await healthy).toMatchObject({ text: 'same page' });
        expect(h.service.host.pending).toBe(0);
    });

    it('retains per-view subscriptions separately and releases them on client disconnect and plugin disable', async () => {
        const h = await harness(), first = await h.attach(), second = await h.attach();
        const watched = pluginObject(await h.api(String(first['lease']), 'browser.watch'));
        await h.api(String(second['lease']), 'browser.unwatch', { subscription: watched['subscription']! });
        const before = h.broadcast.mock.calls.length;
        h.service.favourites.toggle('https://saved.example', 'Native change'); await flush();
        expect(h.broadcast.mock.calls.slice(before).some(([event]) => event['type'] === 'plugin-event' && pluginObject(event['event'])['name'] === 'browser.changed')).toBe(true);
        h.plugins.releaseClient(h.caller.clientID);
        h.broadcast.mockClear();
        h.service.favourites.toggle('https://saved2.example', 'After disconnect'); await flush();
        expect(h.broadcast.mock.calls.some(([event]) => event['type'] === 'plugin-event' && pluginObject(event['event'])['name'] === 'browser.changed')).toBe(false);
        const next = await h.attach(); await h.api(String(next['lease']), 'browser.watch');
        await h.plugins.request('disable', { pluginID: PLUGIN });
        await expect(h.api(String(next['lease']), 'browser.get')).rejects.toThrow('expired');
        expect(h.state().workspaces[0]?.webPanes[WEB_PANE]?.tabs[0]?.id).toBe(WEB_TAB);
    });

    it('shares the native snapshot with CLI/control readers and publishes host availability without a view lease', async () => {
        const h = await harness();
        expect(await h.plugins.request('browser', { method: 'get', args: { paneID: WEB_PANE } })).toMatchObject({ host: { available: false } });
        const registration = h.service.registerHost({ sendJson() {} }, { name: 'Shell', windowID: 'host-window' });
        expect(await h.plugins.request('browser', { method: 'get', args: { paneID: WEB_PANE } })).toMatchObject({ host: { available: true, windowID: 'host-window' } });
        expect(h.broadcast).toHaveBeenCalledWith({ type: 'web-browser-changed', paneID: null });
        registration.release();
        expect(await h.plugins.request('browser', { method: 'get', args: { paneID: WEB_PANE } })).toMatchObject({ host: { available: false } });
    });

    it('keeps native browser state available beyond plugin RPC limits while SDK snapshots remain bounded', async () => {
        const h = await harness(), host = attachFakeHost(h.service), view = await h.attach();
        for (let index = 0; index < 40; index++) h.service.favourites.toggle(`https://saved-${index}.example`, `Title ${index}: ${'x'.repeat(8192)}`);
        const native = await h.plugins.request('browser-state', { paneID: WEB_PANE });
        expect(JSON.stringify(native).length).toBeGreaterThan(256 * 1024);
        expect(native).toMatchObject({ host: { available: true, id: host.registration.hostID }, activeTabID: WEB_TAB });
        expect(pluginObject({ count: (native as { favourites: unknown[] }).favourites.length })).toEqual({ count: 40 });
        await expect(h.api(String(view['lease']), 'browser.get')).rejects.toThrow('256 KiB');
        await expect(h.api(String(view['lease']), 'browser.watch')).rejects.toThrow('256 KiB');
        await expect(h.api(String(view['lease']), 'browser-state')).rejects.toThrow('unknown plugin API');
        expect(h.service.hasHost).toBe(true);
    });

    it('runs the public browser SDK from an isolated backend against the same daemon tabs and snapshot', async () => {
        const h = await harness(`export function activate(api) {
            api.commands.register('${PLUGIN}.run', async args => {
                const watch = await api.browser.watch(args.paneID);
                try {
                    const opened = await api.browser.tabs.open(args.paneID, 'https://backend.example', {makeActive:false});
                    const after = await api.browser.get(args.paneID);
                    return {before:watch.state,opened,after};
                } finally { await api.browser.unwatch(watch.subscription); }
            });
        }`);
        const result = pluginObject(await h.plugins.request('run', { command: `${PLUGIN}.run`, args: { paneID: WEB_PANE } }));
        expect(result['before']).toMatchObject({ activeTabID: WEB_TAB, tabs: [{ id: WEB_TAB }], host: { available: false } });
        expect(result['opened']).toMatchObject({ paneID: WEB_PANE, tabID: expect.any(String), active: false });
        const tabID = String(pluginObject(result['opened'])['tabID']);
        expect(result['after']).toMatchObject({ activeTabID: WEB_TAB, tabs: [{ id: WEB_TAB }, { id: tabID, url: 'https://backend.example' }] });
        expect(h.reply({ command: 'web-tabs', target: WEB_PANE })).toMatchObject({ tabs: [{ id: WEB_TAB }, { id: tabID }] });
    });

    it('a released renderer cannot restore native view state through a stale lease after pane id reuse', async () => {
        const h = await harness(), first = await h.attach();
        h.store.dispatch({ type: 'close-pane', workspaceID: WORKSPACE, paneID: WEB_PANE });
        h.store.dispatch({ type: 'open-web-pane', workspaceID: WORKSPACE, paneID: WEB_PANE, tabID: WEB_TAB, url: 'https://new.example', now: NOW + 2 });
        await expect(h.api(String(first['lease']), 'views.setState', { state: { stale: true } })).rejects.toThrow('expired');
        const current = await h.attach(); expect(current['state']).toEqual({});
    });

    it('runs canonical before/after hooks once for SDK browser actions and native browser control requests', async () => {
        const h = await harness(`export function activate(api) { api.commands.register('${PLUGIN}.run', args => api.browser.navigate(args.paneID, args.url)); }`);
        const host = attachFakeHost(h.service), p = await policy(h, "return {allow:false,reason:'Navigation blocked by browser policy'};");
        await expect(h.plugins.request('run', { command: `${PLUGIN}.run`, args: { paneID: WEB_PANE, url: 'https://blocked.example' } })).rejects.toThrow('Navigation blocked by browser policy');
        await vi.waitFor(async () => expect(await p.get('after')).toMatchObject({ count: 1, operation: { command: 'web-navigate', source: 'plugin', result: { ok: false, code: 'PLUGIN_VETO' } } }));
        expect(await p.get('before')).toMatchObject({ count: 1, operation: { payload: { command: 'web-navigate', pane_id: WEB_PANE, target: WEB_PANE, tab_id: WEB_TAB, url: 'https://blocked.example' }, context: { paneID: WEB_PANE, workspaceID: WORKSPACE } } });
        expect(await h.plugins.request('browser', { method: 'navigate', args: { paneID: WEB_PANE, url: 'https://control.example' } })).toMatchObject({ ok: false, code: 'PLUGIN_VETO' });
        await vi.waitFor(async () => expect(await p.get('after')).toMatchObject({ count: 2, operation: { source: 'cli' } }));
        expect(host.calls).toHaveLength(0);
        expect(h.state().workspaces[0]?.webPanes[WEB_PANE]?.tabs[0]?.url).toBe('https://example.com');
    });

    it('captures the intended tab before a slow policy hook and never navigates a newly selected tab', async () => {
        const h = await harness(), host = attachFakeHost(h.service), p = await policy(h, "while (!await api.storage.get('proceed')) await new Promise(resolve => setTimeout(resolve,5)); return {allow:true};");
        const view = await h.attach(), pending = h.api(String(view['lease']), 'browser.navigate', { url: 'https://captured.example' });
        await vi.waitFor(async () => expect(await p.get('before')).toMatchObject({ count: 1 }));
        const opened = h.reply({ command: 'web-tab-new', pane_id: WEB_PANE, url: 'https://new-tab.example', make_active: true });
        await p.set('proceed', true);
        await vi.waitFor(() => expect(host.calls).toHaveLength(1));
        expect(host.calls[0]?.args).toEqual({ paneID: WEB_PANE, tabID: WEB_TAB, url: 'https://captured.example' });
        host.answer({ ok: true }, 'navigate');
        expect(await pending).toMatchObject({ ok: true, tab_id: WEB_TAB });
        expect(h.state().workspaces[0]?.webPanes[WEB_PANE]).toMatchObject({ activeTabID: opened['tab_id'], tabs: [{ id: WEB_TAB, url: 'https://captured.example' }, { id: opened['tab_id'], url: 'https://new-tab.example' }] });
        await vi.waitFor(async () => expect(await p.get('after')).toMatchObject({ count: 1, operation: { result: { ok: true, tab_id: WEB_TAB } } }));
    });

    it('revalidates session identity after an asynchronous before hook and rejects a replaced private session before effects', async () => {
        const h = await harness(), host = attachFakeHost(h.service), p = await policy(h, "while (!await api.storage.get('proceed')) await new Promise(resolve => setTimeout(resolve,5)); return {allow:true};");
        const view = await h.attach(), pending = h.api(String(view['lease']), 'browser.navigate', { url: 'https://must-not-load.example' });
        await vi.waitFor(async () => expect(await p.get('before')).toMatchObject({ count: 1 }));
        h.reply({ command: 'web-private', pane_id: WEB_PANE, private: true });
        await p.set('proceed', true);
        expect(await pending).toMatchObject({ ok: false, error: 'Browser operation target changed.' });
        expect(host.calls).toHaveLength(0);
        expect(h.state().workspaces[0]?.webPanes[WEB_PANE]?.tabs[0]?.url).toBe('https://example.com');
        await vi.waitFor(async () => expect(await p.get('after')).toMatchObject({ count: 1, operation: { result: { ok: false } } }));
    });

    it('releasing a view cancels its before hook wait without failing the policy plugin or applying effects', async () => {
        const h = await harness(), host = attachFakeHost(h.service), p = await policy(h, 'await new Promise(resolve => setTimeout(resolve,200)); return {allow:true};');
        const view = await h.attach(), pending = h.api(String(view['lease']), 'browser.navigate', { url: 'https://must-not-load.example' });
        await vi.waitFor(async () => expect(await p.get('before')).toMatchObject({ count: 1 }));
        await h.plugins.request('release', { lease: view['lease']! }, h.caller);
        expect(await pending).toMatchObject({ ok: false, code: 'PLUGIN_OPERATION_CANCELLED' });
        expect(host.calls).toHaveLength(0);
        expect(h.plugins.list().find(item => item.manifest.id === p.pluginID)?.status).toBe('running');
        await vi.waitFor(async () => expect(await p.get('after')).toMatchObject({ count: 1, operation: { result: { code: 'PLUGIN_OPERATION_CANCELLED' } } }));
    });
});
