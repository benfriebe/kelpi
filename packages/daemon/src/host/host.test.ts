import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isProcessAlive } from '../lifecycle/rundir.js';
import { nodePtySpawner } from '../pty/spawner.js';
import type { PtyProcessHandle, PtySpawner, PtySpawnRequest } from '../pty/types.js';
import { connectTerminalHost, type HostPtyHandle, type TerminalHostClient } from './client.js';
import { TerminalHostServer, type TerminalHostServerOptions } from './server.js';

const TOKEN = 'a'.repeat(64);
const decoder = new TextDecoder();

interface Fixture {
    readonly dir: string;
    readonly socketPath: string;
    readonly server: TerminalHostServer;
    readonly exits: string[];
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startHost(overrides: Partial<TerminalHostServerOptions> = {}): Promise<Fixture> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kth-'));
    const socketPath = path.join(dir, 'h.sock');
    const exits: string[] = [];
    const server = new TerminalHostServer({
        socketPath,
        token: TOKEN,
        spawner: nodePtySpawner,
        hostVersion: 'test',
        onExit: (reason) => exits.push(reason),
        ...overrides
    });
    await server.start();
    cleanups.push(async () => {
        await server.shutdown('test over');
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return { dir, socketPath, server, exits };
}

async function connect(fixture: Fixture, mode: 'attach' | 'probe' = 'attach'): Promise<TerminalHostClient> {
    const client = await connectTerminalHost({ socketPath: fixture.socketPath, token: TOKEN, mode });
    cleanups.push(() => client.close());
    return client;
}

const request = (file: string, args: string[], key = 'PANE-1'): PtySpawnRequest => ({
    file,
    args,
    cwd: os.tmpdir(),
    env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' },
    cols: 80,
    rows: 24,
    name: 'xterm-256color',
    key
});

/** Collects a handle's output and resolves once `predicate` holds. */
function collect(handle: HostPtyHandle | PtyProcessHandle): {
    text(): string;
    until(predicate: (text: string) => boolean, timeoutMs?: number): Promise<string>;
    exited: Promise<number>;
} {
    let text = '';
    const waiters: (() => void)[] = [];
    handle.onData((data) => {
        text += decoder.decode(data);
        for (const wake of waiters.splice(0)) wake();
    });
    const exited = new Promise<number>((resolve) => handle.onExit((code) => resolve(code)));
    return {
        text: () => text,
        until: (predicate, timeoutMs = 5000) =>
            new Promise<string>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`timed out; saw ${JSON.stringify(text)}`)), timeoutMs);
                const check = (): void => {
                    if (predicate(text)) {
                        clearTimeout(timer);
                        resolve(text);
                    } else {
                        waiters.push(check);
                    }
                };
                check();
            }),
        exited
    };
}

/** `createSpawner` as the manager uses it, typed as the host handle it really returns. */
const spawnOn = (client: TerminalHostClient, spawnRequest: PtySpawnRequest, fallbackFile?: string): HostPtyHandle =>
    client.createSpawner(fallbackFile)(spawnRequest) as HostPtyHandle;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('terminal host: real PTYs', () => {
    it('spawns, streams, writes, resizes and reports the exit', async () => {
        const host = await startHost();
        const client = await connect(host);
        const handle = spawnOn(client, request('/bin/sh', []));
        const output = collect(handle);
        handle.resize(100, 30);
        handle.write('stty size; echo marker-$((6*7)); exit 3\n');
        await output.until((text) => text.includes('marker-42'));
        expect(output.text()).toContain('30 100');
        expect(await output.exited).toBe(3);
        expect(handle.pid).toBeGreaterThan(0);
    });

    it('keeps a terminal across a handoff and delivers the gap exactly once', async () => {
        const host = await startHost();
        const first = await connect(host);
        const handle = spawnOn(first, 
            request('/bin/sh', ['-c', 'printf A; sleep 0.3; printf B; sleep 0.3; printf C; sleep 10'])
        );
        const before = collect(handle);
        await before.until((text) => text.includes('A'));
        const pid = handle.pid;

        await first.hold();
        first.checkpoint(handle.tid, handle.received, new TextEncoder().encode('screen-state'));
        await first.detach();
        await sleep(800); // B and C are printed while no daemon is attached

        const second = await connect(host);
        const info = second.welcome.terminals.find((terminal) => terminal.key === 'PANE-1');
        expect(info).toMatchObject({ pid, checkpointOffset: 1, exited: null });
        const { handle: adopted, attached, blob } = await second.attach(info!.tid, 'PANE-1');
        expect(attached).toMatchObject({ checkpointOffset: 1, from: 1, gap: false });
        expect(decoder.decode(blob)).toBe('screen-state');
        const after = collect(adopted);
        await after.until((text) => text.includes('C'));
        expect(after.text()).toBe('BC');
        expect(isProcessAlive(pid)).toBe(true);
        adopted.kill('SIGKILL');
        await after.exited;
    });

    it('survives a daemon that vanishes, and replays its tail with a gap', async () => {
        const host = await startHost();
        const first = await connect(host);
        const handle = spawnOn(first, request('/bin/sh', ['-c', 'printf one; sleep 0.2; printf two; sleep 10']));
        await collect(handle).until((text) => text.includes('one'));
        first.close(); // no hold, no checkpoint
        await sleep(400);

        const second = await connect(host);
        const info = second.welcome.terminals.find((terminal) => terminal.key === 'PANE-1')!;
        const { handle: adopted, attached } = await second.attach(info.tid, 'PANE-1');
        expect(attached.gap).toBe(true);
        const tail = collect(adopted);
        await tail.until((text) => text.includes('two'));
        expect(tail.text()).toBe('onetwo');
        adopted.kill('SIGKILL');
    });

    it('shutdown hangs up every terminal and exits', async () => {
        const host = await startHost();
        const client = await connect(host);
        const handle = spawnOn(client, request('/bin/sleep', ['30']));
        await sleep(100);
        const pid = handle.pid;
        expect(isProcessAlive(pid)).toBe(true);
        await client.shutdown();
        await sleep(700);
        expect(isProcessAlive(pid)).toBe(false);
        expect(host.exits).toEqual(['the daemon asked']);
    });
});

