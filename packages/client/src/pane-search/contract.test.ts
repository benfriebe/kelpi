/**
 * The size clamp, where the box goes and what a needle is: the three pure decisions this surface
 * makes before any of it reaches a window.
 *
 * Every one of them takes a number that arrives over a plugin call, so the edges are the point: the
 * ceilings in both axes, the pane's own room, the floor, a non-finite declaration, and a pane that
 * has not been measured.
 */

import { describe, expect, it } from 'vitest';

import {
    PANE_SEARCH_LIMITS,
    PANE_SEARCH_PLACEMENT,
    isPaneSearchKind,
    paneSearchBox,
    paneSearchClipPath,
    paneSearchNeedle,
    paneSearchRect
} from './contract';

const pane = { width: 800, height: 600 };

describe('the placement', () => {
    it('opens on a shell pane and on no other kind', () => {
        expect(PANE_SEARCH_PLACEMENT).toBe('pane.search');
        expect(isPaneSearchKind('shell')).toBe(true);
        for (const kind of ['markdown', 'scratchpad', 'diff', 'web', 'plugin'] as const) {
            expect(isPaneSearchKind(kind)).toBe(false);
        }
    });
});

describe('paneSearchBox', () => {
    it('is the native bar\'s own measured box until something is declared', () => {
        expect(paneSearchBox(null, pane)).toEqual({
            width: PANE_SEARCH_LIMITS.nativeWidth,
            height: PANE_SEARCH_LIMITS.nativeHeight
        });
    });

    /**
     * The one deliberate asymmetry, and the reason it is here rather than in the general clamp: the
     * native bar holds its own WIDTH to `calc(100% - 16px)` and does nothing at all about its
     * height. Clamping the undeclared height as well would shrink the bundled bar on a short pane
     * nobody has declared anything for, which is a visible change to the surface that shipped.
     */
    it('holds the native default to the pane\'s inner width and leaves its height alone', () => {
        expect(paneSearchBox(null, { width: 200, height: 90 })).toEqual({
            width: 200 - PANE_SEARCH_LIMITS.margin * 2,
            height: PANE_SEARCH_LIMITS.nativeHeight
        });
        // 25% of 90 is 22, well under the native 35, and the default still measures 35.
        expect(paneSearchBox(null, { width: 200, height: 90 }).height).toBeGreaterThan(90 * 0.25);
    });

    it('clamps a declared width to 480 and a declared height to 96', () => {
        expect(paneSearchBox({ width: 9_999, height: 9_999 }, { width: 4_000, height: 4_000 })).toEqual({
            width: PANE_SEARCH_LIMITS.maxWidth,
            height: PANE_SEARCH_LIMITS.maxHeight
        });
    });

    it('clamps a declared box to the pane when the pane is the smaller ceiling', () => {
        // 300 - 16 = 284 of room, and a quarter of 160 is 40.
        expect(paneSearchBox({ width: 460, height: 90 }, { width: 300, height: 160 })).toEqual({
            width: 284,
            height: 40
        });
    });

    it('honours a declaration that fits, rounding a fractional one', () => {
        expect(paneSearchBox({ width: 320.4, height: 55.6 }, pane)).toEqual({ width: 320, height: 56 });
    });

    /**
     * The three answers `box.ts`'s store gives, said by the clamp so the two cannot disagree: a
     * negative number is 0 (a legal box, because a presenter drawing nothing should cost nothing),
     * and a non-finite one is not a size at all.
     */
    it('floors a negative declaration at zero and refuses a non-finite one', () => {
        expect(paneSearchBox({ width: -40, height: -1 }, pane)).toEqual({ width: 0, height: 0 });
        for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
            expect(paneSearchBox({ width: bad, height: 40 }, pane)).toEqual({
                width: PANE_SEARCH_LIMITS.nativeWidth,
                height: PANE_SEARCH_LIMITS.nativeHeight
            });
            expect(paneSearchBox({ width: 300, height: bad }, pane)).toEqual({
                width: PANE_SEARCH_LIMITS.nativeWidth,
                height: PANE_SEARCH_LIMITS.nativeHeight
            });
        }
    });

    it('refuses every declaration for a pane it has no measurement of', () => {
        for (const bad of [
            { width: 0, height: 600 },
            { width: 800, height: 0 },
            { width: Number.NaN, height: 600 },
            { width: 800, height: Number.POSITIVE_INFINITY }
        ]) {
            expect(paneSearchBox({ width: 300, height: 40 }, bad)).toEqual({
                width: PANE_SEARCH_LIMITS.nativeWidth,
                height: PANE_SEARCH_LIMITS.nativeHeight
            });
        }
    });

    it('gives a pane narrower than the margins a box of no width rather than a negative one', () => {
        expect(paneSearchBox({ width: 200, height: 20 }, { width: 8, height: 400 }).width).toBe(0);
    });
});

