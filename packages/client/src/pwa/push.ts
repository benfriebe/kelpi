/**
 * Phone push on this device: whether it can work here, the person's choice, the notification
 * permission, the VAPID pair, and the browser's push subscription (agent-lifecycle.md §7.8).
 *
 * The phone shell registers what this produces with every host it dials (`phone/push-hosts.ts`);
 * each host then pushes its notifications here while Kelpi is closed or in the background
 * (`daemon/src/push/service.ts`, whose header says why the PHONE mints the VAPID pair: one
 * subscription, several hosts). The service worker shows them (`sw.ts`).
 *
 * The browser facts that decide it, measured rather than assumed:
 *
 *   - **iPhone and iPad** have push only in a Home Screen web app (iOS 16.4+): Safari in a tab has
 *     no `PushManager` at all. So the answer there is "add to Home Screen first", not "unsupported".
 *   - **Permission is asked from a tap and nowhere else.** Safari drops the tap's activation at the
 *     first `await`, so `enable` asks before anything else it does. The desktop client's
 *     first-pointerdown ask (`App.tsx`) is not made on a phone: a prompt with no explanation
 *     is how a person answers "Don't Allow" and locks this feature out.
 *   - **Not inside the Electron shell**: it registers no service worker (`register.ts`), and its
 *     own notifications are native.
 *
 * What is remembered, in `localStorage` beside the origin's token: whether the person turned push
 * on here (`kelpi.push.enabled`), and the VAPID pair (`kelpi.push.vapid`). The pair must outlive a
 * page load because the subscription is bound to it; lose it and the next read sees a
 * subscription with someone else's key, drops it and makes a fresh one.
 */

import { defaultStorage, type StorageLike } from '../app/config';
import type { NotificationPermissionState } from '../state';
import { readShellWindowID } from '../webpane/shell-window';

export const PUSH_ENABLED_KEY = 'kelpi.push.enabled';
export const PUSH_VAPID_KEY = 'kelpi.push.vapid';

/*
 * What `push-payload.ts` writes, read here. Restated rather than imported: the app may not import
 * the worker's module (`vite.config.ts` refuses a `sw.js` that shares a chunk with the app), and
 * `push.test.ts` holds the two spellings together.
 */
const PUSH_OPEN_MESSAGE = 'kelpi-push-open';
const PUSH_OPEN_HASH_PREFIX = '#kelpi-open=';
const PUSH_OPEN_CACHE = 'kelpi-push-open';
const PUSH_OPEN_RECORD_PATH = '/__kelpi/push-open';
/** A tap written down longer ago than this is not what the person is opening Kelpi for now. */
const PUSH_OPEN_RECORD_MAX_AGE_MS = 60_000;

const BLOCKED_MESSAGE =
    "Notifications are blocked for Kelpi. Allow them in this phone's settings (on an iPhone: Settings ▸ Notifications ▸ Kelpi), then turn them on here.";
const NOT_ALLOWED_MESSAGE = 'Notifications were not allowed.';

// ── availability ────────────────────────────────────────────────────────────────────

export type PushAvailability = 'available' | 'install-first' | 'insecure' | 'unsupported';

export interface PushFacts {
    /** Inside the Electron shell (`readShellWindowID`). */
    readonly shell: boolean;
    readonly secureContext: boolean;
    readonly ios: boolean;
    /** Launched from the Home Screen (`display-mode: standalone`, or iOS's `navigator.standalone`). */
    readonly standalone: boolean;
    readonly serviceWorker: boolean;
    readonly pushManager: boolean;
    readonly notification: boolean;
}

export function pushAvailability(facts: PushFacts): PushAvailability {
    if (facts.shell) return 'unsupported';
    if (!facts.secureContext) return 'insecure';
    if (facts.ios && !facts.standalone) return 'install-first';
    if (!facts.serviceWorker || !facts.pushManager || !facts.notification) return 'unsupported';
    return 'available';
}

export function readPushFacts(): PushFacts {
    const nav = (globalThis as { navigator?: Navigator & { standalone?: boolean } }).navigator;
    const userAgent = nav?.userAgent ?? '';
    // iPadOS reports itself as a Mac; a Mac has no touch points.
    const ios = /iPad|iPhone|iPod/.test(userAgent) || (nav?.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1);
    let standalone = nav?.standalone === true;
    try {
        standalone ||= typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches;
    } catch {
        // No media queries: not standalone.
    }
    return {
        shell: readShellWindowID() !== null,
        secureContext: (globalThis as { isSecureContext?: boolean }).isSecureContext === true,
        ios,
        standalone,
        serviceWorker: nav !== undefined && 'serviceWorker' in nav,
        pushManager: 'PushManager' in globalThis,
        notification: 'Notification' in globalThis
    };
}

