/**
 * The pane header's preview font-size pair (content-panes.md §3.16).
 *
 * The rule that matters is WHERE they act: §3.16 is explicit that the size applies "only when
 * the focused pane is markdown AND `isEditing == false`" — the built-in editor is a fixed 13 px
 * and a diff pane has no bindings. On a non-markdown pane the pair is absent; in EDIT mode it
 * stays in the row, disabled, because a control that unmounts reflows the whole button strip on
 * every ⌘E and takes the affordance out of sight in the mode you are looking at (run-B nit).
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PaneHeader } from './PaneHeader';
import { testPane } from './testing';

const PANE = 'p1';

afterEach(cleanup);

function smaller(): HTMLElement {
    return screen.getByTestId(`pane-font-smaller-${PANE}`);
}

function larger(): HTMLElement {
    return screen.getByTestId(`pane-font-larger-${PANE}`);
}

describe('font-size buttons', () => {
    it('are shown for a markdown pane in view mode', () => {
        const onSetFontSize = vi.fn();
        render(
            <PaneHeader
                pane={testPane(PANE, { type: 'markdown', isEditing: false })}
                focused
                onSetFontSize={onSetFontSize}
            />
        );

        fireEvent.click(larger());
        fireEvent.click(smaller());
        expect(onSetFontSize.mock.calls).toEqual([
            [PANE, 'increase'],
            [PANE, 'decrease']
        ]);
    });

    it('reset with ⌥-click (the ⌘0 binding, without a third button)', () => {
        const onSetFontSize = vi.fn();
        render(
            <PaneHeader
                pane={testPane(PANE, { type: 'markdown', isEditing: false })}
                focused
                onSetFontSize={onSetFontSize}
            />
        );

        fireEvent.click(larger(), { altKey: true });
        expect(onSetFontSize).toHaveBeenCalledWith(PANE, 'reset');
    });

    it('stay in the row but go inert in edit mode, and never appear on other pane types', () => {
        const onSetFontSize = vi.fn();
        const view = render(
            <PaneHeader
                pane={testPane(PANE, { type: 'markdown', isEditing: true })}
                focused
                onSetFontSize={onSetFontSize}
            />
        );
        expect((smaller() as HTMLButtonElement).disabled).toBe(true);
        expect((larger() as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(smaller());
        expect(onSetFontSize).not.toHaveBeenCalled();

        for (const type of ['shell', 'diff', 'scratchpad', 'web'] as const) {
            view.rerender(<PaneHeader pane={testPane(PANE, { type })} focused />);
            expect(screen.queryByTestId(`pane-font-larger-${PANE}`)).toBeNull();
        }
    });

    it('an unwired header renders inert buttons rather than throwing', () => {
        render(<PaneHeader pane={testPane(PANE, { type: 'markdown', isEditing: false })} focused />);
        expect(() => fireEvent.click(larger())).not.toThrow();
    });
});

/**
 * §H3 — the shipped app has no restart control. `PaneHeaderView.swift:177-272` is the complete
 * per-type button block (markdown-copy, markdown-edit, diff-refresh, then the shared
 * split/split/globe/close tail) and there is no `.shell` branch in it; `grep -rn restartAgent
 * Nex/` is empty. The `restart-pane-agent` verb and `PaneActions.onRestartAgent` stay — what
 * must not come back is a one-click restart of a live agent sitting next to Close.
 */
describe('restart button', () => {
    it('is not offered on any pane, with or without an attached session', () => {
        const onRestartAgent = vi.fn();
        const view = render(
            <PaneHeader
                pane={testPane(PANE, { type: 'shell', agentSessionID: 'abc', status: 'running' })}
                focused
                onRestartAgent={onRestartAgent}
            />
        );
        expect(screen.queryByTestId(`pane-restart-${PANE}`)).toBeNull();
        expect(onRestartAgent).not.toHaveBeenCalled();

        view.rerender(
            <PaneHeader pane={testPane(PANE, { type: 'shell', agentSessionID: null })} focused />
        );
        expect(screen.queryByTestId(`pane-restart-${PANE}`)).toBeNull();
    });
});
