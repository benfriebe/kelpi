import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeForwardTarget, readForwardingRecord, writeForwardingRecord } from './tailnet-forwarding.js';

const roots: string[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-forwarding-'));
    roots.push(root);
    return path.join(root, 'run', 'tailscale-serve.json');
}

describe('forward target probes', () => {
    it('distinguishes an accepting loopback service from a closed port without sending bytes', async () => {
        let received = '';
        const server = net.createServer((socket) => socket.on('data', (data) => { received += String(data); }));
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as net.AddressInfo).port;
        try {
            expect(await probeForwardTarget('127.0.0.1', port)).toBe('listening');
            expect(await probeForwardTarget('localhost', port)).toBe('listening');
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
        expect(received).toBe('');
        expect(await probeForwardTarget('127.0.0.1', port)).toBe('refused');
    });

    it('probes IPv6 as IPv6 and does not call a localhost IPv6 listener stale', async () => {
        const server = net.createServer((socket) => socket.end());
        await new Promise<void>((resolve) => server.listen(0, '::1', resolve));
        const port = (server.address() as net.AddressInfo).port;
        try {
            expect(await probeForwardTarget('::1', port)).toBe('listening');
            expect(await probeForwardTarget('localhost', port)).toBe('listening');
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it('bounds a stalled connection and releases the socket without declaring it unused', async () => {
        vi.useFakeTimers();
        let socket: net.Socket | undefined;
        vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket) {
            socket = this;
            return this;
        });
        const pending = probeForwardTarget('127.0.0.1', 12345);
        await vi.advanceTimersByTimeAsync(1000);
        expect(await pending).toBe('unknown');
        expect(socket?.destroyed).toBe(true);
    });

    it('does not misclassify sandbox/permission errors as a stale target', async () => {
        vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket) {
            queueMicrotask(() => this.emit('error', Object.assign(new Error('denied'), { code: 'EPERM' })));
            return this;
        });
        expect(await probeForwardTarget('localhost', 12345)).toBe('unknown');
    });

    it.each([0, -1, 65536, NaN, 1.5])('does not connect to an invalid port %s', async (port) => {
        const connect = vi.spyOn(net.Socket.prototype, 'connect');
        expect(await probeForwardTarget('127.0.0.1', port)).toBe('unknown');
        expect(connect).not.toHaveBeenCalled();
    });
});

describe('forwarding history', () => {
    const record = { version: 1 as const, dnsName: 'host.tail.ts.net', port: 54321, configuredAt: '2026-09-19T12:00:00.000Z' };

    it('persists only diagnostic data in a private atomic file that can be reread after restart', () => {
        const file = scratch();
        writeForwardingRecord(file, record);
        expect(readForwardingRecord(file)).toEqual(record);
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        expect(fs.readdirSync(path.dirname(file))).toEqual(['tailscale-serve.json']);
        writeForwardingRecord(file, { ...record, port: 54322 });
        expect(readForwardingRecord(file)?.port).toBe(54322);
    });

    it('tolerates absent, corrupt and unsupported history', () => {
        const file = scratch();
        expect(readForwardingRecord(file)).toBeUndefined();
        fs.mkdirSync(path.dirname(file));
        for (const value of ['garbage', 'null', '{}', JSON.stringify({ ...record, port: 0 }), JSON.stringify({ ...record, version: 2 }), JSON.stringify({ ...record, configuredAt: 'invalid' })]) {
            fs.writeFileSync(file, value);
            expect(readForwardingRecord(file)).toBeUndefined();
        }
    });
});
