/**
 * Diff panes: the rendered `git diff`, and the refresh triggers that keep it current (§5.2).
 *
 * The trigger worth a test is the focus transition — "come back to the diff pane and it is
 * current" is only useful if a re-render while already focused does NOT re-run git, since the
 * grid re-renders every pane on any layout change.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { DiffPane } from './DiffPane';
import { contentState, createFakeContentApi, type FakeContentApi } from './testing';
import type { ContentPaneState } from './types';

const PANE = 'DDDDDDDD-0000-4000-8000-000000000003';

function diffState(overrides: Partial<ContentPaneState> = {}): ContentPaneState {
    return contentState({
        paneID: PANE,
        type: 'diff',
        mode: 'view',
        text: null,
        filePath: null,
        assetBase: null,
        html: '<html><body><div class="line line-add">+ added</div></body></html>',
        ...overrides
    });
}

function push(api: FakeContentApi, state: ContentPaneState): void {
    act(() => {
        api.push(state);
    });
}

afterEach(() => {
    cleanup();
});

describe('diff pane', () => {
    it('subscribes and renders the daemon’s diff document', () => {
        const api = createFakeContentApi();
        render(<DiffPane paneID={PANE} content={api} />);
        expect(screen.getByTestId(`content-status-${PANE}`).textContent).toContain('git diff');

        push(api, diffState());

        expect(screen.getByTestId(`content-iframe-${PANE}`).getAttribute('srcdoc')).toContain('line-add');
        expect(api.subscribes).toEqual([PANE]);
    });

    it('re-runs git when the pane goes unfocused → focused', () => {
        const api = createFakeContentApi();
        const view = render(<DiffPane paneID={PANE} content={api} focused={false} />);
        push(api, diffState());
        expect(api.refreshes).toEqual([]);

        view.rerender(<DiffPane paneID={PANE} content={api} focused={true} />);
        expect(api.refreshes).toEqual([PANE]);

        // A re-render that is not a transition must not run git again.
        view.rerender(<DiffPane paneID={PANE} content={api} focused={true} />);
        expect(api.refreshes).toEqual([PANE]);

        view.rerender(<DiffPane paneID={PANE} content={api} focused={false} />);
        view.rerender(<DiffPane paneID={PANE} content={api} focused={true} />);
        expect(api.refreshes).toEqual([PANE, PANE]);
    });

    it('does not re-run git for a pane that mounts focused', () => {
        const api = createFakeContentApi();
        render(<DiffPane paneID={PANE} content={api} focused={true} />);
        push(api, diffState());

        // The subscribe reply is already a fresh run; a second one on mount would double every
        // workspace switch's git invocations.
        expect(api.refreshes).toEqual([]);
    });

    it('is read-only: no editor, no text buffer', () => {
        const api = createFakeContentApi();
        render(<DiffPane paneID={PANE} content={api} focused={false} />);
        push(api, diffState());

        expect(screen.queryByTestId(`content-textarea-${PANE}`)).toBeNull();
        expect(api.texts).toEqual([]);
    });

    it('unsubscribes when the pane leaves the screen', () => {
        const api = createFakeContentApi();
        const view = render(<DiffPane paneID={PANE} content={api} />);
        push(api, diffState());

        view.unmount();

        expect(api.unsubscribes).toEqual([PANE]);
    });
});
