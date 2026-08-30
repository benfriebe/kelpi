/**
 * The built-in editor's line-number gutter (content-panes.md §4.2).
 *
 * The doc is unusually specific here — 11 px numbers, a 36 px floor, "line count = `\n` + 1",
 * an empty document showing "1", a trailing newline showing one extra number — so the metrics
 * are asserted as the contract they are, not as styling.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
    EDITOR_LINE_PX,
    EDITOR_PADDING,
    GUTTER_MIN_WIDTH,
    PlainTextEditor,
    gutterWidth,
    lineCount
} from './PlainTextEditor';
import {
    DEFAULT_GUTTER_OVERSCAN,
    cachedLineStarts,
    lineNumberAt,
    lineStarts,
    resetLineStartCache,
    visibleLineWindow
} from './gutter';
import { createScrollStore } from './scroll';

const PANE = 'DDDDDDDD-0000-4000-8000-000000000002';

function numbers(): string[] {
    const inner = screen.getByTestId(`content-gutter-${PANE}`).firstElementChild;
    return [...(inner?.children ?? [])].map((row) => row.textContent ?? '');
}

afterEach(() => {
    cleanup();
});

describe('lineCount', () => {
    it('is `\\n` count + 1 (§4.2)', () => {
        expect(lineCount('')).toBe(1);
        expect(lineCount('one')).toBe(1);
        expect(lineCount('one\ntwo')).toBe(2);
        // A trailing newline shows an extra final number — deliberately, per the spec.
        expect(lineCount('one\n')).toBe(2);
        expect(lineCount('\n\n')).toBe(3);
    });
});

describe('gutterWidth', () => {
    it('never goes below the 36 px floor and grows with the digit count', () => {
        expect(gutterWidth(1)).toBe(GUTTER_MIN_WIDTH);
        expect(gutterWidth(9)).toBe(GUTTER_MIN_WIDTH);
        expect(gutterWidth(99)).toBe(GUTTER_MIN_WIDTH);
        expect(gutterWidth(1000)).toBeGreaterThan(GUTTER_MIN_WIDTH);
        expect(gutterWidth(100000)).toBeGreaterThan(gutterWidth(1000));
    });
});

describe('PlainTextEditor gutter', () => {
    it('is absent unless asked for', () => {
        render(<PlainTextEditor paneID={PANE} ariaLabel="scratchpad" value="a\nb" onChange={() => {}} />);
        expect(screen.queryByTestId(`content-gutter-${PANE}`)).toBeNull();
    });

    it('numbers every line, 1-based, and shows "1" for an empty document', () => {
        const view = render(
            <PlainTextEditor paneID={PANE} ariaLabel="scratchpad" value="" onChange={() => {}} showGutter />
        );
        expect(numbers()).toEqual(['1']);

        view.rerender(
            <PlainTextEditor
                paneID={PANE}
                ariaLabel="scratchpad"
                value={'alpha\nbeta\ngamma'}
                onChange={() => {}}
                showGutter
            />
        );
        expect(numbers()).toEqual(['1', '2', '3']);
    });

    it('tracks what the user types, not just the incoming value', () => {
        render(
            <PlainTextEditor paneID={PANE} ariaLabel="scratchpad" value="one" onChange={() => {}} showGutter />
        );
        fireEvent.change(screen.getByTestId(`content-textarea-${PANE}`), {
            target: { value: 'one\ntwo\nthree\n' }
        });
        // Four: the trailing newline opens a fourth line (§4.2).
        expect(numbers()).toEqual(['1', '2', '3', '4']);
    });

    /**
     * L38 — `LineNumberRulerView.swift:88-133` fills `bounds` with the gutter colour and draws
     * the numbers. It strokes NOTHING, so in the shipped editor the gutter meets the text on a
     * pure tone change; the port's 1 px divider drew a hard seam down the middle of one pane
     * (`run-N/72-scratchpad-create.png`), which reads as a second pane edge.
     */
    it('meets the text on a tone change, with no rule between them', () => {
        render(
            <PlainTextEditor
                paneID={PANE}
                ariaLabel="scratchpad"
                value={'a\nb\nc'}
                onChange={() => {}}
                showGutter
            />
        );
        const gutter = screen.getByTestId(`content-gutter-${PANE}`);
        expect(gutter.style.background).toContain('--kelpi-header-bg');
        expect(gutter.style.borderRight).toBe('');
        expect(gutter.getAttribute('style')).not.toContain('border');
    });

    it('is hidden from assistive tech and sized by the line count', () => {
        render(
            <PlainTextEditor
                paneID={PANE}
                ariaLabel="scratchpad"
                value={Array.from({ length: 1200 }, () => 'x').join('\n')}
                onChange={() => {}}
                showGutter
            />
        );
        const gutter = screen.getByTestId(`content-gutter-${PANE}`);
        expect(gutter.getAttribute('aria-hidden')).toBe('true');
        expect(gutter.getAttribute('data-lines')).toBe('1200');
        expect(gutter.style.width).toBe(`${String(gutterWidth(1200))}px`);
    });

    it('scrolls in step with the textarea', () => {
        render(
            <PlainTextEditor
                paneID={PANE}
                ariaLabel="scratchpad"
                value={'a\nb\nc\nd'}
                onChange={() => {}}
                showGutter
                scrollStore={createScrollStore()}
            />
        );
        const area = screen.getByTestId(`content-textarea-${PANE}`);
        Object.defineProperty(area, 'scrollTop', { configurable: true, value: 24 });
        fireEvent.scroll(area);

        const inner = screen.getByTestId(`content-gutter-${PANE}`).firstElementChild as HTMLElement;
        expect(inner.style.transform).toBe('translateY(-24px)');
    });
});

