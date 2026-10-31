import { createDecipheriv, createECDH, createPublicKey, generateKeyPairSync, hkdfSync, verify } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { MAX_PAYLOAD_BYTES, VAPID_SUBJECT, encryptPayload, pushTopic, sendPush, vapidAuthorization, vapidSigningKey, type VapidKeys } from './webpush.js';

/** RFC 8291 Appendix A, whitespace removed. */
const RFC = {
    plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
    asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
    salt: 'DGv6ra1nlYgDCS1FRnbzlw',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ'
};

const b64 = (value: string): Buffer => Buffer.from(value, 'base64url');

/** The user agent's half of RFC 8291, so a fresh (random) encryption can be checked too. */
function decrypt(body: Buffer, uaPrivate: Buffer, auth: Buffer): Buffer {
    const salt = body.subarray(0, 16);
    const idlen = body.readUInt8(20);
    const asPublic = body.subarray(21, 21 + idlen);
    const ua = createECDH('prime256v1');
    ua.setPrivateKey(uaPrivate);
    const secret = ua.computeSecret(asPublic);
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), ua.getPublicKey(), asPublic]);
    const ikm = Buffer.from(hkdfSync('sha256', secret, auth, keyInfo, 32));
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12));
    const sealed = body.subarray(21 + idlen);
    const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    const padded = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
    expect(padded[padded.length - 1]).toBe(2);
    return padded.subarray(0, padded.length - 1);
}

function vapidPair(): VapidKeys {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = privateKey.export({ format: 'jwk' });
    const point = publicKey.export({ format: 'jwk' });
    return {
        publicKey: Buffer.concat([Buffer.from([4]), b64(point.x ?? ''), b64(point.y ?? '')]).toString('base64url'),
        privateKey: jwk.d ?? ''
    };
}

