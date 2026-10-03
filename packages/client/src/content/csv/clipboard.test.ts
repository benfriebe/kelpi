import { describe, expect, it } from 'vitest';

import { clipboardCellText, parseClipboardTable } from './clipboard';
import { CSV_SAMPLE_CHARS, CSV_WIDTH_PANES, autoColumnWidth, cellDisplayText, columnLetter, columnOffsets, csvColumnWidths, visibleColumns } from './columns';

describe('parseClipboardTable', () => {
    it('reads a spreadsheet range: tabs between cells, line breaks between rows', () => {
        expect(parseClipboardTable('a\tb\nc\td\n')).toEqual([['a', 'b'], ['c', 'd']]);
        expect(parseClipboardTable('a\tb\r\nc\td')).toEqual([['a', 'b'], ['c', 'd']]);
    });

    it('is one cell for plain text, and keeps empty cells', () => {
        expect(parseClipboardTable('plain words')).toEqual([['plain words']]);
        expect(parseClipboardTable('a\t\tc')).toEqual([['a', '', 'c']]);
        expect(parseClipboardTable('')).toEqual([['']]);
    });

    it('unquotes a cell that holds a tab, a line break or a quote', () => {
        expect(parseClipboardTable('"two\nlines"\t"say ""hi"""\n')).toEqual([['two\nlines', 'say "hi"']]);
        // A quote that does not close a field is just a character.
        expect(parseClipboardTable('5" screen\tx')).toEqual([['5" screen', 'x']]);
    });
});

describe('clipboardCellText', () => {
    it('round-trips any one value through the TSV paste reads, as a single cell', () => {
        for (const value of ['plain', '', 'line1\nline2', 'a\tb', '"x"', '"', 'x\r\ny', 'trailing\n', 'say "hi"', '5" screen']) {
            expect(parseClipboardTable(clipboardCellText(value))).toEqual([[value]]);
        }
    });

    it('quotes only what TSV would misread', () => {
        expect(clipboardCellText('5" screen')).toBe('5" screen');
        expect(clipboardCellText('two\nlines')).toBe('"two\nlines"');
        expect(clipboardCellText('"quoted"')).toBe('"""quoted"""');
    });
});

describe('column geometry', () => {
    it('names columns the spreadsheet way', () => {
        expect([0, 1, 25, 26, 27, 701, 702].map(columnLetter)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
    });

    it('sizes from samples inside 60-360 px', () => {
        expect(autoColumnWidth(['a'])).toBe(60);
        expect(autoColumnWidth(['x'.repeat(500)])).toBe(360);
        expect(autoColumnWidth(['region', 'north-east'])).toBeGreaterThan(60);
        // A real measure wins over the character estimate, plus padding and the border.
        expect(autoColumnWidth(['Arlington'], () => 100)).toBe(118);
        // The multi-line marker is measured with the first line.
        const seen: string[] = [];
        autoColumnWidth(['two\nlines'], (text) => { seen.push(text); return 40; });
        expect(seen).toEqual(['two ↵']);
        // No canvas (null) falls back to the estimate.
        expect(autoColumnWidth(['region', 'north-east'], () => null)).toBe(autoColumnWidth(['region', 'north-east']));
    });

    it('measures at most the first 100 characters of a sample, however long the cell', () => {
        const seen: string[] = [];
        expect(autoColumnWidth(['y'.repeat(65_536)], (text) => { seen.push(text); return text.length * 7; })).toBe(360);
        expect(seen.map((text) => text.length)).toEqual([CSV_SAMPLE_CHARS]);
    });

    it('draws a multi-line value as its first line, marked', () => {
        expect(cellDisplayText('one\ntwo')).toEqual({ text: 'one', multiline: true });
        expect(cellDisplayText('one')).toEqual({ text: 'one', multiline: false });
    });

    it('windows the columns under a horizontal scroll', () => {
        const offsets = columnOffsets([100, 100, 100, 100, 100, 100]);
        expect(offsets.at(-1)).toBe(600);
        expect(visibleColumns(offsets, 0, 250, 0)).toEqual({ start: 0, end: 3 });
        expect(visibleColumns(offsets, 250, 100, 1)).toEqual({ start: 1, end: 5 });
        expect(visibleColumns(offsets, 590, 100, 0)).toEqual({ start: 5, end: 6 });
    });
});

describe('csvColumnWidths.growAuto', () => {
    it('widens, never narrows, and reports a change only when the drawn width moves', async () => {
        const { csvColumnWidths } = await import('./columns');
        csvColumnWidths.clear('grow-pane');
        expect(csvColumnWidths.growAuto('grow-pane', 1, 80)).toBe(true);
        expect(csvColumnWidths.get('grow-pane', 1)).toBe(80);
        expect(csvColumnWidths.growAuto('grow-pane', 1, 70)).toBe(false);
        expect(csvColumnWidths.get('grow-pane', 1)).toBe(80);
        expect(csvColumnWidths.growAuto('grow-pane', 1, 120)).toBe(true);
        csvColumnWidths.setManual('grow-pane', 1, 50);
        expect(csvColumnWidths.growAuto('grow-pane', 1, 200)).toBe(false);
        expect(csvColumnWidths.get('grow-pane', 1)).toBe(50);
        csvColumnWidths.clear('grow-pane');
    });

    it('remembers a bounded number of panes, forgetting the least recently drawn', () => {
        csvColumnWidths.clear();
        csvColumnWidths.setManual('kept', 0, 200);
        csvColumnWidths.setManual('forgotten', 0, 200);
        for (let index = 0; index < CSV_WIDTH_PANES - 1; index++) {
            // 'kept' is drawn between the others; 'forgotten' never is again.
            expect(csvColumnWidths.get('kept', 0)).toBe(200);
            csvColumnWidths.growAuto(`pane-${String(index)}`, 0, 80);
        }
        expect(csvColumnWidths.get('kept', 0)).toBe(200);
        expect(csvColumnWidths.get('forgotten', 0)).toBeNull();
        csvColumnWidths.clear();
    });
});
