/**
 * M8 — legacy database import (`kelpid import`).
 *
 * Spec: docs/current/persistence.md (the entire legacy schema, its 18 migrations, the
 * Swift-Codable encodings and the load-degradation rules).
 *
 *   reader.ts    open a Swift `nex.db` READ-ONLY, verify the ledger, decode every table with
 *                the same degradation rules the app's loader uses — and REPORT what degraded
 *   convert.ts   legacy state → `PersistedSnapshot`: statuses idled, `agentSessionID` +
 *                `agentKind` preserved so the first boot resumes exactly like a Swift restart
 *   importer.ts  write it into a target daemon database through `db/`, in one transaction,
 *                refusing a populated target unless `--force` (which backs it up first)
 *
 * `testing.ts` builds fixture legacy databases from the spec's DDL; it is deliberately not
 * re-exported here (test-only, same convention as `git/testing.ts`).
 */

export { convertLegacySnapshot } from './convert.js';
export type { ConvertOptions, ConvertResult } from './convert.js';

export {
    backupDatabaseFile,
    backupStamp,
    inspectTargetDatabase,
    runImport
} from './importer.js';
export type { ImportReport, RunImportOptions, TargetInspection } from './importer.js';

export {
    inspectLedger,
    isLegacyImportError,
    LEGACY_FOREIGN_MIGRATIONS,
    LEGACY_FOREIGN_TABLES,
    LegacyImportError,
    readFromOpenDatabase,
    readLegacyDatabase
} from './reader.js';
export type {
    LegacyCounts,
    LegacyImportErrorCode,
    LegacyLedger,
    LegacyReadResult,
    ReadLegacyDatabaseOptions,
    SkippedRow
} from './reader.js';
