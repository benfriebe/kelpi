/**
 * A thin, synchronous SQLite adapter.
 *
 * Spec: docs/current/persistence.md §1 (WAL + `foreign_keys=ON`), §5.3 (one transaction per
 * save), Port notes ("`node:sqlite` behind a thin adapter, better-sqlite3 as swap-in").
 *
 * Everything above this file talks to `SqlDatabase`, never to `node:sqlite` — the concrete
 * driver is chosen once, here, so swapping in better-sqlite3 (whose `prepare`/`all`/`get`/`run`
 * surface is the same shape) is a single new `open*` function plus a wrapper, with no changes
 * to schema/codec/persistence.
 *
 * Deliberate adapter-level normalizations (both drivers reject these values outright):
 *   - `boolean` binds as 0/1 (SQLite has no boolean type; the schema's BOOLEAN columns are ints)
 *   - `undefined` binds as NULL (so optional domain fields need no call-site ceremony)
 */

import { DatabaseSync } from 'node:sqlite';

/** Values callers may bind to a statement parameter. */
export type SqlInputValue = string | number | bigint | boolean | null | undefined | Uint8Array;

/** Values SQLite can hand back for a column. */
export type SqlOutputValue = string | number | bigint | null | Uint8Array;

/** One result row. Column values are unknown-ish by construction — decode via `db/codec.ts`. */
export type SqlRow = Record<string, SqlOutputValue>;

export interface SqlRunResult {
    readonly changes: number | bigint;
    readonly lastInsertRowid: number | bigint;
}

export interface SqlStatement {
    all(...params: readonly SqlInputValue[]): SqlRow[];
    get(...params: readonly SqlInputValue[]): SqlRow | undefined;
    run(...params: readonly SqlInputValue[]): SqlRunResult;
}

export interface SqlDatabase {
    /** Run one or more statements with no parameters and no results (DDL, pragmas). */
    exec(sql: string): void;
    /**
     * Prepare (and cache) a statement. Repeated calls with the same SQL return the same
     * statement object — the save path re-runs the same ~8 statements every 500 ms.
     */
    prepare(sql: string): SqlStatement;
    all(sql: string, ...params: readonly SqlInputValue[]): SqlRow[];
    get(sql: string, ...params: readonly SqlInputValue[]): SqlRow | undefined;
    run(sql: string, ...params: readonly SqlInputValue[]): SqlRunResult;
    /**
     * Run `body` inside a transaction, committing on return and rolling back on throw.
     * Re-entrant: a nested call uses a SAVEPOINT so an inner failure cannot commit half of an
     * outer transaction.
     */
    transaction<T>(body: () => T): T;
    close(): void;
    readonly isOpen: boolean;
}

export interface OpenDatabaseOptions {
    /** `PRAGMA foreign_keys` — cascade deletes depend on it (§1). Default true. */
    readonly foreignKeys?: boolean | undefined;
    /** `PRAGMA journal_mode=WAL` for file databases. Default true; ignored for `:memory:`. */
    readonly wal?: boolean | undefined;
    readonly readOnly?: boolean | undefined;
}

export const MEMORY_DATABASE = ':memory:';

function normalizeParams(params: readonly SqlInputValue[]): (string | number | bigint | null | Uint8Array)[] {
    return params.map((value) => {
        if (value === undefined) return null;
        if (typeof value === 'boolean') return value ? 1 : 0;
        return value;
    });
}

/**
 * Wraps a `node:sqlite` `DatabaseSync`. Nothing else in the daemon imports `node:sqlite`.
 */
export function openSqliteDatabase(
    location: string = MEMORY_DATABASE,
    options: OpenDatabaseOptions = {}
): SqlDatabase {
    const handle = new DatabaseSync(location, {
        readOnly: options.readOnly ?? false,
        enableForeignKeyConstraints: options.foreignKeys ?? true
    });
    const db = wrapSqliteDatabase(handle);

    try {
        if ((options.foreignKeys ?? true) === true) db.exec('PRAGMA foreign_keys = ON');
        else db.exec('PRAGMA foreign_keys = OFF');

        // WAL is meaningless for in-memory databases and errors on read-only handles.
        if ((options.wal ?? true) === true && location !== MEMORY_DATABASE && options.readOnly !== true) {
            db.exec('PRAGMA journal_mode = WAL');
        }
    } catch (error) {
        // A file that is not a database fails here (SQLite defers the header check); close the
        // handle so a failed open never leaks a descriptor, and let the caller decide.
        db.close();
        throw error;
    }
    return db;
}

