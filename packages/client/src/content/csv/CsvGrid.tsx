/**
 * The csv pane's grid (#324, docs/csv-pane.md, plan §5): a virtualised, editable table over a
 * file the daemon serves by row range.
 *
 * ## Layout
 *
 * One native scroller, both axes. Inside it a spacer as wide as every column and as tall as the
 * body (capped and mapped past 8,000,000 px by `scroll-map.ts`), and in the spacer:
 *
 *   - the HEADER row, `position: sticky; top: 0`: labels from logical row 0 when the pane treats
 *     it as headers (and then row 0 is not drawn in the body), spreadsheet letters otherwise;
 *   - the visible body rows, absolutely positioned at `rowTop - offset`, each with a
 *     `position: sticky; left: 0` row-number cell, and only the visible columns (horizontal
 *     windowing, so a 5,000-column file draws a screenful);
 *   - ONE `<textarea>`, always mounted over the selected cell. It is the grid's keyboard on a
 *     desktop (typing into it starts an edit, which is what makes "just type" work), and on a
 *     phone it is what a tap on the selected cell focuses synchronously inside the gesture, which
 *     is the only way iOS and Android raise the software keyboard.
 *
 * `overflow-anchor: none`, because rows are absolutely positioned and the browser's scroll
 * anchoring would otherwise "correct" the position every time a row above the fold changes.
 *
 * ## Keys (desktop)
 *
 * Arrows, Home/End, PageUp/PageDown, ⌘↑/⌘↓ (and ⌘←/⌘→) move the selection. Return, F2, a
 * double-click or typing edits; ⌥Return inserts a newline; Return commits and moves down
 * (⇧Return up); Tab/⇧Tab commit and move right/left; Escape cancels. Delete/Backspace clear the
 * cell; ⌘Z/⌘⇧Z are the daemon's undo/redo; ⌘C copies the cell and ⌘V pastes, a TSV block filling
 * the cells under it as one batch. The container carries `PANE_SURFACE_ATTR`, so the window's
 * chords (⌘F, ⌘E, ⌘D…) still reach the app while the textarea holds the caret (`chrome/keys.ts`).
 *
 * ## Touch (phone and tablets)
 *
 * Native momentum scrolling with the header and row numbers pinned. A tap selects; a tap on the
 * selected cell edits; a long press (500 ms inside 8 px, `terminal/touch-scroll.ts`'s numbers)
 * opens the same menu a right-click does, at the touch point. Nothing focuses the textarea
 * except a gesture (`mayClaimPaneCaret`): a keyboard nobody asked for is half the screen.
 */

import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
    type ClipboardEvent,
    type CSSProperties,
    type KeyboardEvent,
    type MouseEvent,
    type PointerEvent as ReactPointerEvent,
    type ReactElement,
    type RefObject,
    type TouchEvent
} from 'react';

import { PANE_SURFACE_ATTR, armCaretClaim, mayClaimPaneCaret } from '../../app/pane-focus';
import { ContextMenu, type MenuItemSpec } from '../../chrome/ContextMenu';
import { tokens } from '../../chrome/tokens';
import { PaneSearchOverlay } from '../../grid/PaneSearchOverlay';
import { LONG_PRESS_MS, TOUCH_SLOP_PX } from '../../terminal/touch-scroll';
import { resolveFindPalette, type FindPalette } from '../bridge';
import { CONTENT_FIND_BAR_OFFSET } from '../ContentFrame';
import { contentPaneLabel } from '../labels';
import { clipboardCellText, parseClipboardTable } from './clipboard';
import {
    autoColumnWidth,
    canvasMeasure,
    rowNumberColumnWidth,
    cellDisplayText,
    columnLetter,
    columnOffsets,
    csvColumnWidths,
    visibleColumns
} from './columns';
import type { CsvCellView, CsvPaneModel } from './csv-model';
import { SCROLL_MAP_IDLE_MS, createScrollMap, visibleRows } from './scroll-map';
import {
    cellEditBlockReason,
    deleteClearsUndo,
    formatCount,
    scanningText,
    structureBlockReason
} from './state-text';
import type { CsvFindStepReply, CsvPaneState } from './types';

export const CSV_ROW_PX = 24;
/** A finger needs a taller target than a pointer. */
export const CSV_PHONE_ROW_PX = 32;
export const CSV_OVERSCAN_ROWS = 8;
export const CSV_OVERSCAN_COLUMNS = 2;
export const CSV_DEFAULT_COLUMN_PX = 120;
/** Keystrokes coalesce for this long before a `csv-find` goes out. */
export const CSV_FIND_DEBOUNCE_MS = 150;
/** Show the phone scrubber once the body is this many viewports tall. */
export const CSV_SCRUBBER_MIN_VIEWPORTS = 20;
/** What jsdom (and a not-yet-laid-out pane) measures as 0. */
const FALLBACK_SIZE = { width: 800, height: 480 } as const;
const STATUS_PX = 24;
const FONT = 'ui-monospace, SFMono-Regular, Menlo, monospace';
/** Header labels are bold, so measure everything in the wider weight. */
const measureCell = canvasMeasure(`600 12px ${FONT}`);
/** Row numbers are drawn in the rows' own regular 12 px. */
const measureRowNumber = canvasMeasure(`12px ${FONT}`);

export interface CsvGridProps {
    readonly paneID: string;
    readonly model: CsvPaneModel;
    readonly filePath?: string | null | undefined;
    readonly focused?: boolean | undefined;
    readonly visible?: boolean | undefined;
    /** The pane container's fill (may carry the ghostty opacity). */
    readonly background?: string | undefined;
    /** The phone form factor: touch-first, no unrequested caret, the scrubber. */
    readonly phone?: boolean | undefined;
    /** Bump to open the find bar (the app's `toggle_search`). */
    readonly findToken?: number | undefined;
    readonly findPalette?: Partial<FindPalette> | undefined;
    readonly onFocusRequest?: ((paneID: string) => void) | undefined;
    /** Test seam: the size jsdom cannot measure. */
    readonly viewportSize?: { readonly width: number; readonly height: number } | undefined;
}

interface Selection {
    readonly view: number;
    readonly col: number;
}

interface EditSession {
    readonly view: number;
    readonly col: number;
    readonly row: number;
    readonly column: number;
    readonly generation: string;
    readonly original: string;
}

interface MenuState {
    readonly x: number;
    readonly y: number;
    readonly view: number;
    readonly col: number;
    readonly header: boolean;
    /** An empty table: no cell to anchor on, only the first row or column to add. */
    readonly empty?: boolean | undefined;
}

interface FindState {
    readonly open: boolean;
    readonly seq: number;
    readonly needle: string;
    readonly total: number | null;
    /** 1-based, as the daemon counts. */
    readonly index: number | null;
    readonly match: Selection | null;
}

type Target = { readonly kind: 'cell'; readonly view: number; readonly col: number } | { readonly kind: 'header'; readonly col: number } | { readonly kind: 'rownum'; readonly view: number };

/** Which grid element an event landed on, read off the data attributes the cells carry. */
function targetOf(node: EventTarget | null): Target | null {
    const element = node as { closest?: (selector: string) => Element | null } | null;
    if (element === null || typeof element.closest !== 'function') return null;
    const hit = element.closest('[data-csv-view], [data-csv-header], [data-csv-rownum]');
    if (hit === null) return null;
    const header = hit.getAttribute('data-csv-header');
    if (header !== null) return { kind: 'header', col: Number(header) };
    const rownum = hit.getAttribute('data-csv-rownum');
    if (rownum !== null) return { kind: 'rownum', view: Number(rownum) };
    return { kind: 'cell', view: Number(hit.getAttribute('data-csv-view')), col: Number(hit.getAttribute('data-csv-col')) };
}

function useModelVersion(model: CsvPaneModel): number {
    return useSyncExternalStore(model.subscribe, model.getVersion, model.getVersion);
}

const sameSelection = (a: Selection | null, b: Selection | null): boolean =>
    a !== null && b !== null && a.view === b.view && a.col === b.col;

