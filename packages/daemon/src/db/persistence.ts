/**
 * `Persistence<PersistedSnapshot>` over SQLite.
 *
 * Spec: docs/persistence.md §5 (debounced save, clear-and-reinsert in ONE transaction,
 * appState upsert), §6 (load + degradation), §9 (invariants); Port notes ("a daemon can and
 * should flush the pending debounced write on graceful shutdown").
 *
 * Shape of the contract (seams.ts):
 *   load()               → the snapshot, or null for "fresh install" (§6.2 Case A) — including
 *                          an unreadable DB, which is NEVER deleted
 *   scheduleSave(s)      → coalescing 500 ms debounce; the LAST snapshot wins, intermediates
 *                          are discarded wholesale
 *   flush()              → synchronous write of whatever is pending (the SIGTERM path; the Mac
 *                          app has no such flush and accepts a 500 ms loss window)
 *   close()              → flush, then close the handle
 *
 * The save is the Swift app's model verbatim: delete every row of the six tables this daemon
 * owns and re-insert the snapshot, all inside one transaction, so the file is always a
 * single-moment snapshot and a failed write leaves the previous contents intact. Tables the
 * daemon does not own (`scheduledTask`, `workspaceFolder`, anything a future version adds) are
 * never read, never written and never dropped, and every INSERT names its columns explicitly so
 * extra columns on adopted tables (e.g. the live `workspace.folderID`) keep their defaults.
 *
 * **Failures are observable.** §5.3's "keep the daemon alive on a broken DB" is about not
 * crashing mid-session; it is NOT a licence to pretend. Every failure lands in `health()`, and
 * boot turns an open failure into a refusal to start (`assertPersistenceUsable`) and a mid-run
 * save failure into a loud log + a client-visible event. A daemon that cannot save must never
 * look healthy — that is how a day of workspaces went to /dev/null.
 */

import type { PersistedSnapshot } from '../store/index.js';
import type { Persistence, PersistenceHealth } from '../seams.js';
import { openSqliteDatabase, type SqlDatabase } from './adapter.js';
import { snapshotFromRows, snapshotToRows, type LoadedRows } from './codec.js';
import { DB_PATH_ENV, prepareDatabaseFile, resolveDatabasePath } from './location.js';
import { initializeSchema } from './schema.js';

/** §5.2 — the Swift app's quiet period, kept so save churn matches. */
export const SAVE_DEBOUNCE_MS = 500;

export type PersistencePhase = 'open' | 'load' | 'save';

export interface PersistenceOptions {
    /** DB file path. Defaults to `resolveDatabasePath()`; `:memory:` is honoured for tests. */
    readonly path?: string | undefined;
    /** Pre-opened handle (tests, or a caller that owns the connection). Skips path resolution. */
    readonly db?: SqlDatabase | undefined;
    /** Run the migration ledger at construction. Default true. */
    readonly migrate?: boolean | undefined;
    readonly debounceMs?: number | undefined;
    /**
     * Every failure, as it happens, with the phase that produced it. Defaults to a no-op.
     * `onDegraded` is the louder companion: this one fires for anything at all.
     */
    readonly onError?: ((error: unknown, phase: PersistencePhase) => void) | undefined;
    /**
     * Fires whenever the persisted state stops matching memory: the DB could not be opened, or
     * a write failed. Boot uses it to log loudly and tell attached clients — a save that fails
     * in silence is indistinguishable from one that worked until the next restart.
     */
    readonly onDegraded?: ((health: PersistenceHealth) => void) | undefined;
    /**
     * Floor between repeat `onDegraded` calls for DROPPED saves (a database that never opened
     * drops one on every dispatch — hundreds per minute). Default 5 s: often enough that a
     * client attaching mid-session learns within a few keystrokes, rare enough to not be spam.
     */
    readonly degradedNotifyMs?: number | undefined;
    /** Injectable clock for `lastSaveAt` (deterministic in tests). */
    readonly now?: (() => number) | undefined;
    /** Injectable id source for pre-v13 `webURL` rows (deterministic in tests). */
    readonly newTabID?: (() => string) | undefined;
}

