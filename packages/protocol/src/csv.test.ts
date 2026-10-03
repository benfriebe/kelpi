import { describe, expect, it } from 'vitest';

import {
    CSV_LIMITS,
    csvError,
    csvErrorCode,
    decodeCsvEditOps,
    decodeCsvFindQuery,
    decodeCsvFindStep,
    decodeCsvRowsRequest,
    decodeCsvSort,
    isCsvCommand,
    isCsvPath
} from './csv.js';

const error = (result: { ok: boolean; error?: string }): string => (result.ok ? '' : (result.error ?? ''));

describe('csv paths and commands', () => {
    it('recognises .csv and .tsv case-insensitively', () => {
        expect(isCsvPath('/data/a.csv')).toBe(true);
        expect(isCsvPath('/data/A.TSV')).toBe(true);
        expect(isCsvPath('/data/a.csv.md')).toBe(false);
        expect(isCsvPath('/data/.csv')).toBe(false);
        expect(isCsvPath('/data.csv/readme')).toBe(false);
    });

    it('knows its verbs', () => {
        expect(isCsvCommand('csv-rows')).toBe(true);
        expect(isCsvCommand('content-subscribe')).toBe(false);
    });

    it('round-trips error codes through messages', () => {
        expect(csvErrorCode(csvError('CSV_GONE', 'row deleted').message)).toBe('CSV_GONE');
        expect(csvErrorCode('DOCUMENT_CONFLICT: x')).toBeNull();
        expect(csvErrorCode('no colon')).toBeNull();
    });
});

describe('decodeCsvEditOps', () => {
    it('accepts every op shape', () => {
        const result = decodeCsvEditOps([
            { op: 'set-cell', row: 1, column: 2, value: 'x' },
            { op: 'insert-rows', at: 0, count: 2, rows: [['a'], ['b', 'c']] },
            { op: 'insert-rows', at: 3, count: 1 },
            { op: 'delete-rows', start: 0, count: 1 },
            { op: 'insert-column', at: 0 },
            { op: 'delete-column', column: 4 },
            { op: 'undo' },
            { op: 'redo' }
        ]);
        expect(result.ok).toBe(true);
        expect(result.ok && result.value.length).toBe(8);
    });

    it('rejects malformed ops with CSV_INVALID', () => {
        expect(error(decodeCsvEditOps('nope'))).toMatch(/^CSV_INVALID: /);
        expect(error(decodeCsvEditOps([]))).toContain('empty');
        expect(error(decodeCsvEditOps([{ op: 'set-cell', row: -1, column: 0, value: '' }]))).toContain('indices');
        expect(error(decodeCsvEditOps([{ op: 'set-cell', row: 0, column: 0, value: 3 }]))).toContain('string');
        expect(error(decodeCsvEditOps([{ op: 'insert-rows', at: 0, count: 0 }]))).toContain('positive');
        expect(error(decodeCsvEditOps([{ op: 'insert-rows', at: 0, count: 2, rows: [['a']] }]))).toContain('count entries');
        expect(error(decodeCsvEditOps([{ op: 'insert-rows', at: 0, count: 1, rows: [[1]] }]))).toContain('strings');
        expect(error(decodeCsvEditOps([{ op: 'delete-rows', start: 0 }]))).toContain('delete-rows');
        expect(error(decodeCsvEditOps([{ op: 'delete-column' }]))).toContain('column id');
        expect(error(decodeCsvEditOps([{ op: 'explode' }]))).toContain('unknown op');
        expect(error(decodeCsvEditOps([null]))).toContain('object');
    });

    it('enforces the limits', () => {
        const many = Array.from({ length: CSV_LIMITS.maxOpsPerBatch + 1 }, () => ({ op: 'undo' }));
        expect(error(decodeCsvEditOps(many))).toContain(`at most ${String(CSV_LIMITS.maxOpsPerBatch)}`);
        expect(error(decodeCsvEditOps([{ op: 'insert-rows', at: 0, count: CSV_LIMITS.maxInsertRows + 1 }]))).toContain('count is over');
        // The insert cap is per batch, not per op.
        expect(decodeCsvEditOps([{ op: 'insert-rows', at: 0, count: CSV_LIMITS.maxInsertRows }]).ok).toBe(true);
        const half = Math.floor(CSV_LIMITS.maxInsertRows / 2);
        expect(decodeCsvEditOps([{ op: 'insert-rows', at: 0, count: half }, { op: 'insert-rows', at: 0, count: half }]).ok).toBe(true);
        expect(error(decodeCsvEditOps([
            { op: 'insert-rows', at: 0, count: half },
            { op: 'insert-rows', at: 0, count: half },
            { op: 'insert-rows', at: 0, count: 1 }
        ]))).toContain('in one batch add up to over');
        const flood = Array.from({ length: CSV_LIMITS.maxOpsPerBatch }, () => ({ op: 'insert-rows', at: 0, count: CSV_LIMITS.maxInsertRows }));
        expect(error(decodeCsvEditOps(flood))).toContain('in one batch add up to over');
        const bigCell = 'x'.repeat(CSV_LIMITS.maxCellBytes + 1);
        expect(error(decodeCsvEditOps([{ op: 'set-cell', row: 0, column: 0, value: bigCell }]))).toContain('over 1 MiB');
        // Multi-byte characters count as UTF-8 bytes.
        const wide = 'é'.repeat(CSV_LIMITS.maxCellBytes / 2 + 1);
        expect(error(decodeCsvEditOps([{ op: 'set-cell', row: 0, column: 0, value: wide }]))).toContain('over 1 MiB');
        const cell = 'y'.repeat(CSV_LIMITS.maxCellBytes);
        const batch = Array.from({ length: 9 }, (_, i) => ({ op: 'set-cell', row: i, column: 0, value: cell }));
        expect(error(decodeCsvEditOps(batch))).toContain('over 8 MiB');
    });
});

