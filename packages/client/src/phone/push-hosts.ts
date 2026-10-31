/**
 * Phone push across hosts: this phone's push subscription (`pwa/push.ts`) registered with every
 * host the phone shows, and each host told when the phone is looking (agent-lifecycle.md §7.8).
 *
 * Registration is `push-subscribe` on EVERY connect, not once: it is idempotent on the daemon,
 * it heals a host that lost its registry, and it is what tells the daemon which connection is
 * this phone's (so its presence reports gate this phone's pushes).
 *
 * Two visibility reports leave here, for two different questions a host asks:
 *
 *   - `push-presence`: "is this phone looking at Kelpi?" While it is, a host pushes it nothing.
 *   - the remote runtimes' document visibility: "is this client looking at that pane?" The origin
 *     runtime's is reported by assembly (`App.tsx`); a remote runtime's never was, so a host kept
 *     believing a phone that had shown one of its panes was still looking at it after the phone
 *     was put away, and its notification for that pane was suppressed (§7.1's `isFocused`).
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { CommandReply } from '../connection';
import type { PushDevice, PushDeviceState, PushRegistrationInfo } from '../pwa/push';
import type { PhoneHostModel } from './model';

export type PushHostStatus =
    /** Push is off on this phone. */
    | { readonly state: 'off' }
    /** Not connected; it registers when it is. */
    | { readonly state: 'waiting' }
    | { readonly state: 'registering' }
    | { readonly state: 'on' }
    | { readonly state: 'error'; readonly message: string };

const OFF: PushHostStatus = { state: 'off' };

/**
 * How often a visible page repeats its presence. The daemon stops counting a phone as looking
 * after 45 s of silence (`ws/sync.ts` `PUSH_WATCH_SILENCE_MS`, for an iOS page suspended with
 * its socket open), and a busy phone can be silent on the text channel for longer than that:
 * the socket's heartbeat is skipped while the daemon keeps sending, and terminal input and
 * acks are binary frames.
 */
export const PUSH_PRESENCE_REPEAT_MS = 20_000;

