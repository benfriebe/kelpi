/**
 * §M60 — the gutter's per-line wrapped heights.
 *
 * M29 gave the markdown editor `wrap="soft"` (`MarkdownEditorView.swift:38-40`), and the gutter
 * kept emitting one number per LOGICAL line at a fixed 16 px pitch — so every wrapped line pushed
 * the whole column below it down by a row (`run-R/21-markdown-edit-toggle-edit.png`: `12` beside
 * line 11). `LineNumberRulerView.swift:88-133` has neither problem, because `NSLayoutManager`
 * hands it `lineFragmentRect(forGlyphAt:)` — the FIRST fragment of each line.
 *
 * The port measures instead, in a hidden mirror styled to the textarea's content box. This file
 * covers the model (the cache, the prefix sums, the row → line search, the cheap refusal) and
 * then the component, with the mirror's measurements stubbed the way jsdom forces: a real browser
 * lays text out, jsdom reports zero for everything, so the two DOM reads — one advance width, one
 * line height — are the seam the test drives.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EDITOR_LINE_PX, EDITOR_PADDING, PlainTextEditor } from './PlainTextEditor';
import {
    cannotWrap,
    createWrapCache,
    lineAtRow,
    prefixSums,
    splitLines,
    wrapMetrics,
    wrappedLineWindow
} from './wrap';

const PANE = 'DDDDDDDD-0000-4000-8000-0000000000M6'.replace('M6', 'A6');

afterEach(cleanup);

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

describe('splitLines / prefixSums', () => {
    it('splits the way `lineStarts` counts, so the two arrays are index-aligned', () => {
        expect(splitLines('')).toEqual(['']);
        expect(splitLines('one')).toEqual(['one']);
        expect(splitLines('one\ntwo')).toEqual(['one', 'two']);
        // A trailing newline opens one more (empty) line — §4.2's own rule.
        expect(splitLines('one\n')).toEqual(['one', '']);
    });

    it('is `[0, …, total]`, one longer than the rows it sums', () => {
        expect(prefixSums([])).toEqual([0]);
        expect(prefixSums([1, 1, 1])).toEqual([0, 1, 2, 3]);
        expect(prefixSums([1, 3, 1, 2])).toEqual([0, 1, 4, 5, 7]);
    });
});

describe('cannotWrap — the cheap refusal', () => {
    it('answers a short ASCII line without measuring anything', () => {
        expect(cannotWrap('', 400, 8)).toBe(true);
        expect(cannotWrap('x'.repeat(10), 400, 8)).toBe(true);
        // 49 × 8 = 392 = the width minus one character of slack.
        expect(cannotWrap('x'.repeat(49), 400, 8)).toBe(true);
        expect(cannotWrap('x'.repeat(50), 400, 8)).toBe(false);
    });

    it('refuses to guess for anything that is not one advance wide', () => {
        // A double-width glyph, an emoji and a tab all measure wider than `length × charWidth`.
        expect(cannotWrap('日本語', 400, 8)).toBe(false);
        expect(cannotWrap('😀', 400, 8)).toBe(false);
        expect(cannotWrap('a\tb', 400, 8)).toBe(false);
        // And with no measured advance at all, nothing is refused.
        expect(cannotWrap('short', 400, 0)).toBe(false);
        expect(cannotWrap('short', 0, 8)).toBe(false);
    });
});

describe('wrapMetrics — the measurement cache', () => {
    const WIDTH = 400;
    const CHAR = 8;

    /** A stand-in for the mirror: 50 characters per row at this width. */
    function measurer(): { measure: (text: string) => number; calls: string[] } {
        const calls: string[] = [];
        return {
            calls,
            measure: (text: string) => {
                calls.push(text);
                return Math.max(1, Math.ceil(text.length / 50));
            }
        };
    }

    it('measures only the lines that might wrap, and caches them by text', () => {
        const cache = createWrapCache();
        const { measure, calls } = measurer();
        const lines = ['short', 'x'.repeat(120), 'short', 'x'.repeat(120)];

        const metrics = wrapMetrics(cache, { lines, width: WIDTH, charWidth: CHAR, measure });
        expect(metrics?.rows).toEqual([1, 3, 1, 3]);
        expect(metrics?.offsets).toEqual([0, 1, 4, 5, 8]);
        // The two short lines never reached the DOM, and the repeated long line was measured once.
        expect(calls).toEqual(['x'.repeat(120)]);
    });

    it('re-measures ONLY the line an edit changed', () => {
        const cache = createWrapCache();
        const { measure, calls } = measurer();
        const first = ['x'.repeat(120), 'y'.repeat(120)];
        wrapMetrics(cache, { lines: first, width: WIDTH, charWidth: CHAR, measure });
        expect(calls).toHaveLength(2);

        calls.length = 0;
        const edited = ['x'.repeat(120), 'y'.repeat(180)];
        const metrics = wrapMetrics(cache, { lines: edited, width: WIDTH, charWidth: CHAR, measure });
        expect(calls).toEqual(['y'.repeat(180)]);
        expect(metrics?.rows).toEqual([3, 4]);
    });

    it('drops every height when the width changes — a resize invalidates all of them', () => {
        const cache = createWrapCache();
        const calls: string[] = [];
        const measure = (text: string): number => {
            calls.push(text);
            return text.length > 100 ? 3 : 1;
        };
        const lines = ['x'.repeat(120)];
        wrapMetrics(cache, { lines, width: WIDTH, charWidth: CHAR, measure });
        expect(calls).toHaveLength(1);

        wrapMetrics(cache, { lines, width: WIDTH, charWidth: CHAR, measure });
        expect(calls).toHaveLength(1); // cache hit

        wrapMetrics(cache, { lines, width: 900, charWidth: CHAR, measure });
        expect(calls).toHaveLength(2); // width moved: measured again
    });

    it('returns the PREVIOUS object by identity when nothing moved', () => {
        const cache = createWrapCache();
        const { measure } = measurer();
        const lines = ['short', 'x'.repeat(120)];
        const first = wrapMetrics(cache, { lines, width: WIDTH, charWidth: CHAR, measure });
        const second = wrapMetrics(cache, {
            lines,
            width: WIDTH,
            charWidth: CHAR,
            measure,
            previous: first
        });
        // Identity is what keeps the component's layout effect from looping.
        expect(second).toBe(first);

        const third = wrapMetrics(cache, {
            lines: [...lines, 'more'],
            width: WIDTH,
            charWidth: CHAR,
            measure,
            previous: first
        });
        expect(third).not.toBe(first);
    });

    it('has no answer for an unmeasured box', () => {
        const cache = createWrapCache();
        const { measure } = measurer();
        expect(wrapMetrics(cache, { lines: ['a'], width: 0, charWidth: CHAR, measure })).toBeNull();
    });
});

