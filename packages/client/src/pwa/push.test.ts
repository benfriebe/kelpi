import { describe, expect, it } from 'vitest';

import type { StorageLike } from '../app/config';
import type { NotificationPermissionState } from '../state';
import {
    PUSH_ENABLED_KEY,
    PUSH_VAPID_KEY,
    createPushDevice,
    fromBase64url,
    pushAvailability,
    takePushOpenRecord,
    toBase64url,
    type PushBrowser,
    type PushFacts,
    type PushSubscriptionLike,
    type PushWorkerLike
} from './push';

const AVAILABLE: PushFacts = { shell: false, secureContext: true, ios: false, standalone: false, serviceWorker: true, pushManager: true, notification: true };

function memoryStorage(): StorageLike & { readonly map: Map<string, string> } {
    const map = new Map<string, string>();
    return { map, getItem: (key) => map.get(key) ?? null, setItem: (key, value) => void map.set(key, value), removeItem: (key) => void map.delete(key) };
}

const VAPID = { publicKey: toBase64url(new Uint8Array(65).fill(4)), privateKey: toBase64url(new Uint8Array(32).fill(9)) };

interface FakeBrowser extends PushBrowser {
    readonly log: string[];
    permissionState: NotificationPermissionState;
    answer: NotificationPermissionState;
    subscription: PushSubscriptionLike | null;
    shown: { data: unknown; closed: boolean }[];
    facts: () => PushFacts;
}

function subscriptionFor(endpoint: string, publicKey: string, log: string[], onDrop: () => void): PushSubscriptionLike {
    return {
        endpoint,
        options: { applicationServerKey: fromBase64url(publicKey).buffer as ArrayBuffer },
        toJSON: () => ({ keys: { p256dh: 'BKey', auth: 'secret' } }),
        unsubscribe: () => {
            log.push(`unsubscribe ${endpoint}`);
            onDrop();
            return Promise.resolve(true);
        }
    };
}

function fakeBrowser(facts: PushFacts = AVAILABLE, storage = memoryStorage()): FakeBrowser {
    const log: string[] = [];
    let count = 0;
    const browser: FakeBrowser = {
        log,
        permissionState: 'default',
        answer: 'granted',
        subscription: null,
        shown: [],
        storage,
        facts: () => facts,
        permission: () => browser.permissionState,
        requestPermission: () => {
            log.push('requestPermission');
            browser.permissionState = browser.answer;
            return Promise.resolve(browser.answer);
        },
        generateVapid: () => {
            log.push('generateVapid');
            return Promise.resolve(VAPID);
        },
        worker: () => {
            log.push('worker');
            const worker: PushWorkerLike = {
                pushManager: {
                    getSubscription: () => Promise.resolve(browser.subscription),
                    subscribe: (options) => {
                        count += 1;
                        log.push(`subscribe ${toBase64url(options.applicationServerKey)}`);
                        browser.subscription = subscriptionFor(`https://push.example/${String(count)}`, toBase64url(options.applicationServerKey), log, () => {
                            browser.subscription = null;
                        });
                        return Promise.resolve(browser.subscription);
                    }
                },
                getNotifications: () =>
                    Promise.resolve(
                        browser.shown.map((entry) => ({
                            data: entry.data,
                            close: () => {
                                entry.closed = true;
                            }
                        }))
                    )
            };
            return Promise.resolve(worker);
        }
    };
    return browser;
}

describe('pushAvailability', () => {
    it('says what stands in the way, in the order that matters', () => {
        expect(pushAvailability(AVAILABLE)).toBe('available');
        expect(pushAvailability({ ...AVAILABLE, shell: true })).toBe('unsupported');
        expect(pushAvailability({ ...AVAILABLE, secureContext: false, ios: true })).toBe('insecure');
        // Safari in a tab has no PushManager: that is "install first", not "unsupported".
        expect(pushAvailability({ ...AVAILABLE, ios: true, standalone: false, pushManager: false })).toBe('install-first');
        expect(pushAvailability({ ...AVAILABLE, ios: true, standalone: true })).toBe('available');
        expect(pushAvailability({ ...AVAILABLE, pushManager: false })).toBe('unsupported');
    });
});

