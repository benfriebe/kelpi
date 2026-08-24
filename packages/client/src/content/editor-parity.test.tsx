/**
 * §CONT-117 — "the scratchpad editor matches the markdown editor's configuration".
 *
 * `ScratchpadEditorView.swift` and `MarkdownEditorView.swift` are two `NSTextView`s that have to
 * be configured identically: plain text, undo on, no smart substitutions, monospaced 13 pt, a
 * transparent background over the pane fill, a luminance-derived text colour, an overlay
 * scroller and the line-number gutter. The port makes that true by construction — both panes
 * render the SAME `PlainTextEditor` — but "by construction" is an argument, not evidence, and a
 * prop added to one call site and not the other would quietly break it.
 *
 * So this renders both bodies and compares them attribute by attribute. The one clause that is
 * NOT here is the native find bar: a `<textarea>` has no `usesFindBar`, the port leaves ⌘F to
 * the host's own find for both editors, and that divergence is recorded under §CONT-072 (with
 * the binding's refusal exercised in `App.find-gate.test.tsx`).
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { MarkdownPane } from './MarkdownPane';
import { EDITOR_FONT_SIZE } from './PlainTextEditor';
import { ScratchpadPane } from './ScratchpadPane';
import { contentState, createFakeContentApi } from './testing';

const MD = 'DDDDDDDD-0000-4000-8000-000000000001';
const SCRATCH = 'DDDDDDDD-0000-4000-8000-000000000004';

/** Everything §4.2 pins about the text field, read off the rendered element. */
function editorProfile(paneID: string): Record<string, unknown> {
    const area = screen.getByTestId(`content-textarea-${paneID}`) as HTMLTextAreaElement;
    const gutter = screen.getByTestId(`content-gutter-${paneID}`);
    const inner = gutter.firstElementChild as HTMLElement;
    return {
        tag: area.tagName,
        // Plain text: no rich editing surface, and no browser text mangling.
        contentEditable: area.isContentEditable === true,
        spellCheck: area.getAttribute('spellcheck'),
        autoCorrect: area.getAttribute('autocorrect'),
        autoCapitalize: area.getAttribute('autocapitalize'),
        wrap: area.getAttribute('wrap'),
        // Monospaced 13 pt on a transparent fill, text colour from the background's luminance.
        fontFamily: area.style.fontFamily,
        fontSize: area.style.fontSize,
        lineHeight: area.style.lineHeight,
        tabSize: area.style.tabSize,
        color: area.style.color,
        caretColor: area.style.caretColor,
        transparent: area.className.includes('bg-transparent'),
        resize: area.className.includes('resize-none'),
        // The line-number gutter, and the numbers' own chrome styling.
        gutterWidth: gutter.style.width,
        gutterLines: gutter.getAttribute('data-lines'),
        gutterFontFamily: inner.style.fontFamily,
        gutterFontSize: inner.style.fontSize,
        gutterLineHeight: inner.style.lineHeight
    };
}

afterEach(cleanup);

describe('CONT-117: the scratchpad editor and the markdown editor', () => {
    it('are configured identically, down to the gutter', () => {
        const api = createFakeContentApi();
        const body = 'alpha\nbeta\ngamma\n';

        render(<MarkdownPane paneID={MD} content={api} background="#123456" />);
        act(() => {
            api.push(
                contentState({ paneID: MD, type: 'markdown', mode: 'edit', text: body, isDark: true })
            );
        });

        render(<ScratchpadPane paneID={SCRATCH} content={api} background="#123456" />);
        act(() => {
            api.push(
                contentState({
                    paneID: SCRATCH,
                    type: 'scratchpad',
                    mode: 'edit',
                    filePath: null,
                    html: null,
                    text: body,
                    isDark: true
                })
            );
        });

        /*
         * §M29 — `wrap` is the ONE field the two deliberately differ on, so it comes out of the
         * equality and gets a stronger assertion of its own rather than a weaker shared one.
         * `MarkdownEditorView.swift:38-40` keeps the text container tracking the view's width,
         * so a markdown buffer wraps to the pane; the scratchpad's `wrap="off"` is a ledgered
         * divergence (`CONT-070` `[d]`). Every other field is still compared one by one, which
         * is what CONT-117 is about.
         */
        const { wrap: markdownWrap, ...markdown } = editorProfile(MD);
        const { wrap: scratchpadWrap, ...scratchpad } = editorProfile(SCRATCH);
        expect(scratchpad).toEqual(markdown);
        expect(markdownWrap).toBe('soft');
        expect(scratchpadWrap).toBe('off');

        // …and the shared profile is the one §4.2 actually specifies, not just "the same".
        expect(editorProfile(SCRATCH)).toMatchObject({
            tag: 'TEXTAREA',
            contentEditable: false,
            spellCheck: 'false',
            autoCorrect: 'off',
            autoCapitalize: 'off',
            fontSize: `${String(EDITOR_FONT_SIZE)}px`,
            transparent: true,
            resize: true,
            gutterLines: '4' // three lines plus the trailing newline's empty one
        });
    });

    it('both take the pane fill as their background, so neither shows a seam', () => {
        const api = createFakeContentApi();
        render(<MarkdownPane paneID={MD} content={api} background="rgb(9, 9, 11)" />);
        act(() => {
            api.push(contentState({ paneID: MD, type: 'markdown', mode: 'edit', text: 'x' }));
        });
        render(<ScratchpadPane paneID={SCRATCH} content={api} background="rgb(9, 9, 11)" />);
        act(() => {
            api.push(
                contentState({
                    paneID: SCRATCH,
                    type: 'scratchpad',
                    mode: 'edit',
                    filePath: null,
                    html: null,
                    text: 'x'
                })
            );
        });

        const md = screen.getByTestId(`content-editor-${MD}`);
        const scratch = screen.getByTestId(`content-editor-${SCRATCH}`);
        expect(scratch.style.background).toBe(md.style.background);
        expect(scratch.style.background).toBe('rgb(9, 9, 11)');
    });

    it('picks the text colour from the background’s luminance, the same way for both', () => {
        const api = createFakeContentApi();
        render(<MarkdownPane paneID={MD} content={api} />);
        render(<ScratchpadPane paneID={SCRATCH} content={api} />);
        act(() => {
            api.push(
                contentState({ paneID: MD, type: 'markdown', mode: 'edit', text: 'x', isDark: false })
            );
            api.push(
                contentState({
                    paneID: SCRATCH,
                    type: 'scratchpad',
                    mode: 'edit',
                    filePath: null,
                    html: null,
                    text: 'x',
                    isDark: false
                })
            );
        });

        const light = {
            md: (screen.getByTestId(`content-textarea-${MD}`) as HTMLTextAreaElement).style.color,
            scratch: (screen.getByTestId(`content-textarea-${SCRATCH}`) as HTMLTextAreaElement).style.color
        };
        expect(light.scratch).toBe(light.md);

        act(() => {
            api.push(
                contentState({ paneID: MD, type: 'markdown', mode: 'edit', text: 'x', isDark: true })
            );
            api.push(
                contentState({
                    paneID: SCRATCH,
                    type: 'scratchpad',
                    mode: 'edit',
                    filePath: null,
                    html: null,
                    text: 'x',
                    isDark: true
                })
            );
        });
        const dark = (screen.getByTestId(`content-textarea-${SCRATCH}`) as HTMLTextAreaElement).style.color;
        expect(dark).toBe(
            (screen.getByTestId(`content-textarea-${MD}`) as HTMLTextAreaElement).style.color
        );
        // A light document and a dark one must not read the same, or the rule is not applied.
        expect(dark).not.toBe(light.scratch);
    });
});
