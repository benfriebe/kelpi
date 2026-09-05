/**
 * Structural queries and mutations over the layout tree.
 * Spec: docs/pane-layout.md §3, §4, §6.1.
 *
 * Every mutation returns a NEW tree; inputs are never modified.
 * Sharp edges (silent pane loss in `movingPane`, one-way rename in
 * `swappingLeaves`) are deliberate — guards live above the model (§15.6).
 */

import type { PaneID, PaneLayout, SplitDirection } from './types.js';
import { EMPTY_LAYOUT, leaf, split } from './types.js';

/** Depth-first pre-order over leaves, first child before second (§3.1). */
export function allPaneIDs(layout: PaneLayout): PaneID[] {
    switch (layout.kind) {
        case 'leaf':
            return [layout.paneID];
        case 'split':
            return [...allPaneIDs(layout.first), ...allPaneIDs(layout.second)];
        case 'empty':
            return [];
    }
}

/** True iff the node is literally the `empty` case (§3.2). */
export function isEmptyLayout(layout: PaneLayout): boolean {
    return layout.kind === 'empty';
}

export function containsPane(layout: PaneLayout, paneID: PaneID): boolean {
    switch (layout.kind) {
        case 'leaf':
            return layout.paneID === paneID;
        case 'split':
            return containsPane(layout.first, paneID) || containsPane(layout.second, paneID);
        case 'empty':
            return false;
    }
}

/** Replace the leaf with the given id by an arbitrary subtree (§4.1). */
export function replacing(
    layout: PaneLayout,
    paneID: PaneID,
    replacement: PaneLayout
): PaneLayout {
    switch (layout.kind) {
        case 'leaf':
            return layout.paneID === paneID ? replacement : layout;
        case 'split':
            return split(
                layout.direction,
                layout.ratio,
                replacing(layout.first, paneID, replacement),
                replacing(layout.second, paneID, replacement)
            );
        case 'empty':
            return layout;
    }
}

/**
 * Remove a pane, collapsing the enclosing split so the sibling is promoted
 * with its own subtree (and ratios) intact (§4.2).
 */
export function removing(layout: PaneLayout, paneID: PaneID): PaneLayout {
    switch (layout.kind) {
        case 'leaf':
            return layout.paneID === paneID ? EMPTY_LAYOUT : layout;
        case 'split': {
            const first = removing(layout.first, paneID);
            const second = removing(layout.second, paneID);
            if (first.kind === 'empty') return second;
            if (second.kind === 'empty') return first;
            return split(layout.direction, layout.ratio, first, second);
        }
        case 'empty':
            return layout;
    }
}

export interface SplittingResult {
    readonly layout: PaneLayout;
    readonly newPaneID: PaneID;
}

/**
 * Split an existing leaf 50/50: the existing pane stays `first` (left/top),
 * the new pane becomes `second` (right/bottom) (§4.3).
 *
 * `newPaneID` must be supplied by the caller (this module mints nothing —
 * the daemon pre-mints ids so split/create acks can carry the real pane id).
 * If `paneID` is absent from the tree the layout is unchanged, but the result
 * still reports `newPaneID`; callers guard before calling.
 */
export function splitting(
    layout: PaneLayout,
    paneID: PaneID,
    direction: SplitDirection,
    newPaneID: PaneID
): SplittingResult {
    const node = split(direction, 0.5, leaf(paneID), leaf(newPaneID));
    return { layout: replacing(layout, paneID, node), newPaneID };
}

/**
 * Exchange the ids of two leaves; structure, directions and ratios preserved
 * exactly (§4.4). If `id2` is not in the tree, the `id1` leaf is renamed to
 * `id2` one-way (documented, conformance test 20).
 */
export function swappingLeaves(layout: PaneLayout, id1: PaneID, id2: PaneID): PaneLayout {
    if (id1 === id2) return layout;
    const walk = (node: PaneLayout): PaneLayout => {
        switch (node.kind) {
            case 'leaf':
                if (node.paneID === id1) return leaf(id2);
                if (node.paneID === id2) return leaf(id1);
                return node;
            case 'split':
                return split(node.direction, node.ratio, walk(node.first), walk(node.second));
            case 'empty':
                return node;
        }
    };
    return walk(layout);
}

/** Cyclic next in leaves order; null for a single-pane or unknown id (§6.1). */
export function nextPaneID(layout: PaneLayout, afterID: PaneID): PaneID | null {
    const ids = allPaneIDs(layout);
    const index = ids.indexOf(afterID);
    if (index < 0 || ids.length <= 1) return null;
    return ids[(index + 1) % ids.length] ?? null;
}

/** Cyclic previous in leaves order; null for a single-pane or unknown id (§6.1). */
export function previousPaneID(layout: PaneLayout, beforeID: PaneID): PaneID | null {
    const ids = allPaneIDs(layout);
    const index = ids.indexOf(beforeID);
    if (index < 0 || ids.length <= 1) return null;
    return ids[(index - 1 + ids.length) % ids.length] ?? null;
}
