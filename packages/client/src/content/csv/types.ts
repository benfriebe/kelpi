/**
 * The csv pane's wire shapes, decoded at the boundary (#324, docs/csv-pane.md).
 *
 * The shapes themselves are `@kelpi/protocol`'s (`csv.ts`); what lives here is the parse guard
 * for each one, for the same reason `content/types.ts` restates the content state: a field the
 * daemon renames must fail loudly where the JSON arrives, not surface as `undefined` three
 * components deep in the grid.
 */

import type {
    CsvDialect,
    CsvFindMatch,
    CsvFindReply,
    CsvFindStepReply,
    CsvPaneState,
    CsvReadOnly,
    CsvReadOnlyCode,
    CsvRow,
    CsvRowsReply,
    CsvScanProgress,
    CsvSortState
} from '@kelpi/protocol';

export type {
    CsvDialect,
    CsvEditOp,
    CsvFindDirection,
    CsvFindMatch,
    CsvFindReply,
    CsvFindStepReply,
    CsvPaneState,
    CsvReadOnly,
    CsvRow,
    CsvRowsReply,
    CsvRowsRequest,
    CsvSortDirection,
    CsvSortState
} from '@kelpi/protocol';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIndex(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function finiteOr(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nullableText(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

const READ_ONLY_CODES: readonly CsvReadOnlyCode[] = ['not-utf8', 'utf16', 'oversized-record', 'raw-elsewhere', 'not-regular'];

function parseReadOnly(value: unknown): CsvReadOnly | null {
    if (!isRecord(value)) return null;
    const code = value['code'];
    const message = value['message'];
    if (typeof message !== 'string') return null;
    // An unknown code from a newer daemon is still read-only; the sentence is what is shown.
    const known = READ_ONLY_CODES.find((entry) => entry === code) ?? 'not-regular';
    return { code: known, message };
}

function parseScanning(value: unknown): CsvScanProgress | null {
    if (!isRecord(value)) return null;
    return {
        rows: finiteOr(value['rows'], 0),
        bytes: finiteOr(value['bytes'], 0),
        totalBytes: finiteOr(value['totalBytes'], 0)
    };
}

function parseSort(value: unknown): CsvSortState | null {
    if (!isRecord(value)) return null;
    const column = value['column'];
    const direction = value['direction'];
    if (!isIndex(column)) return null;
    if (direction !== 'asc' && direction !== 'desc') return null;
    return { column, direction, pending: value['pending'] === true };
}

function parseDialect(value: unknown): CsvDialect | null {
    if (!isRecord(value)) return null;
    const delimiter = value['delimiter'];
    const lineEnding = value['lineEnding'];
    if (delimiter !== ',' && delimiter !== ';' && delimiter !== '\t' && delimiter !== '|') return null;
    return {
        delimiter,
        lineEnding: lineEnding === '\r\n' ? '\r\n' : '\n',
        bom: value['bom'] === true,
        quoteAll: value['quoteAll'] === true
    };
}

/** Type-strict decode of a `csv-updated` / verb-reply `state`; `null` for anything that is not one. */
export function parseCsvState(value: unknown): CsvPaneState | null {
    if (!isRecord(value)) return null;
    const paneID = value['paneID'];
    const incarnation = value['incarnation'];
    const generation = value['generation'];
    const revision = value['revision'];
    const columns = value['columns'];
    if (typeof paneID !== 'string' || paneID.length === 0) return null;
    if (typeof incarnation !== 'string') return null;
    if (typeof generation !== 'string') return null;
    if (typeof revision !== 'number' || !Number.isFinite(revision)) return null;
    if (!Array.isArray(columns) || !columns.every(isIndex)) return null;
    return {
        paneID,
        incarnation,
        revision,
        generation,
        filePath: nullableText(value['filePath']),
        loaded: value['loaded'] === true,
        scanning: parseScanning(value['scanning']),
        rowCount: isIndex(value['rowCount']) ? value['rowCount'] : 0,
        columns: columns as number[],
        bytes: finiteOr(value['bytes'], 0),
        dialect: parseDialect(value['dialect']),
        headerRow: value['headerRow'] !== false,
        sort: parseSort(value['sort']),
        dirty: value['dirty'] === true,
        saving: value['saving'] === true,
        canUndo: value['canUndo'] === true,
        canRedo: value['canRedo'] === true,
        rawEditable: value['rawEditable'] === true,
        readOnly: parseReadOnly(value['readOnly']),
        error: nullableText(value['error']),
        notice: nullableText(value['notice'])
    };
}

function parseRow(value: unknown): CsvRow | null {
    if (!isRecord(value)) return null;
    const view = value['view'];
    const row = value['row'];
    const cells = value['cells'];
    if (!isIndex(view) || !isIndex(row)) return null;
    if (!Array.isArray(cells) || !cells.every((cell) => typeof cell === 'string')) return null;
    const truncated = value['truncated'];
    return {
        view,
        row,
        cells: cells as string[],
        ...(Array.isArray(truncated) && truncated.every(isIndex) ? { truncated: truncated as number[] } : {}),
        fieldCount: isIndex(value['fieldCount']) ? value['fieldCount'] : cells.length
    };
}

/** Decode the `rows` field of a `csv-rows` reply. */
export function parseCsvRowsReply(value: unknown): CsvRowsReply | null {
    if (!isRecord(value)) return null;
    const rows = value['rows'];
    const columnIDs = value['columnIDs'];
    if (!Array.isArray(rows) || !Array.isArray(columnIDs) || !columnIDs.every(isIndex)) return null;
    const parsed: CsvRow[] = [];
    for (const entry of rows) {
        const row = parseRow(entry);
        if (row === null) return null;
        parsed.push(row);
    }
    const nextStart = value['nextStart'];
    return {
        generation: typeof value['generation'] === 'string' ? value['generation'] : '',
        revision: finiteOr(value['revision'], 0),
        start: isIndex(value['start']) ? value['start'] : (parsed[0]?.view ?? 0),
        columnStart: isIndex(value['columnStart']) ? value['columnStart'] : 0,
        columnIDs: columnIDs as number[],
        rows: parsed,
        nextStart: isIndex(nextStart) ? nextStart : null
    };
}

/** Decode the `find` field of a `csv-find` reply. */
export function parseCsvFindReply(value: unknown): CsvFindReply | null {
    if (!isRecord(value)) return null;
    if (typeof value['query'] !== 'string') return null;
    return {
        query: value['query'],
        total: isIndex(value['total']) ? value['total'] : 0,
        complete: value['complete'] !== false,
        truncated: value['truncated'] === true
    };
}

function parseMatch(value: unknown): CsvFindMatch | null {
    if (!isRecord(value)) return null;
    const { view, row, column } = value;
    if (!isIndex(view) || !isIndex(row) || !isIndex(column)) return null;
    return { view, row, column };
}

/** Decode the `step` field of a `csv-find-step` reply. */
export function parseCsvFindStepReply(value: unknown): CsvFindStepReply | null {
    if (!isRecord(value)) return null;
    if (typeof value['query'] !== 'string') return null;
    const index = value['index'];
    return {
        query: value['query'],
        match: parseMatch(value['match']),
        index: isIndex(index) ? index : null,
        total: isIndex(value['total']) ? value['total'] : 0,
        complete: value['complete'] !== false,
        truncated: value['truncated'] === true
    };
}
