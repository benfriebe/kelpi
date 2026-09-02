/**
 * Moving a pane's live view between the off-screen holder and the shell window.
 *
 * The host builds every tab as a `WebContentsView` parented to a holder window that is never
 * shown (`./tab.ts`) — that is what makes the automation surface work with no UI at all. This
 * module is the other half: when the client running *inside this shell's window* reports where
 * it drew a web pane's page area, the pane's ACTIVE view is re-parented into that window at
 * those bounds, and returned to the holder the moment it is hidden, replaced, or the window
 * goes away.
 *
 * The invariants it exists to keep:
 *
 *   - **At most one view per pane is in the window.** A tab switch moves the new active view in
 *     and the old one back, or the previous tab would keep painting over the new one.
 *   - **Every embedded view is accounted for.** A view that is destroyed while embedded is
 *     forgotten without touching it (`forget`), and a window that closes releases everything —
 *     otherwise the next placement would `removeChildView` on a dead window.
 *   - **Geometry that is not ours does nothing.** `ownWindow` (the daemon's tag) plus a direct
 *     comparison against this shell's own window id: a browser client reporting rects must not
 *     be able to move a desktop user's views.
 *   - **No window, no placement.** With the window closed/hidden the pane keeps working exactly
 *     as it did before this module existed, off-screen in the holder.
 *
 * It is generic over the view type and takes its attach/detach/bounds behaviour as hooks, so
 * the bookkeeping is testable without Electron.
 */

import type { PaneGeometry, ViewBounds, WindowMetrics } from './geometry.js';
import { sameBounds, viewBounds } from './geometry.js';

export interface EmbedHooks<V> {
    /** Re-parent the view into the shell window (idempotent from the caller's side). */
    attach(view: V, bounds: ViewBounds): void;
    /** Put it back in the off-screen holder. */
    detach(view: V): void;
    /** Position an already-attached view. */
    setBounds(view: V, bounds: ViewBounds): void;
}

export interface EmbedOptions<V> {
    /** The pane's active view (or the named tab's), or null when it is not built yet. */
    readonly resolveView: (paneID: string, tabID: string | null) => V | null;
    /** The shell window to embed into; null when there is none to embed into right now. */
    readonly metrics: () => WindowMetrics | null;
    readonly hooks: EmbedHooks<V>;
    /** This shell window's id — geometry from any other window is ignored. */
    readonly windowID?: string | undefined;
    /** Diagnostics: called on every state change (the live smoke asserts on these lines). */
    readonly onChange?: ((event: EmbedEvent) => void) | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
}

export type EmbedOutcome =
    /** The view is in the window at these bounds. */
    | 'placed'
    /** It moved (or stayed) back in the holder. */
    | 'released'
    /** Not ours, or nothing to do. */
    | 'ignored';

export interface EmbedEvent {
    readonly paneID: string;
    readonly outcome: EmbedOutcome;
    readonly bounds: ViewBounds | null;
    readonly reason: string;
}

export interface EmbedController<V> {
    /** Apply one `pane-geometry` notification. */
    apply(geometry: PaneGeometry): EmbedOutcome;
    /** Return a pane's view to the holder (pane closed, hidden, window gone). */
    release(paneID: string, reason?: string): boolean;
    releaseAll(reason?: string): void;
    /** A view is being destroyed: drop it from the books without touching it. */
    forget(view: V): boolean;
    /** Re-apply the last geometry for every embedded pane (the view set changed). */
    refresh(): void;
    readonly embeddedPaneIDs: readonly string[];
    /**
     * Where a pane's view actually IS: the rounded, clamped DIP box the shell placed it at, plus
     * the client report that produced it. Issue #12's poster hangs off the pair — a still frame
     * has to be laid out on the box the view occupied, not on the CSS box the client measured,
     * and only this side knows what the rounding did to it.
     */
    placementOf(paneID: string): { view: V; bounds: ViewBounds; geometry: PaneGeometry } | null;
}

interface Placement<V> {
    view: V;
    bounds: ViewBounds;
    geometry: PaneGeometry;
}

