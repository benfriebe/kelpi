/**
 * The markdown pane's two bodies and the toggle between them (content-panes.md §3–§4).
 *
 * The pane is driven from a fake `ContentApi`, which is how the daemon actually looks from here:
 * a stream of snapshots plus five verbs. What is asserted is the part the client owns — which
 * body renders for a mode, that typing leaves as `content-set-text`, and that every route to ⌘E
 * (the app's key map, the header button, and the preview's own keydown behind the iframe) ends
 * in the same request.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CONTENT_BRIDGE_SOURCE } from './bridge';
import { MarkdownPane } from './MarkdownPane';
import { contentState, createFakeContentApi, type FakeContentApi } from './testing';
import type { ContentPaneState } from './types';

const PANE = 'DDDDDDDD-0000-4000-8000-000000000001';

/** A daemon snapshot arriving at a mounted pane is a React update, so it goes through `act`. */
function push(api: FakeContentApi, state: ContentPaneState): void {
    act(() => {
        api.push(state);
    });
}

function fail(api: FakeContentApi, message: string): void {
    act(() => {
        api.fail(PANE, message);
    });
}

afterEach(() => {
    cleanup();
});

describe('markdown view mode', () => {
    /**
     * §L45 — the pre-snapshot body is EMPTY, not a "Loading…" placeholder.
     * `MarkdownPaneView.swift:64-77` mounts a transparent web view and lets the first load paint
     * it; on a local file the port's centred text was a flash, never information.
     */
    it('shows the pane fill and NO placeholder text until the first snapshot lands (§L45)', () => {
        const api = createFakeContentApi();
        render(<MarkdownPane paneID={PANE} content={api} />);

        const status = screen.getByTestId(`content-status-${PANE}`);
        expect(status.textContent).toBe('');
        expect(status.dataset['tone']).toBe('quiet');
        expect(api.subscribes).toEqual([PANE]);
    });

    it('renders the daemon’s document in the sandboxed frame', () => {
        const api = createFakeContentApi();
        render(<MarkdownPane paneID={PANE} content={api} />);

        push(api, contentState({ paneID: PANE, html: '<html><body><h1>Notes</h1></body></html>' }));

        const frame = screen.getByTestId(`content-iframe-${PANE}`);
        expect(frame.getAttribute('srcdoc')).toContain('<h1>Notes</h1>');
        expect(frame.getAttribute('srcdoc')).toContain(`<base href="/pane-assets/${PANE}/">`);
    });

    it('reports a command failure instead of an empty box', () => {
        const api = createFakeContentApi();
        render(<MarkdownPane paneID={PANE} content={api} />);

        fail(api, "pane 'X' is a shell pane, not a content pane");

        const status = screen.getByTestId(`content-status-${PANE}`);
        expect(status.dataset['tone']).toBe('error');
        expect(status.textContent).toContain('not a content pane');
    });

    it('raises the edit toggle when the preview reports ⌘E from inside the frame', () => {
        const api = createFakeContentApi();
        const onToggleEdit = vi.fn();
        render(<MarkdownPane paneID={PANE} content={api} onToggleEdit={onToggleEdit} />);
        push(api, contentState({ paneID: PANE }));

        window.dispatchEvent(
            new MessageEvent('message', {
                data: { source: CONTENT_BRIDGE_SOURCE, paneID: PANE, kind: 'toggle-edit' }
            })
        );

        expect(onToggleEdit).toHaveBeenCalledWith(PANE);
    });
});

describe('markdown edit mode', () => {
    it('follows the daemon’s mode, not a local flag', () => {
        const api = createFakeContentApi();
        render(<MarkdownPane paneID={PANE} content={api} />);

        push(api, contentState({ paneID: PANE, mode: 'view' }));
        expect(screen.queryByTestId(`content-textarea-${PANE}`)).toBeNull();

        push(api, contentState({ paneID: PANE, mode: 'edit', revision: 2, text: '# Notes\n' }));
        const area = screen.getByTestId(`content-textarea-${PANE}`) as HTMLTextAreaElement;
        expect(area.value).toBe('# Notes\n');
        expect(screen.queryByTestId(`content-iframe-${PANE}`)).toBeNull();
    });

    it('sends every keystroke to the daemon’s buffer', () => {
        const api = createFakeContentApi();
        render(<MarkdownPane paneID={PANE} content={api} />);
        push(api, contentState({ paneID: PANE, mode: 'edit', text: '# Notes\n' }));

        const area = screen.getByTestId(`content-textarea-${PANE}`);
        fireEvent.change(area, { target: { value: '# Notes!\n' } });

        expect(api.texts).toEqual([{ paneID: PANE, text: '# Notes!\n' }]);
    });

    it('answers ⌘E itself, because the app ignores pane bindings inside a text field', () => {
        const api = createFakeContentApi();
        const onToggleEdit = vi.fn();
        render(<MarkdownPane paneID={PANE} content={api} onToggleEdit={onToggleEdit} />);
        push(api, contentState({ paneID: PANE, mode: 'edit', text: '# Notes\n' }));

        fireEvent.keyDown(screen.getByTestId(`content-textarea-${PANE}`), {
            key: 'e',
            code: 'KeyE',
            metaKey: true
        });

        expect(onToggleEdit).toHaveBeenCalledWith(PANE);
    });

    it('keeps what the user is typing when a snapshot arrives mid-edit', () => {
        const api = createFakeContentApi();
        render(<MarkdownPane paneID={PANE} content={api} />);
        push(api, contentState({ paneID: PANE, mode: 'edit', text: 'original' }));

        const area = screen.getByTestId(`content-textarea-${PANE}`) as HTMLTextAreaElement;
        fireEvent.focus(area);
        fireEvent.change(area, { target: { value: 'mine' } });
        push(api, contentState({ paneID: PANE, mode: 'edit', revision: 3, text: 'theirs' }));

        expect(area.value).toBe('mine');
    });

    it('adopts the daemon’s buffer while the field is not focused', () => {
        const api = createFakeContentApi();
        render(<MarkdownPane paneID={PANE} content={api} />);
        push(api, contentState({ paneID: PANE, mode: 'edit', text: 'original' }));

        push(api, contentState({ paneID: PANE, mode: 'edit', revision: 3, text: 'saved elsewhere' }));

        expect((screen.getByTestId(`content-textarea-${PANE}`) as HTMLTextAreaElement).value).toBe(
            'saved elsewhere'
        );
    });

    it('flushes the buffer when the editor loses focus or goes away', () => {
        const api = createFakeContentApi();
        const view = render(<MarkdownPane paneID={PANE} content={api} />);
        push(api, contentState({ paneID: PANE, mode: 'edit', text: 'x' }));

        fireEvent.blur(screen.getByTestId(`content-textarea-${PANE}`));
        expect(api.flushes).toEqual([PANE]);

        view.unmount();
        expect(api.flushes).toEqual([PANE, PANE]);
        expect(api.unsubscribes).toEqual([PANE]);
    });
});
