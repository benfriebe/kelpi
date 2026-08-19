/**
 * The built-in editor's line-number gutter (content-panes.md §4.2).
 *
 * The doc is unusually specific here — 11 px numbers, a 36 px floor, "line count = `\n` + 1",
 * an empty document showing "1", a trailing newline showing one extra number — so the metrics
 * are asserted as the contract they are, not as styling.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { GUTTER_MIN_WIDTH, PlainTextEditor, gutterWidth, lineCount } from './PlainTextEditor';
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
