/**
 * Csv find (#324, docs/csv-pane.md §find): a per-document match index per query.
 *
 * A search scans the document once in FILE order (case-insensitive substring per cell) and keeps
 * the matches as parallel `Uint32Array`s of (logical row, column id), capped at
 * `CSV_LIMITS.maxFindMatches`. The last few queries are cached per document (an LRU shared by
 * every pane and client on the file, invalidated by any content change). Each pane maps the
 * index into ITS view order (through its sort's inverse permutation and the display column
 * order) and steps through it by binary search. Clients highlight visible matches themselves.
 */

import { CSV_LIMITS } from '@kelpi/protocol';

export const FIND_CACHE_SIZE = 4;

/** Matches in file order. */
export interface FindIndex {
    readonly query: string;
    /** The document content revision it was built against. */
    readonly revision: number;
    readonly rows: Uint32Array;
    readonly columns: Uint32Array;
    readonly total: number;
    readonly truncated: boolean;
    /** False when the scan stopped early because the document changed under it. */
    readonly complete: boolean;
}

/** Collects matches during a scan, growing its arrays geometrically. */
export class MatchCollector {
    private rows = new Uint32Array(1024);
    private columns = new Uint32Array(1024);
    count = 0;
    truncated = false;

    constructor(readonly cap: number = CSV_LIMITS.maxFindMatches) {}

    get full(): boolean {
        return this.count >= this.cap;
    }

    add(row: number, column: number): boolean {
        if (this.count >= this.cap) {
            this.truncated = true;
            return false;
        }
        if (this.count === this.rows.length) {
            const size = Math.min(this.cap, this.rows.length * 2);
            const rows = new Uint32Array(size);
            rows.set(this.rows);
            const columns = new Uint32Array(size);
            columns.set(this.columns);
            this.rows = rows;
            this.columns = columns;
        }
        this.rows[this.count] = row;
        this.columns[this.count] = column;
        this.count += 1;
        return true;
    }

    finish(query: string, revision: number, complete = true): FindIndex {
        return {
            query,
            revision,
            rows: this.rows.slice(0, this.count),
            columns: this.columns.slice(0, this.count),
            total: this.count,
            truncated: this.truncated,
            complete
        };
    }
}

/** Lower-cased needle; matching is case-insensitive substring. */
export function needleOf(query: string): string {
    return query.toLowerCase();
}

export function cellMatches(cell: string, needle: string): boolean {
    return needle.length > 0 && cell.toLowerCase().includes(needle);
}

/** A tiny LRU of the last `FIND_CACHE_SIZE` queries for one document. */
export class FindCache {
    private readonly entries = new Map<string, FindIndex>();
    private readonly pending = new Map<string, Promise<FindIndex>>();

    constructor(private readonly size: number = FIND_CACHE_SIZE) {}

    get(query: string, revision: number): FindIndex | null {
        const found = this.entries.get(query);
        if (found === undefined) return null;
        if (found.revision !== revision) {
            this.entries.delete(query);
            return null;
        }
        // Refresh recency.
        this.entries.delete(query);
        this.entries.set(query, found);
        return found;
    }

    set(index: FindIndex): void {
        this.entries.delete(index.query);
        this.entries.set(index.query, index);
        while (this.entries.size > this.size) {
            const oldest = this.entries.keys().next().value as string;
            this.entries.delete(oldest);
        }
    }

    /** One build per (query, revision) at a time, shared by every caller. */
    building(query: string, revision: number): Promise<FindIndex> | null {
        return this.pending.get(`${String(revision)}\u0000${query}`) ?? null;
    }

    track(query: string, revision: number, build: Promise<FindIndex>): Promise<FindIndex> {
        const key = `${String(revision)}\u0000${query}`;
        this.pending.set(key, build);
        const clear = (): void => {
            if (this.pending.get(key) === build) this.pending.delete(key);
        };
        build.then(clear, clear);
        return build;
    }

    clear(): void {
        this.entries.clear();
        this.pending.clear();
    }

    get queries(): readonly string[] {
        return [...this.entries.keys()];
    }
}

/** One pane's matches in its view order. */
export interface ViewOrder {
    readonly views: Uint32Array;
    /** Display column positions (for ordering within a row). */
    readonly positions: Uint32Array;
    readonly rows: Uint32Array;
    readonly columns: Uint32Array;
}

/**
 * Map file-order matches into a pane's view order. `inverse[logical] = view` when the pane is
 * sorted (null = identity); `positions` maps a column id to its display position (a column no
 * longer displayed sorts last in its row).
 */
export function toViewOrder(index: FindIndex, inverse: Uint32Array | null, positions: ReadonlyMap<number, number>): ViewOrder {
    const n = index.total;
    const views = new Uint32Array(n);
    const columnPositions = new Uint32Array(n);
    for (let i = 0; i < n; i += 1) {
        const row = index.rows[i] as number;
        views[i] = inverse === null ? row : (inverse[row] ?? row);
        columnPositions[i] = positions.get(index.columns[i] as number) ?? 0xffffffff;
    }
    if (inverse === null) {
        // File order is already view order (positions ascend within a row by construction).
        return { views, positions: columnPositions, rows: index.rows, columns: index.columns };
    }
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i += 1) order[i] = i;
    order.sort((a, b) => ((views[a] as number) - (views[b] as number)) || ((columnPositions[a] as number) - (columnPositions[b] as number)));
    const sortedViews = new Uint32Array(n);
    const sortedPositions = new Uint32Array(n);
    const rows = new Uint32Array(n);
    const columns = new Uint32Array(n);
    for (let k = 0; k < n; k += 1) {
        const i = order[k] as number;
        sortedViews[k] = views[i] as number;
        sortedPositions[k] = columnPositions[i] as number;
        rows[k] = index.rows[i] as number;
        columns[k] = index.columns[i] as number;
    }
    return { views: sortedViews, positions: sortedPositions, rows, columns };
}

/** First match strictly after `(view, position)` (or the first match when `from` is null). */
function firstAfter(order: ViewOrder, view: number, position: number): number {
    let lo = 0;
    let hi = order.views.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const v = order.views[mid] as number;
        const p = order.positions[mid] as number;
        if (v < view || (v === view && p <= position)) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/** Index into `order` of the next/previous match from `from`, wrapping; -1 when there are none. */
export function stepIndex(order: ViewOrder, from: { view: number; position: number } | null, direction: 'next' | 'previous'): number {
    const n = order.views.length;
    if (n === 0) return -1;
    if (from === null) return direction === 'next' ? 0 : n - 1;
    if (direction === 'next') {
        const next = firstAfter(order, from.view, from.position);
        return next < n ? next : 0;
    }
    // Last match strictly before (view, position): everything before the first match >= it.
    let lo = 0;
    let hi = n;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const v = order.views[mid] as number;
        const p = order.positions[mid] as number;
        if (v < from.view || (v === from.view && p < from.position)) lo = mid + 1;
        else hi = mid;
    }
    return lo > 0 ? lo - 1 : n - 1;
}
