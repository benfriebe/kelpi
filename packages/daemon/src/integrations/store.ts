/**
 * The credential store: `integrations.json`, the one place a linked account's token is written
 * down (docs/integrations.md §9.1, persistence.md §7.4).
 *
 * Modelled on the paired-device registry (`lifecycle/devices.ts`) with the differences a secret
 * that must be USED (not just compared) forces:
 *
 *   - the daemon is the only writer, and every write is synchronous, so writes are serialised by
 *     construction (no CLI writes this file);
 *   - the directory is created 0700, the file 0600, and a write goes temp file (opened `wx` at
 *     0600, fchmod'd past the umask) → fsync → rename → directory fsync, so a crash leaves the
 *     old file or the new one, never half of either, and never a moment at a wider mode;
 *   - a file that cannot be read or parsed, or one a newer daemon wrote (`v` above 1), FAILS
 *     CLOSED: every provider reports `problem: 'unreadable'` and nothing is sent anywhere. The
 *     file is left untouched until the next link (or unlink), which moves it aside as
 *     `integrations.json.unreadable-<epoch ms>` (still 0600, so whatever was in it stays as
 *     private as it was) and writes a fresh one;
 *   - a `:memory:` daemon (no path) keeps the account in memory only.
 *
 * Shape (`v: 1`):
 *
 *   { "v": 1, "accounts": [ { "provider": "github", "host": "github.com", "login": "octocat",
 *       "how": "oauth" | "token", "scopes": ["repo"]?, "createdAt": "<ISO>", "problem": "revoked"?,
 *       "credential": { "accessToken": "…", "tokenType": "bearer", "expiresAt": null,
 *                       "refreshToken": null, "refreshTokenExpiresAt": null } } ] }
 *
 * `scopes` is absent for a fine-grained token (GitHub reports none). The three refresh fields are
 * RESERVED: GitHub OAuth App tokens do not expire, so phase 2 registers no refresher and writes
 * them as null; a provider whose tokens expire (Linear) fills them later, and a file with them set
 * already reads back. An account of a provider this daemon does not know is kept verbatim on
 * every rewrite, so a later daemon's Linear link survives a downgrade-and-relink of GitHub.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { INTEGRATION_AUTH_METHODS, isIntegrationProvider, type IntegrationAuthMethod, type IntegrationProvider } from '@kelpi/protocol';

export const INTEGRATIONS_FILE_VERSION = 1;

export interface StoredCredential {
    readonly accessToken: string;
    readonly tokenType: string;
    /** Reserved (ISO 8601 or null): when `accessToken` expires. */
    readonly expiresAt: string | null;
    /** Reserved. */
    readonly refreshToken: string | null;
    /** Reserved (ISO 8601 or null). */
    readonly refreshTokenExpiresAt: string | null;
}

export interface StoredAccount {
    readonly provider: IntegrationProvider;
    readonly host: 'github.com';
    readonly login: string;
    readonly how: IntegrationAuthMethod;
    /** Null for a fine-grained token, which reports no scopes. */
    readonly scopes: readonly string[] | null;
    /** ISO 8601. */
    readonly createdAt: string;
    /** Set when GitHub answered 401 for this credential; kept across restarts. */
    readonly revoked: boolean;
    readonly credential: StoredCredential;
}

export interface CredentialStore {
    /** The file, or null for a memory-only store. */
    readonly path: string | null;
    /** True while the file could not be read: every provider is then `problem: 'unreadable'`. */
    readonly unreadable: boolean;
    /** Why it could not be read (for the log; never any of the file's content). */
    readonly unreadableReason: string | null;
    /** The provider's account, or null (always null while `unreadable`). */
    account(provider: IntegrationProvider): StoredAccount | null;
    /** Replace the provider's account and write the file. Throws (with an fs message) when the write fails. */
    save(account: StoredAccount): void;
    /** Mark the provider's credential revoked (a 401), in memory and, best effort, on disk. */
    markRevoked(provider: IntegrationProvider): void;
    /** Forget the provider's account. Throws when the write fails. */
    remove(provider: IntegrationProvider): void;
}