describe('paneSearchRect', () => {
    it('puts the box at the pane\'s top-trailing corner, inset by the native bar\'s margin', () => {
        const frame = { x: 100, y: 40, width: 800, height: 600 };
        expect(paneSearchRect(frame, { width: 266, height: 35 })).toEqual({
            x: 100 + 800 - 8 - 266,
            y: 40 + 8,
            width: 266,
            height: 35
        });
    });

    /**
     * The leading edge is never crossed. The clamp has already held the width to the pane's inner
     * width, and this says the same thing again for a caller that passed a box it did not clamp -
     * a bar that grew off the leading edge is the §S16 defect the native bar's own ceiling exists
     * to prevent.
     */
    it('never reaches past the pane\'s leading edge, whatever box it is handed', () => {
        const frame = { x: 100, y: 40, width: 200, height: 300 };
        const rect = paneSearchRect(frame, { width: 9_999, height: 9_999 });
        expect(rect.x).toBeGreaterThanOrEqual(frame.x);
        expect(rect.x + rect.width).toBeLessThanOrEqual(frame.x + frame.width);
        expect(rect.y + rect.height).toBeLessThanOrEqual(frame.y + frame.height);
    });
});

describe('paneSearchClipPath', () => {
    it('clips to the one box, and to nothing at all when there is none', () => {
        expect(paneSearchClipPath({ x: 10, y: 20, width: 100, height: 30 })).toBe(
            `path('M10 20H110V50H10Z')`
        );
        expect(paneSearchClipPath(null)).toBe(`path('M0 0Z')`);
        expect(paneSearchClipPath({ x: 10, y: 20, width: 0, height: 30 })).toBe(`path('M0 0Z')`);
        expect(paneSearchClipPath({ x: 10, y: 20, width: 100, height: 0 })).toBe(`path('M0 0Z')`);
    });
});

describe('paneSearchNeedle', () => {
    it('accepts a single line within the cap', () => {
        expect(paneSearchNeedle('')).toBe('');
        expect(paneSearchNeedle('anchor')).toBe('anchor');
        expect(paneSearchNeedle('x'.repeat(PANE_SEARCH_LIMITS.needleChars))).toHaveLength(
            PANE_SEARCH_LIMITS.needleChars
        );
    });

    it('refuses a non-string, an oversized one, and anything with a line break in it', () => {
        expect(paneSearchNeedle(7)).toBeNull();
        expect(paneSearchNeedle(null)).toBeNull();
        expect(paneSearchNeedle(undefined)).toBeNull();
        expect(paneSearchNeedle('x'.repeat(PANE_SEARCH_LIMITS.needleChars + 1))).toBeNull();
        // A single-line `<input>` cannot express these, and the daemon would scan for a run that
        // can never match a terminal line.
        for (const code of [0x0a, 0x0d, 0x2028, 0x2029])
            expect(paneSearchNeedle(`a${String.fromCharCode(code)}b`)).toBeNull();
    });
});
