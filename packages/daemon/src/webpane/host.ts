/**
 * The web-pane **host channel** — the daemon's RPC seam to whatever process owns real browser
 * views (the Electron shell's `WebContentsView`s driven over CDP).
 *
 * The daemon is headless (ARCHITECTURE.md): it owns pane/tab/console state, but it cannot
 * render a page. So every `web-*` verb whose effect only exists in a browser is forwarded here
 * as `{id, verb, args}` and awaited. The full contract — verb table, argument/reply shapes,
 * event shapes, registration handshake — is `./HOST_PROTOCOL.md`, which the shell implements
 * against.
 *
 * Rules that matter:
 *   - **Exactly one active host.** A second `host-register` takes over; the previous host is
 *     told (`host-revoked`, reason `superseded`) and its in-flight calls fail immediately
 *     rather than hanging until their timeout.
 *   - **No host is a first-class answer**, not an exception: `{"ok":false,"error":"no web pane
 *     host connected"}` (`NO_HOST_ERROR` — a stable string agents grep for).
 *   - **Every call is bounded.** A wedged host must never wedge the CLI: each verb carries a
 *     timeout, and a reply that arrives after it is discarded.
 */

import { randomUUID } from 'node:crypto';

import type { JsonObject } from '@kelpi/protocol';

/** No shell (or other host) has claimed the web-pane role. Stable wire string. */
export const NO_HOST_ERROR = 'no web pane host connected';
/** The host vanished while a call was in flight (registration taken over, or socket closed). */
export const HOST_GONE_ERROR = 'web pane host disconnected';
/** Default per-call budget; `./verbs.ts` overrides it for the slow verbs. */
export const DEFAULT_HOST_TIMEOUT_MS = 5_000;

export type HostRevokeReason = 'superseded' | 'unregistered' | 'shutdown';

/** What the sync session gives the registry: one WS connection's JSON writer. */
export interface HostTransport {
    sendJson(message: JsonObject): void;
}

export interface HostRegistration {
    readonly hostID: string;
    /** True when this registration displaced a previous host. */
    readonly superseded: boolean;
    /** Release the slot (WS close, `host-unregister`). No-op once superseded. */
    release(reason?: HostRevokeReason): void;
}

export interface HostCallOptions {
    readonly timeoutMs?: number | undefined;
}

export interface HostRegistry {
    readonly hasHost: boolean;
    readonly hostID: string | null;
    readonly hostName: string | null;
    /**
     * The window the host renders into, when it declared one (`WsClientInfo.windowID`). It is
     * what makes a client's geometry report addressable: only the UI running inside THAT window
     * knows where the host's own views belong (`./geometry.ts`).
     */
    readonly hostWindowID: string | null;
    /** Calls awaiting a reply (diagnostics + tests). */
    readonly pending: number;
    register(
        transport: HostTransport,
        options?: { name?: string | undefined; windowID?: string | undefined }
    ): HostRegistration;
    /**
     * Forward one verb. Resolves with the host's `{ok:…}` envelope, or with a daemon-authored
     * failure envelope (`NO_HOST_ERROR`, `HOST_GONE_ERROR`, timeout). It never rejects: a
     * handler's only job is to merge ids into the envelope and write it.
     */
    call(verb: string, args: JsonObject, options?: HostCallOptions): Promise<JsonObject>;
    /** Fire-and-forget: state the daemon owns, mirrored to the host. Silent with no host. */
    notify(verb: string, args: JsonObject): void;
    /** Route a `host-rpc-reply`. A late/unknown id is ignored. */
    settle(id: string, reply: JsonObject): void;
    /** Called when the active host disconnects (WS close). */
    close(): void;
}

interface PendingCall {
    readonly hostID: string;
    readonly settle: (reply: JsonObject) => void;
    readonly timer: NodeJS.Timeout;
}

function failure(error: string): JsonObject {
    return { ok: false, error };
}

export function timeoutError(verb: string, timeoutMs: number): string {
    return `web pane host did not answer '${verb}' within ${String(timeoutMs)}ms`;
}

