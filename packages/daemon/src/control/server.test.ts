/// <reference types="node" />

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { WireMessage } from '@nex/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ControlDispatcher, ReplyHandle } from '../seams.js';
import { ControlSocketBusyError, createControlServer, dispatchWireLine, type ControlServer } from './server.js';

const PANE = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';

interface Recorded {
    readonly message: WireMessage;
    readonly reply: ReplyHandle | null;
}

interface Recorder {
    readonly calls: Recorded[];
    readonly dispatcher: ControlDispatcher;
}

/** Records every dispatch; `answer` decides what (if anything) a reply handle sends. */
function recorder(answer?: (message: WireMessage, reply: ReplyHandle) => void): Recorder {
    const calls: Recorded[] = [];
    const dispatcher: ControlDispatcher = (message, reply) => {
        calls.push({ message, reply });
        if (reply !== null) {
            if (answer === undefined) {
                reply.send({ ok: true, command: message.command });
                reply.close();
            } else {
                answer(message, reply);
            }
        }
    };
    return { calls, dispatcher };
}

function connect(target: { path: string } | { port: number }): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const socket = 'path' in target ? net.connect({ path: target.path }) : net.connect({ port: target.port, host: '127.0.0.1' });
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
    });
}

interface ReadResult {
    readonly text: string;
    /** True when the server closed the connection (the CLI's end-of-reply marker). */
    readonly eof: boolean;
}

