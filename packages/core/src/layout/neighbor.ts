/**
 * Spatial pane navigation.
 * Spec: docs/pane-layout.md §6.2.
 *
 * Resolution-independent: computed over fixed canonical 10000x10000 bounds so
 * "focus left" means the same thing at every window size.
 */

import type { PaneID, PaneLayout, Rect } from './types.js';
import { DIVIDER_THICKNESS, maxX, maxY, midX, midY, minX, minY } from './types.js';
import { paneFrames } from './frames.js';

export type Direction = 'left' | 'right' | 'up' | 'down';

export const NEIGHBOR_BOUNDS: Rect = { x: 0, y: 0, width: 10000, height: 10000 };

/** Frames include divider gaps, so adjacency needs DIVIDER_THICKNESS + 1 slack. */
export const NEIGHBOR_TOLERANCE = DIVIDER_THICKNESS + 1;

interface Candidate {
    readonly inDirection: boolean;
    readonly distance: number;
    /** Tiebreaker on equal distance: smaller wins (prefers top-left). */
    readonly secondary: number;
}

function evaluate(direction: Direction, source: Rect, cand: Rect): Candidate {
    switch (direction) {
        case 'left':
            return {
                inDirection: maxX(cand) <= minX(source) + NEIGHBOR_TOLERANCE,
                distance: Math.abs(minX(source) - maxX(cand)) + Math.abs(midY(source) - midY(cand)),
                secondary: midY(cand)
            };
        case 'right':
            return {
                inDirection: minX(cand) >= maxX(source) - NEIGHBOR_TOLERANCE,
                distance: Math.abs(minX(cand) - maxX(source)) + Math.abs(midY(source) - midY(cand)),
                secondary: midY(cand)
            };
        case 'up':
            return {
                inDirection: maxY(cand) <= minY(source) + NEIGHBOR_TOLERANCE,
                distance: Math.abs(minY(source) - maxY(cand)) + Math.abs(midX(source) - midX(cand)),
                secondary: midX(cand)
            };
        case 'down':
            return {
                inDirection: minY(cand) >= maxY(source) - NEIGHBOR_TOLERANCE,
                distance: Math.abs(minY(cand) - maxY(source)) + Math.abs(midX(source) - midX(cand)),
                secondary: midX(cand)
            };
    }
}

/**
 * The pane adjacent to `paneID` in `direction`, or null when nothing lies that
 * way. `inDirection` is a half-plane test on the candidate's far edge (not an
 * overlap test); ranking is edge gap + cross-axis midline offset, with the
 * explicit smaller-secondary tiebreaker so the result never depends on map
 * iteration order.
 */
export function neighborPaneID(
    layout: PaneLayout,
    paneID: PaneID,
    direction: Direction
): PaneID | null {
    const frames = paneFrames(layout, NEIGHBOR_BOUNDS);
    const source = frames.get(paneID);
    if (source === undefined) return null;

    let best: PaneID | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestSecondary = Number.POSITIVE_INFINITY;

    for (const [candID, cand] of frames) {
        if (candID === paneID) continue;
        const { inDirection, distance, secondary } = evaluate(direction, source, cand);
        if (!inDirection) continue;
        const better =
            distance < bestDistance ||
            (distance === bestDistance && secondary < bestSecondary);
        if (!better) continue;
        best = candID;
        bestDistance = distance;
        bestSecondary = secondary;
    }
    return best;
}