export function CsvGrid(props: CsvGridProps): ReactElement {
    const { paneID, model } = props;
    const phone = props.phone === true;
    const modelVersion = useModelVersion(model);
    const state = model.state();

    const rowPx = phone ? CSV_PHONE_ROW_PX : CSV_ROW_PX;
    const headerPx = rowPx;
    const rowCount = state?.rowCount ?? 0;
    const columns = state?.columns ?? EMPTY_COLUMNS;
    const headerRow = state?.headerRow ?? true;
    const bodyStart = headerRow && rowCount > 0 ? 1 : 0;
    const bodyCount = Math.max(0, rowCount - bodyStart);

    // ── size ───────────────────────────────────────────────────────────────────────
    const rootRef = useRef<HTMLDivElement | null>(null);
    const scrollerRef = useRef<HTMLDivElement | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const gotoRef = useRef<HTMLInputElement | null>(null);
    const [measured, setMeasured] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
    useLayoutEffect(() => {
        const scroller = scrollerRef.current;
        if (scroller === null) return;
        const measure = (): void => {
            setMeasured((previous) =>
                previous.width === scroller.clientWidth && previous.height === scroller.clientHeight
                    ? previous
                    : { width: scroller.clientWidth, height: scroller.clientHeight }
            );
        };
        measure();
        const Observer = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
        if (Observer === undefined) {
            globalThis.addEventListener?.('resize', measure);
            return () => globalThis.removeEventListener?.('resize', measure);
        }
        const observer = new Observer(measure);
        observer.observe(scroller);
        return () => observer.disconnect();
    }, []);
    const size = props.viewportSize ?? {
        width: measured.width > 0 ? measured.width : FALLBACK_SIZE.width,
        height: measured.height > 0 ? measured.height : FALLBACK_SIZE.height
    };
    const bodyViewportPx = Math.max(rowPx, size.height - headerPx);

    // ── columns ────────────────────────────────────────────────────────────────────
    const [widthsVersion, setWidthsVersion] = useState(0);
    const widths = useMemo(
        () => columns.map((id) => csvColumnWidths.get(paneID, id) ?? CSV_DEFAULT_COLUMN_PX),
        // `widthsVersion` is the store's change signal.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [columns, paneID, widthsVersion]
    );
    const offsets = useMemo(() => columnOffsets(widths), [widths]);
    const rowNumberPx = useMemo(() => rowNumberColumnWidth(formatCount(Math.max(bodyCount, 1)), measureRowNumber), [bodyCount]);
    const totalWidth = rowNumberPx + (offsets[offsets.length - 1] ?? 0);

    // ── vertical scroll mapping ────────────────────────────────────────────────────
    const mapRef = useRef(createScrollMap());
    const map = mapRef.current;
    map.configure(bodyCount * rowPx, bodyViewportPx);
    const [scroll, setScroll] = useState({ top: 0, left: 0 });
    const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => {
        if (idleTimer.current !== null) clearTimeout(idleTimer.current);
    }, []);
    const snapshot = map.snapshot();

    /** The offset the grid itself last scrolled to, so its own scroll event is not the user's. */
    const programmaticTop = useRef<number | null>(null);
    const applyPhysical = useCallback((physical: number): void => {
        const scroller = scrollerRef.current;
        programmaticTop.current = physical;
        if (scroller !== null) scroller.scrollTop = physical;
        setScroll((previous) => ({ top: physical, left: scroller?.scrollLeft ?? previous.left }));
    }, []);

    const onScroll = (): void => {
        const scroller = scrollerRef.current;
        if (scroller === null) return;
        // The person scrolled after a re-sort: the selection no longer chases its old row.
        if (scroller.scrollTop !== programmaticTop.current) pendingAnchor.current = null;
        programmaticTop.current = null;
        map.onScroll(scroller.scrollTop);
        setScroll({ top: scroller.scrollTop, left: scroller.scrollLeft });
        if (idleTimer.current !== null) clearTimeout(idleTimer.current);
        idleTimer.current = setTimeout(() => {
            idleTimer.current = null;
            const target = mapRef.current.recentre();
            if (target !== null) applyPhysical(target);
        }, SCROLL_MAP_IDLE_MS);
    };

    const scrollLeftTo = (left: number): void => {
        const scroller = scrollerRef.current;
        if (scroller !== null) scroller.scrollLeft = left;
        setScroll((previous) => ({ top: previous.top, left }));
    };

    // ── windows ────────────────────────────────────────────────────────────────────
    const body = visibleRows(snapshot.virtual, bodyViewportPx, rowPx, bodyCount, CSV_OVERSCAN_ROWS);
    const cols = visibleColumns(offsets, scroll.left, size.width - rowNumberPx, CSV_OVERSCAN_COLUMNS);
    const viewStart = body.start + bodyStart;
    const viewEnd = body.end + bodyStart;
    useEffect(() => {
        model.setViewport({
            rowStart: viewStart,
            rowEnd: viewEnd,
            colStart: cols.start,
            colEnd: cols.end,
            pinnedRows: bodyStart === 1 ? [0] : []
        });
    }, [model, viewStart, viewEnd, cols.start, cols.end, bodyStart]);

    /*
     * Auto widths from the header label and the rows on screen. They only ever GROW: the first
     * rows of a file are often its shortest (ids, counters), and while the file is still being
     * indexed its last record is not on screen yet, so a width fixed from the first window cut
     * later values short. Growing never moves a column the person dragged (manual wins), and a
     * column never narrows under them as they scroll. Each column re-measures only when the
     * loaded window it would sample has changed.
     */
    const measuredWindow = useRef(new Map<number, string>());
    useLayoutEffect(() => {
        let changed = false;
        const sampleEnd = Math.min(viewEnd, viewStart + 60);
        for (let col = cols.start; col < cols.end; col++) {
            const id = columns[col];
            if (id === undefined) continue;
            // Wait for the header label too, or the column is sized without it.
            if (bodyStart === 1 && !model.cell(0, col).loaded) continue;
            const samples: string[] = [headerRow ? model.cell(0, col).value : columnLetter(col)];
            let loaded = 0;
            for (let view = viewStart; view < sampleEnd; view++) {
                const cell = model.cell(view, col);
                if (!cell.loaded) continue;
                loaded++;
                samples.push(cell.value);
            }
            if (loaded === 0 && bodyCount > 0) continue;
            const key = `${String(headerRow)}:${String(viewStart)}:${String(sampleEnd)}:${String(modelVersion)}`;
            if (measuredWindow.current.get(id) === key) continue;
            measuredWindow.current.set(id, key);
            if (csvColumnWidths.growAuto(paneID, id, autoColumnWidth(samples, measureCell))) changed = true;
        }
        if (changed) setWidthsVersion((value) => value + 1);
    });

    // ── selection ──────────────────────────────────────────────────────────────────
    const [selection, setSelection] = useState<Selection>({ view: bodyStart, col: 0 });
    const selectionRef = useRef(selection);
    selectionRef.current = selection;
    /**
     * The logical row under the selection, and the order it was read in, so a re-sort (or the
     * header row flipping) can put the same row back under the cursor.
     */
    const anchorRow = useRef<{ key: string; row: number } | null>(null);
    const pendingAnchor = useRef<{ key: string; row: number } | null>(null);
    const orderKey = state === null ? '' : `${state.incarnation}|${state.sort?.column ?? '-'}:${state.sort?.direction ?? ''}:${state.sort?.pending === true ? 1 : 0}|${state.headerRow ? 1 : 0}`;
    const orderKeyRef = useRef(orderKey);
    if (orderKeyRef.current !== orderKey) {
        if (orderKeyRef.current !== '' && anchorRow.current !== null) pendingAnchor.current = { key: orderKey, row: anchorRow.current.row };
        orderKeyRef.current = orderKey;
        anchorRow.current = null;
    }
    // A structural edit renumbers logical rows: an anchor read before it names the wrong row.
    const generationRef = useRef(state?.generation ?? '');
    if (state !== null && generationRef.current !== state.generation) {
        generationRef.current = state.generation;
        anchorRow.current = null;
        pendingAnchor.current = null;
    }
    const clampSelection = useCallback(
        (next: Selection): Selection => ({
            view: Math.max(0, Math.min(next.view, Math.max(rowCount - 1, 0))),
            col: Math.max(0, Math.min(next.col, Math.max(columns.length - 1, 0)))
        }),
        [rowCount, columns.length]
    );

    const ensureVisible = useCallback(
        (target: Selection, align: 'nearest' | 'top' = 'nearest'): void => {
            // Vertical: the header row is always on screen.
            if (!(bodyStart === 1 && target.view === 0)) {
                const top = (target.view - bodyStart) * rowPx;
                const current = mapRef.current.snapshot().virtual;
                let next = current;
                if (align === 'top') next = top;
                else if (top < current) next = top;
                else if (top + rowPx > current + bodyViewportPx) next = top + rowPx - bodyViewportPx;
                if (next !== current) applyPhysical(mapRef.current.scrollToVirtual(next));
            }
            const scroller = scrollerRef.current;
            const left = scroller?.scrollLeft ?? scroll.left;
            const cellLeft = offsets[target.col] ?? 0;
            const cellRight = offsets[target.col + 1] ?? cellLeft;
            const room = size.width - rowNumberPx;
            if (cellLeft < left) scrollLeftTo(cellLeft);
            else if (cellRight > left + room) scrollLeftTo(Math.max(0, cellRight - room));
        },
        [applyPhysical, bodyStart, bodyViewportPx, offsets, rowNumberPx, rowPx, scroll.left, size.width]
    );

    const select = useCallback(
        (next: Selection, options: { scroll?: boolean; align?: 'nearest' | 'top' } = {}): Selection => {
            const clamped = clampSelection(next);
            setSelection(clamped);
            selectionRef.current = clamped;
            pendingAnchor.current = null;
            const row = model.rowAt(clamped.view);
            anchorRow.current = row === null ? null : { key: orderKeyRef.current, row };
            if (options.scroll !== false) ensureVisible(clamped, options.align);
            return clamped;
        },
        [clampSelection, ensureVisible, model]
    );

    // Keep the selection inside the table as it shrinks or the header row flips.
    useEffect(() => {
        if (state === null) return;
        const clamped = clampSelection(selectionRef.current);
        if (!sameSelection(clamped, selectionRef.current)) {
            selectionRef.current = clamped;
            setSelection(clamped);
        }
    }, [state, clampSelection]);

    // Re-anchor by logical row when the ORDER changes (a sort, the header row toggled): once the
    // rows in the new order arrive, the selection follows its row if it is among them. Otherwise
    // (the cache only knows the rows near the viewport) it stays at the same view position. It
    // never scrolls to get there: the rows may arrive after the person has scrolled elsewhere
    // (and a scroll of theirs drops the pending anchor outright, `onScroll`).
    useEffect(() => {
        const pending = pendingAnchor.current;
        if (pending !== null && pending.key === orderKey) {
            const view = model.viewOfRow(pending.row);
            if (view !== null) select({ view, col: selectionRef.current.col }, { scroll: false });
            return;
        }
        if (anchorRow.current === null) {
            const row = model.rowAt(selectionRef.current.view);
            if (row !== null) anchorRow.current = { key: orderKey, row };
        }
    });

    // ── editing ────────────────────────────────────────────────────────────────────
    const [editing, setEditing] = useState<EditSession | null>(null);
    const editingRef = useRef<EditSession | null>(null);
    const [draftLines, setDraftLines] = useState(1);
    const copyArmed = useRef(false);

    const showReason = (reason: string): void => model.showNotice(reason);

    const beginEdit = (initial: string | null): boolean => {
        const at = selectionRef.current;
        const cell = model.cell(at.view, at.col);
        const reason = cellEditBlockReason(model.state(), cell);
        const area = textareaRef.current;
        if (reason !== null || cell.row === null || cell.column === null) {
            showReason(reason ?? 'This row is still loading.');
            if (area !== null) area.value = '';
            return false;
        }
        const session: EditSession = {
            view: at.view,
            col: at.col,
            row: cell.row,
            column: cell.column,
            generation: cell.generation,
            original: cell.value
        };
        editingRef.current = session;
        setEditing(session);
        const text = initial ?? cell.value;
        if (area !== null) {
            if (area.value !== text) area.value = text;
            const end = area.value.length;
            area.setSelectionRange?.(end, end);
        }
        setDraftLines(text.split('\n').length);
        ensureVisible(at);
        return true;
    };

    const endEdit = (): void => {
        editingRef.current = null;
        setEditing(null);
        setDraftLines(1);
        const area = textareaRef.current;
        if (area !== null) area.value = '';
    };

    const commit = (): void => {
        const session = editingRef.current;
        if (session === null) return;
        const value = textareaRef.current?.value ?? session.original;
        endEdit();
        if (value !== session.original) {
            model.setCells([{ row: session.row, column: session.column, value }], session.generation);
        }
    };

    const cancel = (): void => {
        if (editingRef.current === null) return;
        endEdit();
    };

    // A pane leaving the screen mid-edit (⌘E, a workspace switch) keeps what was typed. ⌘E and
    // a close commit it BEFORE they ask the daemon (`model.flush`, through this hook), because
    // the daemon refuses a grid edit once the pane shows raw text or is gone; the unmount commit
    // is the backstop for a switch that does not wait (a workspace switch).
    const latestCommit = useRef(commit);
    latestCommit.current = commit;
    useLayoutEffect(() => model.setCommitHook(() => latestCommit.current()), [model]);
    useLayoutEffect(() => () => latestCommit.current(), []);

    const clearCell = (at: Selection): void => {
        const cell = model.cell(at.view, at.col);
        const reason = cellEditBlockReason(model.state(), cell);
        if (reason !== null || cell.row === null || cell.column === null) {
            showReason(reason ?? 'This row is still loading.');
            return;
        }
        if (cell.value === '') return;
        model.setCells([{ row: cell.row, column: cell.column, value: '' }], cell.generation);
    };

    // ── focus ──────────────────────────────────────────────────────────────────────
    const mayClaim = !phone && mayClaimPaneCaret();
    const claimable = props.focused === true && props.visible !== false && mayClaim;
    useEffect(() => {
        if (!claimable) return;
        return armCaretClaim(textareaRef.current, () => textareaRef.current?.focus());
    }, [claimable]);

    const focusGrid = (): void => {
        if (!mayClaim) return;
        textareaRef.current?.focus();
    };

    // ── structural edits ───────────────────────────────────────────────────────────
    const structure = (op: 'insert-row-above' | 'insert-row-below' | 'delete-row' | 'insert-column-left' | 'insert-column-right' | 'delete-column', at: Selection): void => {
        const current = model.state();
        const reason = structureBlockReason(current);
        if (current === null || reason !== null) {
            showReason(reason ?? 'The table is still loading.');
            return;
        }
        const cell = model.cell(at.view, at.col);
        const generation = cell.generation !== '' ? cell.generation : model.displayGeneration();
        const columnID = current.columns[at.col];
        switch (op) {
            case 'insert-row-above':
            case 'insert-row-below': {
                const row = cell.row ?? model.rowAt(at.view);
                if (row === null) return showReason('This row is still loading.');
                model.structural({ op: 'insert-rows', at: op === 'insert-row-above' ? row : row + 1, count: 1 }, generation);
                if (op === 'insert-row-below') select({ view: at.view + 1, col: at.col });
                return;
            }
            case 'delete-row': {
                const row = cell.row ?? model.rowAt(at.view);
                if (row === null) return showReason('This row is still loading.');
                model.structural({ op: 'delete-rows', start: row, count: 1 }, generation);
                return;
            }
            case 'insert-column-left':
            case 'insert-column-right':
                model.structural({ op: 'insert-column', at: op === 'insert-column-left' ? at.col : at.col + 1 }, generation);
                if (op === 'insert-column-right') select({ view: at.view, col: at.col + 1 });
                return;
            case 'delete-column':
                if (columnID === undefined) return;
                model.structural({ op: 'delete-column', column: columnID }, generation);
                return;
        }
    };

    // ── sort ───────────────────────────────────────────────────────────────────────
    const cycleSort = (col: number): void => {
        const current = model.state();
        const reason = structureBlockReason(current);
        if (current === null || reason !== null) {
            showReason(reason ?? 'The table is still loading.');
            return;
        }
        const id = current.columns[col];
        if (id === undefined) return;
        const sort = current.sort;
        if (sort === null || sort.column !== id) void model.sort(id, 'asc');
        else if (sort.direction === 'asc') void model.sort(id, 'desc');
        else void model.sort(null, 'asc');
    };

    const sortBy = (col: number, direction: 'asc' | 'desc' | null): void => {
        const current = model.state();
        const reason = structureBlockReason(current);
        if (current === null || reason !== null) {
            showReason(reason ?? 'The table is still loading.');
            return;
        }
        if (direction === null) {
            void model.sort(null, 'asc');
            return;
        }
        const id = current.columns[col];
        if (id !== undefined) void model.sort(id, direction);
    };

    // ── paste / copy ───────────────────────────────────────────────────────────────
    const paste = (text: string): void => {
        const current = model.state();
        const at = selectionRef.current;
        const table = parseClipboardTable(text);
        const first = model.cell(at.view, at.col);
        const reason = cellEditBlockReason(current, first);
        if (current === null || reason !== null) {
            showReason(reason ?? 'The table is still loading.');
            return;
        }
        const width = table.reduce((widest, row) => Math.max(widest, row.length), 0);
        const rows = Math.min(table.length, current.rowCount - at.view);
        const cols = Math.min(width, current.columns.length - at.col);
        if (rows <= 0 || cols <= 0) return;
        const clipped = rows < table.length || cols < width;
        // The rows and the generation they are numbered in come back together, so a paste whose
        // targets were read partly before and partly after a structural edit is never sent.
        void model
            .pasteRows(at.view, rows, (logical) => {
                const edits: { row: number; column: number; value: string }[] = [];
                for (let r = 0; r < Math.min(rows, logical.length); r++) {
                    const source = table[r] ?? [];
                    for (let c = 0; c < Math.min(cols, source.length); c++) {
                        const column = current.columns[at.col + c];
                        const row = logical[r];
                        if (column === undefined || row === undefined) continue;
                        edits.push({ row, column, value: source[c] ?? '' });
                    }
                }
                return edits;
            })
            .then((sent) => {
                if (sent && clipped) model.showNotice(`Pasted ${formatCount(rows)} × ${formatCount(cols)}; the rest did not fit the table.`);
            });
    };

    const onCopy = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
        if (editingRef.current !== null) return;
        const at = selectionRef.current;
        // As one TSV field, so ⌘V (which reads TSV) puts back exactly this value.
        const value = clipboardCellText(model.cell(at.view, at.col).value);
        event.clipboardData?.setData('text/plain', value);
        event.preventDefault();
        copyArmed.current = false;
        event.currentTarget.value = '';
    };

    const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
        if (editingRef.current !== null) return;
        const text = event.clipboardData?.getData('text/plain') ?? '';
        event.preventDefault();
        paste(text);
    };

    // ── find ───────────────────────────────────────────────────────────────────────
    const [find, setFind] = useState<FindState>({ open: false, seq: 0, needle: '', total: null, index: null, match: null });
    const findRef = useRef(find);
    findRef.current = find;
    const findGeneration = useRef(0);
    const findTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => {
        if (findTimer.current !== null) clearTimeout(findTimer.current);
    }, []);
    const palette = useMemo(() => resolveFindPalette(props.findPalette), [props.findPalette]);

    const findToken = props.findToken ?? 0;
    const lastFindToken = useRef(findToken);
    useEffect(() => {
        if (findToken === lastFindToken.current) return;
        lastFindToken.current = findToken;
        if (findToken === 0) return;
        if (editingRef.current !== null) latestCommit.current();
        setFind((previous) => ({ ...previous, open: true, seq: previous.seq + 1 }));
    }, [findToken]);

    const applyStep = (step: CsvFindStepReply | null, generation: number): void => {
        if (step === null || generation !== findGeneration.current) return;
        const current = model.state();
        if (step.match === null || current === null) {
            setFind((previous) => ({ ...previous, total: step.total, index: null, match: null }));
            return;
        }
        const col = current.columns.indexOf(step.match.column);
        const match = { view: step.match.view, col: Math.max(0, col) };
        setFind((previous) => ({ ...previous, total: step.total, index: step.index, match }));
        select(match);
    };

    const runFind = (query: string): void => {
        const generation = ++findGeneration.current;
        if (query.length === 0) {
            setFind((previous) => ({ ...previous, total: null, index: null, match: null }));
            return;
        }
        void model.find(query).then((reply) => {
            if (reply === null || generation !== findGeneration.current) return;
            setFind((previous) => ({ ...previous, total: reply.total }));
        });
        void model.findStep(query, 'next', null).then((step) => applyStep(step, generation));
    };

    const onNeedleChange = (needle: string): void => {
        setFind((previous) => ({ ...previous, needle }));
        if (findTimer.current !== null) clearTimeout(findTimer.current);
        findTimer.current = setTimeout(() => {
            findTimer.current = null;
            runFind(needle);
        }, CSV_FIND_DEBOUNCE_MS);
    };

    const stepFind = (direction: 'next' | 'previous'): void => {
        const current = findRef.current;
        const live = model.state();
        if (current.needle.length === 0 || live === null) return;
        const at = current.match ?? selectionRef.current;
        const column = live.columns[at.col];
        const generation = ++findGeneration.current;
        void model
            .findStep(current.needle, direction, column === undefined ? null : { view: at.view, column })
            .then((step) => applyStep(step, generation));
    };

    const closeFind = (): void => {
        findGeneration.current++;
        if (findTimer.current !== null) clearTimeout(findTimer.current);
        setFind((previous) => ({ ...previous, open: false, match: null }));
        focusGrid();
    };

    // ── keys ───────────────────────────────────────────────────────────────────────
    const pageRows = Math.max(1, Math.floor(bodyViewportPx / rowPx) - 1);

    const move = (dView: number, dCol: number): void => {
        const at = selectionRef.current;
        select({ view: at.view + dView, col: at.col + dCol });
    };

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
        if (event.nativeEvent.isComposing) return;
        const command = event.metaKey || event.ctrlKey;
        if (editingRef.current !== null) {
            if (event.key === 'Enter') {
                event.preventDefault();
                if (event.altKey) {
                    const area = event.currentTarget;
                    const start = area.selectionStart ?? area.value.length;
                    const end = area.selectionEnd ?? start;
                    area.value = `${area.value.slice(0, start)}\n${area.value.slice(end)}`;
                    area.setSelectionRange?.(start + 1, start + 1);
                    setDraftLines(area.value.split('\n').length);
                    return;
                }
                commit();
                move(event.shiftKey ? -1 : 1, 0);
                return;
            }
            if (event.key === 'Tab') {
                event.preventDefault();
                commit();
                move(0, event.shiftKey ? -1 : 1);
                return;
            }
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                cancel();
            }
            return;
        }

        const key = event.key;
        if (command && (key === 'z' || key === 'Z')) {
            event.preventDefault();
            if (event.shiftKey) model.redo();
            else model.undo();
            return;
        }
        if (command && (key === 'y' || key === 'Y')) {
            event.preventDefault();
            model.redo();
            return;
        }
        if (command && (key === 'c' || key === 'C')) {
            // The value is put under a real selection so the platform's own copy takes it even
            // where a copy event with nothing selected is not dispatched; `onCopy` then sets the
            // pasteboard explicitly and clears the field.
            const at = selectionRef.current;
            const area = event.currentTarget;
            area.value = clipboardCellText(model.cell(at.view, at.col).value);
            area.select();
            copyArmed.current = true;
            setTimeout(() => {
                if (copyArmed.current && editingRef.current === null && textareaRef.current !== null) textareaRef.current.value = '';
                copyArmed.current = false;
            }, 0);
            return;
        }
        if (command && (key === 'v' || key === 'V')) return;
        const at = selectionRef.current;
        const last = Math.max(rowCount - 1, 0);
        const lastCol = Math.max(columns.length - 1, 0);
        switch (key) {
            case 'ArrowUp':
                event.preventDefault();
                if (command) select({ view: bodyStart, col: at.col });
                else move(-1, 0);
                return;
            case 'ArrowDown':
                event.preventDefault();
                if (command) select({ view: last, col: at.col });
                else move(1, 0);
                return;
            case 'ArrowLeft':
                event.preventDefault();
                if (command) select({ view: at.view, col: 0 });
                else move(0, -1);
                return;
            case 'ArrowRight':
                event.preventDefault();
                if (command) select({ view: at.view, col: lastCol });
                else move(0, 1);
                return;
            case 'Home':
                event.preventDefault();
                select(command ? { view: bodyStart, col: 0 } : { view: at.view, col: 0 });
                return;
            case 'End':
                event.preventDefault();
                select(command ? { view: last, col: lastCol } : { view: at.view, col: lastCol });
                return;
            case 'PageUp':
                event.preventDefault();
                move(-pageRows, 0);
                return;
            case 'PageDown':
                event.preventDefault();
                move(pageRows, 0);
                return;
            case 'Tab':
                event.preventDefault();
                move(0, event.shiftKey ? -1 : 1);
                return;
            case 'Enter':
            case 'F2':
                event.preventDefault();
                beginEdit(null);
                return;
            case 'Delete':
            case 'Backspace':
                event.preventDefault();
                clearCell(at);
                return;
            default:
                break;
        }
        // A printable key starts an edit through the field's own `input`; refuse it up front
        // when the cell cannot be edited, so the character does not land anywhere.
        if (key.length === 1 && !command && !event.altKey) {
            const reason = cellEditBlockReason(model.state(), model.cell(at.view, at.col));
            if (reason !== null) {
                event.preventDefault();
                showReason(reason);
            }
        }
    };

    const onInput = (): void => {
        const area = textareaRef.current;
        if (area === null) return;
        if (editingRef.current !== null) {
            const lines = area.value.split('\n').length;
            if (lines !== draftLines) setDraftLines(lines);
            return;
        }
        if (copyArmed.current) return;
        if (area.value.length === 0) return;
        beginEdit(area.value);
    };

    const onCompositionStart = (): void => {
        if (editingRef.current !== null) return;
        const area = textareaRef.current;
        const typed = area?.value ?? '';
        beginEdit(typed);
    };

    const onBlur = (): void => {
        if (editingRef.current !== null) commit();
    };

    // ── pointer (desktop) ──────────────────────────────────────────────────────────
    const onMouseDown = (event: MouseEvent<HTMLDivElement>): void => {
        if (event.button !== 0) return;
        const target = targetOf(event.target);
        if (target === null) return;
        props.onFocusRequest?.(paneID);
        // Keep the caret in the grid's field rather than letting the press blur it.
        event.preventDefault();
        if (target.kind === 'header') {
            focusGrid();
            return;
        }
        if (editingRef.current !== null) commit();
        if (target.kind === 'rownum') select({ view: target.view, col: selectionRef.current.col }, { scroll: false });
        else select({ view: target.view, col: target.col }, { scroll: false });
        focusGrid();
    };

    const onClick = (event: MouseEvent<HTMLDivElement>): void => {
        const target = targetOf(event.target);
        if (target === null || target.kind !== 'header') return;
        if ((event.target as Element).closest?.('[data-csv-resize]') != null) return;
        cycleSort(target.col);
    };

    const onDoubleClick = (event: MouseEvent<HTMLDivElement>): void => {
        const target = targetOf(event.target);
        if (target === null || target.kind !== 'cell') return;
        select({ view: target.view, col: target.col }, { scroll: false });
        focusGrid();
        beginEdit(null);
    };

    const [menu, setMenu] = useState<MenuState | null>(null);
    /** A menu row that moved the caret on purpose (Go to row…) keeps it when the menu closes. */
    const menuMovedFocus = useRef(false);
    const openMenuAt = (x: number, y: number, target: Target): void => {
        if (editingRef.current !== null) commit();
        if (target.kind === 'header') {
            select({ view: selectionRef.current.view, col: target.col }, { scroll: false });
            setMenu({ x, y, view: selectionRef.current.view, col: target.col, header: true });
            return;
        }
        const view = target.view;
        const col = target.kind === 'cell' ? target.col : selectionRef.current.col;
        select({ view, col }, { scroll: false });
        setMenu({ x, y, view, col, header: false });
    };

    const onContextMenu = (event: MouseEvent<HTMLDivElement>): void => {
        const target = targetOf(event.target);
        const current = model.state();
        if (target === null) {
            // A file with no body rows (empty, or only its header row) has no cell to right-click:
            // offer the first row and column instead.
            const bodyRows = current === null ? 0 : current.rowCount - (current.headerRow && current.rowCount > 0 ? 1 : 0);
            if (current === null || (bodyRows > 0 && current.columns.length > 0)) return;
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY, view: 0, col: 0, header: false, empty: true });
            return;
        }
        event.preventDefault();
        props.onFocusRequest?.(paneID);
        openMenuAt(event.clientX, event.clientY, target);
    };

    // ── touch ──────────────────────────────────────────────────────────────────────
    const touch = useRef<{ x: number; y: number; target: Target | null; timer: ReturnType<typeof setTimeout> | null; moved: boolean; fired: boolean } | null>(null);
    useEffect(() => () => {
        if (touch.current?.timer != null) clearTimeout(touch.current.timer);
    }, []);

    const onTouchStart = (event: TouchEvent<HTMLDivElement>): void => {
        const point = event.touches[0];
        if (point === undefined || event.touches.length > 1) {
            if (touch.current?.timer != null) clearTimeout(touch.current.timer);
            touch.current = null;
            return;
        }
        // The column-resize handle answers its own pointer events; a tap on it is not a sort.
        const onHandle = (event.target as Element | null)?.closest?.('[data-csv-resize]') != null;
        const target = onHandle ? null : targetOf(event.target);
        const record = { x: point.clientX, y: point.clientY, target, timer: null as ReturnType<typeof setTimeout> | null, moved: false, fired: false };
        if (target !== null) {
            record.timer = setTimeout(() => {
                record.timer = null;
                if (record.moved) return;
                record.fired = true;
                openMenuAt(record.x, record.y, target);
            }, LONG_PRESS_MS);
        }
        touch.current = record;
    };

    const onTouchMove = (event: TouchEvent<HTMLDivElement>): void => {
        const record = touch.current;
        const point = event.touches[0];
        if (record === null || point === undefined) return;
        if (Math.hypot(point.clientX - record.x, point.clientY - record.y) > TOUCH_SLOP_PX) {
            record.moved = true;
            if (record.timer !== null) {
                clearTimeout(record.timer);
                record.timer = null;
            }
        }
    };

    const onTouchEnd = (event: TouchEvent<HTMLDivElement>): void => {
        const record = touch.current;
        touch.current = null;
        if (record === null) return;
        if (record.timer !== null) clearTimeout(record.timer);
        if (record.fired) {
            event.preventDefault();
            return;
        }
        if (record.moved || record.target === null) return;
        // A tap. Handled here (and the emulated mouse events suppressed) so the caret moves
        // only when the person asked for it, and inside the gesture so the keyboard comes up.
        event.preventDefault();
        const target = record.target;
        props.onFocusRequest?.(paneID);
        if (target.kind === 'header') {
            cycleSort(target.col);
            return;
        }
        const next: Selection = target.kind === 'cell' ? { view: target.view, col: target.col } : { view: target.view, col: selectionRef.current.col };
        if (target.kind === 'cell' && sameSelection(next, selectionRef.current) && editingRef.current === null) {
            const reason = cellEditBlockReason(model.state(), model.cell(next.view, next.col));
            if (reason !== null) {
                showReason(reason);
                return;
            }
            // Synchronously, inside the gesture: the only focus that raises a phone keyboard.
            textareaRef.current?.focus();
            beginEdit(null);
            return;
        }
        if (editingRef.current !== null) commit();
        select(next, { scroll: false });
    };

    // ── column resize ──────────────────────────────────────────────────────────────
    const resize = useRef<{ col: number; id: number; startX: number; startWidth: number } | null>(null);
    const onResizeDown = (event: ReactPointerEvent<HTMLDivElement>, col: number): void => {
        const id = columns[col];
        if (id === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        resize.current = { col, id, startX: event.clientX, startWidth: widths[col] ?? CSV_DEFAULT_COLUMN_PX };
        try {
            event.currentTarget.setPointerCapture?.(event.pointerId);
        } catch {
            /* jsdom and synthetic pointers have no capture */
        }
    };
    const onResizeMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
        const active = resize.current;
        if (active === null) return;
        csvColumnWidths.setManual(paneID, active.id, active.startWidth + (event.clientX - active.startX));
        setWidthsVersion((value) => value + 1);
    };
    const onResizeUp = (): void => {
        resize.current = null;
    };

    // ── go to row ──────────────────────────────────────────────────────────────────
    const [gotoDraft, setGotoDraft] = useState('');
    const goToRow = (raw: string): boolean => {
        const number = Number.parseInt(raw.replace(/[,\s]/g, ''), 10);
        if (!Number.isFinite(number) || number < 1 || bodyCount === 0) {
            showReason(`Enter a row number from 1 to ${formatCount(bodyCount)}.`);
            return false;
        }
        const view = bodyStart + Math.min(number, bodyCount) - 1;
        select({ view, col: selectionRef.current.col }, { align: 'top' });
        return true;
    };

    // ── phone scrubber ─────────────────────────────────────────────────────────────
    const scrubberShown = phone && bodyCount * rowPx > CSV_SCRUBBER_MIN_VIEWPORTS * bodyViewportPx;
    const trackRef = useRef<HTMLDivElement | null>(null);
    const scrubTo = (clientY: number): void => {
        const track = trackRef.current;
        if (track === null) return;
        const rect = track.getBoundingClientRect();
        const height = rect.height > 0 ? rect.height : bodyViewportPx;
        const fraction = Math.min(1, Math.max(0, (clientY - rect.top) / height));
        const max = Math.max(0, bodyCount * rowPx - bodyViewportPx);
        applyPhysical(mapRef.current.scrollToVirtual(fraction * max));
    };

    // ── chrome facts for the status line ───────────────────────────────────────────
    const busyEdits = model.pendingEdits();
    const error = state?.error ?? model.error();
    const notice = model.notice() ?? state?.notice ?? null;

    // ── menu items ─────────────────────────────────────────────────────────────────
    const menuItems = (target: MenuState): MenuItemSpec[] => {
        const current = model.state();
        if (current === null) return [];
        const blocked = structureBlockReason(current) !== null;
        if (target.empty === true) {
            const generation = model.displayGeneration();
            return [
                { id: 'insert-first-row', label: 'Insert row', disabled: blocked, onSelect: () => model.structural({ op: 'insert-rows', at: current.rowCount, count: 1 }, generation) },
                { id: 'insert-first-column', label: 'Insert column', disabled: blocked, onSelect: () => model.structural({ op: 'insert-column', at: current.columns.length }, generation) }
            ];
        }
        const headerCell = current.headerRow && target.view === 0;
        const columnID = current.columns[target.col];
        const sorted = current.sort !== null && current.sort.column === columnID ? current.sort.direction : null;
        const at = { view: target.view, col: target.col };
        const items: MenuItemSpec[] = [];
        if (target.header && current.headerRow && current.rowCount > 0) {
            // The header row is a row: a file that is only a header gets its first data row here.
            items.push(
                { id: 'insert-row-below', label: 'Insert row below', disabled: blocked, onSelect: () => structure('insert-row-below', { view: 0, col: target.col }) },
                { id: 'sep-rows', label: '', kind: 'separator' }
            );
        }
        if (!target.header) {
            items.push(
                { id: 'insert-row-above', label: 'Insert row above', disabled: blocked || headerCell, onSelect: () => structure('insert-row-above', at) },
                { id: 'insert-row-below', label: 'Insert row below', disabled: blocked, onSelect: () => structure('insert-row-below', at) },
                {
                    id: 'delete-row',
                    label: deleteClearsUndo(current, { rows: 1 }) ? "Delete row (can't be undone)" : 'Delete row',
                    disabled: blocked || headerCell,
                    danger: true,
                    onSelect: () => structure('delete-row', at)
                },
                { id: 'sep-rows', label: '', kind: 'separator' }
            );
        }
        items.push(
            { id: 'insert-column-left', label: 'Insert column left', disabled: blocked, onSelect: () => structure('insert-column-left', at) },
            { id: 'insert-column-right', label: 'Insert column right', disabled: blocked, onSelect: () => structure('insert-column-right', at) },
            {
                id: 'delete-column',
                label: deleteClearsUndo(current, { column: true }) ? "Delete column (can't be undone)" : 'Delete column',
                disabled: blocked || current.columns.length <= 1,
                danger: true,
                onSelect: () => structure('delete-column', at)
            },
            { id: 'sep-columns', label: '', kind: 'separator' },
            { id: 'sort-asc', label: 'Sort ascending', checked: sorted === 'asc', disabled: blocked, onSelect: () => sortBy(target.col, 'asc') },
            { id: 'sort-desc', label: 'Sort descending', checked: sorted === 'desc', disabled: blocked, onSelect: () => sortBy(target.col, 'desc') },
            { id: 'sort-clear', label: 'Clear sort', disabled: blocked || current.sort === null, onSelect: () => sortBy(target.col, null) },
            { id: 'sep-sort', label: '', kind: 'separator' },
            {
                id: 'header-row',
                label: 'First row is the header',
                control: 'checkbox',
                checked: current.headerRow,
                onSelect: () => void model.setHeaderRow(!current.headerRow)
            },
            { id: 'undo', label: 'Undo', disabled: !current.canUndo, onSelect: () => model.undo() },
            { id: 'redo', label: 'Redo', disabled: !current.canRedo, onSelect: () => model.redo() },
            { id: 'sep-goto', label: '', kind: 'separator' },
            {
                id: 'go-to-row',
                label: 'Go to row…',
                onSelect: () => {
                    menuMovedFocus.current = true;
                    gotoRef.current?.focus();
                    gotoRef.current?.select?.();
                }
            }
        );
        return items;
    };

    // ── render ─────────────────────────────────────────────────────────────────────
    const offset = snapshot.offset;
    const lowerNeedle = find.open ? find.needle.toLowerCase() : '';
    const selected = selection;
    const cellStyleFor = (cell: CsvCellView, view: number, col: number): CSSProperties => {
        const isSelected = selected.view === view && selected.col === col;
        const isCurrent = find.open && find.match !== null && find.match.view === view && find.match.col === col;
        const isMatch = !isCurrent && lowerNeedle.length > 0 && cell.value.toLowerCase().includes(lowerNeedle);
        return {
            background: isCurrent ? palette.current : isMatch ? palette.match : isSelected ? tokens.selectionFill : undefined,
            color: isCurrent ? palette.currentText : isMatch ? palette.matchText : cell.pending ? tokens.textSecondary : undefined,
            boxShadow: isSelected ? `inset 0 0 0 2px ${tokens.selectionStroke}` : undefined
        };
    };

    const headerCells: ReactElement[] = [];
    for (let col = cols.start; col < cols.end; col++) {
        const id = columns[col];
        const cell = bodyStart === 1 ? model.cell(0, col) : null;
        const label = cell === null ? columnLetter(col) : cell.value;
        const sorted = state?.sort !== null && state?.sort !== undefined && state.sort.column === id ? state.sort : null;
        const isSelected = bodyStart === 1 && selected.view === 0 && selected.col === col;
        headerCells.push(
            <div
                key={id ?? `c${col}`}
                data-csv-header={col}
                data-testid={`csv-header-${col}`}
                data-sort={sorted === null ? undefined : sorted.direction}
                role="columnheader"
                aria-sort={sorted === null ? 'none' : sorted.direction === 'asc' ? 'ascending' : 'descending'}
                title={cell === null ? `Column ${label}` : `${columnLetter(col)}: ${label}`}
                className="absolute top-0 flex items-center overflow-hidden"
                style={{
                    left: rowNumberPx + (offsets[col] ?? 0),
                    width: widths[col],
                    height: headerPx,
                    padding: '0 6px 0 8px',
                    borderRight: `1px solid ${tokens.divider}`,
                    color: tokens.textPrimary,
                    fontWeight: cell === null ? 400 : 600,
                    cursor: 'pointer',
                    ...(cell === null ? {} : cellStyleFor(cell, 0, col)),
                    boxShadow: isSelected ? `inset 0 0 0 2px ${tokens.selectionStroke}` : undefined
                }}
            >
                <span className="min-w-0 flex-1 truncate" style={{ whiteSpace: 'pre' }}>
                    {cellDisplayText(label).text}
                </span>
                {sorted === null ? null : (
                    <span data-testid={`csv-sort-indicator-${col}`} aria-hidden className="shrink-0 pl-1" style={{ color: tokens.accent }}>
                        {sorted.pending ? '…' : sorted.direction === 'asc' ? '▲' : '▼'}
                    </span>
                )}
                <div
                    data-csv-resize
                    data-testid={`csv-resize-${col}`}
                    aria-hidden
                    className="absolute top-0 right-0 h-full"
                    style={{ width: 6, cursor: 'col-resize', touchAction: 'none' }}
                    onPointerDown={(event) => onResizeDown(event, col)}
                    onPointerMove={onResizeMove}
                    onPointerUp={onResizeUp}
                    onPointerCancel={onResizeUp}
                    onClick={(event) => event.stopPropagation()}
                />
            </div>
        );
    }

    const rows: ReactElement[] = [];
    for (let index = body.start; index < body.end; index++) {
        const view = index + bodyStart;
        const top = headerPx + index * rowPx - offset;
        const cells: ReactElement[] = [];
        for (let col = cols.start; col < cols.end; col++) {
            const cell = model.cell(view, col);
            const { text, multiline } = cellDisplayText(cell.value);
            cells.push(
                <div
                    key={col}
                    data-csv-view={view}
                    data-csv-col={col}
                    data-testid={`csv-cell-${view}-${col}`}
                    data-pending={cell.pending ? 'true' : undefined}
                    role="gridcell"
                    className="absolute top-0 overflow-hidden"
                    title={cell.truncated ? 'Too long to edit here (shown cut)' : multiline ? cell.value : undefined}
                    style={{
                        left: rowNumberPx + (offsets[col] ?? 0),
                        width: widths[col],
                        height: rowPx,
                        padding: '0 8px',
                        whiteSpace: 'pre',
                        textOverflow: 'ellipsis',
                        borderRight: `1px solid ${tokens.divider}`,
                        fontStyle: cell.pending ? 'italic' : undefined,
                        ...cellStyleFor(cell, view, col)
                    }}
                >
                    {text}
                    {multiline ? <span aria-hidden style={{ color: tokens.textTertiary }}> ↵</span> : null}
                    {cell.truncated ? <span aria-hidden style={{ color: tokens.textTertiary }}>…</span> : null}
                </div>
            );
        }
        rows.push(
            <div
                key={view}
                role="row"
                data-testid={`csv-row-${view}`}
                className="absolute left-0"
                style={{ top, height: rowPx, width: totalWidth, borderBottom: `1px solid ${tokens.divider}` }}
            >
                <div
                    data-csv-rownum={view}
                    data-testid={`csv-rownum-${view}`}
                    role="rowheader"
                    className="sticky left-0 z-[1] flex h-full items-center justify-end"
                    style={{
                        width: rowNumberPx,
                        paddingRight: 8,
                        background: tokens.headerBackground,
                        color: selected.view === view ? tokens.textPrimary : tokens.textTertiary,
                        borderRight: `1px solid ${tokens.divider}`
                    }}
                >
                    {formatCount(index + 1)}
                </div>
                {cells}
            </div>
        );
    }

    // The field sits over the selected cell; a selection scrolled out of view parks it at the
    // top-left of the body so the browser never scrolls the grid to reveal a caret off screen.
    const inHeader = bodyStart === 1 && selected.view === 0;
    const selectedIndex = selected.view - bodyStart;
    const selectedOnScreen = inHeader || (selectedIndex >= body.start && selectedIndex < body.end);
    const fieldTop = inHeader ? scroll.top : selectedOnScreen ? headerPx + selectedIndex * rowPx - offset : scroll.top + headerPx;
    const fieldLeft = selectedOnScreen ? rowNumberPx + (offsets[selected.col] ?? 0) : rowNumberPx + scroll.left;
    const fieldHeight = editing === null ? rowPx : Math.max(rowPx, Math.min(8, draftLines) * 16 + 8);
    const readOnlyGrid = state === null || state.readOnly !== null || state.scanning !== null;

    const status = state === null ? null : (
        <CsvStatusLine
            paneID={paneID}
            state={state}
            bodyCount={bodyCount}
            busyEdits={busyEdits}
            error={error}
            notice={notice}
            phone={phone}
            gotoRef={gotoRef}
            gotoDraft={gotoDraft}
            onGotoDraft={setGotoDraft}
            onGoto={() => {
                if (goToRow(gotoDraft)) {
                    setGotoDraft('');
                    focusGrid();
                }
            }}
            onUndo={() => model.undo()}
            onRedo={() => model.redo()}
            onToggleHeaderRow={() => void model.setHeaderRow(!state.headerRow)}
            onDiscard={() => void model.discard()}
        />
    );

    return (
        <div
            ref={rootRef}
            data-testid={`csv-grid-${paneID}`}
            data-csv-pane={paneID}
            className="relative flex h-full w-full flex-col"
            style={{ background: props.background ?? 'var(--kelpi-term-bg, #0a0a0c)', color: tokens.textPrimary }}
        >
            <div
                {...{ [PANE_SURFACE_ATTR]: '' }}
                className="relative min-h-0 flex-1"
                style={{ display: 'flex' }}
            >
                <div
                    ref={scrollerRef}
                    data-testid={`csv-scroller-${paneID}`}
                    role="grid"
                    aria-label={contentPaneLabel('table', paneID, props.filePath ?? state?.filePath ?? null)}
                    aria-rowcount={rowCount}
                    aria-colcount={columns.length}
                    className="relative min-h-0 min-w-0 flex-1"
                    style={{
                        overflow: 'auto',
                        overflowAnchor: 'none',
                        overscrollBehavior: 'contain',
                        WebkitOverflowScrolling: 'touch',
                        WebkitTouchCallout: 'none',
                        userSelect: 'none',
                        fontFamily: FONT,
                        fontSize: 12,
                        lineHeight: `${String(rowPx)}px`
                    } as CSSProperties}
                    onScroll={onScroll}
                    onMouseDown={onMouseDown}
                    onClick={onClick}
                    onDoubleClick={onDoubleClick}
                    onContextMenu={onContextMenu}
                    onTouchStart={onTouchStart}
                    onTouchMove={onTouchMove}
                    onTouchEnd={onTouchEnd}
                    onTouchCancel={() => {
                        if (touch.current?.timer != null) clearTimeout(touch.current.timer);
                        touch.current = null;
                    }}
                >
                    <div
                        data-testid={`csv-spacer-${paneID}`}
                        className="relative"
                        style={{ width: totalWidth, height: headerPx + snapshot.spacerPx, minWidth: '100%' }}
                    >
                        <textarea
                            ref={textareaRef}
                            data-testid={`csv-editor-${paneID}`}
                            data-editing={editing === null ? 'false' : 'true'}
                            aria-label={editing === null ? 'Table cell' : 'Edit cell'}
                            spellCheck={false}
                            autoCapitalize="off"
                            autoComplete="off"
                            autoCorrect="off"
                            readOnly={editing === null && readOnlyGrid}
                            className="absolute resize-none outline-none"
                            style={{
                                top: fieldTop,
                                left: fieldLeft,
                                width: widths[selected.col] ?? CSV_DEFAULT_COLUMN_PX,
                                minWidth: editing === null ? undefined : Math.max(widths[selected.col] ?? 0, 160),
                                height: fieldHeight,
                                zIndex: 4,
                                margin: 0,
                                padding: editing === null ? 0 : '3px 8px',
                                border: 'none',
                                fontFamily: FONT,
                                fontSize: phone ? 16 : 12,
                                lineHeight: editing === null ? `${String(rowPx)}px` : '16px',
                                opacity: editing === null ? 0 : 1,
                                pointerEvents: editing === null ? 'none' : 'auto',
                                caretColor: editing === null ? 'transparent' : undefined,
                                color: tokens.textPrimary,
                                background: editing === null ? 'transparent' : tokens.surfaceBackground,
                                boxShadow: editing === null ? undefined : `0 0 0 2px ${tokens.selectionStroke}, 0 6px 18px rgba(0,0,0,0.35)`,
                                whiteSpace: 'pre',
                                overflow: editing === null ? 'hidden' : 'auto'
                            }}
                            onKeyDown={onKeyDown}
                            onInput={onInput}
                            onCompositionStart={onCompositionStart}
                            onBlur={onBlur}
                            onCopy={onCopy}
                            onPaste={onPaste}
                        />
                        <div
                            role="row"
                            data-testid={`csv-header-row-${paneID}`}
                            data-header-row={bodyStart === 1 ? 'true' : 'false'}
                            className="sticky top-0 left-0 z-[2]"
                            style={{
                                height: headerPx,
                                width: totalWidth,
                                background: tokens.headerBackground,
                                borderBottom: `1px solid ${tokens.divider}`
                            }}
                        >
                            <div
                                aria-hidden
                                className="sticky left-0 z-[3] h-full"
                                style={{ width: rowNumberPx, background: tokens.headerBackground, borderRight: `1px solid ${tokens.divider}` }}
                            />
                            {headerCells}
                        </div>
                        {rows}
                    </div>
                </div>
                {scrubberShown ? (
                    <div
                        ref={trackRef}
                        data-testid={`csv-scrubber-${paneID}`}
                        aria-label="Scroll through the table"
                        role="scrollbar"
                        aria-orientation="vertical"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round((snapshot.virtual / Math.max(1, bodyCount * rowPx - bodyViewportPx)) * 100)}
                        className="absolute right-0 z-[5]"
                        style={{ top: headerPx, bottom: 0, width: 28, touchAction: 'none' }}
                        onPointerDown={(event) => {
                            event.preventDefault();
                            try {
                                event.currentTarget.setPointerCapture?.(event.pointerId);
                            } catch {
                                /* synthetic pointer */
                            }
                            scrubTo(event.clientY);
                        }}
                        onPointerMove={(event) => {
                            if (event.buttons === 0 && event.pointerType === 'mouse') return;
                            scrubTo(event.clientY);
                        }}
                    >
                        <div
                            aria-hidden
                            className="absolute right-1 rounded-full"
                            style={{
                                width: 6,
                                height: 44,
                                top: `calc(${String((snapshot.virtual / Math.max(1, bodyCount * rowPx - bodyViewportPx)) * 100)}% - ${String((snapshot.virtual / Math.max(1, bodyCount * rowPx - bodyViewportPx)) * 44)}px)`,
                                background: tokens.textSecondary,
                                opacity: 0.7
                            }}
                        />
                    </div>
                ) : null}
            </div>
            {status}
            {menu === null ? null : (
                <ContextMenu
                    x={menu.x}
                    y={menu.y}
                    label="Table"
                    items={menuItems(menu)}
                    onClose={() => {
                        setMenu(null);
                        if (menuMovedFocus.current) menuMovedFocus.current = false;
                        else focusGrid();
                    }}
                />
            )}
            {find.open ? (
                <div style={{ display: props.visible === false ? 'none' : 'contents' }}>
                    <PaneSearchOverlay
                        key={find.seq}
                        paneID={paneID}
                        testIDPrefix="content-find"
                        label={`Find in ${contentPaneLabel('table', paneID, props.filePath ?? state?.filePath ?? null)}`}
                        needle={find.needle}
                        total={find.needle.length === 0 ? null : find.total}
                        selected={find.index === null ? null : find.index - 1}
                        top={CONTENT_FIND_BAR_OFFSET.top}
                        right={CONTENT_FIND_BAR_OFFSET.right}
                        onNeedleChange={onNeedleChange}
                        onNext={() => stepFind('next')}
                        onPrevious={() => stepFind('previous')}
                        onClose={closeFind}
                    />
                </div>
            ) : null}
        </div>
    );
}

