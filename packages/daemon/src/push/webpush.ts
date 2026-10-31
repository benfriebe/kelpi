/**
 * Web Push, the sending half: RFC 8291 message encryption, RFC 8292 VAPID, and the RFC 8030
 * POST that hands a message to the phone's push service, on `node:crypto` and `fetch` alone.
 *
 * Why no `web-push` package: the daemon ships as one esbuild bundle, the whole protocol is three
 * HKDF calls, one AES-GCM seal and one ES256 signature, and RFC 8291's Appendix A pins every
 * intermediate value, so `webpush.test.ts` checks this file byte for byte against the RFC.
 *
 * What travels where. The phone's browser hands its page a SUBSCRIPTION: an `endpoint` (an https
 * URL at Apple's, Google's or Mozilla's push service) and two keys, `p256dh` (the browser's
 * P-256 public key) and `auth` (16 random bytes). The payload is sealed to those keys, so the push
 * service carries ciphertext it cannot read. The VAPID key pair is the application server's
 * identity: the subscription was made against its public key, and only a request signed with the
 * matching private key is accepted for it. In Kelpi the PHONE mints that pair and hands it to
 * every host it registers with (`push/service.ts` explains why), so this module takes the pair as
 * input rather than owning one.
 */

import { createCipheriv, createECDH, createHash, createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';

/** A browser push subscription, as `PushSubscription.toJSON()` spells it (keys base64url). */
export interface PushTarget {
    readonly endpoint: string;
    /** The browser's P-256 public key: an uncompressed point, 65 bytes, base64url. */
    readonly p256dh: string;
    /** The browser's 16-byte authentication secret, base64url. */
    readonly auth: string;
}

/** The VAPID pair the subscription was made against. */
export interface VapidKeys {
    /** Uncompressed P-256 point, 65 bytes, base64url: the page's `applicationServerKey`. */
    readonly publicKey: string;
    /** The private scalar `d`, 32 bytes, base64url. */
    readonly privateKey: string;
}

/** RFC 8291 §4's one record: everything Kelpi sends fits in it. */
const RECORD_SIZE = 4096;
/** The header (salt 16, rs 4, idlen 1, keyid 65) plus the AES-GCM tag and the 0x02 delimiter. */
const OVERHEAD = 86 + 16 + 1;
/** The most plaintext one record carries. Push services accept 4096-byte bodies at least. */
export const MAX_PAYLOAD_BYTES = RECORD_SIZE - OVERHEAD;

/**
 * RFC 8292 §2: `sub` is the operator's contact. Apple refuses a push whose JWT has no `sub` or
 * one that is not a `mailto:` or `https:` URL, so every host sends the project's own page: there
 * is no operator behind a self-hosted daemon to name.
 */
export const VAPID_SUBJECT = 'https://github.com/benfriebe/kelpi';

/** RFC 8292 §2: at most 24 hours. Twelve leaves room for a host clock that runs fast. */
const VAPID_TTL_SECONDS = 12 * 60 * 60;

/**
 * A key of exactly `length` bytes, spelled as unpadded base64url the way browsers spell it. Strict
 * on purpose: node's decoder skips characters outside the alphabet, so a lax read would accept a
 * key padded with megabytes of junk and store (and send, in VAPID's `k=`) the junk with it.
 */
export function decodeKey(value: string, what: string, length: number): Buffer {
    const bytes = value.length === Math.ceil((length * 4) / 3) && /^[A-Za-z0-9_-]+$/.test(value) ? Buffer.from(value, 'base64url') : null;
    if (bytes === null || bytes.length !== length || bytes.toString('base64url') !== value) {
        throw new Error(`${what} must be ${String(length)} bytes of unpadded base64url`);
    }
    return bytes;
}

function hkdf(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
    return Buffer.from(hkdfSync('sha256', ikm, salt, info, length));
}

/** Test seam: RFC 8291 Appendix A fixes both of these, a real send draws them fresh. */
export interface EncryptionSeed {
    /** The application server's ephemeral private key (32 bytes). */
    readonly localPrivateKey?: Buffer | undefined;
    readonly salt?: Buffer | undefined;
}

/**
 * Seal `plaintext` to a subscription's keys: the `aes128gcm` body, header included (RFC 8291 §3.4
 * and RFC 8188 §2). One record, no padding beyond the delimiter: Kelpi's payloads are small and
 * their length says nothing the endpoint's owner could not guess.
 */
export function encryptPayload(plaintext: Buffer, target: Pick<PushTarget, 'p256dh' | 'auth'>, seed: EncryptionSeed = {}): Buffer {
    if (plaintext.length > MAX_PAYLOAD_BYTES) {
        throw new Error(`push payload is ${String(plaintext.length)} bytes; one record carries ${String(MAX_PAYLOAD_BYTES)}`);
    }
    const uaPublic = decodeKey(target.p256dh, 'p256dh', 65);
    const authSecret = decodeKey(target.auth, 'auth', 16);
    const local = createECDH('prime256v1');
    if (seed.localPrivateKey !== undefined) local.setPrivateKey(seed.localPrivateKey);
    else local.generateKeys();
    const asPublic = local.getPublicKey();
    const ecdhSecret = local.computeSecret(uaPublic);
    const salt = seed.salt ?? randomBytes(16);

    // §3.4: combine the ECDH secret with the auth secret, then derive the content key and nonce.
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
    const ikm = hkdf(ecdhSecret, authSecret, keyInfo, 32);
    const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16);
    const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12);

    const cipher = createCipheriv('aes-128-gcm', cek, nonce);
    // 0x02: the delimiter of the last (here, only) record.
    const sealed = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

    const header = Buffer.alloc(16 + 4 + 1);
    salt.copy(header, 0);
    header.writeUInt32BE(RECORD_SIZE, 16);
    header.writeUInt8(asPublic.length, 20);
    return Buffer.concat([header, asPublic, sealed]);
}

