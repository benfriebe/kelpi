import { describe, expect, it } from 'vitest';

import {
    calculateDropZone,
    draggedPaneGoesFirst,
    dropZoneForWireEdge,
    dropZoneOverlayRect,
    movingPane,
    splitDirectionOfZone
} from './dropZone.js';
import { allPaneIDs } from './tree.js';
import type { Rect } from './types.js';
import { leaf, split } from './types.js';

const A = 'AAAAAAAA-0000-0000-0000-000000000001';
const B = 'BBBBBBBB-0000-0000-0000-000000000002';
const C = 'CCCCCCCC-0000-0000-0000-000000000003';
const MISSING = 'FFFFFFFF-0000-0000-0000-00000000000F';

const RECT: Rect = { x: 0, y: 0, width: 100, height: 100 };

describe('DropZone helpers', () => {
    it('maps zones to split direction and dragged-pane position', () => {
        expect(splitDirectionOfZone('left')).toBe('horizontal');
        expect(splitDirectionOfZone('right')).toBe('horizontal');
        expect(splitDirectionOfZone('top')).toBe('vertical');
        expect(splitDirectionOfZone('bottom')).toBe('vertical');

        expect(draggedPaneGoesFirst('left')).toBe(true);
        expect(draggedPaneGoesFirst('top')).toBe(true);
        expect(draggedPaneGoesFirst('right')).toBe(false);
        expect(draggedPaneGoesFirst('bottom')).toBe(false);
    });

    it('maps the wire edge names used by `kelpi pane move --target`', () => {
        expect(dropZoneForWireEdge('above')).toBe('top');
        expect(dropZoneForWireEdge('below')).toBe('bottom');
        expect(dropZoneForWireEdge('left-of')).toBe('left');
        expect(dropZoneForWireEdge('right-of')).toBe('right');
    });
});

describe('calculateDropZone', () => {
    it('picks the closest edge (y-down coordinates)', () => {
        expect(calculateDropZone({ x: 90, y: 50 }, RECT)).toBe('right');
        expect(calculateDropZone({ x: 10, y: 50 }, RECT)).toBe('left');
        expect(calculateDropZone({ x: 50, y: 10 }, RECT)).toBe('top');
        expect(calculateDropZone({ x: 50, y: 90 }, RECT)).toBe('bottom');
    });

    it('resolves the exact centre to "top" (vertical branch wins ties, ny > 0 is strict)', () => {
        expect(calculateDropZone({ x: 50, y: 50 }, RECT)).toBe('top');
    });

    it('resolves diagonal ties to the vertical branch', () => {
        expect(calculateDropZone({ x: 75, y: 75 }, RECT)).toBe('bottom');
        expect(calculateDropZone({ x: 25, y: 25 }, RECT)).toBe('top');
        expect(calculateDropZone({ x: 75, y: 25 }, RECT)).toBe('top');
        expect(calculateDropZone({ x: 25, y: 75 }, RECT)).toBe('bottom');
    });

    it('normalizes a degenerate axis to 0', () => {
        expect(calculateDropZone({ x: 0, y: 10 }, { x: 0, y: 0, width: 0, height: 100 })).toBe('top');
        expect(calculateDropZone({ x: 90, y: 0 }, { x: 0, y: 0, width: 100, height: 0 })).toBe(
            'right'
        );
        expect(calculateDropZone({ x: 0, y: 0 }, { x: 0, y: 0, width: 0, height: 0 })).toBe('top');
    });

    it('is relative to the rect origin, not the viewport', () => {
        const offset: Rect = { x: 200, y: 300, width: 100, height: 100 };
        expect(calculateDropZone({ x: 210, y: 350 }, offset)).toBe('left');
        expect(calculateDropZone({ x: 290, y: 350 }, offset)).toBe('right');
    });

    it('normalizes by half-extent, so a wide rect still splits by proportion', () => {
        const wide: Rect = { x: 0, y: 0, width: 1000, height: 100 };
        // 100px above centre out of a 50px half-height beats 100px left of a 500px half-width.
        expect(calculateDropZone({ x: 400, y: 10 }, wide)).toBe('top');
    });
});

describe('dropZoneOverlayRect', () => {
    it('covers the half of the target pane the drop would use', () => {
        expect(dropZoneOverlayRect('left', RECT)).toEqual({ x: 0, y: 0, width: 50, height: 100 });
        expect(dropZoneOverlayRect('right', RECT)).toEqual({ x: 50, y: 0, width: 50, height: 100 });
        expect(dropZoneOverlayRect('top', RECT)).toEqual({ x: 0, y: 0, width: 100, height: 50 });
        expect(dropZoneOverlayRect('bottom', RECT)).toEqual({ x: 0, y: 50, width: 100, height: 50 });
    });
});

describe('movingPane', () => {
    const two = split('horizontal', 0.5, leaf(A), leaf(B));

    it('stacks the moved pane under the anchor for "bottom"', () => {
        expect(movingPane(two, A, B, 'bottom')).toEqual(
            split('vertical', 0.5, leaf(B), leaf(A))
        );
    });

    it('puts the moved pane first for "top" and "left"', () => {
        expect(movingPane(two, A, B, 'top')).toEqual(split('vertical', 0.5, leaf(A), leaf(B)));
        expect(movingPane(two, A, B, 'left')).toEqual(split('horizontal', 0.5, leaf(A), leaf(B)));
        expect(movingPane(two, A, B, 'right')).toEqual(split('horizontal', 0.5, leaf(B), leaf(A)));
    });

    it('collapses the old slot first, then splits the anchor 50/50', () => {
        const layout = split('horizontal', 0.75, leaf(A), split('vertical', 0.2, leaf(B), leaf(C)));
        expect(movingPane(layout, C, A, 'left')).toEqual(
            split('horizontal', 0.75, split('horizontal', 0.5, leaf(C), leaf(A)), leaf(B))
        );
    });

    it('is a no-op when the pane is dropped on itself', () => {
        expect(movingPane(two, A, A, 'bottom')).toEqual(two);
    });

    it('silently drops the moved pane when the anchor is absent (guards live above the model)', () => {
        const result = movingPane(two, A, MISSING, 'bottom');
        expect(result).toEqual(leaf(B));
        expect(allPaneIDs(result)).toEqual([B]);
    });

    it('inserts a pane that was not in the tree next to the anchor', () => {
        expect(movingPane(leaf(A), C, A, 'right')).toEqual(
            split('horizontal', 0.5, leaf(A), leaf(C))
        );
    });
});
