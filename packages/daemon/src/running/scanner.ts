/**
 * The scan: probes in parallel, attribution, one `RunningScan`. Concurrent callers share the
 * scan in flight, and a result is reused for `cacheMs`, so a burst of `kelpi ps` runs (an agent
 * polling) costs one set of probes. Working directories are cached per process (pid and start
 * time), so only processes new since the last scan are looked up.
 *
 * Phase 1 scans on demand only. The periodic loop and the WebSocket broadcast come with the UI
 * (docs/running-services.md §8).
 */

import { buildServices, planProcessStacks } from './attribute.js';
import { PROBE_TIMEOUT_MS, type RunningProbes } from './probes.js';
import type { ContainerStats } from './container-stats.js';
import { createCpuSampler } from './cpu.js';
import type { ContainerRow, ListenSocket, PaneShellRef, ProcessRow, RunningScan, WorkspaceFolders } from './types.js';

/** How long one scan's answer is reused. */
export const RUNNING_SCAN_CACHE_MS = 1_500;

/**
 * The most any probe may take, past its own timeout. A child that outlives even SIGKILL, or a
 * socket that never closes, must not leave the shared scan (and every later caller) pending.
 */
const PROBE_DEADLINE_MS = PROBE_TIMEOUT_MS + 2_000;

function withDeadline<T>(promise: Promise<T>, label: string, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`${label} did not finish`));
        }, ms);
        timer.unref();
    });
    return Promise.race([promise, deadline]).finally(() => {
        clearTimeout(timer);
    });
}

/** Everything a scan needs from the daemon, read at the moment the scan starts. */
export interface ScanContext {
    /** Pane shell pid → its pane. */
    readonly paneShells: ReadonlyMap<number, PaneShellRef>;
    readonly workspaces: readonly WorkspaceFolders[];
    /** Worktree and repo folders: services there with no workspace are listed as unattached. */
    readonly knownFolders: readonly string[];
    /** The folders each known repo's worktrees are created in: a worktree is one folder below. */
    readonly worktreeBases?: readonly string[] | undefined;
    /** Kelpi's own processes (the daemon): never services. */
    readonly selfPids: ReadonlySet<number>;
    /** Workspace ids in sidebar order, for sorting. */
    readonly workspaceOrder: readonly string[];
}

export interface RunningScanner {
    /**
     * The latest scan, shared and briefly cached. With `since`, only one that began at or after
     * it: a caller that knows something just changed (an agent ended a turn) must not get a scan
     * taken before the change.
     */
    scan(options?: { readonly since?: number | undefined }): Promise<RunningScan>;
}

export interface RunningScannerOptions {
    readonly probes: RunningProbes;
    readonly context: () => ScanContext;
    readonly now?: (() => number) | undefined;
    readonly cacheMs?: number | undefined;
    /** Per-probe deadline (tests). */
    readonly deadlineMs?: number | undefined;
    /** Containers' last known memory and CPU, read but never refreshed by a scan. */
    readonly containerStats?: ContainerStats | undefined;
}

function describe(error: unknown, probe: string): string {
    return `${probe}: ${error instanceof Error ? error.message : String(error)}`;
}