/** Minimal structural view of the driver handle, so the wrapper is driver-shaped, not driver-bound. */
interface RawStatement {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

interface RawDatabase {
    exec(sql: string): void;
    prepare(sql: string): RawStatement;
    close(): void;
}

/**
 * Adapts any driver handle exposing `exec` / `prepare` / `close` (node:sqlite's `DatabaseSync`,
 * better-sqlite3's `Database`). Exported so a swap-in driver needs no new transaction logic.
 */
export function wrapSqliteDatabase(handle: RawDatabase): SqlDatabase {
    const cache = new Map<string, SqlStatement>();
    let open = true;
    let depth = 0;
    let savepointCounter = 0;

    const wrapStatement = (raw: RawStatement): SqlStatement => ({
        all: (...params) => raw.all(...normalizeParams(params)) as SqlRow[],
        get: (...params) => raw.get(...normalizeParams(params)) as SqlRow | undefined,
        run: (...params) => raw.run(...normalizeParams(params))
    });

    const db: SqlDatabase = {
        get isOpen() {
            return open;
        },
        exec(sql) {
            handle.exec(sql);
        },
        prepare(sql) {
            const cached = cache.get(sql);
            if (cached !== undefined) return cached;
            const statement = wrapStatement(handle.prepare(sql));
            cache.set(sql, statement);
            return statement;
        },
        all(sql, ...params) {
            return db.prepare(sql).all(...params);
        },
        get(sql, ...params) {
            return db.prepare(sql).get(...params);
        },
        run(sql, ...params) {
            return db.prepare(sql).run(...params);
        },
        transaction(body) {
            if (depth > 0) {
                savepointCounter += 1;
                const name = `kelpi_sp_${String(savepointCounter)}`;
                handle.exec(`SAVEPOINT ${name}`);
                depth += 1;
                try {
                    const result = body();
                    handle.exec(`RELEASE ${name}`);
                    return result;
                } catch (error) {
                    handle.exec(`ROLLBACK TO ${name}`);
                    handle.exec(`RELEASE ${name}`);
                    throw error;
                } finally {
                    depth -= 1;
                }
            }

            // IMMEDIATE: the daemon is the single writer; take the write lock up front so a
            // concurrent reader can never turn a mid-transaction upgrade into SQLITE_BUSY.
            handle.exec('BEGIN IMMEDIATE');
            depth = 1;
            try {
                const result = body();
                handle.exec('COMMIT');
                return result;
            } catch (error) {
                try {
                    handle.exec('ROLLBACK');
                } catch {
                    // A failed ROLLBACK means the transaction was already aborted by SQLite.
                }
                throw error;
            } finally {
                depth = 0;
            }
        },
        close() {
            if (!open) return;
            open = false;
            cache.clear();
            handle.close();
        }
    };

    return db;
}

// ── introspection helpers (used by the migration guards) ────────────────────────────

export function tableExists(db: SqlDatabase, table: string): boolean {
    const row = db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table);
    return row !== undefined;
}

/** Live column names of `table`; empty when the table does not exist. */
export function columnNames(db: SqlDatabase, table: string): string[] {
    const rows = db.all(`SELECT name FROM pragma_table_info(?)`, table);
    const names: string[] = [];
    for (const row of rows) {
        const name = row['name'];
        if (typeof name === 'string') names.push(name);
    }
    return names;
}

export function hasColumn(db: SqlDatabase, table: string, column: string): boolean {
    return columnNames(db, table).includes(column);
}

/** Every table in the file, including ones this daemon knows nothing about. */
export function tableNames(db: SqlDatabase): string[] {
    const rows = db.all(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    );
    const names: string[] = [];
    for (const row of rows) {
        const name = row['name'];
        if (typeof name === 'string') names.push(name);
    }
    return names;
}