export type LoadStatus =
    /** A snapshot with at least one workspace. */
    | 'ok'
    /** Readable, but nothing to restore — first launch or a wiped DB (§6.2 Case A). */
    | 'empty'
    /** Hard read failure: boot as a fresh install, leave the file alone (§6.1). */
    | 'unreadable';

export interface LoadOutcome {
    readonly status: LoadStatus;
    /** Decoded content even when `status === 'empty'`; null when unreadable. */
    readonly snapshot: PersistedSnapshot | null;
    readonly error?: unknown;
}

export interface SqlitePersistence extends Persistence<PersistedSnapshot> {
    /** The database file (`:memory:` for tests), for diagnostics. */
    readonly path: string;
    /** False when the DB could not be opened/migrated: load() is null and saves are dropped. */
    readonly isAvailable: boolean;
    /** The richer form of `load()`; distinguishes "empty" from "unreadable". */
    loadOutcome(): LoadOutcome;
    /** Write immediately, bypassing the debounce. Returns false when the write failed. */
    saveNow(snapshot: PersistedSnapshot): boolean;
    hasPendingSave(): boolean;
    /**
     * Write whatever is pending. True when the state on disk now matches memory (including
     * "nothing was pending"), false when the write failed or there was no DB to write to —
     * which is what makes `kelpid stop` able to refuse to claim a clean shutdown.
     */
    flush(): boolean;
    /** One honest answer to "is my state safe?" — what `ping` / `kelpid status` report. */
    health(): PersistenceHealth;
    /** Last error handed to `onError`, for tests/diagnostics. */
    readonly lastError: unknown;
}

/**
 * Thrown by `assertPersistenceUsable` — a database the daemon cannot open is a refusal to
 * start, not a downgrade. Carries everything an operator needs on one screen: which file, which
 * phase, the real errno, and what to do about it.
 */
export class PersistenceUnavailableError extends Error {
    override readonly name = 'PersistenceUnavailableError';
    /** Stable code so callers can branch without string matching. */
    readonly code = 'ENEXDPERSIST';
    readonly databasePath: string;
    readonly phase: PersistencePhase;
    /** The underlying `EACCES` / `EPERM` / `EROFS` / `ERR_SQLITE_ERROR`, when there was one. */
    readonly errno: string | null;
    readonly repair: string;

    constructor(health: PersistenceHealth, cause: unknown) {
        super(
            `cannot use the database at ${health.path}: ${health.error ?? 'unknown error'} (phase: ${health.phase ?? 'open'})`,
            { cause }
        );
        this.databasePath = health.path;
        this.phase = health.phase ?? 'open';
        this.errno = health.errno;
        this.repair = repairFor(health);
    }
}

function repairFor(health: PersistenceHealth): string {
    const dir = health.path.slice(0, Math.max(0, health.path.lastIndexOf('/'))) || '/';
    switch (health.errno) {
        case 'EPERM':
        case 'EACCES':
            return `Give this user write access to ${dir} (or point ${DB_PATH_ENV} at a directory it owns, e.g. ~/.local/share/kelpid/nex.db). Refusing to start rather than running without persistence — your workspaces would not survive a restart.`;
        case 'EROFS':
            return `${dir} is on a read-only filesystem. Point ${DB_PATH_ENV} at a writable location.`;
        case 'ENOTDIR':
            return `A path component of ${health.path} is a file, not a directory. Fix ${DB_PATH_ENV}.`;
        case 'ENOSPC':
            return `The filesystem holding ${dir} is full. Free space and start again.`;
        default:
            return `Check that ${health.path} is a writable SQLite database (or move it aside and let the daemon create a fresh one). Set ${DB_PATH_ENV} to choose a different file.`;
    }
}

/**
 * Boot's gate: a daemon that cannot persist must not come up pretending otherwise.
 *
 * The one deliberate exception is `:memory:` (tests, and anyone who explicitly asked for a
 * throw-away daemon) — an in-memory database is not a *failure* to persist, it is a choice.
 */
