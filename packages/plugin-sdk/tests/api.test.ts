import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type JsonObject } from '@kelpi/protocol';
import { createKelpiAPI, KelpiError, type Context } from '../index.js';
import { harness as appHarness } from '../../daemon/src/handlers/app/testing.js';
import { harness as paneHarness, W1, W2, testID } from '../../daemon/src/handlers/pane/testing.js';
import { paneHandlers } from '../../daemon/src/handlers/pane/index.js';
import { seededState } from '../../daemon/src/store/testing.js';
import { createSyncHub, type SyncHubOptions } from '../../daemon/src/ws/sync.js';
import { serializeState } from '../../daemon/src/ws/serialize.js';
import { PluginService } from '../../daemon/src/plugins/service.js';
import { createSettingsService } from '../../daemon/src/settings/service.js';
import { scaffoldPlugin } from '../../cli/src/commands/plugin-scaffold.js';
import { createTerminalSearchChannel } from '../../daemon/src/ws/search.js';

const P1 = testID('D', 1);
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function host(options: Partial<SyncHubOptions> | ((app: ReturnType<typeof appHarness>) => Partial<SyncHubOptions>) = {}, getContext: () => Partial<Context> = () => ({ workspaceID: W1, paneID: P1 })) {
    const app = appHarness({ initial: seededState(W1, P1) });
    const pane = paneHarness();
    const hub = createSyncHub({
        store: app.store, daemon: { version: '1', build: 'test' },
        dispatcher(message, reply) {
            const handler = paneHandlers.get(message.command);
            if (handler) handler(message, { ...pane.ctx, store: app.store }, reply);
            else app.table.get(message.command)?.(message, app.ctx, reply);
        },
        ...(typeof options === 'function' ? options(app) : options),
    });
    cleanup.push(() => hub.close());
    const sent: JsonObject[] = [];
    const api = createKelpiAPI(async (method, args) => {
        if (method === 'state.snapshot') return { epoch: 'E', sequence: 0, state: serializeState(app.store.getState()) };
        if (method !== 'command') throw new Error(`unsupported test transport method ${method}`);
        sent.push(args.payload as JsonObject);
        return hub.executeCommand(args.payload as JsonObject, { daemonID: 'D', ...getContext() }, new AbortController().signal);
    }, getContext);
    return { api, app, pane, hub, sent };
}

