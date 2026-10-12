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
    const install = async (id: string, backend: string) => {
        const source = path.join(root, id); fs.mkdirSync(source);
        fs.writeFileSync(path.join(source, 'kelpi.plugin.json'), JSON.stringify({
            id, name: id, version: '1.0.0', apiVersion: 1, trust: 'full', activation: 'on-demand', backend: 'backend.mjs',
            contributes: { providers: [{ id: `${id}.provider`, title: id, service: 'kelpi.agent.permissions', version: 1, methods: ['decide'] }] }
        }));
        fs.writeFileSync(path.join(source, 'backend.mjs'), backend);
        await service.install(source, true);
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

    it('fails a provider that returns a malformed decision, so later calls use the bundled abstain', async () => {
        const h = harness();
        await h.install('sample.policy', `export function activate(api) { api.providers.register('sample.policy.provider', { decide: () => ({ behavior: 'approve' }) }); }`);
        await h.service.request('service-select', { service: 'kelpi.agent.permissions', version: 1, providerID: 'sample.policy.provider' });
        await expect(h.call()).rejects.toThrow('invalid decide result');
        expect(h.service.list()[0]?.status).toBe('failed');
        expect(await h.call()).toEqual({ behavior: 'abstain' });
    });
});