/** A terminal that does only what the test tells it to, and records pause/resume. */
class FakeTerminal implements PtyProcessHandle {
    readonly pid = 4242;
    paused = false;
    readonly pauses: boolean[] = [];
    private dataListener: ((data: Uint8Array) => void) | undefined;
    private exitListener: ((code: number, signal: number | undefined) => void) | undefined;
    readonly writes: string[] = [];
    write(data: string | Uint8Array): void {
        this.writes.push(typeof data === 'string' ? data : decoder.decode(data));
    }
    resize(): void {}
    pause(): void {
        this.paused = true;
        this.pauses.push(true);
    }
    resume(): void {
        this.paused = false;
        this.pauses.push(false);
    }
    kill(): void {
        this.exitListener?.(0, undefined);
    }
    onData(listener: (data: Uint8Array) => void): void {
        this.dataListener = listener;
    }
    onExit(listener: (code: number, signal: number | undefined) => void): void {
        this.exitListener = listener;
    }
    emit(text: string): void {
        this.dataListener?.(new TextEncoder().encode(text));
    }
}

function fakeSpawner(): { spawner: PtySpawner; terminals: FakeTerminal[]; requests: PtySpawnRequest[] } {
    const terminals: FakeTerminal[] = [];
    const requests: PtySpawnRequest[] = [];
    const spawner: PtySpawner = (spawnRequest) => {
        requests.push(spawnRequest);
        if (spawnRequest.file.startsWith('/broken')) throw new Error(`no such shell: ${spawnRequest.file}`);
        const terminal = new FakeTerminal();
        terminals.push(terminal);
        return terminal;
    };
    return { spawner, terminals, requests };
}