/** Read until the server closes, or until `timeoutMs` elapses (used to prove silence). */
function readAll(socket: net.Socket, timeoutMs = 1000): Promise<ReadResult> {
    return new Promise((resolve) => {
        let text = '';
        const onData = (chunk: Buffer): void => {
            text += chunk.toString('utf8');
        };
        const finish = (eof: boolean): void => {
            clearTimeout(timer);
            socket.off('data', onData);
            socket.off('end', onEnd);
            socket.off('close', onClose);
            resolve({ text, eof });
        };
        const onEnd = (): void => finish(true);
        const onClose = (): void => finish(true);
        const timer = setTimeout(() => finish(false), timeoutMs);
        socket.on('data', onData);
        socket.once('end', onEnd);
        socket.once('close', onClose);
    });
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('control server', () => {
    let directory: string;
    let socketPath: string;
    const servers: ControlServer[] = [];
    const sockets: net.Socket[] = [];

    const startServer = async (dispatcher: ControlDispatcher, options: { tcpPort?: number } = {}): Promise<ControlServer> => {
        const server = createControlServer({
            socketPath,
            dispatcher,
            staleProbeTimeoutMs: 250,
            ...(options.tcpPort !== undefined ? { tcpPort: options.tcpPort } : {})
        });
        servers.push(server);
        await server.start();
        return server;
    };

    const client = async (): Promise<net.Socket> => {
        const socket = await connect({ path: socketPath });
        socket.on('error', () => undefined);
        sockets.push(socket);
        return socket;
    };

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexd-ctl-'));
        socketPath = path.join(directory, 'c.sock');
    });

    afterEach(async () => {
        for (const socket of sockets.splice(0)) socket.destroy();
        for (const server of servers.splice(0)) await server.stop();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    it('answers an allowlisted command with exactly one JSON line then EOF', async () => {
        const calls: Recorded[] = [];
        await startServer(recorderWith(calls));

        const socket = await client();
        socket.write('{"command":"ping"}\n');
        const result = await readAll(socket);

        expect(result.eof).toBe(true);
        expect(result.text.endsWith('\n')).toBe(true);
        expect(result.text.split('\n').filter((line) => line.length > 0)).toHaveLength(1);
        expect(JSON.parse(result.text)).toEqual({ ok: true, version: '9.9.9', build: '42', pid: process.pid });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.message.command).toBe('ping');
        expect(calls[0]?.reply).not.toBeNull();
    });

    it('never writes a byte for a fire-and-forget command and leaves the connection open', async () => {
        const rec = recorder();
        await startServer(rec.dispatcher);

        const socket = await client();
        socket.write(`{"command":"stop","pane_id":"${PANE}"}\n`);
        const result = await readAll(socket, 200);

        expect(result.text).toBe('');
        expect(result.eof).toBe(false);
        expect(socket.destroyed).toBe(false);
        expect(rec.calls).toHaveLength(1);
        expect(rec.calls[0]?.message.command).toBe('stop');
        expect(rec.calls[0]?.reply).toBeNull();
    });

    it('answers a malformed but allowlisted command with ok:false (PLAN deliberate fix)', async () => {
        const rec = recorder();
        await startServer(rec.dispatcher);

        const socket = await client();
        // pane-send is allowlisted; it requires a non-empty `text`.
        socket.write('{"command":"pane-send","target":"worker"}\n');
        const result = await readAll(socket);

        expect(result.eof).toBe(true);
        const reply = JSON.parse(result.text) as { ok: boolean; error: string };
        expect(reply.ok).toBe(false);
        expect(reply.error).toContain('text');
        expect(rec.calls).toHaveLength(0);
    });

    it('answers a type-poisoned allowlisted command and stays silent for a poisoned F&F one', async () => {
        const rec = recorder();
        await startServer(rec.dispatcher);

        const bad = await client();
        // `bare` must be a JSON boolean: the wrong type poisons the whole line (§2.2).
        bad.write(`{"command":"pane-send","target":"worker","text":"hi","bare":"true"}\n`);
        const answered = await readAll(bad);
        expect(answered.eof).toBe(true);
        expect((JSON.parse(answered.text) as { ok: boolean }).ok).toBe(false);

        const silent = await client();
        silent.write(`{"command":"stop","pane_id":"${PANE}","background_tasks":"2"}\n`);
        const quiet = await readAll(silent, 200);
        expect(quiet.text).toBe('');
        expect(quiet.eof).toBe(false);
        expect(rec.calls).toHaveLength(0);
    });

    it('answers only the first of two pipelined request/response lines', async () => {
        const rec = recorder();
        await startServer(rec.dispatcher);

        const socket = await client();
        socket.write('{"command":"ping"}\n{"command":"group-list"}\n');
        const result = await readAll(socket);

        // The first close() tears the FD down and orphans the rest (§8 invariant 10).
        expect(result.eof).toBe(true);
        expect(result.text.split('\n').filter((line) => line.length > 0)).toHaveLength(1);
        expect(rec.calls.map((call) => call.message.command)).toEqual(['ping', 'group-list']);
    });

    it('silently drops a malformed fire-and-forget command', async () => {
        const rec = recorder();
        await startServer(rec.dispatcher);

        const socket = await client();
        socket.write('{"command":"stop"}\n'); // missing the mandatory pane_id
        const result = await readAll(socket, 200);

        expect(result.text).toBe('');
        expect(result.eof).toBe(false);
        expect(rec.calls).toHaveLength(0);
    });

    it('silently drops undecodable lines and unknown commands', async () => {
        const rec = recorder();
        await startServer(rec.dispatcher);

        const socket = await client();
        socket.write('this is not json\n{"command":"no-such-command"}\n[]\n');
        const result = await readAll(socket, 200);

        expect(result.text).toBe('');
        expect(result.eof).toBe(false);
        expect(rec.calls).toHaveLength(0);
    });

    it('reassembles a request split across reads (the 4096-byte drop bug)', async () => {
        const rec = recorder();
        await startServer(rec.dispatcher);

        const socket = await client();
        const script = 'x'.repeat(20_000);
        const line = JSON.stringify({ command: 'web-exec', pane_id: PANE, script });
        socket.write(line.slice(0, 100));
        await delay(20);
        socket.write(line.slice(100, 8000));
        await delay(20);
        socket.write(line.slice(8000));
        await delay(20);
        socket.write('\n');

        const result = await readAll(socket);
        expect(result.eof).toBe(true);
        expect(JSON.parse(result.text)).toEqual({ ok: true, command: 'web-exec' });
        expect(rec.calls).toHaveLength(1);
        const message = rec.calls[0]?.message as { command: string; script?: string };
        expect(message.script).toHaveLength(20_000);
    });

    it('dispatches every line of one chunk in wire order', async () => {
        const rec = recorder();
        await startServer(rec.dispatcher);

        const socket = await client();
        socket.write(
            `{"command":"start","pane_id":"${PANE}"}\n` +
                `{"command":"error","pane_id":"${PANE}","message":"boom"}\n` +
                `{"command":"layout-cycle","pane_id":"${PANE}"}\n`
        );
        await readAll(socket, 200);

        expect(rec.calls.map((call) => call.message.command)).toEqual(['start', 'error', 'layout-cycle']);
    });

    it('dual-fires session-start after the primary message, with no reply handle', async () => {
        const rec = recorder();
        await startServer(rec.dispatcher);

        const socket = await client();
        socket.write(`{"command":"stop","pane_id":"${PANE}","session_id":"sess-1","agent":"codex"}\n`);
        await readAll(socket, 200);

        expect(rec.calls.map((call) => call.message.command)).toEqual(['stop', 'session-start']);
        expect(rec.calls.every((call) => call.reply === null)).toBe(true);
        expect(rec.calls[1]?.message).toEqual({
            command: 'session-start',
            pane_id: PANE,
            session_id: 'sess-1',
            agent: 'codex'
        });
    });

    it('excludes session-end from the dual-fire', async () => {
        const rec = recorder();
        await startServer(rec.dispatcher);

        const socket = await client();
        socket.write(`{"command":"session-end","pane_id":"${PANE}","session_id":"sess-1"}\n`);
        await readAll(socket, 200);

        expect(rec.calls.map((call) => call.message.command)).toEqual(['session-end']);
    });

    it('allocates a handle for an allowlisted primary but never for its dual-fire', async () => {
        const rec = recorder();
        await startServer(rec.dispatcher);

        const socket = await client();
        socket.write(`{"command":"pane-list","pane_id":"${PANE}","session_id":"sess-2"}\n`);
        const result = await readAll(socket);

        expect(rec.calls.map((call) => call.message.command)).toEqual(['pane-list', 'session-start']);
        expect(rec.calls[0]?.reply).not.toBeNull();
        expect(rec.calls[1]?.reply).toBeNull();
        expect(result.text.split('\n').filter((line) => line.length > 0)).toHaveLength(1);
    });

    it('keeps a follow stream open and fires onDisconnect when the peer goes away', async () => {
        let disconnected = false;
        let resolveDisconnect: () => void = () => undefined;
        const disconnect = new Promise<void>((resolve) => {
            resolveDisconnect = resolve;
        });
        let followHandle: ReplyHandle | null = null;

        const dispatcher: ControlDispatcher = (message, reply) => {
            if (reply === null) return;
            followHandle = reply;
            reply.send({ ok: true, entries: [] });
            reply.send({ ok: true, entry: 'live-line' });
            reply.onDisconnect(() => {
                disconnected = true;
                resolveDisconnect();
            });
            void message;
        };
        await startServer(dispatcher);

        const socket = await client();
        socket.write(`{"command":"web-console","pane_id":"${PANE}","follow":true}\n`);
        const result = await readAll(socket, 250);

        expect(result.eof).toBe(false); // still streaming
        expect(result.text.split('\n').filter((line) => line.length > 0)).toHaveLength(2);
        expect(disconnected).toBe(false);

        socket.destroy();
        await disconnect;
        expect(disconnected).toBe(true);
        expect((followHandle as ReplyHandle | null)?.closed).toBe(true);
    });

    it('tolerates a client that vanishes before the reply is written', async () => {
        const late: ReplyHandle[] = [];
        const dispatcher: ControlDispatcher = (_message, reply) => {
            if (reply !== null) late.push(reply);
        };
        const server = await startServer(dispatcher);

        const socket = await client();
        socket.write('{"command":"ping"}\n');
        await delay(30);
        socket.destroy();
        await delay(50);

        const handle = late[0] as ReplyHandle;
        expect(() => {
            handle.send({ ok: true });
            handle.close();
        }).not.toThrow();
        expect(handle.closed).toBe(true);

        // The server is still healthy after the EPIPE-ish teardown.
        const second = await client();
        second.write('{"command":"ping"}\n');
        await delay(50);
        expect(server.running).toBe(true);
        expect(late).toHaveLength(2);
    });

    it('serves the same protocol over a loopback TCP port', async () => {
        const rec = recorder();
        const server = await startServer(rec.dispatcher, { tcpPort: 0 });
        const port = server.tcpPort;
        expect(typeof port).toBe('number');

        const socket = await connect({ port: port as number });
        sockets.push(socket);
        socket.write('{"command":"ping"}\n');
        const result = await readAll(socket);

        expect(result.eof).toBe(true);
        expect(JSON.parse(result.text)).toEqual({ ok: true, command: 'ping' });
    });

    it('refuses a non-loopback TCP host', () => {
        expect(() =>
            createControlServer({ socketPath, tcpPort: 0, tcpHost: '0.0.0.0', dispatcher: () => undefined })
        ).toThrow(/loopback-only/);
    });

    it('refuses to start when a live daemon already answers ping on the socket', async () => {
        const first = await startServer(recorder().dispatcher);
        expect(first.running).toBe(true);

        const second = createControlServer({ socketPath, dispatcher: () => undefined, staleProbeTimeoutMs: 500 });
        servers.push(second);
        await expect(second.start()).rejects.toBeInstanceOf(ControlSocketBusyError);
        expect(second.running).toBe(false);

        // The incumbent still owns the socket.
        const socket = await client();
        socket.write('{"command":"ping"}\n');
        const result = await readAll(socket);
        expect(result.eof).toBe(true);
    });

    it('unlinks a stale socket file and binds over it', async () => {
        fs.writeFileSync(socketPath, 'not a socket');
        const rec = recorder();
        await startServer(rec.dispatcher);

        const socket = await client();
        socket.write('{"command":"ping"}\n');
        const result = await readAll(socket);
        expect(result.eof).toBe(true);
        expect(rec.calls).toHaveLength(1);
    });

    it('takes over a socket whose owner accepts but never answers ping', async () => {
        const squatter = net.createServer((connection) => connection.destroy());
        await new Promise<void>((resolve) => squatter.listen({ path: socketPath }, resolve));

        const rec = recorder();
        await startServer(rec.dispatcher);

        const socket = await client();
        socket.write('{"command":"ping"}\n');
        const result = await readAll(socket);
        expect(result.eof).toBe(true);
        expect(rec.calls).toHaveLength(1);

        // Closed last: libuv unlinks a pipe's path on close, which would take our socket
        // file with it if the squatter went away mid-test.
        await new Promise<void>((resolve) => squatter.close(() => resolve()));
    });

    it('unlinks the socket on stop, but only the one it bound', async () => {
        const server = await startServer(recorder().dispatcher);
        expect(fs.existsSync(socketPath)).toBe(true);
        await server.stop();
        expect(fs.existsSync(socketPath)).toBe(false);

        // A second stop of a server that never bound must not delete someone else's file.
        fs.writeFileSync(socketPath, 'someone else');
        const idle = createControlServer({ socketPath, dispatcher: () => undefined });
        await idle.stop();
        expect(fs.existsSync(socketPath)).toBe(true);
    });

    it('drops connections and stops listening on stop()', async () => {
        const server = await startServer(recorder().dispatcher);
        const socket = await client();
        expect(server.connections).toBe(1);
        const clientClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
        await server.stop();
        expect(server.connections).toBe(0);
        await clientClosed; // the peer's FD went away with the listener
        expect(socket.destroyed).toBe(true);
        await expect(connect({ path: socketPath })).rejects.toBeTruthy();
    });
});

/** A recorder whose ping reply carries version fields (used by the first test). */
function recorderWith(calls: Recorded[]): ControlDispatcher {
    return (message, reply) => {
        calls.push({ message, reply });
        if (reply !== null) {
            reply.send({ ok: true, version: '9.9.9', build: '42', pid: process.pid });
            reply.close();
        }
    };
}

describe('dispatchWireLine policy', () => {
    it('reports handler throws instead of propagating them', () => {
        const errors: string[] = [];
        dispatchWireLine(`{"command":"start","pane_id":"${PANE}"}`, {
            dispatcher: () => {
                throw new Error('handler exploded');
            },
            allocateReply: () => {
                throw new Error('must not allocate a handle for a fire-and-forget command');
            },
            onError: (error, context) => errors.push(`${context}: ${error.message}`)
        });
        expect(errors).toEqual(['dispatch start: handler exploded']);
    });

    it('never allocates a handle for an undecodable line', () => {
        let allocations = 0;
        dispatchWireLine('{"command":', {
            dispatcher: () => {
                throw new Error('must not dispatch');
            },
            allocateReply: () => {
                allocations += 1;
                throw new Error('unreachable');
            }
        });
        expect(allocations).toBe(0);
    });
});
