/**
 * Where the daemon's database lives.
 *
 * Spec: docs/current/persistence.md §1 (the Mac app's `~/Library/Application Support/Nex/nex.db`,
 * directory created on startup) and Port notes ("a headless daemon should choose an XDG-style
 * path … on first run MIGRATE by copying the legacy macOS path's file if present").
 *
 *   KELPID_DB_PATH set → that file, verbatim (`~` expanded; `:memory:` honoured)
 *   darwin          → ~/Library/Application Support/kelpid/kelpi.db
 *   otherwise       → $XDG_DATA_HOME/kelpid/kelpi.db, else ~/.local/share/kelpid/kelpi.db
 *
 * `kelpid`, not `Kelpi`: the daemon owns its own directory, distinct from any app-named one,
 * so implementations can run side by side without corrupting each other's state. The pre-rename
 * `nexd/nex.db` is migrated (copied) on boot by `boot/legacy-migration.ts`; the Swift app's own
 * database is a different thing again — `legacyMacAppDatabasePath()` points at it for
 * `kelpid import`, and nothing here reads it.
 *
 * Directories the daemon CREATES are made 0700 (the DB holds working directories, labels and
 * agent session ids). Directories that already exist are used exactly as they are — see
 * `ensureDatabaseDir`, and the P0 that motivated it.
 */

import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const DB_PATH_ENV = 'KELPID_DB_PATH';
export const DB_DIR_MODE = 0o700;
export const DATABASE_FILENAME = 'kelpi.db';
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

    if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'kelpid');

    const xdg = env['XDG_DATA_HOME']?.trim();
    if (xdg !== undefined && xdg.length > 0) return path.join(path.resolve(expandTilde(xdg, home)), 'kelpid');

    return path.join(home, '.local', 'share', 'kelpid');
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

/** Every directory in `first…leaf`, leaf-first. `first` is assumed to be a prefix of `leaf`. */
function createdChain(first: string, leaf: string): string[] {
    const chain: string[] = [];
    let current = leaf;
    for (;;) {
        chain.push(current);
        if (current === first) break;
        const parent = path.dirname(current);
        // Defensive: `first` should always be a prefix of `leaf`, but a symlinked or
        // rewritten path must not spin forever, and must never walk up past the root.
        if (parent === current) break;
        current = parent;
    }
    return chain;
}

/**
 * Create the database's parent directory if it is missing. Returns the directory.
 *
 * **Only directories this call creates are chmod'ed to 0700.** A parent that already exists
 * belongs to whoever made it — `/tmp` (root-owned, mode 1777), a home directory, a mount point,
 * a dir the user made for several tools to share — and chmod'ing it is either impossible or
 * rude. Doing it unconditionally is what silently disabled persistence for a whole day:
 * `KELPID_DB_PATH=/tmp/kelpid-dev.db` → `chmod('/tmp', 0700)` → EPERM → thrown out of
 * `createPersistence`'s open path → the daemon ran memory-only while reporting itself healthy.
 */
export function ensureDatabaseDir(databasePath: string): string {
    const dir = path.dirname(path.resolve(databasePath));
    // `recursive` returns the FIRST directory this call created, or undefined when the whole
    // chain was already there — the only reliable "did I make this?" signal fs gives us.
    const firstCreated = fs.mkdirSync(dir, { recursive: true, mode: DB_DIR_MODE });
    if (firstCreated === undefined) return dir;
    // mkdir's mode is umask-masked; be explicit for every level we just made (matches
    // lifecycle/rundir.ts). Nothing else on the machine can have opened these yet.
    for (const created of createdChain(path.resolve(firstCreated), dir)) {
        fs.chmodSync(created, DB_DIR_MODE);
    }
    return dir;
}

/**
 * Ensure the parent directory and prove the file is actually usable. Returns the resolved path.
 *
 * The preflight exists because `node:sqlite` reports every open failure as a bare
 * `unable to open database file` with no errno and no path — unactionable in a log. Asking the
 * filesystem first turns that into `EACCES: permission denied, access '<dir>'`, which names both
 * the reason and the place. Errors propagate: a database the daemon cannot write is fatal
 * (see `assertPersistenceUsable`), never a silent downgrade to memory-only.
 */
export function prepareDatabaseFile(databasePath: string): string {
    const resolved = path.resolve(databasePath);
    const dir = ensureDatabaseDir(resolved);
    // Writing needs both: X_OK to traverse into the directory, W_OK to create the `-wal` /
    // `-shm` siblings SQLite makes beside the file.
    fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
    if (fs.existsSync(resolved)) fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK);
    return resolved;
}

/** The Swift app's database — the source for `kelpid import`. Never opened by the daemon. */
export function legacyMacAppDatabasePath(home: string = homedir()): string {
    return path.join(home, 'Library', 'Application Support', 'Nex', 'nex.db');
}

/** The pre-rename daemon data directory (`nexd/nex.db`) — the boot migration's source. */
export const LEGACY_DATABASE_FILENAME = 'nex.db';
export function legacyDataDir(lookup: DatabaseLocationLookup = {}): string {
    const env = lookup.env ?? process.env;
    const platform = lookup.platform ?? process.platform;
    const home = lookup.home ?? homedir();
    if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'nexd');
    const xdg = env['XDG_DATA_HOME']?.trim();
    if (xdg !== undefined && xdg.length > 0) return path.join(path.resolve(expandTilde(xdg, home)), 'nexd');
    return path.join(home, '.local', 'share', 'nexd');
}
