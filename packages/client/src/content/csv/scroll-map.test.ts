import { describe, expect, it } from 'vitest';

import {
    SCROLL_MAP_EDGE_PX,
    SCROLL_MAP_JUMP_VIEWPORTS,
    SCROLL_MAP_MAX_PX,
    createScrollMap,
    visibleRows
} from './scroll-map';

const VIEWPORT = 600;
/** 20 million rows at 24 px: the case the mapping exists for. */
const HUGE = 20_000_000 * 24;

describe('the scroll map below the cap', () => {
    it('is the identity: the spacer is the content and physical is virtual', () => {
        const map = createScrollMap(100_000, VIEWPORT);
        expect(map.snapshot()).toMatchObject({ spacerPx: 100_000, mapped: false, offset: 0 });
        expect(map.onScroll(12_345)).toBe(12_345);
        expect(map.scrollToVirtual(50_000)).toBe(50_000);
        expect(map.snapshot()).toMatchObject({ physical: 50_000, virtual: 50_000 });
        expect(map.recentre()).toBeNull();
    });

    it('clamps to the scrollable range', () => {
        const map = createScrollMap(10_000, VIEWPORT);
        expect(map.scrollToVirtual(1_000_000)).toBe(10_000 - VIEWPORT);
        expect(map.onScroll(-40)).toBe(0);
    });
});

describe('the scroll map above the cap', () => {
    it('caps the spacer at 8,000,000 px', () => {
        const map = createScrollMap(HUGE, VIEWPORT);
        const snapshot = map.snapshot();
        expect(snapshot.mapped).toBe(true);
        expect(snapshot.spacerPx).toBe(SCROLL_MAP_MAX_PX);
    });

    it('moves the content 1:1 for deltas under several viewports, even mid-file', () => {
        const map = createScrollMap(HUGE, VIEWPORT);
        // A jump to the middle, then ordinary wheel and fling steps.
        const middle = SCROLL_MAP_MAX_PX / 2;
        const start = map.onScroll(middle);
        expect(map.onScroll(middle + 100)).toBeCloseTo(start + 100, 6);
        expect(map.onScroll(middle + 100 + 3 * VIEWPORT)).toBeCloseTo(start + 100 + 3 * VIEWPORT, 6);
        expect(map.onScroll(middle - 50)).toBeCloseTo(start - 50, 6);
    });

    it('maps a big jump proportionally, so the scrollbar reaches the whole file', () => {
        const map = createScrollMap(HUGE, VIEWPORT);
        const jump = (SCROLL_MAP_JUMP_VIEWPORTS + 1) * VIEWPORT;
        const pmax = SCROLL_MAP_MAX_PX - VIEWPORT;
        const vmax = HUGE - VIEWPORT;
        // Halfway down the physical range is halfway down the file.
        expect(map.onScroll(pmax / 2)).toBeCloseTo(vmax / 2, -2);
        // A drag a little further is proportional, not 1:1: it covers far more content.
        const before = map.snapshot().virtual;
        const after = map.onScroll(pmax / 2 + jump);
        expect(after - before).toBeGreaterThan(jump * 10);
    });

    it('keeps both ends exact: the first and last edge zone map 1:1', () => {
        const map = createScrollMap(HUGE, VIEWPORT);
        expect(map.toVirtual(1234)).toBe(1234);
        expect(map.toPhysical(1234)).toBe(1234);
        const pmax = SCROLL_MAP_MAX_PX - VIEWPORT;
        const vmax = HUGE - VIEWPORT;
        expect(map.toVirtual(pmax - 10)).toBe(vmax - 10);
        expect(map.toVirtual(SCROLL_MAP_EDGE_PX)).toBe(SCROLL_MAP_EDGE_PX);
        // And the two directions agree in the middle.
        expect(map.toVirtual(map.toPhysical(HUGE / 3))).toBeCloseTo(HUGE / 3, 3);
    });

    it('snaps to the file’s ends when the physical scroll reaches its own', () => {
        const map = createScrollMap(HUGE, VIEWPORT);
        map.onScroll(SCROLL_MAP_MAX_PX / 2);
        map.onScroll(SCROLL_MAP_MAX_PX / 2 + 300);
        expect(map.onScroll(SCROLL_MAP_MAX_PX)).toBe(HUGE - VIEWPORT);
        expect(map.onScroll(0)).toBe(0);
    });

    it('re-centres only when asked (idle), keeping the content where it is', () => {
        const map = createScrollMap(HUGE, VIEWPORT);
        const middle = SCROLL_MAP_MAX_PX / 2;
        map.onScroll(middle);
        // 1:1 steps drift `virtual` away from the proportional position of `physical`.
        map.onScroll(middle + 2 * VIEWPORT);
        map.onScroll(middle + 4 * VIEWPORT);
        const drifted = map.snapshot();
        expect(drifted.offset).not.toBeCloseTo(map.toVirtual(drifted.physical) - drifted.physical, 0);
        const target = map.recentre();
        expect(target).not.toBeNull();
        const after = map.snapshot();
        // The content did not move; only the physical position under it did.
        expect(after.virtual).toBe(drifted.virtual);
        expect(after.physical).toBe(target);
        // Within one physical pixel's worth of content (~80 px at this ratio): `scrollTop` is whole.
        expect(Math.abs(map.toVirtual(after.physical) - after.virtual)).toBeLessThan(100);
        // The scroll event the write produces is a no-op.
        expect(map.onScroll(target!)).toBe(drifted.virtual);
        // And a second idle has nothing to do.
        expect(map.recentre()).toBeNull();
    });

    it('routes programmatic scrolls through the map: small moves keep the offset, far ones remap', () => {
        const map = createScrollMap(HUGE, VIEWPORT);
        map.onScroll(SCROLL_MAP_MAX_PX / 2);
        map.onScroll(SCROLL_MAP_MAX_PX / 2 + 1000);
        const before = map.snapshot();
        const physical = map.scrollToVirtual(before.virtual + 48);
        expect(physical).toBe(Math.round(before.physical + 48));
        expect(map.snapshot().virtual).toBe(before.virtual + 48);
        // Go to row 15,000,000: proportional.
        const far = 15_000_000 * 24;
        const target = map.scrollToVirtual(far);
        expect(map.snapshot().virtual).toBe(far);
        expect(target).toBe(Math.round(map.toPhysical(far)));
        // Back to the top is exact.
        expect(map.scrollToVirtual(0)).toBe(0);
    });

    it('keeps the content still when the file grows under it (a scan)', () => {
        const map = createScrollMap(4_000_000, VIEWPORT);
        map.onScroll(1_000_000);
        map.configure(HUGE, VIEWPORT);
        expect(map.snapshot()).toMatchObject({ mapped: true, virtual: 1_000_000, physical: 1_000_000 });
    });
});

describe('visibleRows', () => {
    it('is the rows under the viewport plus overscan, clamped to the table', () => {
        expect(visibleRows(0, 240, 24, 1000, 2)).toEqual({ start: 0, end: 12 });
        expect(visibleRows(2400, 240, 24, 1000, 2)).toEqual({ start: 98, end: 112 });
        expect(visibleRows(23_000, 240, 24, 1000, 2)).toEqual({ start: 956, end: 971 });
        expect(visibleRows(23_800, 240, 24, 1000, 2)).toEqual({ start: 989, end: 1000 });
        expect(visibleRows(0, 240, 24, 0, 2)).toEqual({ start: 0, end: 0 });
    });
});
