/** Source and save state of a native document on the plugin's owning daemon. */
export interface DocumentSnapshot {
    readonly paneID: string;
    readonly workspaceID: string;
    readonly kind: 'markdown' | 'scratchpad' | 'diff' | 'csv';
    readonly mode: 'view' | 'edit';
    readonly path: string | null;
    /**
     * The document source. A csv table's `text` is its raw source only in raw-text mode (`mode`
     * `'edit'`, ⌘E) and `''` otherwise; read rows through `documents.csv` instead.
     */
    readonly text: string;
    readonly loaded: boolean;
    readonly dirty: boolean;
    readonly error: string | null;
    /** Opaque token; changes and reopened documents invalidate retained edits. */
    readonly revision: string;
    /** A csv table's raw `text` was cut to fit the 256 KiB plugin JSON cap. Absent for other kinds. */
    readonly truncated?: boolean;
}

// ── csv tables (#324) ─────────────────────────────────────────────────────────────────
// These mirror Kelpi's protocol shapes so the SDK stays standalone. Rows come back in the pane's
// VIEW order (its sort, header row pinned first); edits address LOGICAL rows (file order, never
// changed by sorting or saving) and stable column ids, guarded by `generation`.

export type CsvDelimiter = ',' | ';' | '\t' | '|';
export type CsvLineEnding = '\n' | '\r\n';
export type CsvSortDirection = 'asc' | 'desc';
export type CsvFindDirection = 'next' | 'previous';

export interface CsvDialect {
    readonly delimiter: CsvDelimiter;
    readonly lineEnding: CsvLineEnding;
    /** A UTF-8 BOM opens the file and is written back on save. */
    readonly bom: boolean;
    /** Every field in the sample was quoted, so edited rows quote every field too. */
    readonly quoteAll: boolean;
}

export interface CsvSortState {
    /** Stable column id. */
    readonly column: number;
    readonly direction: CsvSortDirection;
    /** True while the daemon is still building the order; rows come back unsorted meanwhile. */
    readonly pending: boolean;
}

export interface CsvScanProgress {
    readonly rows: number;
    readonly bytes: number;
    readonly totalBytes: number;
}

export interface CsvReadOnly {
    readonly code: 'not-utf8' | 'utf16' | 'oversized-record' | 'raw-elsewhere' | 'not-regular';
    /** A sentence for a status line. */
    readonly message: string;
}

/** One csv pane's table state. */
export interface CsvPaneState {
    readonly paneID: string;
    /** Changes when the document is reopened: a reload, a reopen or a daemon restart. */
    readonly incarnation: string;
    /** Bumps on every visible change; drop a state older than the one you hold. */
    readonly revision: number;
    /** Bumps when logical row indices or the column set change. Pass it to `edit`. */
    readonly generation: string;
    readonly filePath: string | null;
    readonly loaded: boolean;
    /** Non-null while the file is being indexed. Edits, sort and find wait until it is null. */
    readonly scanning: CsvScanProgress | null;
    /** Logical rows, including the header row when there is one. */
    readonly rowCount: number;
    /** Stable column ids in display order. */
    readonly columns: readonly number[];
    readonly bytes: number;
    readonly dialect: CsvDialect | null;
    /** This pane treats logical row 0 as headers (sticky, excluded from sort). */
    readonly headerRow: boolean;
    readonly sort: CsvSortState | null;
    readonly dirty: boolean;
    readonly saving: boolean;
    readonly canUndo: boolean;
    readonly canRedo: boolean;
    /** Raw-text mode (`documents.setMode(..., 'edit')`) is available for this file. */
    readonly rawEditable: boolean;
    readonly readOnly: CsvReadOnly | null;
    readonly error: string | null;
    /** A one-off notice, e.g. unsaved edits discarded after an external rewrite. */
    readonly notice: string | null;
}

export interface CsvRow {
    /** Position in the pane's view order. */
    readonly view: number;
    /** Logical row (file order). Edits address this. */
    readonly row: number;
    /** Values for the requested column window, in display order. Missing fields are ''. */
    readonly cells: readonly string[];
    /** Indices into `cells` that were cut at 64 KiB (read-only in the grid). */
    readonly truncated?: readonly number[];
    /** Fields this row really has (a ragged row has fewer than `columns.length`). */
    readonly fieldCount: number;
}

