/**
 * Attribution against a host modelled on a real scan (15 Nov 2026): a Claude agent's background
 * dev stack started in another worktree, a pane's foreground `pnpm start`, orphans left behind,
 * desktop apps, Docker's port forwarder, and compose projects with and without a workspace.
 */

import { describe, expect, it } from 'vitest';

import { buildServices, isPathInside, mergePorts, planProcessStacks, workspaceForPath, type BuildInput } from './attribute.js';
import type { ContainerRow, ListenSocket, PaneShellRef, ProcessRow, RunningService, WorkspaceFolders } from './types.js';

const W1 = 'W1-DEMO';
const W2 = 'W2-NOTES';
const W3 = 'W3-ENDPOINT';
const W4 = 'W4-FPSELECT';
const P1 = 'P1-DEMO';
const P2 = 'P2-NOTES';

function proc(pid: number, ppid: number, args: string, extra: Partial<ProcessRow> = {}): ProcessRow {
    return { pid, ppid, pgid: pid, tpgid: 0, rssBytes: 10 * 1024 * 1024, startedAt: 1_000_000 + pid, args, ...extra };
}

const processes: ProcessRow[] = [
    proc(900, 1, '/Applications/Kelpi.app/Contents/Resources/node /x/terminal-host.js'),
    proc(500, 1, '/Applications/Kelpi.app/Contents/Resources/node /x/kelpid.js'),
    proc(501, 500, 'node /x/plugin-backend.mjs'),
    // checkout: Claude ran `cd ../feature-flags && pnpm run dev:prebuilt` in the background.
    proc(44552, 900, '/bin/zsh -l', { tpgid: 45027 }),
    proc(45027, 44552, 'claude', { tpgid: 45027 }),
    proc(54122, 45027, "/bin/zsh -c source /tmp/snap.sh && eval 'cd ../feature-flags && pnpm run dev:prebuilt'"),
    proc(54596, 54122, '/bin/sh /Users/x/Library/pnpm/pnpm run dev:prebuilt'),
    proc(54602, 54596, '/Users/x/Library/pnpm/.tools/pnpm-exe/10.28.1/pnpm run dev:prebuilt'),
    proc(56081, 54602, '/w/shop/feature-flags/node_modules/.bin/turbo run dev:prebuilt'),
    proc(56146, 56081, 'bash -c next dev'),
    proc(56153, 56146, 'next-server (v15.5.28)', { rssBytes: 40 * 1024 * 1024 }),
    proc(56145, 56081, 'bash -c next dev'),
    proc(56155, 56145, 'next-server (v15.5.28)', { rssBytes: 50 * 1024 * 1024 }),
    // notes: `pnpm start` in the foreground of the pane.
    proc(48307, 900, '/bin/zsh -l', { tpgid: 51513 }),
    proc(51513, 48307, '/bin/sh /Users/x/Library/pnpm/pnpm start', { pgid: 51513, tpgid: 51513 }),
    proc(51519, 51513, 'pnpm start', { pgid: 51513, tpgid: 51513 }),
    proc(51532, 51519, 'next-server (v16.4.6)', { pgid: 51513, tpgid: 51513 }),
    // Orphans: their parents are gone, launchd adopted them.
    proc(60000, 1, 'node sink.mjs'),
    proc(61000, 1, 'node server.js'),
    // Desktop apps and Docker's forwarder.
    proc(62000, 1, '/Applications/OrbStack.app/Contents/Frameworks/OrbStack Helper.app/Contents/MacOS/OrbStack Helper vmgr'),
    proc(63000, 1, '/Applications/Docker.app/Contents/MacOS/com.docker.backend'),
    proc(64000, 1, '/usr/local/bin/ollama serve')
];

