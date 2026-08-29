import { describe, expect, it } from 'vitest';

import {
    dividerDragDelta,
    dividerDragSnapshot,
    dividerHitRect,
    paneAtPoint,
    paneFrames,
    ratioFromDividerDrag,
    splitBounds,
    splitDividers
} from './frames.js';
import { ratioAtPath, updatingSplitRatio } from './ratio.js';
import type { Rect } from './types.js';
import { DIVIDER_HIT_INSET, DIVIDER_THICKNESS, EMPTY_LAYOUT, leaf, split } from './types.js';

const A = 'AAAAAAAA-0000-0000-0000-000000000001';
const B = 'BBBBBBBB-0000-0000-0000-000000000002';
const C = 'CCCCCCCC-0000-0000-0000-000000000003';

const BOUNDS: Rect = { x: 0, y: 0, width: 100, height: 100 };

describe('splitBounds', () => {
    it('applies the ratio to the space left after the 2px divider (horizontal)', () => {
        const { first, second } = splitBounds('horizontal', 0.5, BOUNDS);
        expect(first).toEqual({ x: 0, y: 0, width: 49, height: 100 });
        expect(second).toEqual({ x: 51, y: 0, width: 49, height: 100 });
        expect(second.x - (first.x + first.width)).toBe(DIVIDER_THICKNESS);
        expect(second.x + second.width).toBe(100);
    });

    it('stacks children for a vertical split', () => {
        const { first, second } = splitBounds('vertical', 0.25, BOUNDS);
        expect(first).toEqual({ x: 0, y: 0, width: 100, height: 24.5 });
        expect(second).toEqual({ x: 0, y: 26.5, width: 100, height: 73.5 });
    });

    it('respects a non-zero origin', () => {
        const { first, second } = splitBounds('horizontal', 0.5, {
            x: 10,
            y: 20,
            width: 100,
            height: 50
        });
        expect(first).toEqual({ x: 10, y: 20, width: 49, height: 50 });
        expect(second).toEqual({ x: 61, y: 20, width: 49, height: 50 });
    });

    it('does not clamp or round: absurd bounds may go negative', () => {
        const { first, second } = splitBounds('horizontal', 0.5, {
            x: 0,
            y: 0,
            width: 1,
            height: 10
        });
        expect(first.width).toBe(-0.5);
        expect(second.width).toBe(-0.5);
    });
});

describe('paneFrames', () => {
    it('gives every leaf exactly one rect, in DFS order', () => {
        const layout = split('horizontal', 0.5, leaf(A), split('vertical', 0.5, leaf(B), leaf(C)));
        const frames = paneFrames(layout, BOUNDS);
        expect([...frames.keys()]).toEqual([A, B, C]);
        expect(frames.get(A)).toEqual({ x: 0, y: 0, width: 49, height: 100 });
        expect(frames.get(B)).toEqual({ x: 51, y: 0, width: 49, height: 49 });
        expect(frames.get(C)).toEqual({ x: 51, y: 51, width: 49, height: 49 });
    });

    it('maps a lone leaf to the whole bounds and empty to nothing', () => {
        expect([...paneFrames(leaf(A), BOUNDS).entries()]).toEqual([[A, BOUNDS]]);
        expect(paneFrames(EMPTY_LAYOUT, BOUNDS).size).toBe(0);
    });

    it('leaves a divider-thick gap between siblings', () => {
        const frames = paneFrames(split('vertical', 0.5, leaf(A), leaf(B)), BOUNDS);
        const first = frames.get(A);
        const second = frames.get(B);
        expect(second!.y - (first!.y + first!.height)).toBe(DIVIDER_THICKNESS);
    });
});

describe('splitDividers', () => {
    it('emits one record per split, path-addressed root-first then L then R', () => {
        const layout = split('horizontal', 0.5, leaf(A), split('vertical', 0.25, leaf(B), leaf(C)));
        const dividers = splitDividers(layout, BOUNDS);
        expect(dividers.map((d) => d.id)).toEqual(['d', 'dR']);

        const [root, nested] = dividers;
        expect(root).toEqual({
            id: 'd',
            direction: 'horizontal',
            rect: { x: 49, y: 0, width: DIVIDER_THICKNESS, height: 100 },
            available: 98,
            firstSize: 49
        });
        expect(nested).toEqual({
            id: 'dR',
            direction: 'vertical',
            rect: { x: 51, y: 24.5, width: 49, height: DIVIDER_THICKNESS },
            available: 98,
            firstSize: 24.5
        });
    });

    it('addresses nested splits on both sides of the tree', () => {
        const layout = split(
            'horizontal',
            0.5,
            split('vertical', 0.5, leaf(A), leaf(B)),
            split('vertical', 0.5, leaf(C), leaf('EEEEEEEE-0000-0000-0000-000000000005'))
        );
        expect(splitDividers(layout, BOUNDS).map((d) => d.id)).toEqual(['d', 'dL', 'dR']);
    });

    it('returns nothing for leaves and empty layouts', () => {
        expect(splitDividers(leaf(A), BOUNDS)).toEqual([]);
        expect(splitDividers(EMPTY_LAYOUT, BOUNDS)).toEqual([]);
    });

    it('divider ids address the same splits updatingSplitRatio uses', () => {
        const layout = split('horizontal', 0.5, leaf(A), split('vertical', 0.25, leaf(B), leaf(C)));
        for (const divider of splitDividers(layout, BOUNDS)) {
            expect(ratioAtPath(layout, divider.id)).not.toBeNull();
        }
    });
});

