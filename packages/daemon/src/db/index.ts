/**
 * WP2.6 — persistence.
 *
 * `createPersistence()` is the seam (`Persistence<PersistedSnapshot>`); everything else is
 * exported for boot-time diagnostics, the M8 legacy-import utility, and tests.
 *
 * Spec: docs/current/persistence.md.
 */

export {
    columnNames,
    hasColumn,
    MEMORY_DATABASE,
    openSqliteDatabase,
    tableExists,
    tableNames,
    wrapSqliteDatabase
} from './adapter.js';
export type {
    OpenDatabaseOptions,
    SqlDatabase,
    SqlInputValue,
    SqlOutputValue,
    SqlRow,
    SqlRunResult,
    SqlStatement
} from './adapter.js';

export {
    APP_STATE_ACTIVE_WORKSPACE,
    APP_STATE_LABEL_PRESETS,
    APP_STATE_LABEL_PRESETS_MIGRATED,
    APP_STATE_SNAPSHOT_VERSION,
    APP_STATE_TOP_LEVEL_ORDER,
    decodeAgentKind,
    decodeAppStateFlag,
    decodeGroupColor,
    decodeGroupRow,
    decodeLabelPresetsJSON,
    decodePaneRow,
    decodePaneStatus,
    decodePaneType,
    decodeRepoAssociationRow,
    decodeRepoRow,
    decodeWorkspaceColor,
    decodeWorkspaceRow,
    DEFAULT_WORKSPACE_COLOR,
    encodeAppStateRows,
    encodeGroupRow,
    encodeLabelPresetsJSON,
    encodePaneRow,
    encodeRepoAssociationRow,
    encodeRepoRow,
    encodeWorkspaceRow,
    snapshotFromRows,
    snapshotToRows,
    toEpochSecondsColumn
} from './codec.js';
export type {
    AppStateRow,
    DecodedGroupRow,
    DecodedPaneRow,
    DecodedRepoAssociationRow,
    DecodedWorkspaceScalars,
    DecodePaneOptions,
    LoadedRows,
    PaneRow,
    RepoAssociationRow,
    RepoRow,
    SnapshotRows,
    WorkspaceGroupRow,
    WorkspaceRow
} from './codec.js';

export {
    DATABASE_FILENAME,
    DB_DIR_MODE,
    DB_PATH_ENV,
    ensureDatabaseDir,
    expandTilde,
    legacyMacAppDatabasePath,
    MEMORY_DATABASE_PATH,
    prepareDatabaseFile,
    resolveDatabasePath,
    resolveDataDir
} from './location.js';
export type { DatabaseLocationLookup } from './location.js';

export {
    assertPersistenceUsable,
    createPersistence,
    PersistenceUnavailableError,
    SAVE_DEBOUNCE_MS
} from './persistence.js';
export type {
    LoadOutcome,
    LoadStatus,
    PersistenceOptions,
    PersistencePhase,
    SqlitePersistence
} from './persistence.js';

export {
    appliedMigrations,
    ensureMigrationsTable,
    initializeSchema,
    migrate,
    MIGRATION_IDENTIFIERS,
    MIGRATIONS,
    MIGRATIONS_TABLE,
    OWNED_TABLES
} from './schema.js';
export type { Migration, MigrateResult } from './schema.js';
