/**
 * The host's own daemon connection (`./client.ts`).
 *
 * The live smoke proves the handshake against a real daemon; what is worth pinning here is the
 * behaviour that only shows up in the unhappy paths, where a bug is silent: an RPC that is never
 * answered turns into the daemon's `web pane host did not answer …` for whoever is at the other
 * end of the CLI, and a revoke that is ignored leaves two shells driving the same pages.
 *
 * The `ws` socket is replaced through the module's `socketFactory` seam — no daemon, no ports.
 */

import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WS_PROTOCOL_VERSION, type JsonObject } from '@nex/protocol';

import type { DaemonLocation } from '../daemon.js';
import { setLogStreams } from '../log.js';
import { createWebHostClient, type WebHostClient } from './client.js';

type Handler = (...args: unknown[]) => void;

/** A daemon the client never actually dials (the socket factory is faked). */
function location(url: string, token: string): DaemonLocation {
    return {
        paths: { dir: '/tmp/none', protocol: 1, socket: '/tmp/none/d.sock', token: '/tmp/none/d.token', pid: '/tmp/none/d.pid' },
        url,
        port: Number(url.split(':')[2] ?? 0),
        token,
        pid: 1,
        spawned: false
    };
}

/** The slice of `ws` the client actually uses. */
class FakeSocket {
    readonly sent: JsonObject[] = [];
    readyState: number = WebSocket.OPEN;
    closed = false;
    private readonly handlers = new Map<string, Handler[]>();

    on(event: string, handler: Handler): this {
        const list = this.handlers.get(event) ?? [];
        list.push(handler);
        this.handlers.set(event, list);
        return this;
    }

    removeAllListeners(): this {
        this.handlers.clear();
        return this;
    }

    send(raw: string): void {
        this.sent.push(JSON.parse(raw) as JsonObject);
    }

    close(): void {
        this.closed = true;
    }

    emit(event: string, ...args: unknown[]): void {
        for (const handler of [...(this.handlers.get(event) ?? [])]) handler(...args);
    }

    /** One frame from the daemon. */
    deliver(message: JsonObject): void {
        this.emit('message', JSON.stringify(message), false);
    }

    frames(type: string): JsonObject[] {
        return this.sent.filter((message) => message['type'] === type);
    }
}

interface Harness {
    readonly client: WebHostClient;
    readonly sockets: FakeSocket[];
    readonly calls: { verb: string; args: JsonObject }[];
    readonly notifies: { verb: string; args: JsonObject }[];
    readonly revoked: string[];
    readonly registrations: { hostID: string; superseded: boolean }[];
    latest(): FakeSocket;
}

function harness(
    overrides: {
        call?: (verb: string, args: JsonObject) => Promise<JsonObject>;
        notify?: (verb: string, args: JsonObject) => void;
        windowID?: string;
    } = {}
): Harness {
    const sockets: FakeSocket[] = [];
    const calls: { verb: string; args: JsonObject }[] = [];
    const notifies: { verb: string; args: JsonObject }[] = [];
    const revoked: string[] = [];
    const registrations: { hostID: string; superseded: boolean }[] = [];

    const client = createWebHostClient({
        location: location('http://127.0.0.1:4242', 'tok'),
        name: 'test-shell',
        version: '9.9.9',
        ...(overrides.windowID === undefined ? {} : { windowID: overrides.windowID }),
        call: (verb, args) => {
            calls.push({ verb, args });
            return overrides.call?.(verb, args) ?? Promise.resolve({ ok: true, verb });
        },
        notify: (verb, args) => {
            notifies.push({ verb, args });
            overrides.notify?.(verb, args);
        },
        onRegistered: (hostID, superseded) => registrations.push({ hostID, superseded }),
        onRevoked: (reason) => revoked.push(reason),
        socketFactory: () => {
            const socket = new FakeSocket();
            sockets.push(socket);
            return socket as unknown as WebSocket;
        },
        random: () => 0.5
    });

    return {
        client,
        sockets,
        calls,
        notifies,
        revoked,
        registrations,
        latest: () => sockets[sockets.length - 1] as FakeSocket
    };
}