// ── base64url ───────────────────────────────────────────────────────────────────────

export function toBase64url(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array {
    const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

// ── the browser, as a seam ──────────────────────────────────────────────────────────

export interface VapidPair {
    /** Uncompressed P-256 point, base64url: the `applicationServerKey`. */
    readonly publicKey: string;
    /** The private scalar `d`, base64url. */
    readonly privateKey: string;
}

export interface PushSubscriptionLike {
    readonly endpoint: string;
    readonly options?: { readonly applicationServerKey?: ArrayBuffer | null } | undefined;
    toJSON(): { readonly keys?: Readonly<Record<string, string | undefined>> | undefined };
    unsubscribe(): Promise<boolean>;
}

export interface PushWorkerLike {
    readonly pushManager: {
        getSubscription(): Promise<PushSubscriptionLike | null>;
        subscribe(options: { userVisibleOnly: true; applicationServerKey: Uint8Array }): Promise<PushSubscriptionLike>;
    };
    getNotifications(): Promise<readonly { readonly data: unknown; close(): void }[]>;
}

export interface PushBrowser {
    facts(): PushFacts;
    permission(): NotificationPermissionState;
    requestPermission(): Promise<NotificationPermissionState>;
    /** The active service worker registration, or null if none comes within `timeoutMs`. */
    worker(timeoutMs: number): Promise<PushWorkerLike | null>;
    generateVapid(): Promise<VapidPair>;
    readonly storage: StorageLike | null;
}

async function generateVapidPair(): Promise<VapidPair> {
    const subtle = globalThis.crypto.subtle;
    const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
    const jwk = await subtle.exportKey('jwk', pair.privateKey);
    if (raw.length !== 65 || typeof jwk.d !== 'string') throw new Error('This browser could not make a push key.');
    return { publicKey: toBase64url(raw), privateKey: jwk.d };
}

function realPushBrowser(): PushBrowser {
    const notification = (): { permission: NotificationPermissionState; requestPermission(): Promise<NotificationPermissionState> } | undefined =>
        (globalThis as { Notification?: { permission: NotificationPermissionState; requestPermission(): Promise<NotificationPermissionState> } }).Notification;
    return {
        facts: readPushFacts,
        permission: () => notification()?.permission ?? 'denied',
        requestPermission: () => notification()?.requestPermission() ?? Promise.resolve('denied'),
        worker: (timeoutMs) =>
            new Promise((resolve) => {
                const container = (globalThis as { navigator?: Navigator }).navigator?.serviceWorker;
                if (container === undefined) {
                    resolve(null);
                    return;
                }
                // `ready` never settles on a page whose worker did not register; the timeout is the answer then.
                const timer = setTimeout(() => resolve(null), timeoutMs);
                container.ready.then(
                    (registration) => {
                        clearTimeout(timer);
                        resolve(registration as unknown as PushWorkerLike);
                    },
                    () => {
                        clearTimeout(timer);
                        resolve(null);
                    }
                );
            }),
        generateVapid: generateVapidPair,
        storage: defaultStorage()
    };
}

// ── the device ──────────────────────────────────────────────────────────────────────

/** What a host needs to push to this phone (`push-subscribe`). */
export interface PushRegistrationInfo {
    readonly endpoint: string;
    readonly p256dh: string;
    readonly auth: string;
    readonly vapidPublicKey: string;
    readonly vapidPrivateKey: string;
}

export interface PushDeviceState {
    readonly availability: PushAvailability;
    readonly permission: NotificationPermissionState;
    /** The person turned notifications on for this device (remembered across launches). */
    readonly wanted: boolean;
    /** Set once the browser subscription exists: what every host is given. */
    readonly registration: PushRegistrationInfo | null;
    /** Turning on or off, or the first read, is in flight. */
    readonly busy: boolean;
    readonly error: string | null;
}

export interface PushDevice {
    getState(): PushDeviceState;
    subscribe(listener: () => void): () => void;
    /** Read the facts and the subscription; renews a lost subscription when push is on and allowed. */
    refresh(): Promise<void>;
    /** Turn push on. Call it from a tap: it asks for the permission first. */
    enable(): Promise<void>;
    /** Turn push off here: the browser subscription is dropped, so every host's next push is refused. */
    disable(): Promise<void>;
    /**
     * Trade the subscription for a fresh one, a new endpoint under the same key: a host that
     * could not be told to forget this phone is left pushing to an endpoint that answers 410.
     */
    renew(): Promise<void>;
    /** Close shown notifications whose data matches (the pane they name is on screen now). */
    closeNotifications(match: (data: { readonly host: string | null; readonly paneID: string | null }) => boolean): Promise<void>;
}

function readVapid(storage: StorageLike | null): VapidPair | null {
    try {
        const raw = storage?.getItem(PUSH_VAPID_KEY);
        if (raw === null || raw === undefined) return null;
        const parsed = JSON.parse(raw) as Partial<VapidPair>;
        return typeof parsed.publicKey === 'string' && typeof parsed.privateKey === 'string' ? { publicKey: parsed.publicKey, privateKey: parsed.privateKey } : null;
    } catch {
        return null;
    }
}

function store(storage: StorageLike | null, key: string, value: string | null): void {
    try {
        if (value === null) storage?.removeItem(key);
        else storage?.setItem(key, value);
    } catch {
        // Remembered for this page's life only.
    }
}

function readWanted(storage: StorageLike | null): boolean {
    try {
        return storage?.getItem(PUSH_ENABLED_KEY) === '1';
    } catch {
        return false;
    }
}

/** Is this subscription bound to `publicKey`? A browser that does not say is taken at its word. */
function boundTo(subscription: PushSubscriptionLike, publicKey: string): boolean {
    const key = subscription.options?.applicationServerKey;
    if (key === undefined || key === null) return true;
    return toBase64url(new Uint8Array(key)) === publicKey;
}

function message(error: unknown): string {
    return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}

export function createPushDevice(browser: PushBrowser = realPushBrowser()): PushDevice {
    const listeners = new Set<() => void>();
    let state: PushDeviceState = {
        availability: 'unsupported',
        permission: 'default',
        wanted: readWanted(browser.storage),
        registration: null,
        busy: false,
        error: null
    };
    const set = (patch: Partial<PushDeviceState>): void => {
        state = { ...state, ...patch };
        for (const listener of [...listeners]) listener();
    };

    /** The subscription for this device's pair, made if missing (permission must already be granted). */
    const ensureSubscription = async (): Promise<PushRegistrationInfo> => {
        let vapid = readVapid(browser.storage);
        if (vapid === null) {
            vapid = await browser.generateVapid();
            store(browser.storage, PUSH_VAPID_KEY, JSON.stringify(vapid));
        }
        const worker = await browser.worker(10_000);
        if (worker === null) throw new Error("Kelpi's service worker is not running. Close and reopen the app, then try again.");
        let subscription = await worker.pushManager.getSubscription();
        if (subscription !== null && !boundTo(subscription, vapid.publicKey)) {
            await subscription.unsubscribe().catch(() => false);
            subscription = null;
        }
        subscription ??= await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64url(vapid.publicKey) });
        const keys = subscription.toJSON().keys ?? {};
        const p256dh = keys['p256dh'];
        const auth = keys['auth'];
        if (p256dh === undefined || auth === undefined) throw new Error('The browser made a push subscription without keys.');
        return { endpoint: subscription.endpoint, p256dh, auth, vapidPublicKey: vapid.publicKey, vapidPrivateKey: vapid.privateKey };
    };

    return {
        getState: () => state,

        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },

        async refresh() {
            const availability = pushAvailability(browser.facts());
            const permission = availability === 'available' ? browser.permission() : 'default';
            const wanted = readWanted(browser.storage);
            set({ availability, permission, wanted });
            if (availability !== 'available' || !wanted) {
                set({ registration: null });
                return;
            }
            if (permission !== 'granted') {
                set({ registration: null, error: permission === 'denied' ? BLOCKED_MESSAGE : null });
                return;
            }
            set({ busy: true });
            try {
                const registration = await ensureSubscription();
                // Turned off while this was in flight: what it made is not wanted, so it goes again.
                if (!readWanted(browser.storage)) {
                    const worker = await browser.worker(5_000);
                    await (await worker?.pushManager.getSubscription())?.unsubscribe().catch(() => false);
                    set({ registration: null, busy: false });
                    return;
                }
                set({ registration, busy: false, error: null });
            } catch (error) {
                set({ registration: null, busy: false, error: message(error) });
            }
        },

        async enable() {
            const availability = pushAvailability(browser.facts());
            if (availability !== 'available') {
                set({ availability });
                return;
            }
            // First, before any await: Safari only shows the prompt inside the tap's activation.
            const asking = browser.permission() === 'default' ? browser.requestPermission() : Promise.resolve(browser.permission());
            set({ busy: true, error: null });
            const permission = await asking.catch((): NotificationPermissionState => 'denied');
            set({ permission });
            if (permission !== 'granted') {
                set({ busy: false, error: permission === 'denied' ? BLOCKED_MESSAGE : NOT_ALLOWED_MESSAGE });
                return;
            }
            try {
                const registration = await ensureSubscription();
                store(browser.storage, PUSH_ENABLED_KEY, '1');
                set({ wanted: true, registration, busy: false });
            } catch (error) {
                set({ busy: false, error: message(error) });
            }
        },

        async disable() {
            store(browser.storage, PUSH_ENABLED_KEY, null);
            set({ wanted: false, registration: null, busy: true, error: null });
            try {
                const worker = await browser.worker(5_000);
                const subscription = await worker?.pushManager.getSubscription();
                await subscription?.unsubscribe();
            } catch {
                // A subscription that would not drop is refused by the hosts it was taken off.
            }
            set({ busy: false });
        },

        async renew() {
            if (!readWanted(browser.storage) || pushAvailability(browser.facts()) !== 'available' || browser.permission() !== 'granted') return;
            set({ busy: true });
            try {
                const worker = await browser.worker(5_000);
                await (await worker?.pushManager.getSubscription())?.unsubscribe().catch(() => false);
                const registration = await ensureSubscription();
                if (!readWanted(browser.storage)) {
                    await (await worker?.pushManager.getSubscription())?.unsubscribe().catch(() => false);
                    set({ registration: null, busy: false });
                    return;
                }
                set({ registration, busy: false, error: null });
            } catch (error) {
                set({ registration: null, busy: false, error: message(error) });
            }
        },

        async closeNotifications(match) {
            try {
                const worker = await browser.worker(2_000);
                for (const shown of (await worker?.getNotifications()) ?? []) {
                    const data = typeof shown.data === 'object' && shown.data !== null ? (shown.data as Record<string, unknown>) : {};
                    const host = typeof data['host'] === 'string' ? data['host'] : null;
                    const paneID = typeof data['paneID'] === 'string' ? data['paneID'] : null;
                    if (match({ host, paneID })) shown.close();
                }
            } catch {
                // Nothing shown, or nothing to ask: there is nothing to close.
            }
        }
    };
}