describe('the other csv decoders', () => {
    it('rows: snake or camel case, bounded', () => {
        expect(decodeCsvRowsRequest({ start: 0, count: 10, column_start: 2, column_count: 3 })).toEqual({ ok: true, value: { start: 0, count: 10, columnStart: 2, columnCount: 3 } });
        expect(decodeCsvRowsRequest({ start: 5, count: 1, columnStart: 1 })).toEqual({ ok: true, value: { start: 5, count: 1, columnStart: 1 } });
        expect(error(decodeCsvRowsRequest({ start: 0, count: CSV_LIMITS.maxRowsPerRequest + 1 }))).toContain('rows per request');
        expect(error(decodeCsvRowsRequest({ start: 0, count: 1, column_count: CSV_LIMITS.maxColumnsPerRequest + 1 }))).toContain('column_count');
        expect(error(decodeCsvRowsRequest({ start: 1.5, count: 1 }))).toContain('start and count');
    });

    it('sort: a column id or null, asc by default', () => {
        expect(decodeCsvSort({ column: 3 })).toEqual({ ok: true, value: { column: 3, direction: 'asc' } });
        expect(decodeCsvSort({ column: null, direction: 'desc' })).toEqual({ ok: true, value: { column: null, direction: 'desc' } });
        expect(error(decodeCsvSort({ column: 'a' }))).toContain('column id');
        expect(error(decodeCsvSort({ column: 1, direction: 'up' }))).toContain('asc or desc');
    });

    it('find: queries up to 1 KiB, steps with an optional origin', () => {
        expect(decodeCsvFindQuery('')).toEqual({ ok: true, value: '' });
        expect(error(decodeCsvFindQuery('x'.repeat(CSV_LIMITS.maxFindQueryBytes + 1)))).toContain('over 1 KiB');
        expect(error(decodeCsvFindQuery(7))).toContain('string');
        expect(decodeCsvFindStep({ query: 'a' })).toEqual({ ok: true, value: { query: 'a', direction: 'next', from: null } });
        expect(decodeCsvFindStep({ query: 'a', direction: 'previous', from: { view: 2, column: 0 } })).toEqual({ ok: true, value: { query: 'a', direction: 'previous', from: { view: 2, column: 0 } } });
        expect(error(decodeCsvFindStep({ query: 'a', direction: 'sideways' }))).toContain('next or previous');
        expect(error(decodeCsvFindStep({ query: 'a', from: { view: -1, column: 0 } }))).toContain('from must be');
    });
});
