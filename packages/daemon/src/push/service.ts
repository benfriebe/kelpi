/**
 * Phone push subscriptions: who to wake when the daemon decides to notify, and the fan-out that
 * wakes them (agent-lifecycle.md §7.8, phone-ui.md "Notifications").
 *
 * **Why the phone, not the daemon, owns the VAPID key.** A push subscription is made against ONE
 * application server key, and a phone shows several hosts at once (`client/src/phone/hosts.ts`).
 * If each daemon minted its own key the phone could only take pushes from one of them, since a
 * service worker registration holds a single subscription. So the phone mints the pair, subscribes
 * once, and registers the same subscription AND the pair with every host it dials. The private key
 * lets a host do exactly one thing: push to that phone's subscription. A host the phone already
 * trusts with its terminals gains nothing it should not have; a host the phone forgets keeps a key
 * that stops working the moment the phone turns notifications off (the browser drops the
 * subscription, and the next push comes back 410).
 *
 * **Storage.** `push.json` in the daemon's data dir (0600, write-then-rename, the `devices.json`
 * recipe), written only by the daemon. Each entry remembers the fingerprint of the credential the
 * registering session presented (`credentialFingerprint`: a hash of the asset credential, so the
 * file admits nothing itself), and revoking the device that registered a phone also stops its
 * pushes: `prune()` runs on every registry change and `deliver` re-checks before each send. What
 * the file does hold is each phone's subscription and VAPID pair: whoever reads it can push to
 * those phones, as any host the phone registered with can.
 *
 * **Pacing.** The notifications come from PTYs too (OSC 9), and a PTY is an untrusted byte
 * source. Each phone has a queue: one push in flight, the newest per pane, a pane's next push at
 * least `REPEAT_GAP_MS` after its last, and a pause when the push service answers 429 or 503.
 *
 * **SSRF.** A subscription's endpoint is a URL the daemon will POST to, chosen by the client.
 * Only https is accepted, redirects are not followed, and only an authenticated session can
 * register one; a paired device already runs shells on this machine, so pointing the daemon at a
 * URL gives it nothing new.
 *
 * What gets sent is the daemon's own `notification` broadcast, already through the §7
 * suppression matrix and the mute rule (`ws/sync.ts` `broadcast`), minus the phones that are
 * looking at Kelpi right now (they get it over the socket like any client).
 */

