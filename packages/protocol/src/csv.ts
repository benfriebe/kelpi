/**
 * The csv document pane contract (#324, docs/csv-pane.md).
 *
 * A csv pane never moves a whole file over the wire. The daemon indexes the file once, serves
 * rows by range in the pane's view order, and takes row-level edits addressed by LOGICAL row
 * (file order, unchanged by sorting or saving) and stable column id. This module is the one
 * place the shapes, verbs and limits live, so the WS hub, the plugin documents API, the CLI and
 * the client validate the same way.
 */

/** Lower-cased extensions (no dot) that open as a csv pane. */
export const CSV_OPEN_EXTENSIONS: readonly string[] = ['csv', 'tsv'];

/** True when `filePath` ends in a csv extension (case-insensitive). */
export function isCsvPath(filePath: string): boolean {
    const base = filePath.slice(filePath.lastIndexOf('/') + 1);
    const dot = base.lastIndexOf('.');
    if (dot <= 0) return false;
    return CSV_OPEN_EXTENSIONS.includes(base.slice(dot + 1).toLowerCase());
}

const KIB = 1024;
const MIB = 1024 * KIB;

/** Every bound the daemon enforces. Clients use the same numbers to stay inside them. */
export const CSV_LIMITS = {
    /** Ops in one `csv-edit` batch. */
    maxOpsPerBatch: 1000,
    /** Rows inserted by one `csv-edit` batch (the sum of its `insert-rows.count`s). */
    maxInsertRows: 100_000,
    /** One cell value, UTF-8 bytes. */
    maxCellBytes: MIB,
    /** A whole `csv-edit` payload, UTF-8 bytes of its JSON. */
    maxBatchBytes: 8 * MIB,
    /** A find query, UTF-8 bytes. */
    maxFindQueryBytes: KIB,
    /** Rows in one `csv-rows` request. */
    maxRowsPerRequest: 500,
    /** Columns in one `csv-rows` request. */
    maxColumnsPerRequest: 256,
    /** A `csv-rows` reply stops adding rows past this many cell bytes and returns `nextStart`. */
    rowsReplyBudgetBytes: 2 * MIB,
    /** The same budget for the plugin documents API (its JSON is capped at 256 KiB). */
    pluginRowsReplyBudgetBytes: 200 * KIB,
    /** A cell longer than this is sent truncated and is read-only in the grid. */
    truncatedCellBytes: 64 * KIB,
    /** ⌘E raw text is offered only up to this file size. */
    rawEditLimitBytes: 2 * MIB,
    /** A record longer than this makes the file read-only (malformed or unbalanced quotes). */
    maxRecordBytes: 16 * MIB,
    /** Find stops collecting past this many matches (`truncated: true`). */
    maxFindMatches: 1_000_000,
    /** Above this size autosave waits longer and quit/close save in the background. */
    largeFileBytes: 16 * MIB,
    /** Undo history budget per document. */
    undoBudgetBytes: 64 * MIB
} as const;

export type CsvDelimiter = ',' | ';' | '\t' | '|';
export type CsvLineEnding = '\n' | '\r\n';

export interface CsvDialect {
    readonly delimiter: CsvDelimiter;
    readonly lineEnding: CsvLineEnding;
    /** A UTF-8 BOM opens the file and is written back on save. */
    readonly bom: boolean;
    /** Every field in the sample was quoted, so edited rows quote every field too. */
    readonly quoteAll: boolean;
}

export type CsvSortDirection = 'asc' | 'desc';

export interface CsvSortState {
    /** Stable column id. */
    readonly column: number;
    readonly direction: CsvSortDirection;
    /** True while the daemon is still building the permutation; rows come back unsorted. */
    readonly pending: boolean;
}

export interface CsvScanProgress {
    readonly rows: number;
    readonly bytes: number;
    readonly totalBytes: number;
}

