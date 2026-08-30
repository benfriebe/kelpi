/**
 * §N17 — the grid must not paint a GROUND, at any opacity.
 *
 * The defect the owner saw on the packaged app was `background-opacity = 0.85` rendering a
 * fully solid terminal pane, and the DOM's share of it was arithmetic rather than a wrong
 * colour: five elements each painted `--kelpi-bg`, alpha multiplies, and 1 − 0.15⁵ is 0.99992.
 * Two of those five live here.
 *
 * `PaneGridView.swift:104-118` is a bare `ZStack` over a `GeometryReader` — the grid paints
 * nothing — and `:370-378` gives a pane's wrapper a `.background` ONLY for markdown /
 * scratchpad / diff / web bodies, so a `.shell` pane's wrapper paints nothing either (the
 * libghostty surface inside it already carries the opacity). The one thing the Swift does fill
 * is the empty placeholder, `:508-510`, "so it reads as a window gap → chrome
 * windowBackground".
 *
 * These are assertions about the ABSENCE of a declaration, which is exactly what regresses
 * silently: re-adding `background: tokens.windowBackground` to either element looks harmless
 * at opacity 1 and reinstates the defect below it.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { empty, leaf, split } from '@kelpi/core/layout';

import { PaneGrid, type PaneGridProps } from './PaneGrid';
import { tokens } from './tokens';
import { testPane } from './testing';

const SIZE = { width: 800, height: 600 };
const SIDE_BY_SIDE = split('horizontal', 0.5, leaf('a'), leaf('b'));

function renderGrid(overrides: Partial<PaneGridProps> = {}) {
    const props: PaneGridProps = {
        layout: SIDE_BY_SIDE,
        panes: [testPane('a'), testPane('b')],
        size: SIZE,
        headerHeight: 24,
        renderPane: (paneID) => <div data-testid={`body-${paneID}`} />,
        ...overrides
    };
    render(<PaneGrid {...props} />);
}

afterEach(cleanup);

describe('pane grid paints no ground (§N17)', () => {
    it('leaves the grid container unpainted — the Swift ZStack fills nothing', () => {
        renderGrid();
        const container = screen.getByTestId('pane-grid');
        expect(container.style.background).toBe('');
        expect(container.style.backgroundColor).toBe('');
    });

    it('leaves every pane wrapper unpainted, focused or not', () => {
        renderGrid({ focusedPaneID: 'a' });
        for (const paneID of ['a', 'b']) {
            const wrapper = screen.getByTestId(`pane-${paneID}`);
            expect(wrapper.style.background).toBe('');
            expect(wrapper.style.backgroundColor).toBe('');
            // The wrapper still does its real job — position, stacking, visibility.
            expect(wrapper.style.position).toBe('absolute');
            expect(wrapper.style.zIndex).toBe('1');
        }
    });

    it('still fills the empty placeholder, which is the one fill the Swift keeps', () => {
        renderGrid({ layout: empty(), panes: [] });
        const placeholder = screen.queryByTestId('pane-grid-empty');
        // Guard rather than assume, so a change to the empty-layout predicate fails loudly here
        // instead of quietly turning the colour assertion below into a no-op.
        expect(placeholder).not.toBeNull();
        expect(placeholder?.style.background).toBe(tokens.windowBackground);
    });
});
