import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    DEFAULT_TERM,
    FALLBACK_SHELL,
    createPtyManager,
    resolveShell,
    resolveSpawnCwd
} from './manager.js';
import type { NexPtyManager } from './manager.js';
import type { PtyProcessHandle, PtySpawnRequest, PtySpawner } from './types.js';

// ---------------------------------------------------------------------------
// Stub transport — deterministic assertions on mirroring / escalation / registry
// ---------------------------------------------------------------------------

let nextPid = 4000;

class StubPty implements PtyProcessHandle {
    readonly pid = nextPid++;
    readonly writes: string[] = [];
    readonly signals: string[] = [];
    readonly resizes: Array<[number, number]> = [];
    private dataListener: ((data: Uint8Array) => void) | undefined;
    private exitListener: ((code: number, signal: number | undefined) => void) | undefined;

    constructor(readonly request: PtySpawnRequest) {}

    write(data: string | Uint8Array): void {
        this.writes.push(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    }

    resize(cols: number, rows: number): void {
        this.resizes.push([cols, rows]);
    }

    kill(signal?: string): void {
        this.signals.push(signal ?? 'SIGHUP');
    }

    onData(listener: (data: Uint8Array) => void): void {
        this.dataListener = listener;
    }

    onExit(listener: (code: number, signal: number | undefined) => void): void {
        this.exitListener = listener;
    }

    emitData(text: string): void {
        this.dataListener?.(Buffer.from(text, 'utf8'));
    }

    emitExit(code = 0): void {
        this.exitListener?.(code, undefined);
    }
}

function stubSpawner(): { spawner: PtySpawner; spawned: StubPty[] } {
    const spawned: StubPty[] = [];
    const spawner: PtySpawner = (request) => {
        const proc = new StubPty(request);
        spawned.push(proc);
        return proc;
    };
    return { spawner, spawned };
}

function spawnOpts(paneID: string, overrides: Partial<PtySpawnRequest> = {}) {
    return {
        paneID,
        cwd: overrides.cwd ?? '/tmp',
        env: [] as ReadonlyArray<readonly [string, string]>,
        cols: 80,
        rows: 24,
        shell: FALLBACK_SHELL
    };
}

const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

async function waitFor(
    predicate: () => boolean,
    { timeout = 8_000, step = 10 }: { timeout?: number; step?: number } = {}
): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await delay(step);
    }
    throw new Error('waitFor: condition not met within timeout');
}

// ---------------------------------------------------------------------------

describe('resolveSpawnCwd (terminal-surface.md §2.2)', () => {
    const isDirectory = (path: string): boolean => path === '/home/ben' || path === '/repo' || path === '/';

    it('uses the requested directory when it exists', () => {
        expect(resolveSpawnCwd('/repo', { home: '/home/ben', isDirectory })).toBe('/repo');
    });

    it('falls back to $HOME when the directory is gone', () => {
        expect(resolveSpawnCwd('/repo/deleted', { home: '/home/ben', isDirectory })).toBe('/home/ben');
    });

    it('falls back to $HOME for an empty or missing cwd', () => {
        expect(resolveSpawnCwd('', { home: '/home/ben', isDirectory })).toBe('/home/ben');
        expect(resolveSpawnCwd(undefined, { home: '/home/ben', isDirectory })).toBe('/home/ben');
        expect(resolveSpawnCwd('   ', { home: '/home/ben', isDirectory })).toBe('/home/ben');
    });

    it('falls back to / when even $HOME is gone', () => {
        expect(resolveSpawnCwd('/repo/deleted', { home: '/home/vanished', isDirectory })).toBe('/');
    });
});

describe('resolveShell (terminal-surface.md §2.2)', () => {
    it('prefers the caller-resolved shell', () => {
        expect(resolveShell('/bin/zsh', { SHELL: '/bin/bash' })).toBe('/bin/zsh');
    });

    it('falls back to $SHELL from the merged env, then /bin/sh', () => {
        expect(resolveShell(undefined, { SHELL: '/bin/bash' })).toBe('/bin/bash');
        expect(resolveShell('   ', { SHELL: '' })).toBe(FALLBACK_SHELL);
        expect(resolveShell(undefined, {})).toBe(FALLBACK_SHELL);
    });
});