export interface CsvRowsRequest {
    /** First view index. */
    readonly start: number;
    /** At most 500. */
    readonly count: number;
    /** First display column (default 0). */
    readonly columnStart?: number;
    /** At most 256 (the default). */
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
    /** Set when the reply's byte budget (200 KiB for plugins) stopped it early: ask again from here. */
    readonly nextStart: number | null;
}

/** One edit. Rows are logical indices; `column` is a stable column id; `at` for a column is a display index. */
export type CsvEditOp =
    | { readonly op: 'set-cell'; readonly row: number; readonly column: number; readonly value: string }
    | { readonly op: 'insert-rows'; readonly at: number; readonly count: number; readonly rows?: readonly (readonly string[])[] }
    | { readonly op: 'delete-rows'; readonly start: number; readonly count: number }
    | { readonly op: 'insert-column'; readonly at: number }
    | { readonly op: 'delete-column'; readonly column: number }
    | { readonly op: 'undo' }
    | { readonly op: 'redo' };

export interface CsvFindReply {
    readonly query: string;
    /** Matching cells. */
    readonly total: number;
    readonly complete: boolean;
    /** Stopped at 1,000,000 matches. */
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

/**
 * A csv table pane's rows and edits. Failures reject with a `KelpiError` whose `code` is one of
 * `CSV_STALE` (the generation is too old or from another incarnation: re-read and retry),
 * `CSV_GONE` (the row or column was deleted), `CSV_READ_ONLY`, `CSV_BUSY` (still indexing) or
 * `CSV_INVALID` (a malformed request or one over a limit).
 */
export interface CsvDocumentsAPI {
    /** The pane's table state (the current pane in a view or scoped command by default). */
    state(paneID?: string): Promise<CsvPaneState>;
    /** Rows in the pane's view order. */
    rows(paneID: string, request: CsvRowsRequest): Promise<CsvRowsReply>;
    /** Apply up to 1000 ops in order, computed against `generation`. Autosave writes them. */
    edit(paneID: string, generation: string, ops: readonly CsvEditOp[]): Promise<CsvPaneState>;
    /** Sort this pane's view by a stable column id, or `null` for file order. Never edits the file. */
    sort(paneID: string, column: number | null, direction?: CsvSortDirection): Promise<CsvPaneState>;
    /** Count the cells containing `query`; resolves when the search is complete. */
    find(paneID: string, query: string): Promise<CsvFindReply>;
    /** The next or previous match from a view position, or the first/last without one. */
    findStep(paneID: string, query: string, direction: CsvFindDirection, from?: { view: number; column: number } | null): Promise<CsvFindStepReply>;
    /** Treat logical row 0 as headers in this pane. Persisted per pane. */
    setHeaderRow(paneID: string, on: boolean): Promise<CsvPaneState>;
    /** Drop unsaved edits and reload the file from disk. */
    discard(paneID: string): Promise<CsvPaneState>;
}

export interface DocumentsAPI {
    get(paneID?: string): Promise<DocumentSnapshot>;
    edit(paneID: string, text: string, revision: string): Promise<DocumentSnapshot>;
    save(paneID: string, revision: string): Promise<DocumentSnapshot>;
    setMode(paneID: string, mode: 'view' | 'edit', revision: string): Promise<DocumentSnapshot>;
    refresh(paneID: string, revision: string): Promise<DocumentSnapshot>;
    /** Listen to documents.changed / documents.closed events before attaching. Changed is an invalidation; call get for latest state. */
    watch(paneID?: string): Promise<{ subscription: string; state: DocumentSnapshot }>;
    unwatch(subscription: string): Promise<void>;
    /** csv table panes (`kind: 'csv'`). */
    readonly csv: CsvDocumentsAPI;
}
/** Drafts belong to this browser window and document pane. Available only in document renderers. */
export interface ViewDocumentsAPI extends DocumentsAPI {
    /** Persist every input before queueing daemon edits, so a reloaded/failed view can recover it. */
    stage(text: string, revision: string): Promise<{ id: string }>;
    /** Apply an exact staged draft with an explicit revision. A newer stage rejects a superseded ID. */
    applyDraft(id: string, revision: string): Promise<DocumentSnapshot>;
}
