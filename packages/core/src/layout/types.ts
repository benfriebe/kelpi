/**
 * Layout tree types + geometry primitives.
 * Spec: docs/current/pane-layout.md §1, §1.1, §7.
 *
 * All geometry is top-left origin, y increases downward (DOM-native).
 */

export type PaneID = string;

/**
 * "horizontal" = children sit SIDE BY SIDE (left | right) — ⌘D "split right".
 * "vertical"   = children are STACKED (top / bottom)      — ⌘⇧D "split down".
 * The direction names the axis being divided. The wire/persistence strings are
 * these exact values and must round-trip.
 */
export type SplitDirection = 'horizontal' | 'vertical';

export type LeafLayout = { readonly kind: 'leaf'; readonly paneID: PaneID };

export type SplitLayout = {
    readonly kind: 'split';
    readonly direction: SplitDirection;
    /** Fraction of the *available* space (post-divider) given to `first`. */
    readonly ratio: number;
    readonly first: PaneLayout;
    readonly second: PaneLayout;
};

export type EmptyLayout = { readonly kind: 'empty' };

export type PaneLayout = LeafLayout | SplitLayout | EmptyLayout;

/** Logical px consumed by the divider between split children, in every split. */
export const DIVIDER_THICKNESS = 2;

/**
 * Divider hit area inset (px per side) — a 2+6+6 = 14px grab strip.
 *
 * SPACING-REVIEW S48 — an OWNER-DIRECTED divergence from `SplitDividerView.swift:21-25`, which
 * is `.contentShape(Rectangle().inset(by: -4))`, i.e. a 10 px band over the same 2 pt bar
 * (`PaneLayout.swift:12`). The port transcribed that exactly and it measured exactly: a
 * 10.00 × 764 grab strip over a 2.00 × 764 bar. It is also half the 20 px pointer-target floor,
 * on the one control in the grid whose whole purpose is to be dragged.
 *
 * The VISIBLE bar does not change: `PaneGrid.tsx`'s `Divider` draws it at `left/top:
 * DIVIDER_HIT_INSET` inside a strip positioned at `dividerHitRect`, so the bar's absolute
 * position is `info.rect` whatever this constant is. Measured before/after on a live 2-pane
 * split at a 1280 × 820 window: the strip 10 → 14 px wide, the 36 × 600 px picture of the bar
 * and both neighbours' insets **pixel-identical** (0 of 21 600 px differ).
 *
 * The strip sits at `zIndex: 10` over its neighbours, so this spends 6 px rather than 4 of each
 * pane's 8 px header inset on the drag handle. Measured on the same split rather than argued:
 * the strip spans x 703 → 717, the nearest control on its left (`pane-close`) ends at 701 and the
 * nearest on its right (`pane-status-dot`) starts at 719 — **2.00 px of clearance either side** —
 * and all ten pane-header controls across both panes still resolve to themselves under
 * `elementFromPoint`. A press at the strip's new outer edge starts and commits a drag (the
 * divider moved 743 → 703 px).
 *
 * Owner-directed: do not re-report this as a divergence. The parity value is 4.
 */
export const DIVIDER_HIT_INSET = 6;

/** Minimum drag distance (px) before a divider drag activates. */
export const DIVIDER_MIN_DRAG_DISTANCE = 1;

export const MIN_SPLIT_RATIO = 0.1;
export const MAX_SPLIT_RATIO = 0.9;

/** Root split path; append "L" to descend into `first`, "R" into `second`. */
export const ROOT_SPLIT_PATH = 'd';

export interface Rect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export interface Point {
    readonly x: number;
    readonly y: number;
}

export interface SplitBounds {
    readonly first: Rect;
    readonly second: Rect;
}

export interface SplitDividerInfo {
    /** Split path: "d" = root, +"L"/"R" per descent. */
    readonly id: string;
    readonly direction: SplitDirection;
    /** The visible bar, exactly DIVIDER_THICKNESS thick. */
    readonly rect: Rect;
    /** total - DIVIDER_THICKNESS along this split's axis. */
    readonly available: number;
    /** available * ratio — the first child's current extent in px. */
    readonly firstSize: number;
}

export interface EnclosingSplit {
    readonly path: string;
    /** true → the pane's share is the stored ratio; false → 1 - ratio. */
    readonly paneIsFirst: boolean;
    readonly direction: SplitDirection;
}

export const EMPTY_LAYOUT: EmptyLayout = { kind: 'empty' };

export function leaf(paneID: PaneID): LeafLayout {
    return { kind: 'leaf', paneID };
}

export function split(
    direction: SplitDirection,
    ratio: number,
    first: PaneLayout,
    second: PaneLayout
): SplitLayout {
    return { kind: 'split', direction, ratio, first, second };
}

export function empty(): EmptyLayout {
    return EMPTY_LAYOUT;
}

export function minX(rect: Rect): number {
    return rect.x;
}

export function maxX(rect: Rect): number {
    return rect.x + rect.width;
}

export function midX(rect: Rect): number {
    return rect.x + rect.width / 2;
}

export function minY(rect: Rect): number {
    return rect.y;
}

export function maxY(rect: Rect): number {
    return rect.y + rect.height;
}

export function midY(rect: Rect): number {
    return rect.y + rect.height / 2;
}

export function rectContains(rect: Rect, point: Point): boolean {
    return (
        point.x >= rect.x &&
        point.x < rect.x + rect.width &&
        point.y >= rect.y &&
        point.y < rect.y + rect.height
    );
}

/**
 * Clamp to [0.1, 0.9]. NaN propagates (matches Swift's `min(max(r, 0.1), 0.9)`,
 * where NaN comparisons are all false and the original value falls through).
 */
export function clampRatio(ratio: number): number {
    return Math.min(Math.max(ratio, MIN_SPLIT_RATIO), MAX_SPLIT_RATIO);
}