describe('PtyManager registry (§1.2)', () => {
    it('is idempotent per paneID: the first caller wins', () => {
        const { spawner, spawned } = stubSpawner();
        const manager = createPtyManager({ spawner });

        manager.spawn(spawnOpts('pane-a', { cwd: '/tmp' }));
        const firstPid = manager.pid('pane-a');
        manager.spawn({ ...spawnOpts('pane-a'), cwd: '/elsewhere' });

        expect(spawned).toHaveLength(1);
        expect(manager.pid('pane-a')).toBe(firstPid);
        expect(spawned[0]?.request.cwd).toBe('/tmp');
        expect(manager.count()).toBe(1);
        expect(manager.paneIDs()).toEqual(['pane-a']);
    });

    it('drops the pane from the registry when the child exits on its own', () => {
        const { spawner, spawned } = stubSpawner();
        const manager = createPtyManager({ spawner });
        const exits: Array<[string, number]> = [];
        manager.onExit((paneID, code) => exits.push([paneID, code]));

        manager.spawn(spawnOpts('pane-a'));
        spawned[0]?.emitExit(3);

        expect(exits).toEqual([['pane-a', 3]]);
        expect(manager.has('pane-a')).toBe(false);
        expect(manager.pid('pane-a')).toBeUndefined();
    });

    it('merges the caller env over the inherited env, ordered, with TERM defaults (§2.1)', () => {
        const { spawner, spawned } = stubSpawner();
        const manager = createPtyManager({ spawner });
        process.env['NEX_TEST_INHERITED'] = 'inherited';

        manager.spawn({
            paneID: 'pane-a',
            cwd: '/tmp',
            env: [
                ['NEX_PANE_ID', 'PANE-A'],
                ['FOO', 'one'],
                ['FOO', 'two']
            ],
            cols: 80,
            rows: 24,
            shell: FALLBACK_SHELL
        });

        const env = spawned[0]?.request.env ?? {};
        expect(env['NEX_TEST_INHERITED']).toBe('inherited');
        expect(env['NEX_PANE_ID']).toBe('PANE-A');
        expect(env['FOO']).toBe('two'); // later pair wins, matching the ordered overlay
        expect(env['TERM']).toBe(DEFAULT_TERM);
        expect(spawned[0]?.request.name).toBe(DEFAULT_TERM);
        delete process.env['NEX_TEST_INHERITED'];
    });

    it('lets a caller-supplied TERM win over the default', () => {
        const { spawner, spawned } = stubSpawner();
        const manager = createPtyManager({ spawner });
        manager.spawn({
            paneID: 'pane-a',
            cwd: '/tmp',
            env: [['TERM', 'xterm-ghostty']],
            cols: 80,
            rows: 24,
            shell: FALLBACK_SHELL
        });
        expect(spawned[0]?.request.env['TERM']).toBe('xterm-ghostty');
        expect(spawned[0]?.request.name).toBe('xterm-ghostty');
    });

    it("does not leak the daemon's own $TERM into panes", () => {
        const { spawner, spawned } = stubSpawner();
        const manager = createPtyManager({ spawner });
        const previous = process.env['TERM'];
        process.env['TERM'] = 'xterm-ghostty'; // the terminal that launched the daemon

        try {
            manager.spawn(spawnOpts('pane-a'));
            expect(spawned[0]?.request.env['TERM']).toBe(DEFAULT_TERM);
            expect(spawned[0]?.request.name).toBe(DEFAULT_TERM);
        } finally {
            if (previous === undefined) delete process.env['TERM'];
            else process.env['TERM'] = previous;
        }
    });

    it('retries once on /bin/sh when the resolved shell cannot be spawned', () => {
        const requests: PtySpawnRequest[] = [];
        const errors: unknown[] = [];
        const spawner: PtySpawner = (request) => {
            requests.push(request);
            if (request.file !== FALLBACK_SHELL) throw new Error('posix_spawnp failed.');
            return new StubPty(request);
        };
        const manager = createPtyManager({ spawner, onError: (_, error) => errors.push(error) });

        manager.spawn({ ...spawnOpts('pane-a'), shell: '/bin/nope' });

        expect(requests.map((r) => r.file)).toEqual(['/bin/nope', FALLBACK_SHELL]);
        expect(manager.has('pane-a')).toBe(true);
        expect(errors).toHaveLength(1);
    });

    it('reports a synthetic exit when no shell can be spawned at all', async () => {
        const spawner: PtySpawner = () => {
            throw new Error('posix_spawnp failed.');
        };
        const errors: unknown[] = [];
        const exits: Array<[string, number]> = [];
        const manager = createPtyManager({ spawner, onError: (_, error) => errors.push(error) });
        manager.onExit((paneID, code) => exits.push([paneID, code]));

        manager.spawn(spawnOpts('pane-a'));

        expect(manager.has('pane-a')).toBe(false);
        await waitFor(() => exits.length === 1, { timeout: 500 });
        expect(exits).toEqual([['pane-a', -1]]);
        expect(errors).toHaveLength(1);
    });

    it('never sends a zero or non-finite size to the PTY (§15.4)', () => {
        const { spawner, spawned } = stubSpawner();
        const manager = createPtyManager({ spawner });
        manager.spawn(spawnOpts('pane-a'));

        manager.resize('pane-a', 0, 24);
        manager.resize('pane-a', 100, 0);
        manager.resize('pane-a', Number.NaN, 24);
        manager.resize('pane-a', 120, 40);
        manager.resize('missing', 120, 40);

        expect(spawned[0]?.resizes).toEqual([[120, 40]]);
    });

    it('unsubscribes data and exit listeners', () => {
        const { spawner, spawned } = stubSpawner();
        const manager = createPtyManager({ spawner });
        const seen: string[] = [];
        const offData = manager.onData((paneID) => seen.push(`data:${paneID}`));
        const offExit = manager.onExit((paneID) => seen.push(`exit:${paneID}`));

        manager.spawn(spawnOpts('pane-a'));
        spawned[0]?.emitData('hi');
        offData();
        offExit();
        spawned[0]?.emitData('more');
        spawned[0]?.emitExit(0);

        expect(seen).toEqual(['data:pane-a']);
    });

    it('delivers PTY output as Uint8Array keyed by paneID', () => {
        const { spawner, spawned } = stubSpawner();
        const manager = createPtyManager({ spawner });
        const chunks: Array<[string, Uint8Array]> = [];
        manager.onData((paneID, data) => chunks.push([paneID, data]));

        manager.spawn(spawnOpts('pane-a'));
        spawned[0]?.emitData('ok');

        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.[0]).toBe('pane-a');
        expect(chunks[0]?.[1]).toBeInstanceOf(Uint8Array);
        expect(Buffer.from(chunks[0]?.[1] ?? new Uint8Array()).toString('utf8')).toBe('ok');
    });
});