export type CsvReadOnlyCode =
    /** Bytes that are not valid UTF-8. */
    | 'not-utf8'
    /** A UTF-16 or UTF-32 byte order mark. */
    | 'utf16'
    /** A record over `maxRecordBytes`, almost always an unbalanced quote. */
    | 'oversized-record'
    /** Another pane has this file open as raw text (⌘E). */
    | 'raw-elsewhere'
    /** Not a regular file, or it could not be opened for reading only. */
    | 'not-regular';

export interface CsvReadOnly {
    readonly code: CsvReadOnlyCode;
    /** A sentence for the pane's status line. */
    readonly message: string;
}

/** What `csv-updated` pushes and every state-returning verb replies with. */
export interface CsvPaneState {
    readonly paneID: string;
    /** Changes when the document is (re)opened: a reload, a reopen or a daemon restart. */
    readonly incarnation: string;
    /** Bumps on every change a client could render; drop a state older than the one you hold. */
    readonly revision: number;
    /**
     * `${incarnation}:${n}`; bumps when logical row indices or the column set change (row or
     * column insert/delete, undo/redo of one, reload). Edits carry the generation they were
     * computed against. Saving and sorting never change it.
     */
    readonly generation: string;
    readonly filePath: string | null;
    /** The first rows are readable (the scan may still be running). */
    readonly loaded: boolean;
    /** Non-null while the file is being indexed. Edits, sort and find wait until it is null. */
    readonly scanning: CsvScanProgress | null;
    /** Logical rows, including the header row when there is one. */
    readonly rowCount: number;
    /** Stable column ids in display order. `columns.length` is the column count. */
    readonly columns: readonly number[];
    /** File size at the last scan or save. */
    readonly bytes: number;
    readonly dialect: CsvDialect | null;
    /** This pane treats logical row 0 as headers (sticky, excluded from sort). Persisted per pane. */
    readonly headerRow: boolean;
    /** This pane's view sort, or null for file order. */
    readonly sort: CsvSortState | null;
    /** Edits not yet on disk. */
    readonly dirty: boolean;
    readonly saving: boolean;
    readonly canUndo: boolean;
    readonly canRedo: boolean;
    /** ⌘E raw text is available (small enough, UTF-8, not read-only). */
    readonly rawEditable: boolean;
    readonly readOnly: CsvReadOnly | null;
    /** A load or save failure, as a sentence. */
    readonly error: string | null;
    /** A one-off notice, e.g. "The file changed on disk; 3 unsaved edits were discarded." */
    readonly notice: string | null;
}

/** One row of a `csv-rows` reply. */
export interface CsvRow {
    /** Position in this pane's view order. With a header row, view 0 is always logical row 0. */
    readonly view: number;
    /** Logical row (file order). Edits address this. */
    readonly row: number;
    /** Values for the requested column window, in display order. Missing fields are ''. */
    readonly cells: readonly string[];
    /** Indices into `cells` that were cut at `truncatedCellBytes` (read-only in the grid). */
    readonly truncated?: readonly number[];
    /** Fields this row really has (a ragged row has fewer than `columns.length`). */
    readonly fieldCount: number;
}

export interface CsvRowsRequest {
    /** First view index. */
    readonly start: number;
    readonly count: number;
    /** First display column (default 0). */
    readonly columnStart?: number;
    /** Columns from `columnStart` (default: up to `maxColumnsPerRequest`). */
    readonly columnCount?: number;
}

export interface CsvRowsReply {
    readonly generation: string;
    readonly revision: number;
    readonly start: number;
    readonly columnStart: number;
    /** Stable ids of the columns `cells` holds, in order. */
    readonly columnIDs: readonly number[];
    readonly rows: readonly CsvRow[];
    /** Set when the byte budget stopped the reply early: ask again from here. */
    readonly nextStart: number | null;
}