export interface HostRegistryOptions {
    readonly newID?: (() => string) | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
    /** Told whenever the active host changes (registry → service → host state sync). */
    readonly onHostChanged?: ((hostID: string | null) => void) | undefined;
}

export function createHostRegistry(options: HostRegistryOptions = {}): HostRegistry {
    const newID = options.newID ?? ((): string => randomUUID());
    const pending = new Map<string, PendingCall>();
    let transport: HostTransport | null = null;
    let hostID: string | null = null;
    let hostName: string | null = null;
    let hostWindowID: string | null = null;

    const report = (error: unknown, context: string): void => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)), context);
    };

    /** Fail every call bound to `id` — the host that owed those replies is gone. */
    const abandon = (id: string, error: string): void => {
        for (const [callID, call] of [...pending]) {
            if (call.hostID !== id) continue;
            pending.delete(callID);
            clearTimeout(call.timer);
            call.settle(failure(error));
        }
    };

    const revoke = (reason: HostRevokeReason): void => {
        const gone = hostID;
        const writer = transport;
        transport = null;
        hostID = null;
        hostName = null;
        hostWindowID = null;
        if (gone === null) return;
        if (writer !== null && reason !== 'unregistered') {
            try {
                writer.sendJson({ type: 'host-revoked', role: 'web-pane', hostID: gone, reason });
            } catch (error) {
                report(error, 'host-revoke');
            }
        }
        abandon(gone, HOST_GONE_ERROR);
        options.onHostChanged?.(null);
    };

    const send = (message: JsonObject): boolean => {
        if (transport === null) return false;
        try {
            transport.sendJson(message);
            return true;
        } catch (error) {
            report(error, 'host-send');
            return false;
        }
    };

    return {
        get hasHost() {
            return transport !== null;
        },
        get hostID() {
            return hostID;
        },
        get hostName() {
            return hostName;
        },
        get hostWindowID() {
            return hostWindowID;
        },
        get pending() {
            return pending.size;
        },

        register(nextTransport, registerOptions = {}) {
            const superseded = transport !== null;
            // Last registration wins; the outgoing host is told before the new one is live so
            // it cannot see traffic meant for its successor.
            if (superseded) revoke('superseded');
            const id = newID();
            transport = nextTransport;
            hostID = id;
            hostName = registerOptions.name ?? null;
            hostWindowID = registerOptions.windowID ?? null;
            send({ type: 'host-registered', role: 'web-pane', hostID: id, superseded });
            options.onHostChanged?.(id);
            return {
                hostID: id,
                superseded,
                release(reason: HostRevokeReason = 'unregistered') {
                    if (hostID !== id) return; // already superseded by a newer registration
                    revoke(reason);
                }
            };
        },

        call(verb, args, callOptions = {}) {
            if (transport === null || hostID === null) {
                return Promise.resolve(failure(NO_HOST_ERROR));
            }
            const timeoutMs = callOptions.timeoutMs ?? DEFAULT_HOST_TIMEOUT_MS;
            const id = newID();
            const owner = hostID;
            return new Promise<JsonObject>((resolve) => {
                let settled = false;
                const settle = (reply: JsonObject): void => {
                    if (settled) return;
                    settled = true;
                    resolve(reply);
                };
                const timer = setTimeout(() => {
                    pending.delete(id);
                    settle(failure(timeoutError(verb, timeoutMs)));
                }, timeoutMs);
                // A pending RPC must never hold the event loop open on its own.
                timer.unref?.();
                pending.set(id, { hostID: owner, settle, timer });
                const delivered = send({ type: 'host-rpc', id, verb, args, timeoutMs });
                if (!delivered) {
                    pending.delete(id);
                    clearTimeout(timer);
                    settle(failure(HOST_GONE_ERROR));
                }
            });
        },

        notify(verb, args) {
            if (transport === null) return;
            send({ type: 'host-notify', verb, args });
        },

        settle(id, reply) {
            const call = pending.get(id);
            if (call === undefined) return; // late reply after a timeout, or a bogus id
            pending.delete(id);
            clearTimeout(call.timer);
            call.settle(reply);
        },

        close() {
            revoke('shutdown');
        }
    };
}
