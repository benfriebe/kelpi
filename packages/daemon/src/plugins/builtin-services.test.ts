import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '@kelpi/protocol';
import { createStore } from '../store/store.js';
import { seededState } from '../store/testing.js';
import { PluginService } from './service.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function harness() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-native-services-'));
    const broadcast = vi.fn();
    const service = new PluginService({
        directory: path.join(root, 'installed'), store: createStore(seededState()),
        cliEnvironment: () => ({ KELPI_SOCKET: path.join(root, 'private.sock') }),
        command: async () => ({ ok: true }), broadcast
    });
    cleanups.push(async () => { await service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
    const install = async (id: string, serviceID: string, methods: string[], backend: string, timeoutMs = 30_000) => {
        const source = path.join(root, id); fs.mkdirSync(source);
        fs.writeFileSync(path.join(source, 'kelpi.plugin.json'), JSON.stringify({
            id, name: id, version: '1.0.0', apiVersion: 1, trust: 'full', activation: 'on-demand', backend: 'backend.mjs',
            contributes: { providers: [{ id: `${id}.provider`, title: id, service: serviceID, version: 1, methods, timeoutMs }] }
        }));
        fs.writeFileSync(path.join(source, 'backend.mjs'), backend);
        await service.install(source, true);
    };
    const select = (serviceID: string, id: string | null) => service.request('service-select', { service: serviceID, version: 1, providerID: id === null ? null : `${id}.provider` });
    const call = (serviceID: string, method: string, args: JsonObject = {}, provider?: string) => service.callService({ service: serviceID, version: 1, method, args, ...(provider ? { provider } : {}) });
    return { root, broadcast, service, install, select, call };
}

describe('native built-in service registry', () => {
    it('registers without broadcasting during composition and freezes contracts at start', async () => {
        const h = harness();
        const adapter = { id: 'kelpi.example', title: 'Example', version: 1, methods: {
            read: { validateArgs() {}, validateResult() {}, run: () => 'native' }
        } };
        h.service.registerBuiltinService(adapter);
        expect(h.broadcast).not.toHaveBeenCalled();
        expect(await h.call('kelpi.example', 'read', {}, 'bundled')).toBe('native');
        expect(() => h.service.registerBuiltinService(adapter)).toThrow('already registered');
        h.service.start();
        expect(() => h.service.registerBuiltinService({ ...adapter, version: 2 })).toThrow('before start');
        expect(h.service.hasSelectedProvider('kelpi.example', 1)).toBe(false);
    });

    it('invalidates consumers on selection, reload and fallback without activation loops', async () => {
        const h = harness();
        await h.install('sample.process', 'kelpi.process', ['exec'], `export function activate(api) { api.providers.register('sample.process.provider', { exec: () => ({stdout:'custom',stderr:''}) }); }`);
        const changed = vi.fn(); const off = h.service.onServicesChanged(changed);
        await h.select('kelpi.process', 'sample.process');
        expect(changed.mock.calls).toEqual([[['kelpi.process@1']]]);
        expect(h.service.hasSelectedProvider('kelpi.process', 1)).toBe(true);
        expect(await h.call('kelpi.process', 'exec', { file: 'unused' })).toEqual({ stdout: 'custom', stderr: '' });
        expect(changed).toHaveBeenCalledTimes(1);
        await h.service.request('reload', { pluginID: 'sample.process' });
        expect(changed.mock.calls.length).toBeGreaterThan(1);
        changed.mockClear();
        await h.service.request('disable', { pluginID: 'sample.process' });
        expect(h.service.hasSelectedProvider('kelpi.process', 1)).toBe(false);
        expect(changed).toHaveBeenCalledWith(['kelpi.process@1']);
        expect(h.service.services().find(service => service['id'] === 'kelpi.process')).toMatchObject({ selectedProviderID: 'sample.process.provider', activeProviderID: 'kelpi.process.bundled' });
        off(); changed.mockClear();
        await h.service.request('enable', { pluginID: 'sample.process' });
        expect(changed).not.toHaveBeenCalled();
    });

    it('validates arguments before dispatch and retires invalid results without retrying mutations', async () => {
        const h = harness(); const write = vi.fn(() => null);
        h.service.registerBuiltinService({ id: 'kelpi.example', title: 'Example', version: 1, methods: {
            write: {
                validateArgs(args) { if (typeof args['value'] !== 'string') throw new Error('value must be text'); },
                validateResult(result) { if (result !== null) throw new Error('write must return null'); }, run: write
            }
        } });
        await h.install('sample.example', 'kelpi.example', ['write'], `export function activate(api) { api.providers.register('sample.example.provider', {write: async args => { await api.storage.set('called', true); return 'invalid'; }}); }`);
        await h.select('kelpi.example', 'sample.example');
        await expect(h.call('kelpi.example', 'write', { value: 1 })).rejects.toThrow('value must be text');
        expect(h.service.list()[0]?.status).toBe('inactive');
        await expect(h.call('kelpi.example', 'write', { value: 'valid' })).rejects.toThrow('invalid write result');
        expect(write).not.toHaveBeenCalled();
        expect(h.service.list()[0]?.status).toBe('failed');
        expect(await h.call('kelpi.example', 'write', { value: 'next call' })).toBe(null);
        expect(write).toHaveBeenCalledTimes(1);
    });

    it('routes the SDK process API through providers and preserves the daemon route on bundled delegation', async () => {
        const h = harness();
        await h.install('sample.process', 'kelpi.process', ['exec'], `export function activate(api) { api.providers.register('sample.process.provider', {exec: async args => { const result = await api.services.call('kelpi.process',1,'exec',args,{provider:'bundled'}); return {...result,stdout:'custom:'+result.stdout}; }}); }`);
        await h.select('kelpi.process', 'sample.process');
        const args = { file: process.execPath, args: ['-e', 'process.stdout.write(process.env.KELPI_SOCKET+":"+process.env.KELPI_REQUIRE_SOCKET)'], cwd: h.root };
        expect(await h.service.api('sample.process', 'process.exec', args, { daemonID: h.service.daemonID })).toEqual({ stdout: `custom:${path.join(h.root, 'private.sock')}:1`, stderr: '' });
        expect(await h.call('kelpi.process', 'exec', args, 'bundled')).toEqual({ stdout: `${path.join(h.root, 'private.sock')}:1`, stderr: '' });
        await expect(h.call('kelpi.process', 'exec', { file: 'unused', args: [7] })).rejects.toThrow('process args');
        await expect(h.call('kelpi.process', 'exec', { file: 'unused', cwd: 7 })).rejects.toThrow('cwd');
    });

    it('never retries an execution that may already have performed a side effect', async () => {
        const h = harness(); const file = path.join(h.root, 'effects');
        await h.install('sample.process', 'kelpi.process', ['exec'], `export function activate(api) { api.providers.register('sample.process.provider', {exec: async args => { await api.services.call('kelpi.process',1,'exec',args,{provider:'bundled'}); throw new Error('after execution'); }}); }`);
        await h.select('kelpi.process', 'sample.process');
        await expect(h.call('kelpi.process', 'exec', { file: process.execPath, args: ['-e', 'require("node:fs").appendFileSync(process.argv[1],"once\\n")', file], cwd: h.root })).rejects.toThrow('after execution');
        expect(fs.readFileSync(file, 'utf8')).toBe('once\n');
        expect(h.service.list()[0]?.status).toBe('running');
    });

    it('cancels a bundled managed process before its delayed side effect', async () => {
        const h = harness(); const file = path.join(h.root, 'cancelled'); const controller = new AbortController();
        const operation = h.service.callService({ service: 'kelpi.process', version: 1, method: 'exec', args: {
            file: process.execPath, args: ['-e', 'setTimeout(()=>require("node:fs").writeFileSync(process.argv[1],"late"),500)', file], cwd: h.root
        } }, undefined, controller.signal);
        controller.abort();
        await expect(operation).rejects.toThrow(/abort|cancel/i);
        expect(fs.existsSync(file)).toBe(false);
    });

    it('cancels an activation waiter without its expired deadline killing the shared backend', async () => {
        const h = harness();
        await h.install('sample.process', 'kelpi.process', ['exec'], `export async function activate(api) { await new Promise(resolve=>setTimeout(resolve,160)); api.providers.register('sample.process.provider', {exec:()=>({stdout:'ready',stderr:''})}); }`, 100);
        await h.select('kelpi.process', 'sample.process');
        const controller = new AbortController();
        const operation = h.service.callService({ service: 'kelpi.process', version: 1, method: 'exec', args: { file: 'unused' } }, undefined, controller.signal);
        await vi.waitFor(() => expect(h.service.list()[0]?.status).toBe('starting'));
        controller.abort();
        await expect(operation).rejects.toThrow('cancelled');
        await vi.waitFor(() => expect(h.service.list()[0]?.status).toBe('running'));
        expect(await h.call('kelpi.process', 'exec', { file: 'unused' })).toEqual({ stdout: 'ready', stderr: '' });
    });

    it('retires oversized provider output and uses bundled on a subsequent call', async () => {
        const h = harness();
        await h.install('sample.process', 'kelpi.process', ['exec'], `export function activate(api) { api.providers.register('sample.process.provider', {exec:()=>({stdout:'x'.repeat(300000),stderr:''})}); }`);
        await h.select('kelpi.process', 'sample.process');
        await expect(h.call('kelpi.process', 'exec', { file: 'unused' })).rejects.toThrow('invalid plugin result');
        expect(h.service.list()[0]?.status).toBe('failed');
        expect(await h.call('kelpi.process', 'exec', { file: process.execPath, args: ['-e', 'process.stdout.write("fallback")'], cwd: h.root })).toEqual({ stdout: 'fallback', stderr: '' });
    });
});
