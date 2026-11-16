import { describe, expect, it } from 'vitest';

import { createRunningStopper, type StopCall } from './stop.js';
import type { ProcessRow, RunningScan, RunningService } from './types.js';

function row(pid: number, ppid: number, args: string, extra: Partial<ProcessRow> = {}): ProcessRow {
    return { pid, ppid, pgid: pid, tpgid: 0, rssBytes: 1_048_576, startedAt: 1_000 + pid, args, ...extra };
}

/*
 * The host: launchd (1); the daemon (50) under a dev-instance script (40), with a plugin backend
 * (51); a terminal host (100) with one pane shell (200) whose foreground job is `pnpm start`
 * (300); a detached stack (400) whose turbo (401) runs two servers and an interactive shell (404,
 * a dev instance's pane, say); another user's server (500); the Kelpi app (600).
 */
const TABLE: readonly ProcessRow[] = [
    row(1, 0, '/sbin/launchd'),
    row(40, 1, 'node scripts/dev-instance.mjs'),
    row(50, 40, 'node kelpid.js'),
    row(51, 50, 'node plugin-backend.js'),
    row(100, 1, 'node terminal-host.js'),
    row(200, 100, '-zsh', { pgid: 200, tpgid: 300 }),
    row(300, 200, 'node /opt/homebrew/bin/pnpm start', { pgid: 300, tpgid: 300 }),
    row(301, 300, 'node server.js', { pgid: 300, tpgid: 300 }),
    row(400, 1, 'sh -c pnpm run dev'),
    row(401, 400, 'turbo run dev'),
    row(402, 401, 'next-server (v15)'),
    row(403, 401, 'vite'),
    row(404, 401, '-zsh'),
    row(405, 404, 'claude'),
    row(500, 1, 'postgres -D /var/db'),
    row(600, 1, '/Applications/Kelpi.app/Contents/MacOS/Kelpi'),
    row(700, 200, 'python3 -m http.server 8000', { pgid: 700, tpgid: 300 })
];

function service(id: string, extra: Partial<RunningService> = {}): RunningService {
    const pid = Number(id.split(':')[1] ?? 0);
    return {
        id,
        kind: 'process',
        name: `svc-${String(pid)}`,
        command: 'pnpm dev',
        category: 'workspace',
        workspaceID: 'W1',
        workspaceName: 'w1',
        paneID: null,
        attribution: 'process-tree',
        startedBy: 'agent',
        agent: 'claude',
        foreground: false,
        directory: '/w',
        directoryWorkspaceID: 'W1',
        directoryWorkspaceName: 'w1',
        directoryMissing: false,
        worktree: null,
        startedAt: 1_000 + pid,
        pid,
        processCount: 1,
        rssBytes: 1,
        cpuPercent: null,
        ports: [{ port: 3000 + pid, address: '127.0.0.1', exposed: false, pid, containerPort: null }],
        members: [],
        ...extra
    };
}

const STACK = service('process:400:1400', { name: 'apps/web' });
const FOREGROUND = service('process:300:1300', { name: 'pnpm start', paneID: 'P1', startedBy: 'pane', agent: null, foreground: true });

interface Rig {
    readonly stopper: ReturnType<typeof createRunningStopper>;
    readonly signals: [number, string | number][];
    readonly interrupts: string[];
    readonly docker: string[];
    readonly alive: Set<number>;
    readonly stubborn: Set<number>;
    pokes: number;
    scans: RunningScan[];
    table: ProcessRow[];
    dockerStatus: (path: string) => number | Error;
    /** Docker answers this long after the request (its stop timeout), on the fake clock. */
    dockerDelayMs: number;
}