describe('sync-group mirroring (§8)', () => {
    it('mirrors write() bytes to every live sibling and skips dead ones', () => {
        const { spawner, spawned } = stubSpawner();
        const manager = createPtyManager({ spawner });
        manager.spawn(spawnOpts('a'));
        manager.spawn(spawnOpts('b'));
        manager.spawn(spawnOpts('c'));

        // 'ghost' has no PTY: membership must not throw and must not stall the fan-out.
        manager.setSyncGroup('ws-1', new Set(['a', 'b', 'c', 'ghost']));
        manager.write('a', 'ls\r');

        expect(spawned[0]?.writes).toEqual(['ls\r']);
        expect(spawned[1]?.writes).toEqual(['ls\r']);
        expect(spawned[2]?.writes).toEqual(['ls\r']);
    });

    it('writeDirect() bypasses mirroring (programmatic sends target one pane)', () => {
        const { spawner, spawned } = stubSpawner();
        const manager = createPtyManager({ spawner });
        manager.spawn(spawnOpts('a'));
        manager.spawn(spawnOpts('b'));
        manager.setSyncGroup('ws-1', new Set(['a', 'b']));

        manager.writeDirect('a', 'secret');

        expect(spawned[0]?.writes).toEqual(['secret']);
        expect(spawned[1]?.writes).toEqual([]);
    });

    it('replaces a group wholesale and deletes it on the empty set (§8.1)', () => {
        const { spawner, spawned } = stubSpawner();
        const manager = createPtyManager({ spawner });
        manager.spawn(spawnOpts('a'));
        manager.spawn(spawnOpts('b'));
        manager.spawn(spawnOpts('c'));

        manager.setSyncGroup('ws-1', new Set(['a', 'b', 'c']));
        expect(manager.isSyncing('c')).toBe(true);
        expect([...manager.syncTargetIDs('a')].sort()).toEqual(['b', 'c']);

        manager.setSyncGroup('ws-1', new Set(['a', 'b'])); // c excluded
        expect(manager.isSyncing('c')).toBe(false);
        manager.write('a', 'x');
        expect(spawned[2]?.writes).toEqual([]);

        manager.setSyncGroup('ws-1', new Set());
        expect(manager.isSyncing('a')).toBe(false);
        manager.write('a', 'y');
        expect(spawned[1]?.writes).toEqual(['x']);
    });

    it('keeps groups per workspace: a pane never mirrors across workspaces', () => {
        const { spawner, spawned } = stubSpawner();
        const manager = createPtyManager({ spawner });
        manager.spawn(spawnOpts('a'));
        manager.spawn(spawnOpts('b'));
        manager.spawn(spawnOpts('x'));
        manager.setSyncGroup('ws-1', new Set(['a', 'b']));
        manager.setSyncGroup('ws-2', new Set(['x']));

        manager.write('a', 'hi');

        expect(spawned[1]?.writes).toEqual(['hi']);
        expect(spawned[2]?.writes).toEqual([]);
    });

    it('mirrors the same bytes for string and Uint8Array payloads', () => {
        const { spawner, spawned } = stubSpawner();
        const manager = createPtyManager({ spawner });
        manager.spawn(spawnOpts('a'));
        manager.spawn(spawnOpts('b'));
        manager.setSyncGroup('ws-1', new Set(['a', 'b']));

        manager.write('a', new Uint8Array([0x03]));

        expect(spawned[0]?.writes).toEqual(['\x03']);
        expect(spawned[1]?.writes).toEqual(['\x03']);
    });
});

