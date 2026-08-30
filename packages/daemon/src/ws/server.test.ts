import {
    PTY_FRAME_TYPES,
    WS_PROTOCOL_VERSION,
    decodePtyFrame,
    encodeAckPayload,
    encodePtyFrame
} from '@kelpi/protocol';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import type { ControlDispatcher } from '../seams.js';
import { harness as storeHarness, seededState, W1 } from '../store/testing.js';
import { createWsServer, type WsServer } from './server.js';
import { WS_CLOSE_CODES } from './sync.js';
import { PANE_A, bytes, stubPty, stubTerm, textOf, type StubPty, type StubTerm } from './testing.js';

const TOKEN = 'test-token-abcdef';
const VERSION = { version: '0.1.0', build: '42', protocol: WS_PROTOCOL_VERSION };

interface Fixture {
    readonly server: WsServer;
    readonly store: ReturnType<typeof storeHarness>;
    readonly pty: StubPty;
    readonly term: StubTerm;
    readonly commands: string[];
    readonly base: string;
}

const running: WsServer[] = [];
const openSockets: WebSocket[] = [];
const temporaries: string[] = [];

afterEach(async () => {
    for (const socket of openSockets.splice(0)) {
        socket.removeAllListeners();
        socket.close();
    }
    for (const server of running.splice(0)) await server.stop();
    while (temporaries.length > 0) {
        fs.rmSync(temporaries.pop() as string, { recursive: true, force: true });
    }
});

async function startServer(
    options: { distDir?: string; token?: string; helloTimeoutMs?: number } = {}
): Promise<Fixture> {
    const store = storeHarness(seededState(W1, PANE_A));
    const pty = stubPty();
    const term = stubTerm();
    const commands: string[] = [];
    const dispatcher: ControlDispatcher = (message, reply) => {
        commands.push(message.command);
        reply?.send({ ok: true, command: message.command });
        reply?.close();
    };

    const server = createWsServer({
        store: store.store,
        dispatcher,
        pty: pty.manager,
        term: term.service,
        version: VERSION,
        host: '127.0.0.1',
        port: 0,
        token: options.token ?? TOKEN,
        ...(options.distDir !== undefined ? { distDir: options.distDir } : {}),
        ...(options.helloTimeoutMs !== undefined ? { helloTimeoutMs: options.helloTimeoutMs } : {})
    });
    running.push(server);
    const addresses = await server.start();
    const address = addresses[0];
    if (address === undefined) throw new Error('server did not bind');
    return { server, store, pty, term, commands, base: `http://127.0.0.1:${address.port}` };
}

interface Client {
    readonly socket: WebSocket;
    readonly json: Record<string, unknown>[];
    readonly frames: { type: number; paneID: string; text: string }[];
    send(message: Record<string, unknown>): void;
    sendFrame(frame: Uint8Array): void;
    waitForJson(predicate: (message: Record<string, unknown>) => boolean, label?: string): Promise<Record<string, unknown>>;
    waitForFrame(
        predicate: (frame: { type: number; paneID: string; text: string }) => boolean,
        label?: string
    ): Promise<{ type: number; paneID: string; text: string }>;
    close(): void;
}

function connect(base: string, query = `?token=${TOKEN}`, headers?: Record<string, string>): Promise<Client> {
    const url = `${base.replace('http://', 'ws://')}/ws${query}`;
    const socket = headers === undefined ? new WebSocket(url) : new WebSocket(url, { headers });
    openSockets.push(socket);
    const json: Record<string, unknown>[] = [];
    const frames: { type: number; paneID: string; text: string }[] = [];

    socket.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
            const decoded = decodePtyFrame(new Uint8Array(data));
            if (decoded !== undefined) {
                frames.push({ type: decoded.type as number, paneID: decoded.paneID, text: textOf(decoded.payload) });
            }
            return;
        }
        json.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>);
    });

    const waitUntil = async <T>(read: () => T | undefined, label: string): Promise<T> => {
        const deadline = Date.now() + 2000;
        for (;;) {
            const found = read();
            if (found !== undefined) return found;
            if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    };

    const client: Client = {
        socket,
        json,
        frames,
        send(message) {
            socket.send(JSON.stringify(message));
        },
        sendFrame(frame) {
            socket.send(frame, { binary: true });
        },
        waitForJson: (predicate, label = 'json message') => waitUntil(() => json.find(predicate), label),
        waitForFrame: (predicate, label = 'pty frame') => waitUntil(() => frames.find(predicate), label),
        close() {
            socket.close();
        }
    };

    return new Promise<Client>((resolve, reject) => {
        socket.once('open', () => resolve(client));
        socket.once('error', reject);
    });
}

