/**
 * One csv pane's client-side model: the row window cache, the fetch pump, the edit queue and
 * the optimistic cells (#324, docs/csv-pane.md, plan §5).
 *
 * A csv pane never holds its file. It holds the rows around the viewport, fetched in blocks of
 * `CSV_ROW_BLOCK` rows by `CSV_COLUMN_BLOCK` columns, and everything here is about keeping that
 * window honest and cheap:
 *
 *   - **The cache key** is `(incarnation, generation, sort, header row)`. A change to any of them
 *     means the view order or the logical row numbering moved, so every cached row is suspect.
 *     A plain revision bump (an edit, a save, an external change) is suspect too. Either way the
 *     cache is invalidated by bumping an `epoch`: blocks OUTSIDE the viewport are dropped, blocks
 *     inside it keep painting their old rows until the refetch replaces them (no flash of empty
 *     cells), and only the visible window is fetched again.
 *   - **Scan progress is not a change.** While the daemon is still indexing it pushes a state
 *     every 200 ms with a larger `rowCount`; rows already read cannot change during a scan (edits
 *     wait for it), so only blocks that reached past the old row count are refetched.
 *   - **Fetches are coalesced**: at most `CSV_MAX_IN_FLIGHT` requests at a time, chosen from the
 *     blocks the viewport still wants, so a fast scroll does not queue a request for every block
 *     it passed. A reply cut short by the daemon's byte budget (`nextStart`) continues from there.
 *   - **Edits** address logical rows and stable column ids. A cell edit is shown at once
 *     (optimistic) and stays shown until a block fetched at or after the revision that acked it
 *     has arrived. Exactly ONE batch is in flight; the rest queue in order. Each batch carries the
 *     generation of the rows the user was looking at when they made it, so the daemon translates
 *     it forward through any structural edit that landed in between. `CSV_GONE` (the row or
 *     column was deleted meanwhile) drops the edit with a notice; `CSV_STALE` (too old to
 *     translate) drops it, refetches and says so.
 *   - **A lost answer is not a refusal.** When the socket drops or the reply times out, nobody
 *     knows whether the batch applied. A batch of cell values is safe to send twice, so it goes
 *     back to the head of the queue and is sent again once the connection is up. A structural
 *     batch (an insert would insert twice) is not resent: the pane says the change could not be
 *     confirmed and refetches what the daemon has.
 *   - **Leaving owes the daemon the queue.** `flush()` commits the cell being typed (through the
 *     grid's hook) and resolves once nothing is queued, in flight or still resolving its rows.
 *     ⌘E to raw text and closing the pane wait on it (`flushCsvPane`), because the daemon refuses
 *     a grid edit once the pane shows raw text or is gone. A batch that still fails after its
 *     grid has gone is reported through `CsvApi.reportFailure` (the window's toast).
 */

import { CSV_LIMITS, csvErrorCode } from '@kelpi/protocol';

import { CommandDisconnectedError, CommandTimeoutError } from '../../connection';
import type { CsvApi, CsvSubscription } from './csv-client';
import type {
    CsvEditOp,
    CsvFindDirection,
    CsvFindReply,
    CsvFindStepReply,
    CsvPaneState,
    CsvRow,
    CsvSortDirection
} from './types';

export const CSV_ROW_BLOCK = 100;
export const CSV_COLUMN_BLOCK = 64;
export const CSV_MAX_IN_FLIGHT = 2;
export const CSV_MAX_CACHED_BLOCKS = 120;
/** How long a one-off notice stays in the status line. */
export const CSV_NOTICE_MS = 6000;
/** Sends of one cell batch whose answer keeps getting lost before it is reported unconfirmed. */
export const CSV_EDIT_MAX_ATTEMPTS = 3;
/** Re-resolves of a paste whose rows keep moving under it before it gives up. */
const CSV_RESOLVE_ATTEMPTS = 3;

/** A half-open window of view rows and display columns. */
export interface CsvViewport {
    readonly rowStart: number;
    readonly rowEnd: number;
    readonly colStart: number;
    readonly colEnd: number;
    /** Rows wanted wherever the viewport is (the sticky header row, view 0). */
    readonly pinnedRows?: readonly number[] | undefined;
}

