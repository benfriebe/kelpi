/**
 * Stopping running services (docs/running-services.md §6, phase 3): `running-stop`, `kelpi kill`,
 * the app's Stop buttons and `workspace-delete`'s `stop_services`.
 *
 * What each kind gets:
 *
 *   - a pane's foreground job, or a server that IS a pane's process: Ctrl-C to the pane, once a
 *     fresh `ps` says the job still owns the terminal (else it is signalled like a stack, or for a
 *     pane's own process refused: ending it ends the pane);
 *   - a process stack: SIGTERM (SIGKILL with `force`) to the root and every process under it,
 *     root first, then SIGCONT so a job suspended with Ctrl-Z sees it;
 *   - a compose project or container: Docker's stop (kill with `force`) per container, never
 *     `down`, so volumes and data stay.
 *
 * Safety rules, each checked against a `ps` taken for this stop, never against the scan the
 * caller saw: the root must still have the start time in its id, so a reused pid is never
 * signalled; the daemon, its ancestors and its own children, its terminal hosts, the Kelpi app,
 * pane shells and pid 1 are never signalled; the walk down a stack stops at a pane shell, an
 * interactive shell and an agent (a Kelpi dev instance's panes, a tmux server's shells); another
 * user's process is left alone. The only pids ever signalled are ones this module found itself,
 * in a scan or in the memory of an earlier stop (`STOP_MEMORY_MS`), never one a caller named,
 * except a member, which must be inside the stack.
 */

import { RUNNING_STOP_DEFAULT_WAIT_MS, type RunningStopAction, type RunningStopCode, type RunningStopRequestCode } from '@kelpi/protocol';

import { childrenOf } from './attribute.js';
import { agentOf, isInteractiveShell } from './parse.js';
import type { ProcessRow, RunningScan, RunningService } from './types.js';

/** How long a stop's processes are remembered, for a second stop after the root has exited. */
export const STOP_MEMORY_MS = 10 * 60_000;
/** How often a wait checks whether the stopped processes have exited. */
export const STOP_POLL_MS = 200;
/** After a stop nobody waits for, how long to watch for the exits before the monitor's last poke. */
export const STOP_WATCH_MS = 10_000;
/** Docker answers a stop once the container has stopped: up to its own stop timeout, 10 s unless set. */
export const DOCKER_STOP_TIMEOUT_MS = 35_000;
export const DOCKER_KILL_TIMEOUT_MS = 10_000;

export interface StopProtection {
    /** Pane shell pid → its pane id. Never signalled; a server that is a pane's own process gets Ctrl-C. */
    readonly paneShells: ReadonlyMap<number, string>;
    /** Kelpi's own processes besides the daemon: its terminal hosts. */
    readonly kelpi: ReadonlySet<number>;
}

export interface StopRequest {
    readonly ids?: readonly string[] | undefined;
    readonly port?: number | undefined;
    readonly member?: string | undefined;
    readonly force: boolean;
    readonly confirmed: boolean;
    readonly waitMs?: number | undefined;
}

/** What only the caller's context knows: the pane shells and hosts now, and how to press Ctrl-C. */
export interface StopCall {
    readonly protection: StopProtection;
    /** Ctrl-C to the pane; false when the pane is gone. */
    readonly interrupt: (paneID: string) => boolean;
}

export interface StopResult {
    readonly id: string;
    readonly name: string;
    readonly ports: readonly number[];
    readonly action: RunningStopAction | null;
    readonly signal: 'SIGTERM' | 'SIGKILL' | null;
    readonly signalled: number;
    readonly skipped: readonly number[];
    readonly failed: readonly string[];
    readonly remaining: readonly (number | string)[] | null;
    readonly stopped: boolean | null;
    readonly restartedBy: string | null;
    readonly error?: string;
    readonly code?: RunningStopCode;
}

export type StopOutcome =
    | { readonly ok: true; readonly results: readonly StopResult[] }
    | { readonly ok: false; readonly code: RunningStopRequestCode; readonly error: string; readonly candidates?: readonly string[] };

export interface RunningStopper {
    stop(request: StopRequest, call: StopCall): Promise<StopOutcome>;
}

