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
    const options = { directory: path.join(root, 'installed'), store, command: vi.fn(async (): Promise<JsonObject> => ({ ok: true })), broadcast: vi.fn() };
    const service = new PluginService(options);
    cleanups.push(async () => { await service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
    const call = (verb: string, argv: string[] = [], extra: JsonObject = {}, on = service) => on.request('cli', { verb, argv, cwd: '/x', isTTY: false, json: false, ...extra });
    return { root, write, store, options, service, call };
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
        // A pane the store does not know (another daemon's) is dropped with no workspace; an explicit workspace keeps both.
        const foreign = (await h.call('echo-call', [], { paneID: 'gone' }) as JsonObject)['context'];
        expect(foreign).not.toHaveProperty('paneID');
        expect(foreign).not.toHaveProperty('workspaceID');
        expect((await h.call('echo-call', [], { paneID, workspaceID: 'given' }) as JsonObject)['context']).toMatchObject({ paneID, workspaceID: 'given' });
        expect((await h.call('echo-call', [], { paneID: 'gone', workspaceID: 'given' }) as JsonObject)['context']).toMatchObject({ paneID: 'gone', workspaceID: 'given' });
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

    it('refuses the same collision through dev-install and rollback', async () => {
        const h = harness(), rival = 'sample.rival';
        await h.service.install(h.write('first', id, verbs(id)), true);
        await expect(h.service.request('dev-install', { path: h.write('rival', rival, verbs(rival, { echo: 'rival-echo', plain: 'rival-plain' })), trust: true, daemonID: h.service.daemonID }))
            .rejects.toThrow(`cli verb "hello" is already provided by plugin ${id}`);
        expect(h.service.list().map(plugin => plugin.manifest.id)).toEqual([id]);
        // The rival's first revision declares `shared`; it moves off it, the owner takes it, and the rival cannot roll back onto it.
        await h.service.install(h.write('rival', rival, verbs(rival, { hello: 'shared', echo: 'rival-echo', plain: 'rival-plain' })), true);
        await h.service.install(h.write('rival', rival, verbs(rival, { hello: 'rival-hello', echo: 'rival-echo', plain: 'rival-plain' }), '1.1.0'), true);
        await h.service.install(h.write('first', id, verbs(id, { hello: 'shared' }), '1.1.0'), true);
        await expect(h.service.request('rollback', { pluginID: rival })).rejects.toThrow(`cli verb "shared" is already provided by plugin ${id}`);
        expect(h.service.list().find(plugin => plugin.manifest.id === rival)?.manifest.version).toBe('1.1.0');
        expect(await h.call('shared', ['d'])).toEqual({ text: 'hello d', exitCode: 3 });
    });

    it('refuses a built-in verb at install and dev-install', async () => {
        const h = harness(), source = h.write('builtin', 'sample.builtin', verbs('sample.builtin', { hello: 'pane' }));
        await expect(h.service.install(source, true)).rejects.toThrow('cli verb "pane" is a built-in kelpi command');
        await expect(h.service.request('dev-install', { path: source, trust: true, daemonID: h.service.daemonID })).rejects.toThrow('cli verb "pane" is a built-in kelpi command');
        expect(h.service.list()).toEqual([]);
    });

    it('boots over a stored verb a later release made built-in, and only drops that verb', async () => {
        const h = harness();
        await h.service.install(h.write('first', id, verbs(id)), true);
        await h.service.install(h.write('second', 'sample.other', [{ name: 'other', command: 'sample.other.hello', summary: 'Another' }]), true);
        await h.service.dispose();
        // Stand in for an upgrade that adds `pane`: rename the stored `hello` in the current manifest and its history.
        const registry = path.join(h.options.directory, 'installed.json');
        const rename = (manifest: { contributes: { cli?: Array<{ name: string }> } }) => { for (const verb of manifest.contributes.cli ?? []) if (verb.name === 'hello') verb.name = 'pane'; };
        const records = JSON.parse(fs.readFileSync(registry, 'utf8')) as Array<{ manifest: Parameters<typeof rename>[0]; revisions: Array<{ manifest: Parameters<typeof rename>[0] }> }>;
        for (const record of records) { rename(record.manifest); for (const revision of record.revisions) rename(revision.manifest); }
        fs.writeFileSync(registry, JSON.stringify(records));
        const onError = vi.fn(), restarted = new PluginService({ ...h.options, onError });
        cleanups.push(() => restarted.dispose());
        expect(onError).not.toHaveBeenCalled();
        expect((await restarted.request('list', {}) as unknown as Array<{ manifest: { id: string } }>).map(plugin => plugin.manifest.id)).toEqual([id, 'sample.other']);
        expect(restarted.list()[0]!.manifest.contributes.cli?.map(verb => verb.name)).toEqual(['pane', 'echo-call', 'plain']);
        expect((await restarted.request('cli-list', {}) as { verbs: Array<{ name: string }> }).verbs.map(verb => verb.name)).toEqual(['echo-call', 'plain', 'other']);
        await expect(h.call('pane', ['a'], {}, restarted)).rejects.toThrow('unknown kelpi verb: pane');
        expect((await h.call('echo-call', ['a'], {}, restarted) as JsonObject)['args']).toMatchObject({ argv: ['a'] });
        expect(await h.call('other', ['b'], {}, restarted)).toEqual({ text: 'hello b', exitCode: 3 });
        // The registry still takes changes.
        await restarted.install(h.write('third', 'sample.third', undefined), true);
        expect(restarted.list().map(plugin => plugin.manifest.id)).toEqual([id, 'sample.other', 'sample.third']);
    });

    it('reports a retained revision declaring a now built-in verb in history and refuses to roll back onto it', async () => {
        const h = harness();
        await h.service.install(h.write('first', id, verbs(id)), true);
        await h.service.install(h.write('first', id, verbs(id, { hello: 'hi' }), '1.1.0'), true);
        await h.service.install(h.write('second', 'sample.other', [{ name: 'other', command: 'sample.other.hello', summary: 'Another' }]), true);
        await h.service.dispose();
        // Stand in for an upgrade that adds `pane`: the retained 1.0.0 declared it as `hello`, and the other plugin's current manifest also carries it.
        const registry = path.join(h.options.directory, 'installed.json');
        const rename = (manifest: { contributes: { cli?: Array<{ name: string }> } }) => { for (const verb of manifest.contributes.cli ?? []) if (verb.name === 'hello' || verb.name === 'other') verb.name = 'pane'; };
        const records = JSON.parse(fs.readFileSync(registry, 'utf8')) as Array<{ manifest: Parameters<typeof rename>[0]; revisions: Array<{ manifest: Parameters<typeof rename>[0] }> }>;
        for (const record of records) { rename(record.manifest); for (const revision of record.revisions) rename(revision.manifest); }
        fs.writeFileSync(registry, JSON.stringify(records));
        const restarted = new PluginService(h.options);
        cleanups.push(() => restarted.dispose());
        const history = await restarted.request('history', { pluginID: id }) as unknown as Array<{ manifest: { version: string }; selected: boolean; problem: string | null }>;
        expect(history.map(entry => [entry.manifest.version, entry.selected, entry.problem])).toEqual([['1.1.0', true, null], ['1.0.0', false, 'cli verb "pane" is a built-in kelpi command']]);
        // The built-in reason wins over the other plugin's stored claim on the same name.
        await expect(restarted.request('rollback', { pluginID: id })).rejects.toThrow('cli verb "pane" is a built-in kelpi command');
        expect(restarted.list()[0]!.manifest.version).toBe('1.1.0');
        expect(await h.call('hi', ['e'], {}, restarted)).toEqual({ text: 'hello e', exitCode: 3 });
    });
});