let shared: PushDevice | undefined;

/** The page's one device; made on first use so a desktop window never touches any of it. */
export function pushDevice(): PushDevice {
    shared ??= createPushDevice();
    return shared;
}

// ── a tap on a notification, read on the page side ──────────────────────────────────

export interface PushOpenTarget {
    readonly host: string;
    readonly workspaceID: string;
    readonly paneID: string;
}

/** The fragment a fresh window opens on (`push-payload.ts` `pushOpenHash`). */
export function readPushOpenHash(hash: string): PushOpenTarget | null {
    if (!hash.startsWith(PUSH_OPEN_HASH_PREFIX)) return null;
    const parts = hash.slice(PUSH_OPEN_HASH_PREFIX.length).split('/');
    if (parts.length !== 3) return null;
    try {
        const [host, workspaceID, paneID] = parts.map(decodeURIComponent) as [string, string, string];
        return host.length > 0 && workspaceID.length > 0 && paneID.length > 0 ? { host, workspaceID, paneID } : null;
    } catch {
        return null;
    }
}

/** The message the worker posts to a window already open. */
export function readPushOpenMessage(data: unknown): PushOpenTarget | null {
    if (typeof data !== 'object' || data === null) return null;
    const record = data as Record<string, unknown>;
    if (record['type'] !== PUSH_OPEN_MESSAGE) return null;
    const { host, workspaceID, paneID } = record;
    return typeof host === 'string' && host.length > 0 && typeof workspaceID === 'string' && workspaceID.length > 0 && typeof paneID === 'string' && paneID.length > 0
        ? { host, workspaceID, paneID }
        : null;
}

