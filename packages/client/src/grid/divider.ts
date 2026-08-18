/**
 * Divider-drag maths and the commit shape the grid raises.
 *
 * Every geometric decision here delegates to `@nex/core/layout` (pane-layout.md §7.4) —
 * this module only sequences it: snapshot at gesture start, cumulative delta, clamp,
 * translate the split's stored ratio into something the wire can actually address.
 *
 * ## Why a commit object and not just `(splitPath, ratio)`
 *
 * The layout model resizes by SPLIT PATH (`updatingSplitRatio`), but the wire has no
 * `update-split-ratio` verb: the only ratio-writing command is `pane-resize`, which takes a
 * PANE and that pane's own SHARE of its enclosing split (wire §4.9, `pane-resize --ratio`,
 * exposed as `commands.setSplitRatio(paneID, share)`). `enclosingSplitPath` only ever
 * resolves the split whose DIRECT child is the pane's leaf, so a split is addressable over
 * the wire exactly when one of its two children is a leaf. `dividerCommit` works that out
 * once and hands assembly both spellings.
 */

import {
    DIVIDER_MIN_DRAG_DISTANCE,
    ROOT_SPLIT_PATH,
    clampRatio,
    dividerDragDelta,
    ratioFromDividerDrag,
    shareForRatio,
    type DividerDragSnapshot,
    type PaneLayout,
    type Point,
    type SplitDirection,
    type SplitLayout
} from '@nex/core/layout';

/** The addressable-pane half of a commit: which pane `pane-resize` should target. */
export interface DividerPaneTarget {
    readonly paneID: string;
    /** True when the pane is the split's `first` child, so its share IS the stored ratio. */
    readonly paneIsFirst: boolean;
}

/** What a divider gesture asks the world to do. */
export interface DividerRatioCommit {
    /** Split path (`"d"`, `"dL"`, …) for the model-side `updatingSplitRatio`. */
    readonly splitPath: string;
    /** The split's new stored first-child ratio, already clamped to [0.1, 0.9]. */
    readonly ratio: number;
    readonly direction: SplitDirection;
    /**
     * A pane whose enclosing split IS this split, i.e. one `commands.setSplitRatio` can
     * address. `null` when both children are themselves splits (e.g. the root divider of a
     * 2×2 tiled layout) — no wire verb can express that resize today; the grid still shows
     * the live preview and assembly decides what to do.
     */
    readonly paneID: string | null;
    /** That pane's own share of the split — the second argument to `setSplitRatio`. */
    readonly share: number;
}

/** Walk a split path (§7.3 encoding: drop the marker, then `L` = first, anything else = second). */
export function splitNodeAtPath(layout: PaneLayout, splitPath: string): SplitLayout | null {
    let node: PaneLayout = layout;
    for (const step of splitPath.slice(1)) {
        if (node.kind !== 'split') return null;
        node = step === 'L' ? node.first : node.second;
    }
    return node.kind === 'split' ? node : null;
}

/**
 * The pane `pane-resize` can use to move this divider. Prefers the `first` child (its share
 * is the ratio unchanged); falls back to `second` (share = 1 - ratio).
 */
export function dividerPaneTarget(layout: PaneLayout, splitPath: string): DividerPaneTarget | null {
    const node = splitNodeAtPath(layout, splitPath);
    if (node === null) return null;
    if (node.first.kind === 'leaf') return { paneID: node.first.paneID, paneIsFirst: true };
    if (node.second.kind === 'leaf') return { paneID: node.second.paneID, paneIsFirst: false };
    return null;
}

/**
 * 1:1 tracking (pane-layout.md §7.4 port note): the ratio is always
 * `(firstSizeAtDragStart + cumulativeDelta) / available`, never re-derived from the
 * re-rendered divider — that compounding bug is what made the Swift divider outrun the
 * cursor. Clamped, so the caller can feed it straight into a preview.
 */
export function ratioForDividerDrag(
    snapshot: DividerDragSnapshot,
    origin: Point,
    point: Point
): number {
    const translation: Point = { x: point.x - origin.x, y: point.y - origin.y };
    const delta = dividerDragDelta(snapshot.direction, translation);
    return clampRatio(ratioFromDividerDrag(snapshot, delta));
}

/** Has the gesture moved far enough along the split axis to count as a drag (§7.4)? */
export function dividerDragActivated(
    direction: SplitDirection,
    origin: Point,
    point: Point,
    minimum: number = DIVIDER_MIN_DRAG_DISTANCE
): boolean {
    const translation: Point = { x: point.x - origin.x, y: point.y - origin.y };
    return Math.abs(dividerDragDelta(direction, translation)) >= minimum;
}

/** Bundle a resolved ratio with the wire-addressable pane, if there is one. */
export function dividerCommit(
    layout: PaneLayout,
    snapshot: DividerDragSnapshot,
    ratio: number
): DividerRatioCommit {
    const target = dividerPaneTarget(layout, snapshot.splitPath);
    return {
        splitPath: snapshot.splitPath,
        ratio,
        direction: snapshot.direction,
        paneID: target?.paneID ?? null,
        share: target === null ? ratio : shareForRatio(ratio, target.paneIsFirst)
    };
}

/** The root split path, re-exported so callers don't need a second import for `"d"`. */
export const ROOT_DIVIDER_PATH = ROOT_SPLIT_PATH;

// ── commit throttling ───────────────────────────────────────────────────────────────

export interface Throttled<Args extends readonly unknown[]> {
    (...args: Args): void;
    /** Fire the newest suppressed call immediately (drag end). */
    flush(): void;
    /** Drop the newest suppressed call (drag cancel / unmount). */
    cancel(): void;
}

/**
 * Leading-edge throttle with a trailing call: a divider drag emits a pointermove per frame,
 * and every one of those would otherwise be a socket round-trip. The first move commits
 * straight away (the daemon starts moving immediately) and later moves coalesce into one
 * call per interval, with the LAST position always winning — a dropped final frame would
 * leave the daemon's ratio disagreeing with what the user sees.
 */
export function throttleTrailing<Args extends readonly unknown[]>(
    fn: (...args: Args) => void,
    intervalMs: number
): Throttled<Args> {
    let lastRun = Number.NEGATIVE_INFINITY;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: Args | null = null;

    const run = (args: Args): void => {
        lastRun = Date.now();
        fn(...args);
    };

    const clearTimer = (): void => {
        if (timer === null) return;
        clearTimeout(timer);
        timer = null;
    };

    const throttled = ((...args: Args): void => {
        const remaining = intervalMs - (Date.now() - lastRun);
        if (remaining <= 0) {
            clearTimer();
            pending = null;
            run(args);
            return;
        }
        pending = args;
        if (timer !== null) return;
        timer = setTimeout(() => {
            timer = null;
            const queued = pending;
            pending = null;
            if (queued !== null) run(queued);
        }, remaining);
    }) as Throttled<Args>;

    throttled.flush = (): void => {
        clearTimer();
        const queued = pending;
        pending = null;
        if (queued !== null) run(queued);
    };

    throttled.cancel = (): void => {
        clearTimer();
        pending = null;
    };

    return throttled;
}
