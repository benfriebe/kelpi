import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadDevices } from '../lifecycle/devices.js';
import type { TailscaleRunner } from '../lifecycle/tailnet.js';
import { createRemoteChannel } from './remote.js';

const roots: string[] = [];

function registryFile(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-remote-'));
    roots.push(root);
    return path.join(root, 'devices.json');
}

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A tailscale CLI whose answers are scripted per argv head (`status` / `serve`). */
function tailscale(script: {
    status?: { code: number; stdout: string };
    serveStatus?: { code: number; stdout: string };
    serveBg?: { code: number; stderr?: string };
}): { run: TailscaleRunner; calls: string[][] } {
    const calls: string[][] = [];
    const run: TailscaleRunner = (args) => {
        calls.push([...args]);
        if (args[0] === 'status') {
            const reply = script.status ?? { code: -1, stdout: '' };
            return Promise.resolve({ code: reply.code, stdout: reply.stdout, stderr: reply.code === -1 ? 'ENOENT' : '' });
        }
        if (args[0] === 'serve' && args[1] === 'status') {
            const reply = script.serveStatus ?? { code: 0, stdout: '{}' };
            return Promise.resolve({ code: reply.code, stdout: reply.stdout, stderr: '' });
        }
        if (args[0] === 'serve' && args[1] === '--bg') {
            const reply = script.serveBg ?? { code: 0 };
            return Promise.resolve({ code: reply.code, stdout: '', stderr: reply.stderr ?? '' });
        }
        return Promise.resolve({ code: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` });
    };
    return { run, calls };
}

const RUNNING = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'werk.taila.ts.net.' } });

function channel(file: string, ts: { run: TailscaleRunner }, port: number | undefined = 61154) {
    return createRemoteChannel({
        env: { KELPID_DEVICES_PATH: file } as NodeJS.ProcessEnv,
        port: () => port,
        tailscale: ts.run
    });
}

describe('remote-status', () => {
    it('reports devices plus an unavailable tailnet when tailscale is not installed', async () => {
        const file = registryFile();
        const remote = channel(file, tailscale({}));
        const reply = (await remote.status()) as Record<string, unknown>;
        expect(reply['ok']).toBe(true);
        expect(reply['devices']).toEqual([]);
        expect(reply['tailnet']).toEqual({
            available: false,
            serving: false,
            reason: 'tailscale is not installed'
        });
    });

    it('reports identity and whether serve fronts the daemon, without mutating anything', async () => {
        const file = registryFile();
        const ts = tailscale({
            status: { code: 0, stdout: RUNNING },
            serveStatus: {
                code: 0,
                stdout: JSON.stringify({
                    Web: { 'werk.taila.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:61154' } } } }
                })
            }
        });
        const remote = channel(file, ts);
        const reply = (await remote.status()) as Record<string, unknown>;
        expect(reply['tailnet']).toEqual({
            available: true,
            backend: 'Running',
            dns_name: 'werk.taila.ts.net',
            serving: true
        });
        // A dashboard, never a mutation: no `serve --bg` ran.
        expect(ts.calls.some((call) => call.includes('--bg'))).toBe(false);
    });
});

describe('remote-pair', () => {
    it('mints a loopback pairing when tailnet is off: the URL carries the token exactly once', async () => {
        const file = registryFile();
        const remote = channel(file, tailscale({}));
        const reply = (await remote.pair('alice-laptop', false)) as Record<string, unknown>;
        expect(reply['ok']).toBe(true);
        const url = reply['url'] as string;
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:61154\/\?token=kd_/);
        const stored = loadDevices(file);
        expect(stored).toHaveLength(1);
        expect(stored[0]?.name).toBe('alice-laptop');
        // The registry holds the HASH, never the plaintext riding the URL.
        expect(url).not.toContain(stored[0]?.tokenHash);
    });

    it('builds the tailnet URL through the serve recipe, reporting what it configured', async () => {
        const file = registryFile();
        const ts = tailscale({
            status: { code: 0, stdout: RUNNING },
            serveStatus: { code: 0, stdout: '{}' },
            serveBg: { code: 0 }
        });
        const remote = channel(file, ts);
        const reply = (await remote.pair('phone', true)) as Record<string, unknown>;
        expect(reply['ok']).toBe(true);
        expect(reply['url']).toMatch(/^https:\/\/werk\.taila\.ts\.net\/\?token=kd_/);
        expect(reply['notes']).toEqual(['tailscale serve --bg 61154: configured (was not serving anything)']);
    });

    it('rolls the mint back when the tailnet half fails — nothing paired, registry unchanged', async () => {
        const file = registryFile();
        const remote = channel(file, tailscale({ status: { code: 0, stdout: JSON.stringify({ BackendState: 'Stopped' }) } }));
        const reply = (await remote.pair('phone', true)) as Record<string, unknown>;
        expect(reply['ok']).toBe(false);
        expect(reply['error']).toContain('tailscaled is not running');
        expect(reply['error']).toContain('rolled back');
        // The repair rides through as ordered steps too - the UI renders them as a checklist.
        expect(reply['repair']).toContain('tailscale up');
        expect(reply['steps']).toEqual([expect.stringContaining('tailscale up')]);
        expect(loadDevices(file)).toEqual([]);
    });

    it('refuses a duplicate live name, like the CLI does', async () => {
        const file = registryFile();
        const remote = channel(file, tailscale({}));
        await remote.pair('phone', false);
        const reply = (await remote.pair('phone', false)) as Record<string, unknown>;
        expect(reply['ok']).toBe(false);
        expect(reply['error']).toContain('already named');
    });
});

describe('remote-revoke', () => {
    it('revokes by id and reports the entry; an unknown target is an error', async () => {
        const file = registryFile();
        const remote = channel(file, tailscale({}));
        const minted = (await remote.pair('phone', false)) as Record<string, unknown>;
        const id = (minted['device'] as Record<string, unknown>)['id'] as string;

        const revoked = (await remote.revoke(id)) as Record<string, unknown>;
        expect(revoked['ok']).toBe(true);
        expect((revoked['device'] as Record<string, unknown>)['revoked_at']).toBeDefined();
        expect(loadDevices(file)[0]?.revokedAt).toBeDefined();

        const missing = (await remote.revoke('nope')) as Record<string, unknown>;
        expect(missing['ok']).toBe(false);
    });

    it('status lists live devices before revoked ones', async () => {
        const file = registryFile();
        const remote = channel(file, tailscale({}));
        const first = (await remote.pair('old', false)) as Record<string, unknown>;
        await remote.pair('new', false);
        await remote.revoke(((first['device'] as Record<string, unknown>)['id'] as string) ?? '');
        const reply = (await remote.status()) as Record<string, unknown>;
        const names = (reply['devices'] as { name: string; revoked_at?: string }[]).map((d) => d.name);
        expect(names).toEqual(['new', 'old']);
    });
});
