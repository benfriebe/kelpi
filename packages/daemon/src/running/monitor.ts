/**
 * The scan loop behind the app's Services UI (docs/running-services.md §4, cadence phase 2):
 * every 10 s while some client is visible, every 60 s while clients are attached but none is
 * visible, never with no clients. `poke` asks for a scan about a second from now (an agent
 * finished a turn, say). A `running-services` message goes out when the list changes and is
 * kept for replay on attach.
 *
 * Memory is compared to the MiB, so a server whose resident size wobbles by a few pages does not
 * rebroadcast the whole list on every scan.
 */

import { WS_RUNNING_SERVICES_MESSAGE, type RunningServiceEntry, type WsRunningServicesMessage } from '@kelpi/protocol';

import { wireTimestamp } from '../handlers/app/common.js';
import { toWireService } from './handlers.js';
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
    readonly broadcast: (message: WsRunningServicesMessage) => void;
    readonly now?: (() => number) | undefined;
    readonly onError?: ((error: unknown) => void) | undefined;
    /** Tests drive `tick` themselves. */
    readonly timers?: boolean | undefined;
}

export interface RunningMonitor {
    /** The last list, for replay on attach; an empty one before the first scan. */
    current(): WsRunningServicesMessage;
    /** Scan about a second from now, if anyone is attached. */
    poke(): void;
    /** One turn of the loop (the timer calls it; tests call it directly). */
    tick(): Promise<void>;
    dispose(): void;
}

const MIB = 1_048_576;

/** What counts as a change: everything but memory below a MiB. */
function changeKey(services: readonly RunningServiceEntry[], warnings: readonly string[]): string {
    const coarse = (bytes: number | null): number | null => (bytes === null ? null : Math.round(bytes / MIB));
    return JSON.stringify({
        warnings,
        services: services.map((service) => ({
            ...service,
            rss_bytes: coarse(service.rss_bytes),
            members: service.members.map((member) => ({ ...member, rss_bytes: coarse(member.rss_bytes) }))
        }))
    });
}

export function createRunningMonitor(options: RunningMonitorOptions): RunningMonitor {
    const now = options.now ?? (() => Date.now());
    let current: WsRunningServicesMessage = { type: WS_RUNNING_SERVICES_MESSAGE, services: [], scannedAt: null, warnings: [] };
    let announced = changeKey([], []);
    let lastScanAt = Number.NEGATIVE_INFINITY;
    let pokedFor: number | null = null;
    let scanning = false;
    let disposed = false;

    async function tick(): Promise<void> {
        if (disposed || scanning) return;
        const presence = options.presence();
        if (presence.clients === 0) return;
        const at = now();
        const interval = presence.anyVisible ? RUNNING_VISIBLE_INTERVAL_MS : RUNNING_HIDDEN_INTERVAL_MS;
        const due = at - lastScanAt >= interval || (pokedFor !== null && at >= pokedFor);
        if (!due) return;
        scanning = true;
        pokedFor = null;
        lastScanAt = at;
        try {
            const scan = await options.scanner.scan();
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
        poke() {
            const at = now() + RUNNING_POKE_DELAY_MS;
            pokedFor = pokedFor === null ? at : Math.min(pokedFor, at);
        },
        tick,
        dispose() {
            disposed = true;
            if (timer !== null) clearInterval(timer);
        }
    };
}