async function handshake(base: string): Promise<Client> {
    const client = await connect(base);
    client.send({
        type: 'hello',
        protocolVersion: WS_PROTOCOL_VERSION,
        token: TOKEN,
        client: { kind: 'browser', name: 'kelpi-web' }
    });
    await client.waitForJson((message) => message['type'] === 'snapshot', 'snapshot');
    return client;
}

function clientDist(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpid-ws-server-'));
    temporaries.push(dir);
    for (const [name, contents] of Object.entries(files)) {
        const target = path.join(dir, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents);
    }
    return dir;
}

describe('http surface', () => {
    it('serves /healthz and the client build over a real socket', async () => {
        const dist = clientDist({ 'index.html': 'SHELL', 'assets/app.js': 'console.log(1)' });
        const f = await startServer({ distDir: dist });

        const health = await fetch(`${f.base}/healthz`);
        expect(health.status).toBe(200);
        expect(await health.json()).toMatchObject({ ok: true, version: '0.1.0', protocol: WS_PROTOCOL_VERSION });

        const shell = await fetch(`${f.base}/workspaces/anything`);
        expect(await shell.text()).toBe('SHELL');

        const asset = await fetch(`${f.base}/assets/app.js`);
        expect(asset.headers.get('content-type')).toContain('text/javascript');
    });

    it('serves the "client not built" page when there is no build', async () => {
        const f = await startServer();
        const response = await fetch(`${f.base}/`);
        expect(response.headers.get('x-kelpi-client')).toBe('not-built');
    });
});

describe('upgrade auth', () => {
    /** Open a socket, send `hello`, and report what came back — welcome or rejection. */
    async function helloWith(
        base: string,
        query: string,
        token: string | undefined,
        headers?: Record<string, string>
    ): Promise<{ client: Client; first: Record<string, unknown>; closeCode: number }> {
        const client = await connect(base, query, headers);
        const closed = new Promise<number>((resolve) => client.socket.once('close', (code) => resolve(code)));
        client.send({
            type: 'hello',
            protocolVersion: WS_PROTOCOL_VERSION,
            ...(token === undefined ? {} : { token }),
            client: { kind: 'browser', name: 'kelpi-web' }
        });
        const first = await client.waitForJson(
            (message) => message['type'] === 'rejected' || message['type'] === 'welcome',
            'welcome or rejection'
        );
        // A rejection closes; a welcome does not, so only wait for the close when refused.
        const closeCode = first['type'] === 'rejected' ? await closed : 0;
        return { client, first, closeCode };
    }

    it('upgrades a tokenless browser, then rejects its hello with a reason and a clean close', async () => {
        const f = await startServer();
        // The bug this replaces: the upgrade 401'd, the browser saw only close 1006, and the
        // client retried with backoff forever with nothing to show the user.
        const { first, closeCode } = await helloWith(f.base, '', '');
        expect(first).toMatchObject({ type: 'rejected', code: 'unauthorized', reason: 'bad-token' });
        expect(String(first['message'])).toContain('kelpid url');
        expect(closeCode).toBe(WS_CLOSE_CODES.unauthorized);
        expect(closeCode).not.toBe(1006);
    });

    it('upgrades a wrong-token browser, then rejects its hello the same way', async () => {
        const f = await startServer();
        const { first, closeCode } = await helloWith(f.base, '?token=wrong', 'wrong');
        expect(first).toMatchObject({ type: 'rejected', code: 'unauthorized', reason: 'bad-token' });
        expect(closeCode).toBe(WS_CLOSE_CODES.unauthorized);
    });

    it('lets a valid query token through unchanged', async () => {
        const f = await startServer();
        const { first } = await helloWith(f.base, `?token=${TOKEN}`, TOKEN);
        expect(first).toMatchObject({ type: 'welcome', protocolVersion: WS_PROTOCOL_VERSION });
    });

    it('refuses a hello whose token is wrong even when the upgrade was authenticated', async () => {
        const f = await startServer();
        // An authenticated upgrade must not launder a bogus hello token.
        const { first, closeCode } = await helloWith(f.base, `?token=${TOKEN}`, 'wrong');
        expect(first).toMatchObject({ type: 'rejected', reason: 'bad-token' });
        expect(closeCode).toBe(WS_CLOSE_CODES.unauthorized);
    });

    it('refuses an upgrade on an unknown path', async () => {
        const f = await startServer();
        const socket = new WebSocket(`${f.base.replace('http://', 'ws://')}/nope?token=${TOKEN}`);
        openSockets.push(socket);
        await expect(
            new Promise((resolve, reject) => {
                socket.once('open', resolve);
                socket.once('error', reject);
            })
        ).rejects.toThrow(/404/);
    });

    it('accepts a bearer token header', async () => {
        const f = await startServer();
        const socket = new WebSocket(`${f.base.replace('http://', 'ws://')}/ws`, {
            headers: { authorization: `Bearer ${TOKEN}` }
        });
        openSockets.push(socket);
        await new Promise<void>((resolve, reject) => {
            socket.once('open', () => resolve());
            socket.once('error', reject);
        });
        expect(socket.readyState).toBe(WebSocket.OPEN);
    });

    // ── Electron shell compatibility (packages/shell) ───────────────────────────────
    //
    // Both shell sockets (`shell/src/status.ts`, `shell/src/webhost/client.ts`) authenticate
    // the UPGRADE with a bearer header and also repeat the token in their hello. Case 1 is
    // what they actually do; case 2 pins the exemption they would fall back on if one of them
    // ever stopped sending it, which is why the hello gate cannot simply demand a token.

    it('welcomes a bearer-authenticated shell whose hello carries the token', async () => {
        const f = await startServer();
        const { first } = await helloWith(f.base, '', TOKEN, { authorization: `Bearer ${TOKEN}` });
        expect(first).toMatchObject({ type: 'welcome' });
    });

    it('welcomes a bearer-authenticated shell whose hello omits the token', async () => {
        const f = await startServer();
        const { first } = await helloWith(f.base, '', undefined, { authorization: `Bearer ${TOKEN}` });
        expect(first).toMatchObject({ type: 'welcome' });
    });

    it('closes a connection that never says hello', async () => {
        const f = await startServer({ helloTimeoutMs: 120 });
        const client = await connect(f.base, '');
        const closed = new Promise<number>((resolve) => client.socket.once('close', (code) => resolve(code)));
        const rejection = await client.waitForJson((message) => message['type'] === 'rejected', 'timeout rejection');
        expect(rejection).toMatchObject({ reason: 'hello-timeout' });
        expect(await closed).toBe(WS_CLOSE_CODES.serverError);
    });

    it('ignores binary frames from a connection that has not helloed', async () => {
        const f = await startServer();
        const client = await connect(f.base, '');
        // An anonymous socket must not reach a PTY: the input frame is dropped, and the
        // JSON channel answers the hello-first rule instead.
        client.sendFrame(encodePtyFrame(PTY_FRAME_TYPES.input, PANE_A, bytes('rm -rf /\r')) as Uint8Array);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(f.pty.writes).toEqual([]);
    });
});