const listeners = new Map<number, ListenSocket[]>([
    [501, [{ address: '127.0.0.1', port: 4000 }]],
    [45027, [{ address: '127.0.0.1', port: 65053 }]],
    [56153, [{ address: '*', port: 3200 }, { address: '::', port: 3200 }]],
    [56155, [{ address: '127.0.0.1', port: 3201 }]],
    [51532, [{ address: '*', port: 4400 }]],
    [60000, [{ address: '127.0.0.1', port: 9726 }]],
    [61000, [{ address: '127.0.0.1', port: 7000 }]],
    [62000, [{ address: '127.0.0.1', port: 32222 }, { address: '*', port: 54322 }]],
    [63000, [{ address: '*', port: 13679 }]],
    [64000, [{ address: '127.0.0.1', port: 11434 }]]
]);

const paneShells = new Map<number, PaneShellRef>([
    [44552, { paneID: P1, workspaceID: W1 }],
    [48307, { paneID: P2, workspaceID: W2 }]
]);

const workspaces: WorkspaceFolders[] = [
    { id: W1, name: 'checkout', folders: ['/w/shop/checkout'] },
    { id: W2, name: 'notes', folders: ['/w/notes'] },
    { id: W3, name: 'perf', folders: ['/w/shop/perf'] },
    { id: W4, name: 'search-filters', folders: ['/w/shop/search-filters'] }
];

const cwds = new Map<number, string>([
    [45027, '/w/shop/checkout'],
    [54596, '/w/shop/feature-flags'],
    [56153, '/w/shop/feature-flags/apps/admin-web'],
    [56155, '/w/shop/feature-flags/apps/store-web'],
    [51513, '/w/notes'],
    [51532, '/w/notes'],
    [60000, '/w/shop/perf/phase2'],
    [61000, '/w/shop/gone-tree'],
    [62000, '/w/shop/gone-branch'],
    [64000, '/']
]);

function container(name: string, extra: Partial<ContainerRow>): ContainerRow {
    return { id: `${name}-0123456789abcdef`, name, image: 'img', project: null, service: null, directory: null, createdAt: 2_000_000, ports: [], ...extra };
}

const containers: ContainerRow[] = [
    container('shop-200-redis-1', {
        project: 'shop-200',
        service: 'redis',
        directory: '/w/shop/feature-flags/apps/api-server',
        ports: [{ port: 6579, address: '0.0.0.0', containerPort: 6379 }]
    }),
    container('supabase_db_shop-200', {
        project: 'shop-200',
        directory: '/w/shop/feature-flags/packages',
        createdAt: 1_999_000,
        ports: [{ port: 54522, address: '0.0.0.0', containerPort: 5432 }, { port: 54522, address: '::', containerPort: 5432 }]
    }),
    container('shop-7300-redis-1', {
        project: 'shop-7300',
        service: 'redis',
        directory: '/w/shop/search-filters/apps/api-server',
        ports: [{ port: 13679, address: '0.0.0.0', containerPort: 6379 }]
    }),
    container('supabase_db_shop-7300', {
        project: 'shop-7300',
        directory: '/w/shop/search-filters/packages',
        ports: [{ port: 54322, address: '127.0.0.1', containerPort: 5432 }]
    }),
    container('shop-400-redis-1', { project: 'shop-400', directory: '/w/shop/old-branch/apps/api-server' }),
    container('otel-collector', { ports: [{ port: 4317, address: '127.0.0.1', containerPort: 4317 }] })
];

const missing = new Set(['/w/shop/gone-tree', '/w/shop/gone-branch', '/w/shop/old-branch/apps/api-server']);
const containerPorts = new Set(containers.flatMap((row) => row.ports.map((port) => port.port)));

const planInput = { processes, listeners, paneShells, selfPids: new Set([500]), containerPorts };

function build(overrides: Partial<BuildInput> = {}): RunningService[] {
    return buildServices(
        {
            ...planInput,
            stacks: planProcessStacks(planInput),
            cwds,
            containers,
            workspaces,
            knownFolders: ['/w/shop'],
            pathExists: (path) => !missing.has(path),
            ...overrides
        },
        [W1, W2, W3, W4]
    );
}

function byID(services: readonly RunningService[], id: string): RunningService {
    const found = services.find((service) => service.id === id);
    if (found === undefined) throw new Error(`no service ${id}: ${services.map((service) => service.id).join(', ')}`);
    return found;
}

