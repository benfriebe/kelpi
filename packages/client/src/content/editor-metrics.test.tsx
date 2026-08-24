/**
 * The built-in editor's typing and layout metrics — §M26, §M27, §M29.
 *
 * All three are the same class of finding: a `<textarea>` behaves like a form field where the
 * shipped app has an `NSTextView`, and the browser defaults were left standing. Tab traversed
 * out of the pane in an editor that sets `tabSize: 4`; the text sat 12 px in on a 1.5 line box
 * where AppKit insets 8 pt and lays 13 pt monospace out at ~1.2 em; and markdown prose ran off
 * the right edge because every editor was `wrap="off"`.
 *
 * Swift: `ScratchpadEditorView.swift:23-33, 44-48`, `MarkdownEditorView.swift:29, 36, 38-40`.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MarkdownPane } from './MarkdownPane';
import { EDITOR_FONT_SIZE, EDITOR_LINE_PX, EDITOR_PADDING, PlainTextEditor } from './PlainTextEditor';
import { ScratchpadPane } from './ScratchpadPane';
import { contentState, createFakeContentApi } from './testing';

const PANE = 'DDDDDDDD-0000-4000-8000-000000000007';
const MD = 'DDDDDDDD-0000-4000-8000-000000000008';
const SCRATCH = 'DDDDDDDD-0000-4000-8000-000000000009';

afterEach(cleanup);

function area(paneID = PANE): HTMLTextAreaElement {
    return screen.getByTestId(`content-textarea-${paneID}`) as HTMLTextAreaElement;
}

/** A controlled editor that keeps its own buffer, the way both panes do. */
function Editor(props: { readonly onChange?: (text: string) => void; readonly readOnly?: boolean }) {
    return (
        <PlainTextEditor
            paneID={PANE}
            ariaLabel="scratchpad"
            value=""
            onChange={props.onChange ?? (() => {})}
            {...(props.readOnly === true ? { readOnly: true } : {})}
        />
    );
}

