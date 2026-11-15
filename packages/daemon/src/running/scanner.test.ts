import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DaemonState } from '../store/index.js';
import { buildScanContext } from './context.js';
import { dockerSocketPath, ProbeUnavailableError, type RunningProbes } from './probes.js';
import { createRunningScanner, type ScanContext } from './scanner.js';
import type { ContainerRow, ListenSocket, ProcessRow } from './types.js';

const SHELL = 100;

function proc(pid: number, ppid: number, args: string): ProcessRow {
    return { pid, ppid, pgid: pid, tpgid: 0, rssBytes: 1024, startedAt: 5000 + pid, args };
}

const context: ScanContext = {
    paneShells: new Map([[SHELL, { paneID: 'P1', workspaceID: 'W1' }]]),
    workspaces: [{ id: 'W1', name: 'w1', folders: ['/w/one'] }],
    knownFolders: ['/w'],
    selfPids: new Set(),
    workspaceOrder: ['W1']
};

interface FakeProbes extends RunningProbes {
    readonly calls: { table: number; listeners: number; containers: number; cwds: number[][] };
    gate: Promise<void> | null;
}

function fakeProbes(overrides: Partial<RunningProbes> = {}): FakeProbes {
    const calls = { table: 0, listeners: 0, containers: 0, cwds: [] as number[][] };
    const probes: FakeProbes = {
        calls,
        gate: null,
        async processTable() {
            calls.table += 1;
            if (probes.gate !== null) await probes.gate;
            return [proc(SHELL, 1, '/bin/zsh -l'), proc(200, SHELL, 'node server.js')];
        },
        async listeners() {
            calls.listeners += 1;
            return new Map<number, ListenSocket[]>([[200, [{ address: '127.0.0.1', port: 3000 }]]]);
        },
        async cwds(pids) {
            calls.cwds.push([...pids]);
            return new Map(pids.map((pid) => [pid, '/w/one/storefront']));
        },
        async containers(): Promise<ContainerRow[] | null> {
            calls.containers += 1;
            return null;
        },
        pathExists: () => true,
        realpath: (path) => path,
        ...overrides
    };
    return probes;
}

describe('createRunningScanner', () => {
    it('scans once for concurrent callers and reuses the answer briefly', async () => {
        let clock = 1_000;
        const probes = fakeProbes();
        let open: () => void = () => {};
        probes.gate = new Promise((resolve) => {
            open = resolve;
        });
        const scanner = createRunningScanner({ probes, context: () => context, now: () => clock, cacheMs: 1_500 });
        const first = scanner.scan();
        const second = scanner.scan();
        open();
        const [a, b] = await Promise.all([first, second]);
        expect(a).toBe(b);
        expect(probes.calls.table).toBe(1);
        expect(a.services.map((service) => [service.name, service.workspaceID, service.ports[0]?.port])).toEqual([['storefront', 'W1', 3000]]);

        clock += 1_000;
        probes.gate = null;
        expect(await scanner.scan()).toBe(a);
        expect(probes.calls.table).toBe(1);

        clock += 1_000;
        const fresh = await scanner.scan();
        expect(fresh).not.toBe(a);
        expect(probes.calls.table).toBe(2);
    });

    it('looks up a working directory once per process', async () => {
        let clock = 0;
        const probes = fakeProbes();
        const scanner = createRunningScanner({ probes, context: () => context, now: () => (clock += 10_000) });
        await scanner.scan();
        await scanner.scan();
        expect(probes.calls.cwds).toEqual([[200]]);
    });

    it('reports a probe that cannot run and keeps what the others found', async () => {
        const probes = fakeProbes({
            listeners: () => Promise.reject(new ProbeUnavailableError('lsof not found')),
            containers: () => Promise.reject(new Error('timed out'))
        });
        const scan = await createRunningScanner({ probes, context: () => context }).scan();
        expect(scan.services).toEqual([]);
        expect(scan.warnings).toEqual(['listening ports: lsof not found', 'docker: timed out']);
    });

    it('gives up on a probe that never answers, and keeps the scan', async () => {
        const probes = fakeProbes({ containers: () => new Promise<ContainerRow[] | null>(() => {}) });
        const scan = await createRunningScanner({ probes, context: () => context, deadlineMs: 20 }).scan();
        expect(scan.warnings).toEqual(['docker: docker did not finish']);
        expect(scan.services).toHaveLength(1);
    });

    it('keeps the scan when the working directories cannot be read', async () => {
        const probes = fakeProbes({ cwds: () => Promise.reject(new Error('lsof timed out')) });
        const scan = await createRunningScanner({ probes, context: () => context }).scan();
        expect(scan.warnings).toEqual(['working directories: lsof timed out']);
        // Without a folder the server still belongs to the pane that started it.
        expect(scan.services.map((service) => [service.workspaceID, service.directory])).toEqual([['W1', null]]);
    });
});