export interface RunningStopperDeps {
    /** The scanner's answer; a cached one is fine, since every pid is rechecked against a fresh `ps`. */
    scan(options?: { readonly since?: number | undefined }): Promise<RunningScan>;
    processTable(): Promise<ProcessRow[]>;
    /** `process.kill`: throws the errno error (`ESRCH`, `EPERM`). Signal 0 only checks. */
    signal(pid: number, signal: NodeJS.Signals | 0): void;
    /** A Docker engine POST, answering its status; rejects when there is no engine or on a timeout. */
    docker(path: string, timeoutMs: number): Promise<number>;
    /** Ask the scan loop for a new list soon (the monitor's `poke`). */
    poke(): void;
    now?: (() => number) | undefined;
    sleep?: ((ms: number) => Promise<void>) | undefined;
    /** The daemon's own pid; `process.pid` by default. */
    selfPid?: number | undefined;
    pollMs?: number | undefined;
    watchMs?: number | undefined;
}

interface Remembered {
    readonly name: string;
    readonly ports: readonly number[];
    readonly processes: readonly { readonly pid: number; readonly startedAt: number }[];
    /** How it was stopped: after a Ctrl-C the next plain stop sends SIGTERM rather than Ctrl-C again. */
    readonly via: 'interrupt' | 'signal';
    readonly at: number;
}

/** A member's stop is remembered apart, so it never replaces the record of the whole service's. */
function memoryKey(id: string, member: string | undefined): string {
    return member === undefined ? id : `${id}#${member}`;
}

function errnoCode(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException | null)?.code;
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function refused(
    service: { readonly id: string; readonly name: string; readonly ports?: readonly number[] },
    code: RunningStopCode,
    error: string
): StopResult {
    return {
        id: service.id,
        name: service.name,
        ports: service.ports ?? [],
        action: null,
        signal: null,
        signalled: 0,
        skipped: [],
        failed: [],
        remaining: null,
        stopped: null,
        restartedBy: null,
        error,
        code
    };
}

/** `process:<pid>:<start>` → the root's pid and start (epoch seconds). */
function processIdentity(id: string): { readonly pid: number; readonly startedAt: number } | null {
    const match = /^process:(\d+):(\d+)$/.exec(id);
    return match === null ? null : { pid: Number(match[1]), startedAt: Number(match[2]) };
}

const DEFUNCT = /<defunct>/;

/** A planned signal stop: what to signal, root first, and who to tell. */
interface SignalPlan {
    readonly kind: 'signal';
    readonly service: { readonly id: string; readonly name: string; readonly ports: readonly number[] };
    readonly targets: readonly ProcessRow[];
    readonly rootPid: number;
}

interface InterruptPlan {
    readonly kind: 'interrupt';
    readonly service: { readonly id: string; readonly name: string; readonly ports: readonly number[] };
    readonly paneID: string;
    /** The job's processes, for the wait. */
    readonly watch: readonly ProcessRow[];
    /** When the pane turns out to be gone: signal instead, or refuse (a pane's own process). */
    readonly fallback: SignalPlan | null;
}

interface ContainerPlan {
    readonly kind: 'containers';
    readonly service: { readonly id: string; readonly name: string; readonly ports: readonly number[] };
    readonly containers: readonly string[];
}

type Plan = SignalPlan | InterruptPlan | ContainerPlan | { readonly kind: 'refused'; readonly result: StopResult };

/** A stop in progress: what was done to one service, and what is left to wait for. */
interface Running {
    readonly plan: SignalPlan | InterruptPlan | ContainerPlan;
    action: RunningStopAction;
    signal: 'SIGTERM' | 'SIGKILL' | null;
    signalled: number;
    readonly skipped: number[];
    readonly failed: string[];
    /** Processes to wait for. */
    watch: ProcessRow[];
    /** Containers still stopping; each leaves once Docker answers. */
    readonly pending: Map<string, Promise<void>>;
    refusal?: StopResult;
}

function resultOf(entry: Running, remaining: readonly (number | string)[] | null): StopResult {
    if (entry.refusal !== undefined) return entry.refusal;
    return {
        id: entry.plan.service.id,
        name: entry.plan.service.name,
        ports: entry.plan.service.ports,
        action: entry.action,
        signal: entry.signal,
        signalled: entry.signalled,
        skipped: entry.skipped,
        failed: entry.failed,
        remaining,
        stopped: remaining === null ? null : remaining.length === 0 && entry.failed.length === 0,
        restartedBy: null
    };
}