export interface CsvCellView {
    readonly value: string;
    /** The row this cell belongs to has arrived (a pending block paints empty, not stale). */
    readonly loaded: boolean;
    /** Logical row (file order), the address an edit uses; null until loaded. */
    readonly row: number | null;
    /** Stable column id; null when the column window has not arrived. */
    readonly column: number | null;
    /** Cut at `CSV_LIMITS.truncatedCellBytes`, so read-only here. */
    readonly truncated: boolean;
    /** Showing an edit the daemon has not confirmed yet. */
    readonly pending: boolean;
    /** The generation of the rows this cell came from: what an edit of it is computed against. */
    readonly generation: string;
}

export interface CsvCellEdit {
    readonly row: number;
    readonly column: number;
    readonly value: string;
}

/** Logical rows for a run of view rows, and the ONE generation they are numbered in. */
export interface CsvResolvedRows {
    readonly rows: readonly number[];
    readonly generation: string;
}

export interface CsvPaneModelOptions {
    readonly notice?: ((message: string) => void) | undefined;
    /** Test seam for the notice timer. */
    readonly noticeMs?: number | undefined;
}

export interface CsvPaneModel {
    readonly paneID: string;
    subscribe(listener: () => void): () => void;
    /** Bumps on every change a render could show. */
    getVersion(): number;
    state(): CsvPaneState | null;
    /** The last transport failure (subscribe, rows), cleared by the next good state. */
    error(): string | null;
    notice(): string | null;
    /** The edit batches not yet acknowledged (in flight + queued). */
    pendingEdits(): number;
    cell(view: number, column: number): CsvCellView;
    /** The logical row behind a view row, when it is in the cache. */
    rowAt(view: number): number | null;
    /** Where a logical row sits in the current view order, when it is in the cache. */
    viewOfRow(row: number): number | null;
    /** The generation of the rows on screen (the newest fresh block's, else the state's). */
    displayGeneration(): string;
    setViewport(viewport: CsvViewport): void;
    setCells(edits: readonly CsvCellEdit[], generation: string): void;
    structural(op: CsvEditOp, generation: string): void;
    undo(): void;
    redo(): void;
    sort(column: number | null, direction: CsvSortDirection): Promise<void>;
    setHeaderRow(on: boolean): Promise<void>;
    discard(): Promise<void>;
    find(query: string): Promise<CsvFindReply | null>;
    findStep(query: string, direction: CsvFindDirection, from: { view: number; column: number } | null): Promise<CsvFindStepReply | null>;
    /**
     * Logical rows for a run of view rows (a large paste), all numbered in one generation: from
     * this epoch's cache where it agrees, otherwise the whole run from the daemon. Rejects when
     * the rows keep moving under it.
     */
    resolveRows(viewStart: number, count: number): Promise<CsvResolvedRows>;
    /**
     * A paste: resolve the rows, then send what `build` makes of them under the generation they
     * were resolved in. Counted by `flush`. Resolves false when nothing was sent.
     */
    pasteRows(viewStart: number, count: number, build: (rows: readonly number[]) => readonly CsvCellEdit[]): Promise<boolean>;
    /** The grid's "commit the cell being typed", for `flush`. Returns its release. */
    setCommitHook(hook: () => void): () => void;
    /** Commit the open cell edit, then resolve once no batch is queued, in flight or resolving. */
    flush(): Promise<void>;
    showNotice(message: string): void;
    dispose(): void;
}

/**
 * Every model that still owes its daemon edits, by pane: the mounted grid's, and a disposed one
 * whose queue is still draining. ⌘E and the close guard reach them through `flushCsvPane`.
 */
const owing = new Map<string, Set<CsvPaneModel>>();

/** Wait until every grid of the pane has sent (and heard back about) the edits made in it. */
export function flushCsvPane(paneID: string): Promise<void> {
    const models = [...(owing.get(paneID) ?? [])];
    if (models.length === 0) return Promise.resolve();
    return Promise.all(models.map((model) => model.flush())).then(() => undefined);
}