describe('a package a pre-#391 daemon stored without contributes.cli', () => {
    // What the older decoder kept: the same revision, with the key it did not know dropped.
    const strip = (directory: string): void => {
        const registry = path.join(directory, 'installed.json');
        const records = JSON.parse(fs.readFileSync(registry, 'utf8')) as Array<{ manifest: { contributes: Record<string, unknown> }; revisions: Array<{ manifest: { contributes: Record<string, unknown> } }> }>;
        for (const record of records) { delete record.manifest.contributes['cli']; for (const row of record.revisions) delete row.manifest.contributes['cli']; }
        fs.writeFileSync(registry, JSON.stringify(records));
    };
    const stored = (directory: string) => JSON.parse(fs.readFileSync(path.join(directory, 'installed.json'), 'utf8')) as Array<{ manifest: { contributes: { cli?: unknown[] } }; revisions: Array<{ manifest: { contributes: { cli?: unknown[] } } }> }>;

    it('gains its verbs when the same package is reinstalled, enabled or disabled, and still boots', async () => {
        const h = harness();
        const source = h.write('source', id, verbs(id));
        await h.service.install(source, true);
        await h.service.dispose();
        strip(h.options.directory);

        const upgraded = new PluginService(h.options);
        cleanups.push(() => upgraded.dispose());
        await expect(h.call('hello', ['a'], {}, upgraded)).rejects.toThrow('unknown kelpi verb: hello');
        // The same directory again: the same revision, but a manifest this decoder reads differently.
        await upgraded.install(source, true);
        expect(await h.call('hello', ['a'], {}, upgraded)).toEqual({ text: 'hello a', exitCode: 3 });
        expect(stored(h.options.directory)[0]!.revisions).toHaveLength(1);
        expect(stored(h.options.directory)[0]!.revisions[0]!.manifest.contributes.cli).toHaveLength(3);
        await upgraded.dispose();

        strip(h.options.directory);
        const disabled = new PluginService(h.options);
        cleanups.push(() => disabled.dispose());
        await disabled.request('disable', { pluginID: id });
        await disabled.install(source, true);
        expect(await h.call('hello', ['b'], {}, disabled)).toEqual({ text: 'hello b', exitCode: 3 });
        expect(stored(h.options.directory)[0]!.revisions[0]!.manifest.contributes.cli).toHaveLength(3);
        await disabled.dispose();

        const errors: string[] = [];
        const rebooted = new PluginService({ ...h.options, onError: (error: Error) => { errors.push(error.message); } });
        cleanups.push(() => rebooted.dispose());
        expect(errors).toEqual([]);
        expect(rebooted.list()).toHaveLength(1);
        expect(await h.call('hello', ['c'], {}, rebooted)).toEqual({ text: 'hello c', exitCode: 3 });
    });
});

