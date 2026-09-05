/**
 * Split addressing by path: locate, read and update ratios.
 * Spec: docs/pane-layout.md §8, §9, §12.5.
 *
 * Path encoding (§7.3): "d" is the root split, "L" descends into `first`,
 * "R" into `second`. Paths are positional and go stale after any structural
 * change — a path that no longer lands on a split is a no-op, never an error.
 */

import type { EnclosingSplit, PaneID, PaneLayout } from './types.js';
import { ROOT_SPLIT_PATH, clampRatio, split } from './types.js';
import { containsPane } from './tree.js';

/** Strip the leading path marker; the first character is always dropped. */
function navigation(path: string): string {
    return path.slice(1);
}

/**
 * Set the ratio of the addressed split, clamped to [0.1, 0.9] (§9.1).
 * A path that walks off the tree returns the tree unchanged. Any nav character
 * other than "L" is treated as "R".
 */
export function updatingSplitRatio(
    layout: PaneLayout,
    atPath: string,
    newRatio: number
): PaneLayout {
    const clamped = clampRatio(newRatio);
    const walk = (node: PaneLayout, nav: string): PaneLayout => {
        if (node.kind !== 'split') return node;
        if (nav.length === 0) {
            return split(node.direction, clamped, node.first, node.second);
        }
        const head = nav[0];
        const rest = nav.slice(1);
        if (head === 'L') {
            return split(node.direction, node.ratio, walk(node.first, rest), node.second);
        }
        return split(node.direction, node.ratio, node.first, walk(node.second, rest));
    };
    return walk(layout, navigation(atPath));
}

/** The stored first-child ratio at a path, or null if it isn't a split (§9.2). */
export function ratioAtPath(layout: PaneLayout, atPath: string): number | null {
    const walk = (node: PaneLayout, nav: string): number | null => {
        if (node.kind !== 'split') return null;
        if (nav.length === 0) return node.ratio;
        const head = nav[0];
        const rest = nav.slice(1);
        return head === 'L' ? walk(node.first, rest) : walk(node.second, rest);
    };
    return walk(layout, navigation(atPath));
}

/**
 * The immediate parent split of a pane's leaf (§8) — the split whose direct
 * child is `leaf(paneID)`. Null for a sole root leaf or an absent pane.
 */
export function enclosingSplitPath(
    layout: PaneLayout,
    paneID: PaneID,
    prefix: string = ROOT_SPLIT_PATH
): EnclosingSplit | null {
    if (layout.kind !== 'split') return null;
    if (containsPane(layout.first, paneID)) {
        const deeper = enclosingSplitPath(layout.first, paneID, `${prefix}L`);
        return deeper ?? { path: prefix, paneIsFirst: true, direction: layout.direction };
    }
    if (containsPane(layout.second, paneID)) {
        const deeper = enclosingSplitPath(layout.second, paneID, `${prefix}R`);
        return deeper ?? { path: prefix, paneIsFirst: false, direction: layout.direction };
    }
    return null;
}

/** A pane's own share of its enclosing split (§12.5). */
export function shareForRatio(ratio: number, paneIsFirst: boolean): number {
    return paneIsFirst ? ratio : 1 - ratio;
}

/** The stored first-child ratio that gives a pane the requested share (§12.5). */
export function ratioForShare(share: number, paneIsFirst: boolean): number {
    return paneIsFirst ? share : 1 - share;
}

export interface ResizeResult {
    readonly layout: PaneLayout;
    readonly splitPath: string;
    /** Stored first-child ratio after the update. */
    readonly ratio: number;
    /** The pane's own clamped share. */
    readonly targetShare: number;
}

/** Default `--grow`/`--shrink` step for `kelpi pane resize` (§12.5). */
export const RESIZE_STEP = 0.05;

/**
 * The `pane resize` share→ratio pipeline (§12.5): clamp the requested share to
 * [0.1, 0.9], convert to the split's first-child ratio, apply. Returns null
 * when the pane has no enclosing split (sole leaf / absent) — the caller
 * replies with the "no sibling to resize against" error.
 */
export function resizePaneShare(
    layout: PaneLayout,
    paneID: PaneID,
    desiredShare: number
): ResizeResult | null {
    const enclosing = enclosingSplitPath(layout, paneID);
    if (enclosing === null) return null;
    const targetShare = clampRatio(desiredShare);
    const requestedRatio = ratioForShare(targetShare, enclosing.paneIsFirst);
    const updated = updatingSplitRatio(layout, enclosing.path, requestedRatio);
    // Report the ratio actually stored: `1 - 0.9` lands a hair under the clamp
    // floor, so the model's own clamp can nudge the requested value.
    return {
        layout: updated,
        splitPath: enclosing.path,
        ratio: ratioAtPath(updated, enclosing.path) ?? requestedRatio,
        targetShare
    };
}

/**
 * A pane's current share, for `--grow`/`--shrink` deltas (§12.5). The stored
 * ratio defaults to 0.5 when the path unexpectedly doesn't resolve.
 */
export function currentPaneShare(layout: PaneLayout, paneID: PaneID): number | null {
    const enclosing = enclosingSplitPath(layout, paneID);
    if (enclosing === null) return null;
    const ratio = ratioAtPath(layout, enclosing.path) ?? 0.5;
    return shareForRatio(ratio, enclosing.paneIsFirst);
}
