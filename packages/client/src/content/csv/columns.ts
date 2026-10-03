/**
 * Column geometry for the csv grid (#324): spreadsheet letters, auto widths from loaded rows,
 * the per-pane width memory, and the prefix sums horizontal windowing reads.
 */

/** Auto-sized columns stay inside this band (plan §5). */
export const CSV_COLUMN_MIN_AUTO_PX = 60;
export const CSV_COLUMN_MAX_AUTO_PX = 360;
/** A dragged column may go narrower or wider than auto sizing would. */
export const CSV_COLUMN_MIN_PX = 32;
export const CSV_COLUMN_MAX_PX = 2000;
/** The monospace advance at the grid's 12 px, and the cell's horizontal padding. */
export const CSV_CHAR_PX = 7.2;
export const CSV_CELL_PADDING_PX = 16;
/**
 * A sample is cut to this many characters before it is measured: 100 characters is already
 * wider than `CSV_COLUMN_MAX_AUTO_PX`, and a 64 KiB cell measured on every scan push stutters.
 */
export const CSV_SAMPLE_CHARS = 100;
/** Panes whose widths are remembered; the least recently drawn one is forgotten past this. */
export const CSV_WIDTH_PANES = 64;

/** `0 → A`, `25 → Z`, `26 → AA` - the spreadsheet column name for a display index. */
export function columnLetter(index: number): string {
    let n = Math.max(0, Math.floor(index)) + 1;
    let out = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        out = String.fromCharCode(65 + rem) + out;
        n = Math.floor((n - 1) / 26);
    }
    return out;
}

/** What a cell shows on its one line: the first line, with a marker when there is more. */
export function cellDisplayText(value: string): { readonly text: string; readonly multiline: boolean } {
    const newline = value.search(/\r?\n|\r/);
    if (newline < 0) return { text: value, multiline: false };
    return { text: value.slice(0, newline), multiline: true };
}

/** Measures a line in a CSS font, or null where there is no canvas (jsdom). */
export type CsvTextMeasure = (text: string) => number | null;

let measureContext: CanvasRenderingContext2D | null | undefined;

/**
 * A measure for `font` backed by one shared 2D canvas. The `CSV_CHAR_PX` estimate undershoots
 * the real monospace advance at some zoom levels and fonts, which cut short values that had
 * plenty of room, so the browser measures and the estimate is only the fallback.
 */
export function canvasMeasure(font: string): CsvTextMeasure {
    return (text) => {
        if (measureContext === undefined) {
            measureContext = null;
            try {
                const jsdom = typeof navigator !== 'undefined' && navigator.userAgent.includes('jsdom');
                if (!jsdom && typeof document !== 'undefined') measureContext = document.createElement('canvas').getContext('2d');
            } catch {
                measureContext = null;
            }
        }
        if (measureContext === null) return null;
        measureContext.font = font;
        return measureContext.measureText(text).width;
    };
}

/** The auto width for a column whose header label and sampled values are given. */
export function autoColumnWidth(samples: readonly string[], measure?: CsvTextMeasure): number {
    let widest = 0;
    for (const sample of samples) {
        const { text, multiline } = cellDisplayText(sample.length > CSV_SAMPLE_CHARS ? sample.slice(0, CSV_SAMPLE_CHARS) : sample);
        const marker = multiline ? ' ↵' : '';
        const measured = measure?.(text + marker) ?? null;
        widest = Math.max(widest, measured ?? (text.length + marker.length) * CSV_CHAR_PX);
    }
    // +2: the cell's right border and sub-pixel rounding, so an exact fit never ellipsizes.
    const width = Math.ceil(widest + CSV_CELL_PADDING_PX + 2);
    return Math.min(CSV_COLUMN_MAX_AUTO_PX, Math.max(CSV_COLUMN_MIN_AUTO_PX, width));
}

export function clampColumnWidth(width: number): number {
    return Math.min(CSV_COLUMN_MAX_PX, Math.max(CSV_COLUMN_MIN_PX, Math.round(width)));
}

interface PaneWidths {
    readonly auto: Map<number, number>;
    readonly manual: Map<number, number>;
    /** When the pane's widths were last read or written (least recently used goes first). */
    used: number;
}

/**
 * Widths per pane, by stable column id, kept in memory for the life of the window (plan §5:
 * column widths are not persisted across restarts). A module map rather than component state so
 * ⌘E to raw text and back, or a workspace switch that remounts the grid, keeps them. Capped at
 * `CSV_WIDTH_PANES` panes, so a long-lived window that opens many csv files does not keep every
 * one it has closed.
 */
const widths = new Map<string, PaneWidths>();
let widthClock = 0;

function paneWidths(paneID: string): PaneWidths {
    const existing = widths.get(paneID);
    if (existing !== undefined) {
        existing.used = ++widthClock;
        return existing;
    }
    const created: PaneWidths = { auto: new Map(), manual: new Map(), used: ++widthClock };
    widths.set(paneID, created);
    if (widths.size > CSV_WIDTH_PANES) {
        let oldest: string | null = null;
        let oldestUsed = Number.POSITIVE_INFINITY;
        for (const [id, pane] of widths) {
            if (pane.used < oldestUsed) {
                oldest = id;
                oldestUsed = pane.used;
            }
        }
        if (oldest !== null) widths.delete(oldest);
    }
    return created;
}

export const csvColumnWidths = {
    /** The width to draw, or null when the column has not been sized yet. */
    get(paneID: string, column: number): number | null {
        const pane = widths.get(paneID);
        if (pane === undefined) return null;
        pane.used = ++widthClock;
        return pane.manual.get(column) ?? pane.auto.get(column) ?? null;
    },
    /**
     * Widen the auto width when wider content has come into view; never narrow it. Returns
     * whether the width that will be DRAWN changed (a manual width hides the auto one).
     */
    growAuto(paneID: string, column: number, width: number): boolean {
        const pane = paneWidths(paneID);
        const current = pane.auto.get(column);
        if (current !== undefined && current >= width) return false;
        pane.auto.set(column, width);
        return !pane.manual.has(column);
    },
    setManual(paneID: string, column: number, width: number): void {
        paneWidths(paneID).manual.set(column, clampColumnWidth(width));
    },
    /** Tests, and a pane whose document was replaced. */
    clear(paneID?: string): void {
        if (paneID === undefined) widths.clear();
        else widths.delete(paneID);
    }
};

/** Left offsets for each display column (length + 1, last = total width). */
export function columnOffsets(widthsPx: readonly number[]): number[] {
    const offsets = new Array<number>(widthsPx.length + 1);
    offsets[0] = 0;
    for (let index = 0; index < widthsPx.length; index++) offsets[index + 1] = offsets[index]! + widthsPx[index]!;
    return offsets;
}

/** The display columns overlapping [left, left + width), padded by `overscan`. */
export function visibleColumns(
    offsets: readonly number[],
    left: number,
    width: number,
    overscan: number
): { readonly start: number; readonly end: number } {
    const count = offsets.length - 1;
    if (count <= 0) return { start: 0, end: 0 };
    // First column whose right edge is past `left`.
    let low = 0;
    let high = count - 1;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (offsets[mid + 1]! <= left) low = mid + 1;
        else high = mid;
    }
    const first = low;
    let last = first;
    const right = left + Math.max(width, 0);
    while (last < count && offsets[last]! < right) last++;
    return { start: Math.max(0, first - overscan), end: Math.min(count, Math.max(last, first + 1) + overscan) };
}