/**
 * §CONT-078 — the ruler's three performance rules, ported from
 * `LineNumberRulerView.swift:41-84,136-161`: a cached line-start array, an O(log n) offset →
 * line lookup, and numbers drawn only for the visible rect.
 */
describe('the line-start cache (CONT-078)', () => {
    afterEach(() => {
        resetLineStartCache();
    });

    it('starts every line, so its length IS the line count', () => {
        expect(lineStarts('')).toEqual([0]);
        expect(lineStarts('one')).toEqual([0]);
        expect(lineStarts('one\ntwo')).toEqual([0, 4]);
        // A trailing newline opens a line whose start is the end of the buffer.
        expect(lineStarts('one\n')).toEqual([0, 4]);
        expect(lineStarts('\n\n')).toEqual([0, 1, 2]);
        expect(lineStarts('a\nbb\nccc\n').length).toBe(lineCount('a\nbb\nccc\n'));
    });

    it('hands back the SAME array while the buffer is unchanged', () => {
        const text = 'alpha\nbeta\ngamma';
        const first = cachedLineStarts(text);
        expect(cachedLineStarts(text)).toBe(first);
        // A different buffer rebuilds it; the identical string is a hit again.
        const other = cachedLineStarts(`${text}\ndelta`);
        expect(other).not.toBe(first);
        expect(cachedLineStarts(`${text}\ndelta`)).toBe(other);
    });

    it('binary-searches a character offset to its 1-based line', () => {
        //          0123 456 78901
        const text = 'one\ntwo\nthree';
        const starts = lineStarts(text); // [0, 4, 8]
        expect(lineNumberAt(starts, 0)).toBe(1);
        expect(lineNumberAt(starts, 3)).toBe(1); // the "\n" belongs to the line it ends
        expect(lineNumberAt(starts, 4)).toBe(2);
        expect(lineNumberAt(starts, 7)).toBe(2);
        expect(lineNumberAt(starts, 8)).toBe(3);
        expect(lineNumberAt(starts, text.length)).toBe(3);
        // Out of range on either side clamps rather than throwing.
        expect(lineNumberAt(starts, -5)).toBe(1);
        expect(lineNumberAt(starts, 9_999)).toBe(3);
        expect(lineNumberAt([0], 0)).toBe(1);
    });

    it('agrees with a linear scan over a large buffer', () => {
        const lines = Array.from({ length: 500 }, (_unused, index) => `line ${String(index)}`);
        const text = lines.join('\n');
        const starts = lineStarts(text);
        for (const offset of [0, 7, 42, 500, 1234, text.length - 1, text.length]) {
            const scanned = text.slice(0, offset + 1).split('\n').length;
            expect(lineNumberAt(starts, offset)).toBe(Math.min(scanned, starts.length));
        }
    });
});

