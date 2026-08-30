/**
 * The import itself: read a legacy database, convert it, write it into a TARGET daemon
 * database through the existing `db/` layer — one transaction, nothing hand-rolled.
 *
 * Spec: docs/current/persistence.md §5.3 (clear + reinsert inside ONE transaction — which is
 * exactly what `SqlitePersistence.saveNow` does), §6 (load), Port notes ("on first run MIGRATE
 * by copying the legacy macOS path's file if present so existing users keep their workspaces").
 *
 * Safety rules, in order of how much damage breaking one would do:
 *
 *   1. The SOURCE is opened read-only and never written, migrated or deleted (`reader.ts`).
 *   2. A target that already holds workspaces is REFUSED. `--force` overrides, and only after
 *      the target has been copied aside with a timestamp suffix — an import is a whole-database
 *      replacement (§5.3 deletes every row in every owned table), so "oops" has to be
 *      recoverable.
 *   3. `--dry-run` writes NOTHING — not even the empty database that opening a missing path
 *      would create, which is why the target is inspected through `fs.existsSync` first.
 *
 * The "is a daemon running against this target?" check lives in `main.ts`: it needs the run
 * dir and an async probe, and it must refuse regardless of `--force` (a live daemon holds the
 * state in memory and would overwrite whatever we wrote on its next save).
 */

import fs from 'node:fs';
import nodePath from 'node:path';

import {
    createPersistence,
    openSqliteDatabase,
    tableExists,
    type SqlDatabase
} from '../db/index.js';
import type { PersistedSnapshot } from '../store/index.js';
import { convertLegacySnapshot } from './convert.js';
import {
    LegacyImportError,
    readLegacyDatabase,
    type LegacyLedger,
    type SkippedRow
} from './reader.js';

export interface ImportReport {
    readonly from: string;
    readonly to: string;
    readonly dryRun: boolean;
    /** True only when the target database was actually written. */
    readonly written: boolean;
    /** Counts of what landed (or would land) in the target. */
    readonly workspaces: number;
    readonly panes: number;
    readonly groups: number;
    readonly repos: number;
    readonly repoAssociations: number;
    /** Panes whose agent session will be resumed by the first boot after the import. */
    readonly resumable: number;
    /** Workspaces the target held BEFORE the import (non-zero requires `--force`). */
    readonly targetWorkspacesBefore: number;
    /** Where the pre-import target was copied, when `--force` replaced a populated one. */
    readonly backupPath: string | null;
    readonly skipped: readonly SkippedRow[];
    readonly warnings: readonly string[];
    readonly ledger: LegacyLedger;
    readonly ignoredTables: readonly string[];
}

export interface RunImportOptions {
    readonly from: string;
    readonly to: string;
    /** Replace a populated target (after backing it up). Never overrides the daemon check. */
    readonly force?: boolean | undefined;
    /** Report only; the target is not created, migrated or written. */
    readonly dryRun?: boolean | undefined;
    /** Clock for the backup suffix (tests). */
    readonly now?: (() => Date) | undefined;
    /** Injectable id source for pre-v13 `webURL` rows (tests). */
    readonly newTabID?: (() => string) | undefined;
}

