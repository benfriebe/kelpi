/**
 * Schema + the GRDB migration ledger.
 *
 * Spec: docs/current/persistence.md §2 (tables), §4 (all 18 migrations, in order, with the
 * column-existence guards), §8 (post-v18 DDL), Port notes ("run/verify the same migration
 * ledger … only applying migrations whose identifiers are absent").
 *
 * The daemon may adopt a database written by the Swift app, so migrations are expressed
 * exactly as they were there: one row per identifier in `grdb_migrations`, applied in
 * registration order, each in its own transaction. Identifiers already present are skipped —
 * which is also how a live DB's *foreign* identifiers (`v7_scheduled_tasks`,
 * `v9_workspace_folders`, from features this daemon does not implement) are handled: they are
 * simply not ours, we never run them, and we never touch the tables they created.
 *
 * Every `ADD COLUMN` is guarded by a live column check (§4). Pre-release Swift builds sometimes
 * created a column before its migration row was written; an unguarded re-run throws and wedges
 * startup. The guard makes each migration idempotent regardless of ledger drift.
 */

import { columnNames, hasColumn, tableExists, type SqlDatabase } from './adapter.js';

export const MIGRATIONS_TABLE = 'grdb_migrations';

/** Entity tables this daemon owns. Anything else in the file is left strictly alone (§5.3). */
export const OWNED_TABLES = [
    'workspace',
    'pane',
    'appState',
    'repo',
    'repoAssociation',
    'workspace_group'
] as const;

export interface Migration {
    readonly identifier: string;
    readonly apply: (db: SqlDatabase) => void;
}

/** `ALTER TABLE … ADD COLUMN`, skipped when the column is already there (§4). */
function addColumn(db: SqlDatabase, table: string, column: string, definition: string): void {
    if (hasColumn(db, table, column)) return;
    db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
}

