/**
 * The safe triangle's geometry (#279): whether a point is on the way from a parent row into its
 * submenu. `ContextMenu.test.tsx` drives the same rule through pointer events; this is the
 * arithmetic on its own, including the flipped (left-opening) case where the triangle has to
 * point the other way.
 */

import { describe, expect, it } from 'vitest';

import {
    distanceToSubmenu,
    isAimingAtSubmenu,
    pointInTriangle,
    SAFE_TRIANGLE_APEX_BACKOFF,
    submenuNearEdge
} from './safe-triangle';

describe('pointInTriangle', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };
    const c = { x: 0, y: 10 };

    it('contains a point inside, whichever way round the corners are wound', () => {
        expect(pointInTriangle({ x: 2, y: 2 }, a, b, c)).toBe(true);
        expect(pointInTriangle({ x: 2, y: 2 }, a, c, b)).toBe(true);
    });

    it('counts the edges and corners as inside', () => {
        expect(pointInTriangle({ x: 5, y: 5 }, a, b, c)).toBe(true);
        expect(pointInTriangle({ x: 5, y: 0 }, a, b, c)).toBe(true);
        expect(pointInTriangle(b, a, b, c)).toBe(true);
    });

    it('excludes a point outside any one edge', () => {
        expect(pointInTriangle({ x: 6, y: 6 }, a, b, c)).toBe(false);
        expect(pointInTriangle({ x: -1, y: 2 }, a, b, c)).toBe(false);
        expect(pointInTriangle({ x: 2, y: -1 }, a, b, c)).toBe(false);
    });

    it('a degenerate triangle holds only the points on its line', () => {
        const flat = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }] as const;
        expect(pointInTriangle({ x: 7, y: 0 }, ...flat)).toBe(true);
        expect(pointInTriangle({ x: 7, y: 1 }, ...flat)).toBe(false);
    });
});

/**
 * A panel at x 0..190 with its Color row at y 24..48; the submenu hangs from that row's top.
 * Opened right it sits at x 194..374, flipped left (a panel near the window's right edge) the
 * mirror image, which is what the second fixture lays out around a panel at x 800..990.
 */
const RIGHT = { left: 194, right: 374, top: 24, bottom: 264 };
const LEFT = { left: 606, right: 796, top: 24, bottom: 264 };

describe('submenuNearEdge', () => {
    it('is the LEFT edge of a submenu that opened to the right', () => {
        expect(submenuNearEdge(RIGHT, 'right')).toEqual([
            { x: 194, y: 24 },
            { x: 194, y: 264 }
        ]);
    });

    it('is the RIGHT edge of a submenu that flipped to the left', () => {
        expect(submenuNearEdge(LEFT, 'left')).toEqual([
            { x: 796, y: 24 },
            { x: 796, y: 264 }
        ]);
    });
});

describe('isAimingAtSubmenu', () => {
    // The pointer left the Color row at its lower edge, heading down and right.
    const exit = { x: 120, y: 46 };

    it('protects a diagonal that crosses the rows below on the way to a lower item', () => {
        expect(isAimingAtSubmenu(exit, { x: 128, y: 54 }, RIGHT, 'right')).toBe(true);
        expect(isAimingAtSubmenu(exit, { x: 170, y: 150 }, RIGHT, 'right')).toBe(true);
    });

    it('does not protect a move back towards the panel or away from the submenu', () => {
        expect(isAimingAtSubmenu(exit, { x: 100, y: 60 }, RIGHT, 'right')).toBe(false);
    });

    it('does not protect a deliberate move straight down onto the next row', () => {
        // A row lower: the triangle is a sliver that close to its apex.
        expect(isAimingAtSubmenu(exit, { x: 120, y: 70 }, RIGHT, 'right')).toBe(false);
    });

    it('does not protect a move up, above the submenu top', () => {
        expect(isAimingAtSubmenu({ x: 120, y: 26 }, { x: 128, y: 18 }, RIGHT, 'right')).toBe(false);
    });

    it('gives a first straight-down sample somewhere to land (the apex back-off)', () => {
        // One mouse event with dy and no dx, right out of the exit point.
        expect(isAimingAtSubmenu(exit, { x: 120, y: 47 }, RIGHT, 'right')).toBe(true);
        expect(SAFE_TRIANGLE_APEX_BACKOFF).toBeGreaterThan(0);
    });

    it('holds a straight-down move for longer the nearer the exit is to the submenu (the back-off cost)', () => {
        // dy <= BACKOFF * H / (nearEdge.x - apex.x + BACKOFF), with H = 264 - 46 = 218 here.
        // Exit near the row's left, 94 px from the near edge: out after about 9 px.
        expect(isAimingAtSubmenu({ x: 100, y: 46 }, { x: 100, y: 54 }, RIGHT, 'right')).toBe(true);
        expect(isAimingAtSubmenu({ x: 100, y: 46 }, { x: 100, y: 60 }, RIGHT, 'right')).toBe(false);
        // Exit from the chevron column, 14 px from the near edge: the next row's middle (60) and
        // most of the row after it stay inside for about 48 px, so a deliberate move straight
        // down from there is held and pays the grace period. Documented, and accepted.
        expect(isAimingAtSubmenu({ x: 180, y: 46 }, { x: 180, y: 60 }, RIGHT, 'right')).toBe(true);
        expect(isAimingAtSubmenu({ x: 180, y: 46 }, { x: 180, y: 94 }, RIGHT, 'right')).toBe(true);
        expect(isAimingAtSubmenu({ x: 180, y: 46 }, { x: 180, y: 100 }, RIGHT, 'right')).toBe(false);
    });

    it('points the other way for a submenu that flipped left', () => {
        const leftExit = { x: 870, y: 46 };
        // The mirror of the right-hand diagonal is protected...
        expect(isAimingAtSubmenu(leftExit, { x: 862, y: 54 }, LEFT, 'left')).toBe(true);
        // ...and the right-hand diagonal, which now heads away from the submenu, is not.
        expect(isAimingAtSubmenu(leftExit, { x: 878, y: 54 }, LEFT, 'left')).toBe(false);
        // Reading a flipped submenu as right-opening would get both of those backwards.
        expect(isAimingAtSubmenu(leftExit, { x: 862, y: 54 }, LEFT, 'right')).toBe(false);
    });
});

describe('distanceToSubmenu', () => {
    it('shrinks as the pointer closes on the near edge, on either side', () => {
        expect(distanceToSubmenu({ x: 150, y: 60 }, RIGHT, 'right')).toBe(44);
        expect(distanceToSubmenu({ x: 180, y: 60 }, RIGHT, 'right')).toBe(14);
        expect(distanceToSubmenu({ x: 840, y: 60 }, LEFT, 'left')).toBe(44);
        expect(distanceToSubmenu({ x: 810, y: 60 }, LEFT, 'left')).toBe(14);
    });
});
