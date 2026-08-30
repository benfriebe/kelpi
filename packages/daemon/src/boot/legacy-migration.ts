/**
 * The one-shot cutover from the pre-rename (`nex`) state locations to the Kelpi ones.
 *
 * Two moves, both COPY-only — the originals stay behind as a fallback snapshot, and a machine
 * that never ran the pre-rename daemon is untouched:
 *
 *   ~/Library/Application Support/nexd/nex.db  (+ -wal/-shm, pane-geometry.json)
 *     → ~/Library/Application Support/kelpid/kelpi.db (+ siblings)
 *   ~/.config/nex/config
 *     → ~/.config/kelpi/config
 *
 * Both migrations are skipped whenever the corresponding env override is set: an override
 * means a sandbox (smokes, dev-instance, tests), and a sandbox must never read the real
 * machine's legacy state. Each is also skipped once the target exists — the migration runs
 * exactly once, and a later boot never clobbers state the daemon has since written.
 *
 * Beside the data there is the wire: the daemon binds `/tmp/kelpi.sock`, and
 * `maintainLegacyCompatSocket` keeps a SYMLINK at the pre-rename `/tmp/nex.sock` pointing to
 * it, so every pre-rename client — installed hooks, the shipped Swift `nex` — still connects.
 * A live foreign socket at the legacy path (the Swift app running) is left alone; only a
 * missing entry, a stale dead socket, or a symlink of ours is (re)written.
 */

import fs from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';

import { DB_PATH_ENV, LEGACY_DATABASE_FILENAME, ensureDatabaseDir, legacyDataDir, resolveDatabasePath } from '../db/location.js';
import { CONFIG_PATH_ENV, resolveConfigPath } from './config.js';

export interface LegacyMigrationLookup {
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly platform?: NodeJS.Platform | undefined;
    readonly home?: string | undefined;
    readonly log?: ((line: string) => void) | undefined;
}

/** Extra files copied beside the database when present. */
const DATA_SIBLINGS = ['pane-geometry.json'];

function copyIfPresent(source: string, target: string, log: (line: string) => void): boolean {
    if (!fs.existsSync(source)) return false;
    fs.copyFileSync(source, target);
    log(`legacy-migrate: copied ${source} -> ${target}`);
    return true;
}

/**
 * Copy the pre-rename daemon state into the Kelpi locations. Returns the copied file count.
 * Safe to call on every boot: it is a no-op unless a target is missing and a source exists.
 */
export function migrateLegacyState(lookup: LegacyMigrationLookup = {}): number {
    const env = lookup.env ?? process.env;
    const home = lookup.home ?? homedir();
    const platform = lookup.platform ?? process.platform;
    const log = lookup.log ?? (() => undefined);
    let copied = 0;

    // ── database + siblings ─────────────────────────────────────────────────
    const dbOverride = env[DB_PATH_ENV]?.trim();
    if (dbOverride === undefined || dbOverride.length === 0) {
        const target = resolveDatabasePath({ env, platform, home });
        const legacyDir = legacyDataDir({ env, platform, home });
        const source = path.join(legacyDir, LEGACY_DATABASE_FILENAME);
        if (!fs.existsSync(target) && fs.existsSync(source)) {
            ensureDatabaseDir(target);
            if (copyIfPresent(source, target, log)) copied += 1;
            for (const suffix of ['-wal', '-shm']) {
                if (copyIfPresent(`${source}${suffix}`, `${target}${suffix}`, log)) copied += 1;
            }
            for (const sibling of DATA_SIBLINGS) {
                if (copyIfPresent(path.join(legacyDir, sibling), path.join(path.dirname(target), sibling), log)) {
                    copied += 1;
                }
            }
        }
    }

    // ── config file ─────────────────────────────────────────────────────────
    const configOverride = env[CONFIG_PATH_ENV]?.trim();
    if (configOverride === undefined || configOverride.length === 0) {
        const target = resolveConfigPath({ env, home });
        const source = path.join(home, '.config', 'nex', 'config');
        if (!fs.existsSync(target) && fs.existsSync(source)) {
            fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
            if (copyIfPresent(source, target, log)) copied += 1;
        }
    }

    return copied;
}

/** True when something ACCEPTS on the socket within `timeoutMs` — a live owner. */
function socketAlive(socketPath: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect(socketPath);
        const done = (alive: boolean): void => {
            socket.destroy();
            resolve(alive);
        };
        socket.setTimeout(timeoutMs, () => {
            done(false);
        });
        socket.once('connect', () => {
            done(true);
        });
        socket.once('error', () => {
            done(false);
        });
    });
}

export interface LegacyCompatSocketOptions {
    /** The socket this daemon actually bound (the symlink's target). */
    readonly boundPath: string;
    /** The pre-rename path to maintain the symlink at. */
    readonly legacyPath: string;
    readonly log?: ((line: string) => void) | undefined;
    readonly probeTimeoutMs?: number | undefined;
}

/**
 * Keep `legacyPath` resolving to `boundPath`. Never touches a live foreign socket; replaces
 * a dead one or a stale symlink; creates the link when the path is free. Best-effort — a
 * failure is logged and the daemon carries on (the legacy path is a convenience, not a
 * dependency).
 */
export async function maintainLegacyCompatSocket(options: LegacyCompatSocketOptions): Promise<void> {
    const log = options.log ?? (() => undefined);
    const { boundPath, legacyPath } = options;
    if (boundPath === legacyPath) return;
    try {
        let entry: fs.Stats | undefined;
        try {
            entry = fs.lstatSync(legacyPath);
        } catch {
            entry = undefined; // free: create below
        }
        if (entry !== undefined) {
            if (entry.isSymbolicLink()) {
                if (fs.readlinkSync(legacyPath) === boundPath) return; // already ours
                fs.unlinkSync(legacyPath); // a stale symlink (old bound path); rewrite
            } else if (entry.isSocket()) {
                if (await socketAlive(legacyPath, options.probeTimeoutMs ?? 1000)) {
                    log(`legacy-socket: ${legacyPath} has a live owner — left alone`);
                    return;
                }
                fs.unlinkSync(legacyPath); // dead socket from a pre-cutover daemon
            } else {
                log(`legacy-socket: ${legacyPath} is not a socket or symlink — left alone`);
                return;
            }
        }
        fs.symlinkSync(boundPath, legacyPath);
        log(`legacy-socket: ${legacyPath} -> ${boundPath}`);
    } catch (error) {
        log(`legacy-socket: could not maintain ${legacyPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
}