describe('lineAtRow / wrappedLineWindow', () => {
    // Lines 1..5, where line 2 takes 3 rows and line 4 takes 2 — 8 visual rows in all.
    const offsets = prefixSums([1, 3, 1, 2, 1]);

    it('maps a visual row to the logical line that owns it', () => {
        expect(offsets).toEqual([0, 1, 4, 5, 7, 8]);
        expect(lineAtRow(offsets, 0)).toBe(1);
        expect(lineAtRow(offsets, 1)).toBe(2);
        expect(lineAtRow(offsets, 3)).toBe(2); // still inside line 2's third row
        expect(lineAtRow(offsets, 4)).toBe(3);
        expect(lineAtRow(offsets, 5)).toBe(4);
        expect(lineAtRow(offsets, 6)).toBe(4);
        expect(lineAtRow(offsets, 7)).toBe(5);
        // Past the end clamps to the last line rather than to one that is not there.
        expect(lineAtRow(offsets, 99)).toBe(5);
        expect(lineAtRow(offsets, -5)).toBe(1);
    });

    it('draws everything while the viewport is unmeasured', () => {
        expect(
            wrappedLineWindow({
                offsets,
                scrollTop: 0,
                viewportHeight: 0,
                lineHeight: EDITOR_LINE_PX,
                paddingTop: EDITOR_PADDING
            })
        ).toEqual({ first: 1, last: 5 });
    });

    it('resolves the window through the ROWS, not through the line count', () => {
        // Scrolled to visual row 5, which is line 4 — the fixed-pitch answer would be line 6.
        const window = wrappedLineWindow({
            offsets,
            scrollTop: EDITOR_PADDING + 5 * EDITOR_LINE_PX,
            viewportHeight: 2 * EDITOR_LINE_PX,
            lineHeight: EDITOR_LINE_PX,
            paddingTop: EDITOR_PADDING,
            overscan: 0
        });
        expect(window).toEqual({ first: 4, last: 5 });
    });

    it('clamps at both ends, overscan included', () => {
        expect(
            wrappedLineWindow({
                offsets,
                scrollTop: 0,
                viewportHeight: 100,
                lineHeight: EDITOR_LINE_PX,
                paddingTop: EDITOR_PADDING,
                overscan: 4
            })
        ).toEqual({ first: 1, last: 5 });
        expect(
            wrappedLineWindow({
                offsets,
                scrollTop: 99_999,
                viewportHeight: 100,
                lineHeight: EDITOR_LINE_PX,
                paddingTop: EDITOR_PADDING,
                overscan: 0
            })
        ).toEqual({ first: 5, last: 5 });
    });
});

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

const CHAR_WIDTH = 8;
const CONTENT_WIDTH = 400;
const PER_ROW = CONTENT_WIDTH / CHAR_WIDTH; // 50 characters