/** The VAPID pair as a signing key, checked: a pair whose halves disagree signs nothing a push service accepts. */
export function vapidSigningKey(keys: VapidKeys): KeyObject {
    const point = decodeKey(keys.publicKey, 'VAPID public key', 65);
    if (point[0] !== 0x04) throw new Error('VAPID public key must be an uncompressed P-256 point');
    const d = decodeKey(keys.privateKey, 'VAPID private key', 32);
    const jwk = {
        kty: 'EC',
        crv: 'P-256',
        x: point.subarray(1, 33).toString('base64url'),
        y: point.subarray(33, 65).toString('base64url'),
        d: d.toString('base64url')
    };
    const key = createPrivateKey({ key: jwk, format: 'jwk' });
    // Importing does not prove `d` belongs to `x,y`; a round trip does.
    const probe = Buffer.from('kelpi-vapid-probe');
    const signature = sign('sha256', probe, key);
    const publicJwk = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
    if (!verify('sha256', probe, createPublicKey({ key: publicJwk, format: 'jwk' }), signature)) {
        throw new Error('VAPID private key does not match its public key');
    }
    return key;
}

/** RFC 8292 §3: `Authorization: vapid t=<ES256 JWT>, k=<public key>`, for this endpoint's origin. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, nowMs: number, key: KeyObject = vapidSigningKey(keys)): string {
    const segment = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${segment({ typ: 'JWT', alg: 'ES256' })}.${segment({
        aud: new URL(endpoint).origin,
        exp: Math.floor(nowMs / 1000) + VAPID_TTL_SECONDS,
        sub: VAPID_SUBJECT
    })}`;
    // JOSE wants the raw r||s pair, not node's default DER.
    const signature = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${unsigned}.${signature.toString('base64url')}, k=${keys.publicKey}`;
}

/**
 * RFC 8030 §5.4: a newer message with the same `Topic` replaces one the push service still holds
 * for an offline phone, which is the `kelpi-<paneID>` replace rule carried one hop further. A
 * topic is at most 32 characters of the base64url alphabet, so the tag is hashed into one.
 */
export function pushTopic(tag: string): string {
    return createHash('sha256').update(tag, 'utf8').digest('base64url').slice(0, 32);
}

export interface PushSendOptions {
    /** Seconds the push service keeps an undelivered message. */
    readonly ttlSeconds: number;
    readonly topic?: string | undefined;
    readonly nowMs: number;
    readonly timeoutMs?: number | undefined;
    readonly fetch?: typeof fetch | undefined;
    /** A key already built from `keys`, so a fan-out does not re-check the pair per send. */
    readonly signingKey?: KeyObject | undefined;
    /**
     * A VAPID header minted earlier for this endpoint's origin and key. Apple asks for a JWT to be
     * refreshed at most once an hour, so a sender reuses one rather than signing per message.
     */
    readonly authorization?: string | undefined;
}

export interface PushSendResult {
    readonly status: number;
    /** 404/410: the subscription is gone for good (RFC 8030 §7.3) and should be forgotten. */
    readonly gone: boolean;
    readonly ok: boolean;
    /** 429/503: how long the push service asked to be left alone (`Retry-After`), when it said. */
    readonly retryAfterMs?: number | undefined;
}

/** `Retry-After` as delay-seconds or an HTTP date (RFC 9110 §10.2.3), in ms from `nowMs`. */
function retryAfter(value: string | null, nowMs: number): number | undefined {
    if (value === null) return undefined;
    if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
    const at = Date.parse(value);
    return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

/** One message to one subscription. Network failures reject; HTTP refusals resolve with their status. */
export async function sendPush(target: PushTarget, keys: VapidKeys, payload: Buffer, options: PushSendOptions): Promise<PushSendResult> {
    const body = encryptPayload(payload, target);
    const response = await (options.fetch ?? fetch)(target.endpoint, {
        method: 'POST',
        headers: {
            Authorization: options.authorization ?? vapidAuthorization(target.endpoint, keys, options.nowMs, options.signingKey),
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            TTL: String(Math.max(0, Math.floor(options.ttlSeconds))),
            // An agent waiting on the person is worth waking a sleeping phone for.
            Urgency: 'high',
            ...(options.topic !== undefined ? { Topic: options.topic } : {})
        },
        body: new Uint8Array(body),
        // A push service answers, it does not redirect: following one would carry the message to
        // wherever the endpoint points, past the https check the endpoint passed (plain http on
        // this machine included). A 3xx is a refusal.
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000)
    });
    // Nothing in the body is needed, and reading it would buffer whatever the endpoint sends.
    await response.body?.cancel().catch(() => undefined);
    const { status } = response;
    return {
        status,
        gone: status === 404 || status === 410,
        ok: status >= 200 && status < 300,
        ...(status === 429 || status === 503 ? { retryAfterMs: retryAfter(response.headers.get('retry-after'), options.nowMs) } : {})
    };
}
