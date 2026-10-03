/**
 * Test doubles for the csv pane: an in-memory daemon behind the `CsvApi` seam, and a state
 * builder. Exported for the same reason `content/testing.ts` is - the grid, the pane and the
 * App-level routing tests all need a table without a socket.
 *
 * The fake is a small but honest csv document: logical rows (file order) with stable column
 * ids, a view order (sort, header row pinned), structural edits that bump the generation, an
 * undo stack, find over view order, and the same row/column windowing the daemon serves. Edit
 * replies can be HELD so a test can see what is in flight.
 */

import type { CsvApi, CsvListener, CsvSubscription } from './csv-client';
import type {
    CsvEditOp,
    CsvFindReply,
    CsvFindStepReply,
    CsvPaneState,
    CsvRow,
    CsvRowsReply,
    CsvRowsRequest,
    CsvSortDirection
} from './types';

/** A csv state with sane defaults; override only what a test is about. */
export function csvState(overrides: Partial<CsvPaneState> & { paneID: string }): CsvPaneState {
    return {
        incarnation: 'inc-1',
        revision: 1,
        generation: 'inc-1:0',
        filePath: '/repo/data.csv',
        loaded: true,
        scanning: null,
        rowCount: 0,
        columns: [],
        bytes: 100,
        dialect: { delimiter: ',', lineEnding: '\n', bom: false, quoteAll: false },
        headerRow: true,
        sort: null,
        dirty: false,
        saving: false,
        canUndo: false,
        canRedo: false,
        rawEditable: true,
        readOnly: null,
        error: null,
        notice: null,
        ...overrides
    };
}

export interface SentEdit {
    readonly paneID: string;
    readonly generation: string;
    readonly ops: readonly CsvEditOp[];
}

export interface HeldEdit extends SentEdit {
    resolve(): void;
    reject(message: string): void;
}

export interface FakeCsvApi extends CsvApi {
    /** Logical rows; row 0 is the header row when `headerRow` is on. */
    table: string[][];
    columnIDs: number[];
    readonly subscribes: string[];
    readonly unsubscribes: string[];
    readonly rowRequests: (CsvRowsRequest & { readonly paneID: string })[];
    readonly edits: SentEdit[];
    readonly sorts: { paneID: string; column: number | null; direction: CsvSortDirection }[];
    readonly finds: string[];
    readonly steps: { query: string; direction: string; from: { view: number; column: number } | null }[];
    readonly headerRows: boolean[];
    readonly notices: string[];
    /** Hold `csv-edit` replies until a test releases them. */
    holdEdits: boolean;
    readonly held: HeldEdit[];
    /** Answer `csv-rows` only when the test calls `releaseRows` (fetch coalescing tests). */
    holdRows: boolean;
    releaseRows(): Promise<void>;
    /** Fail the next edit with this message (e.g. `CSV_GONE: …`), or this very error (a lost answer). */
    failNextEdit: string | Error | null;
    /**
     * The pane shows raw text (the daemon's `isEditing`): every edit is refused with
     * `CSV_READ_ONLY`, exactly as the daemon refuses a grid edit then.
     */
    rawMode: boolean;
    /** Whether `connected()` resolves at once; `goOnline` releases the waiters. */
    online: boolean;
    goOnline(): Promise<void>;
    /** What `reportFailure` was handed (the window's toast). */
    readonly failures: string[];
    /**
     * Apply ops as another client would, WITHOUT pushing the new state yet: the `csv-updated` is
     * still on its way, so the pane's cache is the old generation while the daemon is the new one.
     */
    applySilently(ops: readonly CsvEditOp[]): void;
    /** Cut every `csv-rows` reply at this many rows and answer `nextStart`, as the byte budget does. */
    maxRowsPerReply: number | null;
    /** Send cells longer than this cut and marked `truncated`, as the daemon does past 64 KiB. */
    truncateAt: number | null;
    /** Overrides applied to every state (read-only, scanning, sizes…). */
    overrides: Partial<CsvPaneState>;
    state(paneID: string): CsvPaneState;
    /** Push the current state to the pane's listeners (a `csv-updated`). */
    push(paneID: string): void;
    listenerCount(paneID: string): number;
    /** Bump the revision without changing anything (an external save, a scan tick). */
    touch(): void;
    settle(): Promise<void>;
}

