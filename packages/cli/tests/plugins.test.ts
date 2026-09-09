import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCLI, scratchHome, startFakeServer, type FakeServer } from './harness.js';

let server: FakeServer, home: string;
beforeEach(async () => { server = await startFakeServer(); home = scratchHome(); });
afterEach(async () => { await server.close(); fs.rmSync(home, { recursive: true, force: true }); });

describe('bundled plugin CLI', () => {
    it('inspects complete contribution state as JSON through a read-only request and documents the action', async () => {
        const contributions = [{ pluginID: 'sample.board', instanceID: 'E:2', sequence: 12, state: { context: { ready: true }, items: { 'sample.board.status': { text: 'Ready', badge: '2' } } } }];
        server.respond(() => ({ lines: [{ ok: true, result: contributions }] }));
        for (const args of [['contributions'], ['contributions', '--json']]) {
            const result = await runCLI(['plugin', ...args], { port: server.port, cwd: home });
            expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toEqual(contributions);
        }
        expect(server.requests).toEqual([{ command: 'plugin', action: 'contributions', text: '{}' }, { command: 'plugin', action: 'contributions', text: '{}' }]);
        const help = await runCLI(['plugin', '--help'], { port: server.port, cwd: home });
        expect(help.code).toBe(0); expect(help.stdout).toContain('contributions [--json]');
        const invalid = await runCLI(['plugin', 'contributions', '--args', '{"context":{"ready":false}}'], { port: server.port, cwd: home });
        expect(invalid.code).toBe(1); expect(invalid.stderr).toContain('unexpected arguments');
        expect(server.requests).toHaveLength(2);
    });
    it('encodes namespaced commands and structured arguments without shell interpretation', async () => {
        server.respond(() => ({ lines: [{ ok: true, result: { answer: 42 } }] }));
        const result = await runCLI(['plugin', 'run', 'sample.board.run', '--args', '{"text":"$(literal) `literal`"}', '--workspace', 'workspace'], { port: server.port, cwd: home });
        expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toEqual({ answer: 42 });
        expect(JSON.parse(String(server.requests[0]?.['text']))).toEqual({ command: 'sample.board.run', args: { text: '$(literal) `literal`' }, workspaceID: 'workspace' });
    });
    it('rejects incomplete installation and invalid JSON before connecting', async () => {
        for (const args of [['install', '--trust'], ['run', 'sample.board.run', '--args', '[1]'], ['settings', 'sample.board', '--key', 'title'], ['service-call', 'sample.service', 'read', '--version', '0'], ['service-select', 'sample.service'], ['service-call', 'sample.service', 'read', '--args', '[]'], ['init', '--unknown', '--id', 'example.starter']]) {
            expect((await runCLI(['plugin', ...args], { port: server.port, cwd: home })).code).toBe(1);
        }
        expect(server.requests).toHaveLength(0);
    });
    it('discovers, calls and selects versioned service providers through the bundled CLI', async () => {
        const services = [{ id: 'kelpi.files', version: 1, methods: ['read', 'write'], selectedProviderID: null, activeProviderID: 'kelpi.files.bundled', providers: [{ id: 'kelpi.files.bundled', status: 'available' }] }];
        server.respond(request => ({ lines: [{ ok: true, result: request.action === 'service-call' ? 'file contents' : services }] }));
        const listing = await runCLI(['plugin', 'services'], { port: server.port, cwd: home });
        expect(listing.code).toBe(0); expect(JSON.parse(listing.stdout)[0].activeProviderID).toBe('kelpi.files.bundled');
        const read = await runCLI(['plugin', 'service-call', 'kelpi.files', 'read', '--version', '1', '--provider', 'kelpi.files.bundled', '--args', '{"path":"/tmp/a file"}'], { port: server.port, cwd: home });
        expect(read.code).toBe(0); expect(JSON.parse(read.stdout)).toBe('file contents');
        expect(JSON.parse(String(server.requests[1]?.text))).toEqual({ service: 'kelpi.files', method: 'read', version: 1, provider: 'kelpi.files.bundled', args: { path: '/tmp/a file' } });
        const selected = await runCLI(['plugin', 'service-select', 'kelpi.files', 'default'], { port: server.port, cwd: home });
        expect(selected.code).toBe(0);
        expect(JSON.parse(String(server.requests[2]?.text))).toEqual({ service: 'kelpi.files', version: 1, provider: null });
    });
    it('scaffolds an offline starter without contacting a daemon', async () => {
        const target = path.join(home, 'my plugin');
        const result = await runCLI(['plugin', 'init', target, '--id', 'example.starter', '--name', 'My Starter'], { port: server.port, cwd: home });
        expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toEqual({ path: target, pluginID: 'example.starter', viewID: 'example.starter.home' });
        expect(JSON.parse(fs.readFileSync(path.join(target, 'kelpi.plugin.json'), 'utf8')).name).toBe('My Starter');
        expect(server.requests).toHaveLength(0);
    });
    it('closes its event subscription on Ctrl-C and keeps watch output as JSON lines', async () => {
        server.respond(() => ({ lines: [{ ok: true, epoch: 'E', sequence: 1, state: {} }, { ok: true, event: { epoch: 'E', sequence: 2, name: 'state.changed', data: [] } }], keepOpen: true }));
        const result = await runCLI(['plugin', 'watch'], { port: server.port, cwd: home, sigintAfterMs: 500 });
        expect(result.code).toBe(130);
        expect(result.stdout.trim().split('\n').map(line => JSON.parse(line))).toHaveLength(2);
        await vi.waitFor(() => expect(server.open).toHaveLength(0));
    });
});
