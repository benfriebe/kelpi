/**
 * §N31 (reopened) — the grid's MEASUREMENT, which is what decides whether a slide shows the
 * desktop.
 *
 * Every pane is `position: absolute` at a pixel rect derived from the measured container, and
 * the container itself paints nothing (§N17: the window fill is `transparent` below
 * `background-opacity` 1). So the measurement is not a detail of layout quality — for as long
 * as it disagrees with the container, the difference is a strip of window that NOTHING painted,
 * which on a real screen is the wallpaper. The owner reported it as "the inspector still shows a
 * small amount of white during its slide" after the clip fill had closed the reveal itself.
 *
 * Two properties keep that strip at zero width, and this file pins both:
 *
 *   1. **Synchronous.** The `ResizeObserver` notification lands after layout and before paint. A
 *      plain `setState` there is scheduled — React re-renders in a later task and the browser
 *      paints the frame in between with the panes still at their old rects, which during a
 *      250 ms slide is ~18 px of unpainted window travelling with the panel (measured: 21.2 px
 *      on the inspector's close, 16.7 px on the sidebar's). The re-render therefore has to be
 *      flushed inside the callback.
 *   2. **Fractional.** `clientWidth` is an integer and the container is fractional for every
 *      frame of a slide, so a rounded measurement leaves the remainder — up to a pixel at the
 *      trailing edge — unpainted for the whole animation.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { leaf, split } from '@kelpi/core/layout';

import { PaneGrid } from './PaneGrid';
import { installFakeResizeObserver } from '../terminal/testing';
import { stubBoundingRect, testPane } from './testing';

const LAYOUT = split('horizontal', 0.5, leaf('a'), leaf('b'));

/**
 * Render the grid with NO `size` prop, so the component measures its own container — the path
 * the app actually runs and the one `size` (tests, non-DOM hosts) bypasses entirely.
 */
function renderMeasuring(box: { width: number; height: number }) {
    const observers = installFakeResizeObserver();
    const view = render(
        <PaneGrid
            layout={LAYOUT}
            panes={[testPane('a'), testPane('b')]}
            headerHeight={24}
            renderPane={(paneID) => <div data-testid={`body-${paneID}`} />}
        />
    );
    const container = screen.getByTestId('pane-grid');
    const resize = (next: { width: number; height: number }): void => {
        stubBoundingRect(container, { left: 0, top: 0, ...next });
        observers.trigger();
    };
    stubBoundingRect(container, { left: 0, top: 0, ...box });
    return { ...view, container, observers, resize };
}

afterEach(() => {
    cleanup();
});

describe('§N31 — the pane grid measures its container without a frame of debt', () => {
    it('lays the panes out synchronously inside the resize notification', () => {
        const { resize } = renderMeasuring({ width: 800, height: 600 });

        // The container grows the way a closing side panel grows it. No `act`, no await, no
        // microtask: the assertion runs on the DOM as it stands the instant the observer's
        // callback returned, which is the state the browser is about to paint.
        resize({ width: 1080, height: 600 });

        const right = screen.getByTestId('pane-b');
        expect(right.style.left).not.toBe('');
        const rightEdge = Number.parseFloat(right.style.left) + Number.parseFloat(right.style.width);
        expect(rightEdge).toBeCloseTo(1080, 3);
    });

    it('covers the container edge to edge at every step of a slide-sized sweep', () => {
        const { resize } = renderMeasuring({ width: 800, height: 600 });

        // 280 px of travel — the inspector's width — in the ~18 px steps a 250 ms ease takes.
        for (let width = 800; width <= 1080; width += 17.6) {
            resize({ width, height: 600 });
            const left = screen.getByTestId('pane-a');
            const right = screen.getByTestId('pane-b');
            const covered =
                Number.parseFloat(right.style.left) + Number.parseFloat(right.style.width);
            expect(Number.parseFloat(left.style.left)).toBeCloseTo(0, 3);
            // The uncovered strip is what the desktop shows through. It has to be zero, not small.
            expect(width - covered).toBeCloseTo(0, 3);
        }
    });

    it('keeps the fractional width a transition actually lands on', () => {
        const { resize } = renderMeasuring({ width: 800, height: 600 });

        resize({ width: 1013.6875, height: 599.5 });

        const right = screen.getByTestId('pane-b');
        const rightEdge = Number.parseFloat(right.style.left) + Number.parseFloat(right.style.width);
        // A rounded measurement would stop at 1013 and leave 0.6875 px of window bare.
        expect(rightEdge).toBeCloseTo(1013.6875, 3);
        const bottom =
            Number.parseFloat(right.style.top) + Number.parseFloat(right.style.height);
        expect(bottom).toBeCloseTo(599.5, 3);
    });
});