/** Connect + complete the handshake, leaving the client registered. */
function connected(overrides?: Parameters<typeof harness>[0]): Harness {
    const test = harness(overrides);
    test.client.start();
    test.latest().emit('open');
    test.latest().deliver({ type: 'welcome', protocolVersion: WS_PROTOCOL_VERSION, clientID: 'c1' });
    test.latest().deliver({ type: 'host-registered', role: 'web-pane', hostID: 'H1', superseded: false });
    return test;
}

beforeEach(() => {
    const sink = { write: () => true };
    setLogStreams({ out: sink, err: sink });
});

afterEach(() => {
    vi.useRealTimers();
    setLogStreams({ out: process.stdout, err: process.stderr });
});

describe('handshake', () => {
    it('claims the host role in the hello, so there is no window with a client and no host', () => {
        const test = harness();
        test.client.start();
        test.latest().emit('open');
        const hello = test.latest().frames('hello')[0];
        expect(hello?.['protocolVersion']).toBe(WS_PROTOCOL_VERSION);
        expect(hello?.['token']).toBe('tok');
        expect((hello?.['client'] as JsonObject)['capabilities']).toEqual(['web-pane-host']);
        expect(test.client.registered).toBe(false);
    });

    it('declares the shell window it renders into, when it has one', () => {
        const test = harness({ windowID: 'WIN-1' });
        test.client.start();
        test.latest().emit('open');
        const client = test.latest().frames('hello')[0]?.['client'] as JsonObject;
        // Both halves matter: the capability claims the role, the window id is what makes a
        // geometry report from the UI in that same window addressable back to this host.
        expect(client['capabilities']).toEqual(['web-pane-host']);
        expect(client['windowID']).toBe('WIN-1');
    });

    it('omits the window id entirely for a host with no window', () => {
        const test = harness();
        test.client.start();
        test.latest().emit('open');
        const client = test.latest().frames('hello')[0]?.['client'] as JsonObject;
        expect('windowID' in client).toBe(false);
    });

    it('reports the registration (and whether it took a role off another shell)', () => {
        const test = harness();
        test.client.start();
        test.latest().emit('open');
        test.latest().deliver({ type: 'host-registered', role: 'web-pane', hostID: 'H2', superseded: true });
        expect(test.client.registered).toBe(true);
        expect(test.registrations).toEqual([{ hostID: 'H2', superseded: true }]);
    });
});

describe('rpc', () => {
    it('answers with the verb result under the same id', async () => {
        const test = connected({ call: () => Promise.resolve({ ok: true, url: 'https://x/' }) });
        test.latest().deliver({ type: 'host-rpc', id: 'r1', verb: 'url', args: { paneID: 'P', tabID: 'T' }, timeoutMs: 5000 });
        await vi.waitFor(() => expect(test.latest().frames('host-rpc-reply')).toHaveLength(1));
        expect(test.latest().frames('host-rpc-reply')[0]).toEqual({
            type: 'host-rpc-reply',
            id: 'r1',
            reply: { ok: true, url: 'https://x/' }
        });
        expect(test.calls).toEqual([{ verb: 'url', args: { paneID: 'P', tabID: 'T' } }]);
    });

    it('answers even when the verb throws — silence becomes a daemon timeout for the CLI', async () => {
        const test = connected({ call: () => Promise.reject(new Error('view exploded')) });
        test.latest().deliver({ type: 'host-rpc', id: 'r2', verb: 'capture', args: {} });
        await vi.waitFor(() => expect(test.latest().frames('host-rpc-reply')).toHaveLength(1));
        expect(test.latest().frames('host-rpc-reply')[0]?.['reply']).toEqual({
            ok: false,
            error: 'view exploded'
        });
    });

    it('ignores a malformed rpc rather than replying to nothing', () => {
        const test = connected();
        test.latest().deliver({ type: 'host-rpc', verb: 'url', args: {} });
        test.latest().deliver({ type: 'host-rpc', id: 'r3' });
        expect(test.calls).toEqual([]);
        expect(test.latest().frames('host-rpc-reply')).toEqual([]);
    });

    it('defaults missing args to an empty object', async () => {
        const test = connected();
        test.latest().deliver({ type: 'host-rpc', id: 'r4', verb: 'back' });
        await vi.waitFor(() => expect(test.calls).toHaveLength(1));
        expect(test.calls[0]).toEqual({ verb: 'back', args: {} });
    });
});