/** `20260819T101112Z` — sortable, filename-safe, no colons. */
export function backupStamp(date: Date): string {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function uniqueBackupPath(target: string, stamp: string): string {
    const base = `${target}.${stamp}.bak`;
    if (!fs.existsSync(base)) return base;
    for (let index = 2; index < 1000; index += 1) {
        const candidate = `${target}.${stamp}-${String(index)}.bak`;
        if (!fs.existsSync(candidate)) return candidate;
    }
    throw new LegacyImportError(
        'target-unwritable',
        `cannot find a free backup name beside ${target}`,
        'Move the existing .bak files out of the way and retry.'
    );
}

/**
 * Copy the target aside before replacing it. `VACUUM INTO` is preferred over a file copy: it
 * writes ONE consistent file even when the database's newest rows are still in a -wal, which a
 * naive `cp nex.db` would miss. A driver that cannot do it falls back to copying the file plus
 * its sidecars.
 */
export function backupDatabaseFile(target: string, stamp: string): string {
    const backup = uniqueBackupPath(target, stamp);
    try {
        // `wal: false` so opening does not switch the journal mode of the file we are saving.
        const db = openSqliteDatabase(target, { wal: false });
        try {
            db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
        } finally {
            db.close();
        }
    } catch {
        fs.copyFileSync(target, backup);
        for (const suffix of ['-wal', '-shm']) {
            if (fs.existsSync(`${target}${suffix}`)) fs.copyFileSync(`${target}${suffix}`, `${backup}${suffix}`);
        }
    }
    return backup;
}

export interface TargetInspection {
    /** Workspaces the target currently holds; 0 when it does not exist yet. */
    readonly workspaces: number;
    /**
     * False when the file exists but could not be read. Treated exactly like a populated
     * target: "I could not tell what is in there" must never become "so I overwrote it".
     */
    readonly readable: boolean;
}

/**
 * What the target holds, WITHOUT creating or migrating it — a missing file stays missing,
 * because opening one would create it and a dry run must write nothing.
 */
export function inspectTargetDatabase(target: string, warnings: string[]): TargetInspection {
    if (target === ':memory:' || !fs.existsSync(target)) return { workspaces: 0, readable: true };
    let db: SqlDatabase;
    try {
        db = openSqliteDatabase(target, { readOnly: true, wal: false });
    } catch (error) {
        warnings.push(
            `target ${target} could not be opened for inspection: ${error instanceof Error ? error.message : String(error)}`
        );
        return { workspaces: 0, readable: false };
    }
    try {
        if (!tableExists(db, 'workspace')) return { workspaces: 0, readable: true };
        const row = db.get('SELECT COUNT(*) AS n FROM "workspace"');
        const value = row?.['n'];
        return { workspaces: typeof value === 'number' ? value : Number(value ?? 0), readable: true };
    } catch (error) {
        warnings.push(
            `target ${target} could not be inspected: ${error instanceof Error ? error.message : String(error)}`
        );
        return { workspaces: 0, readable: false };
    } finally {
        db.close();
    }
}

function countPanes(snapshot: PersistedSnapshot): number {
    return snapshot.workspaces.reduce((total, workspace) => total + workspace.panes.length, 0);
}

function countAssociations(snapshot: PersistedSnapshot): number {
    return snapshot.workspaces.reduce((total, workspace) => total + workspace.repoAssociations.length, 0);
}

/** Read → convert → (unless dry-run) write. Throws `LegacyImportError` on every refusal. */
export function runImport(options: RunImportOptions): ImportReport {
    if (options.to !== ':memory:' && nodePath.resolve(options.from) === nodePath.resolve(options.to)) {
        throw new LegacyImportError(
            'same-database',
            `--from and --to are the same file (${options.to})`,
            'Point --to at the daemon database (default: ~/Library/Application Support/kelpid/kelpi.db); the daemon keeps its own file so the Swift app can keep using yours.'
        );
    }

    const legacy = readLegacyDatabase({
        path: options.from,
        ...(options.newTabID !== undefined ? { newTabID: options.newTabID } : {})
    });
    const converted = convertLegacySnapshot(legacy.snapshot);
    const warnings = [...legacy.warnings, ...converted.warnings];

    const target = inspectTargetDatabase(options.to, warnings);
    const targetWorkspacesBefore = target.workspaces;
    const replacesSomething = targetWorkspacesBefore > 0 || !target.readable;
    const dryRun = options.dryRun === true;

    const base = {
        from: options.from,
        to: options.to,
        dryRun,
        workspaces: converted.snapshot.workspaces.length,
        panes: countPanes(converted.snapshot),
        groups: converted.snapshot.groups.length,
        repos: converted.snapshot.repos.length,
        repoAssociations: countAssociations(converted.snapshot),
        resumable: converted.resumable.length,
        targetWorkspacesBefore,
        skipped: legacy.skipped,
        ledger: legacy.ledger,
        ignoredTables: legacy.ignoredTables
    } as const;

    if (replacesSomething && options.force !== true) {
        // Refuse BEFORE the dry-run short-circuit: a dry run that says "would import" against a
        // populated target would be lying about what the real run does.
        throw new LegacyImportError(
            'target-populated',
            target.readable
                ? `${options.to} already holds ${String(targetWorkspacesBefore)} workspace(s)`
                : `${options.to} exists but could not be inspected`,
            'Pass --force to replace it (the existing database is copied aside with a timestamp suffix first), or --to <path> to import somewhere else.'
        );
    }

    if (dryRun) {
        return {
            ...base,
            written: false,
            backupPath: null,
            warnings: [...warnings, 'dry run: nothing was written']
        };
    }

    const backupPath = replacesSomething
        ? backupDatabaseFile(options.to, backupStamp((options.now ?? (() => new Date()))()))
        : null;
    if (backupPath !== null) warnings.push(`backed the target up to ${backupPath}`);

    // The daemon's own persistence layer owns the schema migration AND the one-transaction
    // clear-and-reinsert; the importer never writes SQL of its own.
    const persistence = createPersistence({ path: options.to });
    try {
        if (!persistence.isAvailable) {
            throw new LegacyImportError(
                'target-unwritable',
                `cannot open ${options.to} for writing: ${persistence.lastError instanceof Error ? persistence.lastError.message : String(persistence.lastError ?? 'unknown error')}`,
                'Check the path and its permissions, and make sure no other process holds the database.',
                { cause: persistence.lastError }
            );
        }
        if (!persistence.saveNow(converted.snapshot)) {
            throw new LegacyImportError(
                'target-unwritable',
                `writing ${options.to} failed: ${persistence.lastError instanceof Error ? persistence.lastError.message : String(persistence.lastError ?? 'unknown error')}`,
                backupPath === null
                    ? 'The transaction rolled back, so the target is unchanged.'
                    : `The transaction rolled back, so the target is unchanged; the backup at ${backupPath} can be removed.`,
                { cause: persistence.lastError }
            );
        }
    } finally {
        persistence.close();
    }

    return { ...base, written: true, backupPath, warnings };
}