describe('planProcessStacks', () => {
    const plans = planProcessStacks(planInput);

    it("roots an agent's stack below its shell wrapper and groups the stack's listeners", () => {
        expect(plans.find((plan) => plan.rootPid === 54596)).toEqual({
            rootPid: 54596,
            listenerPids: [56153, 56155],
            paneShellPid: 44552,
            agent: 'claude',
            agentInternal: false,
            foreground: false
        });
    });

    it("marks the agent's own port, and a pane's foreground job", () => {
        expect(plans.find((plan) => plan.rootPid === 45027)).toMatchObject({ agentInternal: true, agent: 'claude', paneShellPid: 44552 });
        expect(plans.find((plan) => plan.rootPid === 51513)).toMatchObject({ foreground: true, agent: null, paneShellPid: 48307 });
    });

    it('still finds pane processes when the daemon started the terminal host (a fresh boot)', () => {
        // Before any handoff the host is the daemon's child, so every pane is a daemon descendant.
        const fresh = processes.map((row) => (row.pid === 900 ? { ...row, ppid: 500 } : row));
        const roots = planProcessStacks({ ...planInput, processes: fresh }).map((plan) => plan.rootPid);
        expect(roots).toContain(54596);
        expect(roots).toContain(51513);
        expect(roots).not.toContain(501);
    });

    it("leaves out Kelpi's own processes and a forwarder that only holds containers' ports", () => {
        const roots = plans.map((plan) => plan.rootPid);
        expect(roots).not.toContain(500);
        expect(roots).not.toContain(501);
        expect(roots).not.toContain(63000);
        expect(roots.sort((a, b) => a - b)).toEqual([45027, 51513, 54596, 60000, 61000, 62000, 64000]);
    });
});

