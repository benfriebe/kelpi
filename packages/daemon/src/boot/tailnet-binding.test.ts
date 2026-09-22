/** Tailnet URLs must reach the actual daemon bind, including across the CLI/control boundary. */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { WS_PROTOCOL_VERSION } from '@kelpi/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { probeDaemon, loadDevices, readToken, writePidRecord } from '../lifecycle/index.js';
import * as tailnet from '../lifecycle/tailnet.js';
import { readForwardingRecord } from '../lifecycle/tailnet-forwarding.js';
import { runKelpid } from '../main.js';
import { createDaemon, type Daemon } from './compose.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
    vi.restoreAllMocks();
});

async function fixture(host: string) {
    const root = fs.mkdtempSync('/tmp/kelpi-tailnet-bind-');
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const env = { KELPID_RUN_DIR: path.join(root, 'run'), KELPID_SOCKET_PATH: path.join(root, 'compat.sock'),
        KELPID_DEVICES_PATH: path.join(root, 'devices.json'), KELPID_HTTP_HOST: '127.0.0.1' };
    const calls: string[][] = [];
    let config = '{}';
    const run: tailnet.TailscaleRunner = async (args) => {
        calls.push([...args]);
        return { code: 0, stderr: '', stdout: args[0] === 'status'
            ? JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'host.tail.ts.net.' } })
            : args[1] === 'status' ? config : '' };
    };
    vi.spyOn(tailnet, 'defaultTailscaleRunner').mockReturnValue(run);
    // A programmatic override deliberately differs from the CLI/inherited environment.
    const daemon = createDaemon({ env, home, httpHost: host, httpPort: 0, settleMs: 0,
        runDir: env.KELPID_RUN_DIR, controlSocketPath: env.KELPID_SOCKET_PATH,
        dbPath: path.join(root, 'db'), configPath: path.join(root, 'config') });
    cleanups.push(() => daemon.stop());
    const info = await daemon.start();
    return { daemon, info, env, calls, setProxy(proxy: string) {
        config = JSON.stringify({ TCP: { '443': { HTTPS: true } },
            Web: { 'host.tail.ts.net:443': { Handlers: { '/': { Proxy: proxy } } } } });
    }, async cli(command: 'url' | 'pair') {
        const out: string[] = [], err: string[] = [];
        const args = command === 'url' ? ['url', '--tailnet'] : ['pair', '--name', 'cli-phone', '--tailnet'];
        const code = await runKelpid(args, { env, out: line => out.push(line), err: line => err.push(line), tailscaleRunner: run });
        return { code, out, err };
    } };
}

async function ownerCommands(daemon: Daemon, host: string, port: number) {
    const token = readToken(daemon.paths)!;
    const socket = new WebSocket(`ws://${host.includes(':') ? `[${host}]` : host}:${port}/ws`);
    cleanups.push(() => { socket.terminate(); });
    const next = (type: string, id?: string): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.off('message', receive); reject(new Error(`waiting for ${type}`)); }, 3000);
        const receive = (data: unknown) => {
            const message = JSON.parse(String(data)) as Record<string, unknown>;
            if (message['type'] !== type || (id !== undefined && message['id'] !== id)) return;
            clearTimeout(timer);
            socket.off('message', receive);
            resolve(message);
        };
        socket.on('message', receive);
    });
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const welcome = next('welcome');
    socket.send(JSON.stringify({ type: 'hello', protocolVersion: WS_PROTOCOL_VERSION, token }));
    await welcome;
    return async (command: string) => {
        const response = next('command-reply', command);
        socket.send(JSON.stringify({ type: 'command', id: command, payload: { command, name: 'ws-phone', tailnet: true } }));
        return (await response)['reply'];
    };
}