describe('base64url', () => {
    it('round-trips any bytes without padding or + and /', () => {
        const bytes = Uint8Array.from({ length: 65 }, (_, index) => (index * 37) % 256);
        const text = toBase64url(bytes);
        expect(text).not.toMatch(/[+/=]/);
        expect([...fromBase64url(text)]).toEqual([...bytes]);
    });
});

describe('createPushDevice', () => {
    it('asks for permission before anything else, then subscribes with a minted VAPID key it keeps', async () => {
        const browser = fakeBrowser();
        const device = createPushDevice(browser);
        await device.enable();
        expect(browser.log[0]).toBe('requestPermission');
        expect(browser.log).toEqual(['requestPermission', 'generateVapid', 'worker', `subscribe ${VAPID.publicKey}`]);
        expect(device.getState()).toMatchObject({
            wanted: true,
            permission: 'granted',
            busy: false,
            error: null,
            registration: { endpoint: 'https://push.example/1', p256dh: 'BKey', auth: 'secret', vapidPublicKey: VAPID.publicKey, vapidPrivateKey: VAPID.privateKey }
        });
        expect(browser.storage?.getItem(PUSH_ENABLED_KEY)).toBe('1');
        expect(JSON.parse(browser.storage?.getItem(PUSH_VAPID_KEY) ?? '{}')).toEqual(VAPID);
    });

    it('says how to unblock a refused permission and stays off', async () => {
        const browser = fakeBrowser();
        browser.answer = 'denied';
        const device = createPushDevice(browser);
        await device.enable();
        expect(device.getState()).toMatchObject({ wanted: false, registration: null, permission: 'denied' });
        expect(device.getState().error).toMatch(/Settings ▸ Notifications ▸ Kelpi/);
        expect(browser.log).toEqual(['requestPermission']);
    });

    it('does nothing where push cannot work, and reports why', async () => {
        const browser = fakeBrowser({ ...AVAILABLE, ios: true, standalone: false });
        const device = createPushDevice(browser);
        await device.enable();
        await device.refresh();
        expect(device.getState().availability).toBe('install-first');
        expect(browser.log).toEqual([]);
    });

    it('on the next launch, finds the subscription again without asking', async () => {
        const storage = memoryStorage();
        const first = fakeBrowser(AVAILABLE, storage);
        await createPushDevice(first).enable();

        const second = fakeBrowser(AVAILABLE, storage);
        second.permissionState = 'granted';
        second.subscription = first.subscription;
        const device = createPushDevice(second);
        await device.refresh();
        expect(second.log).toEqual(['worker']);
        expect(device.getState().registration?.endpoint).toBe('https://push.example/1');
    });

    it('renews a subscription the browser dropped, and replaces one bound to another key', async () => {
        const storage = memoryStorage();
        storage.setItem(PUSH_ENABLED_KEY, '1');
        storage.setItem(PUSH_VAPID_KEY, JSON.stringify(VAPID));
        const browser = fakeBrowser(AVAILABLE, storage);
        browser.permissionState = 'granted';
        const device = createPushDevice(browser);
        await device.refresh();
        expect(browser.log).toEqual(['worker', `subscribe ${VAPID.publicKey}`]);

        browser.log.length = 0;
        const other = toBase64url(new Uint8Array(65).fill(5));
        browser.subscription = subscriptionFor('https://push.example/stale', other, browser.log, () => {
            browser.subscription = null;
        });
        await device.refresh();
        expect(browser.log).toEqual(['worker', 'unsubscribe https://push.example/stale', `subscribe ${VAPID.publicKey}`]);
    });

    it('a refresh that finishes after Turn off drops what it made', async () => {
        const storage = memoryStorage();
        storage.setItem(PUSH_ENABLED_KEY, '1');
        storage.setItem(PUSH_VAPID_KEY, JSON.stringify(VAPID));
        const browser = fakeBrowser(AVAILABLE, storage);
        browser.permissionState = 'granted';
        const device = createPushDevice(browser);
        const refreshing = device.refresh();
        // Turn off lands while the refresh is still subscribing.
        await device.disable();
        await refreshing;
        expect(device.getState()).toMatchObject({ wanted: false, registration: null });
        expect(browser.subscription).toBeNull();
    });

    it('renews onto a fresh endpoint under the same key, and only while push is on', async () => {
        const browser = fakeBrowser();
        const device = createPushDevice(browser);
        await device.renew();
        expect(browser.log).toEqual([]);

        await device.enable();
        browser.log.length = 0;
        await device.renew();
        expect(browser.log).toEqual(['worker', 'unsubscribe https://push.example/1', 'worker', `subscribe ${VAPID.publicKey}`]);
        expect(device.getState()).toMatchObject({ wanted: true, busy: false, registration: { endpoint: 'https://push.example/2', vapidPublicKey: VAPID.publicKey } });
    });

    it('a permission revoked in the phone settings reads as blocked, not on', async () => {
        const storage = memoryStorage();
        storage.setItem(PUSH_ENABLED_KEY, '1');
        const browser = fakeBrowser(AVAILABLE, storage);
        browser.permissionState = 'denied';
        const device = createPushDevice(browser);
        await device.refresh();
        expect(device.getState()).toMatchObject({ wanted: true, registration: null });
        expect(device.getState().error).toMatch(/blocked/);
    });

    it('turning off forgets the choice and drops the browser subscription', async () => {
        const browser = fakeBrowser();
        const device = createPushDevice(browser);
        await device.enable();
        await device.disable();
        expect(device.getState()).toMatchObject({ wanted: false, registration: null, busy: false });
        expect(browser.storage?.getItem(PUSH_ENABLED_KEY)).toBeNull();
        expect(browser.log).toContain('unsubscribe https://push.example/1');
    });

    it('closes only the notifications that match', async () => {
        const browser = fakeBrowser();
        browser.shown = [
            { data: { host: 'origin', paneID: 'p1' }, closed: false },
            { data: { host: 'phone:2', paneID: 'p1' }, closed: false },
            { data: null, closed: false }
        ];
        await createPushDevice(browser).closeNotifications((data) => data.host === 'origin' && data.paneID === 'p1');
        expect(browser.shown.map((entry) => entry.closed)).toEqual([true, false, false]);
    });

    it('tells its listeners about every change', async () => {
        const device = createPushDevice(fakeBrowser());
        const seen: boolean[] = [];
        const off = device.subscribe(() => seen.push(device.getState().busy));
        await device.enable();
        off();
        expect(seen).toContain(true);
        expect(seen[seen.length - 1]).toBe(false);
    });
});

