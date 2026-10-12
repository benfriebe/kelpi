import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deadPort, runCLI, scratchHome, startFakeServer, type FakeServer } from './harness.js';

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
    it('selects offline pane, sidebar, document and browser templates and rejects unknown templates', async () => {
        const placements = { pane: ['pane', 'sidebar.primary', 'sidebar.secondary'], sidebar: ['sidebar.primary', 'sidebar.secondary'],
            document: ['document.markdown', 'document.scratchpad', 'document.diff', 'document.csv'], browser: ['browser'] };
        for (const [template, expected] of Object.entries(placements)) {
            const target = path.join(home, template);
            const result = await runCLI(['plugin', 'init', target, '--id', 'example.starter', '--template', template], { port: server.port, cwd: home });
            expect(result.code).toBe(0);
            expect(JSON.parse(fs.readFileSync(path.join(target, 'kelpi.plugin.json'), 'utf8')).contributes.views[0].placements).toEqual(expected);
        }
        const missing = path.join(home, 'unknown');
        expect((await runCLI(['plugin', 'init', missing, '--id', 'example.starter', '--template', 'unknown'], { port: server.port, cwd: home })).code).toBe(1);
        expect(fs.existsSync(missing)).toBe(false);
        expect(server.requests).toHaveLength(0);
    });
    it('requires dev trust and recovery-capable daemon before applying any edit', async () => {
        const source = path.join(home, 'source');
        await runCLI(['plugin', 'init', source, '--id', 'example.dev'], { port: server.port, cwd: home });
        for (const args of [['dev', source], ['dev', '--trust'], ['dev', source, '--trust', '--unknown']]) {
            expect((await runCLI(['plugin', ...args], { port: server.port, cwd: home })).code).toBe(1);
        }
        expect(server.requests).toHaveLength(0);
        server.respond(() => ({ lines: [{ ok: true, result: { apiVersion: 1 } }] }));
        const old = await runCLI(['plugin', 'dev', source, '--trust'], { port: server.port, cwd: home });
        expect(old.code).toBe(1); expect(old.stderr).toContain('requires a daemon with plugin revision recovery');
        expect(server.requests).toEqual([{ command: 'plugin', action: 'identity', text: '{}' }]);
    });
    it.each([false, true])('keeps dev running after an install response (failure=%s) and releases its captured files on Ctrl-C', async fail => {
        const source = path.join(home, 'source');
        await runCLI(['plugin', 'init', source, '--id', 'example.dev'], { port: server.port, cwd: home });
        const validated = await runCLI(['plugin', 'validate', source], { port: server.port, cwd: home });
        const revision = JSON.parse(validated.stdout).revision;
        let snapshot = '';
        server.respond(request => {
            if (request.action === 'identity') return { lines: [{ ok: true, result: { daemonID: 'selected-daemon', capabilities: ['plugin-revisions', 'plugin-dev'] } }] };
            const input = JSON.parse(String(request.text)); snapshot = input.path;
            expect(input.trust).toBe(true); expect(input.daemonID).toBe('selected-daemon'); expect(snapshot).not.toBe(source);
            expect(fs.readFileSync(path.join(snapshot, 'backend.mjs'), 'utf8')).toBe(fs.readFileSync(path.join(source, 'backend.mjs'), 'utf8'));
            return { lines: [fail ? { ok: false, error: 'activation failed; previous revision restored' } : { ok: true, result: [{ manifest: { id: 'example.dev' }, revision, enabled: true, status: 'running' }] }] };
        });
        const result = await runCLI(['plugin', 'dev', source, '--trust'], { port: server.port, cwd: home, sigintAfterMs: 700 });
        expect(result.code).toBe(130);
        const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
        expect(events.map(event => event.type)).toEqual(['watching', 'applying', fail ? 'failed' : 'applied', 'stopped']);
        if (fail) expect(events[2].error).toContain('previous revision restored');
        expect(events[3].signal).toBe('SIGINT');
        expect(server.requests.map(request => request.action)).toEqual(['identity', 'dev-install']);
        expect(fs.existsSync(snapshot)).toBe(false); expect(fs.existsSync(source)).toBe(true);
    });
    it('validates and packs offline, then sends the artifact path to the selected daemon for installation', async () => {
        const source = path.join(home, 'my plugin'), archive = path.join(home, 'my plugin.kelpi-plugin');
        expect((await runCLI(['plugin', 'init', source, '--id', 'example.package'], { port: server.port, cwd: home })).code).toBe(0);
        const validate = await runCLI(['plugin', 'validate', source, '--json'], { port: server.port, cwd: home });
        expect(validate.code).toBe(0);
        const report = JSON.parse(validate.stdout);
        expect(report).toMatchObject({ format: 'directory', pluginID: 'example.package', apiVersion: 1 });
        const packed = await runCLI(['plugin', 'pack', source, '--out', archive], { port: server.port, cwd: home });
        expect(packed.code).toBe(0); expect(JSON.parse(packed.stdout)).toMatchObject({ path: archive, revision: report.revision });
        fs.rmSync(source, { recursive: true });
        const checked = await runCLI(['plugin', 'validate', archive], { port: server.port, cwd: home });
        expect(checked.code).toBe(0); expect(JSON.parse(checked.stdout)).toMatchObject({ format: 'kelpi-plugin', revision: report.revision });
        expect(server.requests).toHaveLength(0);
        server.respond(() => ({ lines: [{ ok: true, result: [] }] }));
        expect((await runCLI(['plugin', 'install', archive, '--trust'], { port: server.port, cwd: home })).code).toBe(0);
        expect(server.requests).toEqual([{ command: 'plugin', action: 'install', text: JSON.stringify({ trust: true, path: archive }) }]);
    });
    it('reports invalid package input and output without contacting a daemon', async () => {
        const source = path.join(home, 'source');
        expect((await runCLI(['plugin', 'init', source, '--id', 'example.package'], { port: server.port, cwd: home })).code).toBe(0);
        for (const args of [['validate'], ['validate', source, '--trust'], ['pack', source], ['pack', source, '--out', path.join(source, 'out.kelpi-plugin')]]) {
            const result = await runCLI(['plugin', ...args], { port: server.port, cwd: home });
            expect(result.code).toBe(1); expect(result.stderr).toContain('kelpi plugin:');
        }
        fs.unlinkSync(path.join(source, 'backend.mjs'));
        const invalid = await runCLI(['plugin', 'validate', source], { port: server.port, cwd: home });
        expect(invalid.code).toBe(1); expect(invalid.stderr).toContain('missing plugin entry');
        expect(server.requests).toHaveLength(0);
    });
    it('lists retained versions and selects an explicit revision without treating version strings as identities', async () => {
        const revision = 'a'.repeat(64);
        const history = [{ revision, manifest: { id: 'example.package', version: '1.0.0' }, selected: false, installedAt: 123, problem: null }];
        server.respond(request => ({ lines: [{ ok: true, result: request.action === 'history' ? history : [] }] }));
        const listed = await runCLI(['plugin', 'history', 'example.package', '--json'], { port: server.port, cwd: home });
        expect(listed.code).toBe(0); expect(JSON.parse(listed.stdout)).toEqual(history);
        expect((await runCLI(['plugin', 'rollback', 'example.package', '--revision', revision], { port: server.port, cwd: home })).code).toBe(0);
        expect((await runCLI(['plugin', 'rollback', 'example.package'], { port: server.port, cwd: home })).code).toBe(0);
        expect(server.requests).toEqual([
            { command: 'plugin', action: 'history', text: JSON.stringify({ pluginID: 'example.package' }) },
            { command: 'plugin', action: 'rollback', text: JSON.stringify({ pluginID: 'example.package', revision }) },
            { command: 'plugin', action: 'rollback', text: JSON.stringify({ pluginID: 'example.package' }) },
        ]);
        for (const args of [['history'], ['rollback'], ['rollback', 'example.package', '--revision', '1.0.0'], ['history', 'example.package', '--revision', revision]]) {
            expect((await runCLI(['plugin', ...args], { port: server.port, cwd: home })).code).toBe(1);
        }
        expect(server.requests).toHaveLength(3);
    });
    it('closes its event subscription on Ctrl-C and keeps watch output as JSON lines', async () => {
        server.respond(() => ({ lines: [{ ok: true, epoch: 'E', sequence: 1, state: {} }, { ok: true, event: { epoch: 'E', sequence: 2, name: 'state.changed', data: [] } }], keepOpen: true }));
        const result = await runCLI(['plugin', 'watch'], { port: server.port, cwd: home, sigintAfterMs: 500 });
        expect(result.code).toBe(130);
        expect(result.stdout.trim().split('\n').map(line => JSON.parse(line))).toHaveLength(2);
        await vi.waitFor(() => expect(server.open).toHaveLength(0));
    });
});

