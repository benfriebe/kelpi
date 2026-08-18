/**
 * `Persistence<PersistedSnapshot>` over SQLite.
 *
 * Spec: docs/current/persistence.md §5 (debounced save, clear-and-reinsert in ONE transaction,
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
 */

import type { PersistedSnapshot } from '../store/index.js';
import type { Persistence } from '../seams.js';
import { openSqliteDatabase, type SqlDatabase } from './adapter.js';
import { snapshotFromRows, snapshotToRows, type LoadedRows } from './codec.js';
import { ensureDatabaseDir, resolveDatabasePath } from './location.js';
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
     * Errors are swallowed to keep the daemon alive on a broken DB (§5.3); this is the only
     * way to observe them. Defaults to a no-op.
     */
    readonly onError?: ((error: unknown, phase: PersistencePhase) => void) | undefined;
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
    /** Last error handed to `onError`, for tests/diagnostics. */
    readonly lastError: unknown;
}

const WORKSPACE_COLUMNS =
    '"id","name","color","layoutJSON","focusedPaneID","createdAt","lastAccessedAt","sortOrder","slug","labelsJSON","icon","profileName"';
const PANE_COLUMNS =
    '"id","workspaceID","label","type","workingDirectory","createdAt","lastActivityAt","agentSessionID","status","filePath","content","webURL","webTabsJSON","webActiveTabID","webIsPrivate","agentKind"';
const REPO_COLUMNS = '"id","path","name","remoteURL","lastAccessedAt","isAutoDiscovered"';
const REPO_ASSOCIATION_COLUMNS = '"id","workspaceID","repoID","worktreePath","branchName","isAutoDetected"';
const GROUP_COLUMNS = '"id","name","color","isCollapsed","childOrderJSON","createdAt","sortOrder","icon"';

function placeholders(count: number): string {
    return new Array(count).fill('?').join(',');
}

const INSERT_WORKSPACE = `INSERT INTO "workspace" (${WORKSPACE_COLUMNS}) VALUES (${placeholders(12)})`;
const INSERT_PANE = `INSERT INTO "pane" (${PANE_COLUMNS}) VALUES (${placeholders(16)})`;
const INSERT_REPO = `INSERT INTO "repo" (${REPO_COLUMNS}) VALUES (${placeholders(6)})`;
const INSERT_REPO_ASSOCIATION = `INSERT INTO "repoAssociation" (${REPO_ASSOCIATION_COLUMNS}) VALUES (${placeholders(6)})`;
const INSERT_GROUP = `INSERT INTO "workspace_group" (${GROUP_COLUMNS}) VALUES (${placeholders(8)})`;
/** §2.4 / §9.3: appState is upsert-only, never cleared — unknown keys survive our saves. */
const UPSERT_APP_STATE =
    'INSERT INTO "appState" ("key","value") VALUES (?,?) ON CONFLICT("key") DO UPDATE SET "value" = excluded."value"';

export function createPersistence(options: PersistenceOptions = {}): SqlitePersistence {
    const debounceMs = options.debounceMs ?? SAVE_DEBOUNCE_MS;
    const onError = options.onError;

    let db: SqlDatabase | null = null;
    let path = options.path ?? '';
    let lastError: unknown = null;

    const report = (error: unknown, phase: PersistencePhase): void => {
        lastError = error;
        onError?.(error, phase);
    };

    try {
        if (options.db !== undefined) {
            db = options.db;
            if (path.length === 0) path = options.path ?? ':memory:';
        } else {
            path = options.path ?? resolveDatabasePath();
            if (path !== ':memory:') ensureDatabaseDir(path);
            db = openSqliteDatabase(path);
        }
        if (options.migrate !== false) initializeSchema(db);
    } catch (error) {
        report(error, 'open');
        // A broken/locked DB must not take the daemon down: it runs, it just cannot persist.
        if (db !== null) {
            try {
                db.close();
            } catch {
                // already unusable
            }
        }
        db = null;
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
                        row.agentKind
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
            return true;
        } catch (error) {
            // §5.3: the transaction rolled back; log and keep running on the previous contents.
            report(error, 'save');
            return false;
        }
    };

    const flush = (): void => {
        cancelTimer();
        const next = pending;
        pending = null;
        if (next === null) return;
        writeSnapshot(next);
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
        load() {
            const outcome = loadOutcome();
            // §6.2: "zero workspaces loaded" and "unreadable" take the same branch — the caller
            // creates the Default workspace. Both are reported as null here, per the seam.
            return outcome.status === 'ok' ? outcome.snapshot : null;
        },
        loadOutcome,
        scheduleSave(snapshot) {
            if (closed || db === null) return;
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
