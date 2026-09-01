/**
 * Paired remote devices — per-device tokens for the WS surface (multi-user remote sessions).
 *
 * The run dir's `.token` stays what it always was: the OWNER credential, held by the local
 * shell and anything else with same-UID access to the run dir. This module adds the second
 * tier: a device gets its own token via `kelpid pair`, presents it in the WS `hello` exactly
 * like the owner token, and can be revoked (`kelpid devices revoke`) without rotating what
 * the owner and every other device holds.
 *
 * The registry is a 0600 JSON file in the daemon's DATA dir (`devices.json`, beside the
 * database — durable, unlike a Linux XDG_RUNTIME run dir). The trust model is unchanged from
 * the run dir's: same UID on the same box. The `kelpid` CLI writes the file directly, and
 * the daemon only ever READS it — through `createDeviceValidator`, which re-reads on
 * mtime/size/inode change, so a pair or a revoke takes effect on the next hello with no control
 * command, no daemon restart, and no change to the Swift-parity wire protocol.
 *
 * Tokens are stored HASHED (sha256). The plaintext exists exactly once, in `mintDevice`'s
 * return value, on its way into a pairing URL. A leaked registry file therefore revokes
 * nothing the WS gate would accept (the pane-assets gate accepts stored hashes by design —
 * see `createAssetCredentialValidator`). Revocation covers every surface: pane-asset fetches
 * are cut on the next REQUEST, the WS at the next hello, and sessions already OPEN are cut
 * within a debounce of the registry change — `boot/compose.ts` watches this file and has the
 * sync hub re-check each session's credential (`revalidateSessions`), which closes revoked
 * ones with a `rejected` frame (`reason: 'revoked'`) so the client stops retrying.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { expandTilde, resolveDataDir } from '../db/index.js';

export const DEVICES_PATH_ENV = 'KELPID_DEVICES_PATH';
export const DEVICES_FILENAME = 'devices.json';
/** Distinguishes a device token from the run dir's owner token at a glance (logs, URLs). */
export const DEVICE_TOKEN_PREFIX = 'kd_';

export interface PairedDevice {
    /** Short stable id (hex, 8 chars) — the `revoke` handle. */
    readonly id: string;
    readonly name: string;
    /** sha256 of the full token string, base64url. The plaintext is never stored. */
    readonly tokenHash: string;
    /** ISO-8601. */
    readonly createdAt: string;
    /** ISO-8601 when revoked; absent while the device may connect. */
    readonly revokedAt?: string | undefined;
}

export interface MintedDevice {
    readonly device: PairedDevice;
    /** The plaintext token — shown once, then only its hash survives. */
    readonly token: string;
}

/** Where the registry lives: `KELPID_DEVICES_PATH`, else `<data dir>/devices.json`. */
export function resolveDevicesPath(env: NodeJS.ProcessEnv = process.env): string {
    const override = env[DEVICES_PATH_ENV]?.trim();
    // `expandTilde` like every sibling resolver: a literal `~/…` from a launchd/systemd unit
    // would otherwise resolve against TWO different cwds (the CLI's and the detached
    // daemon's), splitting the registry into a file the CLI writes and one the daemon reads.
    if (override !== undefined && override.length > 0) return path.resolve(expandTilde(override, homedir()));
    return path.join(resolveDataDir({ env }), DEVICES_FILENAME);
}

export function hashDeviceToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('base64url');
}

function parseDevice(value: unknown): PairedDevice | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const { id, name, tokenHash, createdAt, revokedAt } = record;
    if (typeof id !== 'string' || id.length === 0) return null;
    if (typeof name !== 'string' || name.length === 0) return null;
    if (typeof tokenHash !== 'string' || tokenHash.length === 0) return null;
    if (typeof createdAt !== 'string') return null;
    if (revokedAt !== undefined && typeof revokedAt !== 'string') return null;
    return { id, name, tokenHash, createdAt, ...(revokedAt !== undefined ? { revokedAt } : {}) };
}

/**
 * Read the registry. A missing file is an empty registry; an unreadable or malformed one
 * throws — the CLI turns that into words, and the validator FAILS CLOSED around it (a
 * corrupt registry must never admit anyone, and must never take the daemon down either).
 */
export function loadDevices(file: string): PairedDevice[] {
    let raw: string;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${file} is not a devices registry (expected an object)`);
    }
    const list = (parsed as Record<string, unknown>)['devices'];
    if (!Array.isArray(list)) throw new Error(`${file} is not a devices registry (no devices array)`);
    const devices: PairedDevice[] = [];
    for (const entry of list) {
        const device = parseDevice(entry);
        if (device === null) throw new Error(`${file} carries a malformed device entry`);
        devices.push(device);
    }
    return devices;
}

/** 0700 dir, 0600 file, write-then-rename so the daemon's reader never sees a half write. */
function saveDevices(file: string, devices: readonly PairedDevice[]): void {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${String(process.pid)}`;
    fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, devices }, null, 2)}\n`, { mode: 0o600 });
    // The mode above is umask-masked; be explicit (same note as `rundir.ts`'s writeRunFile).
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
}

/**
 * Mint a device: 32 random bytes of token, hash stored, plaintext returned once.
 *
 * The name must not collide with a live (unrevoked) device — `revoke <name>` has to mean
 * one thing. Re-pairing a machine is: revoke the old entry, mint a new one.
 */
export function mintDevice(file: string, name: string, now: () => Date = () => new Date()): MintedDevice {
    const trimmed = name.trim();
    if (trimmed.length === 0) throw new Error('a device needs a name (who is this for?)');
    if (trimmed.length > 120) throw new Error('device names are capped at 120 characters');
    const devices = loadDevices(file);
    if (devices.some((device) => device.revokedAt === undefined && device.name === trimmed)) {
        throw new Error(`a live device is already named "${trimmed}" - revoke it first, or pick another name`);
    }
    const token = `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const device: PairedDevice = {
        // Hex, not base64url: an id starting with `--` would be unrevokable through the CLI's
        // own parser (and hex is the house style for generated identifiers).
        id: randomBytes(4).toString('hex'),
        name: trimmed,
        tokenHash: hashDeviceToken(token),
        createdAt: now().toISOString()
    };
    saveDevices(file, [...devices, device]);
    return { device, token };
}

