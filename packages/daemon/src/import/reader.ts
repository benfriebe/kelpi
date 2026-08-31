/**
 * Read a legacy Swift-app `nex.db` — strictly READ-ONLY.
 *
 * Spec: docs/current/persistence.md §2 (every table + column), §3 (Swift-Codable JSON
 * encodings), §4 (the 18 migrations + the ledger), §6.1 (read + decode), §6.3 (slug backfill),
 * §9 items 5–8 (the graceful-degradation table).
 *
 * Three rules this module never bends:
 *
 *   1. The source file is opened `readOnly` and is never migrated, written or deleted. A
 *      column that a pre-v18 database does not have simply reads as absent (the decoders in
 *      `db/codec.ts` default it) — we do NOT run `ALTER TABLE` to bring it up to date, because
 *      the Swift app may still be using this file.
 *   2. Row-level degradation matches the Swift loader rule for rule, because it IS the same
 *      code: `snapshotFromRows` (the daemon's own load path) decodes the rows, so an imported
 *      database can never disagree with an adopted one. This module adds only the reporting
 *      the load path deliberately lacks — the Swift loader drops a bad row silently, and an
 *      import that drops rows silently is an import nobody can trust.
 *   3. Tables this daemon does not own (`scheduledTask`, `workspaceFolder`, anything a future
 *      Swift version adds) are read by nobody and reported as ignored.
 *
 * The ledger check is advisory, never fatal: a longer ledger carrying identifiers we have
 * never heard of (a future `v19_…`) means the file may have columns we do not read, which is a
 * warning plus "proceed reading only the columns we know", not a refusal.
 */

import fs from 'node:fs';

import { isSafeSessionID } from '@kelpi/core/agent';
import {
    parseChildOrderJSON,
    parseIconString,
    parseLabelsJSON,
    parsePaneLayoutJSON,
    parseTopLevelOrderJSON,
    parseUUID,
    parseWebTabsJSON
} from '@kelpi/core/codec';
import { AGENT_KINDS, PANE_STATUSES, PANE_TYPES } from '@kelpi/core/layout';
import { parseWorkspaceColor } from '@kelpi/protocol';

import {
    APP_STATE_ACTIVE_WORKSPACE,
    APP_STATE_TOP_LEVEL_ORDER,
    decodeGroupRow,
    decodePaneRow,
    decodeRepoAssociationRow,
    decodeRepoRow,
    decodeWorkspaceRow,
    DAEMON_ONLY_MIGRATIONS,
    hasColumn,
    MIGRATION_IDENTIFIERS,
    MIGRATIONS_TABLE,
    openSqliteDatabase,
    OWNED_TABLES,
    snapshotFromRows,
    tableExists,
    tableNames,
    type LoadedRows,
    type SqlDatabase,
    type SqlRow
} from '../db/index.js';
import type { PersistedSnapshot } from '../store/index.js';

/**
 * Migration identifiers that a real Swift `nex.db` carries but this daemon does not own —
 * features the port does not implement (scheduled tasks, workspace folders). Present in the
 * live ledger fixture (`packages/core/fixtures/migrations.json`), so they are expected, not
 * "unknown".
 */
export const LEGACY_FOREIGN_MIGRATIONS: readonly string[] = ['v7_scheduled_tasks', 'v9_workspace_folders'];

/** The tables those foreign migrations create. Read by nobody; reported, never touched. */
export const LEGACY_FOREIGN_TABLES: readonly string[] = ['scheduledTask', 'workspaceFolder'];

/** Pre-v15 name of `pane.agentSessionID` (§4, `v15_rename_agent_session`). */
const LEGACY_SESSION_COLUMN = 'claudeSessionID';

export type LegacyImportErrorCode =
    /** `--from` names nothing. */
    | 'source-missing'
    /** SQLite could not open it read-only (locked WAL without a -shm, not a database, …). */
    | 'source-unreadable'
    /** Opened fine, but has no `workspace` table — this is not a Kelpi database. */
    | 'not-a-kelpi-database'
    /** The target already holds workspaces (or cannot be inspected) and `--force` was not given. */
    | 'target-populated'
    /** `--from` and `--to` name the same file. */
    | 'same-database'
    /** The target could not be opened/migrated, or the write transaction failed. */
    | 'target-unwritable';