export function createEmbedController<V>(options: EmbedOptions<V>): EmbedController<V> {
    const placed = new Map<string, Placement<V>>();

    const report = (error: unknown, context: string): void => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)), context);
    };

    const announce = (paneID: string, outcome: EmbedOutcome, bounds: ViewBounds | null, reason: string): void => {
        options.onChange?.({ paneID, outcome, bounds, reason });
    };

    const detach = (paneID: string, placement: Placement<V>): void => {
        placed.delete(paneID);
        try {
            options.hooks.detach(placement.view);
        } catch (error) {
            report(error, `embed-detach ${paneID}`);
        }
    };

    const release = (paneID: string, reason = 'released'): boolean => {
        const placement = placed.get(paneID);
        if (placement === undefined) return false;
        detach(paneID, placement);
        announce(paneID, 'released', null, reason);
        return true;
    };

    const place = (geometry: PaneGeometry, metrics: WindowMetrics): EmbedOutcome => {
        const bounds = viewBounds(geometry, metrics);
        if (bounds === null) {
            // Hidden, zero-sized, or scrolled entirely out of the window: the holder is where
            // a view with nowhere to be belongs.
            release(geometry.paneID, geometry.visible ? 'off-screen' : 'hidden');
            return 'released';
        }
        const view = options.resolveView(geometry.paneID, geometry.tabID);
        if (view === null) {
            // The host has not built (or has already dropped) that tab's view. Keep whatever is
            // currently placed: the daemon's `tab-open` / `pane-open` notify is on its way, and
            // `refresh()` re-applies this geometry once it lands.
            return 'ignored';
        }

        const current = placed.get(geometry.paneID);
        if (current !== undefined && current.view !== view) {
            // A tab switch: the outgoing view must leave the window, or it keeps painting on
            // top of the one that just became active.
            detach(geometry.paneID, current);
        }
        const attached = placed.get(geometry.paneID);
        try {
            if (attached === undefined) options.hooks.attach(view, bounds);
            else if (!sameBounds(attached.bounds, bounds)) options.hooks.setBounds(view, bounds);
        } catch (error) {
            report(error, `embed-place ${geometry.paneID}`);
            return 'ignored';
        }
        const changed = attached === undefined || !sameBounds(attached.bounds, bounds);
        placed.set(geometry.paneID, { view, bounds, geometry });
        if (changed) announce(geometry.paneID, 'placed', bounds, attached === undefined ? 'attached' : 'moved');
        return 'placed';
    };

    return {
        apply(geometry) {
            // Two gates, deliberately both: the daemon's tag (it knows which host declared which
            // window) and our own id check (a daemon bug must not become a hijacked view).
            if (!geometry.ownWindow) return 'ignored';
            if (
                options.windowID !== undefined &&
                geometry.shellWindowID !== null &&
                geometry.shellWindowID !== options.windowID
            ) {
                return 'ignored';
            }
            const metrics = options.metrics();
            if (metrics === null) {
                // No window to embed into (closed, hidden, not built yet).
                release(geometry.paneID, 'no-window');
                return 'released';
            }
            return place(geometry, metrics);
        },

        release,

        releaseAll(reason = 'release-all') {
            for (const paneID of [...placed.keys()]) release(paneID, reason);
        },

        forget(view) {
            for (const [paneID, placement] of placed) {
                if (placement.view !== view) continue;
                // No hook call: the view is being destroyed, and `removeChildView` on a
                // destroyed view is exactly the throw this exists to avoid.
                placed.delete(paneID);
                announce(paneID, 'released', null, 'view-destroyed');
                return true;
            }
            return false;
        },

        refresh() {
            const metrics = options.metrics();
            for (const [paneID, placement] of [...placed]) {
                if (metrics === null) {
                    release(paneID, 'no-window');
                    continue;
                }
                place(placement.geometry, metrics);
            }
        },

        get embeddedPaneIDs() {
            return [...placed.keys()];
        },

        placementOf(paneID) {
            const placement = placed.get(paneID);
            return placement === undefined
                ? null
                : { view: placement.view, bounds: placement.bounds, geometry: placement.geometry };
        }
    };
}