describe('Tab types a tab (§M26)', () => {
    it('inserts \\t at the caret instead of leaving the pane', () => {
        const onChange = vi.fn();
        render(<Editor onChange={onChange} />);
        const field = area();
        fireEvent.change(field, { target: { value: 'ab' } });
        field.setSelectionRange(1, 1);

        const event = fireEvent.keyDown(field, { key: 'Tab' });

        // `preventDefault` is what stops focus traversal — the whole defect.
        expect(event).toBe(false);
        expect(field.value).toBe('a\tb');
        expect(onChange).toHaveBeenLastCalledWith('a\tb');
        // The caret is after the tab, not parked at the end of the buffer.
        expect(field.selectionStart).toBe(2);
        expect(field.selectionEnd).toBe(2);
    });

    it('replaces a selection, like any other typed character', () => {
        const onChange = vi.fn();
        render(<Editor onChange={onChange} />);
        const field = area();
        fireEvent.change(field, { target: { value: 'alpha beta' } });
        field.setSelectionRange(0, 5);

        fireEvent.keyDown(field, { key: 'Tab' });

        expect(field.value).toBe('\t beta');
        expect(field.selectionStart).toBe(1);
    });

    it('leaves ⇧Tab and modified Tab alone — those are still navigation', () => {
        const onChange = vi.fn();
        render(<Editor onChange={onChange} />);
        const field = area();
        fireEvent.change(field, { target: { value: 'x' } });
        onChange.mockClear();

        for (const modifier of [{ shiftKey: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
            const event = fireEvent.keyDown(field, { key: 'Tab', ...modifier });
            expect(event).toBe(true); // not prevented
        }
        expect(field.value).toBe('x');
        expect(onChange).not.toHaveBeenCalled();
    });

    it('a read-only editor types nothing (the pre-snapshot scratchpad)', () => {
        const onChange = vi.fn();
        render(<Editor onChange={onChange} readOnly />);
        const field = area();

        fireEvent.keyDown(field, { key: 'Tab' });

        expect(field.value).toBe('');
        expect(onChange).not.toHaveBeenCalled();
    });

    it('still toggles edit mode on ⌘E, which shares the same handler', () => {
        const onToggleEdit = vi.fn();
        render(
            <PlainTextEditor
                paneID={PANE}
                ariaLabel="scratchpad"
                value="x"
                onChange={() => {}}
                onToggleEdit={onToggleEdit}
            />
        );
        fireEvent.keyDown(area(), { key: 'e', metaKey: true });
        expect(onToggleEdit).toHaveBeenCalledWith(PANE);
    });
});

describe('editor metrics (§M27)', () => {
    it('insets 8 px and lays rows out at 1.2 em, not 12 px and 1.5', () => {
        render(<Editor />);
        const field = area();
        // `textContainerInset = NSSize(width: 8, height: 8)` — Tailwind's `p-2`.
        expect(field.className).toContain('p-2');
        expect(field.className).not.toContain('p-3');
        expect(EDITOR_PADDING).toBe(8);
        /*
         * An exact integer of px rather than the unitless `1.2` the register sketched: `13 × 1.2`
         * is 15.6, which Chromium snaps to 1/64 px when it lays a row out while the gutter's
         * padding arithmetic uses the unrounded value — the audit measured the drift at 3.12 px
         * by line 1992. 16 px is the same row box to within 0.4 px and accumulates nothing.
         */
        expect(field.style.lineHeight).toBe('16px');
        expect(EDITOR_LINE_PX).toBe(16);
        // ~1.2 em, against the old 1.5 — about a quarter more rows on the same pane.
        expect(Math.abs(EDITOR_LINE_PX - EDITOR_FONT_SIZE * 1.2)).toBeLessThan(0.5);
        expect(EDITOR_LINE_PX).toBeLessThan(EDITOR_FONT_SIZE * 1.5);
    });

    it('the gutter rides the same row height, so the two columns cannot drift', () => {
        render(
            <PlainTextEditor
                paneID={PANE}
                ariaLabel="scratchpad"
                value={'a\nb\nc'}
                onChange={() => {}}
                showGutter
            />
        );
        const inner = screen.getByTestId(`content-gutter-${PANE}`).firstElementChild as HTMLElement;
        expect(inner.style.lineHeight).toBe(`${String(EDITOR_LINE_PX)}px`);
        // The first number sits on the first row's baseline: the same inset, unwindowed.
        expect(inner.style.paddingTop).toBe(`${String(EDITOR_PADDING)}px`);
    });
});

describe('markdown edit mode wraps (§M29)', () => {
    const LONG = `${'a very long line of prose '.repeat(40)}\n`;

    function pushMarkdown(api: ReturnType<typeof createFakeContentApi>): void {
        act(() => {
            api.push(
                contentState({ paneID: MD, type: 'markdown', mode: 'edit', text: LONG, isDark: true })
            );
        });
    }

    it('a markdown buffer soft-wraps to the pane', () => {
        const api = createFakeContentApi();
        render(<MarkdownPane paneID={MD} content={api} />);
        pushMarkdown(api);
        expect(area(MD).getAttribute('wrap')).toBe('soft');
    });

    it('the scratchpad keeps its ledgered `wrap="off"` (CONT-070 [d])', () => {
        const api = createFakeContentApi();
        render(<ScratchpadPane paneID={SCRATCH} content={api} />);
        act(() => {
            api.push(
                contentState({
                    paneID: SCRATCH,
                    type: 'scratchpad',
                    mode: 'edit',
                    filePath: null,
                    html: null,
                    text: LONG,
                    isDark: true
                })
            );
        });
        expect(area(SCRATCH).getAttribute('wrap')).toBe('off');
    });

    it('the editor default is `off`, so nothing else silently changed shape', () => {
        render(<Editor />);
        expect(area().getAttribute('wrap')).toBe('off');
    });
});