export interface CreateCredentialStoreOptions {
    readonly path: string | null;
    readonly now?: (() => number) | undefined;
    /** Best-effort failures (a revoked mark that could not be written). */
    readonly onError?: ((error: Error, context: string) => void) | undefined;
}

class UnreadableFileError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown, field: string): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw new UnreadableFileError(`${field} is not a string`);
    return value;
}

function parseAccount(raw: Record<string, unknown>): StoredAccount {
    const { provider, host, login, how, scopes, createdAt, problem, credential } = raw;
    if (!isIntegrationProvider(provider)) throw new UnreadableFileError('an account has an unknown provider');
    if (host !== 'github.com') throw new UnreadableFileError('an account has an unknown host');
    if (typeof login !== 'string' || login === '') throw new UnreadableFileError('an account has no login');
    if (typeof how !== 'string' || !(INTEGRATION_AUTH_METHODS as readonly string[]).includes(how)) {
        throw new UnreadableFileError('an account has an unknown link method');
    }
    if (scopes !== undefined && (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === 'string'))) {
        throw new UnreadableFileError('an account has malformed scopes');
    }
    if (typeof createdAt !== 'string') throw new UnreadableFileError('an account has no createdAt');
    if (problem !== undefined && problem !== 'revoked') throw new UnreadableFileError('an account has an unknown problem');
    if (!isRecord(credential)) throw new UnreadableFileError('an account has no credential');
    const accessToken = credential['accessToken'];
    if (typeof accessToken !== 'string' || accessToken === '') throw new UnreadableFileError('an account has no access token');
    const tokenType = credential['tokenType'];
    return {
        provider,
        host,
        login,
        how: how as IntegrationAuthMethod,
        scopes: scopes === undefined ? null : (scopes as string[]),
        createdAt,
        revoked: problem === 'revoked',
        credential: {
            accessToken,
            tokenType: typeof tokenType === 'string' && tokenType !== '' ? tokenType : 'bearer',
            expiresAt: nullableString(credential['expiresAt'], 'expiresAt'),
            refreshToken: nullableString(credential['refreshToken'], 'refreshToken'),
            refreshTokenExpiresAt: nullableString(credential['refreshTokenExpiresAt'], 'refreshTokenExpiresAt')
        }
    };
}

interface LoadedFile {
    readonly accounts: Map<IntegrationProvider, StoredAccount>;
    /** Accounts of providers this daemon does not know, kept verbatim. */
    readonly foreign: readonly Record<string, unknown>[];
}