export function assertPersistenceUsable(persistence: SqlitePersistence): void {
    if (persistence.isAvailable) return;
    if (persistence.path === ':memory:') return;
    throw new PersistenceUnavailableError(persistence.health(), persistence.lastError);
}

/** `EACCES`-style code off any thrown value, when it carries one. */
function errnoOf(error: unknown): string | null {
    if (typeof error !== 'object' || error === null) return null;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && code.length > 0 ? code : null;
}

function messageOf(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (error === null || error === undefined) return 'unknown error';
    return String(error);
}

const WORKSPACE_COLUMNS =
    '"id","name","color","layoutJSON","focusedPaneID","createdAt","lastAccessedAt","sortOrder","slug","labelsJSON","icon","profileName"';
const PANE_COLUMNS =
    '"id","workspaceID","label","type","workingDirectory","createdAt","lastActivityAt","agentSessionID","status","filePath","content","webURL","webTabsJSON","webActiveTabID","webIsPrivate","agentKind","agentProfileName"';
const REPO_COLUMNS = '"id","path","name","remoteURL","lastAccessedAt","isAutoDiscovered"';
const REPO_ASSOCIATION_COLUMNS = '"id","workspaceID","repoID","worktreePath","branchName","isAutoDetected"';
const GROUP_COLUMNS = '"id","name","color","isCollapsed","childOrderJSON","createdAt","sortOrder","icon"';

function placeholders(count: number): string {
    return new Array(count).fill('?').join(',');
}

const INSERT_WORKSPACE = `INSERT INTO "workspace" (${WORKSPACE_COLUMNS}) VALUES (${placeholders(12)})`;
const INSERT_PANE = `INSERT INTO "pane" (${PANE_COLUMNS}) VALUES (${placeholders(17)})`;
const INSERT_REPO = `INSERT INTO "repo" (${REPO_COLUMNS}) VALUES (${placeholders(6)})`;
const INSERT_REPO_ASSOCIATION = `INSERT INTO "repoAssociation" (${REPO_ASSOCIATION_COLUMNS}) VALUES (${placeholders(6)})`;
const INSERT_GROUP = `INSERT INTO "workspace_group" (${GROUP_COLUMNS}) VALUES (${placeholders(8)})`;
/** §2.4 / §9.3: appState is upsert-only, never cleared — unknown keys survive our saves. */
const UPSERT_APP_STATE =
    'INSERT INTO "appState" ("key","value") VALUES (?,?) ON CONFLICT("key") DO UPDATE SET "value" = excluded."value"';