/**
 * Revoke by id, or by the name of a live device. Returns the revoked entry, or null when
 * nothing matched. An already-revoked match is returned unchanged (revoking twice is not an
 * error, it is a no-op that says so).
 */
export function revokeDevice(
    file: string,
    idOrName: string,
    now: () => Date = () => new Date()
): PairedDevice | null {
    const target = idOrName.trim();
    const devices = loadDevices(file);
    let match = devices.find((device) => device.id === target);
    if (match === undefined) {
        const named = devices.filter((device) => device.revokedAt === undefined && device.name === target);
        if (named.length > 1) {
            throw new Error(`"${target}" names ${String(named.length)} live devices - revoke by id instead`);
        }
        match = named[0];
    }
    if (match === undefined) return null;
    if (match.revokedAt !== undefined) return match;
    const revoked: PairedDevice = { ...match, revokedAt: now().toISOString() };
    saveDevices(
        file,
        devices.map((device) => (device.id === revoked.id ? revoked : device))
    );
    return revoked;
}

/**
 * Delete a device outright. ONLY for undoing a mint whose token never left the minting
 * process (`kelpid pair`'s rollback when the tailnet half fails) — a device that may have
 * connected is REVOKED instead, so the registry keeps its record.
 */
export function removeDevice(file: string, id: string): void {
    const devices = loadDevices(file);
    const remaining = devices.filter((device) => device.id !== id);
    if (remaining.length === devices.length) return;
    saveDevices(file, remaining);
}

/**
 * The shared mtime-cached read both validators sit on: the live devices' token hashes, as
 * raw bytes, re-read only when the file's identity (mtime/size/inode) changed. Every failure
 * — missing file, corrupt file, unreadable file — yields an empty list and no cache, so a
 * registry we cannot read admits nobody and the next call retries.
 */
function createLiveHashReader(file: string): () => readonly Buffer[] {
    let cachedKey = '';
    let cachedHashes: Buffer[] = [];

    return (): readonly Buffer[] => {
        let key = 'absent';
        try {
            const stat = fs.statSync(file);
            key = `${String(stat.mtimeMs)}:${String(stat.size)}:${String(stat.ino)}`;
        } catch {
            // Missing file: an empty registry, and nothing to cache.
        }
        if (key !== cachedKey) {
            try {
                cachedHashes = loadDevices(file)
                    .filter((device) => device.revokedAt === undefined)
                    .map((device) => Buffer.from(device.tokenHash, 'base64url'));
                cachedKey = key;
            } catch {
                cachedHashes = [];
                cachedKey = '';
            }
        }
        return cachedHashes;
    };
}

function matchesAnyHash(hashes: readonly Buffer[], candidate: Buffer): boolean {
    let matched = false;
    for (const hash of hashes) {
        if (hash.length === candidate.length && timingSafeEqual(hash, candidate)) matched = true;
    }
    return matched;
}

/**
 * The daemon's hello-time check: does this token belong to a live paired device?
 *
 * `kelpid pair` and `kelpid devices revoke` take effect on the next hello without any
 * daemon-side coordination (see `createLiveHashReader`).
 */
export function createDeviceValidator(file: string): (token: string) => boolean {
    const read = createLiveHashReader(file);
    return (token: string): boolean => {
        if (!token.startsWith(DEVICE_TOKEN_PREFIX)) return false;
        return matchesAnyHash(read(), Buffer.from(hashDeviceToken(token), 'base64url'));
    };
}

/**
 * The pane-assets check: is this credential the sha256 (base64url) of a live device token?
 *
 * The asset credential IS the stored hash — a client derives it from its own token
 * (`client/src/content/asset-credential.ts`) so the raw token never enters the sandboxed
 * preview document, and revoking the device kills its asset access on the next request. The
 * deliberate cost: a leaked registry file now grants ASSET reads (never the WS surface,
 * whose gate hashes the presented token before comparing).
 */
export function createAssetCredentialValidator(file: string): (credential: string) => boolean {
    const read = createLiveHashReader(file);
    return (credential: string): boolean => {
        if (credential.length === 0) return false;
        return matchesAnyHash(read(), Buffer.from(credential, 'base64url'));
    };
}

/**
 * The full pane-assets gate: the owner's derived credential, or any live device's.
 * (`boot/compose.ts` hands this to `createPaneAssetsRoute` whenever an owner token exists.)
 */
export function createAssetCredentialGate(file: string, ownerToken: string): (credential: string) => boolean {
    const devices = createAssetCredentialValidator(file);
    const owner = Buffer.from(hashDeviceToken(ownerToken), 'base64url');
    return (credential: string): boolean => {
        if (credential.length === 0) return false;
        const candidate = Buffer.from(credential, 'base64url');
        if (candidate.length === owner.length && timingSafeEqual(candidate, owner)) return true;
        return devices(credential);
    };
}