export function createRunningStopper(deps: RunningStopperDeps): RunningStopper {
    const now = deps.now ?? (() => Date.now());
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const selfPid = deps.selfPid ?? process.pid;
    const pollMs = deps.pollMs ?? STOP_POLL_MS;
    const watchMs = deps.watchMs ?? STOP_WATCH_MS;
    const memory = new Map<string, Remembered>();

    function forget(): void {
        const cutoff = now() - STOP_MEMORY_MS;
        for (const [id, entry] of memory) if (entry.at < cutoff) memory.delete(id);
    }

    function alive(pid: number): boolean {
        try {
            deps.signal(pid, 0);
            return true;
        } catch (error) {
            // EPERM: it exists, it is just not ours. Only ESRCH means gone.
            return errnoCode(error) === 'EPERM';
        }
    }

    /** After a stop nobody waits for: poke the scan loop once what was stopped has exited. */
    async function watchExits(rows: readonly ProcessRow[], containers: readonly Promise<void>[]): Promise<void> {
        const deadline = now() + watchMs;
        let left = rows;
        while (left.length > 0 && now() < deadline) {
            await sleep(pollMs);
            left = left.filter((row) => alive(row.pid));
        }
        await Promise.allSettled(containers);
        deps.poke();
    }

    async function stop(request: StopRequest, call: StopCall): Promise<StopOutcome> {
        forget();
        const waitMs = request.waitMs ?? RUNNING_STOP_DEFAULT_WAIT_MS;
        const signal: 'SIGTERM' | 'SIGKILL' = request.force ? 'SIGKILL' : 'SIGTERM';
        const scan = await deps.scan();
        if (scan.warnings.some((warning) => warning.startsWith('processes:'))) {
            return { ok: false, code: 'SCAN_INCOMPLETE', error: `cannot list processes (${scan.warnings.join('; ')}), so nothing was stopped` };
        }

        // What was asked for, in the order asked.
        let wanted: { readonly id: string; readonly service: RunningService | null }[];
        if (request.port !== undefined) {
            const port = request.port;
            const holders = scan.services.filter((service) => service.ports.some((entry) => entry.port === port));
            if (holders.length === 0) return { ok: false, code: 'PORT_NOT_FOUND', error: `nothing is listening on port ${String(port)}` };
            if (holders.length > 1) {
                return {
                    ok: false,
                    code: 'AMBIGUOUS_PORT',
                    error: `${String(holders.length)} services listen on port ${String(port)}: ${holders
                        .map((holder) => `${holder.name} (${holder.id})`)
                        .join(', ')}; stop one by id`,
                    candidates: holders.map((holder) => holder.id)
                };
            }
            const holder = holders[0] as RunningService;
            wanted = [{ id: holder.id, service: holder }];
        } else {
            wanted = [...new Set(request.ids ?? [])].map((id) => ({ id, service: scan.services.find((service) => service.id === id) ?? null }));
        }

        let table: ProcessRow[];
        try {
            table = await deps.processTable();
        } catch (error) {
            return { ok: false, code: 'SCAN_INCOMPLETE', error: `cannot list processes (${message(error)}), so nothing was stopped` };
        }
        const byPid = new Map(table.map((row) => [row.pid, row]));
        const children = childrenOf(table);
        const paneShells = call.protection.paneShells;
        const guarded = protectedPids(table, byPid, children, call.protection, selfPid);

        /** The root (or member) and everything under it, root first. */
        function subtree(start: ProcessRow): ProcessRow[] {
            const order: ProcessRow[] = [start];
            const seen = new Set<number>([start.pid]);
            for (let index = 0; index < order.length; index += 1) {
                for (const child of children.get((order[index] as ProcessRow).pid) ?? []) {
                    if (seen.has(child) || guarded.has(child)) continue;
                    seen.add(child);
                    const row = byPid.get(child);
                    // A shell someone types into, or an agent, below the stack is not the stack's:
                    // a Kelpi dev instance's panes, a tmux server's sessions.
                    if (row === undefined || isInteractiveShell(row.args) || agentOf(row.args) !== null) continue;
                    order.push(row);
                }
            }
            return order;
        }

        /**
         * What an earlier stop of this id left running, still with the same start times. With a
         * member, only that member and what runs under it, from either the member's own record or
         * the whole service's.
         */
        function remembered(id: string): SignalPlan | null {
            const member = request.member;
            const entries = [memory.get(memoryKey(id, member)), member === undefined ? undefined : memory.get(id)].filter(
                (entry): entry is Remembered => entry !== undefined
            );
            const first = entries[0];
            if (first === undefined) return null;
            const alive = (process: { readonly pid: number; readonly startedAt: number }): ProcessRow | null => {
                const row = byPid.get(process.pid);
                return row !== undefined && row.startedAt === process.startedAt && !guarded.has(row.pid) && !DEFUNCT.test(row.args) ? row : null;
            };
            const roots = entries
                .flatMap((entry) => entry.processes)
                .filter((process) => member === undefined || String(process.pid) === member)
                .map(alive)
                .filter((row): row is ProcessRow => row !== null);
            if (roots.length === 0) return null;
            const targets = new Map<number, ProcessRow>();
            for (const root of roots) for (const row of subtree(root)) targets.set(row.pid, row);
            return { kind: 'signal', service: { id, name: first.name, ports: first.ports }, targets: [...targets.values()], rootPid: (roots[0] as ProcessRow).pid };
        }

        function planFor(item: { readonly id: string; readonly service: RunningService | null }): Plan {
            const service = item.service;
            if (service === null) {
                return remembered(item.id) ?? { kind: 'refused', result: refused({ id: item.id, name: item.id }, 'NOT_FOUND', `${item.id} is not running`) };
            }
            const summary = { id: service.id, name: service.name, ports: service.ports.map((entry) => entry.port) };
            if (service.category === 'agent') {
                return { kind: 'refused', result: refused(summary, 'AGENT', `${service.name} is the agent itself; close its pane to end it`) };
            }
            if (service.category === 'outside' && !request.confirmed) {
                return {
                    kind: 'refused',
                    result: refused(summary, 'NEEDS_CONFIRM', `${service.name} was started outside Kelpi (${service.command}); ask the user before stopping it`)
                };
            }
            if (service.kind !== 'process') {
                const containers = service.members.map((member) => member.containerID).filter((id): id is string => id !== null);
                const member = request.member;
                const chosen = member === undefined ? containers : containers.filter((id) => id.startsWith(member) || member.startsWith(id));
                if (chosen.length === 0) return { kind: 'refused', result: refused(summary, 'NOT_FOUND', `${service.name} has no container ${member ?? ''}`.trim()) };
                return { kind: 'containers', service: summary, containers: chosen };
            }

            const identity = processIdentity(service.id);
            const root = identity === null ? undefined : byPid.get(identity.pid);
            if (identity === null || root === undefined || root.startedAt !== identity.startedAt || DEFUNCT.test(root.args)) {
                // The root has exited (or its pid was reused): what an earlier stop left running.
                return remembered(service.id) ?? { kind: 'refused', result: refused(summary, 'NOT_FOUND', `${service.name} has already stopped`) };
            }
            let start = root;
            if (request.member !== undefined) {
                const member = byPid.get(Number(request.member));
                if (member === undefined || !subtree(root).some((row) => row.pid === member.pid)) {
                    return { kind: 'refused', result: refused(summary, 'NOT_FOUND', `process ${request.member} is not part of ${service.name}`) };
                }
                start = member;
            }

            const ownsTerminal = (row: ProcessRow): boolean => row.tpgid > 0 && row.pgid === row.tpgid;
            const paneOfStart = paneShells.get(start.pid);
            if (paneOfStart !== undefined) {
                // The server is the pane's own process: Ctrl-C reaches it, a signal would end the pane.
                if (request.force || !ownsTerminal(start)) {
                    return { kind: 'refused', result: refused(summary, 'PROTECTED', `${service.name} is its pane's own process; close the pane to end it`) };
                }
                return { kind: 'interrupt', service: summary, paneID: paneOfStart, watch: [start], fallback: null };
            }
            if (guarded.has(start.pid)) {
                return { kind: 'refused', result: refused(summary, 'PROTECTED', `${service.name} is part of Kelpi; it is never stopped from here`) };
            }
            const signalPlan: SignalPlan = { kind: 'signal', service: summary, targets: subtree(start), rootPid: start.pid };
            // A pane's foreground job gets Ctrl-C, as long as it still owns the terminal: otherwise
            // the Ctrl-C would land on whatever is in the foreground now (an agent's turn, say).
            // If Ctrl-C already failed to stop it, the next stop sends SIGTERM instead.
            const interrupted = memory.get(service.id)?.via === 'interrupt';
            if (request.member === undefined && !request.force && !interrupted && service.foreground && service.paneID !== null && ownsTerminal(start)) {
                return { kind: 'interrupt', service: summary, paneID: service.paneID, watch: signalPlan.targets, fallback: signalPlan };
            }
            return signalPlan;
        }

        function signalAll(plan: SignalPlan, into: Running): void {
            into.action = 'signal';
            into.signal = signal;
            const live: ProcessRow[] = [];
            for (const row of plan.targets) {
                try {
                    deps.signal(row.pid, 0);
                    live.push(row);
                } catch (error) {
                    if (errnoCode(error) === 'EPERM') {
                        if (row.pid === plan.rootPid) {
                            into.refusal = refused(plan.service, 'NOT_YOURS', `${plan.service.name} belongs to another user`);
                            return;
                        }
                        into.skipped.push(row.pid);
                    }
                    // ESRCH: it exited between the `ps` and now, which is what we wanted.
                }
            }
            for (const row of live) {
                try {
                    deps.signal(row.pid, signal);
                    into.signalled += 1;
                    into.watch.push(row);
                } catch (error) {
                    const code = errnoCode(error);
                    if (code === 'EPERM') into.skipped.push(row.pid);
                    else if (code !== 'ESRCH') into.failed.push(`${String(row.pid)}: ${code ?? message(error)}`);
                }
            }
            // A stopped (Ctrl-Z) process keeps a pending SIGTERM until it runs again.
            if (signal === 'SIGTERM') {
                for (const row of into.watch) {
                    try {
                        deps.signal(row.pid, 'SIGCONT');
                    } catch {
                        // Gone already.
                    }
                }
            }
            if (into.watch.length > 0) remember(plan.service, into.watch, 'signal');
        }

        function remember(service: SignalPlan['service'], rows: readonly ProcessRow[], via: Remembered['via']): void {
            memory.set(memoryKey(service.id, request.member), {
                name: service.name,
                ports: service.ports,
                processes: rows.map((row) => ({ pid: row.pid, startedAt: row.startedAt })),
                via,
                at: now()
            });
        }

        function begin(plan: SignalPlan | InterruptPlan | ContainerPlan): Running {
            const entry: Running = { plan, action: 'signal', signal: null, signalled: 0, skipped: [], failed: [], watch: [], pending: new Map() };
            if (plan.kind === 'signal') {
                signalAll(plan, entry);
            } else if (plan.kind === 'interrupt') {
                if (call.interrupt(plan.paneID)) {
                    entry.action = 'interrupt';
                    entry.watch = [...plan.watch];
                    // So Force stop still finds what ignored the Ctrl-C once the job's first
                    // process has exited, and a second plain stop escalates to SIGTERM.
                    remember(plan.service, plan.watch, 'interrupt');
                } else if (plan.fallback !== null) {
                    signalAll(plan.fallback, entry);
                } else {
                    entry.refusal = refused(plan.service, 'PROTECTED', `${plan.service.name} is its pane's own process, and the pane is gone`);
                }
            } else {
                entry.action = 'stop-containers';
                for (const id of plan.containers) {
                    const path = `/containers/${encodeURIComponent(id)}/${request.force ? 'kill' : 'stop'}`;
                    const settled = deps
                        .docker(path, request.force ? DOCKER_KILL_TIMEOUT_MS : DOCKER_STOP_TIMEOUT_MS)
                        .then(
                            (status) => {
                                // 304: already stopped; 404: gone (an `--rm` container); 409 on kill: not running.
                                if (status >= 400 && status !== 404 && !(request.force && status === 409)) {
                                    entry.failed.push(`${id}: Docker answered ${String(status)}`);
                                }
                            },
                            (error: unknown) => {
                                entry.failed.push(`${id}: ${message(error)}`);
                            }
                        )
                        .finally(() => {
                            entry.pending.delete(id);
                        });
                    entry.pending.set(id, settled);
                    entry.signalled += 1;
                }
            }
            return entry;
        }

        const started = wanted.map(planFor).map((plan) => (plan.kind === 'refused' ? plan.result : begin(plan)));
        const live = started.filter((entry): entry is Running => 'plan' in entry && entry.refusal === undefined);
        const finish = (remainingOf: (entry: Running) => readonly (number | string)[] | null): StopResult[] =>
            started.map((entry) => ('plan' in entry ? resultOf(entry, remainingOf(entry)) : entry));

        if (waitMs === 0) {
            deps.poke();
            void watchExits(
                live.flatMap((entry) => entry.watch),
                live.flatMap((entry) => [...entry.pending.values()])
            );
            return { ok: true, results: finish(() => null) };
        }

        // Wait for the processes to exit, to the deadline. Docker answers a stop only once the
        // container has stopped, after its own stop timeout (10 s unless the project set another),
        // so containers are waited for to that answer rather than cut off at the processes' wait.
        const deadline = now() + waitMs;
        const containersDeadline = now() + Math.max(waitMs, DOCKER_STOP_TIMEOUT_MS);
        let left = live.flatMap((entry) => entry.watch);
        for (;;) {
            left = left.filter((row) => alive(row.pid));
            const containersPending = live.some((entry) => entry.pending.size > 0);
            const processesDone = left.length === 0 || now() >= deadline;
            if (processesDone && (!containersPending || now() >= containersDeadline)) break;
            const until = left.length > 0 && now() < deadline ? deadline : containersDeadline;
            await sleep(Math.min(pollMs, Math.max(0, until - now())));
        }
        left = left.filter((row) => alive(row.pid));
        // `kill(pid, 0)` also answers for a zombie and for a reused pid: a fresh `ps` decides.
        let stillRunning = new Set<number>();
        if (left.length > 0) {
            try {
                const after = new Map((await deps.processTable()).map((row) => [row.pid, row]));
                stillRunning = new Set(
                    left
                        .filter((row) => {
                            const current = after.get(row.pid);
                            return current !== undefined && current.startedAt === row.startedAt && !DEFUNCT.test(current.args);
                        })
                        .map((row) => row.pid)
                );
            } catch {
                stillRunning = new Set(left.map((row) => row.pid));
            }
        }
        let results = finish((entry) => [...entry.watch.filter((row) => stillRunning.has(row.pid)).map((row) => row.pid), ...entry.pending.keys()]);

        // A supervisor (turbo, pm2, a launchd KeepAlive job) may have started it again on its port.
        const portsByID = new Map(live.map((entry) => [entry.plan.service.id, entry.plan.service.ports]));
        if (results.some((result) => result.stopped === true && (portsByID.get(result.id)?.length ?? 0) > 0)) {
            try {
                const again = await deps.scan({ since: now() });
                // A service that already held one of the ports before the stop is a neighbour (one
                // on `::1` beside one on `127.0.0.1`), not a restart.
                const before = new Set(scan.services.map((service) => service.id));
                results = results.map((result) => {
                    const ports = portsByID.get(result.id) ?? [];
                    if (result.stopped !== true || ports.length === 0) return result;
                    const successor = again.services.find(
                        (service) => !before.has(service.id) && service.ports.some((entry) => ports.includes(entry.port))
                    );
                    return successor === undefined ? result : { ...result, restartedBy: successor.name };
                });
            } catch {
                // No answer about restarts is not a failed stop.
            }
        }
        deps.poke();
        return { ok: true, results };
    }

    return { stop };
}

