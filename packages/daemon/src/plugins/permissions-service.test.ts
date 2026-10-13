import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '@kelpi/protocol';
import { createStore } from '../store/store.js';
import { seededState } from '../store/testing.js';
import { BUNDLED_PERMISSIONS_PROVIDER, createPermissionsService } from './permissions-service.js';
import { PluginService } from './service.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const ARGS = { paneID: 'P', workspaceID: 'W', agent: 'claude', toolName: 'Bash', toolInput: { command: 'mv a b' } };

function harness() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-permissions-service-'));
    const service = new PluginService({
        directory: path.join(root, 'installed'), store: createStore(seededState()),
        cliEnvironment: () => ({ KELPI_SOCKET: path.join(root, 'private.sock') }),
        command: async () => ({ ok: true }), broadcast: () => {}
    });
    cleanups.push(async () => { await service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
    /** `providers` replaces the one permissions provider; installing an installed id again adds a revision. */
    const install = async (id: string, backend: string, options: { version?: string; providers?: JsonObject[] } = {}) => {
        const source = path.join(root, id); fs.mkdirSync(source, { recursive: true });
        fs.writeFileSync(path.join(source, 'kelpi.plugin.json'), JSON.stringify({
            id, name: id, version: options.version ?? '1.0.0', apiVersion: 1, trust: 'full', activation: 'on-demand', backend: 'backend.mjs',
            contributes: { providers: options.providers ?? [{ id: `${id}.provider`, title: id, service: 'kelpi.agent.permissions', version: 1, methods: ['decide'] }] }
        }));
        fs.writeFileSync(path.join(source, 'backend.mjs'), backend);
        await service.install(source, true);
        return source;
    };
    const call = (args: JsonObject = ARGS) => service.callService({ service: 'kelpi.agent.permissions', version: 1, method: 'decide', args });
    return { service, install, call };
}

describe('kelpi.agent.permissions', () => {
    it('abstains through the plugin service with no plugin installed', async () => {
        const h = harness();
        expect(await h.call()).toEqual({ behavior: 'abstain' });
        expect(h.service.hasSelectedProvider('kelpi.agent.permissions', 1)).toBe(false);
        expect(h.service.services().find(service => service['id'] === 'kelpi.agent.permissions')).toMatchObject({
            title: 'Agent permission decisions', version: 1, methods: ['decide'], selectedProviderID: null, activeProviderID: BUNDLED_PERMISSIONS_PROVIDER
        });
    });

    it('rejects arguments without a tool name or with a non-object tool input', async () => {
        const h = harness();
        await expect(h.call({ ...ARGS, toolName: '' })).rejects.toThrow('toolName');
        const { toolName: _toolName, ...noToolName } = ARGS;
        await expect(h.call(noToolName)).rejects.toThrow('toolName');
        for (const toolInput of [['x'], 'mv a b', null]) await expect(h.call({ ...ARGS, toolInput })).rejects.toThrow('toolInput');
        const { toolInput: _toolInput, ...noToolInput } = ARGS;
        await expect(h.call(noToolInput)).rejects.toThrow('toolInput');
    });

    it('accepts only the three behaviors and a string message', () => {
        const { validateResult } = createPermissionsService().methods['decide']!;
        for (const result of [{ behavior: 'allow' }, { behavior: 'deny', message: 'no' }, { behavior: 'abstain' }]) {
            expect(() => validateResult(result)).not.toThrow();
        }
        for (const result of [{ behavior: 'approve' }, {}, 'allow', null, ['allow']]) {
            expect(() => validateResult(result)).toThrow('allow, deny or abstain');
        }
        for (const message of [7, null, { text: 'no' }]) {
            expect(() => validateResult({ behavior: 'deny', message })).toThrow('message');
        }
    });

    it('never lets an installed provider decide until the user selects it', async () => {
        const h = harness();
        await h.install('sample.policy', `export function activate(api) { api.providers.register('sample.policy.provider', { decide: (args, context) => ({ behavior: 'allow', message: context.paneID ?? 'none' }) }); }`);
        expect(await h.call()).toEqual({ behavior: 'abstain' });
        await h.service.request('service-select', { service: 'kelpi.agent.permissions', version: 1, providerID: 'sample.policy.provider' });
        expect(await h.service.callService({ service: 'kelpi.agent.permissions', version: 1, method: 'decide', args: ARGS }, { daemonID: h.service.daemonID, paneID: 'P' })).toEqual({ behavior: 'allow', message: 'P' });
        await h.service.request('service-select', { service: 'kelpi.agent.permissions', version: 1, providerID: null });
        expect(await h.call()).toEqual({ behavior: 'abstain' });
    });

    it('forgets the selection when its plugin is removed, so a reinstall does not decide by itself', async () => {
        const h = harness();
        const source = await h.install('sample.policy', `export function activate(api) {
            api.providers.register('sample.policy.provider', { decide: () => ({ behavior: 'allow' }) });
            api.providers.register('sample.policy.files', { read: () => 'custom', write: () => null });
        }`, {
            providers: [
                { id: 'sample.policy.provider', title: 'policy', service: 'kelpi.agent.permissions', version: 1, methods: ['decide'] },
                { id: 'sample.policy.files', title: 'files', service: 'kelpi.files', version: 1, methods: ['read', 'write'] }
            ]
        });
        await h.service.request('service-select', { service: 'kelpi.agent.permissions', version: 1, providerID: 'sample.policy.provider' });
        await h.service.request('service-select', { service: 'kelpi.files', version: 1, providerID: 'sample.policy.files' });
        expect(await h.call()).toEqual({ behavior: 'allow' });
        await h.service.request('remove', { pluginID: 'sample.policy' });
        await h.service.install(source, true);
        expect(h.service.services().find(service => service['id'] === 'kelpi.agent.permissions')).toMatchObject({ selectedProviderID: null, activeProviderID: BUNDLED_PERMISSIONS_PROVIDER });
        expect(await h.call()).toEqual({ behavior: 'abstain' });
        // Every other service keeps its selection through a removal, as plugin-services.md says.
        expect(h.service.services().find(service => service['id'] === 'kelpi.files')).toMatchObject({ selectedProviderID: 'sample.policy.files', activeProviderID: 'sample.policy.files' });
    });

    it('forgets a selected provider that only an older retained revision declares', async () => {
        const h = harness();
        const backend = `export function activate(api) { api.providers.register('sample.policy.provider', { decide: () => ({ behavior: 'allow' }) }); }`;
        const v1 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-permissions-v1-')), 'sample.policy');
        const source = await h.install('sample.policy', backend);
        fs.cpSync(source, v1, { recursive: true });
        cleanups.push(async () => fs.rmSync(path.dirname(v1), { recursive: true, force: true }));
        await h.service.request('service-select', { service: 'kelpi.agent.permissions', version: 1, providerID: 'sample.policy.provider' });
        // v2 renames the provider: the selection is kept and falls back to the bundled abstain.
        await h.install('sample.policy', `export function activate(api) { api.providers.register('sample.policy.renamed', { decide: () => ({ behavior: 'allow' }) }); }`, {
            version: '2.0.0',
            providers: [{ id: 'sample.policy.renamed', title: 'renamed', service: 'kelpi.agent.permissions', version: 1, methods: ['decide'] }]
        });
        expect(h.service.services().find(service => service['id'] === 'kelpi.agent.permissions')).toMatchObject({ selectedProviderID: 'sample.policy.provider', activeProviderID: BUNDLED_PERMISSIONS_PROVIDER });
        await h.service.request('remove', { pluginID: 'sample.policy' });
        await h.service.install(v1, true);
        expect(h.service.services().find(service => service['id'] === 'kelpi.agent.permissions')).toMatchObject({ selectedProviderID: null, activeProviderID: BUNDLED_PERMISSIONS_PROVIDER });
        expect(await h.call()).toEqual({ behavior: 'abstain' });
    });

    it('fails a provider that returns a malformed decision, so later calls use the bundled abstain', async () => {
        const h = harness();
        await h.install('sample.policy', `export function activate(api) { api.providers.register('sample.policy.provider', { decide: () => ({ behavior: 'approve' }) }); }`);
        await h.service.request('service-select', { service: 'kelpi.agent.permissions', version: 1, providerID: 'sample.policy.provider' });
        await expect(h.call()).rejects.toThrow('invalid decide result');
        expect(h.service.list()[0]?.status).toBe('failed');
        expect(await h.call()).toEqual({ behavior: 'abstain' });
    });
});