describe('notify + events', () => {
    it('applies a lifecycle notify without replying to it', () => {
        const test = connected();
        test.latest().deliver({ type: 'host-notify', verb: 'tab-open', args: { paneID: 'P', tabID: 'T' } });
        expect(test.notifies).toEqual([{ verb: 'tab-open', args: { paneID: 'P', tabID: 'T' } }]);
        expect(test.latest().frames('host-rpc-reply')).toEqual([]);
    });

    it('survives a notify handler that throws (one bad pane must not kill the socket)', () => {
        const test = connected({
            notify: () => {
                throw new Error('registry blew up');
            }
        });
        test.latest().deliver({ type: 'host-notify', verb: 'pane-close', args: { paneID: 'P' } });
        test.latest().deliver({ type: 'host-notify', verb: 'tab-select', args: { paneID: 'P', tabID: 'T' } });
        expect(test.notifies).toHaveLength(2);
    });

    it('frames an event with its pane and tab, omitting the tab when there is none', () => {
        const test = connected();
        test.client.sendEvent('console', 'P', 'T', { level: 'log', message: 'hi', url: 'https://x/' });
        test.client.sendEvent('inspect-disarmed', 'P', null, {});
        const events = test.latest().frames('host-event');
        expect(events[0]).toEqual({
            type: 'host-event',
            event: 'console',
            paneID: 'P',
            tabID: 'T',
            payload: { level: 'log', message: 'hi', url: 'https://x/' }
        });
        expect(events[1]).toEqual({ type: 'host-event', event: 'inspect-disarmed', paneID: 'P', payload: {} });
    });
});

describe('role lifecycle', () => {
    it('surfaces a revoke and stops claiming the role', () => {
        const test = connected();
        test.latest().deliver({ type: 'host-revoked', role: 'web-pane', hostID: 'H1', reason: 'superseded' });
        expect(test.client.registered).toBe(false);
        expect(test.revoked).toEqual(['superseded']);
    });

    it('reports a dropped socket as `disconnected` and redials', () => {
        vi.useFakeTimers();
        const test = connected();
        test.latest().emit('close', 1006);
        expect(test.revoked).toEqual(['disconnected']);
        expect(test.client.registered).toBe(false);
        vi.advanceTimersByTime(2_000);
        expect(test.sockets).toHaveLength(2);
    });

    it('does not report a revoke for a socket that never registered', () => {
        vi.useFakeTimers();
        const test = harness();
        test.client.start();
        test.latest().emit('open');
        test.latest().emit('close', 1006);
        expect(test.revoked).toEqual([]);
    });

    it('releases the role explicitly on stop, so the daemon does not wait for the close', () => {
        const test = connected();
        test.client.stop();
        expect(test.latest().frames('host-unregister')).toHaveLength(1);
        expect(test.latest().closed).toBe(true);
        expect(test.client.registered).toBe(false);
    });

    it('stops redialing once stopped', () => {
        vi.useFakeTimers();
        const test = connected();
        test.client.stop();
        vi.advanceTimersByTime(60_000);
        expect(test.sockets).toHaveLength(1);
    });

    it('gives up after a fatal handshake rejection, but keeps trying on a server error', () => {
        vi.useFakeTimers();
        const fatal = harness();
        fatal.client.start();
        fatal.latest().emit('open');
        fatal.latest().deliver({ type: 'rejected', code: 'unauthorized', message: 'token rejected' });
        fatal.latest().emit('close', 1008);
        vi.advanceTimersByTime(60_000);
        expect(fatal.sockets).toHaveLength(1);

        const transient = harness();
        transient.client.start();
        transient.latest().emit('open');
        transient.latest().deliver({ type: 'rejected', code: 'server-error', message: 'try later' });
        transient.latest().emit('close', 1011);
        vi.advanceTimersByTime(60_000);
        expect(transient.sockets.length).toBeGreaterThan(1);
    });

    it('redials immediately at a new location (the daemon was respawned elsewhere)', () => {
        const test = connected();
        const first = test.latest();
        test.client.setLocation(location('http://127.0.0.1:5555', 'tok2'));
        expect(first.closed).toBe(true);
        expect(test.sockets).toHaveLength(2);
        test.latest().emit('open');
        expect(test.latest().frames('hello')[0]?.['token']).toBe('tok2');
    });
});