describe('buildServices', () => {
    const services = build();

    it('lists the agent stack under the pane that started it, named by its command, running in another worktree', () => {
        const stack = byID(services, 'process:54596:1054596');
        expect(stack).toMatchObject({
            kind: 'process',
            name: 'pnpm run dev:prebuilt',
            command: '/bin/sh /Users/x/Library/pnpm/pnpm run dev:prebuilt',
            category: 'workspace',
            workspaceID: W1,
            workspaceName: 'checkout',
            paneID: P1,
            attribution: 'process-tree',
            startedBy: 'agent',
            agent: 'claude',
            foreground: false,
            directory: '/w/shop/feature-flags',
            directoryWorkspaceID: null,
            directoryMissing: false,
            pid: 54596,
            // sh → pnpm → turbo → two (bash → next-server) branches
            processCount: 7
        });
        expect(stack.members.map((member) => member.name)).toEqual(['admin-web', 'store-web']);
        // IPv4 and IPv6 on :3200 fold to one port, exposed because it is bound to every interface.
        expect(stack.ports).toEqual([
            { port: 3200, address: '*', exposed: true, pid: 56153, containerPort: null },
            { port: 3201, address: '127.0.0.1', exposed: false, pid: 56155, containerPort: null }
        ]);
        expect(stack.rssBytes).toBe((5 * 10 + 40 + 50) * 1024 * 1024);
    });

    it("places a compose project in that worktree with the workspace whose stack runs there", () => {
        expect(byID(services, 'compose:shop-200')).toMatchObject({
            kind: 'compose',
            category: 'workspace',
            workspaceID: W1,
            attribution: 'directory',
            directoryWorkspaceID: null,
            startedBy: 'compose',
            command: 'docker compose -p shop-200',
            processCount: 2,
            startedAt: 1_999_000,
            rssBytes: null
        });
    });

    it("names the workspace that holds a project's own folder, which can differ from its owner", () => {
        const mixed: ContainerRow[] = [
            container('db-a', { project: 'mixed', directory: '/w/elsewhere/packages' }),
            container('db-b', { project: 'mixed', directory: '/w/elsewhere/packages' }),
            container('api', { project: 'mixed', directory: '/w/shop/search-filters/apps/api' })
        ];
        expect(byID(build({ containers: mixed }), 'compose:mixed')).toMatchObject({
            workspaceID: W4,
            directory: '/w/elsewhere/packages',
            directoryWorkspaceID: null
        });
    });

    it("finds a compose project's workspace from any of its containers' folders", () => {
        const project = byID(services, 'compose:shop-7300');
        expect(project).toMatchObject({ category: 'workspace', workspaceID: W4, attribution: 'compose-label', directoryWorkspaceID: W4 });
        // Members are containers, named by their compose service when they have one; ids are 12 characters.
        expect(project.members.map((member) => [member.name, member.containerID])).toEqual([
            ['redis', 'shop-7300-re'],
            ['supabase_db_shop-7300', 'supabase_db_']
        ]);
    });

    it("marks a pane's foreground job and names the stack by its command", () => {
        expect(byID(services, 'process:51513:1051513')).toMatchObject({
            name: 'pnpm start',
            workspaceID: W2,
            startedBy: 'pane',
            foreground: true,
            agent: null,
            ports: [{ port: 4400, address: '*', exposed: true, pid: 51532, containerPort: null }]
        });
    });

    it('places an orphan by its folder, named after the app folder', () => {
        expect(byID(services, 'process:60000:1060000')).toMatchObject({
            name: 'phase2',
            category: 'workspace',
            workspaceID: W3,
            paneID: null,
            attribution: 'directory',
            startedBy: 'unknown'
        });
    });

    it('lists stacks in a deleted worktree as unattached', () => {
        expect(byID(services, 'process:61000:1061000')).toMatchObject({ category: 'unattached', directoryMissing: true, workspaceID: null });
        expect(byID(services, 'compose:shop-400')).toMatchObject({ category: 'unattached', directoryMissing: true, attribution: 'none' });
    });

    it("treats a desktop app as started outside Kelpi, wherever it was launched, and drops containers' ports from it", () => {
        const helper = byID(services, 'process:62000:1062000');
        expect(helper).toMatchObject({ name: 'OrbStack Helper', category: 'outside', workspaceID: null, directoryMissing: false });
        expect(helper.ports.map((port) => port.port)).toEqual([32222]);
        expect(byID(services, 'process:64000:1064000')).toMatchObject({ name: 'ollama serve', category: 'outside' });
        expect(byID(services, 'container:otel-collect')).toMatchObject({ kind: 'container', category: 'outside', name: 'otel-collector' });
    });

    it("lists the agent's own port as the agent's", () => {
        // Only the agent itself: the stack it started is its own service, not counted twice.
        expect(byID(services, 'process:45027:1045027')).toMatchObject({
            name: 'Claude Code',
            category: 'agent',
            workspaceID: W1,
            startedBy: 'pane',
            processCount: 1,
            rssBytes: 10 * 1024 * 1024
        });
    });

    it('sorts by category, then sidebar order', () => {
        expect(services.map((service) => [service.category, service.workspaceName])).toEqual([
            ['workspace', 'checkout'],
            ['workspace', 'checkout'],
            ['workspace', 'notes'],
            ['workspace', 'perf'],
            ['workspace', 'search-filters'],
            ['unattached', null],
            ['unattached', null],
            ['outside', null],
            ['outside', null],
            ['outside', null],
            ['agent', 'checkout']
        ]);
    });
});

describe('helpers', () => {
    it('matches folders on path boundaries only', () => {
        expect(isPathInside('/w/a', '/w/a')).toBe(true);
        expect(isPathInside('/w/a/b', '/w/a/')).toBe(true);
        expect(isPathInside('/w/ab', '/w/a')).toBe(false);
    });

    it('picks the longest folder that holds a path', () => {
        const nested: WorkspaceFolders[] = [
            { id: 'outer', name: 'outer', folders: ['/w/repo'] },
            { id: 'inner', name: 'inner', folders: ['/w/repo/worktrees/x'] }
        ];
        expect(workspaceForPath('/w/repo/worktrees/x/src', nested)?.id).toBe('inner');
        expect(workspaceForPath('/w/repo/src', nested)?.id).toBe('outer');
        expect(workspaceForPath(null, nested)).toBeNull();
    });

    it('folds a port bound on IPv4 and IPv6, keeping the exposed one', () => {
        expect(
            mergePorts([
                { port: 80, address: '127.0.0.1', exposed: false, pid: 1, containerPort: null },
                { port: 80, address: '::', exposed: true, pid: 1, containerPort: null },
                { port: 22, address: '::1', exposed: false, pid: 1, containerPort: null }
            ])
        ).toEqual([
            { port: 22, address: '::1', exposed: false, pid: 1, containerPort: null },
            { port: 80, address: '::', exposed: true, pid: 1, containerPort: null }
        ]);
    });
});

