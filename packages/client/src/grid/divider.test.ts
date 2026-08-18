import { describe, expect, it, vi } from 'vitest';

import {
    dividerDragSnapshot,
    leaf,
    split,
    splitDividers,
    type DividerDragSnapshot
} from '@nex/core/layout';

import {
    dividerCommit,
    dividerDragActivated,
    dividerPaneTarget,
    ratioForDividerDrag,
    splitNodeAtPath,
    throttleTrailing
} from './divider';

const BOUNDS = { x: 0, y: 0, width: 800, height: 600 };

function rootSnapshot(layout: Parameters<typeof splitDividers>[0]): DividerDragSnapshot {
    const info = splitDividers(layout, BOUNDS)[0];
    if (info === undefined) throw new Error('fixture has no dividers');
    return dividerDragSnapshot(info);
}

describe('splitNodeAtPath', () => {
    const nested = split('horizontal', 0.5, leaf('a'), split('vertical', 0.25, leaf('b'), leaf('c')));

    it('resolves the root and descendants', () => {
        expect(splitNodeAtPath(nested, 'd')?.direction).toBe('horizontal');
        expect(splitNodeAtPath(nested, 'dR')?.direction).toBe('vertical');
        expect(splitNodeAtPath(nested, 'dR')?.ratio).toBe(0.25);
    });

    it('returns null for a path that lands on a leaf or walks off the tree', () => {
        expect(splitNodeAtPath(nested, 'dL')).toBeNull();
        expect(splitNodeAtPath(nested, 'dLLL')).toBeNull();
        expect(splitNodeAtPath(leaf('a'), 'd')).toBeNull();
    });
});

describe('dividerPaneTarget', () => {
    it('prefers the first child, whose share is the ratio itself', () => {
        const layout = split('horizontal', 0.4, leaf('a'), leaf('b'));
        expect(dividerPaneTarget(layout, 'd')).toEqual({ paneID: 'a', paneIsFirst: true });
    });

    it('falls back to the second child when the first is a split', () => {
        const layout = split('horizontal', 0.4, split('vertical', 0.5, leaf('a'), leaf('b')), leaf('c'));
        expect(dividerPaneTarget(layout, 'd')).toEqual({ paneID: 'c', paneIsFirst: false });
    });

    it('is null when both children are splits — no wire verb can address that divider', () => {
        const layout = split(
            'horizontal',
            0.5,
            split('vertical', 0.5, leaf('a'), leaf('b')),
            split('vertical', 0.5, leaf('c'), leaf('d'))
        );
        expect(dividerPaneTarget(layout, 'd')).toBeNull();
    });
});

describe('ratioForDividerDrag', () => {
    const layout = split('horizontal', 0.5, leaf('a'), leaf('b'));
    const snapshot = rootSnapshot(layout);

    it('snapshots firstSize once: the ratio is linear in the cumulative delta', () => {
        // available = 800 - 2 = 798, firstSize = 399.
        expect(snapshot.available).toBe(798);
        expect(snapshot.firstSize).toBe(399);
        const at = (dx: number): number =>
            ratioForDividerDrag(snapshot, { x: 100, y: 0 }, { x: 100 + dx, y: 0 });
        expect(at(0)).toBeCloseTo(0.5, 12);
        expect(at(60)).toBeCloseTo((399 + 60) / 798, 12);
        expect(at(120) - at(60)).toBeCloseTo(at(60) - at(0), 12);
    });

    it('ignores movement across the split axis', () => {
        const moved = ratioForDividerDrag(snapshot, { x: 100, y: 0 }, { x: 100, y: 250 });
        expect(moved).toBeCloseTo(0.5, 12);
    });

    it('tracks the vertical axis for a vertical split', () => {
        const vertical = rootSnapshot(split('vertical', 0.5, leaf('a'), leaf('b')));
        expect(vertical.available).toBe(598);
        const ratio = ratioForDividerDrag(vertical, { x: 0, y: 10 }, { x: 999, y: 60 });
        expect(ratio).toBeCloseTo((299 + 50) / 598, 12);
    });

    it('clamps to [0.1, 0.9]', () => {
        expect(ratioForDividerDrag(snapshot, { x: 0, y: 0 }, { x: -5000, y: 0 })).toBe(0.1);
        expect(ratioForDividerDrag(snapshot, { x: 0, y: 0 }, { x: 5000, y: 0 })).toBe(0.9);
    });
});

describe('dividerDragActivated', () => {
    it('needs one pixel along the split axis', () => {
        expect(dividerDragActivated('horizontal', { x: 0, y: 0 }, { x: 0.5, y: 900 })).toBe(false);
        expect(dividerDragActivated('horizontal', { x: 0, y: 0 }, { x: -1, y: 0 })).toBe(true);
        expect(dividerDragActivated('vertical', { x: 0, y: 0 }, { x: 900, y: 0.5 })).toBe(false);
        expect(dividerDragActivated('vertical', { x: 0, y: 0 }, { x: 0, y: 1 })).toBe(true);
    });
});

describe('dividerCommit', () => {
    it('reports the first child share unchanged', () => {
        const layout = split('horizontal', 0.5, leaf('a'), leaf('b'));
        const commit = dividerCommit(layout, rootSnapshot(layout), 0.62);
        expect(commit).toEqual({
            splitPath: 'd',
            ratio: 0.62,
            direction: 'horizontal',
            paneID: 'a',
            share: 0.62
        });
    });

    it('inverts the share when only the second child is a leaf', () => {
        const layout = split('horizontal', 0.5, split('vertical', 0.5, leaf('a'), leaf('b')), leaf('c'));
        const commit = dividerCommit(layout, rootSnapshot(layout), 0.62);
        expect(commit.paneID).toBe('c');
        expect(commit.share).toBeCloseTo(0.38, 12);
    });

    it('leaves paneID null for a split with no leaf child', () => {
        const layout = split(
            'horizontal',
            0.5,
            split('vertical', 0.5, leaf('a'), leaf('b')),
            split('vertical', 0.5, leaf('c'), leaf('d'))
        );
        const commit = dividerCommit(layout, rootSnapshot(layout), 0.62);
        expect(commit.paneID).toBeNull();
        expect(commit.share).toBe(0.62);
    });
});

describe('throttleTrailing', () => {
    it('runs the first call immediately and coalesces the rest, last value winning', () => {
        vi.useFakeTimers();
        try {
            const seen: number[] = [];
            const throttled = throttleTrailing((value: number) => seen.push(value), 50);
            throttled(1);
            throttled(2);
            throttled(3);
            expect(seen).toEqual([1]);
            vi.advanceTimersByTime(50);
            expect(seen).toEqual([1, 3]);
            vi.advanceTimersByTime(500);
            expect(seen).toEqual([1, 3]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('flush() emits the suppressed call at once; cancel() drops it', () => {
        vi.useFakeTimers();
        try {
            const seen: number[] = [];
            const throttled = throttleTrailing((value: number) => seen.push(value), 50);
            throttled(1);
            throttled(2);
            throttled.flush();
            expect(seen).toEqual([1, 2]);

            throttled(3);
            throttled(4);
            throttled.cancel();
            vi.advanceTimersByTime(500);
            expect(seen).toEqual([1, 2]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('an interval of 0 commits every call', () => {
        const seen: number[] = [];
        const throttled = throttleTrailing((value: number) => seen.push(value), 0);
        throttled(1);
        throttled(2);
        throttled(3);
        expect(seen).toEqual([1, 2, 3]);
    });
});