describe('public SDK over Kelpi command handlers', () => {
    it('creates, moves, labels and removes workspaces with standalone camelCase DTOs', async () => {
        const { api, app } = host();
        const created = await api.workspaces.create({ name: 'SDK', path: '/tmp', color: 'purple' });
        const group = await api.groups.create('Plugins', { workspaceIDs: [created.workspaceID], color: 'blue' });
        expect((await api.groups.list())[0]).toMatchObject({ id: group.groupID, workspaces: [{ id: created.workspaceID }] });
        await api.workspaces.rename(created.workspaceID, 'Board');
        await api.workspaces.labels(created.workspaceID, 'set', ['sdk_tag']);
        await api.workspaces.setColor([created.workspaceID], 'green');
        await api.workspaces.setIcon(created.workspaceID, 'emoji:🧩');
        await api.groups.setCollapsed(group.groupID, true);
        await api.workspaces.moveMany([created.workspaceID]);
        const listed = (await api.workspaces.list()).find(workspace => workspace.id === created.workspaceID);
        expect(listed).toMatchObject({ name: 'Board', color: 'green', labels: ['sdk_tag'], paneCount: 1 });
        expect(listed).not.toHaveProperty('groupID');
        expect(app.state().groups[0]?.isCollapsed).toBe(true);
        expect(await api.workspaces.remove(created.workspaceID)).toMatchObject({ workspaceID: created.workspaceID, workspaceName: 'Board' });
        expect(await api.workspaces.list()).toHaveLength(1);
    });
    it('creates and splits panes, resizes a real split, and applies zoom/layout changes', async () => {
        const { api, app } = host();
        const second = await api.panes.create({ workspaceID: W1, name: 'second' });
        const third = await api.panes.split(second.paneID, { direction: 'vertical', name: 'third' });
        expect(third.workspaceID).toBe(W1);
        await api.panes.rename(third.paneID, 'worker');
        const resized = await api.panes.resize(third.paneID, { ratio: 0.7 });
        expect(resized.targetShare).toBeCloseTo(0.7);
        await api.layout.setSplitRatio(W1, resized.splitPath, 0.4);
        expect((await api.layout.zoom(third.paneID)).zoomedPaneID).toBe(third.paneID);
        await api.layout.zoom(third.paneID);
        await api.layout.select(P1, 'even-horizontal');
        expect(app.state().workspaces[0]?.layout.kind).toBe('split');
        expect(await api.panes.list({ workspaceID: W1 })).toEqual(expect.arrayContaining([expect.objectContaining({ id: third.paneID, label: 'worker' })]));
        await api.panes.close(third.paneID);
        expect((await api.panes.list()).some(pane => pane.id === third.paneID)).toBe(false);
    });
    it('targets terminal input exactly once and captures scrollback through the real terminal handler', async () => {
        const { api, pane } = host();
        pane.term.viewport.set(P1, 'visible');
        pane.term.scrollback.set(P1, 'older\nvisible');
        await api.terminal.send({ paneID: P1, workspaceID: W1 }, 'echo $(literal)', { bare: true });
        await api.terminal.sendKey(P1, 'enter');
        expect(pane.input.texts).toEqual([{ paneID: P1, text: 'echo $(literal)', bare: true, mirror: false }]);
        expect(pane.input.keys).toEqual([{ paneID: P1, key: 'enter' }]);
        expect(await api.terminal.capture(P1, { scrollback: true })).toBe('older\nvisible');
        expect(await api.terminal.capture(P1, { scrollback: true, lines: 1 })).toBe('visible');
        expect((await api.terminal.sync(W1, 'on')).active).toBe(true);
        expect((await api.terminal.excludeFromSync(P1, true)).excluded).toEqual([{ id: P1 }]);
    });
    it('uses lazy pane/workspace context instead of the daemon active workspace, with explicit options winning', async () => {
        let context: Partial<Context> = { workspaceID: W1, paneID: P1 };
        const { api, app, sent } = host({}, () => context);
        const P2 = testID('D', 2);
        app.store.dispatch({ type: 'create-workspace', id: W2, paneID: P2, name: 'Other', color: 'green', now: Date.now() });
        expect(app.state().lastActiveWorkspaceID).toBe(W2);
        expect((await api.panes.create()).workspaceID).toBe(W1);
        expect((await api.panes.list({ scope: 'current' })).every(pane => pane.workspaceID === W1)).toBe(true);
        await api.git.diff('/tmp/source-repo');
        expect(app.state().workspaces.find(workspace => workspace.id === W1)?.panes.some(pane => pane.type === 'diff')).toBe(true);
        await api.files.open('/tmp/source.md', { reuse: true });
        expect(app.state().workspaces.find(workspace => workspace.id === W1)?.parkedPanes.some(pane => pane.id === P1)).toBe(true);
        expect(app.state().workspaces.find(workspace => workspace.id === W2)?.panes.map(pane => pane.id)).toEqual([P2]);
        context = { workspaceID: W2 }; // Sidebar context has no caller pane.
        expect((await api.panes.create()).workspaceID).toBe(W2);
        expect((await api.panes.list({ scope: 'current' })).every(pane => pane.workspaceID === W2)).toBe(true);
        await api.files.open('/tmp/sidebar.md');
        expect(app.state().workspaces.find(workspace => workspace.id === W2)?.panes.some(pane => pane.filePath === '/tmp/sidebar.md')).toBe(true);
        await expect(api.files.open('/tmp/no-reuse.md', { reuse: true })).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE' });
        expect((await api.panes.create({ workspaceID: W1 })).workspaceID).toBe(W1);
        expect((await api.panes.list({ workspaceID: W1, scope: 'current' })).every(pane => pane.workspaceID === W1)).toBe(true);
        await api.git.diff('/tmp/explicit-repo', { workspaceID: W1 });
        expect(app.state().workspaces.find(workspace => workspace.id === W1)?.panes.some(pane => pane.type === 'diff' && pane.workingDirectory === '/tmp/explicit-repo')).toBe(true);
        await expect(api.git.graft.start()).rejects.toThrow('no repo associations');
        expect(sent.at(-1)).toEqual({ command: 'graft-start', workspace: W2 });
        expect(await api.git.graft.stop({ repo: 'explicit-repo' })).toEqual({ stopped: [] });
        expect(sent.at(-1)).toEqual({ command: 'graft-stop', repo: 'explicit-repo' });
        context = {};
        for (const operation of [() => api.panes.create(), () => api.panes.list({ scope: 'current' }), () => api.files.open('/tmp/no-scope.md'), () => api.git.diff('/tmp/no-scope'), () => api.git.graft.start()]) {
            await expect(operation()).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE' });
        }
    });
    it('models terminal find at workspace scope and keeps its active search pane', async () => {
        const searchAsync = vi.fn(async () => [{ line: 0, col: 0, length: 3, linesFromBottom: 0 }]);
        const { api, app } = host(app => ({ search: createTerminalSearchChannel({ store: app.store, term: { searchAsync } }) }));
        const second = await api.panes.create({ workspaceID: W1 });
        expect((await api.terminal.search(W1, 'toggle')).paneID).toBe(second.paneID);
        app.store.dispatch({ type: 'focus-pane', workspaceID: W1, paneID: P1 });
        expect(await api.terminal.search(W1, 'set', { needle: 'hit' })).toMatchObject({ workspaceID: W1, paneID: second.paneID, total: 1 });
        expect(searchAsync).toHaveBeenCalledWith(second.paneID, 'hit', { caseSensitive: false });
        expect((await api.terminal.search(W1, 'close')).paneID).toBeNull();
    });
    it('reports and discovers agent sessions without pretending to launch one', async () => {
        const { api } = host();
        await api.agents.sessionStart(P1, 'session-123', 'codex');
        await api.agents.reportStart(P1, 'codex');
        expect(await api.agents.list()).toEqual([expect.objectContaining({ id: P1, agent: 'codex', agentSessionID: 'session-123', status: 'running' })]);
        expect((await api.agents.setStatus(P1, 'waitingForInput')).status).toBe('waitingForInput');
        await api.agents.reportStop(P1, { backgroundTasks: 2 });
        expect((await api.panes.list())[0]?.backgroundTasks).toBe(2);
        await api.agents.reportStop(P1);
        await api.agents.clearStatus(P1);
        await api.agents.sessionEnd(P1, 'session-123');
        expect((await api.panes.list())[0]?.status).toBe('idle');
    });
    it('uses the real repository channel to manage repositories, associations and worktrees', async () => {
        const worktreeAdd = vi.fn(async () => {});
        let sequence = 0;
        const { api } = host(app => ({ repos: {
            store: app.store, now: Date.now, uuid: () => testID('F', ++sequence), worktreeBasePath: '/tmp/kelpi-sdk/<repo>',
            git: {
                getRemoteURL: async () => 'git@example.invalid:repo.git', getCurrentBranch: async () => 'main',
                getStatus: async () => ({ kind: 'clean' }),
                resolveRepoRoot: async value => ({ worktreeRoot: value, parentRepoRoot: value }),
                worktreeAdd, removeWorktree: async () => {},
            },
        } }));
        const repository = await api.git.addRepository('/tmp/sdk-repo', { name: 'SDK repository' });
        expect(repository).toMatchObject({ name: 'SDK repository', remoteURL: 'git@example.invalid:repo.git', isAutoDiscovered: false });
        const associated = await api.git.associate(W1, repository.path);
        expect(associated).toMatchObject({ repoID: repository.id, repoPath: '/tmp/sdk-repo', branch: 'main', isWorktree: false });
        expect(await api.git.status(W1)).toEqual([associated]);
        const worktree = await api.git.addWorktree(W1, { repoID: repository.id, name: 'feature', branch: 'sdk-feature' });
        expect(worktree).toMatchObject({ workspaceID: W1, branch: 'sdk-feature', association: { isWorktree: true } });
        expect(worktreeAdd).toHaveBeenCalledWith(expect.objectContaining({ branchName: 'sdk-feature', updateMain: false }));
        await api.git.dissociate(W1, associated.id);
        expect((await api.git.renameRepository(repository.id, 'Renamed')).name).toBe('Renamed');
        expect((await api.git.removeRepository(repository.id)).removedAssociations).toContain(worktree.association.id);
        expect(await api.git.repositories()).toEqual([]);
    });
    it('runs a scaffolded backend with the same SDK and reads real service/settings DTOs', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-sdk-host-'));
        cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
        const settings = createSettingsService({ configPath: path.join(root, 'config'), ghosttyPath: path.join(root, 'appearance'), home: root, watch: false, env: { KELPID_GHOSTTY_THEME_DIRS: path.join(root, 'themes') } });
        cleanup.push(() => settings.dispose());
        const h = host({ settings });
        const plugin = scaffoldPlugin(path.join(root, 'source'), 'sample.sdk', 'SDK');
        const manifestPath = path.join(plugin.path, 'kelpi.plugin.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifest.contributes.commands.push({ id: 'sample.sdk.create', title: 'Create pane in caller workspace' });
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        const backendPath = path.join(plugin.path, 'backend.mjs');
        fs.writeFileSync(backendPath, fs.readFileSync(backendPath, 'utf8').replace('export function activate(api) {', "export function activate(api) {\n    api.commands.register('sample.sdk.create', () => api.panes.create());"));
        const service = new PluginService({
            directory: path.join(root, 'plugins'), store: h.app.store, broadcast: () => {},
            command: (payload, context, signal) => h.hub.executeCommand(payload, context, signal),
            applicationSettings: () => settings.snapshot as unknown as JsonObject,
        });
        cleanup.push(() => service.dispose());
        await service.install(plugin.path, true);
        const api = createKelpiAPI((method, args) => service.api(plugin.pluginID, method, args, { daemonID: service.daemonID }));
        const services = await api.services.list();
        expect(services[0]?.selectedProviderID).toBeNull();
        expect(services[0]?.activeProviderID).toBe('kelpi.files.bundled');
        expect(services[0]?.providers[0]?.status).toBe('available');
        expect(await api.services.select('kelpi.files', 1, null)).toEqual(services);
        const file = path.join(root, 'sdk.txt');
        await api.services.call('kelpi.files', 1, 'write', { path: file, text: 'service data' });
        expect(await api.files.read(file)).toBe('service data');
        await expect(api.services.call('kelpi.files', 2, 'read', { path: file })).rejects.toThrow('unavailable');
        expect((await api.appSettings.get()).general.focusFollowsMouse).toBe(false);
        expect((await api.appSettings.setGeneral('focus-follows-mouse', true)).general.focusFollowsMouse).toBe(true);
        await api.appSettings.setProfiles([{ name: 'sdk', env: { MY_VAR: 'literal_value' } }]);
        expect((await api.appSettings.get()).profiles).toEqual([{ name: 'sdk', env: { MY_VAR: 'literal_value' } }]);
        const summary = await api.commands.execute<{ workspaces: { id: string; paneCount: number }[] }>('sample.sdk.summary');
        expect(summary.workspaces).toEqual([expect.objectContaining({ id: W1, paneCount: 1 })]);
        h.app.store.dispatch({ type: 'create-workspace', id: W2, paneID: testID('D', 2), name: 'Other', color: 'green', now: Date.now() });
        expect(await service.request('run', { command: 'sample.sdk.create', workspaceID: W1 })).toMatchObject({ workspaceID: W1 });
        expect(await service.request('run', { command: 'sample.sdk.create', workspaceID: W2 })).toMatchObject({ workspaceID: W2 });
        await expect(service.request('run', { command: 'sample.sdk.create' })).rejects.toThrow('requires a paneID or workspaceID');
    });
    it('preserves structured command refusals and leaves the raw API compatible', async () => {
        const { api } = host();
        const failure = await api.workspaces.remove(W1).catch(error => error);
        expect(failure).toBeInstanceOf(KelpiError);
        expect(failure).toMatchObject({ code: 'COMMAND_FAILED', method: 'workspace-delete', details: { ok: false } });
        await expect(api.panes.close('does-not-exist')).rejects.toMatchObject({ code: 'COMMAND_FAILED', method: 'pane-close' });
        expect(await api.command({ command: 'pane-close', target: 'does-not-exist' })).toMatchObject({ ok: false });
    });
    it('preserves caller settings dictionary keys and normalizes transport failures', async () => {
        const snapshot = { profiles: [{ name: 'dev', env: { MY_VAR: 'literal_value' } }], chrome: { custom_key: 1 } };
        const transport = vi.fn(async (method, args) => method === 'app.settings.get' ? snapshot : { ok: true, settings: snapshot });
        const api = createKelpiAPI(transport);
        expect(await api.appSettings.get()).toEqual(snapshot);
        expect(await api.appSettings.setProfiles(snapshot.profiles)).toEqual(snapshot);
        expect(transport.mock.calls[1]?.[1]).toEqual({ payload: { command: 'set-profiles', profiles: snapshot.profiles }, context: {} });
        const broken = createKelpiAPI(async () => { throw new Error('channel closed'); });
        await expect(broken.files.read('/tmp/file')).rejects.toMatchObject({ code: 'TRANSPORT_ERROR', method: 'files.read', message: 'channel closed' });
        const malformed = createKelpiAPI(async () => null);
        await expect(malformed.workspaces.list()).rejects.toMatchObject({ code: 'INVALID_REPLY', method: 'workspace-list' });
    });
    it('uses exact version/provider service contracts and leaves provider JSON untouched', async () => {
        const transport = vi.fn(async () => ({ user_key: { keep_this: 1 } }));
        const api = createKelpiAPI(transport);
        expect(await api.services.call('sample.host.catalog', 2, 'read', { custom_arg: true }, { provider: 'sample.host.local' })).toEqual({ user_key: { keep_this: 1 } });
        expect(transport).toHaveBeenLastCalledWith('services.call', { service: 'sample.host.catalog', version: 2, method: 'read', args: { custom_arg: true }, provider: 'sample.host.local' });
        await api.services.select('kelpi.files', 1, null);
        expect(transport).toHaveBeenLastCalledWith('services.select', { service: 'kelpi.files', version: 1, providerID: null });
    });
});
