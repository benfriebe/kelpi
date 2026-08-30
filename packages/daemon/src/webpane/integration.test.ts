/**
 * Web panes end to end: a REAL daemon (own run dir, own control socket, own SQLite file), a
 * REAL WebSocket host speaking `./HOST_PROTOCOL.md`, and REAL control-socket clients issuing
 * `web-*` commands the way the `kelpi` CLI does — one JSON line in, one JSON line + EOF out.
 *
 * This is where the pieces that only composition can get wrong are exercised: the host
 * registered on the WS channel is the same registry the control-socket handlers call into, a
 * `--follow` stream survives on a held reply handle and stops when the client hangs up, and a
 * second shell taking over strands nothing.
 *
 * Every path here is private to the test (`/tmp/kelpid-web-*`): the production Swift Kelpi owns
 * `/tmp/nex.sock` and the default run dir, and this suite must never touch them.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { createLineBuffer } from '@kelpi/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { createDaemon, type Daemon, type DaemonInfo } from '../boot/compose.js';
import { WS_PROTOCOL_VERSION } from '@kelpi/protocol';

type Reply = Record<string, unknown>;

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
    while (cleanups.length > 0) {
        const cleanup = cleanups.pop();
        if (cleanup !== undefined) await cleanup();
    }
});

interface Paths {
    readonly root: string;
    readonly runDir: string;
    readonly socketPath: string;
    readonly dbPath: string;
    readonly home: string;
    readonly configPath: string;
}

/** Short paths: a unix socket path is capped near 104 bytes on macOS. */
function scratch(): Paths {
    const root = fs.mkdtempSync(path.join('/tmp', 'kelpid-web-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    return {
        root,
        runDir: path.join(root, 'run'),
        socketPath: path.join(root, 'kelpi.sock'),
        dbPath: path.join(root, 'nex.db'),
        home,
        configPath: path.join(root, 'config')
    };
}

async function boot(paths: Paths): Promise<{ daemon: Daemon; info: DaemonInfo }> {
    const daemon = createDaemon({
        env: {},
        home: paths.home,
        runDir: paths.runDir,
        controlSocketPath: paths.socketPath,
        dbPath: paths.dbPath,
        configPath: paths.configPath,
        httpPort: 0,
        settleMs: 0,
        sleep: async () => {}
    });
    cleanups.push(() => daemon.stop());
    const info = await daemon.start();
    return { daemon, info };
}

/** One request, one reply line, then EOF — exactly what the CLI does. */
function request(socketPath: string, message: Reply, timeoutMs = 10_000): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
        const socket = net.connect({ path: socketPath });
        const buffer = createLineBuffer();
        let settled = false;
        const finish = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            fn();
        };
        const timer = setTimeout(
            () => finish(() => reject(new Error(`timeout: ${String(message['command'])}`))),
            timeoutMs
        );
        socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`));
        socket.on('data', (chunk: Buffer) => {
            for (const line of buffer.push(chunk)) {
                finish(() => resolve(JSON.parse(line) as Reply));
                return;
            }
        });
        socket.on('error', (error) => finish(() => reject(error)));
        socket.on('close', () => finish(() => reject(new Error('closed without a reply'))));
    });
}

/** A long-lived control connection: what `kelpi web console --follow` holds open. */
interface Follower {
    readonly lines: Reply[];
    next(index: number, timeoutMs?: number): Promise<Reply>;
    hangUp(): void;
    readonly ended: boolean;
}

function follow(socketPath: string, message: Reply): Follower {
    const socket = net.connect({ path: socketPath });
    const buffer = createLineBuffer();
    const lines: Reply[] = [];
    const waiters: (() => void)[] = [];
    let ended = false;
    socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on('data', (chunk: Buffer) => {
        for (const line of buffer.push(chunk)) lines.push(JSON.parse(line) as Reply);
        for (const wake of waiters.splice(0)) wake();
    });
    socket.on('close', () => {
        ended = true;
        for (const wake of waiters.splice(0)) wake();
    });
    socket.on('error', () => {});
    cleanups.push(() => {
        socket.destroy();
    });

    return {
        lines,
        async next(index, timeoutMs = 5_000) {
            const deadline = Date.now() + timeoutMs;
            while (lines.length <= index) {
                if (Date.now() > deadline) throw new Error(`no line ${String(index)} within budget`);
                await new Promise<void>((resolve) => {
                    waiters.push(resolve);
                    setTimeout(resolve, 25);
                });
            }
            return lines[index] as Reply;
        },
        hangUp() {
            socket.destroy();
        },
        get ended() {
            return ended;
        }
    };
}

/** A fake Electron shell: registers as the web-pane host and answers RPCs. */
interface FakeShell {
    readonly socket: WebSocket;
    readonly calls: Reply[];
    readonly notifies: Reply[];
    readonly revoked: Reply[];
    /** Wait for the next unanswered RPC (optionally of one verb) and answer it. */
    answer(reply: Reply, verb?: string, timeoutMs?: number): Promise<Reply>;
    emit(event: string, paneID: string, payload: Reply, tabID?: string): void;
    waitForNotify(verb: string, timeoutMs?: number): Promise<Reply>;
    close(): Promise<void>;
}

async function connectShell(info: DaemonInfo, name = 'fake-shell'): Promise<FakeShell> {
    const url = `${info.url.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(info.token)}`;
    const socket = new WebSocket(url);
    const calls: Reply[] = [];
    const notifies: Reply[] = [];
    const revoked: Reply[] = [];
    const answered = new Set<string>();
    let registered = false;

    await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
    });
    socket.on('message', (raw: Buffer) => {
        const message = JSON.parse(raw.toString('utf8')) as Reply;
        const type = message['type'];
        if (type === 'host-rpc') calls.push(message);
        else if (type === 'host-notify') notifies.push(message);
        else if (type === 'host-revoked') revoked.push(message);
        else if (type === 'host-registered') registered = true;
    });
    cleanups.push(() => socket.close());

    socket.send(
        JSON.stringify({
            type: 'hello',
            protocolVersion: WS_PROTOCOL_VERSION,
            token: info.token,
            client: { kind: 'electron', name, capabilities: ['web-pane-host'] }
        })
    );
    const deadline = Date.now() + 5_000;
    while (!registered) {
        if (Date.now() > deadline) throw new Error('host registration never acked');
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }

    const waitFor = async <T>(read: () => T | undefined, what: string, timeoutMs: number): Promise<T> => {
        const stop = Date.now() + timeoutMs;
        for (;;) {
            const value = read();
            if (value !== undefined) return value;
            if (Date.now() > stop) throw new Error(`no ${what} within budget`);
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
    };

    return {
        socket,
        calls,
        notifies,
        revoked,
        async answer(reply, verb, timeoutMs = 5_000) {
            const call = await waitFor(
                () =>
                    calls.find(
                        (candidate) =>
                            !answered.has(String(candidate['id'])) &&
                            (verb === undefined || candidate['verb'] === verb)
                    ),
                `host-rpc${verb === undefined ? '' : ` ${verb}`}`,
                timeoutMs
            );
            answered.add(String(call['id']));
            socket.send(JSON.stringify({ type: 'host-rpc-reply', id: call['id'], reply }));
            return call;
        },
        emit(event, paneID, payload, tabID) {
            socket.send(
                JSON.stringify({
                    type: 'host-event',
                    event,
                    paneID,
                    ...(tabID === undefined ? {} : { tabID }),
                    payload
                })
            );
        },
        waitForNotify(verb, timeoutMs = 5_000) {
            return waitFor(
                () => notifies.find((entry) => entry['verb'] === verb),
                `host-notify ${verb}`,
                timeoutMs
            );
        },
        async close() {
            socket.close();
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
        }
    };
}

describe('web panes end to end', () => {
    it('opens a pane headlessly, then drives it once a host attaches', async () => {
        const paths = scratch();
        const { info } = await boot(paths);

        // 1. No host yet: the pane is daemon state, so `web open` works anyway.
        const opened = await request(paths.socketPath, {
            command: 'web-open',
            url: 'example.com'
        });
        expect(opened).toMatchObject({ ok: true, url: 'https://example.com', private: false });
        const paneID = String(opened['pane_id']);
        const tabID = String(opened['tab_id']);

        // 2. Browser-bound verbs fail honestly instead of hanging.
        expect(
            await request(paths.socketPath, { command: 'web-click', target: paneID, selector: '#a' })
        ).toEqual({ ok: false, error: 'no web pane host connected' });

        // 3. State reads still answer.
        const tabs = await request(paths.socketPath, { command: 'web-tabs', target: paneID });
        expect(tabs).toMatchObject({ ok: true, pane_id: paneID });
        expect((tabs['tabs'] as Reply[])[0]).toMatchObject({ id: tabID, active: true, index: 0 });

        // 4. A shell connects and is replayed the pane it must build.
        const shell = await connectShell(info);
        const announced = await shell.waitForNotify('pane-open');
        expect((announced['args'] as Reply)['paneID']).toBe(paneID);

        // 5. An actuator verb round-trips through the host.
        const clicking = request(paths.socketPath, {
            command: 'web-click',
            target: paneID,
            selector: '#login'
        });
        const call = await shell.answer({ ok: true, matched: true, text: 'Sign in' }, 'actuate');
        expect((call['args'] as Reply)['method']).toBe('click');
        expect(await clicking).toEqual({
            ok: true,
            matched: true,
            text: 'Sign in',
            pane_id: paneID,
            workspace_id: opened['workspace_id'],
            tab_id: tabID
        });

        // 6. The host mirrors the live URL/title back into daemon state, so a state read
        //    (which needs no host at all) sees it.
        shell.emit('page-state', paneID, { url: 'https://example.com/in', title: 'Inbox' }, tabID);
        const deadline = Date.now() + 3_000;
        let mirrored: Reply | undefined;
        while (Date.now() < deadline) {
            const reply = await request(paths.socketPath, { command: 'web-tabs', target: paneID });
            const first = (reply['tabs'] as Reply[])[0];
            if (first?.['url'] === 'https://example.com/in') {
                mirrored = first;
                break;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 25));
        }
        expect(mirrored).toMatchObject({ url: 'https://example.com/in', title: 'Inbox' });

        // 7. `web-url` prefers the live view: the host answers, and its values win.
        const reading = request(paths.socketPath, { command: 'web-url', target: paneID });
        await shell.answer({ ok: true, url: 'https://example.com/in#live', title: 'Inbox (3)' }, 'url');
        expect(await reading).toMatchObject({
            ok: true,
            url: 'https://example.com/in#live',
            title: 'Inbox (3)',
            tab_id: tabID
        });
    }, 60_000);

    it('streams console lines to a --follow client until it hangs up', async () => {
        const paths = scratch();
        const { info } = await boot(paths);
        const opened = await request(paths.socketPath, { command: 'web-open', url: 'example.com' });
        const paneID = String(opened['pane_id']);
        const tabID = String(opened['tab_id']);
        const shell = await connectShell(info);
        await shell.waitForNotify('pane-open');

        shell.emit('console', paneID, { level: 'log', message: 'before', url: 'https://a/' }, tabID);
        // Give the daemon a moment to buffer it, then subscribe.
        await new Promise<void>((resolve) => setTimeout(resolve, 50));

        const stream = follow(paths.socketPath, {
            command: 'web-console',
            target: paneID,
            follow: true
        });
        const drain = await stream.next(0);
        expect(drain).toMatchObject({ ok: true, follow: true, next_since: 1, dropped: 0 });
        expect((drain['lines'] as Reply[]).map((line) => line['message'])).toEqual(['before']);

        shell.emit('console', paneID, { level: 'error', message: 'live', url: 'https://a/' }, tabID);
        const streamed = await stream.next(1);
        expect(streamed).toMatchObject({ seq: 1, level: 'error', message: 'live', tab_id: tabID });
        // The handle is still open: a follow stream never closes on its own.
        expect(stream.ended).toBe(false);

        // Ctrl-C. The server's disconnect callbacks release the subscriber slot, so the next
        // line goes nowhere and the daemon keeps running.
        stream.hangUp();
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        shell.emit('console', paneID, { level: 'log', message: 'after', url: 'https://a/' }, tabID);
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        expect(stream.lines).toHaveLength(2);

        // The line still landed in the ring buffer — a later poll sees it.
        const polled = await request(paths.socketPath, {
            command: 'web-console',
            target: paneID,
            since: 2
        });
        expect((polled['lines'] as Reply[]).map((line) => line['message'])).toEqual(['after']);
    }, 60_000);

    it('hands the host role to a second shell and strands nothing', async () => {
        const paths = scratch();
        const { info } = await boot(paths);
        const opened = await request(paths.socketPath, { command: 'web-open', url: 'example.com' });
        const paneID = String(opened['pane_id']);

        const first = await connectShell(info, 'first');
        await first.waitForNotify('pane-open');

        // An RPC is in flight when the takeover happens.
        const stranded = request(paths.socketPath, {
            command: 'web-q-text',
            target: paneID,
            selector: 'body'
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        expect(first.calls).toHaveLength(1);

        const second = await connectShell(info, 'second');
        // The failure envelope still carries the ids the call was made against.
        expect(await stranded).toMatchObject({ ok: false, error: 'web pane host disconnected', pane_id: paneID });
        const deadline = Date.now() + 3_000;
        while (first.revoked.length === 0 && Date.now() < deadline) {
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        expect(first.revoked[0]).toMatchObject({ reason: 'superseded' });
        // The new shell was replayed the pane and now owns the traffic.
        expect((await second.waitForNotify('pane-open'))['args']).toMatchObject({ paneID });

        const retried = request(paths.socketPath, {
            command: 'web-q-text',
            target: paneID,
            selector: 'body'
        });
        await second.answer({ ok: true, text: 'hello', truncated: false }, 'actuate');
        expect(await retried).toMatchObject({ ok: true, text: 'hello' });
        expect(first.calls).toHaveLength(1);

        // Dropping the live host puts the daemon back to the honest no-host answer.
        await second.close();
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        expect(
            await request(paths.socketPath, { command: 'web-back', target: paneID })
        ).toEqual({ ok: false, error: 'no web pane host connected' });
    }, 60_000);

    it('persists tabs across a daemon restart (§15.1)', async () => {
        const paths = scratch();
        const first = await boot(paths);
        const opened = await request(paths.socketPath, { command: 'web-open', url: 'example.com' });
        const paneID = String(opened['pane_id']);
        const tabID = String(opened['tab_id']);
        await request(paths.socketPath, {
            command: 'web-tab-new',
            target: paneID,
            url: 'second.test',
            make_active: true
        });
        await first.daemon.stop();

        const second = await boot(paths);
        void second;
        const tabs = await request(paths.socketPath, { command: 'web-tabs', target: paneID });
        const restored = tabs['tabs'] as Reply[];
        expect(restored.map((tab) => tab['url'])).toEqual([
            'https://example.com',
            'https://second.test'
        ]);
        expect(restored[0]?.['id']).toBe(tabID);
        expect(restored[1]?.['active']).toBe(true);
    }, 60_000);
});
