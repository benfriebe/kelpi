import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pluginObject, type JsonObject } from '@kelpi/protocol';
import { createStore } from '../store/store.js';
import { seededState } from '../store/testing.js';
import { PluginService } from './service.js';

const id = 'sample.rich', itemID = `${id}.status`;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of cleanups.splice(0).reverse()) await stop(); });
const backend = (seed = '') => `export async function activate(api) {
    api.commands.register('${id}.update', args => api.call('contributions.update', args));
    api.commands.register('${id}.get', () => api.call('contributions.get'));
    api.commands.register('${id}.crash', () => { setTimeout(() => process.exit(7), 1); return null; });
    ${seed}
}`;
function harness(sourceText = backend()) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-plugin-contributions-'));
    const source = path.join(root, 'source'); fs.mkdirSync(path.join(source, 'ui'), { recursive: true });
    const manifest = { id, name: 'Rich', version: '1.0.0', apiVersion: 1, trust: 'full', activation: 'startup', backend: 'backend.mjs', contributes: {
        views: [{ id: `${id}.view`, title: 'View', entry: 'ui/index.html', placements: ['pane', 'sidebar.primary'] }],
        commands: [{ id: `${id}.update`, title: 'Update', when: { 'context.ready': true } }, { id: `${id}.get`, title: 'Get' }, { id: `${id}.crash`, title: 'Crash' }],
        items: [{ id: itemID, placement: 'statusbar', text: 'Ready', command: `${id}.get` }],
        menus: [{ id: `${id}.menu`, placement: 'workspace', command: `${id}.get` }],
        settingGroups: [{ id: `${id}.general`, title: 'General' }],
        settings: { mode: { title: 'Mode', type: 'string', default: 'compact', enum: ['compact', 'expanded'], group: `${id}.general` }, limit: { title: 'Limit', type: 'number', default: 5, min: 0, max: 10 } },
    } };
    const writeManifest = (value: unknown = manifest): void => fs.writeFileSync(path.join(source, 'kelpi.plugin.json'), JSON.stringify(value));
    writeManifest(); fs.writeFileSync(path.join(source, 'backend.mjs'), sourceText); fs.writeFileSync(path.join(source, 'ui/index.html'), '<h1>View</h1>');
    const options = { directory: path.join(root, 'installed'), store: createStore(seededState()), command: vi.fn(async (): Promise<JsonObject> => ({ ok: true })), broadcast: vi.fn() };
    const service = new PluginService(options);
    cleanups.push(async () => { await service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
    const context = { daemonID: service.daemonID, clientID: 'owner' };
    const api = (method: string, args: JsonObject = {}) => service.api(id, method, args, context);
    const update = (args: JsonObject) => service.request('run', { command: `${id}.update`, args });
    const events = () => options.broadcast.mock.calls.map(([event]) => event as JsonObject).filter(event => event['type'] === 'plugin-event').map(event => pluginObject(event['event'])).filter(event => event['name'] === 'plugin.contributions.changed');
    return { root, source, manifest, writeManifest, service, options, context, api, update, events };
}

describe('daemon UI contribution state', () => {
    it('accepts real backend updates and publishes complete ordered state under the final instance identity', async () => {
        const h = harness(backend(`await api.call('contributions.update', { context: { seeded: true }, items: { '${itemID}': { text: 'Activated' } } });`));
        await h.service.install(h.source, true);
        const info = h.service.list()[0]!;
        expect(await h.service.request('contributions', {})).toEqual([{ pluginID: id, instanceID: info.instanceID, sequence: expect.any(Number), state: { context: { seeded: true }, items: { [itemID]: { text: 'Activated' } } } }]);
        const first = h.service.contributions()[0]!;
        const result = await h.update({ context: { count: 1 }, items: { [itemID]: { badge: '1', tone: 'info' } } });
        expect(result).toEqual({ context: { seeded: true, count: 1 }, items: { [itemID]: { text: 'Activated', badge: '1', tone: 'info' } } });
        const event = h.events().at(-1)!;
        expect(event['pluginID']).toBe(id);
        expect(event['data']).toEqual({ pluginID: id, instanceID: info.instanceID, sequence: event['sequence'], state: result });
        const current = h.service.contributions()[0]!;
        expect(current.sequence).toBeGreaterThan(first.sequence);
        expect(current).toEqual(event['data']);
        const clone = pluginObject(await h.api('contributions.get')); (clone['context'] as Record<string, unknown>)['count'] = 500;
        expect(await h.service.request('run', { command: `${id}.get` })).toEqual(result);
        const eventCount = h.events().length;
        await h.update({ context: { count: 1 } });
        expect(h.events()).toHaveLength(eventCount);
        // Command when/enablement are presentation conditions, not daemon authorization.
        expect(h.service.list()[0]!.manifest.contributes.commands[0]!.when).toEqual({ 'context.ready': true });
    });

    it('shares state across owned views and rejects stale leases or attempts to update another plugin item', async () => {
        const h = harness(); await h.service.install(h.source, true);
        const first = pluginObject(await h.service.request('attach', { pluginID: id, viewID: `${id}.view` }, h.context));
        const second = pluginObject(await h.service.request('attach', { pluginID: id, viewID: `${id}.view` }, h.context));
        const request = { lease: first['lease']!, method: 'contributions.update', args: { context: { ready: true }, items: { [itemID]: { enabled: false } } } };
        await expect(h.service.request('api', request, { ...h.context, clientID: 'other' })).rejects.toThrow('another client');
        await h.service.request('api', request, h.context);
        expect(await h.service.request('api', { lease: second['lease']!, method: 'contributions.get' }, h.context)).toEqual(request.args);
        await expect(h.service.request('api', { ...request, args: { context: { ready: false }, items: { 'another.plugin.status': { text: 'Hijacked' } } } }, h.context)).rejects.toThrow('not declared');
        expect(await h.api('contributions.get')).toEqual(request.args);
        await h.service.request('reload', { pluginID: id });
        await expect(h.service.request('api', request, h.context)).rejects.toThrow('expired');
        await expect(h.service.api(id, 'contributions.update', request.args, h.context, String(first['lease']))).rejects.toThrow('expired');
        expect(await h.api('contributions.get')).toEqual({ context: {}, items: {} });
    });

    it('rejects excessive updates atomically and allows bounded resets afterward', async () => {
        const h = harness(); await h.service.install(h.source, true);
        await h.update({ context: { ready: true }, items: { [itemID]: { text: 'Working', visible: false } } });
        const before = h.service.contributions()[0]!;
        for (const args of [
            { context: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`key${index}`, true])) },
            { context: Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`key${index}`, '💠'.repeat(1024)])) },
            { context: { ready: false }, items: { [itemID]: { command: `${id}.get` } } },
        ]) await expect(h.update(args)).rejects.toThrow();
        expect(h.service.contributions()[0]).toEqual(before);
        expect(await h.update({ context: { ready: null }, items: { [itemID]: null } })).toEqual({ context: {}, items: {} });
        expect(h.service.list()[0]?.status).toBe('running');
    });

    it('clears state on disable/reload/remove/failure and daemon restart without persisting it', async () => {
        const h = harness(); await h.service.install(h.source, true);
        for (const action of ['reload', 'disable'] as const) {
            await h.update({ context: { transient: action } });
            const instance = h.service.list()[0]!.instanceID;
            await h.service.request(action, { pluginID: id });
            expect(h.service.list()[0]!.instanceID).not.toBe(instance);
            if (action === 'disable') { expect(h.service.contributions()).toEqual([]); await h.service.request('enable', { pluginID: id }); }
            expect(await h.api('contributions.get')).toEqual({ context: {}, items: {} });
        }
        await h.update({ context: { transient: 'crash' } });
        await h.service.request('run', { command: `${id}.crash` });
        await vi.waitFor(() => expect(h.service.list()[0]?.status).toBe('failed'));
        expect(h.service.contributions()).toEqual([]);
        expect(pluginObject(h.events().at(-1)!['data'])['state']).toEqual({ context: {}, items: {} });
        await h.service.request('reload', { pluginID: id });
        expect(await h.api('contributions.get')).toEqual({ context: {}, items: {} });
        await h.update({ context: { transient: 'restart' } });
        await h.service.dispose();
        const restarted = new PluginService(h.options); cleanups.push(() => restarted.dispose());
        expect(restarted.contributions()[0]?.state).toEqual({ context: {}, items: {} });
        expect(restarted.contributions()[0]?.instanceID).not.toBe(h.service.list()[0]?.instanceID);
        await restarted.request('remove', { pluginID: id });
        expect(restarted.contributions()).toEqual([]);
        expect(fs.existsSync(path.join(h.options.directory, 'data', id, 'contributions.json'))).toBe(false);
    });

    it('rejects a stopped backend raw IPC write and never revives it in the next generation', async () => {
        const h = harness();
        const report = path.join(h.root, 'late-write.json');
        fs.writeFileSync(path.join(h.source, 'backend.mjs'), backend(`return () => new Promise(resolve => {
            process.on('message', message => { if (message.type === 'reply' && message.id === 'late-write') { import('node:fs').then(fs => { fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify(message)); resolve(); }); } });
            process.send({ type:'call', id:'late-write', method:'contributions.update', args:{context:{revived:true}} });
        });`));
        await h.service.install(h.source, true);
        await h.update({ context: { original: true } });
        await h.service.request('reload', { pluginID: id });
        expect(JSON.parse(fs.readFileSync(report, 'utf8'))).toMatchObject({ error: 'plugin is stopping' });
        expect(await h.api('contributions.get')).toEqual({ context: {}, items: {} });
        expect(h.service.contributions().every(info => !info.state.context['revived'])).toBe(true);
    });

    it('clears activation-time updates when activation fails and includes view-only available plugins', async () => {
        const h = harness(backend(`await api.call('contributions.update', {context:{partial:true}}); throw new Error('activation failed');`));
        await expect(h.service.install(h.source, true)).rejects.toThrow('activation failed');
        expect(h.service.contributions()).toEqual([]);
        expect(pluginObject(h.events().at(-1)!['data'])['state']).toEqual({ context: {}, items: {} });
        h.writeManifest({ ...h.manifest, backend: undefined, contributes: { views: h.manifest.contributes.views, items: [{ id: itemID, placement: 'statusbar', text: 'View only' }] } });
        await h.service.install(h.source, true);
        expect(h.service.list()[0]?.status).toBe('inactive');
        expect(h.service.contributions()).toMatchObject([{ pluginID: id, state: { context: {}, items: {} } }]);
        await h.api('contributions.update', { context: { ready: true } });
        expect(h.service.contributions()[0]?.state.context).toEqual({ ready: true });
    });

    it('clears a dependent plugin while its required dependency is unavailable and starts with fresh state on recovery', async () => {
        const h = harness(backend(`await api.call('contributions.update', {context:{activated:true}});`));
        const dependency = 'sample.dependency', source = path.join(h.root, 'dependency');
        fs.mkdirSync(source);
        fs.writeFileSync(path.join(source, 'kelpi.plugin.json'), JSON.stringify({ id: dependency, version: '1.0.0', apiVersion: 1, trust: 'full' }));
        await h.service.install(source, true);
        h.writeManifest({ ...h.manifest, dependencies: [{ pluginID: dependency, version: '^1.0.0' }] });
        await h.service.install(h.source, true);
        await h.update({ context: { previousGeneration: true } });
        const before = h.service.contributions().find(info => info.pluginID === id)!;
        await h.service.request('disable', { pluginID: dependency });
        expect(h.service.contributions().some(info => info.pluginID === id)).toBe(false);
        await expect(h.api('contributions.update', { context: { revived: true } })).rejects.toThrow('dependency');
        await h.service.request('enable', { pluginID: dependency });
        await vi.waitFor(() => expect(h.service.list().find(plugin => plugin.manifest.id === id)?.status).toBe('running'));
        const after = h.service.contributions().find(info => info.pluginID === id)!;
        expect(after.instanceID).not.toBe(before.instanceID);
        expect(after.sequence).toBeGreaterThan(before.sequence);
        expect(after.state).toEqual({ context: { activated: true }, items: {} });
    });

    it('rejects nested plugin installations claiming owned menu/item/setting group identities', async () => {
        const h = harness(); await h.service.install(h.source, true);
        for (const claimed of [itemID, `${id}.menu`, `${id}.general`]) {
            const source = path.join(h.root, claimed); fs.mkdirSync(source);
            fs.writeFileSync(path.join(source, 'kelpi.plugin.json'), JSON.stringify({ id: claimed, version: '1.0.0', apiVersion: 1, trust: 'full' }));
            await expect(h.service.install(source, true)).rejects.toThrow('already owned');
        }
        expect(h.service.list()).toHaveLength(1);
    });
});

