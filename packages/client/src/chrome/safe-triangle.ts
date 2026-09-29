/**
 * The geometry of a submenu's "safe triangle" (#279), kept pure so it can be tested without a
 * box model.
 *
 * A submenu hangs off the side of its parent row, and the rows below (or above) that parent sit
 * between the pointer and most of the submenu's items. The straight line from the parent row to,
 * say, the ninth colour in the workspace Color ▸ submenu crosses Profile and Change Icon on the
 * way, and a menu that switches submenus the moment another row is entered takes the colour list
 * away mid-journey. The user had to move horizontally into the submenu first and only then down,
 * which is not how a hand moves a pointer.
 *
 * The fix every native menu uses: while the pointer is travelling from where it left the parent
 * row towards the submenu, it is inside the triangle whose apex is that exit point and whose
 * base is the submenu's NEAR edge. Rows crossed inside that triangle are on the way, not a
 * choice. `ContextMenu` owns the timing (a short grace period, so resting on a row still switches
 * to it); this file only answers "is this point on the way to that submenu?".
 *
 * See https://www.smashingmagazine.com/2023/08/better-context-menus-safe-triangles/ for the
 * behaviour this reproduces.
 */

export interface Point {
    readonly x: number;
    readonly y: number;
}

/** A submenu's box in client coordinates, as `getBoundingClientRect` reports it. */
export interface SubmenuBox {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
}

/** Which side of its parent a submenu opened on (`ContextMenu`'s `data-submenu-side`). */
export type SubmenuSide = 'left' | 'right';

/**
 * How far the apex is pushed back, away from the submenu, before the triangle is built.
 *
 * With the apex exactly on the exit point, a pointer that leaves the parent row straight down for
 * one sample (a hand's diagonal is not a perfect line, and one mouse event can carry dy with no
 * dx) sits on the triangle's very tip and reads as "not heading for the submenu". Four pixels
 * gives that first sample somewhere to land without widening the triangle enough to swallow a
 * deliberate vertical move to the next row, which leaves it within a row's height.
 */
export const SAFE_TRIANGLE_APEX_BACKOFF = 4;

/** The z of (b - a) x (p - a): which side of the line a→b the point p is on. */
function side(p: Point, a: Point, b: Point): number {
    return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

/**
 * Whether `p` lies inside the triangle abc, edges included, whichever way round it is wound.
 *
 * The sign test: a point inside is on the same side of all three edges. A degenerate triangle
 * (the three corners on one line) contains only points on that line, which is the right answer
 * for a submenu with no height.
 */
export function pointInTriangle(p: Point, a: Point, b: Point, c: Point): boolean {
    const d1 = side(p, a, b);
    const d2 = side(p, b, c);
    const d3 = side(p, c, a);
    const negative = d1 < 0 || d2 < 0 || d3 < 0;
    const positive = d1 > 0 || d2 > 0 || d3 > 0;
    return !(negative && positive);
}

/**
 * The two corners of the submenu edge that faces its parent: the LEFT edge of a submenu that
 * opened to the right, and the RIGHT edge of one that flipped to the left near the window's edge.
 * Using the far edge would build a triangle that points through the submenu, and using the wrong
 * side's edge for a flipped submenu would protect a path away from it.
 */
export function submenuNearEdge(box: SubmenuBox, opened: SubmenuSide): readonly [Point, Point] {
    const x = opened === 'right' ? box.left : box.right;
    return [
        { x, y: box.top },
        { x, y: box.bottom }
    ];
}

/**
 * Whether a pointer at `point`, having left the parent row at `apex`, is still on its way into
 * the submenu: inside the triangle from the (backed-off) apex to the submenu's near edge.
 */
export function isAimingAtSubmenu(apex: Point, point: Point, box: SubmenuBox, opened: SubmenuSide): boolean {
    const origin = {
        x: apex.x + (opened === 'right' ? -SAFE_TRIANGLE_APEX_BACKOFF : SAFE_TRIANGLE_APEX_BACKOFF),
        y: apex.y
    };
    const [top, bottom] = submenuNearEdge(box, opened);
    return pointInTriangle(point, origin, top, bottom);
}

/**
 * How far the pointer still has to travel, horizontally, to reach the submenu's near edge.
 * A submenu hangs from its parent row's top, so the apex is within the near edge's vertical span
 * and so is everything inside the triangle: the horizontal gap is the whole distance.
 * `ContextMenu` uses it to tell progress from dawdling.
 */
export function distanceToSubmenu(point: Point, box: SubmenuBox, opened: SubmenuSide): number {
    return opened === 'right' ? box.left - point.x : point.x - box.right;
}