function rig(services: readonly RunningService[], options: { warnings?: string[] } = {}): Rig {
    let clock = 0;
    const state: Rig = {
        stopper: undefined as never,
        signals: [],
        interrupts: [],
        docker: [],
        alive: new Set(TABLE.map((entry) => entry.pid)),
        stubborn: new Set(),
        pokes: 0,
        scans: [{ services: [...services], scannedAt: 0, warnings: options.warnings ?? [] }],
        table: [...TABLE],
        dockerStatus: () => 204,
        dockerDelayMs: 0
    };
    const due: { at: number; settle: () => void }[] = [];
    const errno = (code: string): Error => Object.assign(new Error(code), { code });
    (state as { stopper: Rig['stopper'] }).stopper = createRunningStopper({
        scan: () => Promise.resolve(state.scans.length > 1 ? (state.scans.shift() as RunningScan) : (state.scans[0] as RunningScan)),
        processTable: () => Promise.resolve(state.table.filter((entry) => state.alive.has(entry.pid))),
        signal: (pid, signal) => {
            if (!state.alive.has(pid)) throw errno('ESRCH');
            if (pid === 500) throw errno('EPERM');
            // Signal 0 only asks whether it is alive; it is not a signal sent.
            if (signal !== 0) state.signals.push([pid, signal]);
            if (signal === 'SIGKILL' || (signal === 'SIGTERM' && !state.stubborn.has(pid))) state.alive.delete(pid);
        },
        docker: (path) => {
            state.docker.push(path);
            const answer = state.dockerStatus(path);
            if (state.dockerDelayMs === 0) return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
            return new Promise((resolve, reject) => {
                due.push({ at: clock + state.dockerDelayMs, settle: () => (answer instanceof Error ? reject(answer) : resolve(answer)) });
            });
        },
        poke: () => {
            state.pokes += 1;
        },
        now: () => clock,
        sleep: async (ms) => {
            clock += ms;
            for (const entry of due.filter((candidate) => candidate.at <= clock)) {
                due.splice(due.indexOf(entry), 1);
                entry.settle();
            }
            // Let a settled Docker answer run its handlers before the loop looks again.
            await Promise.resolve();
            await Promise.resolve();
        },
        selfPid: 50,
        watchMs: 1_000
    });
    return state;
}

const CALL: StopCall = {
    protection: { paneShells: new Map([[200, 'P1']]), kelpi: new Set([100]) },
    interrupt: () => true
};

function callWith(r: Rig, interrupt = true): StopCall {
    return {
        ...CALL,
        interrupt: (paneID) => {
            r.interrupts.push(paneID);
            return interrupt;
        }
    };
}

const sent = (r: Rig, signal: string): number[] => r.signals.filter(([, name]) => name === signal).map(([pid]) => pid);

