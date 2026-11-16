/**
 * The scan loop behind the app's Services UI (docs/running-services.md §4, cadence phase 2):
 * every 10 s while some client is visible, every 60 s while clients are attached but none is
 * visible, never with no clients. `poke` asks for a scan about a second from now (an agent
 * finished a turn, say). A `running-services` message goes out when the list changes and is
 * kept for replay on attach.
 *
 * The list never changes for CPU, and for memory only in 10% steps. The live numbers go in
 * `running-stats` (phase 4), after every scan while a window is visible; the scan loop is also what refreshes containers' Docker
 * stats then, off the scan's own path, so `kelpi ps` and a stop never wait on Docker. The latest
 * numbers are kept for replay whether or not they were sent.
 */

import {
    WS_RUNNING_SERVICES_MESSAGE,
    WS_RUNNING_STATS_MESSAGE,
    type RunningServiceEntry,
    type WsRunningServicesMessage,
    type WsRunningStatsMessage
} from '@kelpi/protocol';

import { wireTimestamp } from '../handlers/app/common.js';
import type { ContainerStats } from './container-stats.js';
import { toWireService, wireCpu } from './handlers.js';
import type { RunningScanner } from './scanner.js';

export const RUNNING_VISIBLE_INTERVAL_MS = 10_000;
export const RUNNING_HIDDEN_INTERVAL_MS = 60_000;
/** How often the loop looks at who is attached; a scan only runs when one is due. */
export const RUNNING_TICK_MS = 1_000;
/** A poke's delay: soon, but after the burst of activity that caused it. */
export const RUNNING_POKE_DELAY_MS = 1_000;

export interface RunningPresence {
    readonly clients: number;
    readonly anyVisible: boolean;
}

export interface RunningMonitorOptions {
    readonly scanner: RunningScanner;
    readonly presence: () => RunningPresence;
    readonly broadcast: (message: WsRunningServicesMessage | WsRunningStatsMessage) => void;
    /** Containers' Docker stats, refreshed after a scan while a window is visible. */
    readonly containerStats?: ContainerStats | undefined;
    readonly now?: (() => number) | undefined;
    readonly onError?: ((error: unknown) => void) | undefined;
    /** Tests drive `tick` themselves. */
    readonly timers?: boolean | undefined;
}

export interface RunningMonitor {
    /** The last list, for replay on attach; an empty one before the first scan. */
    current(): WsRunningServicesMessage;
    /** The latest numbers, for replay after `current()`; empty before the first scan. */
    currentStats(): WsRunningStatsMessage;
    /** Scan about a second from now, if anyone is attached. */
    poke(): void;
    /** One turn of the loop (the timer calls it; tests call it directly). */
    tick(): Promise<void>;
    dispose(): void;
}

/**
 * What counts as a change. CPU never does, and memory only in 10% steps: the list stays close
 * enough for a tooltip or a dialog's figure without being resent every scan, and the live numbers
 * travel in `running-stats`.
 */
function changeKey(services: readonly RunningServiceEntry[], warnings: readonly string[]): string {
    const coarse = (bytes: number | null): number | null => (bytes === null || bytes <= 0 ? bytes : Math.round(Math.log(bytes) / Math.log(1.1)));
    return JSON.stringify({
        warnings,
        services: services.map((service) => ({
            ...service,
            rss_bytes: coarse(service.rss_bytes),
            cpu_percent: null,
            members: service.members.map((member) => ({ ...member, rss_bytes: coarse(member.rss_bytes) }))
        }))
    });
}

export function createRunningMonitor(options: RunningMonitorOptions): RunningMonitor {
    const now = options.now ?? (() => Date.now());
    let current: WsRunningServicesMessage = { type: WS_RUNNING_SERVICES_MESSAGE, services: [], scannedAt: null, warnings: [] };
    let currentStats: WsRunningStatsMessage = { type: WS_RUNNING_STATS_MESSAGE, scannedAt: null, stats: [] };
    let announced = changeKey([], []);
    let lastScanAt = Number.NEGATIVE_INFINITY;
    /** A pending poke: when it is due, and when it was asked for (the scan must start after). */
    let poked: { readonly due: number; readonly since: number } | null = null;
    let scanning = false;
    let disposed = false;

    async function tick(): Promise<void> {
        if (disposed || scanning) return;
        const presence = options.presence();
        if (presence.clients === 0) return;
        const at = now();
        const interval = presence.anyVisible ? RUNNING_VISIBLE_INTERVAL_MS : RUNNING_HIDDEN_INTERVAL_MS;
        const pokeDue = poked !== null && at >= poked.due;
        if (!pokeDue && at - lastScanAt < interval) return;
        const since = poked?.since;
        scanning = true;
        poked = null;
        lastScanAt = at;
        try {
            // A poke's scan must not be the scanner's cached answer from before the change.
            const scan = await options.scanner.scan(since === undefined ? undefined : { since });
            const services = scan.services.map(toWireService);
            current = {
                type: WS_RUNNING_SERVICES_MESSAGE,
                services,
                scannedAt: wireTimestamp(scan.scannedAt / 1000),
                warnings: scan.warnings
            };
            const key = changeKey(services, scan.warnings);
            if (key !== announced && !disposed) {
                announced = key;
                options.broadcast(current);
            }
            // Only for the containers of the workspaces' and leftover worktrees' services, and
            // only while someone can see them: a refresh asks Docker about each one.
            if (presence.anyVisible && options.containerStats !== undefined) {
                const ids = scan.services
                    .filter((service) => service.category === 'workspace' || service.category === 'unattached')
                    .flatMap((service) => service.members.map((member) => member.containerID))
                    .filter((id): id is string => id !== null);
                if (ids.length > 0) await options.containerStats.refresh(ids);
            }
            // The scan's own numbers: a container's are from the refresh before this one, one scan
            // interval behind, which is all the precision a 10-second figure has.
            currentStats = {
                type: WS_RUNNING_STATS_MESSAGE,
                scannedAt: current.scannedAt,
                stats: scan.services.map((service) => ({ id: service.id, cpu_percent: wireCpu(service.cpuPercent), rss_bytes: service.rssBytes }))
            };
            if (presence.anyVisible && !disposed) options.broadcast(currentStats);
        } catch (error) {
            options.onError?.(error);
        } finally {
            scanning = false;
        }
    }

    const timer = options.timers === false ? null : setInterval(() => void tick(), RUNNING_TICK_MS);
    timer?.unref();

    return {
        current: () => current,
        currentStats: () => currentStats,
        poke() {
            const at = now();
            poked = poked === null ? { due: at + RUNNING_POKE_DELAY_MS, since: at } : { due: poked.due, since: Math.max(poked.since, at) };
        },
        tick,
        dispose() {
            disposed = true;
            if (timer !== null) clearInterval(timer);
        }
    };
}