describe('declared plugin setting constraints', () => {
    it('validates enum/range writes and preserves valid saved settings and their existing event contract', async () => {
        const h = harness(); await h.service.install(h.source, true);
        await h.service.request('settings', { pluginID: id, key: 'mode', value: 'expanded' });
        await h.service.request('settings', { pluginID: id, key: 'limit', value: 10 });
        const file = path.join(h.options.directory, 'data', id, 'settings.json');
        const before = fs.readFileSync(file, 'utf8');
        for (const input of [{ key: 'mode', value: 'custom' }, { key: 'limit', value: 11 }, { key: 'limit', value: -1 }, { key: 'limit', value: '5' }]) {
            await expect(h.service.request('settings', { pluginID: id, ...input })).rejects.toThrow();
            expect(fs.readFileSync(file, 'utf8')).toBe(before);
        }
        expect(await h.service.request('settings', { pluginID: id })).toEqual({ mode: 'expanded', limit: 10 });
        expect(h.options.broadcast.mock.calls.some(([message]) => {
            const event = message['event'] as JsonObject | undefined;
            return event?.['name'] === 'settings.changed' && event['pluginID'] === id && pluginObject(event['data'])['value'] === 'expanded';
        })).toBe(true);
    });
    it('falls back from saved values invalidated by a manifest update without rewriting user data', async () => {
        const h = harness(); await h.service.install(h.source, true);
        await h.service.request('settings', { pluginID: id, key: 'mode', value: 'expanded' });
        await h.service.request('settings', { pluginID: id, key: 'limit', value: 10 });
        const file = path.join(h.options.directory, 'data', id, 'settings.json');
        const before = fs.readFileSync(file, 'utf8');
        h.writeManifest({ ...h.manifest, version: '1.0.1', contributes: { ...h.manifest.contributes, settings: {
            mode: { ...h.manifest.contributes.settings.mode, enum: ['compact'] },
            limit: { ...h.manifest.contributes.settings.limit, max: 6 },
        } } });
        await h.service.install(h.source, true);
        expect(await h.service.request('settings', { pluginID: id })).toEqual({ mode: 'compact', limit: 5 });
        expect(fs.readFileSync(file, 'utf8')).toBe(before);
        h.writeManifest(); await h.service.install(h.source, true);
        expect(await h.service.request('settings', { pluginID: id })).toEqual({ mode: 'expanded', limit: 10 });
    });
});