describe('kill escalation (§1.3, §15.18)', () => {
    it('sends SIGHUP immediately and escalates to SIGKILL after the grace window', async () => {
        const { spawner, spawned } = stubSpawner();
        const manager = createPtyManager({ spawner, killGraceMs: 30 });
        manager.spawn(spawnOpts('a'));

        manager.kill('a');
        expect(spawned[0]?.signals).toEqual(['SIGHUP']);
        expect(manager.has('a')).toBe(false); // registry slot freed immediately

        await waitFor(() => (spawned[0]?.signals.length ?? 0) === 2, { timeout: 500 });
        expect(spawned[0]?.signals).toEqual(['SIGHUP', 'SIGKILL']);
    });

    it('does not escalate when the child honours SIGHUP', async () => {
        const { spawner, spawned } = stubSpawner();
        const manager = createPtyManager({ spawner, killGraceMs: 30 });
        manager.spawn(spawnOpts('a'));

        manager.kill('a');
        spawned[0]?.emitExit(0);
        await delay(80);

        expect(spawned[0]?.signals).toEqual(['SIGHUP']);
    });

    it('escalates each pane on its own timer — one stuck child never blocks another', async () => {
        const { spawner, spawned } = stubSpawner();
        const manager = createPtyManager({ spawner, killGraceMs: 30 });
        manager.spawn(spawnOpts('stuck'));
        manager.spawn(spawnOpts('polite'));

        const started = Date.now();
        manager.kill('stuck');
        manager.kill('polite');
        expect(Date.now() - started).toBeLessThan(50); // kill() never blocks

        spawned[1]?.emitExit(0); // polite reaps instantly
        await waitFor(() => (spawned[0]?.signals.length ?? 0) === 2, { timeout: 500 });
        expect(spawned[0]?.signals).toEqual(['SIGHUP', 'SIGKILL']);
        expect(spawned[1]?.signals).toEqual(['SIGHUP']);
    });

    it('reports the kill-driven exit so terminal state can be disposed', () => {
        const { spawner, spawned } = stubSpawner();
        const manager = createPtyManager({ spawner, killGraceMs: 30 });
        const exits: string[] = [];
        manager.onExit((paneID) => exits.push(paneID));

        manager.spawn(spawnOpts('a'));
        manager.kill('a');
        spawned[0]?.emitExit(129);

        expect(exits).toEqual(['a']);
    });

    it('suppresses a stale exit when the pane was re-spawned during teardown', () => {
        const { spawner, spawned } = stubSpawner();
        const manager = createPtyManager({ spawner, killGraceMs: 30 });
        const exits: string[] = [];
        manager.onExit((paneID) => exits.push(paneID));

        manager.spawn(spawnOpts('a'));
        manager.kill('a');
        manager.spawn(spawnOpts('a')); // fresh PTY takes the pane id
        spawned[0]?.emitExit(129); // old child finally reaps

        expect(exits).toEqual([]);
        expect(manager.has('a')).toBe(true);
        expect(manager.pid('a')).toBe(spawned[1]?.pid);
    });

    it('kill of an unknown pane is a no-op', () => {
        const { spawner } = stubSpawner();
        const manager = createPtyManager({ spawner });
        expect(() => manager.kill('nope')).not.toThrow();
    });

    it('killAll is bounded: it resolves even when a child never reaps', async () => {
        const { spawner, spawned } = stubSpawner();
        const manager = createPtyManager({ spawner, killGraceMs: 10, killAllTimeoutMs: 60 });
        manager.spawn(spawnOpts('a'));
        manager.spawn(spawnOpts('b'));
        manager.setSyncGroup('ws-1', new Set(['a', 'b']));

        const started = Date.now();
        await manager.killAll();
        const elapsed = Date.now() - started;

        expect(elapsed).toBeLessThan(1_000);
        expect(elapsed).toBeGreaterThanOrEqual(50);
        expect(manager.count()).toBe(0);
        expect(spawned[0]?.signals).toContain('SIGKILL');
        expect(manager.isSyncing('a')).toBe(false);
    });

    it('killAll resolves as soon as every child has reaped', async () => {
        const { spawner, spawned } = stubSpawner();
        const manager = createPtyManager({ spawner, killGraceMs: 500, killAllTimeoutMs: 5_000 });
        manager.spawn(spawnOpts('a'));
        manager.spawn(spawnOpts('b'));

        const started = Date.now();
        const pending = manager.killAll();
        spawned[0]?.emitExit(0);
        spawned[1]?.emitExit(0);
        await pending;

        expect(Date.now() - started).toBeLessThan(400);
        expect(manager.count()).toBe(0);
    });

    it('killAll with no panes resolves immediately', async () => {
        const { spawner } = stubSpawner();
        const manager = createPtyManager({ spawner, killAllTimeoutMs: 5_000 });
        const started = Date.now();
        await manager.killAll();
        expect(Date.now() - started).toBeLessThan(100);
    });
});