describe('scan context', () => {
    it("resolves each known repo's worktree folder from the template, as worktree creation does", () => {
        const known = (template: string): readonly string[] =>
            buildScanContext({
                state: { workspaces: [], repos: [{ path: '/code/kelpi' }] } as unknown as DaemonState,
                panePid: () => undefined,
                worktreeBasePath: template,
                home: '/Users/x',
                realpath: (path) => path,
                selfPids: new Set(),
                workspaceOrder: []
            }).knownFolders;
        expect(known('~/kelpi/worktrees/<repo>')).toEqual(['/Users/x/kelpi/worktrees/kelpi', '/code/kelpi']);
        // A leading `<repo>` is the repo's own path; `<repo>` in the middle is its name.
        expect(known('<repo>-worktrees')).toEqual(['/code/kelpi-worktrees', '/code/kelpi']);
        expect(known('~/code/<repo>/.worktrees')).toEqual(['/Users/x/code/kelpi/.worktrees', '/code/kelpi']);
    });

    it("maps pane shells, visible and parked, and resolves each workspace's folders", () => {
        const state = {
            workspaces: [
                {
                    id: 'W1',
                    name: 'w1',
                    panes: [{ id: 'P1' }],
                    parkedPanes: [{ id: 'P2' }],
                    repoAssociations: [{ worktreePath: '/link/one' }, { worktreePath: '/link/one' }]
                },
                { id: 'W2', name: 'w2', panes: [{ id: 'P3' }], parkedPanes: [], repoAssociations: [] }
            ],
            repos: [{ path: '/code/repo' }]
        } as unknown as DaemonState;
        const pids: Record<string, number> = { P1: 11, P2: 12 };
        const built = buildScanContext({
            state,
            panePid: (paneID) => pids[paneID],
            worktreeBasePath: '~/trees/<repo>',
            home: '/Users/x',
            realpath: (path) => path.replace('/link', '/real'),
            selfPids: new Set([1]),
            workspaceOrder: ['W2', 'W1']
        });
        expect([...built.paneShells.entries()]).toEqual([
            [11, { paneID: 'P1', workspaceID: 'W1' }],
            [12, { paneID: 'P2', workspaceID: 'W1' }]
        ]);
        expect(built.workspaces).toEqual([
            { id: 'W1', name: 'w1', folders: ['/real/one'] },
            { id: 'W2', name: 'w2', folders: [] }
        ]);
        expect(built.knownFolders).toEqual(['/Users/x/trees/repo', '/code/repo']);
    });
});

describe('dockerSocketPath', () => {
    it('follows DOCKER_HOST, then the current context, then the usual places', () => {
        const home = mkdtempSync(join(tmpdir(), 'kelpi-docker-'));
        const all = (): boolean => true;
        expect(dockerSocketPath({ DOCKER_HOST: 'unix:///run/custom.sock' }, home, all)).toBe('/run/custom.sock');
        expect(dockerSocketPath({ DOCKER_HOST: 'tcp://10.0.0.2:2375' }, home, all)).toBeNull();

        const digest = createHash('sha256').update('orbstack').digest('hex');
        mkdirSync(join(home, '.docker', 'contexts', 'meta', digest), { recursive: true });
        writeFileSync(join(home, '.docker', 'config.json'), JSON.stringify({ currentContext: 'orbstack' }));
        writeFileSync(
            join(home, '.docker', 'contexts', 'meta', digest, 'meta.json'),
            JSON.stringify({ Name: 'orbstack', Endpoints: { docker: { Host: `unix://${home}/.orbstack/run/docker.sock` } } })
        );
        expect(dockerSocketPath({}, home, all)).toBe(`${home}/.orbstack/run/docker.sock`);

        // The chosen context's engine is stopped: no engine, even if another engine's socket exists.
        const only = (path: string): boolean => path === join(home, '.colima', 'default', 'docker.sock');
        expect(dockerSocketPath({}, home, only)).toBeNull();

        // With no context chosen, the usual places, in order.
        writeFileSync(join(home, '.docker', 'config.json'), JSON.stringify({}));
        expect(dockerSocketPath({}, home, only)).toBe(join(home, '.colima', 'default', 'docker.sock'));
        expect(dockerSocketPath({}, home, () => false)).toBeNull();
    });
});
