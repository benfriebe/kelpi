/**
 * The five tmux-style predefined layouts, plus cycling order.
 * Spec: docs/pane-layout.md §10, §11.
 *
 * The FIRST id is the "main" pane for the main-* kinds. buildLayout does not
 * clamp: predefined layouts may produce shares below 0.1 (e.g. 1/12) — only
 * the user-driven update paths clamp (§1 invariants).
 */

import type { PaneID, PaneLayout, SplitDirection } from './types.js';
import { EMPTY_LAYOUT, leaf, split } from './types.js';
import { allPaneIDs } from './tree.js';

export type PredefinedLayoutKind =
    | 'even-horizontal'
    | 'even-vertical'
    | 'main-horizontal'
    | 'main-vertical'
    | 'tiled';

/** Canonical order — used by cycling (§11.1). */
export const PREDEFINED_LAYOUT_ORDER: readonly PredefinedLayoutKind[] = [
    'even-horizontal',
    'even-vertical',
    'main-horizontal',
    'main-vertical',
    'tiled'
];

export const PREDEFINED_LAYOUT_DISPLAY_NAMES: Record<PredefinedLayoutKind, string> = {
    'even-horizontal': 'Even Horizontal',
    'even-vertical': 'Even Vertical',
    'main-horizontal': 'Main Horizontal',
    'main-vertical': 'Main Vertical',
    tiled: 'Tiled'
};

export function isPredefinedLayoutKind(value: string): value is PredefinedLayoutKind {
    return (PREDEFINED_LAYOUT_ORDER as readonly string[]).includes(value);
}

export function predefinedLayoutIndex(kind: PredefinedLayoutKind): number {
    return PREDEFINED_LAYOUT_ORDER.indexOf(kind);
}

export function predefinedLayoutAtIndex(index: number): PredefinedLayoutKind | null {
    return PREDEFINED_LAYOUT_ORDER[index] ?? null;
}

/** Right-leaning comb: first pane takes 1/N, the rest recursively split (§10.1). */
export function evenSplit(direction: SplitDirection, ids: readonly PaneID[]): PaneLayout {
    const head = ids[0];
    if (head === undefined) return EMPTY_LAYOUT;
    if (ids.length === 1) return leaf(head);
    return split(direction, 1 / ids.length, leaf(head), evenSplit(direction, ids.slice(1)));
}

/** Balanced binary tiling, alternating direction per depth (§10.5). */
export function tiledSplit(ids: readonly PaneID[], direction: SplitDirection): PaneLayout {
    const head = ids[0];
    if (head === undefined) return EMPTY_LAYOUT;
    if (ids.length === 1) return leaf(head);
    const mid = Math.floor(ids.length / 2);
    const next: SplitDirection = direction === 'horizontal' ? 'vertical' : 'horizontal';
    return split(
        direction,
        mid / ids.length,
        tiledSplit(ids.slice(0, mid), next),
        tiledSplit(ids.slice(mid), next)
    );
}

export function buildLayout(
    kind: PredefinedLayoutKind,
    paneIDs: readonly PaneID[]
): PaneLayout {
    const head = paneIDs[0];
    if (head === undefined) return EMPTY_LAYOUT;
    if (paneIDs.length === 1) return leaf(head);

    const rest = paneIDs.slice(1);
    switch (kind) {
        case 'even-horizontal':
            return evenSplit('horizontal', paneIDs);
        case 'even-vertical':
            return evenSplit('vertical', paneIDs);
        case 'main-horizontal':
            return split('vertical', 0.6, leaf(head), evenSplit('horizontal', rest));
        case 'main-vertical':
            return split('horizontal', 0.6, leaf(head), evenSplit('vertical', rest));
        case 'tiled':
            return tiledSplit(paneIDs, 'horizontal');
    }
}

/** `cycleLayout`'s index advance: null restarts at 0, then wraps (§11.1). */
export function nextLayoutIndex(currentLayoutIndex: number | null): number {
    if (currentLayoutIndex === null) return 0;
    return (currentLayoutIndex + 1) % PREDEFINED_LAYOUT_ORDER.length;
}

/** Move the focused pane to the front so it becomes the "main" pane (§11.1). */
export function orderIDsWithFocusedFirst(
    ids: readonly PaneID[],
    focusedPaneID: PaneID | null
): PaneID[] {
    if (focusedPaneID === null) return [...ids];
    const index = ids.indexOf(focusedPaneID);
    if (index <= 0) return [...ids];
    return [focusedPaneID, ...ids.slice(0, index), ...ids.slice(index + 1)];
}

/**
 * Rebuild the current tree as a predefined layout (§11.1/§11.2): ids come from
 * the *current tree's* leaves order (not the pane-list order), with the focused
 * pane hoisted to the front.
 *
 * Callers own the surrounding workspace rules: no-op with <=1 pane, un-zoom
 * first, and set `currentLayoutIndex` to this kind's index (§11.3).
 */
export function rebuildLayout(
    layout: PaneLayout,
    kind: PredefinedLayoutKind,
    focusedPaneID: PaneID | null
): PaneLayout {
    const ids = orderIDsWithFocusedFirst(allPaneIDs(layout), focusedPaneID);
    return buildLayout(kind, ids);
}