// ---------------------------------------------------------------------------
// Real PTYs (node-pty) — the contract that actually matters
// ---------------------------------------------------------------------------

describe('real node-pty integration', () => {
    const managers: NexPtyManager[] = [];
    const tmpDirs: string[] = [];

    function makeManager(options: Parameters<typeof createPtyManager>[0] = {}): NexPtyManager {
        const manager = createPtyManager(options);
        managers.push(manager);
        return manager;
    }

    function makeTmpDir(): string {
        const dir = mkdtempSync(join(tmpdir(), 'nex-pty-'));
        tmpDirs.push(dir);
        return dir;
    }

    /** Accumulates raw output per pane so assertions can poll for a marker. */
    function sink(manager: NexPtyManager): Map<string, string> {
        const output = new Map<string, string>();
        manager.onData((paneID, data) => {
            output.set(paneID, (output.get(paneID) ?? '') + Buffer.from(data).toString('utf8'));
        });
        return output;
    }

    function shellOpts(paneID: string, cwd: string) {
        return {
            paneID,
            cwd,
            env: [
                ['NEX_PANE_ID', paneID],
                ['PS1', ''],
                ['NEX_TEST_MARKER', 'marker-value']
            ] as ReadonlyArray<readonly [string, string]>,
            cols: 80,
            rows: 24,
            shell: FALLBACK_SHELL
        };
    }

    afterEach(async () => {
        await Promise.all(managers.splice(0).map((manager) => manager.killAll()));
        for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    it('spawns a shell, streams output, and runs what we write', { timeout: 20_000 }, async () => {
        const manager = makeManager();
        const output = sink(manager);
        const dir = makeTmpDir();

        manager.spawn(shellOpts('pane-1', dir));
        expect(manager.has('pane-1')).toBe(true);
        expect(manager.pid('pane-1') ?? 0).toBeGreaterThan(0);

        // The marker is assembled by the child, so a terminal echo of the input line
        // can never satisfy the assertion.
        manager.write('pane-1', 'printf "RUN[%s]\\n" hello-from-pty\r');
        await waitFor(() => (output.get('pane-1') ?? '').includes('RUN[hello-from-pty]'));
    });

    it('injects the caller env and honours the pane cwd', { timeout: 20_000 }, async () => {
        const manager = makeManager();
        const output = sink(manager);
        const dir = makeTmpDir();

        manager.spawn(shellOpts('pane-1', dir));
        manager.write('pane-1', 'printf "ENV[%s]\\n" "$NEX_TEST_MARKER"\r');
        await waitFor(() => (output.get('pane-1') ?? '').includes('ENV[marker-value]'));

        manager.write('pane-1', 'printf "CWD[%s]\\n" "$(pwd -P)"\r');
        const resolved = realpathSync(dir);
        await waitFor(() => (output.get('pane-1') ?? '').includes(`CWD[${resolved}]`));
    });

    it('falls back to $HOME when the pane directory is gone', { timeout: 20_000 }, async () => {
        const home = makeTmpDir();
        const manager = makeManager({ homeDir: home });
        const output = sink(manager);

        manager.spawn(shellOpts('pane-1', '/definitely/not/a/real/dir'));
        manager.write('pane-1', 'printf "CWD[%s]\\n" "$(pwd -P)"\r');

        const resolvedHome = realpathSync(home);
        await waitFor(() => (output.get('pane-1') ?? '').includes(`CWD[${resolvedHome}]`));
    });

    it('resizes the PTY so the child sees the new geometry', { timeout: 20_000 }, async () => {
        const manager = makeManager();
        const output = sink(manager);
        const dir = makeTmpDir();

        manager.spawn(shellOpts('pane-1', dir));
        manager.write('pane-1', 'stty size\r');
        await waitFor(() => (output.get('pane-1') ?? '').includes('24 80'));

        manager.resize('pane-1', 100, 30);
        manager.write('pane-1', 'stty size\r');
        await waitFor(() => (output.get('pane-1') ?? '').includes('30 100'));
    });

    it('reports a natural exit and frees the registry slot', { timeout: 20_000 }, async () => {
        const manager = makeManager();
        const exits: Array<[string, number]> = [];
        manager.onExit((paneID, code) => exits.push([paneID, code]));
        const dir = makeTmpDir();

        manager.spawn(shellOpts('pane-1', dir));
        manager.write('pane-1', 'exit 0\r');

        await waitFor(() => exits.length === 1);
        expect(exits[0]?.[0]).toBe('pane-1');
        expect(manager.has('pane-1')).toBe(false);
    });

    it(
        'escalates SIGHUP to SIGKILL for a child that traps it',
        { timeout: 20_000 },
        async () => {
            const manager = makeManager({ killGraceMs: 250 });
            const output = sink(manager);
            const dir = makeTmpDir();
            const exits: string[] = [];
            manager.onExit((paneID) => exits.push(paneID));

            manager.spawn(shellOpts('stubborn', dir));
            manager.write(
                'stubborn',
                "trap '' HUP; printf 'TRAP[%s]\\n' on; while :; do sleep 0.2; done\r"
            );
            await waitFor(() => (output.get('stubborn') ?? '').includes('TRAP[on]'));
            const pid = manager.pid('stubborn');
            expect(pid ?? 0).toBeGreaterThan(0);

            const started = Date.now();
            manager.kill('stubborn');
            expect(Date.now() - started).toBeLessThan(50); // never blocks the event loop
            expect(manager.has('stubborn')).toBe(false);

            await waitFor(() => exits.includes('stubborn'));
            expect(Date.now() - started).toBeGreaterThanOrEqual(200); // SIGHUP was ignored
            expect(() => process.kill(pid ?? 0, 0)).toThrow(); // and the child is really gone
        }
    );

    it(
        'never serializes teardowns: a polite pane exits while a stubborn one waits',
        { timeout: 20_000 },
        async () => {
            const manager = makeManager({ killGraceMs: 400 });
            const output = sink(manager);
            const dir = makeTmpDir();
            const order: string[] = [];
            manager.onExit((paneID) => order.push(paneID));

            manager.spawn(shellOpts('stubborn', dir));
            manager.spawn(shellOpts('polite', dir));
            manager.write(
                'stubborn',
                "trap '' HUP; printf 'TRAP[%s]\\n' on; while :; do sleep 0.2; done\r"
            );
            manager.write('polite', "printf 'READY[%s]\\n' yes\r");
            await waitFor(() => (output.get('stubborn') ?? '').includes('TRAP[on]'));
            await waitFor(() => (output.get('polite') ?? '').includes('READY[yes]'));

            manager.kill('stubborn');
            manager.kill('polite');

            await waitFor(() => order.length === 2);
            expect(order[0]).toBe('polite'); // did not wait behind the stuck child
            expect(order[1]).toBe('stubborn');
        }
    );

    it('killAll tears down every pane within its bound', { timeout: 20_000 }, async () => {
        const manager = makeManager({ killGraceMs: 200, killAllTimeoutMs: 3_000 });
        const output = sink(manager);
        const dir = makeTmpDir();

        manager.spawn(shellOpts('a', dir));
        manager.spawn(shellOpts('b', dir));
        manager.write('a', "trap '' HUP; printf 'TRAP[%s]\\n' a; while :; do sleep 0.2; done\r");
        manager.write('b', "printf 'READY[%s]\\n' b\r");
        await waitFor(() => (output.get('a') ?? '').includes('TRAP[a]'));
        await waitFor(() => (output.get('b') ?? '').includes('READY[b]'));
        const pidA = manager.pid('a');
        const pidB = manager.pid('b');

        const started = Date.now();
        await manager.killAll();

        expect(Date.now() - started).toBeLessThan(3_500);
        expect(manager.count()).toBe(0);
        await waitFor(() => {
            try {
                process.kill(pidA ?? 0, 0);
                return false;
            } catch {
                return true;
            }
        });
        expect(() => process.kill(pidB ?? 0, 0)).toThrow();
    });

    it('mirrors real keystrokes across a sync group', { timeout: 20_000 }, async () => {
        const manager = makeManager();
        const output = sink(manager);
        const dir = makeTmpDir();

        manager.spawn(shellOpts('a', dir));
        manager.spawn(shellOpts('b', dir));
        manager.spawn(shellOpts('c', dir));
        manager.setSyncGroup('ws-1', new Set(['a', 'b']));

        manager.write('a', "printf 'SYNC[%s]\\n' ok\r");

        // Both group members executed the mirrored keystrokes; the excluded pane saw nothing.
        await waitFor(() => (output.get('a') ?? '').includes('SYNC[ok]'));
        await waitFor(() => (output.get('b') ?? '').includes('SYNC[ok]'));
        expect(output.get('c') ?? '').not.toContain('SYNC');
    });
});
