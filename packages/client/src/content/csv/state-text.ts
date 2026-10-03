/**
 * The sentences a csv pane says about its document (#324): the status line, the reasons an edit
 * or ⌘E is refused, and the "can't be undone" warning on a destructive structural edit.
 */

import { CSV_LIMITS } from '@kelpi/protocol';

import type { CsvCellView } from './csv-model';
import type { CsvPaneState } from './types';

const NUMBER = new Intl.NumberFormat('en-US');

export function formatCount(value: number): string {
    return NUMBER.format(Math.max(0, Math.round(value)));
}

/** "Indexing… 1,234,567 rows", or null when the scan is done. */
export function scanningText(state: CsvPaneState): string | null {
    if (state.scanning === null) return null;
    const total = state.scanning.totalBytes;
    const percent = total > 0 ? ` (${Math.min(99, Math.floor((state.scanning.bytes / total) * 100))}%)` : '';
    return `Indexing… ${formatCount(state.scanning.rows)} rows${percent}`;
}

/** Why ⌘E (raw text) is unavailable, or null when it is available. */
export function csvRawUnavailableReason(state: CsvPaneState): string | null {
    if (state.rawEditable) return null;
    if (state.readOnly !== null) return `Raw text is unavailable: ${state.readOnly.message}`;
    if (state.scanning !== null) return 'Raw text (⌘E) is available once indexing finishes';
    if (state.bytes > CSV_LIMITS.rawEditLimitBytes) return 'Raw text (⌘E) is only available for files up to 2 MiB';
    return 'Raw text (⌘E) is unavailable for this file';
}

/** Why a cell cannot be edited right now, or null when it can. */
export function cellEditBlockReason(state: CsvPaneState | null, cell: CsvCellView): string | null {
    if (state === null) return 'The table is still loading.';
    if (state.readOnly !== null) return `Read-only: ${state.readOnly.message}`;
    if (state.scanning !== null) return 'Editing is available once indexing finishes.';
    if (!cell.loaded || cell.row === null || cell.column === null) return 'This row is still loading.';
    if (cell.truncated) return 'This cell is too long to edit in the grid; use raw text or another editor.';
    return null;
}

/** Why the document's structure cannot change right now (insert/delete/sort), or null. */
export function structureBlockReason(state: CsvPaneState | null): string | null {
    if (state === null) return 'The table is still loading.';
    if (state.readOnly !== null) return `Read-only: ${state.readOnly.message}`;
    if (state.scanning !== null) return 'Available once indexing finishes.';
    return null;
}

/**
 * The daemon keeps a deleted column's undo only for files under this size; above it the delete
 * is applied and the history cleared (its `That change was too large to undo…` notice).
 */
export const CSV_COLUMN_UNDO_LIMIT_BYTES = 32 * 1024 * 1024;

/**
 * Whether a delete will clear undo rather than be undoable, so the menu can say so BEFORE it is
 * chosen. The state carries no flag for it: a column follows the daemon's own file-size rule
 * above, and rows are estimated against the undo budget from the average row size (the deleted
 * values are what an undo would have to keep).
 */
export function deleteClearsUndo(state: CsvPaneState, target: { readonly rows?: number; readonly column?: boolean }): boolean {
    if (state.bytes <= 0) return false;
    if (target.column === true) return state.bytes > CSV_COLUMN_UNDO_LIMIT_BYTES;
    if (target.rows !== undefined && state.rowCount > 0) return (state.bytes / state.rowCount) * target.rows > CSV_LIMITS.undoBudgetBytes;
    return false;
}
