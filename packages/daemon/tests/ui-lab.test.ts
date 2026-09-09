import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pluginObject, type JsonObject, type PluginEvent } from '@kelpi/protocol';
import { createStore } from '../src/store/store.js';
import { seededState } from '../src/store/testing.js';
import { PluginService } from '../src/plugins/service.js';

const id = 'example.ui-lab';
const itemIDs = [`${id}.counter`, `${id}.workspace`, `${id}.pane`];
const source = fileURLToPath(new URL('../../../examples/plugins/ui-lab/', import.meta.url));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function harness() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-ui-lab-'));
    const broadcast = vi.fn<(event: JsonObject) => void>();
    const service = new PluginService({ directory: root, store: createStore(seededState()), command: async () => ({ ok: true }), broadcast });
    cleanups.push(async () => { await service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
    const api = (method: string, args: JsonObject = {}) => service.api(id, method, args, { daemonID: service.daemonID });
    const run = (name: string, args: JsonObject = {}) => service.request('run', { command: `${id}.${name}`, args });
    const events = () => broadcast.mock.calls.map(([message]) => message).filter(message => message['type'] === 'plugin-event').map(message => pluginObject(message['event']));
    return { service, api, run, events };
}

// Read-only inspection proves a real queue overflow and waits for its acknowledgements;
// neither event delivery nor the installed example/SDK runner is replaced by a test stub.
function backendQueue(service: PluginService) {
    const runtime = (service as unknown as { readonly running: ReadonlyMap<string, {
        readonly sending: boolean;
        readonly queue: { readonly entries: ReadonlyArray<{ readonly event: PluginEvent }> };
    }> }).running.get(id)!;
    return {
        events: () => runtime.queue.entries.map(entry => entry.event),
        drained: () => expect.poll(() => !runtime.sending && runtime.queue.entries.length === 0, { timeout: 2000 }).toBe(true),
    };
}

function expectCounter(service: PluginService, count: number, step: number, density: string, enabled = true, visible = true) {
    expect(service.contributions().find(info => info.pluginID === id)?.state).toEqual({
        context: { count, enabled, visible },
        items: Object.fromEntries(itemIDs.map(itemID => [itemID, {
            badge: String(count), tone: enabled ? 'info' : 'warning', enabled, visible,
            tooltip: `UI Lab count ${count}; step ${step}; ${density} layout`,
        }])),
    });
}

describe('UI Lab example backend', () => {
    it('republishes every native tooltip after settings events are lost to queue gaps without changing the count', async () => {
        const h = harness(); await h.service.install(source, true);
        await Promise.all([h.run('increment'), h.run('increment')]);
        expectCounter(h.service, 2, 1, 'comfortable');
        const queue = backendQueue(h.service); await queue.drained();

        for (const settings of [{ step: 3, density: 'compact' }, { step: 2, density: 'comfortable' }]) {
            const before = h.events().length;
            // Do not yield between emissions: the first noise event is in flight while
            // both settings events and the burst overflow the real 32-entry queue.
            const burst = [
                h.api('events.emit', { name: 'noise' }),
                h.api('settings.set', { key: 'step', value: settings.step }),
                h.api('settings.set', { key: 'density', value: settings.density }),
                ...Array.from({ length: 80 }, (_, data) => h.api('events.emit', { name: 'noise', data })),
            ];
            await Promise.all(burst);
            const queued = queue.events();
            expect(queued[0]).toMatchObject({ name: 'gap', data: null });
            expect(queued[0]).not.toHaveProperty('pluginID');
            expect(queued.some(event => event.name === 'settings.changed')).toBe(false);
            expect(h.events().slice(before).filter(event => event['name'] === 'settings.changed')).toHaveLength(2);
            await queue.drained();

            // Assert recovery before snapshot, toggle, increment, or another settings event
            // can refresh/publish the backend's cache as a side effect.
            expectCounter(h.service, 2, settings.step, settings.density);
            const published = h.events().slice(before).filter(event => event['name'] === 'plugin.contributions.changed');
            expect(published).toHaveLength(1);
            expect(pluginObject(published[0]!['data'])['state']).toEqual(h.service.contributions()[0]!.state);
            expect(pluginObject(await h.run('snapshot'))['settings']).toMatchObject(settings);
        }

        await h.run('toggle', { field: 'enabled', value: false });
        await h.run('toggle', { field: 'visible', value: false });
        expectCounter(h.service, 2, 2, 'comfortable', false, false);
        await h.run('toggle', { field: 'enabled', value: true });
        await h.run('toggle', { field: 'visible', value: true });
        await Promise.all(Array.from({ length: 8 }, () => h.run('increment')));
        expectCounter(h.service, 18, 2, 'comfortable');
    });

    it('keeps concurrent increments and ordinary settings refreshes ordered across reload', async () => {
        const h = harness(); await h.service.install(source, true);
        await Promise.all(Array.from({ length: 12 }, () => h.run('increment')));
        expectCounter(h.service, 12, 1, 'comfortable');
        await h.api('settings.set', { key: 'step', value: 3 });
        await h.api('settings.set', { key: 'density', value: 'compact' });
        await backendQueue(h.service).drained();
        expectCounter(h.service, 12, 3, 'compact');
        await Promise.all(Array.from({ length: 4 }, () => h.run('increment')));
        expectCounter(h.service, 24, 3, 'compact');
        await h.service.request('reload', { pluginID: id });
        expectCounter(h.service, 0, 3, 'compact');
        await h.run('increment');
        expectCounter(h.service, 3, 3, 'compact');
    });
});