/** Whether any model of the pane is mounted or still draining (the close guard's filter). */
export function csvPaneHasModel(paneID: string): boolean {
    return (owing.get(paneID)?.size ?? 0) > 0;
}

/** A reply that never came: nobody knows whether the daemon applied the batch. */
function answerLost(error: unknown): boolean {
    return error instanceof CommandDisconnectedError || error instanceof CommandTimeoutError;
}

interface Block {
    readonly rowStart: number;
    readonly colBlock: number;
    /** The epoch its rows were fetched in; another epoch's rows are stale but still painted. */
    epoch: number;
    rows: Map<number, CsvRow>;
    columnIDs: readonly number[];
    colStart: number;
    revision: number;
    generation: string;
    /** Next view row to fetch inside this block when a reply was cut short. */
    filledTo: number;
    complete: boolean;
    loading: boolean;
    failedEpoch: number;
    lastUsed: number;
}

interface OptimisticCell {
    value: string;
    readonly batch: number;
    ackRevision: number | null;
}

interface Batch {
    readonly id: number;
    readonly ops: readonly CsvEditOp[];
    readonly generation: string;
    readonly keys: readonly string[];
    /** Sends so far whose answer was lost (a cell batch is resent, up to a limit). */
    readonly attempts: number;
}

const EMPTY_CELL: CsvCellView = {
    value: '',
    loaded: false,
    row: null,
    column: null,
    truncated: false,
    pending: false,
    generation: ''
};

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** The sentence after a `CSV_X:` code, for the status line. */
export function csvErrorSentence(message: string): string {
    const code = csvErrorCode(message);
    return code === null ? message : message.slice(code.length + 1).trim();
}

/** What makes cached rows wrong wholesale: their order, their numbering, their incarnation. */
export function csvCacheKey(state: CsvPaneState): string {
    const sort = state.sort === null ? '-' : `${state.sort.column}:${state.sort.direction}:${state.sort.pending ? 1 : 0}`;
    return `${state.incarnation}|${state.generation}|${sort}|${state.headerRow ? 1 : 0}`;
}

const blockKey = (rowBlock: number, colBlock: number): string => `${rowBlock}:${colBlock}`;
const cellKey = (row: number, column: number): string => `${row}:${column}`;

function utf8Length(value: string): number {
    let bytes = 0;
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code < 0x80) bytes += 1;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff) {
            bytes += 4;
            index++;
        } else bytes += 3;
    }
    return bytes;
}

