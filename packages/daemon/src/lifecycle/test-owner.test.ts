import net from 'node:net';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { connectTestOwner } from './test-owner.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function channel() {
    const sockets = new Set<net.Socket>();
    const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on('error', () => {});
    });
    cleanups.push(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as net.AddressInfo;
    const env = { KELPI_TEST_OWNER_PORT: String(address.port), KELPI_TEST_OWNER_TOKEN: 'a'.repeat(64) };
    const connected = once(server, 'connection');
    const pending = connectTestOwner(env);
    const [socket] = await connected as [net.Socket];
    socket.setEncoding('utf8');
    const [hello] = await once(socket, 'data') as [string];
    return { socket, pending, env, hello };
}

it('leaves ordinary daemon launches alone', async () => {
    const env = { HOME: '/private-home' };
    const before = process.listenerCount('SIGTERM');
    await connectTestOwner(env);
    expect(env).toEqual({ HOME: '/private-home' });
    expect(process.listenerCount('SIGTERM')).toBe(before);
});

it.each([
    { KELPI_TEST_OWNER_PORT: '19733' },
    { KELPI_TEST_OWNER_TOKEN: 'a'.repeat(64) },
    { KELPI_TEST_OWNER_PORT: '-1', KELPI_TEST_OWNER_TOKEN: 'a'.repeat(64) },
    { KELPI_TEST_OWNER_PORT: '0', KELPI_TEST_OWNER_TOKEN: 'a'.repeat(64) },
    { KELPI_TEST_OWNER_PORT: '65536', KELPI_TEST_OWNER_TOKEN: 'a'.repeat(64) },
    { KELPI_TEST_OWNER_PORT: '1.5', KELPI_TEST_OWNER_TOKEN: 'a'.repeat(64) },
    { KELPI_TEST_OWNER_PORT: '12345', KELPI_TEST_OWNER_TOKEN: 'not-a-capability' }
])('refuses malformed ownership before boot and consumes its private environment', async env => {
    await expect(connectTestOwner(env)).rejects.toThrow('invalid private test owner channel');
    expect(env).toEqual({});
});

it('authenticates before permission and acknowledges only explicit completed cleanup', async () => {
    const before = process.listenerCount('SIGTERM');
    const { socket, pending, env, hello } = await channel();
    expect(JSON.parse(hello)).toEqual({ token: 'a'.repeat(64), pid: process.pid });
    expect(env).toEqual({});
    let permitted = false;
    void pending.then(() => { permitted = true; });
    socket.write('sta');
    await new Promise(resolve => setImmediate(resolve));
    expect(permitted).toBe(false);
    socket.write('rt\n');
    const owner = (await pending)!;
    cleanups.push(() => owner.confirmStopped());
    expect(owner.stopRequested).toBe(false);
    let receipt = '';
    socket.on('data', chunk => { receipt += chunk; });
    socket.write('stop\nstop\n');
    await owner.whenStopRequested;
    expect(owner.stopRequested).toBe(true);
    expect(receipt).toBe('');
    const ended = once(socket, 'end');
    const confirmation = owner.confirmStopped();
    expect(owner.confirmStopped()).toBe(confirmation);
    await confirmation;
    await ended;
    expect(receipt).toBe('stopped\n');
    expect(process.listenerCount('SIGTERM')).toBe(before);
});

it('accepts cancellation instead of startup permission', async () => {
    const { socket, pending } = await channel();
    socket.write('stop\n');
    const owner = (await pending)!;
    cleanups.push(() => owner.confirmStopped());
    expect(owner.stopRequested).toBe(true);
    await owner.whenStopRequested;
});

it('rejects a closed channel before permission and releases signal handlers', async () => {
    const before = process.listenerCount('SIGTERM');
    const { socket, pending } = await channel();
    const rejected = expect(pending).rejects.toThrow('closed before startup permission');
    socket.end();
    await rejected;
    expect(process.listenerCount('SIGTERM')).toBe(before);
});

it('requests cleanup if the owner disconnects after permission', async () => {
    const { socket, pending } = await channel();
    socket.write('start\n');
    const owner = (await pending)!;
    cleanups.push(() => owner.confirmStopped());
    socket.end();
    await owner.whenStopRequested;
    expect(owner.stopRequested).toBe(true);
});

it('refuses oversized commands before startup', async () => {
    const { socket, pending } = await channel();
    const rejected = expect(pending).rejects.toThrow('invalid private test owner command');
    socket.write('x'.repeat(1025));
    await rejected;
});
