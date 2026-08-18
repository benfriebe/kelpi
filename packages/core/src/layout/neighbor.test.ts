import { describe, expect, it } from 'vitest';

import { NEIGHBOR_BOUNDS, NEIGHBOR_TOLERANCE, neighborPaneID } from './neighbor.js';
import type { PaneLayout } from './types.js';
import { leaf, split } from './types.js';

const A = 'AAAAAAAA-0000-0000-0000-000000000001';
const B = 'BBBBBBBB-0000-0000-0000-000000000002';
const C = 'CCCCCCCC-0000-0000-0000-000000000003';
const D = 'DDDDDDDD-0000-0000-0000-000000000004';

describe('neighborPaneID', () => {
    it('uses the canonical 10000x10000 bounds and DIVIDER_THICKNESS + 1 tolerance', () => {
        expect(NEIGHBOR_BOUNDS).toEqual({ x: 0, y: 0, width: 10000, height: 10000 });
        expect(NEIGHBOR_TOLERANCE).toBe(3);
    });

    it('21. neighborRightInHorizontalSplit', () => {
        const layout = split('horizontal', 0.5, leaf(A), leaf(B));
        expect(neighborPaneID(layout, A, 'right')).toBe(B);
        expect(neighborPaneID(layout, B, 'right')).toBeNull();
    });

    it('22. neighborLeftInHorizontalSplit', () => {
        const layout = split('horizontal', 0.5, leaf(A), leaf(B));
        expect(neighborPaneID(layout, B, 'left')).toBe(A);
        expect(neighborPaneID(layout, A, 'left')).toBeNull();
    });

    it('23. neighborDownInVerticalSplit', () => {
        const layout = split('vertical', 0.5, leaf(A), leaf(B));
        expect(neighborPaneID(layout, A, 'down')).toBe(B);
        expect(neighborPaneID(layout, B, 'down')).toBeNull();
    });

    it('24. neighborUpInVerticalSplit', () => {
        const layout = split('vertical', 0.5, leaf(A), leaf(B));
        expect(neighborPaneID(layout, B, 'up')).toBe(A);
        expect(neighborPaneID(layout, A, 'up')).toBeNull();
    });

    it('25. neighborInFourPaneTile', () => {
        // a top-left, b bottom-left, c top-right, d bottom-right
        const layout = split(
            'horizontal',
            0.5,
            split('vertical', 0.5, leaf(A), leaf(B)),
            split('vertical', 0.5, leaf(C), leaf(D))
        );
        expect(neighborPaneID(layout, A, 'right')).toBe(C);
        expect(neighborPaneID(layout, A, 'down')).toBe(B);
        expect(neighborPaneID(layout, A, 'left')).toBeNull();
        expect(neighborPaneID(layout, A, 'up')).toBeNull();

        expect(neighborPaneID(layout, D, 'left')).toBe(B);
        expect(neighborPaneID(layout, D, 'up')).toBe(C);
        expect(neighborPaneID(layout, D, 'right')).toBeNull();
        expect(neighborPaneID(layout, D, 'down')).toBeNull();
    });

    it('26. neighborEquidistantPrefersTopleft (deterministic across repeats)', () => {
        const layout: PaneLayout = split(
            'horizontal',
            0.5,
            leaf(A),
            split('vertical', 0.5, leaf(B), leaf(C))
        );
        for (let i = 0; i < 20; i += 1) {
            expect(neighborPaneID(layout, A, 'right')).toBe(B);
        }
    });

    it('27. neighborEquidistantVerticalPrefersLeft (deterministic across repeats)', () => {
        const layout: PaneLayout = split(
            'vertical',
            0.5,
            leaf(A),
            split('horizontal', 0.5, leaf(B), leaf(C))
        );
        for (let i = 0; i < 20; i += 1) {
            expect(neighborPaneID(layout, A, 'down')).toBe(B);
        }
    });

    it('28. neighborSinglePaneReturnsNil', () => {
        const layout = leaf(A);
        expect(neighborPaneID(layout, A, 'left')).toBeNull();
        expect(neighborPaneID(layout, A, 'right')).toBeNull();
        expect(neighborPaneID(layout, A, 'up')).toBeNull();
        expect(neighborPaneID(layout, A, 'down')).toBeNull();
    });

    it('29. neighborNoAdjacentInDirection', () => {
        const layout = split('horizontal', 0.5, leaf(A), leaf(B));
        expect(neighborPaneID(layout, A, 'up')).toBeNull();
        expect(neighborPaneID(layout, A, 'down')).toBeNull();
    });

    it('returns null for a pane that is not in the tree', () => {
        const layout = split('horizontal', 0.5, leaf(A), leaf(B));
        expect(neighborPaneID(layout, D, 'left')).toBeNull();
    });

    it('prefers the pane whose midline lines up over a diagonal candidate', () => {
        // a spans the full left column; c is directly right, d is diagonally right-down.
        const layout = split(
            'horizontal',
            0.5,
            leaf(A),
            split('vertical', 0.9, leaf(C), leaf(D))
        );
        expect(neighborPaneID(layout, A, 'right')).toBe(C);
    });
});
