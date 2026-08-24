/**
 * The content panes' LOW-POLISH fidelity rows that are not metrics — §L45 and §L46.
 *
 * Both are about what the pane says rather than what it does, which is why they share a file:
 *
 *   §L45  before the first snapshot the Swift shows NOTHING (`MarkdownPaneView.swift:64-77`
 *         mounts an empty transparent `WKWebView`; `PaneGridView.swift:289-299` does the same for
 *         a diff). The port drew centred "Loading…" / "Running git diff…" text that, on a local
 *         file or a local `git diff`, only ever flashed.
 *   §L46  the Swift sets no accessibility label at all on these views, so there is no string to
 *         port — but an `<iframe>` with no `title` is worse than an imperfect name, and the port's
 *         names embedded the raw pane UUID, which VoiceOver spells out in full. The rule is:
 *         never a 36-character hex string; the document's own name plus four hex characters,
 *         which keeps two panes on one file distinguishable.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { DiffPane } from './DiffPane';
import { contentPaneLabel, paneShortID } from './labels';
import { MarkdownPane } from './MarkdownPane';
import { ScratchpadPane } from './ScratchpadPane';
import { contentState, createFakeContentApi, type FakeContentApi } from './testing';
import type { ContentPaneState } from './types';

const PANE = 'DDDDDDDD-0000-4000-8000-00000000ABCD';
const OTHER = 'DDDDDDDD-0000-4000-8000-00000000BEEF';

function push(api: FakeContentApi, state: ContentPaneState): void {
    act(() => {
        api.push(state);
    });
}

afterEach(cleanup);

describe('paneShortID / contentPaneLabel (§L46)', () => {
    it('is the last four hex characters, dashes ignored', () => {
        expect(paneShortID(PANE)).toBe('ABCD');
        expect(paneShortID('short')).toBe('hort');
        expect(paneShortID('a-b')).toBe('ab');
        expect(paneShortID('')).toBe('');
    });

    it('names the document, then the short id — and never the whole UUID', () => {
        expect(contentPaneLabel('markdown preview', PANE, '/repo/docs/NOTES.md')).toBe(
            'markdown preview NOTES.md ABCD'
        );
        expect(contentPaneLabel('diff', PANE, null)).toBe('diff ABCD');
        expect(contentPaneLabel('scratchpad', PANE)).toBe('scratchpad ABCD');
        expect(contentPaneLabel('markdown preview', PANE, '/repo/docs/NOTES.md')).not.toContain(PANE);
    });

    it('keeps two panes on the SAME file distinguishable', () => {
        expect(contentPaneLabel('markdown preview', PANE, '/a/NOTES.md')).not.toBe(
            contentPaneLabel('markdown preview', OTHER, '/a/NOTES.md')
        );
    });
});

describe('content pane bodies (§L45, §L46)', () => {
    it('a markdown pane: empty before the snapshot, then a UUID-free frame name', () => {
        const api = createFakeContentApi();
        render(<MarkdownPane paneID={PANE} content={api} />);

        const status = screen.getByTestId(`content-status-${PANE}`);
        expect(status.textContent).toBe('');
        expect(status.textContent).not.toMatch(/loading/i);

        push(api, contentState({ paneID: PANE, filePath: '/repo/docs/NOTES.md' }));
        const frame = screen.getByTestId(`content-iframe-${PANE}`);
        expect(frame.getAttribute('title')).toBe('markdown preview NOTES.md ABCD');
        expect(frame.getAttribute('title')).not.toContain(PANE);
    });

    it('a markdown EDITOR: the same name, on the textarea', () => {
        const api = createFakeContentApi();
        render(<MarkdownPane paneID={PANE} content={api} />);
        push(api, contentState({ paneID: PANE, mode: 'edit', filePath: '/repo/docs/NOTES.md' }));

        const area = screen.getByTestId(`content-textarea-${PANE}`);
        expect(area.getAttribute('aria-label')).toBe('markdown editor NOTES.md ABCD');
        expect(area.getAttribute('aria-label')).not.toContain(PANE);
    });

    it('a diff pane: empty before the snapshot, then a UUID-free frame name', () => {
        const api = createFakeContentApi();
        render(<DiffPane paneID={PANE} content={api} />);

        const status = screen.getByTestId(`content-status-${PANE}`);
        expect(status.textContent).toBe('');
        expect(status.textContent).not.toMatch(/git diff/i);

        push(
            api,
            contentState({ paneID: PANE, type: 'diff', filePath: '/repo/src/main.ts', text: null })
        );
        expect(screen.getByTestId(`content-iframe-${PANE}`).getAttribute('title')).toBe(
            'diff main.ts ABCD'
        );
    });

    it('a scratchpad: no file, so the kind plus the short id', () => {
        const api = createFakeContentApi();
        render(<ScratchpadPane paneID={PANE} content={api} />);
        push(api, contentState({ paneID: PANE, type: 'scratchpad', mode: 'edit', filePath: null }));

        const area = screen.getByTestId(`content-textarea-${PANE}`);
        expect(area.getAttribute('aria-label')).toBe('scratchpad ABCD');
        expect(area.getAttribute('aria-label')).not.toContain(PANE);
    });

    it('an ERROR still speaks: §L45 removes the placeholder, not the failure', () => {
        const api = createFakeContentApi();
        render(<MarkdownPane paneID={PANE} content={api} />);
        act(() => {
            api.fail(PANE, "pane 'X' is a shell pane, not a content pane");
        });

        const status = screen.getByTestId(`content-status-${PANE}`);
        expect(status.dataset['tone']).toBe('error');
        expect(status.textContent).toContain('not a content pane');
    });
});
