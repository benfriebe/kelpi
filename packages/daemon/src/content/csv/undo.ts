/**
 * Csv undo/redo (#324, docs/csv-pane.md): each applied batch is one entry holding its forward
 * ops and their inverses, both in LOGICAL space (logical rows, stable column ids). Logical
 * addresses do not change when the document is saved and rebased, so history survives autosave.
 *
 * Inverses carry the data they need (a cell's old value, deleted rows' contents, a deleted
 * column's values), so the history has a memory budget. Old entries are evicted to stay inside
 * it; an entry that alone is over budget clears the history instead (the document then tells the
 * user the change can't be undone).
 */

import type { RowData } from './overlay.js';

export type AppliedOp =
    | { readonly op: 'set-cell'; readonly row: number; readonly column: number; readonly value: string }
    /** Rows are materialised (`base: -1`); the overlay copies a row before changing it, so history is never mutated. */
    | { readonly op: 'insert-rows'; readonly at: number; readonly rows: readonly RowData[] }
    | { readonly op: 'delete-rows'; readonly start: number; readonly count: number }
    /**
     * Insert column `id` at display position `at`. A restore (undoing a delete) names the base
     * field it came from and the base `epoch` that field index belongs to: while no save has
     * rebased the file since, the column is restored by reference. Otherwise `values` (by logical
     * row) refill it.
     */
    | {
          readonly op: 'insert-column';
          readonly at: number;
          readonly id: number;
          readonly base: number | null;
          readonly epoch: number;
          readonly values: readonly string[] | null;
      }
    | { readonly op: 'delete-column'; readonly id: number };

export interface UndoEntry {
    readonly forward: readonly AppliedOp[];
    readonly inverse: readonly AppliedOp[];
    readonly bytes: number;
}

const STRING_OVERHEAD = 40;

function stringBytes(value: string): number {
    return value.length * 2 + STRING_OVERHEAD;
}

function rowBytes(row: RowData): number {
    let bytes = 64;
    if (row.cells !== null) for (const value of row.cells.values()) bytes += stringBytes(value) + 16;
    if (row.quoted !== null) bytes += row.quoted.size * 16;
    return bytes;
}

/** An estimate of what holding `op` costs. */
export function opBytes(op: AppliedOp): number {
    switch (op.op) {
        case 'set-cell':
            return stringBytes(op.value) + 48;
        case 'insert-rows': {
            let bytes = 64;
            for (const row of op.rows) bytes += rowBytes(row);
            return bytes;
        }
        case 'insert-column': {
            let bytes = 64;
            if (op.values !== null) for (const value of op.values) bytes += value.length * 2 + 16;
            return bytes;
        }
        default:
            return 48;
    }
}

export function entryBytes(forward: readonly AppliedOp[], inverse: readonly AppliedOp[]): number {
    let bytes = 64;
    for (const op of forward) bytes += opBytes(op);
    for (const op of inverse) bytes += opBytes(op);
    return bytes;
}

export interface HistorySnapshot {
    readonly undo: readonly UndoEntry[];
    readonly redo: readonly UndoEntry[];
    readonly used: number;
}

export class UndoHistory {
    private undoStack: UndoEntry[] = [];
    private redoStack: UndoEntry[] = [];
    private used = 0;

    constructor(readonly budget: number) {}

    get canUndo(): boolean {
        return this.undoStack.length > 0;
    }

    get canRedo(): boolean {
        return this.redoStack.length > 0;
    }

    get bytes(): number {
        return this.used;
    }

    clear(): void {
        this.undoStack.length = 0;
        this.redoStack.length = 0;
        this.used = 0;
    }

    /** A new edit: clears redo. False when the entry alone is over budget (history cleared). */
    push(entry: UndoEntry): boolean {
        for (const old of this.redoStack) this.used -= old.bytes;
        this.redoStack.length = 0;
        if (entry.bytes > this.budget) {
            this.clear();
            return false;
        }
        this.undoStack.push(entry);
        this.used += entry.bytes;
        while (this.used > this.budget && this.undoStack.length > 1) {
            const evicted = this.undoStack.shift() as UndoEntry;
            this.used -= evicted.bytes;
        }
        return true;
    }

    /** Pop the entry to undo; the caller applies `inverse` and then calls `undone`. */
    takeUndo(): UndoEntry | null {
        const entry = this.undoStack.pop() ?? null;
        if (entry !== null) this.used -= entry.bytes;
        return entry;
    }

    undone(entry: UndoEntry): void {
        this.redoStack.push(entry);
        this.used += entry.bytes;
    }

    takeRedo(): UndoEntry | null {
        const entry = this.redoStack.pop() ?? null;
        if (entry !== null) this.used -= entry.bytes;
        return entry;
    }

    redone(entry: UndoEntry): void {
        this.undoStack.push(entry);
        this.used += entry.bytes;
    }

    /** Both stacks as they are now, for `restore` when a batch that undid or redid fails. */
    snapshot(): HistorySnapshot {
        return { undo: this.undoStack.slice(), redo: this.redoStack.slice(), used: this.used };
    }

    restore(snapshot: HistorySnapshot): void {
        this.undoStack = snapshot.undo.slice();
        this.redoStack = snapshot.redo.slice();
        this.used = snapshot.used;
    }
}