/**
 * SPACING-REVIEW S48 — the numbers below were 4 / 10 / 108 / 57, the Swift's own
 * `.contentShape(Rectangle().inset(by: -4))`. They are 6 / 14 / 112 / 61 by the owner's
 * direction; the constant carries the reasoning and the parity value.
 */
describe('divider hit area', () => {
    it('insets the 2px bar by -6px per side, yielding a 14px grab strip (S48, owner-directed)', () => {
        const hit = dividerHitRect({ x: 49, y: 0, width: DIVIDER_THICKNESS, height: 100 });
        expect(hit).toEqual({ x: 43, y: -6, width: 14, height: 112 });
    });

    it('extends a vertical split divider by 6px on each end (S48, owner-directed)', () => {
        const hit = dividerHitRect({ x: 51, y: 24.5, width: 49, height: DIVIDER_THICKNESS });
        expect(hit).toEqual({ x: 45, y: 18.5, width: 61, height: 14 });
    });

    /**
     * The half the row insists on: the VISIBLE bar is unmoved. `PaneGrid`'s `Divider` positions
     * the strip at `dividerHitRect` and then draws the bar at `+DIVIDER_HIT_INSET` inside it, so
     * the bar lands back on `info.rect` for any inset at all. Asserted here rather than in the
     * client because this is where the inset lives.
     */
    it('leaves the visible bar exactly on info.rect, whatever the inset (S48)', () => {
        const bar = { x: 49, y: 0, width: DIVIDER_THICKNESS, height: 100 };
        const hit = dividerHitRect(bar);
        expect({ x: hit.x + DIVIDER_HIT_INSET, y: hit.y + DIVIDER_HIT_INSET }).toEqual({ x: bar.x, y: bar.y });
    });
});

describe('divider drag math (gesture-start snapshot)', () => {
    const layout = split('horizontal', 0.5, leaf(A), leaf(B));
    const info = splitDividers(layout, BOUNDS)[0]!;

    it('takes the axis delta from the cumulative translation', () => {
        expect(dividerDragDelta('horizontal', { x: 12, y: -30 })).toBe(12);
        expect(dividerDragDelta('vertical', { x: 12, y: -30 })).toBe(-30);
    });

    it('tracks 1:1 with the cursor: ratio = (startFirstSize + delta) / available', () => {
        const snapshot = dividerDragSnapshot(info);
        expect(snapshot).toEqual({
            splitPath: 'd',
            direction: 'horizontal',
            firstSize: 49,
            available: 98
        });
        expect(ratioFromDividerDrag(snapshot, 9.8)).toBeCloseTo(0.6, 12);
        expect(ratioFromDividerDrag(snapshot, -9.8)).toBeCloseTo(0.4, 12);
        expect(ratioFromDividerDrag(snapshot, 0)).toBe(0.5);
    });

    it('does not compound across drag events (the deliberate fix)', () => {
        const snapshot = dividerDragSnapshot(info);
        // Successive events during one gesture carry cumulative deltas; each is
        // computed against the SAME snapshot, so the ratio stays linear in delta.
        const first = ratioFromDividerDrag(snapshot, 10);
        const second = ratioFromDividerDrag(snapshot, 20);
        expect(first).toBe((49 + 10) / 98);
        expect(second).toBe((49 + 20) / 98);
        expect(second - first).toBeCloseTo(10 / 98, 12);

        // Re-reading firstSize mid-gesture (the Swift quirk) would overshoot:
        const compounded = (98 * first + 20) / 98;
        expect(compounded).toBeGreaterThan(second);
    });

    it('feeds the model, which clamps the applied ratio', () => {
        const snapshot = dividerDragSnapshot(info);
        const dragged = updatingSplitRatio(layout, snapshot.splitPath, ratioFromDividerDrag(snapshot, -60));
        expect(ratioAtPath(dragged, 'd')).toBe(0.1);
    });
});

describe('paneAtPoint', () => {
    const layout = split('horizontal', 0.5, leaf(A), split('vertical', 0.5, leaf(B), leaf(C)));
    const frames = paneFrames(layout, BOUNDS);

    it('finds the pane containing the cursor', () => {
        expect(paneAtPoint(frames, { x: 10, y: 10 })).toBe(A);
        expect(paneAtPoint(frames, { x: 60, y: 10 })).toBe(B);
        expect(paneAtPoint(frames, { x: 60, y: 80 })).toBe(C);
    });

    it('excludes the dragged pane and returns null over divider strips', () => {
        expect(paneAtPoint(frames, { x: 10, y: 10 }, A)).toBeNull();
        expect(paneAtPoint(frames, { x: 50, y: 10 })).toBeNull();
        expect(paneAtPoint(frames, { x: 60, y: 50 })).toBeNull();
    });
});
