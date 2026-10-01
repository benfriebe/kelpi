/**
 * §4.4: ⌘F in the built-in editor (issue #305).
 *
 * A scratchpad, and a markdown pane in edit mode, used to decline ⌘F so the chord could fall
 * through to "the host's own find" (§CONT-072). The Electron shell has none, so the key did
 * nothing. The editor now draws the shared `PaneSearchOverlay` over a scan of its own buffer;
 * these drive the REAL panes through the token the app's `toggle_search` binding bumps, and read
 * the result off the textarea itself: its selection, its scroll, and the caret on close.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { MarkdownPane } from './MarkdownPane';
import { EDITOR_LINE_PX, EDITOR_PADDING } from './PlainTextEditor';
import { ScratchpadPane } from './ScratchpadPane';
import { contentState, createFakeContentApi, type FakeContentApi } from './testing';
import type { FindPalette } from './bridge';

const PANE = 'DDDDDDDD-0000-4000-8000-000000000004';
const TEXT = 'alpha beta\ngamma BETA\n';

afterEach(cleanup);

function scratchState(text: string, revision = 1) {
    return contentState({
        paneID: PANE,
        type: 'scratchpad',
        mode: 'edit',
        filePath: null,
        html: null,
        assetBase: null,
        revision,
        text
    });
}

interface Mounted {
    readonly api: FakeContentApi;
    /** Re-render with the app's find token at `token` (a bump is ⌘F). */
    find(token: number): void;
    /** Re-render on or off screen (a zoomed sibling, a parked pane), keeping the token. */
    show(visible: boolean): void;
}

function mountScratchpad(text = TEXT, palette?: Partial<FindPalette>): Mounted {
    const api = createFakeContentApi();
    let token = 0;
    let visible = true;
    const view = () => (
        <ScratchpadPane paneID={PANE} content={api} focused visible={visible} findToken={token} findPalette={palette} />
    );
    const { rerender } = render(view());
    act(() => {
        api.push(scratchState(text));
    });
    return {
        api,
        find(next) {
            token = next;
            rerender(view());
        },
        show(next) {
            visible = next;
            rerender(view());
        }
    };
}

function area(): HTMLTextAreaElement {
    return screen.getByTestId(`content-textarea-${PANE}`) as HTMLTextAreaElement;
}

function field(): HTMLInputElement {
    return screen.getByTestId(`content-find-input-${PANE}`) as HTMLInputElement;
}

function type(needle: string): void {
    fireEvent.change(field(), { target: { value: needle } });
}

function count(): string | null {
    return screen.queryByTestId(`content-find-count-${PANE}`)?.textContent ?? null;
}

function selection(): [number, number] {
    return [area().selectionStart, area().selectionEnd];
}

function marks(): HTMLElement[] {
    const layer = screen.queryByTestId(`content-find-highlights-${PANE}`);
    return layer === null ? [] : [...layer.querySelectorAll<HTMLElement>('mark')];
}

