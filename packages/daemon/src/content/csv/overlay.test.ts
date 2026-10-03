import { describe, expect, it } from 'vitest';

import { EMPTY_ROW, MAX_ROWS_SEGMENT, newRow, Overlay, type Run } from './overlay.js';
import { UndoHistory, entryBytes, type AppliedOp } from './undo.js';

const describeRuns = (runs: Iterable<Run>): string[] =>
    [...runs].map(run => run.kind === 'base'
        ? `b${String(run.start)}+${String(run.count)}@${String(run.logical)}`
        : `r${String(run.data.base)}@${String(run.logical)}`);

describe('csv overlay', () => {
    it('starts as one base run with identity columns', () => {
        const overlay = Overlay.identity(10, 3);
        expect(overlay.rowCount).toBe(10);
        expect(overlay.identityColumns()).toBe(true);
        expect(overlay.columns.map(column => column.id)).toEqual([0, 1, 2]);
        expect(describeRuns(overlay.runs(0, 10))).toEqual(['b0+10@0']);
        expect(describeRuns(overlay.runs(3, 4))).toEqual(['b3+4@3']);
    });

    it('splits a base run to materialise an edited row and reverts an override set back', () => {
        const overlay = Overlay.identity(10, 2);
        overlay.setCell(4, 1, 'new', 'old');
        expect(describeRuns(overlay.runs(0, 10))).toEqual(['b0+4@0', 'r4@4', 'b5+5@5']);
        const resolved = overlay.resolve(4);
        expect(resolved.kind === 'row' && resolved.data.cells?.get(1)).toBe('new');
        overlay.setCell(4, 1, 'old', 'old');
        const reverted = overlay.resolve(4);
        expect(reverted.kind === 'row' && reverted.data.cells).toBeNull();
        // A replay (no base value) always keeps the override.
        overlay.setCell(4, 1, 'old', undefined);
        const kept = overlay.resolve(4);
        expect(kept.kind === 'row' && kept.data.cells?.get(1)).toBe('old');
    });

    it('inserts rows inside base runs, inside materialised runs and at the end', () => {
        const overlay = Overlay.identity(4, 1);
        overlay.insertRows(2, [newRow(['x'], [0])]);
        expect(overlay.rowCount).toBe(5);
        expect(describeRuns(overlay.runs(0, 5))).toEqual(['b0+2@0', 'r-1@2', 'b2+2@3']);
        overlay.insertRows(3, [newRow(), newRow()]);
        expect(describeRuns(overlay.runs(0, 7))).toEqual(['b0+2@0', 'r-1@2', 'r-1@3', 'r-1@4', 'b2+2@5']);
        overlay.insertRows(7, [newRow(['end'], [0])]);
        expect(overlay.rowCount).toBe(8);
        const last = overlay.resolve(7);
        expect(last.kind === 'row' && last.data.cells?.get(0)).toBe('end');
        expect(() => overlay.insertRows(99, [newRow()])).toThrow(RangeError);
    });

    it('deletes ranges that span base and materialised runs, merging what is left', () => {
        const overlay = Overlay.identity(10, 1);
        overlay.setCell(3, 0, 'e', '');
        overlay.deleteRows(2, 3); // base 2, edited 3, base 4
        expect(overlay.rowCount).toBe(7);
        expect(describeRuns(overlay.runs(0, 7))).toEqual(['b0+2@0', 'b5+5@2']);
        overlay.deleteRows(0, 7);
        expect(overlay.rowCount).toBe(0);
        expect(() => overlay.deleteRows(0, 1)).toThrow(RangeError);
    });

    it('a big paste is not limited by argument counts', () => {
        const overlay = Overlay.identity(1, 1);
        const rows = Array.from({ length: 150_000 }, () => newRow());
        overlay.insertRows(1, rows);
        overlay.insertRows(1, rows);
        expect(overlay.rowCount).toBe(300_001);
    });

    it('tracks columns by stable id, remembers deleted ones and stops being identity', () => {
        const overlay = Overlay.identity(2, 3);
        overlay.insertColumn(1, { id: overlay.nextColumnID, base: null });
        expect(overlay.columns.map(column => column.id)).toEqual([0, 3, 1, 2]);
        expect(overlay.identityColumns()).toBe(false);
        expect(overlay.deleteColumn(1)).toBe(2);
        expect(overlay.deletedColumns.get(1)).toBe(1);
        expect(overlay.columnPosition(2)).toBe(2);
        expect(overlay.deleteColumn(42)).toBe(-1);
        overlay.insertColumn(2, { id: 1, base: 1 });
        expect(overlay.deletedColumns.has(1)).toBe(false);
    });

    it('rebased identity keeps the ids it is given', () => {
        const overlay = Overlay.identity(5, 3, [7, 2, 9], 12);
        expect(overlay.columns).toEqual([{ id: 7, base: 0 }, { id: 2, base: 1 }, { id: 9, base: 2 }]);
        expect(overlay.nextColumnID).toBe(12);
        expect(overlay.identityColumns()).toBe(true);
    });

    it('clones deeply so a save snapshot never sees later edits', () => {
        const overlay = Overlay.identity(3, 1);
        overlay.setCell(1, 0, 'a', '');
        const snapshot = overlay;
        const live = overlay.clone();
        live.setCell(1, 0, 'b', '');
        live.insertRows(0, [newRow()]);
        const before = snapshot.resolve(1);
        expect(before.kind === 'row' && before.data.cells?.get(0)).toBe('a');
        expect(snapshot.rowCount).toBe(3);
    });
});

