/**
 * Web panes against the REAL Swift `nex` CLI (M6).
 *
 * `ping.test.ts` covers the headless half (a pane exists, its tabs list, browser-bound verbs
 * fail honestly). This suite adds the other half: a **fake Electron shell** registers as the
 * web-pane host over the daemon's WS channel, and the shipped CLI drives it end to end. What
 * that proves, and nothing else can:
 *
 *   - the CLI's exit-code semantics survive the daemon's envelope merge — `exists` exits 0/1
 *     on `found`, `attr` exits 1 when `present:false`, a `wait` timeout exits 1;
 *   - console lines the host pushes land in the daemon's ring buffer and drain back out through
 *     the shipped CLI's own `--since` / `--level` handling.
 */

import { WS_PROTOCOL_VERSION } from '@nex/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { startCompatDaemon, swiftCLIAvailable, type CompatDaemon } from './harness.js';

type Json = Record<string, unknown>;

interface FakeShell {
    readonly calls: Json[];
    answer(reply: Json, verb?: string, timeoutMs?: number): Promise<Json>;
    emit(event: string, paneID: string, payload: Json, tabID?: string): void;
    waitForNotify(verb: string, timeoutMs?: number): Promise<Json>;
    close(): void;
}

async function connectShell(url: string, token: string): Promise<FakeShell> {
    const socket = new WebSocket(`${url.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`);
    const calls: Json[] = [];
    const notifies: Json[] = [];
    const answered = new Set<string>();
    let registered = false;

    await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
    });
    socket.on('message', (raw: Buffer) => {
        const message = JSON.parse(raw.toString('utf8')) as Json;
        if (message['type'] === 'host-rpc') calls.push(message);
        else if (message['type'] === 'host-notify') notifies.push(message);
        else if (message['type'] === 'host-registered') registered = true;
    });
    socket.send(
        JSON.stringify({
            type: 'hello',
            protocolVersion: WS_PROTOCOL_VERSION,
            token,
            client: { kind: 'electron', name: 'compat-shell', capabilities: ['web-pane-host'] }
        })
    );

    const waitFor = async <T>(read: () => T | undefined, what: string, timeoutMs: number): Promise<T> => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const value = read();
            if (value !== undefined) return value;
            if (Date.now() > deadline) throw new Error(`no ${what} within budget`);
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
    };
    await waitFor(() => (registered ? true : undefined), 'host-registered', 5_000);

    return {
        calls,
        async answer(reply, verb, timeoutMs = 10_000) {
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
        waitForNotify(verb, timeoutMs = 10_000) {
            return waitFor(() => notifies.find((entry) => entry['verb'] === verb), `notify ${verb}`, timeoutMs);
        },
        close() {
            socket.close();
        }
    };
}

describe.skipIf(!swiftCLIAvailable())('compat: web panes with a live host', () => {
    let nex: CompatDaemon;
    let shell: FakeShell;
    let paneID: string;

    beforeEach(async () => {
        nex = await startCompatDaemon();
        shell = await connectShell(nex.info.url, nex.info.token);
        const opened = await nex.run(['web', 'open', 'https://example.com'], { timeoutMs: 15_000 });
        expect(opened.code).toBe(0);
        paneID = /open ok: ([0-9A-Fa-f-]{36})/.exec(opened.stdout)?.[1] as string;
        expect(paneID).toBeDefined();
        await shell.waitForNotify('pane-open');
    }, 60_000);

    afterEach(async () => {
        shell?.close();
        await nex?.stop();
    });

    it('round-trips an actuator verb and prints the host result', async () => {
        const running = nex.run(['web', 'text', '--target', paneID, 'css:body'], { timeoutMs: 15_000 });
        const call = await shell.answer({ ok: true, text: 'hello world', truncated: false }, 'actuate');
        expect((call['args'] as Json)['method']).toBe('text');
        const result = await running;
        expect(result.code).toBe(0);
        expect(result.stdout.trim()).toBe('hello world');
    }, 60_000);

    it('keeps `exists` exit-code semantics (0 = found, 1 = missing)', async () => {
        const yes = nex.run(['web', 'exists', '--target', paneID, 'css:#login'], { timeoutMs: 15_000 });
        await shell.answer({ ok: true, found: true }, 'actuate');
        expect((await yes).code).toBe(0);

        const no = nex.run(['web', 'exists', '--target', paneID, 'css:#nope'], { timeoutMs: 15_000 });
        await shell.answer({ ok: true, found: false }, 'actuate');
        expect((await no).code).toBe(1);
    }, 60_000);

    it('keeps `attr` exit 1 for an absent attribute, exit 0 for an empty one', async () => {
        const absent = nex.run(['web', 'attr', '--target', paneID, 'css:#a', 'disabled'], {
            timeoutMs: 15_000
        });
        await shell.answer(
            { ok: true, name: 'disabled', value: null, present: false, truncated: false },
            'actuate'
        );
        expect((await absent).code).toBe(1);

        const empty = nex.run(['web', 'attr', '--target', paneID, 'css:#a', 'disabled'], {
            timeoutMs: 15_000
        });
        await shell.answer(
            { ok: true, name: 'disabled', value: '', present: true, truncated: false },
            'actuate'
        );
        expect((await empty).code).toBe(0);
    }, 60_000);

    it('turns a wait timeout into exit 1', async () => {
        const running = nex.run(
            ['web', 'wait', '--target', paneID, '--selector', 'css:#late', '--timeout', '1'],
            { timeoutMs: 20_000 }
        );
        await shell.answer(
            { ok: false, error: 'timeout', condition: 'exists', waited_ms: 1000 },
            'actuate'
        );
        const result = await running;
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('timeout');
    }, 60_000);

    it('drains the console buffer the host filled, honouring --since and --level', async () => {
        shell.emit('console', paneID, { level: 'log', message: 'first', url: 'https://a/' });
        shell.emit('console', paneID, { level: 'error', message: 'boom', url: 'https://a/' });
        await new Promise<void>((resolve) => setTimeout(resolve, 150));

        const all = await nex.run(['web', 'console', '--target', paneID], { timeoutMs: 15_000 });
        expect(all.code).toBe(0);
        expect(all.stdout).toContain('[0] log: first');
        expect(all.stdout).toContain('[1] error: boom');
        expect(all.stderr).toContain('(next_since=2)');

        const errorsOnly = await nex.run(
            ['web', 'console', '--target', paneID, '--level', 'error', '--json'],
            { timeoutMs: 15_000 }
        );
        const reply = JSON.parse(errorsOnly.stdout) as { lines: { message: string }[] };
        expect(reply.lines.map((line) => line.message)).toEqual(['boom']);

        const since = await nex.run(['web', 'console', '--target', paneID, '--since', '1'], {
            timeoutMs: 15_000
        });
        expect(since.stdout).not.toContain('first');
        expect(since.stdout).toContain('boom');
    }, 60_000);

    // NOTE: `web console --follow` is NOT exercised here — the shipped 0.32.0 CLI predates the
    // flag (its `web console` help lists no `--follow`), so it would silently send follow:false.
    // The streaming framing is covered against a raw control-socket client in
    // `src/webpane/integration.test.ts`.
});