import { createECDH, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import { homedir, hostname as osHostname } from 'node:os';
import path from 'node:path';

import { expandTilde, resolveDataDir } from '../db/index.js';
import {
    MAX_PAYLOAD_BYTES,
    decodeKey,
    pushTopic,
    sendPush,
    vapidAuthorization,
    vapidSigningKey,
    type PushSendOptions,
    type PushSendResult,
    type PushTarget,
    type VapidKeys
} from './webpush.js';

export const PUSH_PATH_ENV = 'KELPID_PUSH_PATH';
export const PUSH_FILENAME = 'push.json';

/** The `push-*` WS-only verbs (`ws/sync.ts` routes them; any authenticated session may use them). */
export const PUSH_COMMANDS = ['push-subscribe', 'push-unsubscribe', 'push-test'] as const;
export type PushCommand = (typeof PUSH_COMMANDS)[number];

export function isPushCommand(command: string): command is PushCommand {
    return (PUSH_COMMANDS as readonly string[]).includes(command);
}

/** How long a push service holds a message for a phone that is off. Topic collapse keeps it one per pane. */
const NOTIFICATION_TTL_SECONDS = 4 * 60 * 60;
/** A test that cannot arrive within a minute has answered the question anyway. */
const TEST_TTL_SECONDS = 60;
/** Phones are few; a runaway client re-subscribing with fresh endpoints must not grow the file forever. */
const MAX_REGISTRATIONS = 64;
const MAX_TITLE = 200;
const MAX_BODY = 1000;
/**
 * The soonest a pane's next push follows its last one to the same phone. A newer push for a pane
 * replaces the older one on the phone (one tag, one Topic), so waiting loses nothing; it is what
 * keeps a PTY printing OSC 9 in a loop (`cat` of the wrong file) from becoming a stream of POSTs
 * that a push service answers with 429, Apple's for "too many requests to the same device".
 */
const REPEAT_GAP_MS = 5_000;
/** A 429/503 that names no `Retry-After` holds that phone's pushes this long; a named one is capped. */
const RETRY_AFTER_DEFAULT_MS = 30_000;
const RETRY_AFTER_MAX_MS = 10 * 60_000;
/** How long one VAPID header is reused (Apple: refresh a JWT at most once an hour). It is valid for 12. */
const VAPID_REUSE_MS = 60 * 60_000;

export interface PushRegistration {
    readonly endpoint: string;
    readonly p256dh: string;
    readonly auth: string;
    readonly vapidPublicKey: string;
    readonly vapidPrivateKey: string;
    /**
     * `credentialFingerprint` of the registering session's token: enough to tell whether that
     * credential is still live, not enough to present as one. Null for a session that presented
     * none (an anonymous daemon).
     */
    readonly credentialHash: string | null;
    /** The phone's own key for this host (`origin`, `phone:<id>`, …), echoed so a tap opens the right one. */
    readonly host: string;
    /** ISO-8601. */
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface PushSubscribeInput {
    readonly endpoint: string;
    readonly p256dh: string;
    readonly auth: string;
    readonly vapidPublicKey: string;
    readonly vapidPrivateKey: string;
    readonly host: string;
}

/** The fields of a `notification` broadcast a push carries. */
export interface PushNotice {
    readonly kind: string;
    readonly title: string;
    readonly body: string;
    readonly dedupeKey: string;
    readonly paneID: string;
    readonly workspaceID: string;
}

/** What the service worker reads (`client/src/pwa/push-payload.ts` is the other end). */
export interface PushPayload {
    readonly v: 1;
    readonly kind: string;
    readonly title: string;
    readonly body: string;
    readonly tag: string;
    readonly host: string;
    readonly workspaceID?: string;
    readonly paneID?: string;
}

export interface PushTestResult {
    readonly ok: boolean;
    readonly status: number;
}

export interface PushService {
    /** Add or refresh one subscription. Throws with a sentence the phone can show. */
    subscribe(input: PushSubscribeInput, credentialHash: string | null): void;
    /** Forget one subscription; true when there was one. */
    unsubscribe(endpoint: string): boolean;
    has(endpoint: string): boolean;
    /**
     * Push one notification to every subscription not in `skip` (phones looking at Kelpi now), or
     * only to those in `only`. Resolves when those phones' queues have drained: a phone gets one
     * push at a time, the newest per pane, `REPEAT_GAP_MS` apart per pane.
     */
    deliver(notice: PushNotice, skip: ReadonlySet<string>, only?: ReadonlySet<string>): Promise<void>;
    /** Push a test notification to one subscription now, whoever is looking. */
    test(endpoint: string): Promise<PushTestResult>;
    /** Drop subscriptions whose credential no longer admits anyone; returns how many. */
    prune(): number;
    readonly size: number;
}

export interface PushServiceOptions {
    readonly file: string;
    /** Is a stored credential fingerprint still live? (`createCredentialFingerprintGate`). Absent = always. */
    readonly credentialValid?: ((hash: string) => boolean) | undefined;
    /** Test seam over the real HTTP send. */
    readonly send?: ((target: PushTarget, keys: VapidKeys, payload: Buffer, options: PushSendOptions) => Promise<PushSendResult>) | undefined;
    readonly now?: (() => number) | undefined;
    /** Names this machine in the test notification. */
    readonly hostname?: string | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
    readonly log?: ((line: string) => void) | undefined;
}

/** Where the subscriptions live: `KELPID_PUSH_PATH`, else `<data dir>/push.json`. */
export function resolvePushPath(env: NodeJS.ProcessEnv = process.env): string {
    const override = env[PUSH_PATH_ENV]?.trim();
    if (override !== undefined && override.length > 0) return path.resolve(expandTilde(override, homedir()));
    return path.join(resolveDataDir({ env }), PUSH_FILENAME);
}

function isRegistration(value: unknown): value is PushRegistration {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const strings = ['endpoint', 'p256dh', 'auth', 'vapidPublicKey', 'vapidPrivateKey', 'host', 'createdAt', 'updatedAt'];
    if (!strings.every((key) => typeof record[key] === 'string' && (record[key] as string).length > 0)) return false;
    return record['credentialHash'] === null || typeof record['credentialHash'] === 'string';
}

/** A missing file is no subscriptions; a malformed one is reported and read as none (the phones re-register on their next open). */
export function loadPushRegistrations(file: string): PushRegistration[] {
    let raw: string;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    const list = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)['subscriptions'] : undefined;
    if (!Array.isArray(list)) throw new Error(`${file} is not a push registry (no subscriptions array)`);
    return list.filter(isRegistration);
}

function savePushRegistrations(file: string, registrations: readonly PushRegistration[]): void {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${String(process.pid)}`;
    fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, subscriptions: registrations }, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
}

function clip(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Everything a send will need, checked now: a registration that cannot be sent to would fail every push and never be pruned. */
function validateSubscribe(input: PushSubscribeInput): void {
    if (input.endpoint.length > 2048) throw new Error('push endpoint is too long');
    let url: URL;
    try {
        url = new URL(input.endpoint);
    } catch {
        throw new Error('push endpoint is not a URL');
    }
    if (url.protocol !== 'https:') throw new Error('push endpoint must be https');
    if (input.host.length === 0 || input.host.length > 200) throw new Error('push host key must be 1-200 characters');
    // The uncompressed point `encryptPayload` needs (a compressed one would agree a secret here and fail there)...
    const point = decodeKey(input.p256dh, 'push subscription key (p256dh)', 65);
    try {
        if (point[0] !== 0x04) throw new Error('compressed');
        // ...and on the curve: the cheapest proof is to agree a secret with it.
        const probe = createECDH('prime256v1');
        probe.generateKeys();
        probe.computeSecret(point);
    } catch {
        throw new Error('push subscription key (p256dh) is not an uncompressed P-256 public key');
    }
    decodeKey(input.auth, 'push subscription auth secret', 16);
    vapidSigningKey({ publicKey: input.vapidPublicKey, privateKey: input.vapidPrivateKey });
}

/** The service worker's message, kept inside one record (a long agent message is cut, never the routing). */
export function pushPayload(payload: PushPayload): Buffer {
    const sized = { ...payload, title: clip(payload.title, MAX_TITLE), body: clip(payload.body, MAX_BODY) };
    let bytes = Buffer.from(JSON.stringify(sized));
    // Multi-byte text can still overflow at 1000 characters; cut harder rather than drop the push.
    if (bytes.length > MAX_PAYLOAD_BYTES) bytes = Buffer.from(JSON.stringify({ ...sized, body: clip(sized.body, 200) }));
    return bytes;
}

/** One phone's pushes waiting to go: the newest per tag, oldest tag first. */
interface Outbox {
    readonly pending: Map<string, Buffer>;
    /** When each tag last went to this phone, for `REPEAT_GAP_MS`. */
    readonly sentAt: Map<string, number>;
    /** The push service asked for a pause (429/503) until then. */
    pausedUntil: number;
    running: Promise<void> | null;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms).unref();
    });
}

export function createPushService(options: PushServiceOptions): PushService {
    const now = options.now ?? Date.now;
    const send = options.send ?? sendPush;
    const machine = (options.hostname ?? osHostname()).replace(/\.local$/, '');
    const report = (error: unknown, context: string): void => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)), context);
    };

    const registrations = new Map<string, PushRegistration>();
    try {
        for (const entry of loadPushRegistrations(options.file)) registrations.set(entry.endpoint, entry);
    } catch (error) {
        report(error, 'push registry');
    }
    const keys = new Map<string, KeyObject>();
    /** One VAPID header per push service origin and key, reused for `VAPID_REUSE_MS`. */
    const authorizations = new Map<string, { readonly header: string; readonly at: number }>();
    /** When each phone last registered, kept in memory: an unchanged re-registration writes nothing, but still counts as alive. */
    const seen = new Map<string, number>();
    const outboxes = new Map<string, Outbox>();

    const persist = (): void => {
        try {
            savePushRegistrations(options.file, [...registrations.values()]);
        } catch (error) {
            report(error, 'push registry');
        }
    };

    const signingKey = (entry: PushRegistration): KeyObject => {
        const cached = keys.get(entry.vapidPrivateKey);
        if (cached !== undefined) return cached;
        const key = vapidSigningKey({ publicKey: entry.vapidPublicKey, privateKey: entry.vapidPrivateKey });
        keys.set(entry.vapidPrivateKey, key);
        return key;
    };

    const authorization = (entry: PushRegistration, at: number): string => {
        const id = `${new URL(entry.endpoint).origin} ${entry.vapidPublicKey}`;
        const cached = authorizations.get(id);
        // `at < cached.at`: the clock stepped back, and the header's expiry with it is unknown.
        if (cached !== undefined && at >= cached.at && at - cached.at < VAPID_REUSE_MS) return cached.header;
        const header = vapidAuthorization(entry.endpoint, { publicKey: entry.vapidPublicKey, privateKey: entry.vapidPrivateKey }, at, signingKey(entry));
        authorizations.set(id, { header, at });
        return header;
    };

    const live = (entry: PushRegistration): boolean =>
        entry.credentialHash === null || options.credentialValid === undefined || options.credentialValid(entry.credentialHash);

    /** A forgotten phone's queue goes with it (a drain in progress notices and stops). */
    const dropOutbox = (endpoint: string): void => {
        seen.delete(endpoint);
        const box = outboxes.get(endpoint);
        if (box === undefined) return;
        box.pending.clear();
        if (box.running === null) outboxes.delete(endpoint);
    };

    const forget = (endpoint: string, why: string): void => {
        if (!registrations.delete(endpoint)) return;
        dropOutbox(endpoint);
        persist();
        options.log?.(`push: forgot a subscription at ${new URL(endpoint).origin} (${why})`);
    };

    /** One send, its outcome folded into the registry. Never rejects. */
    const sendTo = async (entry: PushRegistration, payload: Buffer, ttlSeconds: number, topic: string | undefined): Promise<PushTestResult & { readonly retryAfterMs?: number }> => {
        const origin = new URL(entry.endpoint).origin;
        try {
            const at = now();
            const result = await send(
                { endpoint: entry.endpoint, p256dh: entry.p256dh, auth: entry.auth },
                { publicKey: entry.vapidPublicKey, privateKey: entry.vapidPrivateKey },
                payload,
                { ttlSeconds, topic, nowMs: at, signingKey: signingKey(entry), authorization: authorization(entry, at) }
            );
            if (result.gone) forget(entry.endpoint, `HTTP ${String(result.status)}`);
            else if (!result.ok) report(new Error(`push to ${origin} refused: HTTP ${String(result.status)}`), 'push');
            if (result.status !== 429 && result.status !== 503) return { ok: result.ok, status: result.status };
            const hold = Math.min(Math.max(result.retryAfterMs ?? RETRY_AFTER_DEFAULT_MS, 1_000), RETRY_AFTER_MAX_MS);
            return { ok: false, status: result.status, retryAfterMs: hold };
        } catch (error) {
            report(new Error(`push to ${origin} failed: ${error instanceof Error ? error.message : String(error)}`), 'push');
            return { ok: false, status: 0 };
        }
    };

    /**
     * Send a phone's queue: one push in flight at a time, the next one the queue's first pane whose
     * `REPEAT_GAP_MS` has passed, everything held while the push service asked for a pause.
     */
    const drain = async (endpoint: string, box: Outbox): Promise<void> => {
        for (;;) {
            const entry = registrations.get(endpoint);
            if (entry === undefined) box.pending.clear();
            if (box.pending.size === 0) return;
            const at = now();
            let wake = box.pausedUntil;
            let next: readonly [string, Buffer] | undefined;
            if (at >= box.pausedUntil) {
                wake = Number.POSITIVE_INFINITY;
                for (const [tag, payload] of box.pending) {
                    const last = box.sentAt.get(tag);
                    // `at < last`: the clock stepped back; send rather than wait out a gap of unknown length.
                    const due = last === undefined || at < last ? at : last + REPEAT_GAP_MS;
                    if (due <= at) {
                        next = [tag, payload];
                        break;
                    }
                    wake = Math.min(wake, due);
                }
            }
            if (next === undefined || entry === undefined) {
                await sleep(Math.max(0, wake - at));
                continue;
            }
            const [tag, payload] = next;
            box.pending.delete(tag);
            box.sentAt.set(tag, at);
            const result = await sendTo(entry, payload, NOTIFICATION_TTL_SECONDS, pushTopic(tag));
            if (result.retryAfterMs !== undefined) {
                box.pausedUntil = now() + result.retryAfterMs;
                // Try it again after the pause, unless a newer one for the pane is already waiting.
                if (!box.pending.has(tag)) box.pending.set(tag, payload);
                box.sentAt.delete(tag);
            }
        }
    };

    const kick = (endpoint: string, box: Outbox): Promise<void> => {
        box.running ??= drain(endpoint, box)
            .catch((error: unknown) => report(error, 'push'))
            .finally(() => {
                box.running = null;
                if (!registrations.has(endpoint)) outboxes.delete(endpoint);
                // Queued between the loop's last look and here.
                else if (box.pending.size > 0) void kick(endpoint, box);
            });
        return box.running;
    };

    return {
        get size(): number {
            return registrations.size;
        },

        has(endpoint) {
            return registrations.has(endpoint);
        },

        subscribe(input, credentialHash) {
            validateSubscribe(input);
            const stamp = new Date(now()).toISOString();
            const previous = registrations.get(input.endpoint);
            const next: PushRegistration = {
                endpoint: input.endpoint,
                p256dh: input.p256dh,
                auth: input.auth,
                vapidPublicKey: input.vapidPublicKey,
                vapidPrivateKey: input.vapidPrivateKey,
                credentialHash,
                host: input.host,
                createdAt: previous?.createdAt ?? stamp,
                updatedAt: stamp
            };
            const unchanged =
                previous !== undefined &&
                (['p256dh', 'auth', 'vapidPublicKey', 'vapidPrivateKey', 'credentialHash', 'host'] as const).every((key) => previous[key] === next[key]);
            seen.set(input.endpoint, now());
            // A phone re-registers on every connect; rewriting the file for each would be churn.
            if (unchanged) return;
            registrations.delete(input.endpoint);
            registrations.set(input.endpoint, next);
            while (registrations.size > MAX_REGISTRATIONS) {
                // The phone gone quietest goes first, not the one registered longest ago.
                const lastSeen = (entry: PushRegistration): number => seen.get(entry.endpoint) ?? Date.parse(entry.updatedAt);
                const oldest = [...registrations.values()].sort((a, b) => lastSeen(a) - lastSeen(b))[0];
                if (oldest === undefined) break;
                registrations.delete(oldest.endpoint);
                dropOutbox(oldest.endpoint);
            }
            persist();
        },

        unsubscribe(endpoint) {
            if (!registrations.has(endpoint)) return false;
            registrations.delete(endpoint);
            dropOutbox(endpoint);
            persist();
            return true;
        },

        async deliver(notice, skip, only) {
            const drains: Promise<void>[] = [];
            const tag = notice.dedupeKey.length > 0 ? notice.dedupeKey : `kelpi-${notice.paneID}`;
            const at = now();
            for (const entry of [...registrations.values()]) {
                if (skip.has(entry.endpoint) || (only !== undefined && !only.has(entry.endpoint))) continue;
                if (!live(entry)) {
                    forget(entry.endpoint, 'its credential was revoked');
                    continue;
                }
                const payload = pushPayload({
                    v: 1,
                    kind: notice.kind,
                    title: notice.title,
                    body: notice.body,
                    tag,
                    host: entry.host,
                    workspaceID: notice.workspaceID,
                    paneID: notice.paneID
                });
                let box = outboxes.get(entry.endpoint);
                if (box === undefined) {
                    box = { pending: new Map(), sentAt: new Map(), pausedUntil: 0, running: null };
                    outboxes.set(entry.endpoint, box);
                }
                // Newest wins, and waits behind the panes queued before it.
                box.pending.delete(tag);
                box.pending.set(tag, payload);
                for (const [pane, sent] of box.sentAt) if (at < sent || at - sent >= REPEAT_GAP_MS) box.sentAt.delete(pane);
                drains.push(kick(entry.endpoint, box));
            }
            await Promise.all(drains);
        },

        async test(endpoint) {
            const entry = registrations.get(endpoint);
            if (entry === undefined) throw new Error('this phone has no push subscription on this host');
            const payload = pushPayload({
                v: 1,
                kind: 'test',
                title: 'Kelpi',
                body: `Notifications from ${machine} are working.`,
                tag: `kelpi-push-test-${entry.host}`,
                host: entry.host
            });
            return sendTo(entry, payload, TEST_TTL_SECONDS, undefined);
        },

        prune() {
            let dropped = 0;
            for (const entry of [...registrations.values()]) {
                if (live(entry)) continue;
                registrations.delete(entry.endpoint);
                dropOutbox(entry.endpoint);
                dropped += 1;
            }
            if (dropped > 0) persist();
            return dropped;
        }
    };
}
