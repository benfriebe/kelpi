/**
 * Drag-and-drop drop zones and the `movingPane` primitive.
 * Spec: docs/current/pane-layout.md §5, §7.5.
 */

import type { PaneID, PaneLayout, Point, Rect, SplitDirection } from './types.js';
import { leaf, midX, midY, split } from './types.js';
import { removing, replacing } from './tree.js';

export type DropZone = 'top' | 'bottom' | 'left' | 'right';

export const DROP_ZONES: readonly DropZone[] = ['top', 'bottom', 'left', 'right'];

export function splitDirectionOfZone(zone: DropZone): SplitDirection {
    return zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical';
}

export function draggedPaneGoesFirst(zone: DropZone): boolean {
    return zone === 'left' || zone === 'top';
}

/**
 * Closest-edge quadrant test (§5.2). Top-left origin, y down.
 * Ties (including the exact centre) resolve to the vertical branch, and within
 * it `ny > 0` is strict — so the exact centre yields "top".
 */
export function calculateDropZone(point: Point, rect: Rect): DropZone {
    const dx = point.x - midX(rect);
    const dy = point.y - midY(rect);
    const hw = rect.width / 2;
    const hh = rect.height / 2;
    const nx = hw > 0 ? dx / hw : 0;
    const ny = hh > 0 ? dy / hh : 0;
    if (Math.abs(nx) > Math.abs(ny)) return nx > 0 ? 'right' : 'left';
    return ny > 0 ? 'bottom' : 'top';
}

/** The translucent half-pane overlay drawn on the drop target (§7.5). */
export function dropZoneOverlayRect(zone: DropZone, rect: Rect): Rect {
    switch (zone) {
        case 'left':
            return { x: rect.x, y: rect.y, width: rect.width / 2, height: rect.height };
        case 'right':
            return {
                x: midX(rect),
                y: rect.y,
                width: rect.width / 2,
                height: rect.height
            };
        case 'top':
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height / 2 };
        case 'bottom':
            return {
                x: rect.x,
                y: midY(rect),
                width: rect.width,
                height: rect.height / 2
            };
    }
}

/**
 * Re-parent `paneID` onto an edge of `targetID` (§5.3): the moved pane's old
 * slot collapses first, then the target leaf becomes a fresh 50/50 split.
 *
 * Sharp edge kept deliberately: if `targetID` is absent after the removal the
 * `replacing` no-ops and the moved pane vanishes from the layout. Callers must
 * verify both panes exist in the same workspace first (§15.6).
 */
export function movingPane(
    layout: PaneLayout,
    paneID: PaneID,
    targetID: PaneID,
    zone: DropZone
): PaneLayout {
    if (paneID === targetID) return layout;

    const without = removing(layout, paneID);
    const direction = splitDirectionOfZone(zone);
    const node = draggedPaneGoesFirst(zone)
        ? split(direction, 0.5, leaf(paneID), leaf(targetID))
        : split(direction, 0.5, leaf(targetID), leaf(paneID));
    return replacing(without, targetID, node);
}

/** Wire zone names used by `kelpi pane move --target` (§12.2). */
export type WireMoveEdge = 'above' | 'below' | 'left-of' | 'right-of';

const WIRE_EDGE_TO_ZONE: Record<WireMoveEdge, DropZone> = {
    above: 'top',
    below: 'bottom',
    'left-of': 'left',
    'right-of': 'right'
};

export function dropZoneForWireEdge(edge: WireMoveEdge): DropZone {
    return WIRE_EDGE_TO_ZONE[edge];
}