export type CsvEditOp =
    | { readonly op: 'set-cell'; readonly row: number; readonly column: number; readonly value: string }
    /** Insert `count` rows before logical row `at` (`at === rowCount` appends). `rows` optionally fills them. */
    | { readonly op: 'insert-rows'; readonly at: number; readonly count: number; readonly rows?: readonly (readonly string[])[] }
    | { readonly op: 'delete-rows'; readonly start: number; readonly count: number }
    /** Insert an empty column before display index `at` (`at === columns.length` appends). */
    | { readonly op: 'insert-column'; readonly at: number }
    | { readonly op: 'delete-column'; readonly column: number }
    | { readonly op: 'undo' }
    | { readonly op: 'redo' };

export type CsvEditOpName = CsvEditOp['op'];

export const CSV_EDIT_OPS: readonly CsvEditOpName[] = [
    'set-cell',
    'insert-rows',
    'delete-rows',
    'insert-column',
    'delete-column',
    'undo',
    'redo'
];

export interface CsvFindReply {
    readonly query: string;
    /** Matches found (cells, not rows). */
    readonly total: number;
    readonly complete: boolean;
    /** Stopped at `maxFindMatches`. */
    readonly truncated: boolean;
}

export interface CsvFindMatch {
    readonly view: number;
    readonly row: number;
    /** Stable column id. */
    readonly column: number;
}

export interface CsvFindStepReply {
    readonly query: string;
    readonly match: CsvFindMatch | null;
    /** 1-based position of `match` among all matches in view order, when known. */
    readonly index: number | null;
    readonly total: number;
    readonly complete: boolean;
    readonly truncated: boolean;
}

export type CsvFindDirection = 'next' | 'previous';

/**
 * Error messages the daemon throws start with one of these codes and a colon, the same way
 * `DOCUMENT_CONFLICT:` does, so the SDK can surface a `code`.
 */
export const CSV_ERROR_CODES = [
    /** The edit's generation is from another incarnation or older than the translation log. */
    'CSV_STALE',
    /** The edit's row or column was deleted since its generation. */
    'CSV_GONE',
    /** The document is read-only (see `readOnly`) or in raw-text mode. */
    'CSV_READ_ONLY',
    /** The file is still being indexed. */
    'CSV_BUSY',
    /** A request broke one of `CSV_LIMITS` or was malformed. */
    'CSV_INVALID'
] as const;
export type CsvErrorCode = (typeof CSV_ERROR_CODES)[number];

export function csvError(code: CsvErrorCode, message: string): Error {
    return new Error(`${code}: ${message}`);
}

/** The code at the start of an error message, if it has one. */
export function csvErrorCode(message: string): CsvErrorCode | null {
    const colon = message.indexOf(':');
    if (colon <= 0) return null;
    const code = message.slice(0, colon);
    return (CSV_ERROR_CODES as readonly string[]).includes(code) ? (code as CsvErrorCode) : null;
}

// ── WS verbs ─────────────────────────────────────────────────────────────────────────

/**
 * The csv pane's WS-only verbs. Like the content verbs they are matched before the wire decode
 * and answer through `command-reply` when their promise settles. Every payload carries
 * `pane_id`; the rest is below (snake_case on the wire).
 *
 *   csv-subscribe       -                                    → `{ok, pane_id, state}` + `csv-updated` pushes
 *   csv-unsubscribe     -                                    → `{ok, pane_id}`
 *   csv-rows            `start, count, column_start?, column_count?` → `{ok, pane_id, rows: CsvRowsReply}`
 *   csv-edit            `generation, ops: CsvEditOp[]`       → `{ok, pane_id, state}`
 *   csv-sort            `column: number | null, direction?`  → `{ok, pane_id, state}`
 *   csv-find            `query`                              → `{ok, pane_id, find: CsvFindReply}` (when complete)
 *   csv-find-step       `query, direction, from?: {view, column}` → `{ok, pane_id, step: CsvFindStepReply}`
 *   csv-set-header-row  `on: boolean`                        → `{ok, pane_id, state}` (persisted per pane)
 *   csv-discard         -                                    → `{ok, pane_id, state}` (drop unsaved edits, reload)
 *
 * `csv-updated` (`{type, paneID, state}`) goes only to sessions subscribed to that pane.
 */