export function createPersistence(options: PersistenceOptions = {}): SqlitePersistence {
    const debounceMs = options.debounceMs ?? SAVE_DEBOUNCE_MS;
    const onError = options.onError;
    const onDegraded = options.onDegraded;
    const clock = options.now ?? Date.now;

    let db: SqlDatabase | null = null;
    let path = options.path ?? '';
    let lastError: unknown = null;
    let failurePhase: PersistencePhase | null = null;
    let failedSaves = 0;
    let openFailed = false;
    let lastSaveFailed = false;
    let lastSaveAt: number | null = null;
    const notifyFloorMs = options.degradedNotifyMs ?? 5_000;
    /** Epoch ms of the last `onDegraded`, so a dropped-save storm cannot become a log storm. */
    let lastNotifiedAt = Number.NEGATIVE_INFINITY;

    const health = (): PersistenceHealth => {
        // "Degraded" is about failures, not about having a handle: a deliberate `:memory:`
        // database is healthy, and a cleanly closed one at shutdown is not retroactively broken.
        const broken = openFailed || lastSaveFailed;
        return {
            path,
            available: db !== null,
            degraded: broken,
            phase: broken ? failurePhase : null,
            error: broken ? messageOf(lastError) : null,
            errno: broken ? errnoOf(lastError) : null,
            failedSaves,
            lastSaveAt
        };
    };

    const report = (error: unknown, phase: PersistencePhase): void => {
        lastError = error;
        failurePhase = phase;
        onError?.(error, phase);
    };

    /** A failure that means memory and disk have diverged; the caller must be told. */
    const reportDegraded = (error: unknown, phase: PersistencePhase): void => {
        report(error, phase);
        lastNotifiedAt = clock();
        onDegraded?.(health());
    };

    /**
     * A save the daemon threw away because there is no database to write to.
     *
     * This used to be a bare `return` — the quietest line in the codebase, and the one that
     * turned an open failure into a day of lost work. Every drop is now counted, and the
     * warning is re-announced on a floor so a client that attached AFTER the failed open still
     * finds out (the open-time announcement had nobody to talk to).
     */
    const noteDroppedSave = (): void => {
        failedSaves += 1;
        lastSaveFailed = true;
        const at = clock();
        if (at - lastNotifiedAt < notifyFloorMs) return;
        lastNotifiedAt = at;
        onDegraded?.(health());
    };

    try {
        if (options.db !== undefined) {
            db = options.db;
            if (path.length === 0) path = options.path ?? ':memory:';
        } else {
            path = options.path ?? resolveDatabasePath();
            // Resolve + create-what-we-own + preflight, so an unusable location fails with a
            // real errno and a real path instead of sqlite's pathless "unable to open".
            if (path !== ':memory:') path = prepareDatabaseFile(path);
            db = openSqliteDatabase(path);
        }
        if (options.migrate !== false) initializeSchema(db);
    } catch (error) {
        // The handle is unusable. Boot turns this into a refusal to start
        // (`assertPersistenceUsable`); the importer turns it into a typed CLI error. Nobody
        // gets to carry on as if state were being written.
        if (db !== null) {
            try {
                db.close();
            } catch {
                // already unusable
            }
        }
        db = null;
        openFailed = true;
        reportDegraded(error, 'open');
    }

    let pending: PersistedSnapshot | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const cancelTimer = (): void => {
        if (timer === null) return;
        clearTimeout(timer);
        timer = null;
    };

    const readRows = (handle: SqlDatabase): LoadedRows => ({
        // Ordered reads mirror §6.1; `snapshotFromRows` re-sorts defensively so a caller passing
        // unordered rows still lands on the same snapshot.
        workspaces: handle.all('SELECT * FROM "workspace" ORDER BY "sortOrder"'),
        // No ORDER BY: pane order is insert order (§5.3), which is the app's array order.
        panes: handle.all('SELECT * FROM "pane"'),
        repos: handle.all('SELECT * FROM "repo"'),
        repoAssociations: handle.all('SELECT * FROM "repoAssociation"'),
        groups: handle.all('SELECT * FROM "workspace_group" ORDER BY "sortOrder"'),
        appState: handle.all('SELECT "key","value" FROM "appState"')
    });

    const loadOutcome = (): LoadOutcome => {
        const handle = db;
        if (handle === null) return { status: 'unreadable', snapshot: null, error: lastError };
        try {
            const snapshot = snapshotFromRows(readRows(handle), {
                ...(options.newTabID !== undefined ? { newTabID: options.newTabID } : {})
            });
            return { status: snapshot.workspaces.length > 0 ? 'ok' : 'empty', snapshot };
        } catch (error) {
            // §6.1: any thrown error abandons the whole load. The file is left untouched.
            report(error, 'load');
            return { status: 'unreadable', snapshot: null, error };
        }
    };

    const writeSnapshot = (snapshot: PersistedSnapshot): boolean => {
        const handle = db;
        // No handle = the open already failed and was already reported; do not re-fire the
        // degraded callback on every 500 ms tick.
        if (handle === null) return false;
        const rows = snapshotToRows(snapshot);
        try {
            handle.transaction(() => {
                // Delete order respects the FK graph (§5.3). Only tables this daemon owns.
                handle.run('DELETE FROM "repoAssociation"');
                handle.run('DELETE FROM "pane"');
                handle.run('DELETE FROM "workspace"');
                handle.run('DELETE FROM "repo"');
                handle.run('DELETE FROM "workspace_group"');

                for (const row of rows.repos) {
                    handle.run(
                        INSERT_REPO,
                        row.id,
                        row.path,
                        row.name,
                        row.remoteURL,
                        row.lastAccessedAt,
                        row.isAutoDiscovered
                    );
                }
                for (const row of rows.workspaces) {
                    handle.run(
                        INSERT_WORKSPACE,
                        row.id,
                        row.name,
                        row.color,
                        row.layoutJSON,
                        row.focusedPaneID,
                        row.createdAt,
                        row.lastAccessedAt,
                        row.sortOrder,
                        row.slug,
                        row.labelsJSON,
                        row.icon,
                        row.profileName
                    );
                }
                for (const row of rows.panes) {
                    handle.run(
                        INSERT_PANE,
                        row.id,
                        row.workspaceID,
                        row.label,
                        row.type,
                        row.workingDirectory,
                        row.createdAt,
                        row.lastActivityAt,
                        row.agentSessionID,
                        row.status,
                        row.filePath,
                        row.content,
                        row.webURL,
                        row.webTabsJSON,
                        row.webActiveTabID,
                        row.webIsPrivate,
                        row.agentKind,
                        row.agentProfileName
                    );
                }
                for (const row of rows.repoAssociations) {
                    handle.run(
                        INSERT_REPO_ASSOCIATION,
                        row.id,
                        row.workspaceID,
                        row.repoID,
                        row.worktreePath,
                        row.branchName,
                        row.isAutoDetected
                    );
                }
                for (const row of rows.groups) {
                    handle.run(
                        INSERT_GROUP,
                        row.id,
                        row.name,
                        row.color,
                        row.isCollapsed,
                        row.childOrderJSON,
                        row.createdAt,
                        row.sortOrder,
                        row.icon
                    );
                }
                for (const row of rows.appState) {
                    handle.run(UPSERT_APP_STATE, row.key, row.value);
                }
            });
            lastSaveAt = clock();
            lastSaveFailed = false;
            return true;
        } catch (error) {
            // §5.3: the transaction rolled back, so the file still holds the PREVIOUS snapshot
            // and the daemon keeps running — but memory and disk have now diverged, and that is
            // a fact the operator and every attached client are entitled to.
            failedSaves += 1;
            lastSaveFailed = true;
            reportDegraded(error, 'save');
            return false;
        }
    };

    const flush = (): boolean => {
        cancelTimer();
        const next = pending;
        pending = null;
        if (next === null) return db !== null && !lastSaveFailed;
        return writeSnapshot(next);
    };

    return {
        get path() {
            return path;
        },
        get isAvailable() {
            return db !== null;
        },
        get lastError() {
            return lastError;
        },
        health,
        load() {
            const outcome = loadOutcome();
            // §6.2: "zero workspaces loaded" and "unreadable" take the same branch — the caller
            // creates the Default workspace. Both are reported as null here, per the seam.
            return outcome.status === 'ok' ? outcome.snapshot : null;
        },
        loadOutcome,
        scheduleSave(snapshot) {
            if (closed) return;
            if (db === null) {
                noteDroppedSave();
                return;
            }
            // The snapshot is captured by the caller at dispatch time; the debounce delays the
            // WRITE, not the capture, so the last one wins and intermediates are dropped (§5.2).
            pending = snapshot;
            cancelTimer();
            timer = setTimeout(() => {
                timer = null;
                const next = pending;
                pending = null;
                if (next !== null) writeSnapshot(next);
            }, debounceMs);
            // Never hold the event loop open for a pending save; SIGTERM calls flush().
            timer.unref?.();
        },
        flush,
        saveNow(snapshot) {
            if (closed) return false;
            cancelTimer();
            pending = null;
            if (db === null) {
                noteDroppedSave();
                return false;
            }
            return writeSnapshot(snapshot);
        },
        hasPendingSave() {
            return pending !== null;
        },
        close() {
            if (closed) return;
            flush();
            closed = true;
            if (db === null) return;
            try {
                db.close();
            } catch (error) {
                report(error, 'save');
            }
            db = null;
        }
    };
}