/** Every refusal carries a repair line; the CLI prints both. */
export class LegacyImportError extends Error {
    readonly code: LegacyImportErrorCode;
    readonly repair: string;

    constructor(code: LegacyImportErrorCode, message: string, repair: string, options: { cause?: unknown } = {}) {
        super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = 'LegacyImportError';
        this.code = code;
        this.repair = repair;
    }
}

export function isLegacyImportError(value: unknown): value is LegacyImportError {
    return value instanceof LegacyImportError;
}

/** One row the import could not carry over, and why. */
export interface SkippedRow {
    readonly table: string;
    readonly id?: string;
    readonly reason: string;
}

export interface LegacyLedger {
    /** False when the file has no `grdb_migrations` table at all. */
    readonly present: boolean;
    /** Everything recorded, in insertion order. */
    readonly identifiers: readonly string[];
    /** Identifiers this importer knows that the file does not have (older database). */
    readonly missing: readonly string[];
    /** Known-foreign identifiers (`LEGACY_FOREIGN_MIGRATIONS`). */
    readonly foreign: readonly string[];
    /** Anything else — a newer Swift build. Warned about, then read anyway. */
    readonly unknown: readonly string[];
}

export interface LegacyCounts {
    readonly workspaces: number;
    readonly panes: number;
    readonly groups: number;
    readonly repos: number;
    readonly repoAssociations: number;
}

export interface LegacyReadResult {
    readonly path: string;
    /**
     * The legacy state in daemon shapes, decoded exactly as the daemon's own load path would.
     * Statuses and session ids are still VERBATIM here — `convert.ts` applies the transient
     * rules, so this value is also what a "what does the file actually say" dump wants.
     */
    readonly snapshot: PersistedSnapshot;
    readonly ledger: LegacyLedger;
    /** Tables present in the file that this importer does not own. */
    readonly ignoredTables: readonly string[];
    readonly skipped: readonly SkippedRow[];
    readonly warnings: readonly string[];
    /** Row counts AFTER degradation (i.e. what the snapshot actually holds). */
    readonly counts: LegacyCounts;
}

export interface ReadLegacyDatabaseOptions {
    readonly path: string;
    /** Injectable id source for the pre-v13 `webURL` → single-tab fallback (tests). */
    readonly newTabID?: (() => string) | undefined;
}

// ---------------------------------------------------------------------------
// Column helpers (raw rows — the decoders own the typed reads)
// ---------------------------------------------------------------------------

function text(row: SqlRow, key: string): string | null {
    const value = row[key];
    return typeof value === 'string' ? value : null;
}

function skipRow(table: string, id: string | null, reason: string): SkippedRow {
    return { table, ...(id !== null && id.length > 0 ? { id } : {}), reason };
}

