/**
 * Spring-loaded tabs, the grid's half (workspace-feature.md §12, shell-ui.md §3.3).
 *
 * The title bar opens a tab a dragged pane is held over and records where the drag started
 * (`chrome/tab-drop.ts` ▸ `setTabSpring`, pinned in `WorkspaceTabBar.test.tsx`). From then on the
 * grid draws that tab's panes while the drag goes on, and its end decides: a release over the
 * grid moves the pane into the tab now on screen, beside the pane under the release; anything
 * that is not a drop goes back to the tab the drag started in.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { leaf, split } from '@kelpi/core/layout';

import { setTabSpring, tabSpring } from '../chrome/tab-drop';
import { PaneGrid, type PaneGridProps } from './PaneGrid';
import { firePointer, stubBoundingRect, testPane } from './testing';

const SIZE = { width: 800, height: 600 };
/** The tab the drag starts in: `a` beside `b`. */
const HOME = { layout: split('horizontal', 0.5, leaf('a'), leaf('b')), panes: [testPane('a'), testPane('b')] };
/** The tab it opens: `c` beside `d`. */
const OPENED = { layout: split('horizontal', 0.5, leaf('c'), leaf('d')), panes: [testPane('c'), testPane('d')] };

function renderGrid(overrides: Partial<PaneGridProps> = {}) {
    const props: PaneGridProps = {
        ...HOME,
        size: SIZE,
        headerHeight: 24,
        ratioCommitIntervalMs: 0,
        renderPane: (paneID) => <div data-testid={`body-${paneID}`} />,
        onMovePaneToTab: vi.fn(),
        onMovePane: vi.fn(),
        ...overrides
    };
    const view = render(<PaneGrid {...props} />);
    stubBoundingRect(screen.getByTestId('pane-grid'), { left: 0, top: 0, ...SIZE });
    /** What the window does when the bar shows the opened tab: the grid now draws its panes. */
    const springTo = (returnHome: () => void): void => {
        act(() => {
            setTabSpring({ originTabID: 'home', tabID: 'opened', returnHome });
            view.rerender(<PaneGrid {...props} {...OPENED} />);
        });
        stubBoundingRect(screen.getByTestId('pane-grid'), { left: 0, top: 0, ...SIZE });
    };
    return { props, springTo };
}

/** Press a's header and drag well past the threshold, into the right half. */
function liftPaneA(): void {
    act(() => firePointer(screen.getByTestId('pane-header-a'), 'pointerdown', { clientX: 100, clientY: 12 }));
    act(() => firePointer(window, 'pointermove', { clientX: 300, clientY: 300 }));
}

afterEach(() => {
    cleanup();
    setTabSpring(null);
});

describe('a pane drag that opened another tab on its way', () => {
    it('drops the pane into that tab, beside the pane under the release', () => {
        const { props, springTo } = renderGrid();
        const returnHome = vi.fn();
        liftPaneA();
        springTo(returnHome);
        // The source pane is not drawn any more; the drag goes on regardless.
        expect(screen.queryByTestId('pane-header-a')).toBeNull();
        act(() => firePointer(window, 'pointermove', { clientX: 780, clientY: 300 }));
        act(() => firePointer(window, 'pointerup', { clientX: 780, clientY: 300 }));

        expect(props.onMovePaneToTab).toHaveBeenCalledWith('a', { kind: 'tab', tabID: 'opened', beside: { paneID: 'd', zone: 'right' } });
        expect(props.onMovePane).not.toHaveBeenCalled();
        expect(returnHome).not.toHaveBeenCalled();
        expect(tabSpring()).toBeNull();
    });

    it('goes back to the tab it started in on Escape, and moves nothing', () => {
        const { props, springTo } = renderGrid();
        const returnHome = vi.fn();
        liftPaneA();
        springTo(returnHome);
        act(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        });
        act(() => firePointer(window, 'pointerup', { clientX: 780, clientY: 300 }));

        expect(returnHome).toHaveBeenCalledTimes(1);
        expect(props.onMovePaneToTab).not.toHaveBeenCalled();
        expect(props.onMovePane).not.toHaveBeenCalled();
    });

    it('goes back when released outside the grid and the bar', () => {
        const { props, springTo } = renderGrid();
        const returnHome = vi.fn();
        liftPaneA();
        springTo(returnHome);
        act(() => firePointer(window, 'pointerup', { clientX: 900, clientY: 700 }));

        expect(returnHome).toHaveBeenCalledTimes(1);
        expect(props.onMovePaneToTab).not.toHaveBeenCalled();
    });

    it('goes back when the window loses the pointer (a gesture reset)', () => {
        const { props, springTo } = renderGrid();
        const returnHome = vi.fn();
        liftPaneA();
        springTo(returnHome);
        act(() => window.dispatchEvent(new Event('blur')));

        expect(returnHome).toHaveBeenCalledTimes(1);
        expect(props.onMovePaneToTab).not.toHaveBeenCalled();
    });

    it('leaves a drag that opened nothing as it was: a pane drop in its own tab', () => {
        const { props } = renderGrid();
        liftPaneA();
        act(() => firePointer(window, 'pointermove', { clientX: 780, clientY: 300 }));
        act(() => firePointer(window, 'pointerup', { clientX: 780, clientY: 300 }));

        expect(props.onMovePane).toHaveBeenCalledWith('a', 'b', 'right');
        expect(props.onMovePaneToTab).not.toHaveBeenCalled();
    });

    it('lets Escape cancel any pane drag', () => {
        const { props } = renderGrid();
        liftPaneA();
        act(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        });
        act(() => firePointer(window, 'pointerup', { clientX: 780, clientY: 300 }));

        expect(props.onMovePane).not.toHaveBeenCalled();
    });
});