describe('an oversized verb result', () => {
    it('fails only its own call and leaves the backend running', async () => {
        const h = harness();
        const source = path.join(h.root, 'big'); fs.mkdirSync(source, { recursive: true });
        fs.writeFileSync(path.join(source, 'kelpi.plugin.json'), JSON.stringify({ id: 'sample.big', name: 'Big', version: '1.0.0', apiVersion: 1, trust: 'full', backend: 'backend.mjs', contributes: {
            commands: [{ id: 'sample.big.dump', title: 'dump' }], cli: [{ name: 'dump', command: 'sample.big.dump', summary: 'Dump a log' }] } }));
        fs.writeFileSync(path.join(source, 'backend.mjs'), `export function activate(api) { api.commands.register('sample.big.dump', args => ({ text: 'x'.repeat(Number(args.argv[0])) })); }`);
        await h.service.install(source, true);
        expect(await h.call('dump', ['10'])).toEqual({ text: 'xxxxxxxxxx' });
        await expect(h.call('dump', [String(256 * 1024 + 1)])).rejects.toThrow('plugin result exceeds the 256 KiB limit');
        expect(await h.call('dump', ['3'])).toEqual({ text: 'xxx' });
        expect((h.service.list()[0] as { error?: string | null }).error).toBeFalsy();
    });
});