/** The tap the worker wrote down (`push-payload.ts` `pushOpenRecord`), if it is recent. */
export function readPushOpenRecord(text: string, nowMs: number): PushOpenTarget | null {
    try {
        const record = JSON.parse(text) as Record<string, unknown>;
        const at = record['at'];
        if (typeof at !== 'number' || nowMs - at > PUSH_OPEN_RECORD_MAX_AGE_MS || at - nowMs > PUSH_OPEN_RECORD_MAX_AGE_MS) return null;
        return readPushOpenMessage({ ...record, type: PUSH_OPEN_MESSAGE });
    } catch {
        return null;
    }
}

export interface PushOpenCaches {
    open(name: string): Promise<{
        match(path: string): Promise<{ text(): Promise<string> } | undefined>;
        delete(path: string): Promise<boolean>;
    }>;
}

/** Take the tap the worker wrote down: read once, then gone, whatever it said. */
export async function takePushOpenRecord(
    storage: PushOpenCaches | undefined = (globalThis as { caches?: PushOpenCaches }).caches,
    nowMs: number = Date.now()
): Promise<PushOpenTarget | null> {
    if (storage === undefined) return null;
    try {
        const cache = await storage.open(PUSH_OPEN_CACHE);
        const entry = await cache.match(PUSH_OPEN_RECORD_PATH);
        if (entry === undefined) return null;
        await cache.delete(PUSH_OPEN_RECORD_PATH);
        return readPushOpenRecord(await entry.text(), nowMs);
    } catch {
        return null;
    }
}
