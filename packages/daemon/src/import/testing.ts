/**
 * Fixture builder for legacy Swift `nex.db` files.
 *
 * The DDL below is docs/persistence.md §8 verbatim — deliberately NOT the daemon's own
 * `db/schema.ts`. If the two ever drift, these fixtures keep testing what the Swift app
 * actually writes rather than what the port happens to create, which is the whole point of an
 * importer test.
 *
 * Two schema variants are available: the post-v18 shape and a `v14` shape (before
 * `v15_rename_agent_session`, so `pane.claudeSessionID`, no `agentKind`, no workspace
 * `icon`/`profileName`) for the legacy-column fallbacks.
 *
 * Test-only, same convention as `git/testing.ts`: not re-exported from `import/index.ts`.
 */

import { readFileSync } from 'node:fs';

import { openSqliteDatabase, type SqlDatabase, type SqlInputValue } from '../db/index.js';

export type LegacyRow = Record<string, SqlInputValue>;

export type LegacySchemaVariant = 'v18' | 'v14';

export interface LegacyDatabaseSpec {
    readonly workspaces?: readonly LegacyRow[] | undefined;
    readonly panes?: readonly LegacyRow[] | undefined;
    readonly repos?: readonly LegacyRow[] | undefined;
    readonly repoAssociations?: readonly LegacyRow[] | undefined;
    readonly groups?: readonly LegacyRow[] | undefined;
    readonly appState?: readonly LegacyRow[] | undefined;
    /** Ledger identifiers to record. `null` omits the `grdb_migrations` table entirely. */
    readonly ledger?: readonly string[] | null | undefined;
    readonly schema?: LegacySchemaVariant | undefined;
    /** Create the tables the foreign migrations own (`scheduledTask`, `workspaceFolder`). */
    readonly foreignTables?: boolean | undefined;
}