const EMPTY_COLUMNS: readonly number[] = [];

interface CsvStatusLineProps {
    readonly paneID: string;
    readonly state: CsvPaneState;
    readonly bodyCount: number;
    readonly busyEdits: number;
    readonly error: string | null;
    readonly notice: string | null;
    readonly phone: boolean;
    readonly gotoRef: RefObject<HTMLInputElement | null>;
    readonly gotoDraft: string;
    readonly onGotoDraft: (value: string) => void;
    readonly onGoto: () => void;
    readonly onUndo: () => void;
    readonly onRedo: () => void;
    readonly onToggleHeaderRow: () => void;
    readonly onDiscard: () => void;
}

/** The one line under the grid: what the document is doing, and Go to row. */
function CsvStatusLine(props: CsvStatusLineProps): ReactElement {
    const { state, paneID } = props;
    const scanning = scanningText(state);
    const saving = state.saving || props.busyEdits > 0 ? 'Saving…' : state.dirty ? 'Unsaved changes' : null;
    const button = (label: string, testID: string, onClick: () => void, disabled = false): ReactElement => (
        <button
            type="button"
            data-testid={testID}
            disabled={disabled}
            className="shrink-0 rounded px-2"
            style={{
                height: props.phone ? 28 : 18,
                border: `1px solid ${tokens.divider}`,
                color: disabled ? tokens.textTertiary : tokens.textSecondary,
                background: tokens.headerBackground
            }}
            onClick={onClick}
        >
            {label}
        </button>
    );
    return (
        <div
            data-testid={`csv-status-${paneID}`}
            className="flex shrink-0 items-center gap-3 overflow-hidden px-2 text-[11px]"
            style={{
                minHeight: props.phone ? 40 : STATUS_PX,
                borderTop: `1px solid ${tokens.divider}`,
                background: tokens.headerBackground,
                color: tokens.textSecondary
            }}
        >
            <span data-testid={`csv-status-rows-${paneID}`} className="shrink-0 tabular-nums">
                {scanning ?? `${formatCount(props.bodyCount)} rows × ${formatCount(state.columns.length)} columns`}
            </span>
            {state.sort?.pending === true ? <span className="shrink-0">Sorting…</span> : null}
            {saving === null ? null : (
                <span data-testid={`csv-status-saving-${paneID}`} className="shrink-0">
                    {saving}
                </span>
            )}
            {state.readOnly === null ? null : (
                <span data-testid={`csv-status-readonly-${paneID}`} className="min-w-0 truncate" title={state.readOnly.message}>
                    Read-only: {state.readOnly.message}
                </span>
            )}
            {props.error === null ? null : (
                <span data-testid={`csv-status-error-${paneID}`} role="alert" className="min-w-0 truncate" style={{ color: '#E5484D' }} title={props.error}>
                    {props.error}
                </span>
            )}
            {props.error !== null && state.dirty ? button('Discard unsaved edits', `csv-discard-${paneID}`, props.onDiscard) : null}
            {props.notice === null ? null : (
                <span data-testid={`csv-status-notice-${paneID}`} role="status" className="min-w-0 truncate" title={props.notice}>
                    {props.notice}
                </span>
            )}
            <span className="flex-1" />
            {props.phone ? (
                <>
                    {button('Undo', `csv-undo-${paneID}`, props.onUndo, !state.canUndo)}
                    {button('Redo', `csv-redo-${paneID}`, props.onRedo, !state.canRedo)}
                    {button(state.headerRow ? 'Header: on' : 'Header: off', `csv-header-toggle-${paneID}`, props.onToggleHeaderRow)}
                </>
            ) : null}
            <label className="flex shrink-0 items-center gap-1">
                <span>Go to row</span>
                <input
                    ref={props.gotoRef}
                    data-testid={`csv-goto-${paneID}`}
                    aria-label="Go to row"
                    inputMode="numeric"
                    enterKeyHint="go"
                    value={props.gotoDraft}
                    placeholder={`1-${formatCount(Math.max(1, props.bodyCount))}`}
                    className="rounded px-1 outline-none"
                    style={{
                        width: props.phone ? 88 : 72,
                        height: props.phone ? 28 : 18,
                        fontSize: props.phone ? 16 : 11,
                        border: `1px solid ${tokens.divider}`,
                        background: tokens.surfaceBackground,
                        color: tokens.textPrimary
                    }}
                    onChange={(event) => props.onGotoDraft(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            props.onGoto();
                        }
                    }}
                />
            </label>
        </div>
    );
}
