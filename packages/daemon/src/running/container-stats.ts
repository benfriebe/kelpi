/**
 * Memory and CPU for containers, from the Docker Engine API's one-shot stats (docs/running-services.md
 * §4, phase 4).
 *
 * Off the scan's path: the scan loop refreshes it after a scan, only while a window is visible,
 * within a total budget, and scans (`kelpi ps`, a stop's) read the last known numbers without ever
 * waiting on Docker. Numbers older than `CONTAINER_STATS_MAX_AGE_MS` are not shown; a container
 * that did not answer keeps its last ones until then.
 *
 * Memory is what `docker stats` shows: usage less the inactive page cache (`inactive_file` on
 * cgroup v2, `total_inactive_file` on v1). CPU is the change in `cpu_usage.total_usage` between
 * two of our refreshes over the time between the replies' own `read` stamps, as a percent of one
 * core, like processes. A restarted container keeps its id but starts its counter again: a
 * negative change is no baseline.
 */

export const CONTAINER_STATS_MAX_AGE_MS = 120_000;
/** The most stats requests in flight at once. */
export const CONTAINER_STATS_CONCURRENCY = 8;
/** One request's longest wait, and the whole refresh's. */
export const CONTAINER_STATS_REQUEST_MS = 3_000;
export const CONTAINER_STATS_BUDGET_MS = 3_000;
/** Containers asked about per refresh; the rest keep their last numbers. */
export const CONTAINER_STATS_MAX = 64;

const CONTAINER_ID = /^[0-9a-f]{12,64}$/;

export interface ContainerNumbers {
    readonly rssBytes: number | null;
    readonly cpuPercent: number | null;
}

export interface ContainerStats {
    /** The last known numbers for a container, while fresh. */
    get(id: string): ContainerNumbers | null;
    /** Ask Docker about these containers, a few at a time, all within the budget. */
    refresh(ids: readonly string[]): Promise<void>;
}

export interface ContainerStatsOptions {
    /** `GET path` on the Docker socket, parsed JSON; rejects on a failure or after `timeoutMs`. */
    readonly fetch: (path: string, timeoutMs: number) => Promise<unknown>;
    readonly now?: (() => number) | undefined;
    readonly budgetMs?: number | undefined;
}

interface Known {
    readonly numbers: ContainerNumbers;
    readonly at: number;
    /** The CPU counter and when it was read, for the next refresh's rate. */
    readonly cpu: Counter | null;
}

function record(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function finite(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `docker stats`'s memory: usage less the inactive page cache, when that is smaller. */
export function containerMemory(reply: unknown): number | null {
    const memory = record(record(reply)?.['memory_stats']);
    const usage = finite(memory?.['usage']);
    if (memory === null || usage === null) return null;
    const stats = record(memory['stats']);
    const inactive = finite(stats?.['inactive_file']) ?? finite(stats?.['total_inactive_file']);
    return inactive !== null && inactive < usage ? usage - inactive : usage;
}

/**
 * The CPU counter and when it was read: by Docker's own `read` stamp, else this daemon's clock.
 * The two clocks can drift apart (Docker Desktop's VM), so a rate only ever compares two readings
 * from the same one.
 */
interface Counter {
    readonly totalNs: number;
    readonly readAt: number;
    readonly clock: 'docker' | 'daemon';
}

function cpuCounter(reply: unknown, fallbackAt: number): Counter | null {
    const top = record(reply);
    const total = finite(record(record(top?.['cpu_stats'])?.['cpu_usage'])?.['total_usage']);
    if (total === null) return null;
    const read = typeof top?.['read'] === 'string' ? Date.parse(top['read']) : Number.NaN;
    return Number.isFinite(read) && read > 0
        ? { totalNs: total, readAt: read, clock: 'docker' }
        : { totalNs: total, readAt: fallbackAt, clock: 'daemon' };
}

export function createContainerStats(options: ContainerStatsOptions): ContainerStats {
    const now = options.now ?? (() => Date.now());
    const budgetMs = options.budgetMs ?? CONTAINER_STATS_BUDGET_MS;
    const known = new Map<string, Known>();

    async function one(id: string, deadline: number): Promise<void> {
        const left = deadline - now();
        if (left <= 0) return;
        let reply: unknown;
        try {
            reply = await options.fetch(`/containers/${id}/stats?stream=false&one-shot=true`, Math.min(CONTAINER_STATS_REQUEST_MS, left));
        } catch {
            // Keeps its last numbers until they go stale.
            return;
        }
        const at = now();
        const before = known.get(id);
        const counter = cpuCounter(reply, at);
        let cpuPercent: number | null = null;
        if (counter !== null && before !== undefined && before.cpu !== null && before.cpu.clock === counter.clock) {
            const elapsedMs = counter.readAt - before.cpu.readAt;
            const used = counter.totalNs - before.cpu.totalNs;
            const fresh = at - before.at <= CONTAINER_STATS_MAX_AGE_MS;
            if (fresh && elapsedMs > 0 && used >= 0) cpuPercent = (used / (elapsedMs * 1_000_000)) * 100;
        }
        known.set(id, { numbers: { rssBytes: containerMemory(reply), cpuPercent }, at, cpu: counter });
    }

    return {
        get(id) {
            const entry = known.get(id);
            return entry === undefined || now() - entry.at > CONTAINER_STATS_MAX_AGE_MS ? null : entry.numbers;
        },
        async refresh(ids) {
            const queue = [...new Set(ids)].filter((id) => CONTAINER_ID.test(id)).slice(0, CONTAINER_STATS_MAX);
            const deadline = now() + budgetMs;
            const worker = async (): Promise<void> => {
                for (let id = queue.shift(); id !== undefined && now() < deadline; id = queue.shift()) await one(id, deadline);
            };
            await Promise.all(Array.from({ length: Math.min(CONTAINER_STATS_CONCURRENCY, queue.length) }, worker));
            // Forget containers that are gone for good.
            for (const [id, entry] of known) if (now() - entry.at > CONTAINER_STATS_MAX_AGE_MS * 5) known.delete(id);
        }
    };
}