/**
 * What is never signalled: pid 0 and 1, the daemon, its ancestors (ending its parent can end it)
 * and its own children down to the pane shells (plugin backends, a terminal host it started), its
 * terminal hosts, the pane shells, and the Kelpi app wherever it was installed.
 */
function protectedPids(
    table: readonly ProcessRow[],
    byPid: ReadonlyMap<number, ProcessRow>,
    children: ReadonlyMap<number, readonly number[]>,
    protection: StopProtection,
    selfPid: number
): Set<number> {
    const out = new Set<number>([0, 1, selfPid, ...protection.kelpi, ...protection.paneShells.keys()]);
    let row = byPid.get(selfPid);
    for (let depth = 0; row !== undefined && depth < 64 && row.ppid > 1; depth += 1) {
        out.add(row.ppid);
        row = byPid.get(row.ppid);
    }
    const queue = [selfPid];
    const seen = new Set(queue);
    for (let index = 0; index < queue.length; index += 1) {
        for (const child of children.get(queue[index] as number) ?? []) {
            if (seen.has(child) || protection.paneShells.has(child)) continue;
            seen.add(child);
            out.add(child);
            queue.push(child);
        }
    }
    for (const entry of table) if (/\/Kelpi\.app\/Contents\//.test(entry.args)) out.add(entry.pid);
    return out;
}

/** A stopper with nothing to stop: the default for handler tables built without a host (tests). */
export const INERT_RUNNING_STOPPER: RunningStopper = {
    stop: (request) =>
        Promise.resolve({
            ok: true,
            results: (request.ids ?? []).map((id) => refused({ id, name: id }, 'NOT_FOUND', `${id} is not running`))
        })
};