describe('§4.4: the scratchpad editor find bar', () => {
    it('opens on ⌘F (a token bump) and takes the caret into its field', () => {
        const h = mountScratchpad();
        expect(screen.queryByTestId(`content-find-${PANE}`)).toBeNull();

        h.find(1);
        const bar = screen.getByTestId(`content-find-${PANE}`);
        expect(bar.getAttribute('role')).toBe('search');
        expect(bar.getAttribute('aria-label')).toMatch(/^Find in scratchpad/);
        expect(document.activeElement).toBe(field());
        // The counter rule is the shared bar's: nothing at all until something is typed.
        expect(count()).toBeNull();
    });

    it('selects the first match as you type, and highlights every match with that one current', () => {
        const h = mountScratchpad();
        h.find(1);

        type('beta');
        expect(count()).toBe('1/2');
        expect(selection()).toEqual([6, 10]);
        expect(marks().map((mark) => [mark.textContent, mark.dataset['findMatch']])).toEqual([
            ['beta', 'current'],
            // Case-folded, like the preview's find: `BETA` is a match.
            ['BETA', 'match']
        ]);
    });

    it('steps with Return / ⇧Return, wrapping at both ends, and the selection follows', () => {
        const h = mountScratchpad();
        h.find(1);
        type('beta');

        fireEvent.keyDown(field(), { key: 'Enter' });
        expect(count()).toBe('2/2');
        expect(selection()).toEqual([17, 21]);
        expect(marks().map((mark) => mark.dataset['findMatch'])).toEqual(['match', 'current']);

        fireEvent.keyDown(field(), { key: 'Enter' });
        expect(count()).toBe('1/2');
        expect(selection()).toEqual([6, 10]);

        fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true });
        expect(count()).toBe('2/2');
        expect(selection()).toEqual([17, 21]);

        // The chevrons are the same two steps (up is next, as the shared bar wires them).
        fireEvent.click(screen.getByTestId(`content-find-next-${PANE}`));
        expect(count()).toBe('1/2');
        fireEvent.click(screen.getByTestId(`content-find-prev-${PANE}`));
        expect(count()).toBe('2/2');
    });

    it('Escape closes the bar and hands the caret back to the text, on the last match', () => {
        const h = mountScratchpad();
        h.find(1);
        type('beta');
        fireEvent.keyDown(field(), { key: 'Enter' });

        fireEvent.keyDown(field(), { key: 'Escape' });
        expect(screen.queryByTestId(`content-find-${PANE}`)).toBeNull();
        expect(marks()).toEqual([]);
        expect(document.activeElement).toBe(area());
        expect(selection()).toEqual([17, 21]);
    });

    it('the ✕ and a second ⌘F from the field close it the same way', () => {
        const h = mountScratchpad();
        h.find(1);
        type('gamma');
        fireEvent.click(screen.getByTestId(`content-find-close-${PANE}`));
        expect(screen.queryByTestId(`content-find-${PANE}`)).toBeNull();
        expect(document.activeElement).toBe(area());
        expect(selection()).toEqual([11, 16]);

        h.find(2);
        fireEvent.keyDown(field(), { key: 'f', metaKey: true });
        expect(screen.queryByTestId(`content-find-${PANE}`)).toBeNull();
        expect(document.activeElement).toBe(area());
    });

    it('a needle with no match counts -/0, selects nothing new and draws no highlights', () => {
        const h = mountScratchpad();
        act(() => {
            area().setSelectionRange(3, 3);
        });
        h.find(1);
        type('zeta');
        expect(count()).toBe('-/0');
        expect(marks()).toEqual([]);
        expect(selection()).toEqual([3, 3]);

        // Closing with nothing found leaves the caret where the user had it.
        fireEvent.keyDown(field(), { key: 'Escape' });
        expect(document.activeElement).toBe(area());
        expect(selection()).toEqual([3, 3]);
    });

    it('a second ⌘F while open pulls the caret back into the field without moving the match', () => {
        const h = mountScratchpad();
        h.find(1);
        type('beta');
        fireEvent.keyDown(field(), { key: 'Enter' });
        act(() => {
            area().focus();
        });

        h.find(2);
        expect(document.activeElement).toBe(field());
        expect(field().value).toBe('beta');
        expect(count()).toBe('2/2');
    });

    /**
     * Opening the bar is not a request to move. A reopened bar shows its old needle and its
     * matches, selects none of them until it is stepped or edited, and ⌘F then Escape leaves the
     * caret where the user was typing.
     */
    it('reopens with its needle highlighted but nothing selected, and moves nothing until stepped', () => {
        const h = mountScratchpad();
        h.find(1);
        type('beta');
        fireEvent.keyDown(field(), { key: 'Enter' });
        fireEvent.keyDown(field(), { key: 'Escape' });
        act(() => {
            area().setSelectionRange(2, 2);
        });

        h.find(2);
        expect(field().value).toBe('beta');
        expect(count()).toBe('-/2');
        expect(marks().map((mark) => mark.dataset['findMatch'])).toEqual(['match', 'match']);
        expect(selection()).toEqual([2, 2]);

        fireEvent.keyDown(field(), { key: 'Escape' });
        expect(document.activeElement).toBe(area());
        expect(selection()).toEqual([2, 2]);

        h.find(3);
        fireEvent.keyDown(field(), { key: 'Enter' });
        expect(count()).toBe('1/2');
        expect(selection()).toEqual([6, 10]);
    });

    it('a needle that stops matching hands back the caret the bar opened from, not a passed-through match', () => {
        const h = mountScratchpad();
        act(() => {
            area().setSelectionRange(20, 20);
        });
        h.find(1);
        type('be');
        expect(selection()).toEqual([6, 8]);
        type('bez');
        expect(count()).toBe('-/0');

        fireEvent.keyDown(field(), { key: 'Escape' });
        expect(document.activeElement).toBe(area());
        expect(selection()).toEqual([20, 20]);
    });

    it('Escape in the TEXT closes the bar and leaves the caret where the user put it', () => {
        const h = mountScratchpad();
        h.find(1);
        type('beta');
        // The user clicks back into the text to edit, with the bar still open.
        act(() => {
            area().focus();
            area().setSelectionRange(1, 1);
        });

        fireEvent.keyDown(area(), { key: 'Escape' });
        expect(screen.queryByTestId(`content-find-${PANE}`)).toBeNull();
        expect(marks()).toEqual([]);
        expect(document.activeElement).toBe(area());
        expect(selection()).toEqual([1, 1]);
    });

    it('a pane that goes off screen and back does not pull the caret into its bar', () => {
        const h = mountScratchpad();
        h.find(1);
        type('beta');
        const elsewhere = document.createElement('input');
        document.body.appendChild(elsewhere);
        try {
            h.show(false);
            act(() => {
                elsewhere.focus();
            });
            h.show(true);
            expect(screen.getByTestId(`content-find-${PANE}`)).toBeTruthy();
            expect(field().value).toBe('beta');
            expect(document.activeElement).toBe(elsewhere);
        } finally {
            elsewhere.remove();
        }
    });

    /**
     * A file that still has its CRLFs (nothing typed into it yet) is one character longer per
     * line ending than the textarea it fills, which normalizes them to LF. Raw offsets selected
     * the wrong characters: `beta` on line 2 came out as `eta` plus the next character.
     */
    it('selects the right characters in a CRLF buffer', () => {
        const h = mountScratchpad('alpha\r\nbeta\r\ngamma beta\r\n');
        expect(area().value).toBe('alpha\nbeta\ngamma beta\n');
        h.find(1);
        type('beta');
        const selected = (): string => area().value.slice(area().selectionStart, area().selectionEnd);
        expect(count()).toBe('1/2');
        expect(selected()).toBe('beta');
        fireEvent.keyDown(field(), { key: 'Enter' });
        expect(selected()).toBe('beta');
        expect(selection()).toEqual([17, 21]);

        fireEvent.keyDown(field(), { key: 'Escape' });
        expect(selected()).toBe('beta');
        expect(selection()).toEqual([17, 21]);
    });

    /**
     * The app hands every pane but the requested one a 0. That is the request moving away, and a
     * pane that took it as a request would pop its bar open every time ⌘F was pressed elsewhere.
     */
    it('a token falling back to 0 is not a request', () => {
        const h = mountScratchpad();
        h.find(1);
        fireEvent.keyDown(field(), { key: 'Escape' });

        h.find(0);
        expect(screen.queryByTestId(`content-find-${PANE}`)).toBeNull();
        // …and the next real request (0 → 1) still opens it.
        h.find(1);
        expect(screen.getByTestId(`content-find-${PANE}`)).toBeTruthy();
    });

    it('recounts when the buffer changes under an open bar', () => {
        const h = mountScratchpad();
        h.find(1);
        type('beta');
        expect(count()).toBe('1/2');

        // Another client's autosave, adopted because the field (not the textarea) has the caret.
        act(() => {
            h.api.push(scratchState('beta beta beta', 2));
        });
        expect(area().value).toBe('beta beta beta');
        expect(count()).toBe('1/3');
        expect(marks()).toHaveLength(3);
        // …and the textarea's selection follows the match the bar is on to its new offsets.
        expect(selection()).toEqual([0, 4]);
    });

    it('scrolls a match below the viewport into the middle of it', () => {
        const lines = Array.from({ length: 200 }, (_unused, index) => (index === 149 ? 'the needle here' : `line ${String(index)}`));
        const h = mountScratchpad(lines.join('\n'));
        const textarea = area();
        let top = 0;
        Object.defineProperty(textarea, 'clientHeight', { configurable: true, value: 160 });
        Object.defineProperty(textarea, 'clientWidth', { configurable: true, value: 400 });
        Object.defineProperty(textarea, 'scrollTop', {
            configurable: true,
            get: () => top,
            set: (next: number) => {
                top = next;
            }
        });

        h.find(1);
        type('needle');
        expect(count()).toBe('1/1');
        // Line 150 starts at row 149: its top, less half the viewport around one row.
        const rowTop = EDITOR_PADDING + 149 * EDITOR_LINE_PX;
        expect(top).toBe(rowTop - (160 - EDITOR_LINE_PX) / 2);

        // A match already on screen is not scrolled to again.
        top = rowTop - 20;
        fireEvent.keyDown(field(), { key: 'Enter' });
        expect(top).toBe(rowTop - 20);
    });

    it('draws highlights for the lines over the viewport only, as the gutter draws numbers', () => {
        const h = mountScratchpad(Array.from({ length: 2000 }, () => 'x').join('\n'));
        const textarea = area();
        Object.defineProperty(textarea, 'clientHeight', { configurable: true, value: 160 });
        Object.defineProperty(textarea, 'scrollTop', { configurable: true, value: 0 });
        fireEvent.scroll(textarea);

        h.find(1);
        type('x');
        expect(count()).toBe('1/2000');
        const drawn = marks().length;
        expect(drawn).toBeGreaterThan(0);
        // The gutter's own window, overscan included, and nowhere near the whole buffer.
        const window = screen.getByTestId(`content-gutter-${PANE}`).getAttribute('data-window');
        const [first, last] = (window ?? '').split('-').map(Number);
        expect(drawn).toBe((last as number) - (first as number) + 1);
        expect(drawn).toBeLessThan(100);
    });

    it("paints the highlights in the user's SET-219 colours", () => {
        const h = mountScratchpad(TEXT, { match: '#112233', matchText: '#ffffff', current: '#445566', currentText: '#eeeeee' });
        h.find(1);
        type('beta');
        const [current, other] = marks();
        expect(current?.style.background).toBe('rgb(68, 85, 102)');
        expect(current?.style.color).toBe('rgb(238, 238, 238)');
        expect(other?.style.background).toBe('rgb(17, 34, 51)');
        expect(other?.style.color).toBe('rgb(255, 255, 255)');
    });
});

describe('§4.4: a markdown pane in edit mode', () => {
    it('opens the editor find bar over the SOURCE text', () => {
        const api = createFakeContentApi();
        const view = (token: number) => (
            <MarkdownPane paneID={PANE} content={api} focused visible findToken={token} />
        );
        const { rerender } = render(view(0));
        act(() => {
            api.push(contentState({ paneID: PANE, mode: 'edit', text: '# Title\n\nSome **bold** text\n' }));
        });
        expect(screen.getByTestId(`content-textarea-${PANE}`)).toBeTruthy();

        rerender(view(1));
        expect(screen.getByTestId(`content-find-${PANE}`).getAttribute('aria-label')).toMatch(/^Find in markdown editor/);
        // Markup is text here: the needle finds the asterisks the preview would have rendered away.
        type('**bold**');
        expect(count()).toBe('1/1');
        expect(selection()).toEqual([14, 22]);

        fireEvent.keyDown(field(), { key: 'Escape' });
        expect(document.activeElement).toBe(area());
        expect(selection()).toEqual([14, 22]);
    });
});