/**
 * jsdom lays nothing out, so the two reads the mirror makes are stubbed here: the probe's advance
 * width, and the mirror's height for whatever text it currently holds. Everything between them —
 * which lines are measured, what is cached, where the numbers land — is the real code.
 */
function stubLayout(paneID: string, { viewport, scrollTop }: { viewport: number; scrollTop: number }): void {
    const area = screen.getByTestId(`content-textarea-${paneID}`);
    Object.defineProperty(area, 'clientWidth', { configurable: true, value: CONTENT_WIDTH });
    Object.defineProperty(area, 'clientHeight', { configurable: true, value: viewport });
    Object.defineProperty(area, 'scrollTop', { configurable: true, value: scrollTop });

    const probe = screen.queryByTestId(`content-gutter-probe-${paneID}`);
    if (probe !== null) {
        Object.defineProperty(probe, 'offsetWidth', { configurable: true, value: CHAR_WIDTH * 64 });
    }
    const mirror = screen.queryByTestId(`content-gutter-mirror-${paneID}`)?.lastElementChild ?? null;
    if (mirror !== null) {
        Object.defineProperty(mirror, 'offsetHeight', {
            configurable: true,
            get(this: Element): number {
                const text = this.textContent ?? '';
                return Math.max(1, Math.ceil(text.length / PER_ROW)) * EDITOR_LINE_PX;
            }
        });
    }
}

function gutterRows(paneID: string): { number: string; rows: number; height: string }[] {
    const inner = screen.getByTestId(`content-gutter-${paneID}`).firstElementChild;
    return [...(inner?.children ?? [])].map((row) => ({
        number: row.textContent ?? '',
        rows: Number(row.getAttribute('data-rows') ?? '1'),
        height: (row as HTMLElement).style.height
    }));
}

function gutterPaddingTop(paneID: string): number {
    const inner = screen.getByTestId(`content-gutter-${paneID}`).firstElementChild as HTMLElement;
    return Number.parseFloat(inner.style.paddingTop);
}

/** Five short lines with a 150-character (3-row) paragraph as line 2. */
const WRAPPING_DOC = ['# Heading', 'p'.repeat(150), '## A list', '- one', '- two'].join('\n');

