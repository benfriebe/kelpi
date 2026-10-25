import { createECDH, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PUSH_PATH_ENV, createPushService, loadPushRegistrations, pushPayload, resolvePushPath, type PushSubscribeInput } from './service.js';
import { MAX_PAYLOAD_BYTES, type PushSendOptions, type PushSendResult, type PushTarget, type VapidKeys } from './webpush.js';

let root: string;
let file: string;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpid-push-'));
    file = path.join(root, 'push.json');
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

function vapid(): { vapidPublicKey: string; vapidPrivateKey: string } {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const point = publicKey.export({ format: 'jwk' });
    return {
        vapidPublicKey: Buffer.concat([Buffer.from([4]), Buffer.from(point.x ?? '', 'base64url'), Buffer.from(point.y ?? '', 'base64url')]).toString('base64url'),
        vapidPrivateKey: privateKey.export({ format: 'jwk' }).d ?? ''
    };
}

function subscription(endpoint: string, host = 'origin'): PushSubscribeInput {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    return { endpoint, p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url'), host, ...vapid() };
}

interface Sent {
    readonly target: PushTarget;
    readonly keys: VapidKeys;
    readonly payload: Record<string, unknown>;
    readonly options: PushSendOptions;
}

function fakeSend(statusFor: (endpoint: string) => number = () => 201): {
    send: (target: PushTarget, keys: VapidKeys, payload: Buffer, options: PushSendOptions) => Promise<PushSendResult>;
    sent: Sent[];
} {
    const sent: Sent[] = [];
    return {
        sent,
        send: (target, keys, payload, options) => {
            sent.push({ target, keys, payload: JSON.parse(payload.toString()) as Record<string, unknown>, options });
            const status = statusFor(target.endpoint);
            return Promise.resolve({ status, gone: status === 404 || status === 410, ok: status >= 200 && status < 300 });
        }
    };
}

const notice = { kind: 'waiting', title: 'Claude', body: 'Waiting for your input', dedupeKey: 'kelpi-pane-1', paneID: 'pane-1', workspaceID: 'ws-1' };

describe('resolvePushPath', () => {
    it('honours the env override and defaults to push.json in the data dir', () => {
        expect(resolvePushPath({ [PUSH_PATH_ENV]: file })).toBe(file);
        expect(resolvePushPath({})).toMatch(/push\.json$/);
    });
});

describe('createPushService', () => {
    it('stores a subscription 0600 and pushes the notification to it with the host key', async () => {
        const { send, sent } = fakeSend();
        const service = createPushService({ file, send });
        const input = subscription('https://web.push.apple.com/abc', 'phone:42');
        service.subscribe(input, 'hash-1');

        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        expect(loadPushRegistrations(file)).toMatchObject([{ endpoint: input.endpoint, host: 'phone:42', credentialHash: 'hash-1' }]);

        await service.deliver(notice, new Set());
        expect(sent).toHaveLength(1);
        expect(sent[0]?.payload).toEqual({ v: 1, kind: 'waiting', title: 'Claude', body: 'Waiting for your input', tag: 'kelpi-pane-1', host: 'phone:42', workspaceID: 'ws-1', paneID: 'pane-1' });
        expect(sent[0]?.keys).toEqual({ publicKey: input.vapidPublicKey, privateKey: input.vapidPrivateKey });
        expect(sent[0]?.options.topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
        expect(sent[0]?.options.ttlSeconds).toBeGreaterThan(0);
    });

    it('survives a restart: a second service reads the same file', async () => {
        createPushService({ file, send: fakeSend().send }).subscribe(subscription('https://fcm.googleapis.com/fcm/send/1'), null);
        const { send, sent } = fakeSend();
        const reborn = createPushService({ file, send });
        expect(reborn.size).toBe(1);
        await reborn.deliver(notice, new Set());
        expect(sent).toHaveLength(1);
    });

    it('skips the phones that are looking at Kelpi', async () => {
        const { send, sent } = fakeSend();
        const service = createPushService({ file, send });
        service.subscribe(subscription('https://fcm.googleapis.com/fcm/send/a'), null);
        service.subscribe(subscription('https://fcm.googleapis.com/fcm/send/b'), null);
        await service.deliver(notice, new Set(['https://fcm.googleapis.com/fcm/send/a']));
        expect(sent.map((entry) => entry.target.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/b']);
    });

    it('forgets a subscription the push service says is gone', async () => {
        const { send } = fakeSend((endpoint) => (endpoint.endsWith('/dead') ? 410 : 201));
        const lines: string[] = [];
        const service = createPushService({ file, send, log: (line) => lines.push(line) });
        service.subscribe(subscription('https://fcm.googleapis.com/fcm/send/dead'), null);
        service.subscribe(subscription('https://fcm.googleapis.com/fcm/send/live'), null);
        await service.deliver(notice, new Set());
        expect(service.has('https://fcm.googleapis.com/fcm/send/dead')).toBe(false);
        expect(service.has('https://fcm.googleapis.com/fcm/send/live')).toBe(true);
        expect(loadPushRegistrations(file)).toHaveLength(1);
        // The endpoint is a capability: only its origin is logged.
        expect(lines.join('\n')).toContain('https://fcm.googleapis.com');
        expect(lines.join('\n')).not.toContain('/dead');
    });

    it('reports a refusal without forgetting, and never rejects on a network failure', async () => {
        const errors: string[] = [];
        let calls = 0;
        const service = createPushService({
            file,
            send: () => {
                calls += 1;
                return calls === 1 ? Promise.resolve({ status: 403, gone: false, ok: false }) : Promise.reject(new Error('ECONNRESET'));
            },
            onError: (error) => errors.push(error.message)
        });
        service.subscribe(subscription('https://web.push.apple.com/x'), null);
        await service.deliver(notice, new Set());
        await service.deliver({ ...notice, dedupeKey: 'kelpi-pane-2', paneID: 'pane-2' }, new Set());
        expect(service.size).toBe(1);
        expect(errors).toEqual(['push to https://web.push.apple.com refused: HTTP 403', 'push to https://web.push.apple.com failed: ECONNRESET']);
    });

    it('stops pushing for a revoked credential, at send time and on prune', async () => {
        const live = new Set(['hash-a', 'hash-b']);
        const { send, sent } = fakeSend();
        const service = createPushService({ file, send, credentialValid: (hash) => live.has(hash) });
        service.subscribe(subscription('https://fcm.googleapis.com/fcm/send/a'), 'hash-a');
        service.subscribe(subscription('https://fcm.googleapis.com/fcm/send/b'), 'hash-b');
        service.subscribe(subscription('https://fcm.googleapis.com/fcm/send/owner'), null);

        live.delete('hash-a');
        await service.deliver(notice, new Set());
        expect(sent.map((entry) => entry.target.endpoint).sort()).toEqual(['https://fcm.googleapis.com/fcm/send/b', 'https://fcm.googleapis.com/fcm/send/owner']);
        expect(service.has('https://fcm.googleapis.com/fcm/send/a')).toBe(false);

        live.delete('hash-b');
        expect(service.prune()).toBe(1);
        expect(loadPushRegistrations(file).map((entry) => entry.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/owner']);
    });

    it('refuses a subscription it could never deliver to', () => {
        const service = createPushService({ file, send: fakeSend().send });
        const good = subscription('https://fcm.googleapis.com/fcm/send/ok');
        expect(() => service.subscribe({ ...good, endpoint: 'http://fcm.googleapis.com/x' }, null)).toThrow(/https/);
        expect(() => service.subscribe({ ...good, endpoint: 'not a url' }, null)).toThrow(/not a URL/);
        expect(() => service.subscribe({ ...good, p256dh: Buffer.alloc(65, 4).toString('base64url') }, null)).toThrow(/p256dh/);
        expect(() => service.subscribe({ ...good, auth: 'AAAA' }, null)).toThrow(/auth/);
        expect(() => service.subscribe({ ...good, vapidPrivateKey: vapid().vapidPrivateKey }, null)).toThrow(/does not match/);
        expect(() => service.subscribe({ ...good, host: '' }, null)).toThrow(/host/);
        // A compressed point agrees a secret, and then no push can be sealed to it.
        const ua = createECDH('prime256v1');
        ua.generateKeys();
        expect(() => service.subscribe({ ...good, p256dh: ua.getPublicKey(null, 'compressed').toString('base64url') }, null)).toThrow(/p256dh/);
        // Junk node's decoder would skip, stored and sent with the key.
        expect(() => service.subscribe({ ...good, p256dh: `${good.p256dh}${'!'.repeat(4096)}` }, null)).toThrow(/p256dh/);
        expect(() => service.subscribe({ ...good, vapidPublicKey: `${good.vapidPublicKey}!` }, null)).toThrow(/VAPID public key/);
        expect(() => service.subscribe({ ...good, endpoint: `https://fcm.googleapis.com/${'x'.repeat(4096)}` }, null)).toThrow(/too long/);
        expect(service.size).toBe(0);
        expect(fs.existsSync(file)).toBe(false);
    });

    it('re-registering the same subscription does not rewrite the file; a new host key does', () => {
        const service = createPushService({ file, send: fakeSend().send, now: () => 1_000 });
        const input = subscription('https://fcm.googleapis.com/fcm/send/1');
        service.subscribe(input, null);
        const first = fs.statSync(file).mtimeMs;
        fs.utimesSync(file, 0, 0);
        service.subscribe(input, null);
        expect(fs.statSync(file).mtimeMs).toBe(0);
        service.subscribe({ ...input, host: 'phone:9' }, null);
        expect(fs.statSync(file).mtimeMs).not.toBe(0);
        expect(first).toBeGreaterThan(0);
    });

    it('unsubscribe forgets, and test pushes to one subscription only', async () => {
        const { send, sent } = fakeSend();
        const service = createPushService({ file, send, hostname: 'werk.local' });
        service.subscribe(subscription('https://fcm.googleapis.com/fcm/send/a', 'origin'), null);
        service.subscribe(subscription('https://fcm.googleapis.com/fcm/send/b', 'origin'), null);

        await expect(service.test('https://fcm.googleapis.com/fcm/send/a')).resolves.toEqual({ ok: true, status: 201 });
        expect(sent).toHaveLength(1);
        expect(sent[0]?.payload).toMatchObject({ kind: 'test', title: 'Kelpi', body: 'Notifications from werk are working.', host: 'origin' });

        expect(service.unsubscribe('https://fcm.googleapis.com/fcm/send/a')).toBe(true);
        expect(service.unsubscribe('https://fcm.googleapis.com/fcm/send/a')).toBe(false);
        await expect(service.test('https://fcm.googleapis.com/fcm/send/a')).rejects.toThrow(/no push subscription/);
    });

    it('paces a storm: one push in flight per phone, the newest per pane, a pane again only after the gap', async () => {
        vi.useFakeTimers();
        try {
            const sent: { tag: unknown; body: unknown }[] = [];
            let inFlight = 0;
            let most = 0;
            const service = createPushService({
                file,
                send: (_target, _keys, payload) => {
                    const parsed = JSON.parse(payload.toString()) as Record<string, unknown>;
                    sent.push({ tag: parsed['tag'], body: parsed['body'] });
                    inFlight += 1;
                    most = Math.max(most, inFlight);
                    return new Promise((resolve) =>
                        setTimeout(() => {
                            inFlight -= 1;
                            resolve({ status: 201, gone: false, ok: true });
                        }, 100)
                    );
                }
            });
            service.subscribe(subscription('https://web.push.apple.com/storm'), null);
            // `cat` of a file full of OSC 9: two hundred notifications for one pane, and one for another.
            const done: Promise<void>[] = [];
            for (let line = 0; line < 200; line += 1) done.push(service.deliver({ ...notice, body: `line ${String(line)}` }, new Set()));
            done.push(service.deliver({ ...notice, dedupeKey: 'kelpi-pane-2', paneID: 'pane-2', body: 'other pane' }, new Set()));

            await vi.advanceTimersByTimeAsync(1_000);
            expect(sent).toEqual([
                { tag: 'kelpi-pane-1', body: 'line 0' },
                { tag: 'kelpi-pane-2', body: 'other pane' }
            ]);
            await vi.advanceTimersByTimeAsync(5_000);
            expect(sent[2]).toEqual({ tag: 'kelpi-pane-1', body: 'line 199' });
            await Promise.all(done);
            expect(sent).toHaveLength(3);
            expect(most).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('holds a phone’s pushes while its push service asks (429), then sends the newest', async () => {
        vi.useFakeTimers();
        try {
            const bodies: unknown[] = [];
            const service = createPushService({
                file,
                send: (_target, _keys, payload) => {
                    bodies.push((JSON.parse(payload.toString()) as Record<string, unknown>)['body']);
                    return Promise.resolve(bodies.length === 1 ? { status: 429, gone: false, ok: false, retryAfterMs: 20_000 } : { status: 201, gone: false, ok: true });
                },
                onError: () => undefined
            });
            service.subscribe(subscription('https://web.push.apple.com/busy'), null);
            const first = service.deliver({ ...notice, body: 'first' }, new Set());
            await vi.advanceTimersByTimeAsync(0);
            const second = service.deliver({ ...notice, dedupeKey: 'kelpi-pane-2', paneID: 'pane-2', body: 'second' }, new Set());
            await vi.advanceTimersByTimeAsync(19_000);
            expect(bodies).toEqual(['first']);
            await vi.advanceTimersByTimeAsync(1_000);
            await Promise.all([first, second]);
            expect(bodies).toEqual(['first', 'first', 'second']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('reuses one VAPID header per push service for an hour (Apple asks for no more)', async () => {
        const clock = { now: 1_700_000_000_000 };
        const { send, sent } = fakeSend();
        const service = createPushService({ file, send, now: () => clock.now });
        service.subscribe(subscription('https://web.push.apple.com/a'), null);
        const pane = (n: number) => ({ ...notice, dedupeKey: `kelpi-pane-${String(n)}`, paneID: `pane-${String(n)}` });
        await service.deliver(pane(1), new Set());
        clock.now += 30 * 60_000;
        await service.deliver(pane(2), new Set());
        clock.now += 31 * 60_000;
        await service.deliver(pane(3), new Set());
        const headers = sent.map((entry) => entry.options.authorization);
        expect(headers[0]).toMatch(/^vapid t=.+, k=/);
        expect(headers[1]).toBe(headers[0]);
        expect(headers[2]).not.toBe(headers[0]);
    });

    it('evicts the phone gone quietest when full, not the one registered first', () => {
        const clock = { now: 1_700_000_000_000 };
        const service = createPushService({ file, send: fakeSend().send, now: () => clock.now });
        const daily = subscription('https://fcm.googleapis.com/fcm/send/daily');
        service.subscribe(daily, null);
        for (let n = 0; n < 63; n += 1) {
            clock.now += 1_000;
            service.subscribe(subscription(`https://fcm.googleapis.com/fcm/send/${String(n)}`), null);
        }
        // The first phone reconnects: an unchanged registration, no write, but it is alive.
        clock.now += 1_000;
        service.subscribe(daily, null);
        clock.now += 1_000;
        service.subscribe(subscription('https://fcm.googleapis.com/fcm/send/new'), null);
        expect(service.size).toBe(64);
        expect(service.has(daily.endpoint)).toBe(true);
        expect(service.has('https://fcm.googleapis.com/fcm/send/0')).toBe(false);
    });

    it('reads a corrupt file as empty and says so', () => {
        fs.writeFileSync(file, '{"nope": true}');
        const errors: string[] = [];
        const service = createPushService({ file, send: fakeSend().send, onError: (error) => errors.push(error.message) });
        expect(service.size).toBe(0);
        expect(errors[0]).toMatch(/not a push registry/);
    });
});

describe('pushPayload', () => {
    it('cuts a long message to fit one record, keeping the routing', () => {
        const bytes = pushPayload({ v: 1, kind: 'agent', title: 't'.repeat(500), body: '🦭'.repeat(2000), tag: 'kelpi-p', host: 'origin', workspaceID: 'w', paneID: 'p' });
        expect(bytes.length).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
        const parsed = JSON.parse(bytes.toString()) as Record<string, string>;
        expect(parsed['title']?.length).toBe(200);
        expect(parsed['paneID']).toBe('p');
        expect(parsed['host']).toBe('origin');
    });
});
