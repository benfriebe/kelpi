import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePluginManifest, pluginObject, type JsonObject, type PluginRevisionInfo } from '@kelpi/protocol';
import { createStore } from '../store/store.js';
import { seededState, W1 } from '../store/testing.js';
import { PluginService } from './service.js';
import { inOperationScope } from './operations.js';
import { decodePluginInstallation, PLUGIN_RETAINED_REVISIONS, recoverPluginRevisionChange, selectPluginRevision } from './revisions.js';

const ID = 'sample.revisions', VIEW = `${ID}.view`;
const stops: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const stop of stops.splice(0).reverse()) await stop(); });
function harness(extra: JsonObject = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-revisions-')), source = path.join(root, 'source');
    fs.mkdirSync(path.join(source, 'ui'), { recursive: true });
    fs.writeFileSync(path.join(source, 'ui/index.html'), '<main>Revision</main>');
    const manifest = { id: ID, name: 'Revisions', version: '1.0.0', apiVersion: 1, trust: 'full', activation: 'startup', backend: 'backend.mjs',
        contributes: { views: [{ id: VIEW, title: 'Revision', entry: 'ui/index.html', placements: ['pane'], stateVersion: 1 }],
            commands: [{ id: `${ID}.run`, title: 'Run' }], settings: { title: { title: 'Title', type: 'string', default: 'Original' } } }, ...extra };
    const write = (patch: JsonObject = {}, body = `api.commands.register('${ID}.run', () => 'original');`) => {
        fs.writeFileSync(path.join(source, 'kelpi.plugin.json'), JSON.stringify({ ...manifest, ...patch }));
        fs.writeFileSync(path.join(source, 'backend.mjs'), `export async function activate(api) { ${body} }`);
    };
    write();
    const store = createStore(seededState());
    const broadcast = vi.fn(), options = { directory: path.join(root, 'plugins'), store, broadcast, command: async (): Promise<JsonObject> => ({ ok: true }) };
    const service = new PluginService(options);
    stops.push(async () => { await service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
    const caller = { daemonID: service.daemonID, clientID: 'owner' };
    const api = (method: string, args: JsonObject = {}) => service.api(ID, method, args, caller);
    const history = async () => await service.request('history', { pluginID: ID }) as unknown as PluginRevisionInfo[];
    const open = () => service.request('open', { pluginID: ID, viewID: VIEW, workspaceID: W1, state: { keep: 'pane state' } }).then(pluginObject);
    return { root, source, manifest, write, store, options, service, caller, api, history, open, broadcast };
}

describe('plugin revision recovery', () => {
    it('pins developer installations to the chosen daemon and routes valid requests through revision recovery', async () => {
        const h = harness(), input = { path: h.source, trust: true, daemonID: h.service.daemonID };
        await expect(h.service.request('dev-install', { ...input, daemonID: 'another-daemon' })).rejects.toThrow('daemon changed');
        await expect(h.service.request('dev-install', { path: h.source, trust: true })).rejects.toThrow('daemon changed');
        await expect(h.service.request('dev-install', { ...input, trust: false })).rejects.toThrow('--trust');
        expect(h.service.list()).toEqual([]);
        expect(fs.existsSync(path.join(h.options.directory, 'installed.json'))).toBe(false);
        await h.service.request('dev-install', input);
        const original = h.service.list()[0]!;
        expect(original.status).toBe('running');
        h.write({ version: '1.1.0' }, 'throw new Error("bad developer edit");');
        await expect(h.service.request('dev-install', input)).rejects.toThrow('previous revision restored: bad developer edit');
        expect(h.service.list()[0]).toMatchObject({ revision: original.revision, status: 'running' });
    });

    it('does not read a queued developer snapshot after its connection is cancelled', async () => {
        const h = harness(); await h.service.install(h.source, true);
        const original = h.service.list()[0]!, controller = new AbortController();
        h.write({ version: '1.1.0' });
        const reloading = h.service.request('reload', { pluginID: ID });
        const queued = inOperationScope({ trace: [], signal: controller.signal }, () => h.service.request('dev-install', { path: h.source, trust: true, daemonID: h.service.daemonID }));
        const cancelled = expect(queued).rejects.toThrow('plugin dev installation cancelled');
        controller.abort(); fs.rmSync(h.source, { recursive: true, force: true });
        await reloading; await cancelled;
        expect(h.service.list()[0]).toMatchObject({ revision: original.revision, status: 'running' });
        expect(await h.history()).toHaveLength(1);
    });

    it('restores an update cancelled during provisional developer activation before committing its JSON writes', async () => {
        const h = harness(); await h.service.install(h.source, true);
        const original = h.service.list()[0]!, controller = new AbortController();
        const entered = path.join(h.root, 'entered'), proceed = path.join(h.root, 'proceed');
        h.write({ version: '1.1.0' }, `await api.storage.set('provisional', true);
            const fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(entered)}, 'ready');
            while (!fs.existsSync(${JSON.stringify(proceed)})) await new Promise(resolve => setTimeout(resolve, 5));
            api.commands.register('${ID}.run', () => 'updated');`);
        const update = inOperationScope({ trace: [], signal: controller.signal }, () => h.service.request('dev-install', { path: h.source, trust: true, daemonID: h.service.daemonID }));
        const cancelled = expect(update).rejects.toThrow('previous revision restored: plugin dev installation cancelled');
        await vi.waitFor(() => expect(fs.existsSync(entered)).toBe(true));
        controller.abort(); fs.writeFileSync(proceed, 'continue'); await cancelled;
        expect(h.service.list()[0]).toMatchObject({ revision: original.revision, status: 'running' });
        expect(await h.api('storage.get', { key: 'provisional' })).toBe(null);
        expect(await h.history()).toHaveLength(1);
    });

    it('retains exact revisions across updates, explicit selection and restart without changing native or plugin panes', async () => {
        const h = harness(); await h.service.install(h.source, true);
        expect(await h.service.request('identity', {})).toMatchObject({ apiVersion: 1, capabilities: ['plugin-packages', 'plugin-revisions', 'plugin-dev'] });
        const first = h.service.list()[0]!, firstHistory = (await h.history())[0]!;
        const pane = await h.open(), paneID = String(pane['paneID']);
        const before = h.store.getState();
        await h.api('storage.set', { key: 'keep', value: 42 });
        await h.service.request('settings', { pluginID: ID, key: 'title', value: 'Mine' });
        const lease = pluginObject(await h.service.request('attach', { pluginID: ID, viewID: VIEW, paneID }, h.caller));
        h.write({}, `api.commands.register('${ID}.run', () => 'second');`); // Same semver, different immutable bytes.
        await h.service.install(h.source, true);
        const second = h.service.list()[0]!;
        expect(second.revision).not.toBe(first.revision);
        expect(second).not.toHaveProperty('revisions');
        expect(second).not.toHaveProperty('selectionID');
        expect(h.store.getState()).toBe(before);
        await expect(h.service.request('api', { lease: lease['lease']!, method: 'state.snapshot' }, h.caller)).rejects.toThrow('expired');
        expect(await h.history()).toMatchObject([{ revision: second.revision, selected: true }, { revision: first.revision, selected: false, installedAt: firstHistory.installedAt }]);
        await h.service.request('rollback', { pluginID: ID, revision: first.revision });
        expect(await h.service.request('run', { command: `${ID}.run` })).toBe('original');
        expect(await h.api('storage.get', { key: 'keep' })).toBe(42);
        expect(await h.service.request('settings', { pluginID: ID })).toEqual({ title: 'Mine' });
        expect(h.store.getState()).toBe(before);
        expect((await h.history())[0]).toMatchObject({ revision: first.revision, installedAt: firstHistory.installedAt, selected: true });
        await h.service.dispose();
        const restarted = new PluginService(h.options); stops.push(() => restarted.dispose());
        await restarted.request('rollback', { pluginID: ID });
        expect(restarted.list()[0]?.revision).toBe(second.revision);
        expect(await restarted.request('run', { command: `${ID}.run` })).toBe('second');
    });

    it.each(['startup', 'on-demand'])('restores a failed %s update and discards candidate settings/storage writes', async activation => {
        const h = harness({ activation }); await h.service.install(h.source, true);
        await h.api('storage.set', { key: 'keep', value: 'before' });
        const first = h.service.list()[0]!;
        h.write({}, `await api.storage.set('keep', 'candidate'); await api.settings.set('title', 'Candidate'); throw new Error('bad update');`);
        await expect(h.service.install(h.source, true)).rejects.toThrow('previous revision restored: bad update');
        expect(h.service.list()[0]).toMatchObject({ revision: first.revision, status: activation === 'startup' ? 'running' : 'inactive' });
        expect(await h.api('storage.get', { key: 'keep' })).toBe('before');
        expect(await h.service.request('settings', { pluginID: ID })).toEqual({ title: 'Original' });
        expect(await h.history()).toHaveLength(1);
        expect(h.broadcast.mock.calls.some(([event]) => event.event?.name === 'settings.changed')).toBe(false);
        expect(await h.service.request('run', { command: `${ID}.run` })).toBe('original');
    });

    it('commits activation JSON writes after readiness and rejects owner writes and pane migration while provisional', async () => {
        const h = harness(); await h.service.install(h.source, true);
        const entered = path.join(h.root, 'entered'), proceed = path.join(h.root, 'proceed');
        h.write({ version: '1.1.0' }, `
            await api.storage.set('own', 7); await api.settings.set('title', 'Updated');
            const fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(entered)}, 'ready');
            while (!fs.existsSync(${JSON.stringify(proceed)})) await new Promise(resolve => setTimeout(resolve, 5));
            let paneError; try { await api.openView('${VIEW}'); } catch (error) { paneError = error.message; }
            api.commands.register('${ID}.run', async () => ({ own: await api.storage.get('own'), paneError }));
        `);
        const update = h.service.install(h.source, true);
        await vi.waitFor(() => expect(fs.existsSync(entered)).toBe(true));
        expect(fs.existsSync(path.join(h.options.directory, 'data', ID, 'storage.json'))).toBe(false);
        await expect(h.service.request('settings', { pluginID: ID, key: 'title', value: 'Raced' })).rejects.toThrow('retry the settings write');
        fs.writeFileSync(proceed, 'continue'); await update;
        expect(await h.service.request('run', { command: `${ID}.run` })).toMatchObject({ own: 7, paneError: expect.stringContaining('revision is committed') });
        expect(JSON.parse(fs.readFileSync(path.join(h.options.directory, 'data', ID, 'storage.json'), 'utf8'))).toEqual({ own: 7 });
        expect(await h.service.request('settings', { pluginID: ID })).toEqual({ title: 'Updated' });
        expect(fs.existsSync(path.join(h.options.directory, 'revision-change.json'))).toBe(false);
    });

    it('restores candidate JSON files and the old running revision when registry commit fails', async () => {
        const h = harness(); await h.service.install(h.source, true);
        await h.api('storage.set', { key: 'keep', value: 'original' });
        const first = h.service.list()[0]!, registry = fs.readFileSync(path.join(h.options.directory, 'installed.json'), 'utf8');
        h.write({ version: '1.1.0' }, `await api.storage.set('keep', 'changed'); api.commands.register('${ID}.run', () => 'updated');`);
        const rename = fs.renameSync;
        vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
            if (String(to) === path.join(h.options.directory, 'installed.json')) throw new Error('registry unavailable');
            return rename(from, to);
        });
        await expect(h.service.install(h.source, true)).rejects.toThrow('previous revision restored: registry unavailable');
        expect(fs.readFileSync(path.join(h.options.directory, 'installed.json'), 'utf8')).toBe(registry);
        expect(h.service.list()[0]).toMatchObject({ revision: first.revision, status: 'running' });
        expect(await h.api('storage.get', { key: 'keep' })).toBe('original');
        expect(await h.service.request('run', { command: `${ID}.run` })).toBe('original');
    });

    it('fails closed if owned-data recovery fails and recovers the retained journal before restarting a backend', async () => {
        const h = harness(); await h.service.install(h.source, true);
        await h.api('storage.set', { key: 'keep', value: 'original' });
        const original = h.service.list()[0]!, data = path.join(h.options.directory, 'data', ID, 'storage.json');
        h.write({ version: '1.1.0' }, `await api.storage.set('keep', 'candidate'); api.commands.register('${ID}.run', () => 'candidate');`);
        const rename = fs.renameSync;
        vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
            if (String(to) === path.join(h.options.directory, 'installed.json')) throw new Error('registry unavailable');
            if (String(to) === data && fs.readFileSync(from, 'utf8').includes('original')) throw new Error('restoration unavailable');
            return rename(from, to);
        });
        await expect(h.service.install(h.source, true)).rejects.toThrow('recovery requires a daemon restart');
        const journal = fs.readFileSync(path.join(h.options.directory, 'revision-change.json'), 'utf8');
        await expect(h.service.install(h.source, true)).rejects.toThrow('recovery requires a daemon restart');
        expect(fs.readFileSync(path.join(h.options.directory, 'revision-change.json'), 'utf8')).toBe(journal);
        await expect(h.service.request('run', { command: `${ID}.run` })).rejects.toThrow();
        await expect(h.service.request('settings', { pluginID: ID, key: 'title', value: 'Raced' })).rejects.toThrow('recovery requires a daemon restart');
        vi.restoreAllMocks(); await h.service.dispose();
        const restarted = new PluginService(h.options); stops.push(() => restarted.dispose());
        expect(restarted.list()[0]?.revision).toBe(original.revision);
        expect(JSON.parse(fs.readFileSync(data, 'utf8'))).toEqual({ keep: 'original' });
        expect(await restarted.request('run', { command: `${ID}.run` })).toBe('original');
        expect(fs.existsSync(path.join(h.options.directory, 'revision-change.json'))).toBe(false);
    });

    it('keeps committed data for a same-byte reinstall after interruption before journal removal', async () => {
        const h = harness();
        h.write({}, `const boot = (await api.storage.get('boot') ?? 0) + 1; await api.storage.set('boot', boot); api.commands.register('${ID}.run', () => boot);`);
        await h.service.install(h.source, true);
        const original = h.service.list()[0]!; await h.service.request('disable', { pluginID: ID });
        const journal = path.join(h.options.directory, 'revision-change.json'), remove = fs.rmSync;
        vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
            if (String(target) === journal) throw new Error('journal removal unavailable');
            return remove(target, options);
        });
        await h.service.install(h.source, true);
        expect(h.service.list()[0]?.revision).toBe(original.revision);
        expect(await h.api('storage.get', { key: 'boot' })).toBe(2);
        expect(fs.existsSync(journal)).toBe(true);
        const storedJournal = JSON.parse(fs.readFileSync(journal, 'utf8'));
        expect(storedJournal.previousRevision).toBe(storedJournal.nextRevision);
        expect(storedJournal.previousSelectionID).not.toBe(storedJournal.nextSelectionID);
        vi.restoreAllMocks(); await h.service.dispose();
        const restarted = new PluginService(h.options); stops.push(() => restarted.dispose());
        expect(await restarted.api(ID, 'storage.get', { key: 'boot' }, { daemonID: restarted.daemonID })).toBe(2);
        expect(fs.existsSync(journal)).toBe(false);
    });

    it('checks dependencies before revoking a live lease and refuses an update that breaks an enabled dependent', async () => {
        const h = harness(); await h.service.install(h.source, true);
        const first = h.service.list()[0]!, lease = pluginObject(await h.service.request('attach', { pluginID: ID, viewID: VIEW }, h.caller));
        h.write({ dependencies: [{ pluginID: 'missing.dependency', version: '*' }] });
        await expect(h.service.install(h.source, true)).rejects.toThrow('not installed');
        expect(h.service.list()[0]?.instanceID).toBe(first.instanceID);
        expect(await h.service.request('api', { lease: lease['lease']!, method: 'state.snapshot' }, h.caller)).toHaveProperty('epoch');
        const dependent = path.join(h.root, 'dependent'); fs.mkdirSync(dependent);
        fs.writeFileSync(path.join(dependent, 'kelpi.plugin.json'), JSON.stringify({ id: 'sample.dependent', version: '1.0.0', apiVersion: 1, trust: 'full', dependencies: [{ pluginID: ID, version: '^1.0.0' }] }));
        await h.service.install(dependent, true);
        h.write({ version: '2.0.0' });
        await expect(h.service.install(h.source, true)).rejects.toThrow('would break an enabled plugin');
        expect(h.service.list()[0]?.instanceID).toBe(first.instanceID);
    });

    it.each(['active', 'parked', 'closed'])('refuses a state downgrade for an %s pane while retaining the updated state', async location => {
        const h = harness(); await h.service.install(h.source, true);
        const first = h.service.list()[0]!, paneID = String((await h.open())['paneID']);
        h.write({ version: '2.0.0', contributes: { ...h.manifest.contributes, views: [{ ...h.manifest.contributes.views[0]!, stateVersion: 2 }] } });
        await h.service.install(h.source, true);
        await h.service.api(ID, 'views.setState', { paneID, state: { upgraded: true } }, h.caller);
        if (location === 'parked') h.store.dispatch({ type: 'park-pane', workspaceID: W1, paneID });
        if (location === 'closed') h.store.dispatch({ type: 'close-pane', workspaceID: W1, paneID });
        const before = h.store.getState(), current = h.service.list()[0]!;
        expect((await h.history()).find(item => item.revision === first.revision)?.problem).toContain('state version 2');
        await expect(h.service.request('rollback', { pluginID: ID })).rejects.toThrow('state version 2');
        expect(h.service.list()[0]?.instanceID).toBe(current.instanceID);
        expect(h.store.getState()).toBe(before);
        h.write({ contributes: { ...h.manifest.contributes, views: [] } });
        await expect(h.service.install(h.source, true)).rejects.toThrow('view sample.revisions.view is unavailable');
    });

    it('checks retained native renderer state and guards future pane state restored after installation', async () => {
        const h = harness(); await h.service.install(h.source, true);
        const paneID = String((await h.open())['paneID']);
        const data = path.join(h.options.directory, 'data', ID); fs.mkdirSync(data, { recursive: true });
        fs.writeFileSync(path.join(data, 'documents.json'), JSON.stringify({ [`${paneID}:${VIEW}`]: { stateVersion: 2, state: { zoom: 4 } } }));
        h.write({ version: '1.1.0' });
        await expect(h.service.install(h.source, true)).rejects.toThrow('native view');
        const pane = h.store.getState().workspaces[0]!.panes.find(pane => pane.id === paneID)!;
        h.store.dispatch({ type: 'set-plugin-pane-state', paneID, plugin: { ...pane.plugin!, stateVersion: 2 } });
        await expect(h.service.request('attach', { pluginID: ID, viewID: VIEW, paneID }, h.caller)).rejects.toThrow('state is newer');
        await expect(h.api('views.setState', { paneID, state: {} })).rejects.toThrow('state is newer');
        expect(h.store.getState().workspaces[0]!.panes.find(pane => pane.id === paneID)?.plugin?.state).toEqual({ keep: 'pane state' });
    });

    it('verifies retained bytes before rollback and preserves the currently running revision on tampering', async () => {
        const h = harness(); await h.service.install(h.source, true);
        const first = h.service.list()[0]!;
        h.write({ version: '1.1.0' }); await h.service.install(h.source, true);
        const current = h.service.list()[0]!;
        fs.writeFileSync(path.join(h.options.directory, 'packages', ID, first.revision, 'backend.mjs'), 'throw new Error("tampered")');
        await expect(h.service.request('rollback', { pluginID: ID })).rejects.toThrow('revision mismatch');
        expect(h.service.list()[0]?.instanceID).toBe(current.instanceID);
        await expect(h.service.request('rollback', { pluginID: ID, revision: current.revision.slice(0, 8) })).rejects.toThrow('full 64-character');
        await h.service.request('disable', { pluginID: ID });
        await h.service.request('rollback', { pluginID: ID, revision: current.revision });
        expect(h.service.list()[0]?.status).toBe('disabled');
    });

    it('loads a legacy registry without rewriting it and can later return to its locale-traversal revision', async () => {
        const h = harness();
        fs.writeFileSync(path.join(h.source, 'Z.txt'), 'upper'); fs.writeFileSync(path.join(h.source, 'a.txt'), 'lower');
        await h.service.dispose();
        const hash = createHash('sha256');
        const scan = (relative: string): void => {
            for (const entry of fs.readdirSync(path.join(h.source, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
                const name = relative ? `${relative}/${entry.name}` : entry.name;
                if (entry.isDirectory()) scan(name);
                else { const bytes = fs.readFileSync(path.join(h.source, name)); hash.update(name).update('\0').update(String(bytes.length)).update('\0').update(bytes); }
            }
        };
        scan(''); const revision = hash.digest('hex');
        fs.cpSync(h.source, path.join(h.options.directory, 'packages', ID, revision), { recursive: true });
        const registry = JSON.stringify([{ manifest: decodePluginManifest(h.manifest), revision, enabled: true }]);
        fs.writeFileSync(path.join(h.options.directory, 'installed.json'), registry);
        const service = new PluginService(h.options); stops.push(() => service.dispose());
        expect(fs.readFileSync(path.join(h.options.directory, 'installed.json'), 'utf8')).toBe(registry);
        expect(await service.request('history', { pluginID: ID })).toMatchObject([{ revision, installedAt: null, selected: true }]);
        h.write({ version: '1.1.0' }); await service.install(h.source, true);
        await service.request('rollback', { pluginID: ID, revision });
        expect(service.list()[0]).toMatchObject({ revision, status: 'running' });
        expect(await service.request('run', { command: `${ID}.run` })).toBe('original');
    });
});