describe('csv overlay copy-on-write and bounds', () => {
    const value = (overlay: Overlay, row: number): string | null => {
        const resolved = overlay.resolve(row);
        return resolved.kind === 'row' ? (resolved.data.cells?.get(0) ?? null) : null;
    };

    it('blank inserted rows are one shared frozen row, copied before a change', () => {
        const overlay = Overlay.identity(1, 1);
        overlay.insertRows(1, [newRow(), newRow(), newRow(['', ''], [0, 1])]);
        const rows = [1, 2, 3].map(row => overlay.resolve(row));
        for (const row of rows) expect(row.kind === 'row' && row.data).toBe(EMPTY_ROW);
        expect(Object.isFrozen(EMPTY_ROW)).toBe(true);
        overlay.setCell(2, 0, 'changed', '');
        expect(value(overlay, 2)).toBe('changed');
        expect(value(overlay, 1)).toBeNull();
        expect(value(overlay, 3)).toBeNull();
        expect(EMPTY_ROW.cells).toBeNull();
    });

    it('a clone shares rows until a side changes one, and never sees the other side change it', () => {
        const overlay = Overlay.identity(3, 1);
        overlay.setCell(1, 0, 'a', '');
        const copy = overlay.clone();
        const shared = (o: Overlay): unknown => { const r = o.resolve(1); return r.kind === 'row' ? r.data : null; };
        expect(shared(copy)).toBe(shared(overlay));
        overlay.setCell(1, 0, 'original changed', '');
        expect(value(copy, 1)).toBe('a');
        copy.setCell(1, 0, 'copy changed', '');
        expect(value(overlay, 1)).toBe('original changed');
        const inserted = newRow(['h'], [0]);
        copy.insertRows(0, [inserted]);
        copy.setCell(0, 0, 'edited', '');
        expect(inserted.cells?.get(0)).toBe('h');
    });

    it('caps rows segments, so an insert inside one copies a bounded slice', () => {
        const overlay = Overlay.identity(2, 1);
        const rows = Array.from({ length: 3 * MAX_ROWS_SEGMENT + 5 }, (_, i) => newRow([`n${String(i)}`], [0]));
        overlay.insertRows(1, rows);
        for (let i = 0; i < 200; i += 1) overlay.insertRows(2 + i * 7, [newRow([`x${String(i)}`], [0])]);
        expect(overlay.rowCount).toBe(2 + rows.length + 200);
        for (const segment of overlay.segments) {
            if (segment.kind === 'rows') expect(segment.rows.length).toBeLessThanOrEqual(MAX_ROWS_SEGMENT);
        }
        expect(value(overlay, 1)).toBe('n0');
        expect(value(overlay, 2)).toBe('x0');
        expect(value(overlay, 3)).toBe('n1');
        expect(overlay.resolve(overlay.rowCount - 1)).toEqual({ kind: 'base', base: 1 });
    });

    it('a cell edit normalises only around the row it touched', () => {
        const overlay = Overlay.identity(100, 1);
        overlay.setCell(10, 0, 'a', '');
        overlay.setCell(50, 0, 'b', '');
        const segments = overlay.segments;
        overlay.setCell(11, 0, 'c', '');
        // Spliced in place, not rebuilt from every segment.
        expect(overlay.segments).toBe(segments);
        expect(describeRuns(overlay.runs(0, 100))).toEqual(['b0+10@0', 'r10@10', 'r11@11', 'b12+38@12', 'r50@50', 'b51+49@51']);
        expect(overlay.segments.filter(segment => segment.kind === 'rows').length).toBe(2);
    });
});

describe('csv undo history', () => {
    const op = (value: string): AppliedOp => ({ op: 'set-cell', row: 0, column: 0, value });

    it('moves entries between undo and redo, and a new edit clears redo', () => {
        const history = new UndoHistory(1024 * 1024);
        const entry = { forward: [op('b')], inverse: [op('a')], bytes: 100 };
        history.push(entry);
        expect(history.canUndo).toBe(true);
        const taken = history.takeUndo();
        expect(taken).toBe(entry);
        history.undone(entry);
        expect(history.canRedo).toBe(true);
        history.push({ forward: [op('c')], inverse: [op('b')], bytes: 100 });
        expect(history.canRedo).toBe(false);
        expect(history.bytes).toBe(100);
    });

    it('restores a snapshot of both stacks', () => {
        const history = new UndoHistory(1024 * 1024);
        const first = { forward: [op('b')], inverse: [op('a')], bytes: 100 };
        history.push(first);
        const snapshot = history.snapshot();
        history.undone(history.takeUndo() as typeof first);
        history.push({ forward: [op('c')], inverse: [op('b')], bytes: 50 });
        history.restore(snapshot);
        expect(history.canUndo).toBe(true);
        expect(history.canRedo).toBe(false);
        expect(history.bytes).toBe(100);
        expect(history.takeUndo()).toBe(first);
    });

    it('evicts the oldest entries over budget and refuses an entry that alone is too big', () => {
        const history = new UndoHistory(250);
        history.push({ forward: [], inverse: [], bytes: 100 });
        history.push({ forward: [], inverse: [], bytes: 100 });
        history.push({ forward: [], inverse: [], bytes: 100 });
        expect(history.bytes).toBe(200);
        expect(history.push({ forward: [], inverse: [], bytes: 300 })).toBe(false);
        expect(history.canUndo).toBe(false);
        expect(history.bytes).toBe(0);
    });

    it('estimates bytes from the data an entry holds', () => {
        const small = entryBytes([op('x')], [op('y')]);
        const big = entryBytes([op('x'.repeat(10_000))], [op('y')]);
        expect(big - small).toBeGreaterThanOrEqual(19_998);
        const rows: AppliedOp = { op: 'insert-rows', at: 0, rows: [newRow(['a'.repeat(100)], [0])] };
        expect(entryBytes([rows], [])).toBeGreaterThan(200);
    });
});