describe('state sync over a real socket', () => {
    it('handshakes, snapshots, then streams deltas in order', async () => {
        const f = await startServer();
        const client = await handshake(f.base);

        expect(client.json[0]).toMatchObject({ type: 'welcome', protocolVersion: WS_PROTOCOL_VERSION });
        const snapshot = client.json[1] as Record<string, unknown>;
        expect(snapshot['seq']).toBe(0);

        f.store.dispatch({ type: 'rename-workspace', id: W1, name: 'alpha' });
        f.store.dispatch({ type: 'rename-workspace', id: W1, name: 'beta' });

        await client.waitForJson((message) => message['type'] === 'delta' && message['seq'] === 2, 'second delta');
        const deltas = client.json.filter((message) => message['type'] === 'delta');
        expect(deltas.map((delta) => delta['seq'])).toEqual([1, 2]);
        const names = deltas.map((delta) => {
            const events = delta['events'] as Record<string, unknown>[];
            return (events[0]?.['workspace'] as Record<string, unknown>)['name'];
        });
        expect(names).toEqual(['alpha', 'beta']);
    });

    it('rejects a protocol mismatch and closes the socket', async () => {
        const f = await startServer();
        const client = await connect(f.base);
        const closed = new Promise<number>((resolve) => client.socket.once('close', (code) => resolve(code)));
        client.send({ type: 'hello', protocolVersion: 999, token: TOKEN, client: { kind: 'browser' } });
        const rejection = await client.waitForJson((message) => message['type'] === 'rejected', 'rejection');
        expect(rejection['code']).toBe('protocol-mismatch');
        expect(await closed).toBe(4001);
    });

    it('routes a focus report into the store', async () => {
        const f = await startServer();
        const client = await handshake(f.base);
        // The seeded workspace already focuses its only pane, so report "nothing focused"
        // to prove the report actually reaches the daemon-canonical focus state.
        expect(f.store.state().workspaces[0]?.focusedPaneID).toBe(PANE_A);
        client.send({ type: 'focus-report', workspaceID: W1, paneID: null });

        const delta = await client.waitForJson((message) => message['type'] === 'delta', 'focus delta');
        const events = delta['events'] as Record<string, unknown>[];
        expect(events.some((event) => event['kind'] === 'focus-changed')).toBe(true);
        expect(f.store.state().workspaces[0]?.focusedPaneID).toBeNull();
    });

    it('answers commands with a command-reply', async () => {
        const f = await startServer();
        const client = await handshake(f.base);
        client.send({ type: 'command', id: 'x1', payload: { command: 'ping' } });
        const reply = await client.waitForJson((message) => message['type'] === 'command-reply', 'command reply');
        expect(reply).toMatchObject({ id: 'x1', reply: { ok: true, command: 'ping' } });
        expect(f.commands).toEqual(['ping']);
    });
});