export const MIGRATIONS: readonly Migration[] = [
    {
        identifier: 'v1_initial',
        apply: (db) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS "workspace" (
                    "id" TEXT PRIMARY KEY NOT NULL,
                    "name" TEXT NOT NULL,
                    "color" TEXT NOT NULL,
                    "layoutJSON" TEXT NOT NULL,
                    "focusedPaneID" TEXT,
                    "createdAt" DOUBLE NOT NULL,
                    "lastAccessedAt" DOUBLE NOT NULL,
                    "sortOrder" INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS "pane" (
                    "id" TEXT PRIMARY KEY NOT NULL,
                    "workspaceID" TEXT NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
                    "label" TEXT,
                    "type" TEXT NOT NULL DEFAULT 'shell',
                    "workingDirectory" TEXT NOT NULL,
                    "createdAt" DOUBLE NOT NULL,
                    "lastActivityAt" DOUBLE NOT NULL
                );
                CREATE TABLE IF NOT EXISTS "appState" (
                    "key" TEXT PRIMARY KEY NOT NULL,
                    "value" TEXT
                );
            `);
        }
    },
    {
        identifier: 'v2_repos',
        apply: (db) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS "repo" (
                    "id" TEXT PRIMARY KEY NOT NULL,
                    "path" TEXT NOT NULL UNIQUE,
                    "name" TEXT NOT NULL,
                    "remoteURL" TEXT,
                    "lastAccessedAt" DOUBLE NOT NULL
                );
                CREATE TABLE IF NOT EXISTS "repoAssociation" (
                    "id" TEXT PRIMARY KEY NOT NULL,
                    "workspaceID" TEXT NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
                    "repoID" TEXT NOT NULL REFERENCES "repo"("id") ON DELETE CASCADE,
                    "worktreePath" TEXT NOT NULL,
                    "branchName" TEXT
                );
            `);
        }
    },
    {
        identifier: 'v3_workspace_slug',
        // Spec pins guards "from v4 onward"; guarding v3 too is a strict superset — the only
        // observable difference is that a DB which already grew `slug` out of band boots
        // instead of throwing.
        apply: (db) => addColumn(db, 'workspace', 'slug', `TEXT DEFAULT ''`)
    },
    {
        identifier: 'v4_agent_session',
        apply: (db) => {
            addColumn(db, 'pane', 'claudeSessionID', 'TEXT');
            addColumn(db, 'pane', 'status', `TEXT DEFAULT 'idle'`);
        }
    },
    {
        identifier: 'v5_markdown_panes',
        apply: (db) => addColumn(db, 'pane', 'filePath', 'TEXT')
    },
    {
        identifier: 'v6_scratchpad_content',
        apply: (db) => addColumn(db, 'pane', 'content', 'TEXT')
    },
    {
        identifier: 'v7_repo_assoc_auto_detected',
        apply: (db) => addColumn(db, 'repoAssociation', 'isAutoDetected', 'BOOLEAN NOT NULL DEFAULT 0')
    },
    {
        identifier: 'v8_repo_auto_discovered',
        apply: (db) => addColumn(db, 'repo', 'isAutoDiscovered', 'BOOLEAN NOT NULL DEFAULT 0')
    },
    {
        identifier: 'v9_workspace_groups',
        apply: (db) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS "workspace_group" (
                    "id" TEXT PRIMARY KEY NOT NULL,
                    "name" TEXT NOT NULL,
                    "color" TEXT,
                    "isCollapsed" BOOLEAN NOT NULL DEFAULT 0,
                    "childOrderJSON" TEXT NOT NULL DEFAULT '[]',
                    "createdAt" DOUBLE NOT NULL,
                    "sortOrder" INTEGER NOT NULL DEFAULT 0
                );
            `);
        }
    },
    {
        identifier: 'v10_workspace_group_icon',
        apply: (db) => addColumn(db, 'workspace_group', 'icon', 'TEXT')
    },
    {
        identifier: 'v11_workspace_labels',
        apply: (db) => addColumn(db, 'workspace', 'labelsJSON', `TEXT NOT NULL DEFAULT '[]'`)
    },
    {
        identifier: 'v12_web_pane_url',
        apply: (db) => addColumn(db, 'pane', 'webURL', 'TEXT')
    },
    {
        identifier: 'v13_web_pane_tabs',
        // Guarded per column, independently (§4).
        apply: (db) => {
            addColumn(db, 'pane', 'webTabsJSON', 'TEXT');
            addColumn(db, 'pane', 'webActiveTabID', 'TEXT');
        }
    },
    {
        identifier: 'v14_web_pane_private',
        apply: (db) => addColumn(db, 'pane', 'webIsPrivate', 'BOOLEAN')
    },
    {
        identifier: 'v15_rename_agent_session',
        // Runs only when the old column exists AND the new one does not (§4).
        apply: (db) => {
            const columns = columnNames(db, 'pane');
            if (!columns.includes('claudeSessionID')) return;
            if (columns.includes('agentSessionID')) return;
            db.exec(`ALTER TABLE "pane" RENAME COLUMN "claudeSessionID" TO "agentSessionID"`);
        }
    },
    {
        identifier: 'v16_workspace_icon',
        apply: (db) => addColumn(db, 'workspace', 'icon', 'TEXT')
    },
    {
        identifier: 'v17_workspace_profile',
        apply: (db) => addColumn(db, 'workspace', 'profileName', 'TEXT')
    },
    {
        identifier: 'v18_pane_agent_kind',
        apply: (db) => addColumn(db, 'pane', 'agentKind', 'TEXT')
    },
    {
        // Kelpi-only (no Swift counterpart): the profile the pane's agent session was
        // launched under, so a resume can rebuild the same environment.
        identifier: 'v19_pane_agent_profile',
        apply: (db) => addColumn(db, 'pane', 'agentProfileName', 'TEXT')
    }
];

/** The ledger identifiers this daemon owns, in registration order (`v1_initial` … `v19_…`). */
export const MIGRATION_IDENTIFIERS: readonly string[] = MIGRATIONS.map((m) => m.identifier);

/**
 * Identifiers with NO Swift counterpart — added by this daemon after the ports reached
 * parity, so a legacy `nex.db` ledger can never contain them. The legacy importer excludes
 * them when judging whether a source database "predates" this importer.
 */
export const DAEMON_ONLY_MIGRATIONS: readonly string[] = ['v19_pane_agent_profile'];

export function ensureMigrationsTable(db: SqlDatabase): void {
    db.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (identifier TEXT NOT NULL PRIMARY KEY)`);
}

/** Every identifier recorded in the file, ours and anyone else's, in insertion order. */
export function appliedMigrations(db: SqlDatabase): string[] {
    if (!tableExists(db, MIGRATIONS_TABLE)) return [];
    const rows = db.all(`SELECT identifier FROM ${MIGRATIONS_TABLE}`);
    const identifiers: string[] = [];
    for (const row of rows) {
        const identifier = row['identifier'];
        if (typeof identifier === 'string') identifiers.push(identifier);
    }
    return identifiers;
}

export interface MigrateResult {
    /** Identifiers applied by this call (empty when the DB was already current). */
    readonly applied: readonly string[];
    /** Everything in the ledger afterwards, foreign identifiers included. */
    readonly ledger: readonly string[];
}

/**
 * Apply every registered migration whose identifier is absent, in order, each inside its own
 * transaction together with its ledger row (so a failure can never record an unapplied step).
 */
export function migrate(db: SqlDatabase): MigrateResult {
    ensureMigrationsTable(db);
    const present = new Set(appliedMigrations(db));
    const applied: string[] = [];

    for (const migration of MIGRATIONS) {
        if (present.has(migration.identifier)) continue;
        db.transaction(() => {
            migration.apply(db);
            db.run(`INSERT OR IGNORE INTO ${MIGRATIONS_TABLE} (identifier) VALUES (?)`, migration.identifier);
        });
        applied.push(migration.identifier);
    }

    return { applied, ledger: appliedMigrations(db) };
}

/** Pragmas are set by the adapter at open time; this brings the schema up to date. */
export function initializeSchema(db: SqlDatabase): MigrateResult {
    return migrate(db);
}
