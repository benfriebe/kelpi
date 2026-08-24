/**
 * §M30 — the pane header carries NO preview font-size pair, and this file is the guard.
 *
 * `PaneHeaderView.swift:177-273` is the shipped app's complete per-type button block —
 * markdown-copy, markdown-edit, diff-refresh, then the shared split / split / globe / close tail,
 * six buttons on a markdown pane — and preview font size is reachable there only through
 * ⌘= / ⌘- / ⌘0. The port's `A−` / `A+` existed partly because a focused preview could not receive
 * those chords (§H9); H9's chord relay closed that, so the reason expired and the buttons went
 * with it. What must not come back is a pair of controls the original never draws.
 *
 * The capability is untouched and stays reachable by the Swift's own gesture:
 * `increase/decrease/reset_markdown_font_size` are bound by default
 * (`core/config/bindings.ts:68-70`), `App.tsx:2565-2567` dispatches them at the focused pane, and
 * a press inside the sandboxed preview posts `focus` before the chord is replayed
 * (`content/bridge.ts`). `PaneActions.onSetFontSize` also stays on the interface — the same
 * treatment `onRestartAgent` gets below.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PaneHeader } from './PaneHeader';
import { testPane } from './testing';

const PANE = 'p1';

afterEach(cleanup);

describe('font-size buttons', () => {
    it('are not offered on a markdown pane in either mode, wired or not', () => {
        const onSetFontSize = vi.fn();
        const view = render(
            <PaneHeader
                pane={testPane(PANE, { type: 'markdown', isEditing: false })}
                focused
                onSetFontSize={onSetFontSize}
            />
        );
        expect(screen.queryByTestId(`pane-font-smaller-${PANE}`)).toBeNull();
        expect(screen.queryByTestId(`pane-font-larger-${PANE}`)).toBeNull();

        view.rerender(
            <PaneHeader
                pane={testPane(PANE, { type: 'markdown', isEditing: true })}
                focused
                onSetFontSize={onSetFontSize}
            />
        );
        expect(screen.queryByTestId(`pane-font-smaller-${PANE}`)).toBeNull();
        expect(screen.queryByTestId(`pane-font-larger-${PANE}`)).toBeNull();
        expect(onSetFontSize).not.toHaveBeenCalled();
    });

    it('are not offered on any other pane type either', () => {
        const view = render(<PaneHeader pane={testPane(PANE, { type: 'shell' })} focused />);
        for (const type of ['shell', 'diff', 'scratchpad', 'web'] as const) {
            view.rerender(<PaneHeader pane={testPane(PANE, { type })} focused />);
            expect(screen.queryByTestId(`pane-font-larger-${PANE}`)).toBeNull();
            expect(screen.queryByTestId(`pane-font-smaller-${PANE}`)).toBeNull();
        }
    });

    /**
     * The Swift's markdown header is exactly six buttons (`PaneHeaderView.swift:177-273`):
     * copy, edit-toggle, split right, split down, new web pane, close. Counting them is what
     * catches a seventh creeping back in — a font control, a rename pencil, a restart.
     */
    it('leaves a markdown header with the Swift’s six buttons and no more', () => {
        render(
            <PaneHeader
                pane={testPane(PANE, { type: 'markdown', isEditing: false })}
                focused
                onCopyDocument={vi.fn()}
            />
        );
        const buttons = [...screen.getByTestId(`pane-header-${PANE}`).querySelectorAll('button')];
        expect(buttons.map((button) => button.getAttribute('data-testid'))).toEqual([
            `pane-copy-${PANE}`,
            `pane-edit-toggle-${PANE}`,
            `pane-split-right-${PANE}`,
            `pane-split-down-${PANE}`,
            `pane-new-web-${PANE}`,
            `pane-close-${PANE}`
        ]);
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