export function createRunningScanner(options: RunningScannerOptions): RunningScanner {
    const now = options.now ?? (() => Date.now());
    const cacheMs = options.cacheMs ?? RUNNING_SCAN_CACHE_MS;
    const deadlineMs = options.deadlineMs ?? PROBE_DEADLINE_MS;
    const { probes } = options;
    let inFlight: { readonly promise: Promise<RunningScan>; readonly startedAt: number } | null = null;
    let last: { readonly scan: RunningScan; readonly startedAt: number } | null = null;
    /** `${pid}:${startedAt}` → working directory. Pruned to the live processes each scan. */
    let cwdCache = new Map<string, string>();
    const cpu = createCpuSampler();

    async function runScan(): Promise<RunningScan> {
        const context = options.context();
        const warnings: string[] = [];
        // When `ps` ran, for the CPU rates; `scannedAt` is taken at the end.
        const psAt = now();
        let psRan = true;
        const [processes, listeners, containers] = await Promise.all([
            withDeadline(probes.processTable(), 'ps', deadlineMs).catch((error: unknown): ProcessRow[] => {
                warnings.push(describe(error, 'processes'));
                psRan = false;
                return [];
            }),
            withDeadline(probes.listeners(), 'lsof', deadlineMs).catch((error: unknown): Map<number, ListenSocket[]> => {
                warnings.push(describe(error, 'listening ports'));
                return new Map();
            }),
            withDeadline(probes.containers(), 'docker', deadlineMs).catch((error: unknown): ContainerRow[] => {
                warnings.push(describe(error, 'docker'));
                return [];
            })
        ]);
        const containerRows = (containers ?? []).map((row) =>
            row.directory !== null && probes.pathExists(row.directory) ? { ...row, directory: probes.realpath(row.directory) } : row
        );
        const containerPorts = new Set(containerRows.flatMap((row) => row.ports.map((port) => port.port)));

        const planInput = {
            processes,
            listeners,
            paneShells: context.paneShells,
            selfPids: context.selfPids,
            containerPorts
        };
        const stacks = planProcessStacks(planInput);

        const started = new Map(processes.map((row) => [row.pid, row.startedAt]));
        const key = (pid: number): string => `${String(pid)}:${String(started.get(pid) ?? 0)}`;
        const wanted = [...new Set(stacks.flatMap((stack) => [stack.rootPid, ...stack.listenerPids]))];
        const missing = wanted.filter((pid) => !cwdCache.has(key(pid)));
        if (missing.length > 0) {
            try {
                const found = await withDeadline(probes.cwds(missing), 'lsof', deadlineMs);
                for (const [pid, cwd] of found) cwdCache.set(key(pid), cwd);
            } catch (error) {
                warnings.push(describe(error, 'working directories'));
            }
        }
        const cwds = new Map<number, string>();
        const kept = new Map<string, string>();
        for (const pid of wanted) {
            const cwd = cwdCache.get(key(pid));
            if (cwd === undefined) continue;
            cwds.set(pid, cwd);
            kept.set(key(pid), cwd);
        }
        cwdCache = kept;

        const services = buildServices(
            {
                ...planInput,
                stacks,
                cwds,
                containers: containerRows,
                workspaces: context.workspaces,
                knownFolders: context.knownFolders,
                worktreeBases: context.worktreeBases,
                pathExists: (path) => probes.pathExists(path),
                cpuByPid: cpu.sample(psRan ? processes : null, psAt),
                // Never asked for here: the scan loop refreshes them off this path (§4).
                containerNumbers: (id) => options.containerStats?.get(id) ?? null
            },
            context.workspaceOrder
        );
        return { services, scannedAt: now(), warnings };
    }

    function scan(scanOptions?: { readonly since?: number | undefined }): Promise<RunningScan> {
        const since = scanOptions?.since ?? Number.NEGATIVE_INFINITY;
        if (inFlight !== null) {
            if (inFlight.startedAt >= since) return inFlight.promise;
            // It began before what the caller waits to see: let it land, then take a new one.
            return inFlight.promise.then(
                () => scan(scanOptions),
                () => scan(scanOptions)
            );
        }
        if (last !== null && last.startedAt >= since && now() - last.scan.scannedAt < cacheMs) return Promise.resolve(last.scan);
        const startedAt = now();
        const promise = runScan()
            .then((result) => {
                last = { scan: result, startedAt };
                return result;
            })
            .finally(() => {
                inFlight = null;
            });
        inFlight = { promise, startedAt };
        return promise;
    }

    return { scan };
}

/** A scanner that finds nothing: the default for handler tables built without a host (tests). */
export const INERT_RUNNING_SCANNER: RunningScanner = {
    scan: () => Promise.resolve({ services: [], scannedAt: Date.now(), warnings: [] })
};