function isEmpty(value: string | null): boolean {
    return value === null || value.length === 0;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/**
 * The identifiers a legacy Swift `nex.db` CAN carry: everything this daemon owns except its
 * own post-parity additions (`DAEMON_ONLY_MIGRATIONS`) — a source without those is not "old".
 */
const EXPECTED_LEGACY_IDENTIFIERS: readonly string[] = MIGRATION_IDENTIFIERS.filter(
    (identifier) => !DAEMON_ONLY_MIGRATIONS.includes(identifier)
);

export function inspectLedger(db: SqlDatabase): LegacyLedger {
    if (!tableExists(db, MIGRATIONS_TABLE)) {
        return { present: false, identifiers: [], missing: [...EXPECTED_LEGACY_IDENTIFIERS], foreign: [], unknown: [] };
    }
    const identifiers: string[] = [];
    for (const row of db.all(`SELECT identifier FROM ${MIGRATIONS_TABLE}`)) {
        const identifier = text(row, 'identifier');
        if (identifier !== null) identifiers.push(identifier);
    }
    const present = new Set(identifiers);
    return {
        present: true,
        identifiers,
        missing: EXPECTED_LEGACY_IDENTIFIERS.filter((identifier) => !present.has(identifier)),
        foreign: identifiers.filter((identifier) => LEGACY_FOREIGN_MIGRATIONS.includes(identifier)),
        unknown: identifiers.filter(
            (identifier) =>
                !MIGRATION_IDENTIFIERS.includes(identifier) && !LEGACY_FOREIGN_MIGRATIONS.includes(identifier)
        )
    };
}

function ledgerWarnings(ledger: LegacyLedger): string[] {
    const warnings: string[] = [];
    if (!ledger.present) {
        warnings.push(
            `no ${MIGRATIONS_TABLE} ledger in the source; reading whatever columns the tables actually have`
        );
        return warnings;
    }
    if (ledger.missing.length > 0) {
        warnings.push(
            `source ledger predates this importer (missing ${ledger.missing.join(', ')}); the columns those migrations add are read only where present`
        );
    }
    if (ledger.unknown.length > 0) {
        warnings.push(
            `source ledger carries migration(s) this importer does not know (${ledger.unknown.join(', ')}); reading only the columns it knows — anything they added is left behind`
        );
    }
    return warnings;
}

// ---------------------------------------------------------------------------
// Table reads
// ---------------------------------------------------------------------------

function readTable(db: SqlDatabase, table: string, warnings: string[], orderBy?: string): SqlRow[] {
    if (!tableExists(db, table)) {
        warnings.push(`source has no "${table}" table; treated as empty`);
        return [];
    }
    const order = orderBy !== undefined && hasColumn(db, table, orderBy) ? ` ORDER BY "${orderBy}"` : '';
    try {
        return db.all(`SELECT * FROM "${table}"${order}`);
    } catch (error) {
        warnings.push(`could not read "${table}": ${error instanceof Error ? error.message : String(error)}`);
        return [];
    }
}

/**
 * Pre-v15 rows keep the session id in `claudeSessionID` (§4). The rename never ran on this
 * file and we must not run it (read-only), so map the column across in memory — otherwise a
 * v14-era database would silently lose every resumable agent session.
 */
function normalizePaneRows(rows: readonly SqlRow[], db: SqlDatabase, warnings: string[]): SqlRow[] {
    if (!tableExists(db, 'pane')) return [...rows];
    if (hasColumn(db, 'pane', 'agentSessionID') || !hasColumn(db, 'pane', LEGACY_SESSION_COLUMN)) {
        return [...rows];
    }
    warnings.push(
        `source predates v15_rename_agent_session; reading "${LEGACY_SESSION_COLUMN}" as "agentSessionID" so agent sessions survive the import`
    );
    return rows.map((row) => ({ ...row, agentSessionID: row[LEGACY_SESSION_COLUMN] ?? null }));
}

function appStateValue(rows: readonly SqlRow[], key: string): string | null {
    for (const row of rows) {
        if (text(row, 'key') === key) return text(row, 'value');
    }
    return null;
}

// ---------------------------------------------------------------------------
// Diagnostics — the reporting the load path deliberately does not do
// ---------------------------------------------------------------------------

interface Diagnostics {
    readonly skipped: SkippedRow[];
    readonly warnings: string[];
}

function diagnoseWorkspaces(rows: readonly SqlRow[], out: Diagnostics): Set<string> {
    const ids = new Set<string>();
    let regeneratedSlugs = 0;

    for (const row of rows) {
        const decoded = decodeWorkspaceRow(row);
        if (decoded === null) {
            out.skipped.push(skipRow('workspace', text(row, 'id'), 'unparseable workspace id'));
            continue;
        }
        if (ids.has(decoded.id)) {
            out.skipped.push(skipRow('workspace', decoded.id, 'duplicate workspace id'));
            continue;
        }
        ids.add(decoded.id);

        const layout = text(row, 'layoutJSON');
        if (isEmpty(layout)) {
            out.warnings.push(`workspace ${decoded.id} has no layoutJSON; imported with an empty layout`);
        } else if (parsePaneLayoutJSON(layout) === null) {
            out.warnings.push(`workspace ${decoded.id} has an undecodable layoutJSON; imported with an empty layout`);
        }

        const labels = text(row, 'labelsJSON');
        if (!isEmpty(labels) && parseLabelsJSON(labels) === null) {
            out.warnings.push(`workspace ${decoded.id} has an undecodable labelsJSON; imported with no labels`);
        }

        const color = text(row, 'color');
        if (!isEmpty(color) && parseWorkspaceColor(color ?? undefined) === undefined) {
            out.warnings.push(`workspace ${decoded.id} has unknown color "${color ?? ''}"; imported as blue`);
        }

        const icon = text(row, 'icon');
        if (!isEmpty(icon) && parseIconString(icon) === null) {
            out.warnings.push(`workspace ${decoded.id} has an unparseable icon "${icon ?? ''}"; imported without one`);
        }

        // §6.3: the v3 default is '' and the loader regenerates. Worth reporting in bulk —
        // a slug change is visible (worktree paths are named from it).
        if (isEmpty(text(row, 'slug'))) regeneratedSlugs += 1;
    }

    if (regeneratedSlugs > 0) {
        out.warnings.push(
            `regenerated ${String(regeneratedSlugs)} empty workspace slug(s) from name + id (legacy v3 rows)`
        );
    }
    return ids;
}

function diagnosePanes(rows: readonly SqlRow[], workspaceIDs: ReadonlySet<string>, out: Diagnostics): void {
    const seen = new Set<string>();

    for (const row of rows) {
        const decoded = decodePaneRow(row);
        if (decoded === null) {
            const reason =
                parseUUID(text(row, 'id')) === null ? 'unparseable pane id' : 'unparseable workspaceID';
            out.skipped.push(skipRow('pane', text(row, 'id'), reason));
            continue;
        }
        const pane = decoded.pane;
        if (seen.has(pane.id)) {
            out.skipped.push(skipRow('pane', pane.id, 'duplicate pane id'));
            continue;
        }
        seen.add(pane.id);
        if (!workspaceIDs.has(decoded.workspaceID)) {
            out.skipped.push(
                skipRow('pane', pane.id, `orphan: workspace ${decoded.workspaceID} was not imported`)
            );
            continue;
        }

        const type = text(row, 'type');
        if (!isEmpty(type) && !(PANE_TYPES as readonly string[]).includes(type ?? '')) {
            out.warnings.push(`pane ${pane.id} has unknown type "${type ?? ''}"; imported as shell`);
        }
        const status = text(row, 'status');
        if (!isEmpty(status) && !(PANE_STATUSES as readonly string[]).includes(status ?? '')) {
            out.warnings.push(`pane ${pane.id} has unknown status "${status ?? ''}"; imported as idle`);
        }
        const kind = text(row, 'agentKind');
        if (!isEmpty(kind) && !(AGENT_KINDS as readonly string[]).includes(kind ?? '')) {
            out.warnings.push(`pane ${pane.id} has unknown agentKind "${kind ?? ''}"; imported without one`);
        }

        const tabs = text(row, 'webTabsJSON');
        if (pane.type === 'web') {
            if (pane.webIsPrivate && !isEmpty(tabs)) {
                // §9.10: the flag survives, the contents never do — even if a hand-edited row
                // carries them.
                out.warnings.push(
                    `private web pane ${pane.id} carried persisted tabs; dropped (private panes always restore blank)`
                );
            } else if (!pane.webIsPrivate && !isEmpty(tabs) && parseWebTabsJSON(tabs) === null) {
                out.warnings.push(
                    `pane ${pane.id} has an undecodable webTabsJSON; falling back to the legacy webURL column`
                );
            }
        }

        const session = pane.agentSessionID;
        if (session !== null && !isSafeSessionID(session)) {
            // §9.13: the id is typed into a shell at restore, so the allowlist is a security
            // boundary — the daemon will silently skip it. Say so now, not never.
            out.warnings.push(
                `pane ${pane.id} has an agent session id that fails the shell-safety allowlist; it will not be resumed`
            );
        }
    }
}

function diagnoseRepos(rows: readonly SqlRow[], out: Diagnostics): Set<string> {
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const row of rows) {
        const repo = decodeRepoRow(row);
        if (repo === null) {
            out.skipped.push(skipRow('repo', text(row, 'id'), 'unparseable repo id'));
            continue;
        }
        if (ids.has(repo.id)) {
            out.skipped.push(skipRow('repo', repo.id, 'duplicate repo id'));
            continue;
        }
        // §9.4: `repo.path` is the schema's only value constraint; the write path drops the
        // second row rather than failing the whole transaction.
        if (paths.has(repo.path)) {
            out.skipped.push(skipRow('repo', repo.id, `duplicate repo path ${repo.path} (path is UNIQUE)`));
            continue;
        }
        ids.add(repo.id);
        paths.add(repo.path);
    }
    return ids;
}

