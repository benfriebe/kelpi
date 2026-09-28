import { describe, expect, it } from 'vitest';

import type { PtyProcessHandle, PtySpawner, PtySpawnRequest } from '../pty/types.js';
import type { TerminalHostClient } from './client.js';
import { HostSpawnerSlot, PendingHostHandle } from './slot.js';

const request: PtySpawnRequest = {
    file: '/bin/sh',
    args: [],
    cwd: '/tmp',
    env: {},
    cols: 80,
    rows: 24,
    name: 'xterm-256color',
    key: 'PANE'
};

function fakeHandle(log: string[]): PtyProcessHandle {
    return {
        pid: 7,
        write: (data) => log.push(`write ${String(data)}`),
        resize: (cols, rows) => log.push(`resize ${cols}x${rows}`),
        kill: (signal) => log.push(`kill ${String(signal)}`),
        onData: () => log.push('onData'),
        onExit: () => log.push('onExit')
    };
}

function fakeClient(log: string[]): TerminalHostClient {
    const spawner: PtySpawner = (spawned) => {
        log.push(`spawn ${spawned.key ?? ''}`);
        return fakeHandle(log);
    };
    return { isClosed: false, createSpawner: () => spawner } as unknown as TerminalHostClient;
}

describe('HostSpawnerSlot', () => {
    it('queues a spawn made before the host connects, then replays everything done to it', () => {
        const log: string[] = [];
        const slot = new HostSpawnerSlot('/bin/sh');
        const pending = slot.spawner(request);
        expect(pending).toBeInstanceOf(PendingHostHandle);
        pending.onData(() => undefined);
        pending.write('ls\r');
        pending.resize(100, 30);
        slot.bind(fakeClient(log));
        expect(log).toEqual(['spawn PANE', 'onData', 'write ls\r', 'resize 100x30']);
        expect(pending.pid).toBe(7);
    });

    it('never starts a spawn that was killed while it waited', () => {
        const log: string[] = [];
        const exits: number[] = [];
        const slot = new HostSpawnerSlot('/bin/sh');
        const pending = slot.spawner(request);
        pending.onExit((code) => exits.push(code));
        pending.kill('SIGHUP');
        slot.bind(fakeClient(log));
        expect(log).toEqual([]);
        expect(exits).toEqual([-1]);
    });

    it('runs waiting spawns in-process when no host can start, and fails them if even that throws', () => {
        const slot = new HostSpawnerSlot('/bin/sh');
        const ok = slot.spawner(request);
        const log: string[] = [];
        slot.useLocal(() => fakeHandle(log));
        expect((ok as PendingHostHandle).bound).toBeDefined();
        expect(slot.degraded).toBe(true);

        const broken = new HostSpawnerSlot('/bin/sh');
        const doomed = broken.spawner(request);
        const exits: number[] = [];
        doomed.onExit((code) => exits.push(code));
        broken.useLocal(() => {
            throw new Error('no pty');
        });
        expect(exits).toEqual([-1]);
    });
});