describe('the markdown editor’s gutter (§M60)', () => {
    it('gives a wrapped line a number as tall as the line, at its FIRST visual row', () => {
        const view = render(
            <PlainTextEditor
                paneID={PANE}
                ariaLabel="markdown editor"
                value={WRAPPING_DOC}
                onChange={() => {}}
                showGutter
                wrap="soft"
            />
        );
        act(() => {
            stubLayout(PANE, { viewport: 0, scrollTop: 0 });
            view.rerender(
                <PlainTextEditor
                    paneID={PANE}
                    ariaLabel="markdown editor"
                    value={`${WRAPPING_DOC} `}
                    onChange={() => {}}
                    showGutter
                    wrap="soft"
                />
            );
        });

        const rows = gutterRows(PANE);
        expect(rows.map((row) => row.number)).toEqual(['1', '2', '3', '4', '5']);
        // Line 2 is three visual rows; its number box is three rows tall, so the number itself
        // sits on the first of them and line 3's number lands on line 3's own first row.
        expect(rows.map((row) => row.rows)).toEqual([1, 3, 1, 1, 1]);
        expect(rows[1]?.height).toBe(`${String(3 * EDITOR_LINE_PX)}px`);
        expect(rows[2]?.height).toBe('');
        // The document's height in VISUAL rows, which a live check can hold against the
        // textarea's own `scrollHeight`.
        const gutter = screen.getByTestId(`content-gutter-${PANE}`);
        expect(gutter.getAttribute('data-rows-total')).toBe('7');
        expect(gutter.getAttribute('data-lines')).toBe('5');
    });

    it('pays for the wrapped rows ABOVE the window in padding, not for logical lines', () => {
        // 40 lines; every fourth one wraps to three rows.
        const lines = Array.from({ length: 40 }, (_unused, index) =>
            index % 4 === 1 ? 'p'.repeat(150) : `line ${String(index + 1)}`
        );
        const view = render(
            <PlainTextEditor
                paneID={PANE}
                ariaLabel="markdown editor"
                value={lines.join('\n')}
                onChange={() => {}}
                showGutter
                wrap="soft"
            />
        );
        // Visual rows: lines 1..12 occupy 1+3+1+1 per group of four = 6 rows per 4 lines, so the
        // first visual row of line 13 is 18. Scroll exactly there.
        act(() => {
            stubLayout(PANE, { viewport: 8 * EDITOR_LINE_PX, scrollTop: EDITOR_PADDING + 18 * EDITOR_LINE_PX });
            view.rerender(
                <PlainTextEditor
                    paneID={PANE}
                    ariaLabel="markdown editor"
                    value={lines.join('\n')}
                    onChange={() => {}}
                    showGutter
                    wrap="soft"
                />
            );
            fireEvent.scroll(screen.getByTestId(`content-textarea-${PANE}`));
        });

        const rows = gutterRows(PANE);
        const first = Number(rows[0]?.number);
        // The window is bounded (CONT-078 still holds) and it starts above line 13 by the
        // overscan, never at line 1.
        expect(rows.length).toBeLessThan(40);
        expect(first).toBeGreaterThan(1);
        expect(rows.map((row) => row.number)).toContain('13');

        // Every drawn number's own offset, computed from the rows the fixture defines.
        const rowsPerLine = lines.map((line) => (line.length > PER_ROW ? 3 : 1));
        const offsetRows = rowsPerLine.slice(0, first - 1).reduce((sum, count) => sum + count, 0);
        expect(gutterPaddingTop(PANE)).toBe(EDITOR_PADDING + offsetRows * EDITOR_LINE_PX);

        // …and the number 13 itself sits at its true visual row, 18 — which is what the old
        // fixed-pitch padding (12 rows) got wrong by six rows.
        const before = rows.slice(0, rows.findIndex((row) => row.number === '13'));
        const rowsAbove13 = before.reduce((sum, row) => sum + row.rows, 0);
        expect(offsetRows + rowsAbove13).toBe(18);
    });

    it('re-measures the edited line only, and keeps the numbers right afterwards', () => {
        const view = render(
            <PlainTextEditor
                paneID={PANE}
                ariaLabel="markdown editor"
                value={WRAPPING_DOC}
                onChange={() => {}}
                showGutter
                wrap="soft"
            />
        );
        act(() => {
            stubLayout(PANE, { viewport: 0, scrollTop: 0 });
            view.rerender(
                <PlainTextEditor
                    paneID={PANE}
                    ariaLabel="markdown editor"
                    value={WRAPPING_DOC}
                    onChange={() => {}}
                    showGutter
                    wrap="soft"
                />
            );
        });
        expect(gutterRows(PANE).map((row) => row.rows)).toEqual([1, 3, 1, 1, 1]);

        // Type into the wrapping paragraph until it takes a fourth row.
        const onChange = vi.fn();
        act(() => {
            fireEvent.change(screen.getByTestId(`content-textarea-${PANE}`), {
                target: {
                    value: ['# Heading', 'p'.repeat(160), '## A list', '- one', '- two'].join('\n')
                }
            });
        });
        expect(onChange).not.toHaveBeenCalled();
        expect(gutterRows(PANE).map((row) => row.rows)).toEqual([1, 4, 1, 1, 1]);
    });
});

describe('the scratchpad’s gutter keeps the fixed-pitch path (§M60 / CONT-070)', () => {
    it('mounts no mirror and measures nothing when `wrap="off"`', () => {
        render(
            <PlainTextEditor
                paneID={PANE}
                ariaLabel="scratchpad"
                value={WRAPPING_DOC}
                onChange={() => {}}
                showGutter
            />
        );
        expect(screen.queryByTestId(`content-gutter-mirror-${PANE}`)).toBeNull();
        expect(screen.queryByTestId(`content-gutter-probe-${PANE}`)).toBeNull();
        // No `data-rows`, no heights: one number per logical line at the shared pitch.
        expect(gutterRows(PANE).map((row) => row.height)).toEqual(['', '', '', '', '']);
        expect(gutterPaddingTop(PANE)).toBe(EDITOR_PADDING);
        // One visual row per logical line, by definition — the same document that wraps to 7
        // rows in the markdown editor above.
        const gutter = screen.getByTestId(`content-gutter-${PANE}`);
        expect(gutter.getAttribute('data-rows-total')).toBe('5');
        expect(gutter.getAttribute('data-lines')).toBe('5');
    });

    it('still pays for the lines above the window at the fixed pitch', () => {
        const text = Array.from({ length: 500 }, (_unused, index) => `line ${String(index + 1)}`).join('\n');
        render(
            <PlainTextEditor paneID={PANE} ariaLabel="scratchpad" value={text} onChange={() => {}} showGutter />
        );
        const area = screen.getByTestId(`content-textarea-${PANE}`);
        Object.defineProperty(area, 'clientHeight', { configurable: true, value: 320 });
        Object.defineProperty(area, 'scrollTop', {
            configurable: true,
            value: EDITOR_PADDING + 200 * EDITOR_LINE_PX
        });
        act(() => {
            fireEvent.scroll(area);
        });

        const rows = gutterRows(PANE);
        const first = Number(rows[0]?.number);
        expect(rows.map((row) => row.number)).toContain('201');
        expect(gutterPaddingTop(PANE)).toBe(EDITOR_PADDING + (first - 1) * EDITOR_LINE_PX);
    });
});
