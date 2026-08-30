import { PTY_FRAME_TYPES, encodePtyFrame } from '@kelpi/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KelpiConnection, resolveWsUrl, tokenFromLocation, type ConnectionStatus } from './socket';
import { completeHandshake, createFakeSocketFactory, emptySnapshotState } from './testing';

const PANE = '11111111-2222-4333-8444-555555555555';

function connectionWith(overrides: Partial<ConstructorParameters<typeof KelpiConnection>[0]> = {}) {
    const harness = createFakeSocketFactory();
    const statuses: ConnectionStatus[] = [];
    const connection = new KelpiConnection({
        url: 'http://daemon.test:19470',
        token: 'secret',
        socketFactory: harness.factory,
        // Deterministic backoff: no jitter, fixed steps.
        backoff: { initialMs: 100, maxMs: 1000, factor: 2, jitter: 0 },
        ...overrides
    });
    connection.on('status', (status) => statuses.push(status));
    return { connection, harness, statuses };
}

describe('resolveWsUrl', () => {
    it('turns an http origin into the daemon ws endpoint with the token attached', () => {
        expect(resolveWsUrl('http://127.0.0.1:19470', 'abc')).toBe('ws://127.0.0.1:19470/ws?token=abc');
        expect(resolveWsUrl('https://kelpi.tailnet.ts.net', 'x')).toBe('wss://kelpi.tailnet.ts.net/ws?token=x');
    });

    it('keeps an explicit ws url and path', () => {
        expect(resolveWsUrl('ws://host:1/socket', 't')).toBe('ws://host:1/socket?token=t');
    });

    it('reads the token off a page query string', () => {
        expect(tokenFromLocation('?token=abc123')).toBe('abc123');
        expect(tokenFromLocation('?other=1')).toBeUndefined();
    });
});

describe('KelpiConnection handshake', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('sends hello as the first frame and settles on welcome', () => {
        const { connection, harness, statuses } = connectionWith();
        connection.connect();

        const socket = harness.last();
        expect(socket.url).toBe('ws://daemon.test:19470/ws?token=secret');
        expect(socket.sent).toHaveLength(0);

        socket.open();
        const hello = socket.messages()[0];
        expect(hello).toMatchObject({ type: 'hello', protocolVersion: 1, token: 'secret' });
        expect((hello?.['client'] as Record<string, unknown>)['kind']).toBe('browser');
        expect(connection.status).toBe('connecting');

        socket.emit({
            type: 'welcome',
            protocolVersion: 1,
            clientID: 'client-9',
            daemon: { version: '0.1.0', build: 'dev', pid: 77 }
        });

        expect(connection.status).toBe('connected');
        expect(connection.clientID).toBe('client-9');
        expect(connection.daemon).toEqual({ version: '0.1.0', build: 'dev', pid: 77 });
        expect(statuses).toEqual(['connecting', 'connected']);
    });

    it('queues messages sent before the handshake settles and flushes them after', () => {
        const { connection, harness } = connectionWith();
        connection.connect();

        expect(connection.send({ type: 'ping', id: 'early' })).toBe(false);
        harness.last().open();
        expect(harness.last().messages().map((m) => m['type'])).toEqual(['hello']);

        completeHandshake(harness.last(), { snapshot: false });
        expect(harness.last().messages().map((m) => m['type'])).toEqual(['hello', 'ping']);
    });

    it('emits snapshot and delta messages as typed events', () => {
        const { connection, harness } = connectionWith();
        const snapshots: number[] = [];
        const deltas: number[] = [];
        connection.on('snapshot', (message) => snapshots.push(message.seq));
        connection.on('delta', (message) => deltas.push(message.seq));

        connection.connect();
        completeHandshake(harness.last(), { seq: 4, state: emptySnapshotState() });
        harness.last().emit({ type: 'delta', seq: 5, events: [] });

        expect(snapshots).toEqual([4]);
        expect(deltas).toEqual([5]);
    });

    it('decodes binary PTY frames', () => {
        const { connection, harness } = connectionWith();
        const payloads: string[] = [];
        connection.on('frame', (frame) => {
            payloads.push(`${frame.type}:${frame.paneID}:${new TextDecoder().decode(frame.payload)}`);
        });

        connection.connect();
        completeHandshake(harness.last());
        const frame = encodePtyFrame(PTY_FRAME_TYPES.output, PANE, new TextEncoder().encode('hi'));
        harness.last().emitBinary(frame as Uint8Array);

        expect(payloads).toEqual([`${PTY_FRAME_TYPES.output}:${PANE.toUpperCase()}:hi`]);
    });
});