describe('createRunningStopper', () => {
    it('sends SIGTERM to a stack root first, then everything under it, and SIGCONT after', async () => {
        const r = rig([STACK]);
        const outcome = await r.stopper.stop({ ids: [STACK.id], force: false, confirmed: false }, callWith(r));
        expect(outcome).toMatchObject({ ok: true, results: [{ id: STACK.id, action: 'signal', signal: 'SIGTERM', signalled: 4, remaining: [], stopped: true }] });
        // Never into the interactive shell below turbo, nor the agent under it.
        expect(sent(r, 'SIGTERM')).toEqual([400, 401, 402, 403]);
        expect(r.alive.has(404) && r.alive.has(405)).toBe(true);
        expect(r.pokes).toBeGreaterThan(0);
    });

    it('wakes a suspended job so it sees the SIGTERM', async () => {
        const r = rig([STACK]);
        r.stubborn.add(402);
        await r.stopper.stop({ ids: [STACK.id], force: false, confirmed: false, waitMs: 0 }, callWith(r));
        expect(sent(r, 'SIGCONT')).toContain(402);
    });

    it('refuses a root whose pid now belongs to another process', async () => {
        const r = rig([service('process:400:9999')]);
        const outcome = await r.stopper.stop({ ids: ['process:400:9999'], force: false, confirmed: false }, callWith(r));
        expect(outcome).toMatchObject({ ok: true, results: [{ code: 'NOT_FOUND', action: null }] });
        expect(r.signals).toEqual([]);
    });

    it('reports what is still running after the wait, then ends it with force once the root has gone', async () => {
        const r = rig([STACK]);
        r.stubborn.add(402);
        const first = await r.stopper.stop({ ids: [STACK.id], force: false, confirmed: false, waitMs: 1_000 }, callWith(r));
        expect(first).toMatchObject({ ok: true, results: [{ remaining: [402], stopped: false }] });
        // The root (400) exited: the id no longer resolves in a scan, but the stop remembers 402.
        r.scans = [{ services: [], scannedAt: 1, warnings: [] }];
        const second = await r.stopper.stop({ ids: [STACK.id], force: true, confirmed: false }, callWith(r));
        expect(second).toMatchObject({ ok: true, results: [{ action: 'signal', signal: 'SIGKILL', signalled: 1, stopped: true }] });
        expect(sent(r, 'SIGKILL')).toEqual([402]);
    });

    it('sends Ctrl-C to a foreground job that still owns its terminal', async () => {
        const r = rig([FOREGROUND]);
        const outcome = await r.stopper.stop({ ids: [FOREGROUND.id], force: false, confirmed: false, waitMs: 0 }, callWith(r));
        expect(outcome).toMatchObject({ ok: true, results: [{ action: 'interrupt', signal: null, remaining: null }] });
        expect(r.interrupts).toEqual(['P1']);
        expect(r.signals).toEqual([]);
    });

    it('signals a foreground job that lost the terminal, or whose pane is gone, rather than pressing Ctrl-C', async () => {
        const moved = rig([FOREGROUND]);
        moved.table = moved.table.map((entry) => (entry.pid === 300 || entry.pid === 301 ? { ...entry, tpgid: 999 } : entry));
        await moved.stopper.stop({ ids: [FOREGROUND.id], force: false, confirmed: false, waitMs: 0 }, callWith(moved));
        expect(moved.interrupts).toEqual([]);
        expect(sent(moved, 'SIGTERM')).toEqual([300, 301]);

        const gone = rig([FOREGROUND]);
        await gone.stopper.stop({ ids: [FOREGROUND.id], force: false, confirmed: false, waitMs: 0 }, callWith(gone, false));
        expect(gone.interrupts).toEqual(['P1']);
        expect(sent(gone, 'SIGTERM')).toEqual([300, 301]);
    });

    it('presses Ctrl-C for a server that is its pane own process, and refuses to force it', async () => {
        const own = service('process:200:1200', { name: 'http.server', paneID: 'P1', startedBy: 'pane', agent: null });
        const r = rig([own]);
        r.table = r.table.map((entry) => (entry.pid === 200 ? { ...entry, tpgid: 200 } : entry));
        const outcome = await r.stopper.stop({ ids: [own.id], force: false, confirmed: false, waitMs: 0 }, callWith(r));
        expect(outcome).toMatchObject({ results: [{ action: 'interrupt' }] });
        const forced = await r.stopper.stop({ ids: [own.id], force: true, confirmed: false }, callWith(r));
        expect(forced).toMatchObject({ results: [{ code: 'PROTECTED' }] });
        expect(r.signals).toEqual([]);
    });

    it("refuses an agent's own port, and a service started outside Kelpi until the user confirmed", async () => {
        const agent = service('process:400:1400', { category: 'agent' });
        const outside = service('process:403:1403', { category: 'outside', name: 'vite' });
        const r = rig([agent, outside]);
        const outcome = await r.stopper.stop({ ids: [agent.id, outside.id], force: false, confirmed: false }, callWith(r));
        expect(outcome).toMatchObject({ ok: true, results: [{ code: 'AGENT' }, { code: 'NEEDS_CONFIRM' }] });
        expect(r.signals).toEqual([]);
        const confirmed = await r.stopper.stop({ ids: [outside.id], force: false, confirmed: true }, callWith(r));
        expect(confirmed).toMatchObject({ results: [{ action: 'signal', stopped: true }] });
    });

    it('lets a paired device stop what belongs to a workspace, never what was started outside Kelpi', async () => {
        const outside = service('process:403:1403', { category: 'outside', name: 'vite' });
        const r = rig([STACK, outside]);
        const outcome = await r.stopper.stop({ ids: [STACK.id, outside.id], force: false, confirmed: true, paired: true }, callWith(r));
        expect(outcome).toMatchObject({ results: [{ id: STACK.id, action: 'signal', stopped: true }, { id: outside.id, code: 'OWNER_ONLY', action: null }] });
    });

    it('keeps what is left of a service started outside Kelpi from a paired device once its root has exited', async () => {
        const outside = service('process:400:1400', { category: 'outside', name: 'ollama' });
        const r = rig([outside]);
        r.stubborn.add(402);
        await r.stopper.stop({ ids: [outside.id], force: false, confirmed: true, waitMs: 1_000 }, callWith(r));
        // Its root exited, so the scan no longer lists it, but the owner's stop remembers 402.
        r.scans = [{ services: [], scannedAt: 1, warnings: [] }];
        const phone = await r.stopper.stop({ ids: [outside.id], force: true, confirmed: true, paired: true }, callWith(r));
        expect(phone).toMatchObject({ results: [{ id: outside.id, code: 'OWNER_ONLY', action: null }] });
        expect(sent(r, 'SIGKILL')).toEqual([]);
        const owner = await r.stopper.stop({ ids: [outside.id], force: true, confirmed: true }, callWith(r));
        expect(owner).toMatchObject({ results: [{ action: 'signal', signal: 'SIGKILL', stopped: true }] });
    });

    it("leaves another user's process alone before signalling anything", async () => {
        const theirs = service('process:500:1500', { category: 'outside' });
        const r = rig([theirs]);
        const outcome = await r.stopper.stop({ ids: [theirs.id], force: false, confirmed: true }, callWith(r));
        expect(outcome).toMatchObject({ results: [{ code: 'NOT_YOURS' }] });
        expect(r.signals).toEqual([]);
    });

    it('never signals the daemon, its ancestors, its children, a terminal host or the Kelpi app', async () => {
        const ids = ['process:40:1040', 'process:51:1051', 'process:100:1100', 'process:600:1600'];
        const r = rig(ids.map((id) => service(id, { category: 'outside' })));
        const outcome = await r.stopper.stop({ ids, force: true, confirmed: true }, callWith(r));
        expect(outcome).toMatchObject({ results: ids.map(() => ({ code: 'PROTECTED' })) });
        expect(r.signals).toEqual([]);
    });

    it('stops one member and what is under it, and refuses a pid outside the stack', async () => {
        const r = rig([STACK]);
        const outcome = await r.stopper.stop({ ids: [STACK.id], member: '402', force: false, confirmed: false }, callWith(r));
        expect(outcome).toMatchObject({ results: [{ signalled: 1, stopped: true }] });
        expect(sent(r, 'SIGTERM')).toEqual([402]);
        const outside = await r.stopper.stop({ ids: [STACK.id], member: '500', force: false, confirmed: false }, callWith(r));
        expect(outside).toMatchObject({ results: [{ code: 'NOT_FOUND' }] });
    });

    it('finds a service by port, and refuses a port two services hold', async () => {
        const r = rig([STACK, service('process:403:1403', { ports: STACK.ports })]);
        const ambiguous = await r.stopper.stop({ port: STACK.ports[0]?.port, force: false, confirmed: false }, callWith(r));
        expect(ambiguous).toMatchObject({ ok: false, code: 'AMBIGUOUS_PORT', candidates: [STACK.id, 'process:403:1403'] });
        expect(await r.stopper.stop({ port: 1, force: false, confirmed: false }, callWith(r))).toMatchObject({ ok: false, code: 'PORT_NOT_FOUND' });
        const single = rig([STACK]);
        expect(await single.stopper.stop({ port: STACK.ports[0]?.port, force: false, confirmed: false }, callWith(single))).toMatchObject({
            ok: true,
            results: [{ id: STACK.id, stopped: true }]
        });
    });

    it("asks Docker to stop each container, counting gone and stopped ones as stopped", async () => {
        const compose = service('compose:shop', {
            kind: 'compose',
            pid: null,
            members: ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc'].map((containerID) => ({ name: containerID, pid: null, containerID, image: 'img', ports: [], rssBytes: null }))
        });
        const r = rig([compose]);
        r.dockerStatus = (path) => (path.includes('aaaa') ? 304 : path.includes('bbbb') ? 404 : 500);
        const outcome = await r.stopper.stop({ ids: [compose.id], force: false, confirmed: false }, callWith(r));
        expect(r.docker).toEqual(['/containers/aaaaaaaaaaaa/stop', '/containers/bbbbbbbbbbbb/stop', '/containers/cccccccccccc/stop']);
        expect(outcome).toMatchObject({ results: [{ action: 'stop-containers', signalled: 3, failed: ['cccccccccccc: Docker answered 500'], stopped: false }] });

        const forced = rig([compose]);
        forced.dockerStatus = () => 409;
        const killed = await forced.stopper.stop({ ids: [compose.id], member: 'bbbbbbbbbbbb', force: true, confirmed: false }, callWith(forced));
        expect(forced.docker).toEqual(['/containers/bbbbbbbbbbbb/kill']);
        expect(killed).toMatchObject({ results: [{ failed: [], stopped: true }] });
    });

    it('answers at once without a wait, then pokes the scan loop', async () => {
        const r = rig([STACK]);
        const outcome = await r.stopper.stop({ ids: [STACK.id], force: false, confirmed: false, waitMs: 0 }, callWith(r));
        expect(outcome).toMatchObject({ results: [{ remaining: null, stopped: null }] });
        expect(r.pokes).toBeGreaterThan(0);
    });

    it('refuses everything when processes cannot be listed, rather than calling them stopped', async () => {
        const warned = rig([STACK], { warnings: ['processes: ps did not finish'] });
        expect(await warned.stopper.stop({ ids: [STACK.id], force: false, confirmed: false }, callWith(warned))).toMatchObject({
            ok: false,
            code: 'SCAN_INCOMPLETE'
        });
        expect(warned.signals).toEqual([]);
    });

    it('says when a supervisor started it again on its port', async () => {
        const r = rig([STACK]);
        r.scans = [
            { services: [STACK], scannedAt: 0, warnings: [] },
            { services: [service('process:403:1403', { name: 'apps/web again', ports: STACK.ports })], scannedAt: 1, warnings: [] }
        ];
        const outcome = await r.stopper.stop({ ids: [STACK.id], force: false, confirmed: false }, callWith(r));
        expect(outcome).toMatchObject({ results: [{ stopped: true, restartedBy: 'apps/web again' }] });
    });

    it('remembers a Ctrl-C, so the next plain stop sends SIGTERM and Force still finds what is left', async () => {
        const r = rig([FOREGROUND]);
        r.alive.add(301);
        // pnpm (300) exits on Ctrl-C; its server (301) ignores it.
        const call: StopCall = {
            ...CALL,
            interrupt: (paneID) => {
                r.interrupts.push(paneID);
                r.alive.delete(300);
                return true;
            }
        };
        const first = await r.stopper.stop({ ids: [FOREGROUND.id], force: false, confirmed: false, waitMs: 400 }, call);
        expect(first).toMatchObject({ results: [{ action: 'interrupt', remaining: [301], stopped: false }] });
        // The root has gone, so the id resolves only through what the Ctrl-C was sent to.
        r.scans = [{ services: [], scannedAt: 1, warnings: [] }];
        const forced = await r.stopper.stop({ ids: [FOREGROUND.id], force: true, confirmed: false }, call);
        expect(forced).toMatchObject({ results: [{ action: 'signal', signal: 'SIGKILL', stopped: true }] });
        expect(sent(r, 'SIGKILL')).toEqual([301]);
    });

    it('sends SIGTERM rather than a second Ctrl-C to a foreground job that ignored the first', async () => {
        const r = rig([FOREGROUND]);
        r.stubborn.add(300);
        const call = callWith(r);
        await r.stopper.stop({ ids: [FOREGROUND.id], force: false, confirmed: false, waitMs: 400 }, call);
        expect(r.interrupts).toEqual(['P1']);
        const again = await r.stopper.stop({ ids: [FOREGROUND.id], force: false, confirmed: false, waitMs: 0 }, call);
        expect(again).toMatchObject({ results: [{ action: 'signal', signal: 'SIGTERM' }] });
        expect(r.interrupts).toEqual(['P1']);
        expect(sent(r, 'SIGTERM')).toEqual([300, 301]);
    });

    it('keeps a member stop to that member, even after the root has exited', async () => {
        const r = rig([STACK]);
        r.stubborn.add(402);
        r.stubborn.add(403);
        await r.stopper.stop({ ids: [STACK.id], force: false, confirmed: false, waitMs: 400 }, callWith(r));
        r.scans = [{ services: [], scannedAt: 1, warnings: [] }];
        r.signals.length = 0;
        const member = await r.stopper.stop({ ids: [STACK.id], member: '403', force: true, confirmed: false }, callWith(r));
        expect(member).toMatchObject({ results: [{ stopped: true }] });
        expect(sent(r, 'SIGKILL')).toEqual([403]);
        expect(r.alive.has(402)).toBe(true);
    });

    it('does not call a service that already shared the port a restart', async () => {
        // A neighbour on the same port (one on `::1`, one on `127.0.0.1`), outside the stack.
        const neighbour = service('process:403:1403', { name: 'vite on ::1', ports: STACK.ports });
        const r = rig([STACK, neighbour]);
        r.table = r.table.map((entry) => (entry.pid === 403 ? { ...entry, ppid: 1 } : entry));
        r.scans = [
            { services: [STACK, neighbour], scannedAt: 0, warnings: [] },
            { services: [neighbour], scannedAt: 1, warnings: [] }
        ];
        const stopped = await r.stopper.stop({ ids: [STACK.id], force: false, confirmed: false }, callWith(r));
        expect(stopped).toMatchObject({ results: [{ stopped: true, restartedBy: null }] });
    });

    it("waits for Docker's own stop timeout rather than calling a slow container still running", async () => {
        const compose = service('compose:shop', {
            kind: 'compose',
            pid: null,
            members: [{ name: 'api', pid: null, containerID: 'aaaaaaaaaaaa', image: 'img', ports: [], rssBytes: null }]
        });
        const r = rig([compose]);
        r.dockerDelayMs = 10_000;
        const outcome = await r.stopper.stop({ ids: [compose.id], force: false, confirmed: false, waitMs: 5_000 }, callWith(r));
        expect(outcome).toMatchObject({ results: [{ action: 'stop-containers', remaining: [], stopped: true }] });
    });

    it('does not count a zombie as still running', async () => {
        const r = rig([STACK]);
        r.stubborn.add(402);
        r.table = r.table.map((entry) => (entry.pid === 402 ? { ...entry, args: '<defunct>' } : entry));
        const outcome = await r.stopper.stop({ ids: [STACK.id], force: false, confirmed: false, waitMs: 400 }, callWith(r));
        expect(outcome).toMatchObject({ results: [{ remaining: [], stopped: true }] });
    });
});