interface Snapshot {
    readonly table: string[][];
    readonly columnIDs: number[];
}

export function createFakeCsvApi(rows: string[][] = [], options: { paneID?: string } = {}): FakeCsvApi {
    const listeners = new Map<string, Set<CsvListener>>();
    const subscribes: string[] = [];
    const unsubscribes: string[] = [];
    const rowRequests: (CsvRowsRequest & { paneID: string })[] = [];
    const edits: SentEdit[] = [];
    const sorts: { paneID: string; column: number | null; direction: CsvSortDirection }[] = [];
    const finds: string[] = [];
    const steps: { query: string; direction: string; from: { view: number; column: number } | null }[] = [];
    const headerRows: boolean[] = [];
    const notices: string[] = [];
    const held: HeldEdit[] = [];
    const heldRows: (() => void)[] = [];
    const failures: string[] = [];
    let connectWaiters: (() => void)[] = [];
    const undo: Snapshot[] = [];
    const redo: Snapshot[] = [];
    let revision = 1;
    let generationN = 0;
    let nextColumnID = 0;
    let sort: { column: number; direction: CsvSortDirection } | null = null;
    let headerRow = true;
    let dirty = false;
    void options;

    const fake: FakeCsvApi = {
        table: rows.map((row) => [...row]),
        columnIDs: [],
        subscribes,
        unsubscribes,
        rowRequests,
        edits,
        sorts,
        finds,
        steps,
        headerRows,
        notices,
        holdEdits: false,
        held,
        holdRows: false,
        async releaseRows() {
            for (const release of heldRows.splice(0)) release();
            await fake.settle();
        },
        failNextEdit: null,
        rawMode: false,
        online: true,
        async goOnline() {
            fake.online = true;
            const waiters = connectWaiters;
            connectWaiters = [];
            for (const resolve of waiters) resolve();
            await fake.settle();
        },
        failures,
        applySilently(ops) {
            applyOps(ops);
        },
        maxRowsPerReply: null,
        truncateAt: null,
        overrides: {},

        state(paneID) {
            return csvState({
                paneID,
                revision,
                generation: `inc-1:${generationN}`,
                rowCount: fake.table.length,
                columns: [...fake.columnIDs],
                headerRow,
                sort: sort === null ? null : { ...sort, pending: false },
                dirty,
                canUndo: undo.length > 0,
                canRedo: redo.length > 0,
                ...fake.overrides
            });
        },

        push(paneID) {
            const state = fake.state(paneID);
            for (const listener of [...(listeners.get(paneID) ?? [])]) listener.onState(state);
        },

        listenerCount(paneID) {
            return listeners.get(paneID)?.size ?? 0;
        },

        touch() {
            revision++;
        },

        async settle() {
            for (let index = 0; index < 8; index++) await Promise.resolve();
        },

        subscribe(paneID, listener): CsvSubscription {
            subscribes.push(paneID);
            const set = listeners.get(paneID) ?? new Set<CsvListener>();
            set.add(listener);
            listeners.set(paneID, set);
            queueMicrotask(() => {
                if (set.has(listener)) listener.onState(fake.state(paneID));
            });
            return {
                unsubscribe(): void {
                    unsubscribes.push(paneID);
                    set.delete(listener);
                    if (set.size === 0) listeners.delete(paneID);
                }
            };
        },

        peek(paneID) {
            return listeners.has(paneID) ? fake.state(paneID) : null;
        },

        rows(paneID, request): Promise<CsvRowsReply> {
            rowRequests.push({ paneID, ...request });
            const answer = (): CsvRowsReply => {
                const order = viewOrder();
                const columnStart = request.columnStart ?? 0;
                const columnCount = request.columnCount ?? 256;
                const ids = fake.columnIDs.slice(columnStart, columnStart + columnCount);
                const out: CsvRow[] = [];
                const end = Math.min(request.start + request.count, order.length);
                const cut = fake.maxRowsPerReply === null ? end : Math.min(end, request.start + fake.maxRowsPerReply);
                for (let view = request.start; view < cut; view++) {
                    const row = order[view]!;
                    const source = fake.table[row] ?? [];
                    const cells = ids.map((id) => source[fake.columnIDs.indexOf(id)] ?? '');
                    const limit = fake.truncateAt;
                    const truncated = limit === null ? [] : cells.flatMap((cell, index) => (cell.length > limit ? [index] : []));
                    out.push({
                        view,
                        row,
                        cells: limit === null ? cells : cells.map((cell) => cell.slice(0, limit)),
                        ...(truncated.length > 0 ? { truncated } : {}),
                        fieldCount: source.length
                    });
                }
                return {
                    generation: `inc-1:${generationN}`,
                    revision,
                    start: request.start,
                    columnStart,
                    columnIDs: ids,
                    rows: out,
                    nextStart: cut < end ? cut : null
                };
            };
            if (!fake.holdRows) return Promise.resolve().then(answer);
            return new Promise((resolve) => heldRows.push(() => resolve(answer())));
        },

        edit(paneID, generation, ops) {
            const sent = { paneID, generation, ops };
            edits.push(sent);
            const apply = (): CsvPaneState => {
                const failure = fake.failNextEdit;
                if (failure !== null) {
                    fake.failNextEdit = null;
                    throw typeof failure === 'string' ? new Error(failure) : failure;
                }
                if (fake.rawMode) throw new Error('CSV_READ_ONLY: This pane is showing raw text.');
                applyOps(ops);
                const state = fake.state(paneID);
                for (const listener of [...(listeners.get(paneID) ?? [])]) listener.onState(state);
                return state;
            };
            if (!fake.holdEdits) return Promise.resolve().then(apply);
            return new Promise<CsvPaneState>((resolve, reject) => {
                held.push({
                    ...sent,
                    resolve: () => {
                        try {
                            resolve(apply());
                        } catch (error) {
                            reject(error as Error);
                        }
                    },
                    reject: (message) => reject(new Error(message))
                });
            });
        },

        sort(paneID, column, direction) {
            sorts.push({ paneID, column, direction });
            sort = column === null ? null : { column, direction };
            revision++;
            const state = fake.state(paneID);
            for (const listener of [...(listeners.get(paneID) ?? [])]) listener.onState(state);
            return Promise.resolve(state);
        },

        find(_paneID, query): Promise<CsvFindReply> {
            finds.push(query);
            return Promise.resolve({ query, total: matches(query).length, complete: true, truncated: false });
        },

        findStep(_paneID, query, direction, from): Promise<CsvFindStepReply> {
            steps.push({ query, direction, from });
            const found = matches(query);
            let index = -1;
            if (found.length > 0) {
                const position = (match: { view: number; column: number }): number =>
                    match.view * 100_000 + fake.columnIDs.indexOf(match.column);
                if (from === null) index = direction === 'next' ? 0 : found.length - 1;
                else if (direction === 'next') {
                    index = found.findIndex((match) => position(match) > position(from));
                    if (index < 0) index = 0;
                } else {
                    index = -1;
                    for (let i = found.length - 1; i >= 0; i--) {
                        if (position(found[i]!) < position(from)) {
                            index = i;
                            break;
                        }
                    }
                    if (index < 0) index = found.length - 1;
                }
            }
            const match = index < 0 ? null : found[index]!;
            return Promise.resolve({
                query,
                match,
                index: index < 0 ? null : index + 1,
                total: found.length,
                complete: true,
                truncated: false
            });
        },

        setHeaderRow(paneID, on) {
            headerRows.push(on);
            headerRow = on;
            revision++;
            const state = fake.state(paneID);
            for (const listener of [...(listeners.get(paneID) ?? [])]) listener.onState(state);
            return Promise.resolve(state);
        },

        discard(paneID) {
            dirty = false;
            revision++;
            return Promise.resolve(fake.state(paneID));
        },

        notify(paneID, message) {
            notices.push(message);
            for (const listener of [...(listeners.get(paneID) ?? [])]) listener.onNotice?.(message);
        },

        reportFailure(_paneID, message) {
            failures.push(message);
        },

        connected() {
            if (fake.online) return Promise.resolve();
            return new Promise<void>((resolve) => connectWaiters.push(resolve));
        }
    };

    const width = fake.table.reduce((widest, row) => Math.max(widest, row.length), 0);
    for (let index = 0; index < width; index++) fake.columnIDs.push(nextColumnID++);

    /** View order: file order, or sorted with the header row pinned. */
    function viewOrder(): number[] {
        const order = fake.table.map((_row, index) => index);
        if (sort === null) return order;
        const position = fake.columnIDs.indexOf(sort.column);
        const pinned = headerRow && order.length > 0 ? [0] : [];
        const rest = order.slice(pinned.length);
        rest.sort((a, b) => {
            const left = fake.table[a]?.[position] ?? '';
            const right = fake.table[b]?.[position] ?? '';
            const compare = left.localeCompare(right, 'en', { numeric: true });
            return (sort!.direction === 'asc' ? compare : -compare) || a - b;
        });
        return [...pinned, ...rest];
    }

    function matches(query: string): { view: number; row: number; column: number }[] {
        if (query.length === 0) return [];
        const needle = query.toLowerCase();
        const order = viewOrder();
        const out: { view: number; row: number; column: number }[] = [];
        order.forEach((row, view) => {
            fake.columnIDs.forEach((id, position) => {
                if ((fake.table[row]?.[position] ?? '').toLowerCase().includes(needle)) out.push({ view, row, column: id });
            });
        });
        return out;
    }

    function snapshot(): Snapshot {
        return { table: fake.table.map((row) => [...row]), columnIDs: [...fake.columnIDs] };
    }

    function restore(to: Snapshot): void {
        fake.table = to.table.map((row) => [...row]);
        fake.columnIDs = [...to.columnIDs];
    }

    function applyOps(ops: readonly CsvEditOp[]): void {
        let structural = false;
        for (const op of ops) {
            if (op.op === 'undo' || op.op === 'redo') {
                const from = op.op === 'undo' ? undo : redo;
                const to = op.op === 'undo' ? redo : undo;
                const target = from.pop();
                if (target === undefined) continue;
                to.push(snapshot());
                restore(target);
                structural = true;
                continue;
            }
            undo.push(snapshot());
            redo.length = 0;
            switch (op.op) {
                case 'set-cell': {
                    const position = fake.columnIDs.indexOf(op.column);
                    const row = fake.table[op.row];
                    if (row === undefined || position < 0) throw new Error('CSV_GONE: that cell no longer exists');
                    while (row.length <= position) row.push('');
                    row[position] = op.value;
                    break;
                }
                case 'insert-rows': {
                    const fresh = Array.from({ length: op.count }, (_unused, index) => [...(op.rows?.[index] ?? fake.columnIDs.map(() => ''))]);
                    fake.table.splice(op.at, 0, ...fresh);
                    structural = true;
                    break;
                }
                case 'delete-rows':
                    fake.table.splice(op.start, op.count);
                    structural = true;
                    break;
                case 'insert-column':
                    fake.columnIDs.splice(op.at, 0, nextColumnID++);
                    for (const row of fake.table) row.splice(op.at, 0, '');
                    structural = true;
                    break;
                case 'delete-column': {
                    const position = fake.columnIDs.indexOf(op.column);
                    if (position < 0) throw new Error('CSV_GONE: that column no longer exists');
                    fake.columnIDs.splice(position, 1);
                    for (const row of fake.table) row.splice(position, 1);
                    structural = true;
                    break;
                }
            }
        }
        dirty = true;
        revision++;
        if (structural) {
            generationN++;
            sort = null;
        }
    }

    return fake;
}
