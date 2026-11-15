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
        cpuPercent: null,
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

    it('sends the list when it changes, never for CPU, and for memory only in 10% steps', async () => {
        const r = rig({ clients: 1, anyVisible: true });
        const lists = (): unknown[] => r.sent.filter((message) => (message as { type: string }).type === 'running-services');
        await r.advance(0);
        expect(lists()).toHaveLength(1);
        r.setNext({ services: [{ ...service(102 * 1_048_576), cpuPercent: 42 }] });
        await r.advance(RUNNING_VISIBLE_INTERVAL_MS);
        expect(lists()).toHaveLength(1);
        // Tripled: the list's own figure (a tooltip, a dialog) would be wrong, so it goes out.
        r.setNext({ services: [service(300 * 1_048_576)] });
        await r.advance(RUNNING_VISIBLE_INTERVAL_MS);
        expect(lists()).toHaveLength(2);
        r.setNext({ services: [service(300 * 1_048_576, 3001)] });
        await r.advance(RUNNING_VISIBLE_INTERVAL_MS);
        expect(lists()).toHaveLength(3);
        expect(r.monitor.current()).toMatchObject({
            type: 'running-services',
            services: [{ name: 'pnpm dev', ports: [{ port: 3001 }] }],
            warnings: []
        });
    });

    it('sends the live numbers after every scan while a window is visible, and keeps the latest for replay', async () => {
        const r = rig({ clients: 1, anyVisible: false });
        const stats = (): unknown[] => r.sent.filter((message) => (message as { type: string }).type === 'running-stats');
        r.setNext({ services: [{ ...service(100 * 1_048_576), cpuPercent: 12.345 }] });
        await r.advance(0);
        // Hidden: nothing goes out, but a client that attaches gets the latest numbers.
        expect(stats()).toEqual([]);
        expect(r.monitor.currentStats()).toMatchObject({ type: 'running-stats', stats: [{ id: 'process:1:1', cpu_percent: 12.3, rss_bytes: 100 * 1_048_576 }] });
        r.state.presence = { clients: 1, anyVisible: true };
        await r.advance(RUNNING_VISIBLE_INTERVAL_MS);
        expect(stats()).toHaveLength(1);
        await r.advance(RUNNING_VISIBLE_INTERVAL_MS);
        expect(stats()).toHaveLength(2);
    });

    it("refreshes containers' Docker stats only while a window is visible, then sends them", async () => {
        const refreshed: string[][] = [];
        // As the scanner builds it, with the stats cache's last numbers.
        const compose: RunningService = {
            ...service(0),
            id: 'compose:shop',
            kind: 'compose',
            rssBytes: 64 * 1_048_576,
            cpuPercent: 3,
            members: [{ name: 'db', pid: null, containerID: 'aaaaaaaaaaaa', image: 'postgres', ports: [], rssBytes: 64 * 1_048_576 }]
        };
        const outside: RunningService = {
            ...compose,
            id: 'compose:else',
            category: 'outside',
            rssBytes: null,
            cpuPercent: null,
            members: [{ ...compose.members[0]!, containerID: 'bbbbbbbbbbbb', rssBytes: null }]
        };
        const state = { presence: { clients: 1, anyVisible: false } as RunningPresence };
        let clock = 0;
        const sent: { type: string; stats?: unknown }[] = [];
        const monitor = createRunningMonitor({
            scanner: { scan: () => Promise.resolve({ services: [compose, outside], scannedAt: 0, warnings: [] }) },
            presence: () => state.presence,
            broadcast: (message) => sent.push(message as { type: string }),
            containerStats: {
                get: (id) => (id === 'aaaaaaaaaaaa' ? { rssBytes: 64 * 1_048_576, cpuPercent: 3 } : null),
                refresh: (ids) => {
                    refreshed.push([...ids]);
                    return Promise.resolve();
                }
            },
            now: () => clock,
            timers: false
        });
        await monitor.tick();
        expect(refreshed).toEqual([]);
        state.presence = { clients: 1, anyVisible: true };
        clock += RUNNING_HIDDEN_INTERVAL_MS;
        await monitor.tick();
        // Never the containers of something started outside Kelpi.
        expect(refreshed).toEqual([['aaaaaaaaaaaa']]);
        expect(sent.find((message) => message.type === 'running-stats')?.stats).toEqual([
            { id: 'compose:shop', cpu_percent: 3, rss_bytes: 64 * 1_048_576 },
            { id: 'compose:else', cpu_percent: null, rss_bytes: null }
        ]);
    });
});
