/**
 * Frame + divider geometry.
 * Spec: docs/current/pane-layout.md §7.
 *
 * No rounding, no clamping, no minimum sizes: sizes are fractional floats and
 * absurd ratios / tiny bounds may produce negative extents. The frame math must
 * be byte-identical in daemon and client or divider drags jitter (§15.1).
 */

import type {
    PaneID,
    PaneLayout,
    Point,
    Rect,
    SplitBounds,
    SplitDirection,
    SplitDividerInfo
} from './types.js';
import { DIVIDER_HIT_INSET, DIVIDER_THICKNESS, ROOT_SPLIT_PATH, rectContains } from './types.js';

/** The core sizing rule: the ratio applies to space AFTER the divider (§7.1). */
export function splitBounds(
    direction: SplitDirection,
    ratio: number,
    bounds: Rect
): SplitBounds {
    const total = direction === 'horizontal' ? bounds.width : bounds.height;
    const available = total - DIVIDER_THICKNESS;
    const firstSize = available * ratio;

    if (direction === 'horizontal') {
        return {
            first: { x: bounds.x, y: bounds.y, width: firstSize, height: bounds.height },
            second: {
                x: bounds.x + firstSize + DIVIDER_THICKNESS,
                y: bounds.y,
                width: available - firstSize,
                height: bounds.height
            }
        };
    }
    return {
        first: { x: bounds.x, y: bounds.y, width: bounds.width, height: firstSize },
        second: {
            x: bounds.x,
            y: bounds.y + firstSize + DIVIDER_THICKNESS,
            width: bounds.width,
            height: available - firstSize
        }
    };
}

/**
 * One rect per leaf pane, keyed by pane id (§7.2). Insertion order is the DFS
 * leaves order (§3.1) — neighbour resolution relies on a deterministic order.
 */
export function paneFrames(layout: PaneLayout, bounds: Rect): Map<PaneID, Rect> {
    const frames = new Map<PaneID, Rect>();
    const walk = (node: PaneLayout, rect: Rect): void => {
        switch (node.kind) {
            case 'leaf':
                frames.set(node.paneID, rect);
                return;
            case 'split': {
                const { first, second } = splitBounds(node.direction, node.ratio, rect);
                walk(node.first, first);
                walk(node.second, second);
                return;
            }
            case 'empty':
                return;
        }
    };
    walk(layout, bounds);
    return frames;
}

/** One record per split node, addressed by split path (§7.3). */
export function splitDividers(
    layout: PaneLayout,
    bounds: Rect,
    prefix: string = ROOT_SPLIT_PATH
): SplitDividerInfo[] {
    if (layout.kind !== 'split') return [];

    const total = layout.direction === 'horizontal' ? bounds.width : bounds.height;
    const available = total - DIVIDER_THICKNESS;
    const firstSize = available * layout.ratio;
    const { first, second } = splitBounds(layout.direction, layout.ratio, bounds);

    const rect: Rect =
        layout.direction === 'horizontal'
            ? {
                  x: bounds.x + firstSize,
                  y: bounds.y,
                  width: DIVIDER_THICKNESS,
                  height: bounds.height
              }
            : {
                  x: bounds.x,
                  y: bounds.y + firstSize,
                  width: bounds.width,
                  height: DIVIDER_THICKNESS
              };

    return [
        { id: prefix, direction: layout.direction, rect, available, firstSize },
        ...splitDividers(layout.first, first, `${prefix}L`),
        ...splitDividers(layout.second, second, `${prefix}R`)
    ];
}

/** The grab strip: the visible bar inset by -4px on every side (§7.4). */
export function dividerHitRect(rect: Rect): Rect {
    return {
        x: rect.x - DIVIDER_HIT_INSET,
        y: rect.y - DIVIDER_HIT_INSET,
        width: rect.width + DIVIDER_HIT_INSET * 2,
        height: rect.height + DIVIDER_HIT_INSET * 2
    };
}

/** Snapshot taken once when a divider drag begins (§7.4 port note). */
export interface DividerDragSnapshot {
    readonly splitPath: string;
    readonly direction: SplitDirection;
    readonly firstSize: number;
    readonly available: number;
}

export function dividerDragSnapshot(info: SplitDividerInfo): DividerDragSnapshot {
    return {
        splitPath: info.id,
        direction: info.direction,
        firstSize: info.firstSize,
        available: info.available
    };
}

/**
 * 1:1 divider tracking (the deliberate fix, PLAN "Decisions"): the drag start
 * `firstSize` is snapshotted once and the cumulative gesture delta is added to
 * it. The Swift app re-read `firstSize` from the re-rendered view every event
 * while the delta stayed cumulative, so the divider outran the cursor.
 *
 * Returns the raw (unclamped) ratio — `updatingSplitRatio` clamps.
 */
export function ratioFromDividerDrag(
    snapshot: DividerDragSnapshot,
    cumulativeDelta: number
): number {
    return (snapshot.firstSize + cumulativeDelta) / snapshot.available;
}

/** Delta along the split axis for a cumulative gesture translation (§7.4). */
export function dividerDragDelta(
    direction: SplitDirection,
    translation: Point
): number {
    return direction === 'horizontal' ? translation.x : translation.y;
}

/**
 * Hit-test for drag-and-drop (§7.5): the pane whose rect contains the cursor,
 * excluding the dragged pane. Rects never overlap, so iteration order only
 * matters for divider strips, which belong to no pane.
 */
export function paneAtPoint(
    frames: ReadonlyMap<PaneID, Rect>,
    point: Point,
    excludingPaneID: PaneID | null = null
): PaneID | null {
    for (const [paneID, rect] of frames) {
        if (paneID === excludingPaneID) continue;
        if (rectContains(rect, point)) return paneID;
    }
    return null;
}