describe('takePushOpenRecord', () => {
    function fakeCaches(text: string | null): { caches: Parameters<typeof takePushOpenRecord>[0]; deleted: string[] } {
        const deleted: string[] = [];
        let stored = text;
        return {
            deleted,
            caches: {
                open: (name) => {
                    expect(name).toBe('kelpi-push-open');
                    return Promise.resolve({
                        match: (path) => {
                            expect(path).toBe('/__kelpi/push-open');
                            const body = stored;
                            return Promise.resolve(body === null ? undefined : { text: () => Promise.resolve(body) });
                        },
                        delete: (path) => {
                            deleted.push(path);
                            stored = null;
                            return Promise.resolve(true);
                        }
                    });
                }
            }
        };
    }
    const target = { host: 'origin', workspaceID: 'w1', paneID: 'p1' };

    it('takes a fresh tap once', async () => {
        const { caches, deleted } = fakeCaches(JSON.stringify({ ...target, at: 5_000 }));
        await expect(takePushOpenRecord(caches, 6_000)).resolves.toEqual(target);
        expect(deleted).toEqual(['/__kelpi/push-open']);
        await expect(takePushOpenRecord(caches, 6_000)).resolves.toBeNull();
    });

    it('drops a stale one, and is nothing without cache storage', async () => {
        const { caches, deleted } = fakeCaches(JSON.stringify({ ...target, at: 5_000 }));
        await expect(takePushOpenRecord(caches, 5_000 + 10 * 60_000)).resolves.toBeNull();
        expect(deleted).toHaveLength(1);
        await expect(takePushOpenRecord(undefined)).resolves.toBeNull();
    });
});
