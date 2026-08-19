/**
 * The pane header's preview font-size pair (content-panes.md §3.16).
 *
 * The rule that matters is WHERE they appear: §3.16 is explicit that the size applies "only
 * when the focused pane is markdown AND `isEditing == false`" — the built-in editor is a fixed
 * 13 px and a diff pane has no bindings — so the buttons are absent everywhere else rather
 * than present and inert.
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

    it('disappear in edit mode and never appear on other pane types', () => {
        const view = render(
            <PaneHeader pane={testPane(PANE, { type: 'markdown', isEditing: true })} focused />
        );
        expect(screen.queryByTestId(`pane-font-smaller-${PANE}`)).toBeNull();

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

describe('restart button', () => {
    it('appears only for a shell pane with an attached session', () => {
        const onRestartAgent = vi.fn();
        const view = render(
            <PaneHeader
                pane={testPane(PANE, { type: 'shell', agentSessionID: 'abc' })}
                focused
                onRestartAgent={onRestartAgent}
            />
        );
        fireEvent.click(screen.getByTestId(`pane-restart-${PANE}`));
        expect(onRestartAgent).toHaveBeenCalledWith(PANE);

        view.rerender(
            <PaneHeader pane={testPane(PANE, { type: 'shell', agentSessionID: null })} focused />
        );
        expect(screen.queryByTestId(`pane-restart-${PANE}`)).toBeNull();
    });
});