describe('tailnet binding through production entry points', () => {
    it('refuses older or unverified daemon metadata instead of trusting saved ports or CLI env', async () => {
        const f = await fixture('127.0.0.1');
        Object.defineProperty(f.daemon.ctx, 'httpEndpoint', { value: () => undefined });
        expect(await f.cli('url')).toMatchObject({ code: 1, out: [] });
        expect(await f.cli('pair')).toMatchObject({ code: 1, out: [] });
        expect(f.calls).toEqual([]);
        expect(loadDevices(f.env.KELPID_DEVICES_PATH)).toEqual([]);
    });

    it('refuses a foreign IPv4 service sharing the IPv6 daemon port in CLI and Settings', async () => {
        const f = await fixture('::1');
        const foreign = net.createServer(socket => socket.end());
        await new Promise<void>((resolve, reject) => { foreign.once('error', reject); foreign.listen(f.info.httpPort, '127.0.0.1', resolve); });
        cleanups.push(() => new Promise<void>(resolve => foreign.close(() => resolve())));
        f.setProxy(`http://127.0.0.1:${f.info.httpPort}`);
        expect(await f.cli('url')).toMatchObject({ code: 1, out: [] });
        expect(await f.cli('pair')).toMatchObject({ code: 1, out: [] });
        const command = await ownerCommands(f.daemon, '::1', f.info.httpPort);
        expect(await command('remote-status')).toMatchObject({ tailnet: { serving: false } });
        expect(await command('remote-pair')).toMatchObject({ ok: false });
        expect(loadDevices(f.env.KELPID_DEVICES_PATH)).toEqual([]);
        expect(f.calls.some(args => args.includes('--bg'))).toBe(false);
        expect(readForwardingRecord(path.join(f.env.KELPID_RUN_DIR, 'tailscale-serve.json'))).toBeUndefined();
    });

    it('uses an explicit IPv6 target for empty-config setup in CLI and Settings', async () => {
        const f = await fixture('::1');
        const foreign = net.createServer(socket => socket.end());
        await new Promise<void>((resolve, reject) => { foreign.once('error', reject); foreign.listen(f.info.httpPort, '127.0.0.1', resolve); });
        cleanups.push(() => new Promise<void>(resolve => foreign.close(() => resolve())));
        // Neither stale disk metadata nor the CLI's IPv4 env may choose the target.
        writePidRecord(f.daemon.paths, { http_port: 12345 });
        expect((await f.cli('url')).code).toBe(0);
        expect((await f.cli('pair')).code).toBe(0);
        const command = await ownerCommands(f.daemon, '::1', f.info.httpPort);
        expect(await command('remote-pair')).toMatchObject({ ok: true });
        expect(f.calls.filter(args => args.includes('--bg'))).toEqual(
            Array.from({ length: 3 }, () => ['serve', '--bg', `http://[::1]:${f.info.httpPort}`])
        );
        expect(readForwardingRecord(path.join(f.env.KELPID_RUN_DIR, 'tailscale-serve.json'))).toMatchObject({ host: '::1', port: f.info.httpPort });
    });

    it.each(['127.0.0.1', '0.0.0.0', '::1', '::', 'localhost'])('reuses a proven root route for bind %s', async host => {
        const f = await fixture(host);
        const address = f.daemon.ws!.addresses[0]!;
        expect(net.isIP(address.host)).not.toBe(0);
        const loopback = address.host.includes(':') ? '::1' : '127.0.0.1';
        const proxy = `http://${loopback === '::1' ? '[::1]' : loopback}:${address.port}`;
        f.setProxy(proxy);
        expect(await probeDaemon(f.daemon.paths)).toMatchObject({ http: { host: address.host, port: address.port } });
        expect((await f.cli('url')).code).toBe(0);
        expect((await f.cli('pair')).code).toBe(0);
        const command = await ownerCommands(f.daemon, loopback, address.port);
        expect(await command('remote-status')).toMatchObject({ tailnet: { serving: true } });
        expect(await command('remote-pair')).toMatchObject({ ok: true });
        expect(f.calls.some(args => args.includes('--bg'))).toBe(false);
    });
});