function loadFile(file: string): LoadedFile {
    let text: string;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { accounts: new Map(), foreign: [] };
        throw new UnreadableFileError(`cannot read it (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new UnreadableFileError('it is not JSON');
    }
    if (!isRecord(parsed)) throw new UnreadableFileError('it is not an object');
    if (parsed['v'] !== INTEGRATIONS_FILE_VERSION) {
        throw new UnreadableFileError(`it has version ${JSON.stringify(parsed['v'] ?? null)}, this daemon reads ${INTEGRATIONS_FILE_VERSION}`);
    }
    const list = parsed['accounts'];
    if (!Array.isArray(list)) throw new UnreadableFileError('it has no accounts list');
    const accounts = new Map<IntegrationProvider, StoredAccount>();
    const foreign: Record<string, unknown>[] = [];
    for (const entry of list as unknown[]) {
        if (!isRecord(entry)) throw new UnreadableFileError('an account is not an object');
        if (typeof entry['provider'] === 'string' && !isIntegrationProvider(entry['provider'])) {
            foreign.push(entry);
            continue;
        }
        const account = parseAccount(entry);
        if (accounts.has(account.provider)) throw new UnreadableFileError(`it lists ${account.provider} twice`);
        accounts.set(account.provider, account);
    }
    // A file someone widened is narrowed back; the token in it is ours to keep private.
    try {
        if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
    } catch {
        // Best effort: the read above already succeeded.
    }
    return { accounts, foreign };
}

function serializeAccount(account: StoredAccount): Record<string, unknown> {
    return {
        provider: account.provider,
        host: account.host,
        login: account.login,
        how: account.how,
        ...(account.scopes === null ? {} : { scopes: [...account.scopes] }),
        createdAt: account.createdAt,
        ...(account.revoked ? { problem: 'revoked' } : {}),
        credential: {
            accessToken: account.credential.accessToken,
            tokenType: account.credential.tokenType,
            expiresAt: account.credential.expiresAt,
            refreshToken: account.credential.refreshToken,
            refreshTokenExpiresAt: account.credential.refreshTokenExpiresAt
        }
    };
}

/** Temp (0600, `wx`) → fsync → rename → directory fsync. Throws with an fs message; the temp file never outlives a failure. */
export function writeFileAtomic0600(file: string, text: string): void {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${String(process.pid)}-${randomBytes(4).toString('hex')}`;
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
        try {
            // The open mode above is umask-masked; be explicit (the `rundir.ts` note).
            fs.fchmodSync(fd, 0o600);
            fs.writeFileSync(fd, text);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(tmp, file);
    } catch (error) {
        fs.rmSync(tmp, { force: true });
        throw error;
    }
    // The rename itself must reach the disk too. Best effort: not every platform lets a
    // directory be opened for fsync.
    try {
        const dirFD = fs.openSync(dir, 'r');
        try {
            fs.fsyncSync(dirFD);
        } finally {
            fs.closeSync(dirFD);
        }
    } catch {
        // Nothing more to do.
    }
}

export function createCredentialStore(options: CreateCredentialStoreOptions): CredentialStore {
    const file = options.path;
    const now = options.now ?? (() => Date.now());
    let accounts = new Map<IntegrationProvider, StoredAccount>();
    let foreign: readonly Record<string, unknown>[] = [];
    let unreadableReason: string | null = null;

    if (file !== null) {
        try {
            const loaded = loadFile(file);
            accounts = loaded.accounts;
            foreign = loaded.foreign;
        } catch (error) {
            unreadableReason = error instanceof UnreadableFileError ? error.message : 'it could not be parsed';
        }
    }

    /** Move an unreadable file out of the way, so the next write starts clean. */
    const moveAside = (): void => {
        if (file === null || unreadableReason === null) return;
        try {
            fs.renameSync(file, `${file}.unreadable-${String(now())}`);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        unreadableReason = null;
        accounts = new Map();
        foreign = [];
    };

    const write = (next: Map<IntegrationProvider, StoredAccount>): void => {
        if (file !== null) {
            const body = { v: INTEGRATIONS_FILE_VERSION, accounts: [...[...next.values()].map(serializeAccount), ...foreign] };
            writeFileAtomic0600(file, `${JSON.stringify(body, null, 2)}\n`);
        }
        accounts = next;
    };

    return {
        path: file,
        get unreadable() {
            return unreadableReason !== null;
        },
        get unreadableReason() {
            return unreadableReason;
        },
        account(provider) {
            if (unreadableReason !== null) return null;
            return accounts.get(provider) ?? null;
        },
        save(account) {
            moveAside();
            const next = new Map(accounts);
            next.set(account.provider, account);
            write(next);
        },
        markRevoked(provider) {
            if (unreadableReason !== null) return;
            const current = accounts.get(provider);
            if (current === undefined || current.revoked) return;
            const next = new Map(accounts);
            next.set(provider, { ...current, revoked: true });
            try {
                write(next);
            } catch (error) {
                // The mark still holds for this daemon's life; the next 401 tries the write again.
                accounts = next;
                options.onError?.(error instanceof Error ? error : new Error(String(error)), 'integrations: save the revoked mark');
            }
        },
        remove(provider) {
            moveAside();
            if (!accounts.has(provider)) return;
            const next = new Map(accounts);
            next.delete(provider);
            write(next);
        }
    };
}
