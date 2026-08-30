/**
 * The pane-assets credential — how a sandboxed preview proves who is fetching.
 *
 * Content previews render in an `allow-scripts`-only `srcdoc` iframe (`./ContentFrame.tsx`):
 * an OPAQUE origin, so its `<img>` fetches carry no cookies and can set no headers. The only
 * channel left is the URL itself, and `<base href>` propagates exactly one thing to relative
 * URLs — path segments. So the client rewrites the daemon-sent `/pane-assets/<paneID>/` base
 * into `/pane-assets/c/<credential>/<paneID>/`, and the daemon's route gates on the
 * credential (`daemon/src/ws/http.ts`).
 *
 * The credential is sha256(token), base64url — deliberately NOT the token: whatever runs
 * inside the preview document (a rendered markdown file is not trusted input) can read its
 * own base URL, and it must learn at most an assets-scoped credential, never the WS token.
 * For a paired device this equals the registry's stored hash, which is what lets `kelpid
 * devices revoke` kill asset access on the very next request.
 *
 * sha256 is implemented here (FIPS 180-4, verified against its test vectors) rather than via
 * `crypto.subtle` because subtle is undefined outside secure contexts, and a plain
 * `http://<tailnet-ip>` session — degraded, but supported — still needs its images.
 */

const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function rotr(value: number, bits: number): number {
    return (value >>> bits) | (value << (32 - bits));
}

/** FIPS 180-4 sha256 over raw bytes. Synchronous on purpose (see the module note). */
export function sha256(input: Uint8Array): Uint8Array {
    const bitLength = input.length * 8;
    const padded = new Uint8Array((((input.length + 8) >> 6) + 1) << 6);
    padded.set(input);
    padded[input.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
    view.setUint32(padded.length - 4, bitLength >>> 0);

    const h = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);
    const w = new Uint32Array(64);

    for (let offset = 0; offset < padded.length; offset += 64) {
        for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
        for (let i = 16; i < 64; i += 1) {
            const w15 = w[i - 15] as number;
            const w2 = w[i - 2] as number;
            const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
            const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
            w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, hh] = h as unknown as [number, number, number, number, number, number, number, number];
        for (let i = 0; i < 64; i += 1) {
            const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const temp1 = (hh + s1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
            const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (s0 + maj) >>> 0;
            hh = g;
            g = f;
            f = e;
            e = (d + temp1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) >>> 0;
        }
        h[0] = (h[0] as number) + a;
        h[1] = (h[1] as number) + b;
        h[2] = (h[2] as number) + c;
        h[3] = (h[3] as number) + d;
        h[4] = (h[4] as number) + e;
        h[5] = (h[5] as number) + f;
        h[6] = (h[6] as number) + g;
        h[7] = (h[7] as number) + hh;
    }

    const digest = new Uint8Array(32);
    const out = new DataView(digest.buffer);
    for (let i = 0; i < 8; i += 1) out.setUint32(i * 4, (h[i] as number) >>> 0);
    return digest;
}

function base64url(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** sha256(token) base64url — must agree byte-for-byte with the daemon's `hashDeviceToken`. */
export function assetCredentialFor(token: string): string {
    return base64url(sha256(new TextEncoder().encode(token)));
}

let credential: string | undefined;

/** Called once at bootstrap (`main.tsx`) with the resolved daemon token, if any. */
export function setAssetCredentialToken(token: string | undefined): void {
    credential = token === undefined || token.length === 0 ? undefined : assetCredentialFor(token);
}

const PANE_ASSETS_PREFIX = '/pane-assets/';

/**
 * `/pane-assets/<paneID>/` → `/pane-assets/c/<credential>/<paneID>/`.
 *
 * Passed through unchanged when there is no token (a dev daemon serves the legacy form) or
 * when the base is not the shape the daemon documents — never invent a path.
 */
export function credentialedAssetBase(base: string | null): string | null {
    if (base === null || credential === undefined || !base.startsWith(PANE_ASSETS_PREFIX)) return base;
    return `${PANE_ASSETS_PREFIX}c/${credential}/${base.slice(PANE_ASSETS_PREFIX.length)}`;
}