describe('edge cases from review', () => {
    const base = { containerPorts: new Set<number>(), selfPids: new Set<number>() };
    const ws: WorkspaceFolders[] = [{ id: 'WA', name: 'a', folders: ['/w/trees/a'] }];

    function services(
        rows: ProcessRow[],
        listens: Map<number, ListenSocket[]>,
        shells: Map<number, PaneShellRef>,
        dirs: Map<number, string>,
        extra: Partial<BuildInput> = {}
    ): RunningService[] {
        const plan = { ...base, processes: rows, listeners: listens, paneShells: shells };
        return buildServices({
            ...plan,
            stacks: planProcessStacks(plan),
            cwds: dirs,
            containers: [],
            workspaces: ws,
            knownFolders: ['/w/trees'],
            pathExists: () => true,
            ...extra
        });
    }

    it("roots Linux orphans below the `systemd --user` subreaper, each placed by its own folder", () => {
        const rows = [
            proc(1, 0, '/sbin/init'),
            proc(700, 1, '/usr/lib/systemd/systemd --user'),
            proc(710, 700, 'node server.js'),
            proc(720, 700, 'python3 -m http.server')
        ];
        const found = services(
            rows,
            new Map([[710, [{ address: '127.0.0.1', port: 3000 }]], [720, [{ address: '127.0.0.1', port: 8000 }]]]),
            new Map(),
            new Map([[710, '/w/trees/a/web'], [720, '/']])
        );
        expect(found.map((service) => [service.pid, service.category, service.workspaceID])).toEqual([
            [710, 'workspace', 'WA'],
            [720, 'outside', null]
        ]);
    });

    it("roots a stack at its command when the agent's wrapper outlived the agent", () => {
        const rows = [
            proc(800, 1, "/bin/zsh -c source /tmp/snap.sh && eval 'pnpm dev' && pwd -P >| /tmp/cwd"),
            proc(810, 800, '/bin/sh /Users/x/Library/pnpm/pnpm dev'),
            proc(820, 810, 'next-server (v15.5.28)')
        ];
        const [stack] = services(rows, new Map([[820, [{ address: '*', port: 3000 }]]]), new Map(), new Map([[810, '/w/trees/a']]));
        expect(stack).toMatchObject({ pid: 810, name: 'pnpm dev', workspaceID: 'WA', attribution: 'directory' });
    });

    it('sees an agent that is the pane process itself', () => {
        const rows = [
            proc(900, 1, 'node /x/terminal-host.js'),
            proc(910, 900, 'claude'),
            proc(920, 910, '/bin/zsh -c eval pnpm dev'),
            proc(930, 920, 'node server.js')
        ];
        const shells = new Map([[910, { paneID: 'PA', workspaceID: 'WA' }]]);
        const listens = new Map([[910, [{ address: '127.0.0.1', port: 60000 }]], [930, [{ address: '127.0.0.1', port: 3000 }]]]);
        const found = services(rows, listens, shells, new Map([[930, '/w/trees/a']]));
        expect(found.map((service) => [service.pid, service.category, service.startedBy, service.agent])).toEqual([
            [930, 'workspace', 'agent', 'claude'],
            [910, 'agent', 'pane', 'claude']
        ]);
    });

    it("does not let a pane's server in a broad folder claim leftover containers", () => {
        const rows = [proc(900, 1, 'node /x/terminal-host.js'), proc(940, 900, '/bin/zsh -l'), proc(950, 940, 'ssh -L 8080:db:5432 bastion')];
        const shells = new Map([[940, { paneID: 'PA', workspaceID: 'WA' }]]);
        const leftover: ContainerRow = {
            id: 'leftover-0123456789',
            name: 'leftover-redis-1',
            image: 'redis',
            project: 'leftover',
            service: 'redis',
            directory: '/w/trees/gone/packages',
            createdAt: 1,
            ports: []
        };
        const found = services(rows, new Map([[950, [{ address: '127.0.0.1', port: 8080 }]]]), shells, new Map([[950, '/w']]), {
            containers: [leftover],
            pathExists: (path) => !path.startsWith('/w/trees/gone')
        });
        expect(found.find((service) => service.id === 'compose:leftover')).toMatchObject({ category: 'unattached', workspaceID: null });
    });

    it("never counts pane shells or Kelpi's processes into a stack under them", () => {
        // `pnpm dev` of a Kelpi dev instance: its own daemon (self here) and that daemon's panes.
        const rows = [
            proc(900, 1, 'node /x/terminal-host.js'),
            proc(960, 900, '/bin/zsh -l'),
            proc(970, 960, 'node scripts/dev-instance.mjs', { rssBytes: 1024 }),
            proc(980, 970, 'node kelpid.js', { rssBytes: 4096 }),
            proc(990, 980, '/bin/zsh -l', { rssBytes: 2048 })
        ];
        const shells = new Map([
            [960, { paneID: 'PA', workspaceID: 'WA' }],
            [990, { paneID: 'PB', workspaceID: 'WA' }]
        ]);
        const [stack] = services(rows, new Map([[980, [{ address: '127.0.0.1', port: 5000 }]]]), shells, new Map([[970, '/w/trees/a']]));
        expect(stack).toMatchObject({ pid: 970, processCount: 2, rssBytes: 1024 + 4096 });
    });

    it('roots a server started in another terminal app at what was typed, and places it by folder', () => {
        // iTerm2 → login → -zsh → pnpm dev → node; tmux server → zsh → python. Neither is a pane.
        const rows = [
            proc(1000, 1, '/Applications/iTerm.app/Contents/MacOS/iTerm2'),
            proc(1010, 1000, '/usr/bin/login -fp x'),
            proc(1020, 1010, '-zsh'),
            proc(1030, 1020, '/bin/sh /Users/x/Library/pnpm/pnpm dev'),
            proc(1040, 1030, 'node server.js'),
            proc(1100, 1, 'tmux new -s work'),
            proc(1110, 1100, '-zsh'),
            proc(1120, 1110, 'python3 -m http.server'),
            proc(1130, 1100, '-zsh'),
            proc(1140, 1130, 'node other.js')
        ];
        const listens = new Map([
            [1040, [{ address: '127.0.0.1', port: 3000 }]],
            [1120, [{ address: '127.0.0.1', port: 8000 }]],
            [1140, [{ address: '127.0.0.1', port: 9000 }]]
        ]);
        const dirs = new Map([[1030, '/w/trees/a'], [1120, '/w/trees/a/docs'], [1140, '/elsewhere']]);
        const found = services(rows, listens, new Map(), dirs);
        expect(found.map((service) => [service.pid, service.name, service.category, service.workspaceID])).toEqual([
            [1030, 'pnpm dev', 'workspace', 'WA'],
            [1120, 'docs', 'workspace', 'WA'],
            [1140, 'node other.js', 'outside', null]
        ]);
    });

    it('roots a server typed in a nested shell inside a pane below that shell', () => {
        const rows = [
            proc(900, 1, 'node /x/terminal-host.js'),
            proc(1200, 900, '/bin/zsh -l'),
            proc(1210, 1200, 'bash'),
            proc(1220, 1210, 'node a.js'),
            proc(1230, 1210, 'node b.js')
        ];
        const shells = new Map([[1200, { paneID: 'PA', workspaceID: 'WA' }]]);
        const listens = new Map([[1220, [{ address: '127.0.0.1', port: 1 }]], [1230, [{ address: '127.0.0.1', port: 2 }]]]);
        const found = services(rows, listens, shells, new Map());
        expect(found.map((service) => [service.pid, service.workspaceID, service.paneID])).toEqual([
            [1220, 'WA', 'PA'],
            [1230, 'WA', 'PA']
        ]);
    });
});
