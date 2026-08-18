/**
 * Where the daemon's database lives.
 *
 * Spec: docs/current/persistence.md §1 (the Mac app's `~/Library/Application Support/Nex/nex.db`,
 * directory created on startup) and Port notes ("a headless daemon should choose an XDG-style
 * path … on first run MIGRATE by copying the legacy macOS path's file if present").
 *
 *   NEXD_DB_PATH set → that file, verbatim (`~` expanded; `:memory:` honoured)
 *   darwin          → ~/Library/Application Support/nexd/nex.db
 *   otherwise       → $XDG_DATA_HOME/nexd/nex.db, else ~/.local/share/nexd/nex.db
 *
 * `nexd`, not `Nex`: the daemon owns its own file so it can run beside the Swift app during the
 * port without either corrupting the other's state. Importing the legacy DB is a later utility
 * (PLAN.md M8) — `legacyMacAppDatabasePath()` is exported for it, and nothing here reads it.
 *
 * The directory is created 0700: the DB holds working directories, labels and agent session ids.
 */

import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const DB_PATH_ENV = 'NEXD_DB_PATH';
export const DB_DIR_MODE = 0o700;
export const DATABASE_FILENAME = 'nex.db';
/** In-memory databases (tests) skip directory creation entirely. */
export const MEMORY_DATABASE_PATH = ':memory:';

export interface DatabaseLocationLookup {
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly platform?: NodeJS.Platform | undefined;
    readonly home?: string | undefined;
}

/** Expand a leading `~` (alone or as `~/…`) against `home`. */
export function expandTilde(value: string, home: string): string {
    if (value === '~') return home;
    if (value.startsWith('~/')) return path.join(home, value.slice(2));
    return value;
}

/** The per-user data directory holding the database. Does not create it. */
export function resolveDataDir(lookup: DatabaseLocationLookup = {}): string {
    const env = lookup.env ?? process.env;
    const platform = lookup.platform ?? process.platform;
    const home = lookup.home ?? homedir();

    if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'nexd');

    const xdg = env['XDG_DATA_HOME']?.trim();
    if (xdg !== undefined && xdg.length > 0) return path.join(path.resolve(expandTilde(xdg, home)), 'nexd');

    return path.join(home, '.local', 'share', 'nexd');
}

/** Absolute path of the database file. Does not create anything. */
export function resolveDatabasePath(lookup: DatabaseLocationLookup = {}): string {
    const env = lookup.env ?? process.env;
    const home = lookup.home ?? homedir();

    const override = env[DB_PATH_ENV]?.trim();
    if (override !== undefined && override.length > 0) {
        if (override === MEMORY_DATABASE_PATH) return override;
        return path.resolve(expandTilde(override, home));
    }

    return path.join(resolveDataDir(lookup), DATABASE_FILENAME);
}

/** Create the database's parent directory (0700) if missing. Returns the directory. */
export function ensureDatabaseDir(databasePath: string): string {
    const dir = path.dirname(path.resolve(databasePath));
    fs.mkdirSync(dir, { recursive: true, mode: DB_DIR_MODE });
    // mkdir's mode is umask-masked; be explicit (matches lifecycle/rundir.ts).
    fs.chmodSync(dir, DB_DIR_MODE);
    return dir;
}

/** The Swift app's database — the source for the M8 legacy import. Never opened by the daemon. */
export function legacyMacAppDatabasePath(home: string = homedir()): string {
    return path.join(home, 'Library', 'Application Support', 'Nex', DATABASE_FILENAME);
}