describe('plugin CLI verbs through the bundled CLI', () => {
    const verbs = [{ name: 'hello', summary: 'Say hello', command: 'lab.hello', pluginID: 'lab.service', pluginName: 'Service Lab', enabled: true },
        { name: 'shout', summary: 'Say it louder', command: 'lab.shout', pluginID: 'lab.service', pluginName: 'Service Lab', enabled: false }];
    it('runs a verb with its argv, cwd and caller pane in one request, printing text and exiting with its exitCode', async () => {
        server.respond(() => ({ lines: [{ ok: true, result: { text: 'hello a b', exitCode: 3 } }] }));
        const result = await runCLI(['hello', 'a', 'b'], { port: server.port, cwd: home, paneID: 'PANE-1' });
        expect(result.code).toBe(3); expect(result.stdout).toBe('hello a b\n'); expect(result.stderr).toBe('');
        expect(server.requests).toHaveLength(1); expect(server.requests[0]).toMatchObject({ command: 'plugin', action: 'cli' });
        expect(JSON.parse(String(server.requests[0]?.['text']))).toEqual({ verb: 'hello', argv: ['a', 'b'], cwd: home, isTTY: false, json: false, paneID: 'PANE-1' });
        server.respond(() => ({ lines: [{ ok: true, result: { text: 'quiet', stderr: 'careful' } }] }));
        const plain = await runCLI(['hello'], { port: server.port, cwd: home });
        expect(plain.code).toBe(0); expect(plain.stdout).toBe('quiet\n'); expect(plain.stderr).toBe('careful\n');
        expect(JSON.parse(String(server.requests[1]?.['text']))).not.toHaveProperty('paneID');
    });
    it('pops --json before -- and prints the json result, or the text wrapped as an object', async () => {
        server.respond(() => ({ lines: [{ ok: true, result: { text: 'hello a', json: { argv: ['a'] } } }] }));
        const json = await runCLI(['hello', '--json', 'a', '--', '--json'], { port: server.port, cwd: home });
        expect(json.code).toBe(0); expect(JSON.parse(json.stdout)).toEqual({ argv: ['a'] });
        expect(JSON.parse(String(server.requests[0]?.['text']))).toMatchObject({ argv: ['a', '--', '--json'], json: true });
        server.respond(() => ({ lines: [{ ok: true, result: { text: 'hello' } }] }));
        expect(JSON.parse((await runCLI(['hello', '--json'], { port: server.port, cwd: home })).stdout)).toEqual({ text: 'hello' });
        server.respond(() => ({ lines: [{ ok: true, result: { text: 'usage: hello' } }] }));
        expect((await runCLI(['hello', '--help'], { port: server.port, cwd: home })).stdout).toBe('usage: hello\n');
        expect(JSON.parse(String(server.requests[2]?.['text']))).toMatchObject({ argv: ['--help'], json: false });
    });
    it('keeps the unknown-command output for an undeclared word and names the verb for a disabled plugin', async () => {
        server.respond(request => ({ lines: [{ ok: false, error: JSON.parse(String(request['text'])).verb === 'hello' ? 'plugin lab.service is disabled' : 'unknown kelpi verb: frobnicate' }] }));
        const unknown = await runCLI(['frobnicate'], { port: server.port, cwd: home });
        expect(unknown.code).toBe(1); expect(unknown.stdout).toBe(''); expect(unknown.stderr.startsWith('Unknown command: frobnicate\nUsage:\n')).toBe(true);
        const disabled = await runCLI(['hello'], { port: server.port, cwd: home });
        expect(disabled.code).toBe(1); expect(disabled.stderr).toBe('kelpi hello: plugin lab.service is disabled\n');
    });
    it('never asks the daemon about a flag, version or a built-in verb', async () => {
        const flag = await runCLI(['--bogus'], { port: server.port, cwd: home });
        expect(flag.code).toBe(1); expect(flag.stderr.startsWith('Unknown command: --bogus\nUsage:\n')).toBe(true);
        expect((await runCLI(['version'], { port: server.port, cwd: home })).code).toBe(0);
        expect((await runCLI(['plugin', 'help'], { port: server.port, cwd: home })).code).toBe(0);
        expect(server.requests).toHaveLength(0);
    });
    it('answers at once that plugin verbs need a daemon when none is listening, even from a pane', async () => {
        const started = Date.now();
        const result = await runCLI(['frobnicate'], { port: await deadPort(), cwd: home, paneID: 'PANE-1' });
        expect(Date.now() - started).toBeLessThan(4000);
        expect(result.code).toBe(1);
        const lines = result.stderr.split('\n');
        expect(lines[0]).toBe('Unknown command: frobnicate'); expect(lines[1]).toMatch(/^Plugin verbs need a running Kelpi daemon/); expect(lines[2]).toBe('Usage:');
    });
    it('lists installed verbs under their plugin after the usage text of kelpi --help and kelpi help', async () => {
        server.respond(() => ({ lines: [{ ok: true, result: { verbs } }] }));
        for (const word of ['--help', 'help']) {
            const result = await runCLI([word], { port: server.port, cwd: home });
            expect(result.code).toBe(0); expect(result.stdout).toBe('');
            expect(result.stderr).toMatch(/kelpi install-hooks [^\n]*\n\nPlugin commands:\n  # Service Lab\n  kelpi hello             Say hello\n  kelpi shout \(disabled\)  Say it louder\n\n$/);
        }
        expect(server.requests).toEqual([{ command: 'plugin', action: 'cli-list', text: '{}' }, { command: 'plugin', action: 'cli-list', text: '{}' }]);
    });
    it('leaves the plugin block out when there are no verbs, no daemon or no answer within 2 s', async () => {
        server.respond(() => ({ lines: [{ ok: true, result: { verbs: [] } }] }));
        const empty = await runCLI(['--help'], { port: server.port, cwd: home });
        expect(empty.code).toBe(0); expect(empty.stderr).toContain('Usage:'); expect(empty.stderr).not.toContain('Plugin commands:');
        const offline = await runCLI(['--help'], { port: await deadPort(), cwd: home, paneID: 'PANE-1' });
        expect(offline.code).toBe(0); expect(offline.stderr).toContain('Usage:'); expect(offline.stderr).not.toContain('Plugin commands:');
        server.respond(() => ({ keepOpen: true }));
        const started = Date.now();
        const slow = await runCLI(['--help'], { port: server.port, cwd: home });
        expect(Date.now() - started).toBeLessThan(4500);
        expect(slow.code).toBe(0); expect(slow.stderr).toContain('Usage:'); expect(slow.stderr).not.toContain('Plugin commands:');
    });
});
