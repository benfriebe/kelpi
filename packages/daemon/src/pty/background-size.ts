/**
 * How big a pane in a BACKGROUND tab will be drawn (workspace-feature.md §12.6).
 *
 * The spawn gate (`spawn-gate.ts`) holds a new shell until a client measures its pane, and no
 * client measures a pane in a tab that is not on screen. A shell opened there (`kelpi tab new`,
 * an agent's split under "Panes an agent creates go: into a new tab each", a Duplicate Tab copy)
 * would wait out the gate and then start at another pane's size, which the headless emulator
 * never reflows. So it is not offered to the gate at all, and starts at this estimate instead:
 * the on-screen tab's measured panes say how big the pane area is, and the pane's share of its
 * own tab's tree says how much of that area it will get. A guess, but right for the common
 * cases: a new tab's only pane fills the area, and a copy of a split keeps the split's ratios.
 */

import { paneFrames, type PaneLayout } from '@kelpi/core/layout';

import { tabLayout, tabOfPane, type WorkspaceState } from '../store/index.js';
import type { GridSize } from './geometry.js';

/** A nominal pane area: big enough that a divider's few units are lost in the rounding. */
const AREA_UNITS = 1000;

/** Never smaller than a shell can print a prompt in. */
const MIN_COLS = 20;
const MIN_ROWS = 5;

/** Each leaf's fraction of the pane area, as the grid would draw `layout`. */
function shares(layout: PaneLayout): Map<string, { readonly width: number; readonly height: number }> {
    const fractions = new Map<string, { readonly width: number; readonly height: number }>();
    for (const [paneID, rect] of paneFrames(layout, { x: 0, y: 0, width: AREA_UNITS, height: AREA_UNITS })) {
        fractions.set(paneID, { width: rect.width / AREA_UNITS, height: rect.height / AREA_UNITS });
    }
    return fractions;
}

/**
 * The grid `paneID` would be drawn at once its tab is shown, or null when nothing measured on
 * screen says how big the pane area is (the caller then keeps its own fallback).
 */
export function estimateBackgroundGrid(
    workspace: WorkspaceState,
    paneID: string,
    measured: (paneID: string) => GridSize | null
): GridSize | null {
    const tab = tabOfPane(workspace, paneID);
    if (tab === null) return null;
    // The pane area, from any measured pane of the tab on screen: its grid over its share.
    let area: GridSize | null = null;
    for (const [onScreenID, share] of shares(workspace.layout)) {
        const size = measured(onScreenID);
        if (size === null || share.width <= 0 || share.height <= 0) continue;
        area = { cols: size.cols / share.width, rows: size.rows / share.height };
        break;
    }
    if (area === null) return null;
    const own = shares(tabLayout(workspace, tab).layout).get(paneID);
    if (own === undefined) return null;
    return {
        cols: Math.max(MIN_COLS, Math.round(area.cols * own.width)),
        rows: Math.max(MIN_ROWS, Math.round(area.rows * own.height))
    };
}
