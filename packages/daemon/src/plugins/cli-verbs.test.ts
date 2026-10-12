import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pluginPackageReport, readPluginPackage } from '@kelpi/core/plugin-package';
import type { JsonObject } from '@kelpi/protocol';
import { createStore } from '../store/store.js';
import { seededState } from '../store/testing.js';
import { PluginService } from './service.js';

const id = 'sample.verbs';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of cleanups.splice(0).reverse()) await stop(); });
const backend = (pluginID: string) => `export async function activate(api) {
    api.commands.register('${pluginID}.hello', args => ({ text: 'hello ' + args.argv.join(' '), exitCode: 3 }));
    api.commands.register('${pluginID}.echo', (args, context) => ({ args, context }));
    api.commands.register('${pluginID}.plain', args => args.argv[0] === 'array' ? ['x'] : args.argv[0] === 'null' ? null : 'just text');
}`;
const verbs = (pluginID: string, names: { hello?: string; echo?: string; plain?: string } = {}) => [
    { name: names.hello ?? 'hello', command: `${pluginID}.hello`, summary: 'Say hello to the arguments' },
    { name: names.echo ?? 'echo-call', command: `${pluginID}.echo`, summary: 'Return the invocation' },
    { name: names.plain ?? 'plain', command: `${pluginID}.plain`, summary: 'Return something other than an object' },
];
function harness() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-plugin-cli-verbs-'));
    const write = (folder: string, pluginID: string, cli: unknown, version = '1.0.0'): string => {
        const source = path.join(root, folder); fs.mkdirSync(source, { recursive: true });
        fs.writeFileSync(path.join(source, 'kelpi.plugin.json'), JSON.stringify({ id: pluginID, name: `Plugin ${pluginID}`, version, apiVersion: 1, trust: 'full', backend: 'backend.mjs', contributes: {
            commands: ['hello', 'echo', 'plain'].map(name => ({ id: `${pluginID}.${name}`, title: name })), cli,
        } }));
        fs.writeFileSync(path.join(source, 'backend.mjs'), backend(pluginID));
        return source;
    };
    const store = createStore(seededState());
    const service = new PluginService({ directory: path.join(root, 'installed'), store, command: vi.fn(async (): Promise<JsonObject> => ({ ok: true })), broadcast: vi.fn() });
    cleanups.push(async () => { await service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
    const call = (verb: string, argv: string[] = [], extra: JsonObject = {}) => service.request('cli', { verb, argv, cwd: '/x', isTTY: false, json: false, ...extra });
    return { root, write, store, service, call };
}

describe('plugin CLI verbs (#391)', () => {
    it('reports declared verbs when a package is validated offline', async () => {
        const h = harness();
        const report = pluginPackageReport(await readPluginPackage(h.write('source', id, verbs(id))));
        expect(report.cli).toEqual(verbs(id));
        const bare = h.write('bare', 'sample.bare', undefined);
        expect(pluginPackageReport(await readPluginPackage(bare)).cli).toEqual([]);
    });

    it('lists every installed verb with its owner, disabled plugins included', async () => {
        const h = harness();
        await h.service.install(h.write('first', id, verbs(id)), true);
        await h.service.install(h.write('second', 'sample.other', [{ name: 'other', command: 'sample.other.hello', summary: 'Another' }]), true);
        await h.service.install(h.write('none', 'sample.none', undefined), true);
        await h.service.request('disable', { pluginID: 'sample.other' });
        expect(await h.service.request('cli-list', {})).toEqual({ verbs: [
            ...verbs(id).map(verb => ({ ...verb, pluginID: id, pluginName: `Plugin ${id}`, enabled: true })),
            { name: 'other', summary: 'Another', command: 'sample.other.hello', pluginID: 'sample.other', pluginName: 'Plugin sample.other', enabled: false },
        ] });
    });

    it('runs the mapped command with argv and the caller pane, and returns its result as is', async () => {
        const h = harness();
        await h.service.install(h.write('source', id, verbs(id)), true);
        expect(await h.call('hello', ['a', 'b'])).toEqual({ text: 'hello a b', exitCode: 3 });
        const workspace = h.store.getState().workspaces[0]!, paneID = workspace.panes[0]!.id;
        const echoed = await h.call('echo-call', ['a', 'b'], { paneID }) as JsonObject;
        expect(echoed['args']).toEqual({ argv: ['a', 'b'], cwd: '/x', isTTY: false, json: false });
        expect(echoed['context']).toMatchObject({ daemonID: h.service.daemonID, paneID, workspaceID: workspace.id });
        const flags = await h.call('echo-call', ['--help'], { isTTY: true, json: true, cwd: '/elsewhere' }) as JsonObject;
        expect(flags['args']).toEqual({ argv: ['--help'], cwd: '/elsewhere', isTTY: true, json: true });
        expect(flags['context']).not.toHaveProperty('paneID');
        expect(flags['context']).not.toHaveProperty('workspaceID');
        // A pane the store does not know leaves the workspace out; an explicit one is kept.
        expect((await h.call('echo-call', [], { paneID: 'gone' }) as JsonObject)['context']).not.toHaveProperty('workspaceID');
        expect((await h.call('echo-call', [], { paneID, workspaceID: 'given' }) as JsonObject)['context']).toMatchObject({ paneID, workspaceID: 'given' });
        for (const shape of ['text', 'array', 'null']) expect(await h.call('plain', [shape])).toEqual({});
        await expect(h.call('hello', ['a', 1 as unknown as string])).rejects.toThrow('missing or invalid argv');
    });

    it('says an unknown verb is unknown and a disabled owner is disabled', async () => {
        const h = harness();
        await expect(h.call('nope')).rejects.toThrow('unknown kelpi verb: nope');
        await h.service.install(h.write('source', id, verbs(id)), true);
        await expect(h.call('nope')).rejects.toThrow('unknown kelpi verb: nope');
        await h.service.request('disable', { pluginID: id });
        await expect(h.call('hello', ['a'])).rejects.toThrow(`plugin ${id} is disabled`);
        await h.service.request('enable', { pluginID: id });
        expect(await h.call('hello', ['a'])).toEqual({ text: 'hello a', exitCode: 3 });
        await h.service.request('remove', { pluginID: id });
        await expect(h.call('hello')).rejects.toThrow('unknown kelpi verb: hello');
    });

    it('refuses a verb another installed plugin provides, but lets the owner reinstall and update', async () => {
        const h = harness();
        await h.service.install(h.write('first', id, verbs(id)), true);
        await expect(h.service.install(h.write('rival', 'sample.rival', verbs('sample.rival', { echo: 'rival-echo', plain: 'rival-plain' })), true)).rejects.toThrow(`cli verb "hello" is already provided by plugin ${id}`);
        expect(h.service.list().map(plugin => plugin.manifest.id)).toEqual([id]);
        // A disabled owner still holds its names.
        await h.service.request('disable', { pluginID: id });
        await expect(h.service.install(h.write('rival', 'sample.rival', verbs('sample.rival', { echo: 'rival-echo', plain: 'rival-plain' })), true)).rejects.toThrow(`cli verb "hello" is already provided by plugin ${id}`);
        await h.service.request('enable', { pluginID: id });
        await h.service.install(h.write('first', id, verbs(id)), true);
        await h.service.install(h.write('first', id, verbs(id), '1.1.0'), true);
        expect(h.service.list()[0]!.manifest.version).toBe('1.1.0');
        expect(await h.call('hello', ['b'])).toEqual({ text: 'hello b', exitCode: 3 });
        // Different names install side by side.
        await h.service.install(h.write('rival', 'sample.rival', verbs('sample.rival', { hello: 'rival-hello', echo: 'rival-echo', plain: 'rival-plain' })), true);
        expect(await h.call('rival-hello', ['c'])).toEqual({ text: 'hello c', exitCode: 3 });
    });
});
