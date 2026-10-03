/**
 * The csv grid against an in-memory daemon (`testing.ts`): the render window, the header row,
 * the keyboard editing flow, paste, the context menu, sort, find, the raw-text switch and the
 * phone gestures. jsdom has no layout, so the viewport is handed in (`viewportSize`).
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { firePointer } from '../../grid/testing';
import { contentState, createFakeContentApi } from '../testing';
import { csvChromeFacts } from './chrome-facts';
import { csvColumnWidths } from './columns';
import { flushCsvPane } from './csv-model';
import { CsvPane } from './CsvPane';
import { createFakeCsvApi, type FakeCsvApi } from './testing';

const PANE = 'DDDDDDDD-0000-4000-8000-0000000000C5';
const SIZE = { width: 800, height: 480 } as const;

function table(rows: number, columns = 4): string[][] {
    const out: string[][] = [Array.from({ length: columns }, (_unused, index) => `h${index}`)];
    for (let row = 1; row < rows; row++) out.push(Array.from({ length: columns }, (_unused, index) => `r${row}c${index}`));
    return out;
}

async function settle(api: FakeCsvApi, rounds = 4): Promise<void> {
    for (let index = 0; index < rounds; index++) {
        await act(async () => {
            await api.settle();
        });
    }
}

interface Mounted {
    readonly api: FakeCsvApi;
    readonly content: ReturnType<typeof createFakeContentApi>;
    editor(): HTMLTextAreaElement;
    cell(view: number, col: number): HTMLElement;
    rerender(editing: boolean): void;
}

async function mount(rows: string[][], options: { phone?: boolean; findToken?: number; editing?: boolean } = {}): Promise<Mounted> {
    const api = createFakeCsvApi(rows);
    const content = createFakeContentApi();
    const draw = (editing: boolean, findToken = options.findToken ?? 0) => (
        <CsvPane
            paneID={PANE}
            csv={api}
            content={content}
            editing={editing}
            focused
            visible
            phone={options.phone}
            findToken={findToken}
            viewportSize={SIZE}
        />
    );
    const view = render(draw(options.editing === true));
    await settle(api);
    return {
        api,
        content,
        editor: () => screen.getByTestId(`csv-editor-${PANE}`) as HTMLTextAreaElement,
        cell: (row, col) => screen.getByTestId(`csv-cell-${row}-${col}`),
        rerender: (editing) => view.rerender(draw(editing))
    };
}

beforeEach(() => {
    csvColumnWidths.clear();
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('the render window', () => {
    it('draws a screenful of a million-row file, with the header row pinned', async () => {
        const m = await mount(table(1_000_000));
        const rows = screen.getAllByRole('row').filter((row) => row.getAttribute('data-testid')?.startsWith('csv-row-'));
        // 456 px of body at 24 px is 19 rows, plus the overscan: nowhere near a million.
        expect(rows.length).toBeGreaterThan(15);
        expect(rows.length).toBeLessThan(40);
        expect(screen.getByTestId('csv-header-0').textContent).toContain('h0');
        // Logical row 0 is the header, so the body starts at view 1, numbered 1.
        expect(screen.queryByTestId('csv-row-0')).toBeNull();
        expect(screen.getByTestId('csv-rownum-1').textContent).toBe('1');
        expect(m.cell(1, 2).textContent).toBe('r1c2');
        expect(screen.getByTestId(`csv-status-rows-${PANE}`).textContent).toBe('999,999 rows × 4 columns');
        // Only the first block was asked for (plus nothing else: the header row is in it).
        expect(m.api.rowRequests.map((request) => request.start)).toEqual([0]);
    });

    it('moves the window with a native scroll and fetches the block it reached', async () => {
        const m = await mount(table(100_000));
        const scroller = screen.getByTestId(`csv-scroller-${PANE}`);
        scroller.scrollTop = 24 * 5000;
        fireEvent.scroll(scroller);
        await settle(m.api);
        expect(screen.queryByTestId('csv-row-1')).toBeNull();
        expect(m.cell(5001, 0).textContent).toBe('r5001c0');
        expect(screen.getByTestId('csv-rownum-5001').textContent).toBe('5,001');
        expect(m.api.rowRequests.map((request) => request.start)).toContain(5000);
        // A row sits at its own content position: the map is the identity under the cap.
        expect(screen.getByTestId('csv-row-5001').style.top).toBe(`${24 + 5000 * 24}px`);
    });

    it('caps the spacer and still reaches the end through Go to row', async () => {
        const m = await mount(table(1_000_000));
        const spacer = screen.getByTestId(`csv-spacer-${PANE}`);
        // 999,999 rows × 24 px is ~24 million px: capped.
        expect(Number.parseInt(spacer.style.height, 10)).toBeLessThanOrEqual(8_000_024);
        const goto = screen.getByTestId(`csv-goto-${PANE}`);
        fireEvent.change(goto, { target: { value: '999,999' } });
        fireEvent.keyDown(goto, { key: 'Enter' });
        await settle(m.api);
        expect(m.cell(999_999, 0).textContent).toBe('r999999c0');
        expect(m.api.rowRequests.some((request) => request.start === 999_900)).toBe(true);
    });

    it('sizes columns from the loaded rows, inside 60-360 px', async () => {
        const rows = table(30, 2);
        rows[3]![1] = 'x'.repeat(200);
        await mount(rows);
        const narrow = Number.parseInt(screen.getByTestId('csv-header-0').style.width, 10);
        const wide = Number.parseInt(screen.getByTestId('csv-header-1').style.width, 10);
        expect(narrow).toBeGreaterThanOrEqual(60);
        expect(wide).toBe(360);
    });

    it('resizes a column by dragging its header edge, and remembers it for the pane', async () => {
        await mount(table(10, 2));
        const before = Number.parseInt(screen.getByTestId('csv-header-0').style.width, 10);
        const handle = screen.getByTestId('csv-resize-0');
        // jsdom has no PointerEvent; `firePointer` dispatches pointer-named MouseEvents.
        act(() => {
            firePointer(handle, 'pointerdown', { clientX: 100 });
            firePointer(handle, 'pointermove', { clientX: 180 });
            firePointer(handle, 'pointerup', { clientX: 180 });
        });
        expect(Number.parseInt(screen.getByTestId('csv-header-0').style.width, 10)).toBe(before + 80);
        // A drag is not a click on the header: nothing was sorted.
        expect(screen.queryByTestId('csv-sort-indicator-0')).toBeNull();
        cleanup();
        await mount(table(10, 2));
        expect(Number.parseInt(screen.getByTestId('csv-header-0').style.width, 10)).toBe(before + 80);
    });

    it('marks a multi-line cell rather than drawing its lines', async () => {
        const rows = table(5, 2);
        rows[2]![0] = 'first line\nsecond line';
        const m = await mount(rows);
        expect(m.cell(2, 0).textContent).toBe('first line ↵');
    });
});

describe('the header row', () => {
    it('draws letters and puts row 0 in the body when the header row is off', async () => {
        const m = await mount(table(20));
        const toggle = m.api;
        await act(async () => {
            await toggle.setHeaderRow(PANE, false);
        });
        await settle(m.api);
        expect(screen.getByTestId('csv-header-0').textContent).toBe('A');
        expect(screen.getByTestId('csv-header-3').textContent).toBe('D');
        expect(m.cell(0, 0).textContent).toBe('h0');
        expect(screen.getByTestId(`csv-header-row-${PANE}`).getAttribute('data-header-row')).toBe('false');
    });

    it('publishes the header-row flag and the raw-text facts for the pane header', async () => {
        const m = await mount(table(20));
        expect(csvChromeFacts(PANE)).toEqual({ rawEditable: true, rawUnavailableReason: null, headerRow: true, canUndo: false, canRedo: false });
        m.api.overrides = { rawEditable: false, bytes: 3 * 1024 * 1024 };
        m.api.touch();
        act(() => m.api.push(PANE));
        await settle(m.api);
        expect(csvChromeFacts(PANE)?.rawUnavailableReason).toBe('Raw text (⌘E) is only available for files up to 2 MiB');
        cleanup();
        expect(csvChromeFacts(PANE)).toBeNull();
    });
});

describe('keyboard editing', () => {
    it('starts an edit by typing, commits on Return and moves down', async () => {
        const m = await mount(table(20));
        const editor = m.editor();
        act(() => editor.focus());
        fireEvent.keyDown(editor, { key: 'ArrowRight' });
        fireEvent.input(editor, { target: { value: 'x' } });
        expect(editor.getAttribute('data-editing')).toBe('true');
        fireEvent.input(editor, { target: { value: 'xy' } });
        fireEvent.keyDown(editor, { key: 'Enter' });
        expect(m.api.edits.at(-1)).toEqual({ paneID: PANE, generation: 'inc-1:0', ops: [{ op: 'set-cell', row: 1, column: 1, value: 'xy' }] });
        expect(editor.getAttribute('data-editing')).toBe('false');
        // Shown at once, before the daemon answers.
        expect(m.cell(1, 1).textContent).toBe('xy');
        // The selection moved down to row 2.
        expect(m.cell(2, 1).style.boxShadow).toContain('inset');
        await settle(m.api);
        expect(m.cell(1, 1).getAttribute('data-pending')).toBeNull();
    });

    it('edits the cell’s value with Return, inserts a newline with ⌥Return, and Tab commits and moves right', async () => {
        const m = await mount(table(20));
        const editor = m.editor();
        fireEvent.keyDown(editor, { key: 'Enter' });
        expect(editor.value).toBe('r1c0');
        fireEvent.keyDown(editor, { key: 'Enter', altKey: true });
        expect(editor.value).toBe('r1c0\n');
        fireEvent.input(editor, { target: { value: 'r1c0\nmore' } });
        fireEvent.keyDown(editor, { key: 'Tab' });
        expect(m.api.edits.at(-1)?.ops).toEqual([{ op: 'set-cell', row: 1, column: 0, value: 'r1c0\nmore' }]);
        expect(m.cell(1, 1).style.boxShadow).toContain('inset');
        // ⇧Tab goes back.
        fireEvent.keyDown(editor, { key: 'Tab', shiftKey: true });
        expect(m.cell(1, 0).style.boxShadow).toContain('inset');
    });

    it('cancels with Escape and sends nothing; F2 edits; Delete clears', async () => {
        const m = await mount(table(20));
        const editor = m.editor();
        fireEvent.keyDown(editor, { key: 'F2' });
        fireEvent.input(editor, { target: { value: 'never sent' } });
        fireEvent.keyDown(editor, { key: 'Escape' });
        expect(editor.getAttribute('data-editing')).toBe('false');
        expect(m.api.edits).toEqual([]);
        fireEvent.keyDown(editor, { key: 'Delete' });
        expect(m.api.edits.at(-1)?.ops).toEqual([{ op: 'set-cell', row: 1, column: 0, value: '' }]);
    });

    it('moves with arrows, Home/End and ⌘↑/⌘↓, and sends undo/redo for ⌘Z/⌘⇧Z', async () => {
        const m = await mount(table(50));
        const editor = m.editor();
        fireEvent.keyDown(editor, { key: 'End' });
        expect(m.cell(1, 3).style.boxShadow).toContain('inset');
        fireEvent.keyDown(editor, { key: 'Home' });
        fireEvent.keyDown(editor, { key: 'ArrowDown', metaKey: true });
        await settle(m.api);
        expect(m.cell(49, 0).style.boxShadow).toContain('inset');
        fireEvent.keyDown(editor, { key: 'ArrowUp', metaKey: true });
        await settle(m.api);
        expect(m.cell(1, 0).style.boxShadow).toContain('inset');
        fireEvent.keyDown(editor, { key: 'z', metaKey: true });
        fireEvent.keyDown(editor, { key: 'z', metaKey: true, shiftKey: true });
        // One batch in flight: redo waits for undo's answer.
        expect(m.api.edits.map((edit) => edit.ops[0]?.op)).toEqual(['undo']);
        await settle(m.api);
        expect(m.api.edits.map((edit) => edit.ops[0]?.op)).toEqual(['undo', 'redo']);
    });

    it('refuses to edit a read-only file and says why', async () => {
        const rows = table(20);
        const m = await mount(rows);
        m.api.overrides = { readOnly: { code: 'not-utf8', message: 'The file is not valid UTF-8.' } };
        m.api.touch();
        act(() => m.api.push(PANE));
        await settle(m.api);
        const editor = m.editor();
        fireEvent.keyDown(editor, { key: 'Enter' });
        expect(editor.getAttribute('data-editing')).toBe('false');
        expect(screen.getByTestId(`csv-status-notice-${PANE}`).textContent).toBe('Read-only: The file is not valid UTF-8.');
        expect(screen.getByTestId(`csv-status-readonly-${PANE}`).textContent).toContain('not valid UTF-8');
        expect(m.api.edits).toEqual([]);
    });

    it('waits for indexing to finish, saying so in the status line', async () => {
        const m = await mount(table(20));
        m.api.overrides = { scanning: { rows: 1_234_567, bytes: 50, totalBytes: 100 } };
        m.api.touch();
        act(() => m.api.push(PANE));
        await settle(m.api);
        expect(screen.getByTestId(`csv-status-rows-${PANE}`).textContent).toBe('Indexing… 1,234,567 rows (50%)');
        const editor = m.editor();
        fireEvent.keyDown(editor, { key: 'Enter' });
        expect(editor.getAttribute('data-editing')).toBe('false');
        expect(screen.getByTestId(`csv-status-notice-${PANE}`).textContent).toBe('Editing is available once indexing finishes.');
    });

    it('leaves a cell the daemon sent cut short read-only', async () => {
        const rows = table(5, 2);
        rows[1]![0] = 'y'.repeat(50);
        const api = createFakeCsvApi(rows);
        api.truncateAt = 10;
        const content = createFakeContentApi();
        render(<CsvPane paneID={PANE} csv={api} content={content} editing={false} focused visible viewportSize={SIZE} />);
        await settle(api);
        expect(screen.getByTestId('csv-cell-1-0').textContent).toBe('yyyyyyyyyy…');
        const editor = screen.getByTestId(`csv-editor-${PANE}`) as HTMLTextAreaElement;
        fireEvent.keyDown(editor, { key: 'Enter' });
        expect(editor.getAttribute('data-editing')).toBe('false');
        expect(screen.getByTestId(`csv-status-notice-${PANE}`).textContent).toContain('too long to edit in the grid');
    });

    it('carries the pane surface marker, so the window’s chords still reach the app', async () => {
        const m = await mount(table(5));
        expect(m.editor().closest('[data-pane-surface]')).not.toBeNull();
    });
});

describe('paste and copy', () => {
    it('fills a TSV block as one batch, clamped to the table', async () => {
        const m = await mount(table(4, 3));
        const editor = m.editor();
        // Select row 2, column 1.
        fireEvent.keyDown(editor, { key: 'ArrowDown' });
        fireEvent.keyDown(editor, { key: 'ArrowRight' });
        fireEvent.paste(editor, { clipboardData: { getData: () => 'a\tb\tc\nd\te\tf\ng\th\ti\n' } });
        await settle(m.api);
        expect(m.api.edits).toHaveLength(1);
        // Two rows (2, 3) and two columns (1, 2) fit; the rest is clamped.
        expect(m.api.edits[0]!.ops).toEqual([
            { op: 'set-cell', row: 2, column: 1, value: 'a' },
            { op: 'set-cell', row: 2, column: 2, value: 'b' },
            { op: 'set-cell', row: 3, column: 1, value: 'd' },
            { op: 'set-cell', row: 3, column: 2, value: 'e' }
        ]);
        expect(screen.getByTestId(`csv-status-notice-${PANE}`).textContent).toBe('Pasted 2 × 2; the rest did not fit the table.');
    });

    it('copies the selected cell', async () => {
        const m = await mount(table(4, 3));
        const editor = m.editor();
        const setData = vi.fn();
        fireEvent.copy(editor, { clipboardData: { setData } });
        expect(setData).toHaveBeenCalledWith('text/plain', 'r1c0');
    });

    it('copies a multi-line, tabbed or quoted value as one TSV field, so pasting it puts back exactly that value', async () => {
        const rows = table(6, 3);
        rows[1]![0] = 'line1\nline2';
        rows[2]![0] = 'a\tb';
        rows[3]![0] = '"x"';
        const m = await mount(rows);
        const editor = m.editor();
        for (const view of [1, 2, 3]) {
            fireEvent.mouseDown(m.cell(view, 0), { button: 0 });
            let copied = '';
            fireEvent.copy(editor, { clipboardData: { setData: (_type: string, value: string) => { copied = value; } } });
            fireEvent.mouseDown(m.cell(5, 2), { button: 0 });
            fireEvent.paste(editor, { clipboardData: { getData: () => copied } });
            await settle(m.api);
            expect(m.api.edits.at(-1)?.ops).toEqual([{ op: 'set-cell', row: 5, column: 2, value: rows[view]![0] }]);
        }
    });
});

describe('the context menu', () => {
    it('inserts and deletes rows and columns at the right logical places', async () => {
        const m = await mount(table(10, 3));
        fireEvent.contextMenu(m.cell(4, 1), { clientX: 40, clientY: 50 });
        expect(screen.getByTestId('context-menu')).toBeTruthy();
        fireEvent.click(screen.getByText('Insert row above'));
        expect(m.api.edits.at(-1)?.ops).toEqual([{ op: 'insert-rows', at: 4, count: 1 }]);
        await settle(m.api);

        fireEvent.contextMenu(m.cell(4, 1), { clientX: 40, clientY: 50 });
        fireEvent.click(screen.getByText('Insert column right'));
        expect(m.api.edits.at(-1)?.ops).toEqual([{ op: 'insert-column', at: 2 }]);
        await settle(m.api);

        fireEvent.contextMenu(m.cell(4, 0), { clientX: 40, clientY: 50 });
        fireEvent.click(screen.getByText('Delete column'));
        expect(m.api.edits.at(-1)?.ops).toEqual([{ op: 'delete-column', column: 0 }]);
        await settle(m.api);

        fireEvent.contextMenu(m.cell(3, 0), { clientX: 40, clientY: 50 });
        fireEvent.click(screen.getByText('Delete row'));
        expect(m.api.edits.at(-1)?.ops).toEqual([{ op: 'delete-rows', start: 3, count: 1 }]);
    });

    it('warns that deleting a column of a file over 32 MiB cannot be undone', async () => {
        const m = await mount(table(10, 2));
        fireEvent.contextMenu(m.cell(2, 0), { clientX: 10, clientY: 10 });
        expect(screen.getByText('Delete column')).toBeTruthy();
        fireEvent.keyDown(document, { key: 'Escape' });
        m.api.overrides = { bytes: 33 * 1024 * 1024 };
        m.api.touch();
        act(() => m.api.push(PANE));
        await settle(m.api);
        fireEvent.contextMenu(m.cell(2, 0), { clientX: 10, clientY: 10 });
        expect(screen.getByText("Delete column (can't be undone)")).toBeTruthy();
    });

    it('offers the first row and column on an empty file', async () => {
        const m = await mount([]);
        fireEvent.contextMenu(screen.getByTestId(`csv-spacer-${PANE}`), { clientX: 10, clientY: 10 });
        fireEvent.click(screen.getByText('Insert column'));
        expect(m.api.edits.at(-1)?.ops).toEqual([{ op: 'insert-column', at: 0 }]);
    });

    it('gives a file that is only its header row a first data row, from empty space or the header', async () => {
        const m = await mount([['id', 'name']]);
        fireEvent.contextMenu(screen.getByTestId(`csv-spacer-${PANE}`), { clientX: 10, clientY: 10 });
        fireEvent.click(screen.getByText('Insert row'));
        expect(m.api.edits.at(-1)?.ops).toEqual([{ op: 'insert-rows', at: 1, count: 1 }]);
        await settle(m.api);
        fireEvent.contextMenu(screen.getByTestId('csv-header-1'), { clientX: 10, clientY: 10 });
        expect(screen.queryByText('Insert row above')).toBeNull();
        fireEvent.click(screen.getByText('Insert row below'));
        expect(m.api.edits.at(-1)?.ops).toEqual([{ op: 'insert-rows', at: 1, count: 1 }]);
    });

    it('opens on the header too, with the sort and header-row items', async () => {
        const m = await mount(table(10, 3));
        fireEvent.contextMenu(screen.getByTestId('csv-header-1'), { clientX: 10, clientY: 10 });
        expect(screen.queryByText('Insert row above')).toBeNull();
        fireEvent.click(screen.getByText('Sort descending'));
        await settle(m.api);
        expect(m.api.sorts.at(-1)).toEqual({ paneID: PANE, column: 1, direction: 'desc' });
    });
});

describe('sorting', () => {
    it('cycles a header click through ascending, descending and off, with an indicator', async () => {
        const m = await mount([['name', 'n'], ['b', '2'], ['c', '3'], ['a', '1']]);
        const header = (): HTMLElement => screen.getByTestId('csv-header-0');
        fireEvent.click(header());
        await settle(m.api);
        expect(m.api.sorts.at(-1)).toMatchObject({ column: 0, direction: 'asc' });
        expect(screen.getByTestId('csv-sort-indicator-0').textContent).toBe('▲');
        expect(m.cell(1, 0).textContent).toBe('a');
        fireEvent.click(header());
        await settle(m.api);
        expect(m.api.sorts.at(-1)).toMatchObject({ column: 0, direction: 'desc' });
        expect(screen.getByTestId('csv-sort-indicator-0').textContent).toBe('▼');
        fireEvent.click(header());
        await settle(m.api);
        expect(m.api.sorts.at(-1)).toMatchObject({ column: null });
        expect(screen.queryByTestId('csv-sort-indicator-0')).toBeNull();
    });

    it('does not pull the view back to the selected row once the person has scrolled after a sort', async () => {
        const m = await mount(table(1000, 2));
        const scroller = screen.getByTestId(`csv-scroller-${PANE}`);
        fireEvent.mouseDown(m.cell(5, 0), { button: 0 });
        m.api.holdRows = true;
        // Descending: logical row 5 ('r5c0') lands at view 995, in a block not fetched yet.
        fireEvent.click(screen.getByTestId('csv-header-0'));
        await settle(m.api);
        scroller.scrollTop = 24 * 899;
        fireEvent.scroll(scroller);
        m.api.holdRows = false;
        await act(async () => {
            await m.api.releaseRows();
        });
        await settle(m.api);
        // The block holding view 995 arrived with the window the person scrolled to; the view
        // stays where they put it.
        expect(m.api.rowRequests.some((request) => request.start === 900)).toBe(true);
        expect(scroller.scrollTop).toBe(24 * 899);
    });

    it('keeps the selection on the same logical row when the order changes', async () => {
        const m = await mount([['name'], ['c'], ['a'], ['b']]);
        const editor = m.editor();
        // Select row 1 ('c').
        expect(m.cell(1, 0).style.boxShadow).toContain('inset');
        fireEvent.click(screen.getByTestId('csv-header-0'));
        await settle(m.api);
        // Sorted: a, b, c - 'c' is view 3 now, and the selection followed it.
        expect(m.cell(3, 0).textContent).toBe('c');
        expect(m.cell(3, 0).style.boxShadow).toContain('inset');
        void editor;
    });
});

describe('find', () => {
    it('opens on ⌘F, counts with csv-find and steps with csv-find-step', async () => {
        const rows = table(30, 2);
        rows[5]![1] = 'needle here';
        rows[9]![0] = 'another NEEDLE';
        const m = await mount(rows);
        m.rerender(false);
        cleanup();
        const api = m.api;
        const content = createFakeContentApi();
        const draw = (token: number) => <CsvPane paneID={PANE} csv={api} content={content} editing={false} focused visible findToken={token} viewportSize={SIZE} />;
        const view = render(draw(0));
        await settle(api);
        view.rerender(draw(1));
        const input = screen.getByTestId(`content-find-input-${PANE}`);
        fireEvent.change(input, { target: { value: 'needle' } });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
        });
        await settle(api);
        expect(api.finds).toEqual(['needle']);
        expect(api.steps[0]).toEqual({ query: 'needle', direction: 'next', from: null });
        expect(screen.getByTestId(`content-find-count-${PANE}`).textContent).toBe('1/2');
        expect(screen.getByTestId(`csv-cell-5-1`).style.boxShadow).toContain('inset');
        fireEvent.keyDown(input, { key: 'Enter' });
        await settle(api);
        expect(api.steps[1]).toEqual({ query: 'needle', direction: 'next', from: { view: 5, column: 1 } });
        expect(screen.getByTestId(`content-find-count-${PANE}`).textContent).toBe('2/2');
        expect(screen.getByTestId(`csv-cell-9-0`).style.boxShadow).toContain('inset');
        fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
        await settle(api);
        expect(api.steps[2]).toMatchObject({ direction: 'previous', from: { view: 9, column: 0 } });
        // Escape closes it and gives the grid its caret back.
        fireEvent.keyDown(input, { key: 'Escape' });
        expect(screen.queryByTestId(`content-find-input-${PANE}`)).toBeNull();
        expect(document.activeElement).toBe(screen.getByTestId(`csv-editor-${PANE}`));
    });
});

describe('a file that cannot open', () => {
    it('shows the daemon’s reason and no grid', async () => {
        const api = createFakeCsvApi([]);
        api.overrides = { incarnation: 'unopened', generation: '', loaded: false, error: 'No such file: /repo/gone.csv' };
        render(<CsvPane paneID={PANE} csv={api} content={createFakeContentApi()} editing={false} focused visible viewportSize={SIZE} />);
        await settle(api);
        expect(screen.queryByTestId(`csv-grid-${PANE}`)).toBeNull();
        expect(document.body.textContent).toContain('No such file: /repo/gone.csv');
    });

    it('shows the daemon’s one-off notice in the status line', async () => {
        const m = await mount(table(5));
        m.api.overrides = { notice: 'The file changed on disk; 3 unsaved edits were discarded.' };
        m.api.touch();
        act(() => m.api.push(PANE));
        await settle(m.api);
        expect(screen.getByTestId(`csv-status-notice-${PANE}`).textContent).toBe('The file changed on disk; 3 unsaved edits were discarded.');
    });
});

describe('raw text mode', () => {
    it('never subscribes to the content service in grid mode, and does in raw mode', async () => {
        const m = await mount(table(10));
        expect(m.content.subscribes).toEqual([]);
        expect(screen.getByTestId(`csv-grid-${PANE}`)).toBeTruthy();
        m.rerender(true);
        expect(m.content.subscribes).toEqual([PANE]);
        // Nothing to type into until the daemon says it is editing.
        expect(screen.queryByRole('textbox')).toBeNull();
        act(() => m.content.push(contentState({ paneID: PANE, type: 'csv', mode: 'edit', html: null, text: 'a,b\n1,2\n' })));
        expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('a,b\n1,2\n');
        m.rerender(false);
        expect(m.content.unsubscribes).toEqual([PANE]);
        await settle(m.api);
        expect(screen.getByTestId(`csv-grid-${PANE}`)).toBeTruthy();
    });

    it('commits an edit in progress before ⌘E hands the file to raw text', async () => {
        const m = await mount(table(10));
        const editor = m.editor();
        fireEvent.input(editor, { target: { value: 'kept' } });
        // What ⌘E waits on before it sends `markdown-set-mode` (App's toggle, DocumentPane's).
        await act(async () => {
            await flushCsvPane(PANE);
        });
        expect(m.api.edits.at(-1)?.ops).toEqual([{ op: 'set-cell', row: 1, column: 0, value: 'kept' }]);
        // The daemon shows raw text now and refuses any grid edit, as it really does.
        m.api.rawMode = true;
        m.rerender(true);
        await settle(m.api);
        expect(m.api.table[1]![0]).toBe('kept');
        expect(m.api.failures).toEqual([]);
    });

    it('reports a grid edit the daemon refused after the pane went to raw text (another client’s ⌘E)', async () => {
        const m = await mount(table(10));
        fireEvent.input(m.editor(), { target: { value: 'late' } });
        m.api.rawMode = true;
        m.rerender(true);
        await settle(m.api);
        expect(m.api.table[1]![0]).toBe('r1c0');
        expect(m.api.failures).toEqual(['An edit made in the table was not saved. This pane is showing raw text.']);
    });
});

describe('on a phone', () => {
    function tap(node: Element, x = 20, y = 30): void {
        fireEvent.touchStart(node, { touches: [{ clientX: x, clientY: y }] });
        fireEvent.touchEnd(node, { changedTouches: [{ clientX: x, clientY: y }] });
    }

    it('selects on a tap and edits on a tap of the selected cell, focusing inside the gesture', async () => {
        const m = await mount(table(10), { phone: true });
        const editor = m.editor();
        // No caret was claimed on mount: a keyboard nobody asked for is half the screen.
        expect(document.activeElement).not.toBe(editor);
        const focus = vi.spyOn(editor, 'focus');
        tap(m.cell(3, 2));
        expect(m.cell(3, 2).style.boxShadow).toContain('inset');
        expect(focus).not.toHaveBeenCalled();
        expect(editor.getAttribute('data-editing')).toBe('false');
        tap(m.cell(3, 2));
        // Synchronously, inside the touch handler: no await between the tap and the focus.
        expect(focus).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(editor);
        expect(editor.getAttribute('data-editing')).toBe('true');
        expect(editor.value).toBe('r3c2');
    });

    it('opens the same menu on a long press, at the touch point', async () => {
        const m = await mount(table(10), { phone: true });
        vi.useFakeTimers();
        fireEvent.touchStart(m.cell(2, 1), { touches: [{ clientX: 120, clientY: 90 }] });
        act(() => {
            vi.advanceTimersByTime(499);
        });
        expect(screen.queryByTestId('context-menu')).toBeNull();
        act(() => {
            vi.advanceTimersByTime(1);
        });
        expect(screen.getByTestId('context-menu')).toBeTruthy();
        expect(screen.getByText('Insert row above')).toBeTruthy();
        fireEvent.touchEnd(m.cell(2, 1), { changedTouches: [{ clientX: 120, clientY: 90 }] });
        // The press did not also count as a tap that starts an edit.
        expect(m.editor().getAttribute('data-editing')).toBe('false');
    });

    it('does not long-press once the finger moved past the slop (a scroll)', async () => {
        const m = await mount(table(10), { phone: true });
        vi.useFakeTimers();
        fireEvent.touchStart(m.cell(2, 1), { touches: [{ clientX: 120, clientY: 90 }] });
        fireEvent.touchMove(m.cell(2, 1), { touches: [{ clientX: 120, clientY: 120 }] });
        act(() => {
            vi.advanceTimersByTime(600);
        });
        expect(screen.queryByTestId('context-menu')).toBeNull();
    });

    it('puts undo and the header-row toggle in reach, and a scrubber on a huge file', async () => {
        const m = await mount(table(500_000), { phone: true });
        fireEvent.click(screen.getByTestId(`csv-header-toggle-${PANE}`));
        await settle(m.api);
        expect(m.api.headerRows).toEqual([false]);
        expect(screen.getByTestId(`csv-undo-${PANE}`)).toBeTruthy();
        expect(screen.getByTestId(`csv-scrubber-${PANE}`)).toBeTruthy();
    });
});