function diagnoseAssociations(
    rows: readonly SqlRow[],
    workspaceIDs: ReadonlySet<string>,
    repoIDs: ReadonlySet<string>,
    out: Diagnostics
): void {
    const seen = new Set<string>();
    for (const row of rows) {
        const decoded = decodeRepoAssociationRow(row);
        if (decoded === null) {
            out.skipped.push(
                skipRow('repoAssociation', text(row, 'id'), 'unparseable association, workspace or repo id')
            );
            continue;
        }
        const association = decoded.association;
        if (seen.has(association.id)) {
            out.skipped.push(skipRow('repoAssociation', association.id, 'duplicate association id'));
            continue;
        }
        seen.add(association.id);
        if (!workspaceIDs.has(decoded.workspaceID)) {
            out.skipped.push(
                skipRow(
                    'repoAssociation',
                    association.id,
                    `orphan: workspace ${decoded.workspaceID} was not imported`
                )
            );
            continue;
        }
        if (!repoIDs.has(association.repoID)) {
            out.skipped.push(
                skipRow(
                    'repoAssociation',
                    association.id,
                    `repo ${association.repoID} is not in the registry (FK would fail)`
                )
            );
        }
    }
}

function diagnoseGroups(rows: readonly SqlRow[], out: Diagnostics): Set<string> {
    const ids = new Set<string>();
    for (const row of rows) {
        const decoded = decodeGroupRow(row);
        if (decoded === null) {
            out.skipped.push(skipRow('workspace_group', text(row, 'id'), 'unparseable group id'));
            continue;
        }
        if (ids.has(decoded.group.id)) {
            out.skipped.push(skipRow('workspace_group', decoded.group.id, 'duplicate group id'));
            continue;
        }
        ids.add(decoded.group.id);
        const childOrder = text(row, 'childOrderJSON');
        if (!isEmpty(childOrder) && parseChildOrderJSON(childOrder) === null) {
            out.warnings.push(
                `group ${decoded.group.id} has an undecodable childOrderJSON; imported with no members`
            );
        }
    }
    return ids;
}