export interface DocumentLike {
    readonly visibilityState: string;
    addEventListener(type: 'visibilitychange', listener: () => void): void;
    removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

function defaultDocument(): DocumentLike | null {
    return (globalThis as { document?: DocumentLike }).document ?? null;
}

function pageVisible(doc: DocumentLike | null): boolean {
    return doc === null || doc.visibilityState !== 'hidden';
}

/** A host's refusal, in words for the Notifications sheet. */
export function pushRefusal(reply: CommandReply): string {
    const error = typeof reply['error'] === 'string' ? reply['error'] : 'the host refused';
    // A daemon from before phone push decodes the verb as an unknown wire command.
    if (error.startsWith('unknown command')) return "This host's Kelpi is too old for phone notifications. Update it to get them.";
    return error;
}

export function usePushDeviceState(device: PushDevice): PushDeviceState {
    return useSyncExternalStore(device.subscribe, device.getState, device.getState);
}

/** Register with every host while push is on; the per-host outcome, for the sheet. */
export function usePushHosts(
    hosts: readonly PhoneHostModel[],
    device: PushDevice,
    doc: DocumentLike | null = defaultDocument()
): ReadonlyMap<string, PushHostStatus> {
    const { registration: made, wanted } = usePushDeviceState(device);
    // Only while the person wants it: a subscription a racing refresh made after Turn off is not theirs.
    const registration = wanted ? made : null;
    // A refresh hands back an equal registration as a new object; only a real change re-registers.
    const identity = registration === null ? null : `${registration.endpoint} ${registration.vapidPublicKey}`;
    const current = useRef<PushRegistrationInfo | null>(registration);
    current.current = registration;
    const [statuses, setStatuses] = useState<ReadonlyMap<string, PushHostStatus>>(new Map());

    useEffect(() => {
        const info = current.current;
        if (identity === null || info === null) {
            setStatuses(new Map());
            return;
        }
        let live = true;
        const next = new Map<string, PushHostStatus>();
        const put = (key: string, status: PushHostStatus): void => {
            if (!live) return;
            next.set(key, status);
            setStatuses(new Map(next));
        };
        const offs: (() => void)[] = [];
        for (const host of hosts) {
            const register = (): void => {
                put(host.key, { state: 'registering' });
                host.runtime.commands.pushSubscribe(info, host.key, pageVisible(doc)).then(
                    (reply) => put(host.key, reply['ok'] === true ? { state: 'on' } : { state: 'error', message: pushRefusal(reply) }),
                    // A timeout or a dropped link: the next connect registers again.
                    () => put(host.key, { state: 'waiting' })
                );
            };
            if (host.runtime.connection.status === 'connected') register();
            else put(host.key, { state: 'waiting' });
            offs.push(
                host.runtime.connection.on('status', (status) => {
                    if (status === 'connected') register();
                    else if (status !== 'connecting') put(host.key, { state: 'waiting' });
                })
            );
        }
        const presence = (): void => {
            const visible = pageVisible(doc);
            for (const host of hosts) host.runtime.commands.reportPushPresence(visible);
        };
        doc?.addEventListener('visibilitychange', presence);
        const repeat = setInterval(() => {
            if (pageVisible(doc)) presence();
        }, PUSH_PRESENCE_REPEAT_MS);
        return () => {
            live = false;
            for (const off of offs) off();
            doc?.removeEventListener('visibilitychange', presence);
            clearInterval(repeat);
        };
    }, [hosts, identity, doc]);

    return identity === null ? new Map(hosts.map((host) => [host.key, OFF] as const)) : statuses;
}

/** The remote runtimes' document visibility follows the page (see the module note). */
export function useHostsDocumentVisibility(hosts: readonly PhoneHostModel[], doc: DocumentLike | null = defaultDocument()): void {
    useEffect(() => {
        if (doc === null) return;
        const report = (): void => {
            const visible = pageVisible(doc);
            for (const host of hosts) if (host.kind !== 'origin') host.runtime.setDocumentVisible(visible);
        };
        report();
        doc.addEventListener('visibilitychange', report);
        return () => doc.removeEventListener('visibilitychange', report);
    }, [hosts, doc]);
}

/**
 * A host the phone is about to forget forgets the phone, so it stops pushing here. One that cannot
 * say so (asleep, unreachable, too old) keeps the registration, so the phone moves to a fresh
 * endpoint instead and leaves it pushing to one that answers 410; the other hosts get the new one.
 */
export async function unregisterPushHost(host: PhoneHostModel, device: PushDevice): Promise<void> {
    const endpoint = device.getState().registration?.endpoint;
    if (endpoint === undefined) return;
    if (host.runtime.connection.status === 'connected') {
        const reply = await host.runtime.commands.pushUnsubscribe(endpoint, { timeoutMs: 5_000 }).catch(() => null);
        if (reply?.['ok'] === true) return;
    }
    await device.renew();
}

/**
 * Turn push off. Off here first, at once: a phone put away while the hosts answer must not come
 * back on at the next launch. Then each connected host forgets it; one that does not hears 410
 * from the push service, the browser subscription being gone.
 */
export async function turnPushOff(hosts: readonly PhoneHostModel[], device: PushDevice): Promise<void> {
    const endpoint = device.getState().registration?.endpoint;
    const off = device.disable();
    if (endpoint !== undefined) {
        await Promise.allSettled(
            hosts
                .filter((host) => host.runtime.connection.status === 'connected')
                .map((host) => host.runtime.commands.pushUnsubscribe(endpoint, { timeoutMs: 5_000 }))
        );
    }
    await off;
}

export interface PushTestOutcome {
    readonly hostKey: string;
    readonly ok: boolean;
    readonly message: string;
}

/** A test notification from every host push is on for. */
export async function sendPushTests(hosts: readonly PhoneHostModel[], statuses: ReadonlyMap<string, PushHostStatus>): Promise<readonly PushTestOutcome[]> {
    const on = hosts.filter((host) => statuses.get(host.key)?.state === 'on');
    return Promise.all(
        on.map(async (host): Promise<PushTestOutcome> => {
            try {
                const reply = await host.runtime.commands.pushTest();
                return reply['ok'] === true ? { hostKey: host.key, ok: true, message: 'Sent' } : { hostKey: host.key, ok: false, message: pushRefusal(reply) };
            } catch (error) {
                return { hostKey: host.key, ok: false, message: error instanceof Error ? error.message : String(error) };
            }
        })
    );
}