describe('pty streams over a real socket', () => {
    it('replays on attach, streams live output, and forwards input', async () => {
        const f = await startServer();
        f.term.setSnapshot(PANE_A, 'REPLAYED');
        const client = await handshake(f.base);

        client.send({ type: 'attach-pane', paneID: PANE_A, cols: 100, rows: 30 });
        const replay = await client.waitForFrame((frame) => frame.type === PTY_FRAME_TYPES.replay, 'replay frame');
        expect(replay).toEqual({ type: PTY_FRAME_TYPES.replay, paneID: PANE_A, text: 'REPLAYED' });
        expect(f.pty.resizes.at(-1)).toEqual({ paneID: PANE_A, cols: 100, rows: 30 });

        f.pty.emit(PANE_A, 'live output');
        const output = await client.waitForFrame((frame) => frame.type === PTY_FRAME_TYPES.output, 'output frame');
        expect(output.text).toBe('live output');

        client.sendFrame(encodePtyFrame(PTY_FRAME_TYPES.input, PANE_A, bytes('echo hi\r')) as Uint8Array);
        const deadline = Date.now() + 2000;
        while (f.pty.writes.length === 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(f.pty.writes).toEqual([{ paneID: PANE_A, data: 'echo hi\r' }]);

        // Acks keep the window open; the stream stays live afterwards.
        client.sendFrame(encodePtyFrame(PTY_FRAME_TYPES.ack, PANE_A, encodeAckPayload(64)) as Uint8Array);
        f.pty.emit(PANE_A, 'more');
        await client.waitForFrame((frame) => frame.text === 'more', 'post-ack output');
    });

    it('detaches when the client goes away', async () => {
        const f = await startServer();
        const client = await handshake(f.base);
        client.send({ type: 'attach-pane', paneID: PANE_A, cols: 80, rows: 24 });
        await client.waitForFrame((frame) => frame.type === PTY_FRAME_TYPES.replay, 'replay frame');
        expect(f.server.streams.attachedPaneIDs()).toEqual([PANE_A]);

        client.close();
        const deadline = Date.now() + 2000;
        while (f.server.streams.attachedPaneIDs().length > 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(f.server.streams.attachedPaneIDs()).toEqual([]);
        expect(f.server.clients).toBe(0);
    });
});

describe('bind addresses', () => {
    it('keeps loopback up when an extra bind address is unavailable', async () => {
        const store = storeHarness(seededState(W1, PANE_A));
        const pty = stubPty();
        const term = stubTerm();
        const errors: string[] = [];
        const server = createWsServer({
            store: store.store,
            dispatcher: () => {},
            pty: pty.manager,
            term: term.service,
            version: VERSION,
            host: '127.0.0.1',
            port: 0,
            token: TOKEN,
            // TEST-NET-1: guaranteed not to be a local interface.
            extraHosts: ['192.0.2.1'],
            onError: (_error, context) => errors.push(context)
        });
        running.push(server);

        const addresses = await server.start();
        expect(addresses).toHaveLength(1);
        expect(addresses[0]?.host).toBe('127.0.0.1');
        expect(errors).toContain('bind 192.0.2.1');
        expect(server.urls[0]).toBe(`http://127.0.0.1:${addresses[0]?.port}`);

        const health = await fetch(`http://127.0.0.1:${addresses[0]?.port}/healthz`);
        expect(health.status).toBe(200);
    });
});

describe('shutdown', () => {
    it('closes client sockets and stops listening', async () => {
        const f = await startServer();
        const client = await handshake(f.base);
        const closed = new Promise<void>((resolve) => client.socket.once('close', () => resolve()));

        await f.server.stop();
        await closed;

        await expect(fetch(`${f.base}/healthz`)).rejects.toThrow();
    });
});