export function createCsvPaneModel(api: CsvApi, paneID: string, options: CsvPaneModelOptions = {}): CsvPaneModel {
    const listeners = new Set<() => void>();
    const blocks = new Map<string, Block>();
    const optimistic = new Map<string, OptimisticCell>();
    const queue: Batch[] = [];
    let current: CsvPaneState | null = null;
    let version = 0;
    let epoch = 0;
    let inFlight = 0;
    let inFlightBatch: Batch | null = null;
    let nextBatchID = 1;
    let viewport: CsvViewport = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 };
    let transportError: string | null = null;
    let notice: string | null = null;
    let noticeTimer: ReturnType<typeof setTimeout> | null = null;
    let clock = 0;
    let disposed = false;
    /** Pastes still resolving their rows: edits the user made that are not queued yet. */
    let resolving = 0;
    /** A cell batch whose answer was lost is back at the head of the queue, waiting for the socket. */
    let awaitingConnection = false;
    let idleWaiters: (() => void)[] = [];
    let commitHook: (() => void) | null = null;
    const noticeMs = options.noticeMs ?? CSV_NOTICE_MS;

    const bump = (): void => {
        version++;
        for (const listener of [...listeners]) listener();
    };

    const showNotice = (message: string): void => {
        if (disposed) return;
        notice = message;
        options.notice?.(message);
        if (noticeTimer !== null) clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => {
            noticeTimer = null;
            notice = null;
            bump();
        }, noticeMs);
        bump();
    };

    /** The blocks the viewport covers, top-left first. */
    const wantedBlocks = (): { rowBlock: number; colBlock: number }[] => {
        const state = current;
        if (state === null) return [];
        const rowEnd = Math.min(viewport.rowEnd, state.rowCount);
        const colEnd = Math.min(viewport.colEnd, state.columns.length);
        if (rowEnd <= viewport.rowStart || colEnd <= viewport.colStart) return [];
        const wanted: { rowBlock: number; colBlock: number }[] = [];
        const firstRow = Math.floor(Math.max(0, viewport.rowStart) / CSV_ROW_BLOCK);
        const lastRow = Math.floor((rowEnd - 1) / CSV_ROW_BLOCK);
        const firstCol = Math.floor(Math.max(0, viewport.colStart) / CSV_COLUMN_BLOCK);
        const lastCol = Math.floor((colEnd - 1) / CSV_COLUMN_BLOCK);
        const rowBlocks: number[] = [];
        for (const pinned of viewport.pinnedRows ?? []) {
            if (pinned < 0 || pinned >= state.rowCount) continue;
            const rowBlock = Math.floor(pinned / CSV_ROW_BLOCK);
            if (!rowBlocks.includes(rowBlock)) rowBlocks.push(rowBlock);
        }
        for (let rowBlock = firstRow; rowBlock <= lastRow; rowBlock++) {
            if (!rowBlocks.includes(rowBlock)) rowBlocks.push(rowBlock);
        }
        for (const rowBlock of rowBlocks) {
            for (let colBlock = firstCol; colBlock <= lastCol; colBlock++) wanted.push({ rowBlock, colBlock });
        }
        return wanted;
    };

    const blockFor = (rowBlock: number, colBlock: number): Block => {
        const key = blockKey(rowBlock, colBlock);
        const existing = blocks.get(key);
        if (existing !== undefined) return existing;
        const created: Block = {
            rowStart: rowBlock * CSV_ROW_BLOCK,
            colBlock,
            epoch: -1,
            rows: new Map(),
            columnIDs: [],
            colStart: colBlock * CSV_COLUMN_BLOCK,
            revision: -1,
            generation: '',
            filledTo: rowBlock * CSV_ROW_BLOCK,
            complete: false,
            loading: false,
            failedEpoch: -1,
            lastUsed: 0
        };
        blocks.set(key, created);
        return created;
    };

    const isFresh = (block: Block): boolean => block.epoch === epoch && block.complete;

    /** Drop acked optimistic cells once every block on screen is at least as new as the ack. */
    const settleOptimistic = (): void => {
        if (optimistic.size === 0) return;
        let floor = Number.POSITIVE_INFINITY;
        for (const { rowBlock, colBlock } of wantedBlocks()) {
            const block = blocks.get(blockKey(rowBlock, colBlock));
            if (block === undefined || !isFresh(block)) return;
            floor = Math.min(floor, block.revision);
        }
        for (const [key, entry] of optimistic) {
            if (entry.ackRevision !== null && entry.ackRevision <= floor) optimistic.delete(key);
        }
    };

    const evict = (): void => {
        if (blocks.size <= CSV_MAX_CACHED_BLOCKS) return;
        const keep = new Set(wantedBlocks().map(({ rowBlock, colBlock }) => blockKey(rowBlock, colBlock)));
        const candidates = [...blocks.entries()]
            .filter(([key, block]) => !keep.has(key) && !block.loading)
            .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
        for (const [key] of candidates) {
            if (blocks.size <= CSV_MAX_CACHED_BLOCKS) break;
            blocks.delete(key);
        }
    };

    const fetchBlock = (block: Block): void => {
        const state = current;
        if (state === null) return;
        const end = Math.min(block.rowStart + CSV_ROW_BLOCK, state.rowCount);
        const continuing = block.epoch === epoch && !block.complete && block.filledTo > block.rowStart;
        const start = continuing ? block.filledTo : block.rowStart;
        const columnStart = block.colBlock * CSV_COLUMN_BLOCK;
        const columnCount = Math.min(CSV_COLUMN_BLOCK, state.columns.length - columnStart);
        if (end <= start || columnCount <= 0) {
            block.epoch = epoch;
            block.complete = true;
            return;
        }
        const sentEpoch = epoch;
        block.loading = true;
        inFlight++;
        api.rows(paneID, { start, count: Math.min(end - start, CSV_LIMITS.maxRowsPerRequest), columnStart, columnCount }).then(
            (reply) => {
                inFlight--;
                block.loading = false;
                if (disposed) return;
                if (sentEpoch !== epoch) {
                    pump();
                    return;
                }
                transportError = null;
                // The first reply of an epoch replaces what the block painted; a continuation adds.
                if (block.epoch !== epoch) {
                    block.rows = new Map();
                    block.epoch = epoch;
                }
                for (const row of reply.rows) block.rows.set(row.view, row);
                block.columnIDs = reply.columnIDs;
                block.colStart = reply.columnStart;
                block.revision = reply.revision;
                block.generation = reply.generation;
                const next = reply.nextStart;
                if (next !== null && next > start && next < end) {
                    block.filledTo = next;
                    block.complete = false;
                } else {
                    block.filledTo = end;
                    block.complete = true;
                }
                settleOptimistic();
                bump();
                pump();
            },
            (error: unknown) => {
                inFlight--;
                block.loading = false;
                if (disposed) return;
                if (sentEpoch === epoch) {
                    block.failedEpoch = epoch;
                    transportError = csvErrorSentence(messageOf(error));
                    bump();
                }
                pump();
            }
        );
    };

    const pump = (): void => {
        if (disposed || current === null) return;
        for (const { rowBlock, colBlock } of wantedBlocks()) {
            if (inFlight >= CSV_MAX_IN_FLIGHT) break;
            const block = blockFor(rowBlock, colBlock);
            block.lastUsed = ++clock;
            if (block.loading || isFresh(block) || block.failedEpoch === epoch) continue;
            fetchBlock(block);
        }
        evict();
    };

    /** Everything cached is suspect: keep painting what is on screen, refetch only that. */
    const invalidate = (): void => {
        epoch++;
        const keep = new Set(wantedBlocks().map(({ rowBlock, colBlock }) => blockKey(rowBlock, colBlock)));
        for (const key of [...blocks.keys()]) {
            if (!keep.has(key)) blocks.delete(key);
        }
        pump();
    };

    /** A scan grew the file: only the blocks that reached past the old end are short. */
    const extendTail = (previousRowCount: number): void => {
        for (const block of blocks.values()) {
            if (block.rowStart + CSV_ROW_BLOCK > previousRowCount && block.complete) {
                block.complete = false;
                block.filledTo = Math.max(block.rowStart, Math.min(block.filledTo, previousRowCount));
            }
        }
        pump();
    };

    const onState = (next: CsvPaneState): void => {
        if (disposed) return;
        const previous = current;
        current = next;
        transportError = null;
        if (previous === null || csvCacheKey(previous) !== csvCacheKey(next)) {
            invalidate();
        } else if (previous.revision !== next.revision) {
            // A scan only appends rows - unless it met a wider row, which adds columns to every
            // row already served (their missing fields read as empty), so those are refetched.
            if (previous.scanning !== null && next.columns.length === previous.columns.length) {
                if (next.rowCount !== previous.rowCount) extendTail(previous.rowCount);
            } else {
                invalidate();
            }
        }
        bump();
    };

    const idle = (): boolean => queue.length === 0 && inFlightBatch === null && !awaitingConnection && resolving === 0;

    /** Wake `flush` callers once nothing is owed; a disposed model then leaves the registry. */
    const settleIdle = (): void => {
        if (!idle()) return;
        const waiters = idleWaiters;
        idleWaiters = [];
        for (const resolve of waiters) resolve();
        if (disposed) {
            const set = owing.get(paneID);
            set?.delete(model);
            if (set?.size === 0) owing.delete(paneID);
        }
    };

    const dropOptimistic = (batch: Batch): void => {
        for (const key of batch.keys) {
            const entry = optimistic.get(key);
            if (entry !== undefined && entry.batch === batch.id) optimistic.delete(key);
        }
    };

    /**
     * The socket dropped or the reply timed out with `batch` in flight: it may or may not have
     * applied. Cell values are idempotent, so that batch goes again, first in line, once the
     * connection is up. A structural batch is not (an insert would insert twice): the pane says
     * the change could not be confirmed and refetches the table as the daemon has it.
     */
    const answerLostFor = (batch: Batch): void => {
        const cellsOnly = batch.ops.every((op) => op.op === 'set-cell');
        if (cellsOnly && batch.attempts + 1 < CSV_EDIT_MAX_ATTEMPTS) {
            queue.unshift({ ...batch, attempts: batch.attempts + 1 });
            awaitingConnection = true;
            void api.connected().then(() => {
                awaitingConnection = false;
                drain();
            });
            if (!disposed) bump();
            return;
        }
        dropOptimistic(batch);
        const message = cellsOnly
            ? 'The connection kept dropping before the table confirmed an edit, so it may not have been saved.'
            : 'The connection dropped before the table confirmed that change. Showing the table as it is now.';
        if (disposed) {
            api.reportFailure(paneID, message);
        } else {
            showNotice(message);
            void api.connected().then(() => {
                if (!disposed) invalidate();
            });
            bump();
        }
        drain();
    };

    /**
     * Not stopped by `dispose`: a pane leaving the screen (⌘E to raw text, a workspace switch)
     * still owes the daemon the edits the user already made, so the queue keeps draining and only
     * the UI side effects stop.
     */
    const drain = (): void => {
        if (inFlightBatch !== null || awaitingConnection) return;
        const batch = queue.shift();
        if (batch === undefined) {
            settleIdle();
            return;
        }
        inFlightBatch = batch;
        api.edit(paneID, batch.generation, batch.ops).then(
            (state) => {
                inFlightBatch = null;
                if (!disposed) {
                    for (const key of batch.keys) {
                        const entry = optimistic.get(key);
                        if (entry !== undefined && entry.batch === batch.id) entry.ackRevision = state.revision;
                    }
                    settleOptimistic();
                    bump();
                }
                drain();
            },
            (error: unknown) => {
                inFlightBatch = null;
                if (answerLost(error)) {
                    answerLostFor(batch);
                    return;
                }
                const message = messageOf(error);
                if (disposed) {
                    // Nobody is looking at this grid any more (⌘E or a close raced the queue, or
                    // another client switched the pane to raw text): the window says so.
                    api.reportFailure(paneID, `An edit made in the table was not saved. ${csvErrorSentence(message)}`);
                    drain();
                    return;
                }
                dropOptimistic(batch);
                // The daemon's sentence says what happened ("The row or column this edit targets
                // was deleted."); the notice adds what that meant for the edit.
                const code = csvErrorCode(message);
                const sentence = csvErrorSentence(message);
                if (code === 'CSV_GONE') {
                    showNotice(`${sentence || 'That row or column was deleted.'} The edit was dropped.`);
                } else if (code === 'CSV_STALE') {
                    showNotice(`${sentence || 'The table changed before the edit arrived.'} The edit was dropped.`);
                    invalidate();
                } else {
                    showNotice(sentence);
                }
                bump();
                drain();
            }
        );
        bump();
    };

    const enqueue = (ops: readonly CsvEditOp[], generation: string): void => {
        if (ops.length === 0) return;
        queue.push({ id: nextBatchID++, ops, generation, keys: [], attempts: 0 });
        drain();
        bump();
    };

    /**
     * Queue cell values as batches. One batch where the limits allow it; a paste bigger than one
     * batch goes as several, in order, through the same one-in-flight queue. Half the byte cap
     * leaves room for the JSON around the values.
     */
    const queueCells = (edits: readonly CsvCellEdit[], generation: string): void => {
        if (edits.length === 0) return;
        const chunks: CsvCellEdit[][] = [];
        let chunk: CsvCellEdit[] = [];
        let bytes = 0;
        for (const edit of edits) {
            const size = utf8Length(edit.value) + 64;
            if (chunk.length > 0 && (chunk.length >= CSV_LIMITS.maxOpsPerBatch || bytes + size > CSV_LIMITS.maxBatchBytes / 2)) {
                chunks.push(chunk);
                chunk = [];
                bytes = 0;
            }
            chunk.push(edit);
            bytes += size;
        }
        if (chunk.length > 0) chunks.push(chunk);
        for (const part of chunks) {
            const id = nextBatchID++;
            const keys = part.map((edit) => {
                const key = cellKey(edit.row, edit.column);
                optimistic.set(key, { value: edit.value, batch: id, ackRevision: null });
                return key;
            });
            const ops: CsvEditOp[] = part.map((edit) => ({ op: 'set-cell', row: edit.row, column: edit.column, value: edit.value }));
            queue.push({ id, ops, generation, keys, attempts: 0 });
        }
        drain();
        if (!disposed) bump();
    };

    /** A view row's logical row and generation, from a block fetched in THIS epoch only. */
    const freshRow = (view: number): { row: number; generation: string } | null => {
        const rowStart = Math.floor(view / CSV_ROW_BLOCK) * CSV_ROW_BLOCK;
        for (const block of blocks.values()) {
            if (block.rowStart !== rowStart || block.epoch !== epoch || block.generation === '') continue;
            const row = block.rows.get(view);
            if (row !== undefined) return { row: row.row, generation: block.generation };
        }
        return null;
    };

    /**
     * One pass of `resolveRows`. `'moved'` when two sources disagree on the generation (a
     * structural edit landed between them), which the caller answers by asking the daemon for
     * the whole run again.
     */
    const resolveOnce = async (viewStart: number, count: number, useCache: boolean): Promise<CsvResolvedRows | 'moved'> => {
        const rows: number[] = [];
        let generation: string | null = null;
        let view = viewStart;
        const end = viewStart + count;
        while (view < end) {
            const cached = useCache ? freshRow(view) : null;
            if (cached !== null) {
                if (generation !== null && cached.generation !== generation) return 'moved';
                generation = cached.generation;
                rows.push(cached.row);
                view++;
                continue;
            }
            const reply = await api.rows(paneID, {
                start: view,
                count: Math.min(end - view, CSV_LIMITS.maxRowsPerRequest),
                columnStart: 0,
                columnCount: 1
            });
            if (generation !== null && reply.generation !== generation) return 'moved';
            generation = reply.generation;
            let advanced = false;
            for (const row of reply.rows) {
                if (row.view !== view) continue;
                rows.push(row.row);
                view++;
                advanced = true;
            }
            // Past the end of the table (or a reply that did not start where it was asked).
            if (!advanced) break;
        }
        return { rows, generation: generation ?? current?.generation ?? '' };
    };

    const subscription: CsvSubscription = api.subscribe(paneID, {
        onState,
        onError: (message) => {
            if (disposed) return;
            transportError = csvErrorSentence(message);
            bump();
        },
        onNotice: showNotice
    });

    const model: CsvPaneModel = {
        paneID,
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        getVersion: () => version,
        state: () => current,
        error: () => transportError,
        notice: () => notice,
        pendingEdits: () => queue.length + (inFlightBatch === null ? 0 : 1),

        cell(view, column) {
            const block = blocks.get(blockKey(Math.floor(view / CSV_ROW_BLOCK), Math.floor(column / CSV_COLUMN_BLOCK)));
            const row = block?.rows.get(view);
            if (block === undefined || row === undefined) return EMPTY_CELL;
            const index = column - block.colStart;
            const columnID = block.columnIDs[index] ?? current?.columns[column] ?? null;
            let value = row.cells[index] ?? '';
            let pending = false;
            if (columnID !== null) {
                const entry = optimistic.get(cellKey(row.row, columnID));
                if (entry !== undefined && (entry.ackRevision === null || block.revision < entry.ackRevision)) {
                    value = entry.value;
                    pending = true;
                }
            }
            return {
                value,
                loaded: true,
                row: row.row,
                column: columnID,
                truncated: row.truncated?.includes(index) === true && !pending,
                pending,
                generation: block.generation
            };
        },

        rowAt(view) {
            const rowBlock = Math.floor(view / CSV_ROW_BLOCK);
            for (const [key, block] of blocks) {
                if (!key.startsWith(`${rowBlock}:`)) continue;
                const row = block.rows.get(view);
                if (row !== undefined) return row.row;
            }
            return null;
        },

        viewOfRow(row) {
            for (const block of blocks.values()) {
                if (block.epoch !== epoch) continue;
                for (const entry of block.rows.values()) {
                    if (entry.row === row) return entry.view;
                }
            }
            return null;
        },

        displayGeneration() {
            let best: Block | null = null;
            for (const block of blocks.values()) {
                if (block.generation === '' || block.epoch !== epoch) continue;
                if (best === null || block.revision > best.revision) best = block;
            }
            return best?.generation ?? current?.generation ?? '';
        },

        setViewport(next) {
            if (
                next.rowStart === viewport.rowStart &&
                next.rowEnd === viewport.rowEnd &&
                next.colStart === viewport.colStart &&
                next.colEnd === viewport.colEnd &&
                (next.pinnedRows ?? []).join(',') === (viewport.pinnedRows ?? []).join(',')
            ) {
                return;
            }
            viewport = next;
            pump();
        },

        setCells(edits, generation) {
            if (disposed) return;
            queueCells(edits, generation);
        },

        structural(op, generation) {
            if (disposed) return;
            enqueue([op], generation);
        },

        undo() {
            if (disposed) return;
            enqueue([{ op: 'undo' }], current?.generation ?? '');
        },

        redo() {
            if (disposed) return;
            enqueue([{ op: 'redo' }], current?.generation ?? '');
        },

        sort(column, direction) {
            return api.sort(paneID, column, direction).then(
                () => undefined,
                (error: unknown) => showNotice(csvErrorSentence(messageOf(error)))
            );
        },

        setHeaderRow(on) {
            return api.setHeaderRow(paneID, on).then(
                () => undefined,
                (error: unknown) => showNotice(csvErrorSentence(messageOf(error)))
            );
        },

        discard() {
            return api.discard(paneID).then(
                () => undefined,
                (error: unknown) => showNotice(csvErrorSentence(messageOf(error)))
            );
        },

        find(query) {
            return api.find(paneID, query).catch((error: unknown) => {
                showNotice(csvErrorSentence(messageOf(error)));
                return null;
            });
        },

        findStep(query, direction, from) {
            return api.findStep(paneID, query, direction, from).catch((error: unknown) => {
                showNotice(csvErrorSentence(messageOf(error)));
                return null;
            });
        },

        async resolveRows(viewStart, count) {
            // The cache only where it is this epoch's; any disagreement on the generation (a
            // structural edit landed between two reads) and the whole run comes from the daemon.
            let resolved = await resolveOnce(viewStart, count, true);
            for (let attempt = 1; resolved === 'moved'; attempt++) {
                if (attempt >= CSV_RESOLVE_ATTEMPTS) throw new Error('The table kept changing while the paste was placed. Paste again.');
                resolved = await resolveOnce(viewStart, count, false);
            }
            return resolved;
        },

        async pasteRows(viewStart, count, build) {
            if (disposed) return false;
            resolving++;
            try {
                const resolved = await model.resolveRows(viewStart, count);
                const edits = build(resolved.rows);
                // Sent even if the grid left meanwhile: the paste is an edit the user made.
                queueCells(edits, resolved.generation);
                return edits.length > 0;
            } catch (error) {
                showNotice(csvErrorSentence(messageOf(error)));
                return false;
            } finally {
                resolving--;
                settleIdle();
            }
        },

        setCommitHook(hook) {
            commitHook = hook;
            return () => {
                if (commitHook === hook) commitHook = null;
            };
        },

        flush() {
            commitHook?.();
            if (idle()) return Promise.resolve();
            return new Promise<void>((resolve) => {
                idleWaiters.push(resolve);
            });
        },

        showNotice,

        dispose() {
            if (disposed) return;
            disposed = true;
            commitHook = null;
            if (noticeTimer !== null) clearTimeout(noticeTimer);
            subscription.unsubscribe();
            listeners.clear();
            blocks.clear();
            optimistic.clear();
            settleIdle();
        }
    };
    const set = owing.get(paneID) ?? new Set<CsvPaneModel>();
    set.add(model);
    owing.set(paneID, set);
    return model;
}
