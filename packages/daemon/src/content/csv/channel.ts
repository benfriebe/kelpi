/**
 * The seam between the csv document service and its callers (#324, docs/csv-pane.md): the WS
 * hub (`ws/sync.ts`), the plugin documents adapter (`plugins/documents.ts`), the content service
 * (raw-text hand-off) and boot (flush paths). Tests stub it.
 */

import type {
    CsvEditOp,
    CsvFindDirection,
    CsvFindReply,
    CsvFindStepReply,
    CsvPaneState,
    CsvRowsReply,
    CsvRowsRequest,
    CsvSortDirection
} from '@kelpi/protocol';

/**
 * The file a raw-text hand-off edits: the csv document's pinned real path and the inode it had
 * when the grid stood down. The content service reads and writes raw text there, never through
 * the pane's path, so a symlink retargeted after the grid opened cannot split the two.
 */
export interface CsvRawTarget {
    readonly realpath: string;
    readonly dev: number;
    readonly ino: number;
}

export interface CsvSubscription {
    readonly state: CsvPaneState;
    unsubscribe(): void;
}

export interface CsvChannel {
    /** Open (if needed) and stream this pane's state. The first state is in the result. */
    subscribe(paneID: string, listener: (state: CsvPaneState) => void): Promise<CsvSubscription>;
    /** The current state, opening the document if needed. */
    state(paneID: string): Promise<CsvPaneState>;
    /**
     * Rows in this pane's view order. `budgetBytes` defaults to `CSV_LIMITS.rowsReplyBudgetBytes`;
     * the plugin path passes the smaller plugin budget.
     */
    rows(paneID: string, request: CsvRowsRequest, budgetBytes?: number): Promise<CsvRowsReply>;
    /** Apply a validated batch in order. Rows are LOGICAL indices; columns are stable ids. */
    edit(paneID: string, generation: string, ops: readonly CsvEditOp[]): Promise<CsvPaneState>;
    /** Sort this pane's view (`column` null = file order). Resolves once the sort is applied. */
    sort(paneID: string, column: number | null, direction: CsvSortDirection): Promise<CsvPaneState>;
    /** Count matches; resolves when the search is complete. */
    find(paneID: string, query: string): Promise<CsvFindReply>;
    /** The next/previous match from a view position (or the first/last when `from` is null). */
    findStep(
        paneID: string,
        query: string,
        direction: CsvFindDirection,
        from: { view: number; column: number } | null
    ): Promise<CsvFindStepReply>;
    /** Persist this pane's header-row choice. */
    setHeaderRow(paneID: string, on: boolean): Promise<CsvPaneState>;
    /** Drop unsaved edits and reload from disk. */
    discard(paneID: string): Promise<CsvPaneState>;

    /**
     * Raw-text hand-off, called by `ContentService.setMode` BEFORE it dispatches
     * `set-markdown-editing`. Refuses (throws) above `CSV_LIMITS.rawEditLimitBytes` or when the
     * document is read-only; otherwise aborts any in-flight save, flushes edits, stops watching
     * and marks other panes on the same file read-only (`raw-elsewhere`). Resolves with the file
     * the raw text must be read from and written to.
     */
    prepareRaw(paneID: string): Promise<CsvRawTarget>;
    /** Called after the raw-text buffer is flushed and the pane is back in grid mode: reopen the same real path and rescan. */
    afterRaw(paneID: string): Promise<void>;

    /** SIGTERM: abort async saves and write everything synchronously. */
    flushSync(): void;
    /**
     * `flush-saves-request` (the shell's quit pre-flight, 750 ms budget): synchronous for files
     * under `CSV_LIMITS.largeFileBytes`, otherwise start the async save and return.
     */
    flushForQuit(): void;
    /**
     * Before a pane closes. Small files save synchronously (throws on failure, refusing the
     * close like markdown); large files keep saving in the background after the pane is gone.
     */
    prepareClose(paneID: string): void;
    /** Stop watchers and timers; used by boot shutdown after `flushSync`. */
    dispose(): Promise<void>;
}