/** The real ledger from a live database (`packages/core/fixtures/migrations.json`). */
export function realLegacyLedger(): string[] {
    const text = readFileSync(new URL('../../../core/fixtures/migrations.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('migrations fixture is not an array');
    return parsed.map((entry) => {
        const identifier = (entry as Record<string, unknown>)['identifier'];
        if (typeof identifier !== 'string') throw new Error('migrations fixture row has no identifier');
        return identifier;
    });
}

/** Real `layoutJSON` column values captured from a live database, in file order. */
export function realLayoutJSON(): string[] {
    const text = readFileSync(new URL('../../../core/fixtures/layout-json.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('layout fixture is not an array');
    return parsed.map((entry) => {
        const value = (entry as Record<string, unknown>)['layoutJSON'];
        if (typeof value !== 'string') throw new Error('layout fixture row has no layoutJSON');
        return value;
    });
}

/** Real workspace scalars (`id`, `createdAt`, `lastAccessedAt`, `labelsJSON`). */
export function realWorkspaceScalars(): { id: string; createdAt: number; lastAccessedAt: number; labelsJSON: string }[] {
    const text = readFileSync(new URL('../../../core/fixtures/workspace-scalars.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('workspace scalars fixture is not an array');
    return parsed.map((entry) => {
        const row = entry as Record<string, unknown>;
        const id = row['id'];
        const createdAt = row['createdAt'];
        const lastAccessedAt = row['lastAccessedAt'];
        const labelsJSON = row['labelsJSON'];
        if (
            typeof id !== 'string' ||
            typeof createdAt !== 'number' ||
            typeof lastAccessedAt !== 'number' ||
            typeof labelsJSON !== 'string'
        ) {
            throw new Error('workspace scalars fixture row has an unexpected shape');
        }
        return { id, createdAt, lastAccessedAt, labelsJSON };
    });
}

/** The real `appState["topLevelOrder"]` value from a live database. */
export function realTopLevelOrder(): string {
    const text = readFileSync(new URL('../../../core/fixtures/top-level-order.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(text);
    const first = Array.isArray(parsed) ? (parsed[0] as Record<string, unknown> | undefined) : undefined;
    const value = first?.['value'];
    if (typeof value !== 'string') throw new Error('top-level-order fixture has no value');
    return value;
}

// ---------------------------------------------------------------------------
// Schema (docs/persistence.md §8)
// ---------------------------------------------------------------------------

const WORKSPACE_COLUMNS_V18 = [
    'id',
    'name',
    'color',
    'layoutJSON',
    'focusedPaneID',
    'createdAt',
    'lastAccessedAt',
    'sortOrder',
    'slug',
    'labelsJSON',
    'icon',
    'profileName'
] as const;

const PANE_COLUMNS_V18 = [
    'id',
    'workspaceID',
    'label',
    'type',
    'workingDirectory',
    'createdAt',
    'lastActivityAt',
    'agentSessionID',
    'status',
    'filePath',
    'content',
    'webURL',
    'webTabsJSON',
    'webActiveTabID',
    'webIsPrivate',
    'agentKind'
] as const;

const REPO_COLUMNS = ['id', 'path', 'name', 'remoteURL', 'lastAccessedAt', 'isAutoDiscovered'] as const;
const REPO_ASSOCIATION_COLUMNS = [
    'id',
    'workspaceID',
    'repoID',
    'worktreePath',
    'branchName',
    'isAutoDetected'
] as const;
const GROUP_COLUMNS = [
    'id',
    'name',
    'color',
    'isCollapsed',
    'childOrderJSON',
    'createdAt',
    'sortOrder',
    'icon'
] as const;

function schemaSQL(variant: LegacySchemaVariant): string {
    const workspaceTail =
        variant === 'v18'
            ? `  labelsJSON     TEXT NOT NULL DEFAULT '[]',
  icon           TEXT,
  profileName    TEXT`
            : `  labelsJSON     TEXT NOT NULL DEFAULT '[]'`;
    const paneTail =
        variant === 'v18'
            ? `  agentSessionID   TEXT,
  status           TEXT DEFAULT 'idle',
  filePath         TEXT,
  content          TEXT,
  webURL           TEXT,
  webTabsJSON      TEXT,
  webActiveTabID   TEXT,
  webIsPrivate     BOOLEAN,
  agentKind        TEXT`
            : `  claudeSessionID  TEXT,
  status           TEXT DEFAULT 'idle',
  filePath         TEXT,
  content          TEXT,
  webURL           TEXT`;

    return `
CREATE TABLE workspace (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  color          TEXT NOT NULL,
  layoutJSON     TEXT NOT NULL,
  focusedPaneID  TEXT,
  createdAt      DOUBLE NOT NULL,
  lastAccessedAt DOUBLE NOT NULL,
  sortOrder      INTEGER NOT NULL DEFAULT 0,
  slug           TEXT DEFAULT '',
${workspaceTail}
);

CREATE TABLE pane (
  id               TEXT PRIMARY KEY,
  workspaceID      TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  label            TEXT,
  type             TEXT NOT NULL DEFAULT 'shell',
  workingDirectory TEXT NOT NULL,
  createdAt        DOUBLE NOT NULL,
  lastActivityAt   DOUBLE NOT NULL,
${paneTail}
);

CREATE TABLE appState (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE repo (
  id              TEXT PRIMARY KEY,
  path            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  remoteURL       TEXT,
  lastAccessedAt  DOUBLE NOT NULL,
  isAutoDiscovered BOOLEAN NOT NULL DEFAULT 0
);

CREATE TABLE repoAssociation (
  id           TEXT PRIMARY KEY,
  workspaceID  TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  repoID       TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  worktreePath TEXT NOT NULL,
  branchName   TEXT,
  isAutoDetected BOOLEAN NOT NULL DEFAULT 0
);

CREATE TABLE workspace_group (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  color          TEXT,
  isCollapsed    BOOLEAN NOT NULL DEFAULT 0,
  childOrderJSON TEXT NOT NULL DEFAULT '[]',
  createdAt      DOUBLE NOT NULL,
  sortOrder      INTEGER NOT NULL DEFAULT 0,
  icon           TEXT
);
`;
}

const FOREIGN_TABLES_SQL = `
CREATE TABLE scheduledTask (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  schedule  TEXT NOT NULL
);
CREATE TABLE workspaceFolder (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
`;

function insertRows(
    db: SqlDatabase,
    table: string,
    columns: readonly string[],
    rows: readonly LegacyRow[]
): void {
    for (const row of rows) {
        // Only the columns this schema variant actually has, and only the ones the row names:
        // everything else takes its DDL default.
        const named = columns.filter((column) => Object.prototype.hasOwnProperty.call(row, column));
        if (named.length === 0) continue;
        const sql = `INSERT INTO "${table}" (${named.map((c) => `"${c}"`).join(',')}) VALUES (${named
            .map(() => '?')
            .join(',')})`;
        db.run(sql, ...named.map((column) => row[column] ?? null));
    }
}

/** Create a legacy database at `path` from `spec`. Overwrites nothing — the path must be new. */
export function writeLegacyDatabase(path: string, spec: LegacyDatabaseSpec = {}): void {
    const variant = spec.schema ?? 'v18';
    // `foreignKeys: false` so a fixture can hold rows a live connection would reject (an orphan
    // pane, an association pointing at a missing repo). Those rows are not hypothetical: the
    // pragma is per-CONNECTION, so anything that ever wrote this file without it could leave
    // them behind, and §9.5 requires the loader to tolerate them row by row.
    const db = openSqliteDatabase(path, { wal: false, foreignKeys: false });
    try {
        db.exec(schemaSQL(variant));
        if (spec.foreignTables === true) db.exec(FOREIGN_TABLES_SQL);

        const ledger = spec.ledger === undefined ? realLegacyLedger() : spec.ledger;
        if (ledger !== null) {
            db.exec('CREATE TABLE grdb_migrations (identifier TEXT NOT NULL PRIMARY KEY)');
            for (const identifier of ledger) {
                db.run('INSERT OR IGNORE INTO grdb_migrations (identifier) VALUES (?)', identifier);
            }
        }

        const paneColumns =
            variant === 'v18'
                ? PANE_COLUMNS_V18
                : (['id', 'workspaceID', 'label', 'type', 'workingDirectory', 'createdAt', 'lastActivityAt', 'claudeSessionID', 'status', 'filePath', 'content', 'webURL'] as const);
        const workspaceColumns =
            variant === 'v18'
                ? WORKSPACE_COLUMNS_V18
                : (WORKSPACE_COLUMNS_V18.filter((column) => column !== 'icon' && column !== 'profileName') as readonly string[]);

        insertRows(db, 'workspace', workspaceColumns, spec.workspaces ?? []);
        insertRows(db, 'repo', REPO_COLUMNS, spec.repos ?? []);
        insertRows(db, 'pane', paneColumns, spec.panes ?? []);
        insertRows(db, 'repoAssociation', REPO_ASSOCIATION_COLUMNS, spec.repoAssociations ?? []);
        insertRows(db, 'workspace_group', GROUP_COLUMNS, spec.groups ?? []);
        insertRows(db, 'appState', ['key', 'value'], spec.appState ?? []);
    } finally {
        db.close();
    }
}

// ---------------------------------------------------------------------------
// Row builders — required NOT NULL columns get plausible defaults
// ---------------------------------------------------------------------------

const BASE_CREATED_AT = 1_776_423_707.457_244_9;

export function legacyWorkspace(row: LegacyRow): LegacyRow {
    return {
        color: 'blue',
        layoutJSON: '{"empty":{}}',
        createdAt: BASE_CREATED_AT,
        lastAccessedAt: BASE_CREATED_AT + 60,
        sortOrder: 0,
        slug: '',
        labelsJSON: '[]',
        ...row
    };
}

export function legacyPane(row: LegacyRow): LegacyRow {
    return {
        type: 'shell',
        workingDirectory: '/tmp',
        createdAt: BASE_CREATED_AT,
        lastActivityAt: BASE_CREATED_AT + 30,
        status: 'idle',
        ...row
    };
}

export function legacyGroup(row: LegacyRow): LegacyRow {
    return {
        isCollapsed: 0,
        childOrderJSON: '[]',
        createdAt: BASE_CREATED_AT,
        sortOrder: 0,
        ...row
    };
}

export function legacyRepo(row: LegacyRow): LegacyRow {
    return {
        name: 'repo',
        lastAccessedAt: BASE_CREATED_AT,
        isAutoDiscovered: 0,
        ...row
    };
}

export function legacyRepoAssociation(row: LegacyRow): LegacyRow {
    return {
        worktreePath: '/tmp',
        isAutoDetected: 0,
        ...row
    };
}