describe('encryptPayload (RFC 8291)', () => {
    it('reproduces Appendix A byte for byte', () => {
        const body = encryptPayload(b64(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.auth }, { localPrivateKey: b64(RFC.asPrivate), salt: b64(RFC.salt) });
        expect(body.subarray(0, 86).toString('base64url')).toBe(RFC.header);
        expect(body.subarray(86).toString('base64url')).toBe(RFC.ciphertext);
    });

    it('seals a fresh message the user agent can open', () => {
        const ua = createECDH('prime256v1');
        ua.generateKeys();
        const auth = Buffer.alloc(16, 7);
        const message = Buffer.from(JSON.stringify({ title: 'Claude', body: 'waiting for you' }));
        const body = encryptPayload(message, { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') });
        expect(body.readUInt32BE(16)).toBe(4096);
        expect(decrypt(body, ua.getPrivateKey(), auth).toString()).toBe(message.toString());
    });

    it('refuses a payload that does not fit one record, and malformed keys', () => {
        expect(() => encryptPayload(Buffer.alloc(MAX_PAYLOAD_BYTES + 1), { p256dh: RFC.uaPublic, auth: RFC.auth })).toThrow(/one record/);
        expect(() => encryptPayload(Buffer.from('x'), { p256dh: 'AAAA', auth: RFC.auth })).toThrow(/p256dh/);
        expect(() => encryptPayload(Buffer.from('x'), { p256dh: RFC.uaPublic, auth: 'AAAA' })).toThrow(/auth/);
        // node's own decoder would skip the junk and read the key.
        expect(() => encryptPayload(Buffer.from('x'), { p256dh: `${RFC.uaPublic}!!!!`, auth: RFC.auth })).toThrow(/p256dh/);
        expect(() => encryptPayload(Buffer.from('x'), { p256dh: RFC.uaPublic, auth: `${RFC.auth}==` })).toThrow(/auth/);
    });
});

describe('VAPID (RFC 8292)', () => {
    it('signs an ES256 JWT for the endpoint origin that verifies against the public key', () => {
        const keys = vapidPair();
        const header = vapidAuthorization('https://web.push.apple.com/QGuQyavXutnMH/abc', keys, 1_700_000_000_000);
        const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
        expect(match).not.toBeNull();
        const [, head, claims, signature, k] = match as unknown as [string, string, string, string, string];
        expect(k).toBe(keys.publicKey);
        expect(JSON.parse(b64(head).toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
        expect(JSON.parse(b64(claims).toString())).toEqual({ aud: 'https://web.push.apple.com', exp: 1_700_000_000 + 43_200, sub: VAPID_SUBJECT });
        const point = b64(keys.publicKey);
        const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') }, format: 'jwk' });
        expect(verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, b64(signature))).toBe(true);
    });

    it('refuses a private key that is not the public key’s', () => {
        const one = vapidPair();
        const two = vapidPair();
        expect(() => vapidSigningKey({ publicKey: one.publicKey, privateKey: two.privateKey })).toThrow(/does not match/);
        expect(() => vapidSigningKey({ publicKey: 'AAAA', privateKey: one.privateKey })).toThrow(/65 bytes/);
    });
});

describe('pushTopic', () => {
    it('is stable, at most 32 characters, and URL-safe', () => {
        const topic = pushTopic('kelpi-6f1c2a54-0000-4000-8000-000000000000');
        expect(topic).toBe(pushTopic('kelpi-6f1c2a54-0000-4000-8000-000000000000'));
        expect(topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
        expect(pushTopic('kelpi-other')).not.toBe(topic);
    });
});

describe('sendPush', () => {
    it('POSTs the sealed body with the RFC 8030 headers and reads 410 as gone', async () => {
        const ua = createECDH('prime256v1');
        ua.generateKeys();
        const auth = Buffer.alloc(16, 3);
        const keys = vapidPair();
        const calls: { url: string; init: RequestInit }[] = [];
        const fakeFetch = ((url: string, init: RequestInit) => {
            calls.push({ url, init });
            return Promise.resolve(new Response(null, { status: calls.length === 1 ? 201 : 410 }));
        }) as unknown as typeof fetch;
        const target = { endpoint: 'https://fcm.googleapis.com/fcm/send/xyz', p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };

        const first = await sendPush(target, keys, Buffer.from('{"title":"hi"}'), { ttlSeconds: 3600, topic: 'abc', nowMs: Date.now(), fetch: fakeFetch });
        expect(first).toEqual({ status: 201, gone: false, ok: true });
        const headers = calls[0]?.init.headers as Record<string, string>;
        expect(calls[0]?.url).toBe(target.endpoint);
        expect(headers['Content-Encoding']).toBe('aes128gcm');
        expect(headers['TTL']).toBe('3600');
        expect(headers['Urgency']).toBe('high');
        expect(headers['Topic']).toBe('abc');
        expect(headers['Authorization']).toMatch(/^vapid t=.+, k=/);
        expect(decrypt(Buffer.from(calls[0]?.init.body as Uint8Array), ua.getPrivateKey(), auth).toString()).toBe('{"title":"hi"}');

        const second = await sendPush(target, keys, Buffer.from('{}'), { ttlSeconds: 60, nowMs: Date.now(), fetch: fakeFetch });
        expect(second).toEqual({ status: 410, gone: true, ok: false });
    });

    it('takes no redirect, cancels the body, and reads a push service’s Retry-After', async () => {
        const ua = createECDH('prime256v1');
        ua.generateKeys();
        const target = { endpoint: 'https://web.push.apple.com/xyz', p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 3).toString('base64url') };
        const answers = [
            new Response('a body nobody reads', { status: 307, headers: { location: 'http://127.0.0.1:1/admin' } }),
            new Response(null, { status: 429, headers: { 'retry-after': '120' } }),
            new Response(null, { status: 503 })
        ];
        const inits: RequestInit[] = [];
        const fakeFetch = ((_url: string, init: RequestInit) => {
            inits.push(init);
            return Promise.resolve(answers[inits.length - 1]);
        }) as unknown as typeof fetch;
        const options = { ttlSeconds: 60, nowMs: Date.now(), fetch: fakeFetch, authorization: 'vapid t=minted.earlier, k=key' };

        expect(await sendPush(target, vapidPair(), Buffer.from('{}'), options)).toEqual({ status: 307, gone: false, ok: false });
        expect(inits[0]?.redirect).toBe('manual');
        expect(answers[0]?.bodyUsed || answers[0]?.body?.locked).toBe(true);
        expect((inits[0]?.headers as Record<string, string>)['Authorization']).toBe('vapid t=minted.earlier, k=key');
        expect(await sendPush(target, vapidPair(), Buffer.from('{}'), options)).toEqual({ status: 429, gone: false, ok: false, retryAfterMs: 120_000 });
        expect(await sendPush(target, vapidPair(), Buffer.from('{}'), options)).toEqual({ status: 503, gone: false, ok: false, retryAfterMs: undefined });
    });
});