describe('persisted plugin revision records', () => {
    it('bounds history, keeps selected revisions first and retains original install timestamps', () => {
        const manifest = decodePluginManifest({ id: ID, version: '1.0.0', apiVersion: 1, trust: 'full' });
        let installed = selectPluginRevision(undefined, manifest, '0'.repeat(64), true);
        const first = installed.revisions[0]!;
        for (let index = 1; index < PLUGIN_RETAINED_REVISIONS; index++) installed = selectPluginRevision(installed, manifest, index.toString(16).padStart(64, '0'), true);
        installed = selectPluginRevision(installed, manifest, first.revision, false);
        expect(installed.revisions).toHaveLength(PLUGIN_RETAINED_REVISIONS);
        expect(installed.revisions[0]).toEqual(first);
        expect(decodePluginInstallation(installed)).toEqual(installed);
        installed = selectPluginRevision(installed, manifest, 'f'.repeat(64), false);
        expect(installed.revisions).toHaveLength(PLUGIN_RETAINED_REVISIONS);
        expect(installed.revisions[1]).toEqual(first);
        expect(() => decodePluginInstallation({ ...installed, revision: 'e'.repeat(64) })).toThrow('does not match');
    });

    it.each(['previous', 'next'])('recovers a journal according to the durable %s revision selection', selected => {
        const h = harness();
        const manifest = decodePluginManifest(h.manifest), previous = '1'.repeat(64), next = '2'.repeat(64);
        const installed = new Map([[ID, selectPluginRevision(undefined, manifest, selected === 'previous' ? previous : next, true)]]);
        const data = path.join(h.options.directory, 'data', ID); fs.mkdirSync(data, { recursive: true });
        fs.writeFileSync(path.join(data, 'storage.json'), '{"value":"candidate"}');
        fs.writeFileSync(path.join(data, 'settings.json'), '{"title":"candidate"}');
        const original = '{ "value": "original" }';
        const previousSelectionID = selected === 'previous' ? installed.get(ID)!.selectionID : 'a'.repeat(36), nextSelectionID = selected === 'next' ? installed.get(ID)!.selectionID : 'b'.repeat(36);
        fs.writeFileSync(path.join(h.options.directory, 'revision-change.json'), JSON.stringify({ version: 1, pluginID: ID, previousRevision: previous, nextRevision: next, previousSelectionID, nextSelectionID,
            files: { storage: Buffer.from(original).toString('base64'), settings: null } }));
        recoverPluginRevisionChange(h.options.directory, installed);
        expect(fs.readFileSync(path.join(data, 'storage.json'), 'utf8')).toBe(selected === 'previous' ? original : '{"value":"candidate"}');
        expect(fs.existsSync(path.join(data, 'settings.json'))).toBe(selected !== 'previous');
        expect(fs.existsSync(path.join(h.options.directory, 'revision-change.json'))).toBe(false);
    });

    it('fails closed on corrupt recovery metadata instead of overwriting plugin data', () => {
        const h = harness(), journal = path.join(h.options.directory, 'revision-change.json');
        fs.writeFileSync(journal, '{broken');
        expect(() => recoverPluginRevisionChange(h.options.directory, new Map())).toThrow();
        expect(fs.readFileSync(journal, 'utf8')).toBe('{broken');
    });

    it('does not treat a missing installation registry as fresh while a revision journal remains', async () => {
        const h = harness(); await h.service.dispose();
        const journal = path.join(h.options.directory, 'revision-change.json');
        fs.writeFileSync(journal, JSON.stringify({ version: 1, pluginID: ID, previousRevision: '1'.repeat(64), nextRevision: '2'.repeat(64),
            previousSelectionID: null, nextSelectionID: 'a'.repeat(36), files: {} }));
        const restarted = new PluginService(h.options); stops.push(() => restarted.dispose());
        await expect(restarted.request('list', {})).rejects.toThrow('does not match the selected installation');
        await expect(restarted.install(h.source, true)).rejects.toThrow('does not match the selected installation');
        expect(fs.existsSync(path.join(h.options.directory, 'installed.json'))).toBe(false);
        expect(fs.existsSync(journal)).toBe(true);
    });
});
