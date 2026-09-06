/**
 * Issue #79: the grid's gestures end when the pointer leaves this document.
 *
 * `PaneGrid.test.tsx` pins the divider drag's maths and its ordinary release. This file pins the
 * releases that never arrive: a `pointerup` delivered to a web pane's native `WebContentsView`,
 * or the window going away on a Space switch. In both cases the renderer's only signal is
 * `blur` / `visibilitychange`, which `chrome/gesture-reset.ts` turns into an end.
 *
 * The divider and the pane move end DIFFERENTLY, and both halves are asserted here: a divider
 * commits what the user already dragged to, a pane move is cancelled.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { leaf, split, type Rect } from '@kelpi/core/layout';

import { PaneGrid, type PaneGridProps } from './PaneGrid';
import { firePointer, stubBoundingRect, testPane } from './testing';

const SIZE = { width: 800, height: 600 };
const SIDE_BY_SIDE = split('horizontal', 0.5, leaf('a'), leaf('b'));

function renderGrid(overrides: Partial<PaneGridProps> = {}) {
    const props: PaneGridProps = {
        layout: SIDE_BY_SIDE,
        panes: [testPane('a'), testPane('b')],
        size: SIZE,
        headerHeight: 24,
        ratioCommitIntervalMs: 0,
        renderPane: (paneID) => <div data-testid={`body-${paneID}`} />,
        ...overrides
    };
    const view = render(<PaneGrid {...props} />);
    stubBoundingRect(screen.getByTestId('pane-grid'), { left: 0, top: 0, ...SIZE });
    return view;
}

function hide(): void {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
    cleanup();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    vi.useRealTimers();
});

describe('PaneGrid gestures end on blur and on the document going hidden (issue #79)', () => {
    it('ends a divider drag on blur, keeping the ratio the user dragged to', () => {
        const onSetRatio = vi.fn();
        renderGrid({ onSetRatio });
        act(() => firePointer(screen.getByTestId('divider-d'), 'pointerdown', { clientX: 500, clientY: 300 }));
        act(() => firePointer(window, 'pointermove', { clientX: 560, clientY: 300 }));
        const dragged = onSetRatio.mock.calls.at(-1)?.[1] as number;
        expect(dragged).toBeCloseTo((399 + 60) / 798, 12);

        act(() => window.dispatchEvent(new Event('blur')));

        // The lockout: a bare move after the lost release must move nothing.
        onSetRatio.mockClear();
        act(() => firePointer(window, 'pointermove', { clientX: 700, clientY: 300 }));
        expect(onSetRatio).not.toHaveBeenCalled();
        // …and the divider is no longer marked active, so it is not painted as a live drag.
        expect(screen.getByTestId('divider-d').getAttribute('data-dragging')).not.toBe('true');
    });

    it('ends a divider drag when the document goes hidden (a Space switch mid-drag)', () => {
        const onSetRatio = vi.fn();
        renderGrid({ onSetRatio });
        act(() => firePointer(screen.getByTestId('divider-d'), 'pointerdown', { clientX: 500, clientY: 300 }));
        act(() => firePointer(window, 'pointermove', { clientX: 540, clientY: 300 }));
        expect(onSetRatio).toHaveBeenCalled();

        act(() => hide());

        onSetRatio.mockClear();
        act(() => firePointer(window, 'pointermove', { clientX: 700, clientY: 300 }));
        expect(onSetRatio).not.toHaveBeenCalled();
    });

    it('CANCELS a pane move on blur: losing focus is not a drop', () => {
        const onMovePane = vi.fn();
        renderGrid({ onMovePane });
        const header = screen.getByTestId('pane-header-a');
        act(() => firePointer(header, 'pointerdown', { clientX: 100, clientY: 12 }));
        // Past PANE_MOVE_DRAG_THRESHOLD and well inside pane b, so a real release here WOULD
        // have moved the pane.
        act(() => firePointer(window, 'pointermove', { clientX: 600, clientY: 300 }));

        act(() => window.dispatchEvent(new Event('blur')));

        expect(onMovePane).not.toHaveBeenCalled();
        act(() => firePointer(window, 'pointerup', { clientX: 600, clientY: 300 }));
        expect(onMovePane).not.toHaveBeenCalled();
    });

    it('a blur with nothing running is inert, and a later drag still works', () => {
        const onSetRatio = vi.fn();
        renderGrid({ onSetRatio });
        act(() => window.dispatchEvent(new Event('blur')));
        act(() => hide());
        expect(onSetRatio).not.toHaveBeenCalled();

        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        act(() => firePointer(screen.getByTestId('divider-d'), 'pointerdown', { clientX: 500, clientY: 300 }));
        act(() => firePointer(window, 'pointermove', { clientX: 560, clientY: 300 }));
        expect(onSetRatio).toHaveBeenCalledTimes(1);
    });

    it('unmounting the grid unregisters it: a later blur does not reach a dead component', () => {
        const onSetRatio = vi.fn();
        const view = renderGrid({ onSetRatio });
        view.unmount();
        expect(() => act(() => window.dispatchEvent(new Event('blur')))).not.toThrow();
    });
});

/** Kept so the fixture's rect type import is load-bearing rather than decorative. */
export const BOUNDS: Rect = { x: 0, y: 0, ...SIZE };