describe('terminal host: protocol behaviour', () => {
    it('pauses a held terminal instead of dropping output, then drains and resumes', async () => {
        const fake = fakeSpawner();
        const host = await startHost({ spawner: fake.spawner, retentionBytes: 8 });
        const first = await connect(host);
        const handle = spawnOn(first, request('/bin/sh', []));
        await sleep(50);
        const terminal = fake.terminals[0]!;
        terminal.emit('0123');
        await collect(handle).until((text) => text === '0123');

        await first.hold();
        first.checkpoint(handle.tid, 4, new Uint8Array(0));
        await first.detach();
        await sleep(20);
        terminal.emit('abcdefgh');
        terminal.emit('ijklmnop'); // 16 bytes after the pin, capacity 8
        expect(terminal.paused).toBe(true);

        const second = await connect(host);
        const { handle: adopted, attached } = await second.attach(handle.tid, 'PANE-1');
        expect(attached).toMatchObject({ from: 4, gap: false });
        const after = collect(adopted);
        await after.until((text) => text === 'abcdefghijklmnop');
        expect(terminal.paused).toBe(false);
    });

    it('drops a hold pin with no checkpoint when the daemon vanishes, so the PTY keeps flowing', async () => {
        const fake = fakeSpawner();
        const host = await startHost({ spawner: fake.spawner, retentionBytes: 8 });
        const first = await connect(host);
        spawnOn(first, request('/bin/sh', []));
        await sleep(50);
        await first.hold();
        first.close(); // died mid-handoff: no checkpoint, no detach
        await sleep(30);
        const terminal = fake.terminals[0]!;
        terminal.emit('0123456789abcdef'); // twice the ring
        expect(terminal.paused).toBe(false);
    });

    it('lets pinned output flow again after the pin timeout, and a late daemon gets a gap', async () => {
        const fake = fakeSpawner();
        const host = await startHost({ spawner: fake.spawner, retentionBytes: 8, pinTimeoutMs: 100 });
        const first = await connect(host);
        const handle = spawnOn(first, request('/bin/sh', []));
        await sleep(50);
        await first.hold();
        first.checkpoint(handle.tid, 0, new Uint8Array(0));
        await first.detach();
        await sleep(20);
        const terminal = fake.terminals[0]!;
        terminal.emit('0123456789abcdef');
        expect(terminal.paused).toBe(true);
        await sleep(200);
        expect(terminal.paused).toBe(false);
        const second = await connect(host);
        const { attached } = await second.attach(handle.tid, 'PANE-1');
        expect(attached.gap).toBe(true);
    });

    it('falls back to the fallback shell and says so, or reports a failed spawn as exit -1', async () => {
        const fake = fakeSpawner();
        const host = await startHost({ spawner: fake.spawner });
        const problems: string[] = [];
        const client = await connectTerminalHost({
            socketPath: host.socketPath,
            token: TOKEN,
            onSpawnProblem: (key, message) => problems.push(`${key}: ${message}`)
        });
        cleanups.push(() => client.close());

        const saved = spawnOn(client, request('/broken/zsh', [], 'PANE-A'), '/bin/sh');
        await sleep(50);
        expect(fake.requests.map((r) => r.file)).toEqual(['/broken/zsh', '/bin/sh']);
        expect(saved.pid).toBe(4242);
        expect(problems).toEqual(['PANE-A: no such shell: /broken/zsh']);

        const lost = spawnOn(client, request('/broken/sh', [], 'PANE-B'));
        expect(await collect(lost).exited).toBe(-1);
    });

    it('refuses a bad token or protocol, and a probe does not take over', async () => {
        const host = await startHost();
        await expect(connectTerminalHost({ socketPath: host.socketPath, token: 'b'.repeat(64) })).rejects.toThrow(
            /bad token/
        );
        const attached = await connect(host);
        const lost: string[] = [];
        attached.onLost((_tids, reason) => lost.push(reason));
        const probe = await connect(host, 'probe');
        expect(probe.welcome.protocol).toBe(1);
        await sleep(50);
        expect(lost).toEqual([]);
    });

    it('lets a new daemon supersede the old one, and tells the old one why', async () => {
        const host = await startHost();
        const first = await connect(host);
        const reasons: string[] = [];
        first.onLost((_tids, reason) => reasons.push(reason));
        await connect(host);
        await sleep(50);
        expect(reasons).toEqual(['superseded']);
    });

    it('reports a host that dies as lost, without exiting the handles', async () => {
        const fake = fakeSpawner();
        const host = await startHost({ spawner: fake.spawner });
        const client = await connect(host);
        const handle = spawnOn(client, request('/bin/sh', []));
        let exited = false;
        handle.onExit(() => {
            exited = true;
        });
        const lost = new Promise<string[]>((resolve) => client.onLost((tids) => resolve(tids)));
        await sleep(50);
        // What a crash looks like from the daemon: the socket just goes.
        (host.server as unknown as { attached: { socket: { destroy(): void } } }).attached.socket.destroy();
        expect(await lost).toEqual([handle.tid]);
        expect(exited).toBe(false);
    });

    it('makes a successor wait while the attached daemon hands off, then welcomes it', async () => {
        const fake = fakeSpawner();
        const host = await startHost({ spawner: fake.spawner });
        const first = await connect(host);
        const handle = spawnOn(first, request('/bin/sh', []));
        await sleep(50);
        await first.hold();
        let welcomed = false;
        const successor = connect(host).then((client) => {
            welcomed = true;
            return client;
        });
        await sleep(100);
        expect(welcomed).toBe(false); // the handoff is still in progress
        first.checkpoint(handle.tid, 0, new Uint8Array(0));
        await first.detach();
        const second = await successor;
        expect(second.welcome.terminals.map((terminal) => terminal.tid)).toEqual([handle.tid]);
        expect(second.welcome.terminals[0]?.checkpointOffset).toBe(0);
    });

    it('shuts down when its socket file is removed', async () => {
        const fake = fakeSpawner();
        const host = await startHost({ spawner: fake.spawner });
        const client = await connect(host);
        spawnOn(client, request('/bin/sh', []));
        await sleep(50);
        fs.unlinkSync(host.socketPath);
        await sleep(2600);
        expect(host.exits).toEqual(['its socket file was removed']);
    });

    it('exits when idle with no terminals and no daemon', async () => {
        const host = await startHost({ idleExitMs: 30 });
        const client = await connect(host);
        await client.detach();
        await sleep(120);
        expect(host.exits).toEqual(['idle']);
    });

    it('keeps an exited terminal for the next daemon until it is forgotten', async () => {
        const fake = fakeSpawner();
        const host = await startHost({ spawner: fake.spawner });
        const first = await connect(host);
        const handle = spawnOn(first, request('/bin/sh', []));
        await sleep(50);
        await first.hold();
        await first.detach();
        fake.terminals[0]!.kill();
        const second = await connect(host);
        const info = second.welcome.terminals.find((terminal) => terminal.tid === handle.tid);
        expect(info?.exited).toEqual({ code: 0, signal: null });
        second.forget(handle.tid);
        await sleep(30);
        const probe = await connect(host, 'probe');
        expect(probe.welcome.terminals).toEqual([]);
    });
});