export const CSV_COMMANDS = [
    'csv-subscribe',
    'csv-unsubscribe',
    'csv-rows',
    'csv-edit',
    'csv-sort',
    'csv-find',
    'csv-find-step',
    'csv-set-header-row',
    'csv-discard'
] as const;
export type CsvCommand = (typeof CSV_COMMANDS)[number];

export function isCsvCommand(command: string): command is CsvCommand {
    return (CSV_COMMANDS as readonly string[]).includes(command);
}

export const CSV_UPDATED_MESSAGE = 'csv-updated';

// ── validation (shared by the WS hub and the plugin documents API) ───────────────────

export type CsvDecoded<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

const invalid = (message: string): { ok: false; error: string } => ({ ok: false, error: `CSV_INVALID: ${message}` });

const utf8Bytes = (value: string): number => {
    // TextEncoder is available in Node and every browser the client runs in.
    return new TextEncoder().encode(value).length;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isIndex = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * Shape-check a `csv-edit` op list. Bounds against the document (row/column ranges) are the
 * daemon's job; this rejects anything malformed or over `CSV_LIMITS` before it gets there.
 */
export function decodeCsvEditOps(value: unknown): CsvDecoded<readonly CsvEditOp[]> {
    if (!Array.isArray(value)) return invalid('ops must be an array');
    if (value.length === 0) return invalid('ops is empty');
    if (value.length > CSV_LIMITS.maxOpsPerBatch) return invalid(`at most ${CSV_LIMITS.maxOpsPerBatch} ops per batch`);
    let bytes = 0;
    let inserted = 0;
    const ops: CsvEditOp[] = [];
    for (const raw of value) {
        if (!isRecord(raw)) return invalid('each op must be an object');
        switch (raw['op']) {
            case 'set-cell': {
                const { row, column, value: cell } = raw;
                if (!isIndex(row) || !isIndex(column)) return invalid('set-cell needs row and column indices');
                if (typeof cell !== 'string') return invalid('set-cell needs a string value');
                const size = utf8Bytes(cell);
                if (size > CSV_LIMITS.maxCellBytes) return invalid('cell value is over 1 MiB');
                bytes += size;
                ops.push({ op: 'set-cell', row, column, value: cell });
                break;
            }
            case 'insert-rows': {
                const { at, count, rows } = raw;
                if (!isIndex(at) || !isIndex(count) || count === 0) return invalid('insert-rows needs at and a positive count');
                if (count > CSV_LIMITS.maxInsertRows) return invalid(`insert-rows count is over ${CSV_LIMITS.maxInsertRows}`);
                // The cap is per BATCH: 1000 ops of 100,000 blank rows each would be 100M rows.
                inserted += count;
                if (inserted > CSV_LIMITS.maxInsertRows) return invalid(`insert-rows in one batch add up to over ${CSV_LIMITS.maxInsertRows} rows`);
                if (rows === undefined) { ops.push({ op: 'insert-rows', at, count }); break; }
                if (!Array.isArray(rows) || rows.length !== count) return invalid('insert-rows rows must have count entries');
                const filled: string[][] = [];
                for (const entry of rows) {
                    if (!Array.isArray(entry) || entry.length > CSV_LIMITS.maxColumnsPerRequest * 64) return invalid('insert-rows row must be an array of strings');
                    const cells: string[] = [];
                    for (const cell of entry) {
                        if (typeof cell !== 'string') return invalid('insert-rows row must be an array of strings');
                        const size = utf8Bytes(cell);
                        if (size > CSV_LIMITS.maxCellBytes) return invalid('cell value is over 1 MiB');
                        bytes += size;
                        cells.push(cell);
                    }
                    filled.push(cells);
                }
                ops.push({ op: 'insert-rows', at, count, rows: filled });
                break;
            }
            case 'delete-rows': {
                const { start, count } = raw;
                if (!isIndex(start) || !isIndex(count) || count === 0) return invalid('delete-rows needs start and a positive count');
                ops.push({ op: 'delete-rows', start, count });
                break;
            }
            case 'insert-column': {
                const { at } = raw;
                if (!isIndex(at)) return invalid('insert-column needs at');
                ops.push({ op: 'insert-column', at });
                break;
            }
            case 'delete-column': {
                const { column } = raw;
                if (!isIndex(column)) return invalid('delete-column needs a column id');
                ops.push({ op: 'delete-column', column });
                break;
            }
            case 'undo':
            case 'redo':
                ops.push({ op: raw['op'] });
                break;
            default:
                return invalid(`unknown op ${JSON.stringify(raw['op'])}`);
        }
        if (bytes > CSV_LIMITS.maxBatchBytes) return invalid('edit batch is over 8 MiB');
    }
    return { ok: true, value: ops };
}

/** Shape-check a rows request (snake_case wire fields or camelCase SDK fields). */
export function decodeCsvRowsRequest(value: Record<string, unknown>): CsvDecoded<CsvRowsRequest> {
    const start = value['start'];
    const count = value['count'];
    const columnStart = value['column_start'] ?? value['columnStart'];
    const columnCount = value['column_count'] ?? value['columnCount'];
    if (!isIndex(start) || !isIndex(count)) return invalid('rows needs start and count');
    if (count > CSV_LIMITS.maxRowsPerRequest) return invalid(`at most ${CSV_LIMITS.maxRowsPerRequest} rows per request`);
    if (columnStart !== undefined && !isIndex(columnStart)) return invalid('column_start must be an index');
    if (columnCount !== undefined && (!isIndex(columnCount) || columnCount > CSV_LIMITS.maxColumnsPerRequest)) {
        return invalid(`column_count must be at most ${CSV_LIMITS.maxColumnsPerRequest}`);
    }
    return {
        ok: true,
        value: {
            start,
            count,
            ...(columnStart !== undefined ? { columnStart } : {}),
            ...(columnCount !== undefined ? { columnCount } : {})
        }
    };
}

/** Shape-check a sort request: `column` null clears it. */
export function decodeCsvSort(value: Record<string, unknown>): CsvDecoded<{ column: number | null; direction: CsvSortDirection }> {
    const column = value['column'];
    const direction = value['direction'] ?? 'asc';
    if (column !== null && !isIndex(column)) return invalid('sort column must be a column id or null');
    if (direction !== 'asc' && direction !== 'desc') return invalid('sort direction must be asc or desc');
    return { ok: true, value: { column, direction } };
}

/** Shape-check a find query. An empty query is valid (it matches nothing). */
export function decodeCsvFindQuery(value: unknown): CsvDecoded<string> {
    if (typeof value !== 'string') return invalid('query must be a string');
    if (utf8Bytes(value) > CSV_LIMITS.maxFindQueryBytes) return invalid('query is over 1 KiB');
    return { ok: true, value };
}

/** Shape-check a find-step request. */
export function decodeCsvFindStep(value: Record<string, unknown>): CsvDecoded<{ query: string; direction: CsvFindDirection; from: { view: number; column: number } | null }> {
    const query = decodeCsvFindQuery(value['query']);
    if (!query.ok) return query;
    const direction = value['direction'] ?? 'next';
    if (direction !== 'next' && direction !== 'previous') return invalid('direction must be next or previous');
    const from = value['from'];
    if (from === undefined || from === null) return { ok: true, value: { query: query.value, direction, from: null } };
    if (!isRecord(from) || !isIndex(from['view']) || !isIndex(from['column'])) return invalid('from must be {view, column}');
    return { ok: true, value: { query: query.value, direction, from: { view: from['view'], column: from['column'] } } };
}