describe('visibleLineWindow (CONT-078)', () => {
    const starts = lineStarts(Array.from({ length: 1000 }, () => 'x').join('\n'));

    it('draws the whole document when the viewport has not been measured', () => {
        expect(
            visibleLineWindow({ starts, scrollTop: 0, viewportHeight: 0, lineHeight: 19.5, paddingTop: 12 })
        ).toEqual({ first: 1, last: 1000 });
    });

    it('covers the visible rows plus an overscan on each side', () => {
        const window = visibleLineWindow({
            starts,
            scrollTop: 12 + 100 * 19.5,
            viewportHeight: 390, // 20 rows
            lineHeight: 19.5,
            paddingTop: 12,
            overscan: 4
        });
        // Row 100 (0-based) is line 101.
        expect(window.first).toBe(97);
        expect(window.last).toBe(125);
    });

    it('clamps at both ends of the document', () => {
        const top = visibleLineWindow({
            starts,
            scrollTop: 0,
            viewportHeight: 390,
            lineHeight: 19.5,
            paddingTop: 12
        });
        expect(top.first).toBe(1);
        // Over-scrolled past the end (rubber-banding): the last line, not a line that is not
        // there — the binary search is what makes that fall out rather than an index error.
        const past = visibleLineWindow({
            starts,
            scrollTop: 99_999,
            viewportHeight: 390,
            lineHeight: 19.5,
            paddingTop: 12
        });
        expect(past.last).toBe(1000);
        expect(past.first).toBe(1000 - DEFAULT_GUTTER_OVERSCAN);
    });
});

describe('PlainTextEditor gutter windowing (CONT-078)', () => {
    /** A measured textarea: jsdom reports 0 for both, which means "draw everything". */
    function measure(area: HTMLElement, { height, scrollTop }: { height: number; scrollTop: number }): void {
        Object.defineProperty(area, 'clientHeight', { configurable: true, value: height });
        Object.defineProperty(area, 'scrollTop', { configurable: true, value: scrollTop });
    }

    it('draws only the rows over the viewport, not one node per line', () => {
        const text = Array.from({ length: 5000 }, (_unused, index) => `line ${String(index + 1)}`).join('\n');
        render(
            <PlainTextEditor
                paneID={PANE}
                ariaLabel="scratchpad"
                value={text}
                onChange={() => {}}
                showGutter
                scrollStore={createScrollStore()}
            />
        );
        const gutter = screen.getByTestId(`content-gutter-${PANE}`);
        // Unmeasured: the whole document, exactly as before this change.
        expect(gutter.getAttribute('data-window')).toBe('1-5000');

        const area = screen.getByTestId(`content-textarea-${PANE}`);
        measure(area, { height: 400, scrollTop: EDITOR_PADDING + 2000 * EDITOR_LINE_PX });
        act(() => {
            fireEvent.scroll(area);
        });

        const drawn = numbers();
        expect(drawn.length).toBeLessThan(80); // 5000 lines, tens of nodes
        expect(drawn[0]).toBe(String(2001 - DEFAULT_GUTTER_OVERSCAN));
        expect(drawn).toContain('2001');
        expect(drawn).toContain('2020');
        expect(gutter.getAttribute('data-lines')).toBe('5000');

        // The rows above the window are paid for in padding, so line N still sits on the same
        // baseline as the text it numbers.
        const inner = gutter.firstElementChild as HTMLElement;
        const firstDrawn = Number(drawn[0]);
        expect(inner.style.paddingTop).toBe(
            `${String(EDITOR_PADDING + (firstDrawn - 1) * EDITOR_LINE_PX)}px`
        );
        expect(inner.style.transform).toBe(
            `translateY(${String(-(EDITOR_PADDING + 2000 * EDITOR_LINE_PX))}px)`
        );
    });

    it('re-clamps the window when the buffer shrinks under it', () => {
        const long = Array.from({ length: 400 }, (_unused, index) => String(index)).join('\n');
        const view = render(
            <PlainTextEditor
                paneID={PANE}
                ariaLabel="scratchpad"
                value={long}
                onChange={() => {}}
                showGutter
                scrollStore={createScrollStore()}
            />
        );
        const area = screen.getByTestId(`content-textarea-${PANE}`);
        measure(area, { height: 200, scrollTop: EDITOR_PADDING + 300 * EDITOR_LINE_PX });
        act(() => {
            fireEvent.scroll(area);
        });
        expect(numbers()).toContain('301');

        // The document is replaced by a much shorter one while the scroll position stands.
        view.rerender(
            <PlainTextEditor
                paneID={PANE}
                ariaLabel="scratchpad"
                value={'a\nb\nc'}
                onChange={() => {}}
                showGutter
                scrollStore={createScrollStore()}
            />
        );
        expect(screen.getByTestId(`content-gutter-${PANE}`).getAttribute('data-lines')).toBe('3');
        expect(numbers()).toEqual(['1', '2', '3']);
    });
});