describe('KelpiConnection reconnection', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('redials with backoff and takes a fresh snapshot', () => {
        const { connection, harness, statuses } = connectionWith();
        const snapshots: number[] = [];
        connection.on('snapshot', (message) => snapshots.push(message.seq));

        connection.connect();
        completeHandshake(harness.last(), { seq: 1 });
        expect(harness.sockets).toHaveLength(1);

        harness.last().serverClose();
        expect(connection.status).toBe('reconnecting');
        expect(harness.sockets).toHaveLength(1);

        vi.advanceTimersByTime(100);
        expect(harness.sockets).toHaveLength(2);
        completeHandshake(harness.last(), { seq: 7 });

        expect(connection.status).toBe('connected');
        expect(snapshots).toEqual([1, 7]);
        expect(statuses).toEqual(['connecting', 'connected', 'reconnecting', 'connected']);
    });

    it('never resumes from a seq (the daemon cannot serve deltas across a restart)', () => {
        const { connection, harness } = connectionWith();
        connection.connect();
        completeHandshake(harness.last(), { seq: 3 });
        harness.last().serverClose();
        vi.advanceTimersByTime(100);
        harness.last().open();

        expect(harness.last().messages()[0]).not.toHaveProperty('resumeFromSeq');
    });

    it('backs off exponentially while the daemon stays down', () => {
        const { connection, harness } = connectionWith();
        connection.connect();
        harness.last().serverClose();

        vi.advanceTimersByTime(99);
        expect(harness.sockets).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(harness.sockets).toHaveLength(2);

        harness.last().serverClose();
        vi.advanceTimersByTime(199);
        expect(harness.sockets).toHaveLength(2);
        vi.advanceTimersByTime(1);
        expect(harness.sockets).toHaveLength(3);
    });

    it('stops retrying when the daemon rejects the handshake', () => {
        const { connection, harness } = connectionWith();
        const rejections: string[] = [];
        connection.on('rejected', (message) => rejections.push(message.code));

        connection.connect();
        harness.last().open();
        harness.last().emit({ type: 'rejected', code: 'unauthorized', message: 'token rejected', protocolVersion: 1 });
        harness.last().serverClose(4003, 'unauthorized');

        expect(rejections).toEqual(['unauthorized']);
        expect(connection.status).toBe('rejected');
        vi.advanceTimersByTime(10_000);
        expect(harness.sockets).toHaveLength(1);
    });

    it('surfaces the typed bad-token rejection verbatim and reports no socket error', () => {
        const { connection, harness } = connectionWith();
        const reasons: (string | undefined)[] = [];
        const errors: string[] = [];
        connection.on('rejected', (message) => reasons.push(message.reason));
        connection.on('error', (error) => errors.push(error.message));

        connection.connect();
        harness.last().open();
        harness.last().emit({
            type: 'rejected',
            code: 'unauthorized',
            reason: 'bad-token',
            message: "invalid or missing daemon token — open the client via 'kelpid url'",
            protocolVersion: 1
        });
        // A coded close in the app range, NOT the 1006 an aborted upgrade produced.
        harness.last().serverClose(4003, 'bad-token');

        expect(reasons).toEqual(['bad-token']);
        // The daemon's own words reach the UI unprefixed, and the clean close does not add a
        // spurious "socket closed (1006)" on top of the real explanation.
        expect(errors).toEqual(["invalid or missing daemon token — open the client via 'kelpid url'"]);
        expect(connection.status).toBe('rejected');
    });

    it('dials with no token at all, so a tokenless daemon can answer (and a gated one explain)', () => {
        const { connection, harness } = connectionWith({ token: undefined });
        connection.connect();

        // No `?token=` in the URL, and the hello carries an empty one — the connection is
        // attempted either way; the handshake is what decides.
        expect(harness.last().url).toBe('ws://daemon.test:19470/ws');
        harness.last().open();
        expect(harness.last().messages()[0]).toMatchObject({ type: 'hello', token: '' });
    });

    it('resync() drops the socket and redials immediately', () => {
        const { connection, harness } = connectionWith();
        connection.connect();
        completeHandshake(harness.last());

        connection.resync('gap');
        expect(harness.sockets).toHaveLength(2);
        expect(harness.sockets[0]?.closes[0]?.code).toBe(4000);
    });

    it('close() is final: no reconnect, status closed', () => {
        const { connection, harness } = connectionWith();
        connection.connect();
        completeHandshake(harness.last());

        connection.close();
        expect(connection.status).toBe('closed');
        vi.advanceTimersByTime(10_000);
        expect(harness.sockets).toHaveLength(1);
    });
});

describe('KelpiConnection heartbeat', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('pings when the socket goes quiet and reconnects when no pong comes back', () => {
        const { connection, harness } = connectionWith({
            heartbeatIntervalMs: 1000,
            heartbeatTimeoutMs: 500,
            now: () => Date.now()
        });
        connection.connect();
        completeHandshake(harness.last(), { snapshot: false });

        vi.advanceTimersByTime(1000);
        const ping = harness.last().lastOfType('ping');
        expect(ping).toBeDefined();

        // A pong keeps the connection alive.
        harness.last().emit({ type: 'pong', id: String(ping?.['id']) });
        vi.advanceTimersByTime(1000);
        expect(harness.sockets).toHaveLength(1);

        // Silence past the timeout redials.
        vi.advanceTimersByTime(2000);
        expect(harness.sockets.length).toBeGreaterThan(1);
    });
});