function diagnoseAppState(
    rows: readonly SqlRow[],
    snapshot: PersistedSnapshot,
    workspaceIDs: ReadonlySet<string>,
    groupIDs: ReadonlySet<string>,
    out: Diagnostics
): void {
    const order = appStateValue(rows, APP_STATE_TOP_LEVEL_ORDER);
    if (isEmpty(order)) {
        // §6.2 step 3 / §9.8: a pre-groups database has no order at all.
        out.warnings.push('no topLevelOrder recorded; sidebar order synthesized from workspace order');
    } else if (parseTopLevelOrderJSON(order) === null) {
        out.warnings.push('undecodable topLevelOrder; sidebar order synthesized from workspace order');
    } else {
        // §9.9: nothing validates the order against live rows and the app tolerates dangling
        // entries, so they are kept verbatim — but a dangling entry after a skipped row is
        // exactly the kind of thing an import report exists to surface.
        for (const entry of snapshot.topLevelOrder) {
            const known = entry.kind === 'workspace' ? workspaceIDs.has(entry.id) : groupIDs.has(entry.id);
            if (!known) {
                out.warnings.push(
                    `sidebar order references ${entry.kind} ${entry.id}, which was not imported; the entry is kept verbatim`
                );
            }
        }
    }

    const active = appStateValue(rows, APP_STATE_ACTIVE_WORKSPACE);
    const activeID = parseUUID(active);
    if (activeID !== null && !workspaceIDs.has(activeID)) {
        out.warnings.push(
            `active workspace ${activeID} was not imported; the daemon will activate the first workspace instead`
        );
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function openSource(path: string): SqlDatabase {
    if (!fs.existsSync(path)) {
        throw new LegacyImportError(
            'source-missing',
            `no legacy database at ${path}`,
            'Pass --from <path> pointing at the Swift app\'s nex.db (usually ~/Library/Application Support/Kelpi/nex.db).'
        );
    }
    try {
        // readOnly + no WAL pragma: opening must not create a journal, upgrade anything, or
        // give this process any way to write the file.
        return openSqliteDatabase(path, { readOnly: true, wal: false });
    } catch (error) {
        throw new LegacyImportError(
            'source-unreadable',
            `cannot open ${path} read-only: ${error instanceof Error ? error.message : String(error)}`,
            'If Kelpi.app is running, quit it and retry; a WAL database whose -shm file is missing cannot be opened read-only. Otherwise copy nex.db, nex.db-wal and nex.db-shm to a scratch directory and import from the copy.',
            { cause: error }
        );
    }
}

/** Open, verify, decode. Never writes; always closes the handle. */
export function readLegacyDatabase(options: ReadLegacyDatabaseOptions): LegacyReadResult {
    const db = openSource(options.path);
    try {
        return readFromOpenDatabase(db, options.path, options);
    } catch (error) {
        // SQLite defers its header check to the first real statement, so "not a database" and
        // "database disk image is malformed" surface HERE rather than at open. Every failure
        // from this module is a typed refusal with a repair line.
        if (isLegacyImportError(error)) throw error;
        throw new LegacyImportError(
            'source-unreadable',
            `cannot read ${options.path}: ${error instanceof Error ? error.message : String(error)}`,
            'Check that the path is a Kelpi SQLite database. If Kelpi.app is running, quit it and retry, or import from a copy of nex.db (plus its -wal and -shm files).',
            { cause: error }
        );
    } finally {
        db.close();
    }
}

/** The read half, against an already-open (read-only) handle. Exported for tests. */
export function readFromOpenDatabase(
    db: SqlDatabase,
    path: string,
    options: { readonly newTabID?: (() => string) | undefined } = {}
): LegacyReadResult {
    if (!tableExists(db, 'workspace')) {
        throw new LegacyImportError(
            'not-a-kelpi-database',
            `${path} has no "workspace" table`,
            'Point --from at a Kelpi database (the Swift app writes ~/Library/Application Support/Kelpi/nex.db).'
        );
    }

    const ledger = inspectLedger(db);
    const warnings: string[] = ledgerWarnings(ledger);

    const ignoredTables = tableNames(db).filter(
        (name) => !(OWNED_TABLES as readonly string[]).includes(name) && name !== MIGRATIONS_TABLE
    );
    if (ignoredTables.length > 0) {
        // `scheduledTask` / `workspaceFolder` are expected (features the port does not
        // implement); anything else is a table a newer Swift build added, whose contents this
        // import silently leaves behind — worth saying out loud.
        const unrecognised = ignoredTables.filter((name) => !LEGACY_FOREIGN_TABLES.includes(name));
        warnings.push(
            `ignored ${String(ignoredTables.length)} table(s) this importer does not own: ${ignoredTables.join(', ')}${
                unrecognised.length > 0
                    ? ` — ${unrecognised.join(', ')} unrecognised, anything they hold is not carried over`
                    : ''
            }`
        );
    }

    const rows: LoadedRows = {
        workspaces: readTable(db, 'workspace', warnings, 'sortOrder'),
        // No ORDER BY: pane order IS insert order, which is the app's array order (§5.3).
        panes: normalizePaneRows(readTable(db, 'pane', warnings), db, warnings),
        repos: readTable(db, 'repo', warnings),
        repoAssociations: readTable(db, 'repoAssociation', warnings),
        groups: readTable(db, 'workspace_group', warnings, 'sortOrder'),
        appState: readTable(db, 'appState', warnings)
    };

    // The daemon's own load path decodes the rows, so an imported database and an adopted one
    // can never disagree about what a row means.
    const snapshot = snapshotFromRows(rows, {
        ...(options.newTabID !== undefined ? { newTabID: options.newTabID } : {})
    });

    const diagnostics: Diagnostics = { skipped: [], warnings };
    const workspaceIDs = diagnoseWorkspaces(rows.workspaces, diagnostics);
    diagnosePanes(rows.panes, workspaceIDs, diagnostics);
    const repoIDs = diagnoseRepos(rows.repos, diagnostics);
    diagnoseAssociations(rows.repoAssociations, workspaceIDs, repoIDs, diagnostics);
    const groupIDs = diagnoseGroups(rows.groups, diagnostics);
    diagnoseAppState(rows.appState, snapshot, workspaceIDs, groupIDs, diagnostics);

    return {
        path,
        snapshot,
        ledger,
        ignoredTables,
        skipped: diagnostics.skipped,
        warnings: diagnostics.warnings,
        counts: {
            workspaces: snapshot.workspaces.length,
            panes: snapshot.workspaces.reduce((total, workspace) => total + workspace.panes.length, 0),
            groups: snapshot.groups.length,
            repos: snapshot.repos.length,
            repoAssociations: snapshot.workspaces.reduce(
                (total, workspace) => total + workspace.repoAssociations.length,
                0
            )
        }
    };
}
