import { describe, expect, it } from 'vitest';

import { createRunningMonitor, RUNNING_HIDDEN_INTERVAL_MS, RUNNING_POKE_DELAY_MS, RUNNING_VISIBLE_INTERVAL_MS, type RunningPresence } from './monitor.js';
import type { RunningScanner } from './scanner.js';
import type { RunningScan, RunningService } from './types.js';

function service(rssBytes: number, port = 3000): RunningService {
    return {
        id: 'process:1:1',
        kind: 'process',
        name: 'pnpm dev',
        command: 'pnpm dev',
        category: 'workspace',
        workspaceID: 'W1',
        workspaceName: 'w1',
        paneID: null,
        attribution: 'process-tree',
        startedBy: 'pane',
        agent: null,
        foreground: true,
        directory: '/w',
        directoryWorkspaceID: 'W1',
        directoryWorkspaceName: 'w1',
        directoryMissing: false,
        worktree: null,
        startedAt: 1_000,
        pid: 1,
        processCount: 2,
        rssBytes,
        ports: [{ port, address: '127.0.0.1', exposed: false, pid: 1, containerPort: null }],
        members: []
    };
}

function rig(presence: RunningPresence) {
    let clock = 0;
    let next: RunningScan = { services: [service(100 * 1_048_576)], scannedAt: 0, warnings: [] };
    const scans: number[] = [];
    const since: (number | undefined)[] = [];
    const scanner: RunningScanner = {
        scan: (options) => {
            scans.push(clock);
            since.push(options?.since);
            return Promise.resolve({ ...next, scannedAt: clock });
        }
    };
    const sent: unknown[] = [];
    const state = { presence };
    const monitor = createRunningMonitor({
        scanner,
        presence: () => state.presence,
        broadcast: (message) => sent.push(message),
        now: () => clock,
        timers: false
    });
    return {
        monitor,
        scans,
        since,
        sent,
        state,
        advance: async (ms: number) => {
            clock += ms;
            await monitor.tick();
        },
        setNext: (scan: Partial<RunningScan>) => {
            next = { ...next, ...scan };
        }
    };
}

describe('createRunningMonitor', () => {
    it('never scans with no client attached', async () => {
        const r = rig({ clients: 0, anyVisible: false });
        await r.advance(RUNNING_HIDDEN_INTERVAL_MS * 3);
        expect(r.scans).toEqual([]);
        expect(r.monitor.current().scannedAt).toBeNull();
    });

    it('scans every 10 s while a window is visible and every 60 s while none is', async () => {
        const r = rig({ clients: 1, anyVisible: true });
        await r.advance(0);
        await r.advance(RUNNING_VISIBLE_INTERVAL_MS - 1);
        await r.advance(1);
        expect(r.scans).toEqual([0, RUNNING_VISIBLE_INTERVAL_MS]);
        r.state.presence = { clients: 1, anyVisible: false };
        await r.advance(RUNNING_VISIBLE_INTERVAL_MS);
        await r.advance(RUNNING_HIDDEN_INTERVAL_MS - RUNNING_VISIBLE_INTERVAL_MS);
        expect(r.scans).toEqual([0, RUNNING_VISIBLE_INTERVAL_MS, RUNNING_VISIBLE_INTERVAL_MS + RUNNING_HIDDEN_INTERVAL_MS]);
    });

    it('scans a second after a poke, between the usual turns', async () => {
        const r = rig({ clients: 1, anyVisible: false });
        await r.advance(0);
        r.monitor.poke();
        await r.advance(RUNNING_POKE_DELAY_MS - 1);
        await r.advance(1);
        expect(r.scans).toEqual([0, RUNNING_POKE_DELAY_MS]);
        // The poke's scan must have begun after the poke, never the scanner's cached one.
        expect(r.since).toEqual([undefined, 0]);
    });

    it('broadcasts only when the list changes, ignoring memory below a MiB', async () => {
        const r = rig({ clients: 1, anyVisible: true });
        await r.advance(0);
        expect(r.sent).toHaveLength(1);
        r.setNext({ services: [service(100 * 1_048_576 + 4096)] });
        await r.advance(RUNNING_VISIBLE_INTERVAL_MS);
        expect(r.sent).toHaveLength(1);
        r.setNext({ services: [service(100 * 1_048_576 + 4096, 3001)] });
        await r.advance(RUNNING_VISIBLE_INTERVAL_MS);
        expect(r.sent).toHaveLength(2);
        expect(r.monitor.current()).toMatchObject({
            type: 'running-services',
            services: [{ name: 'pnpm dev', ports: [{ port: 3001 }] }],
            warnings: []
        });
    });
});
