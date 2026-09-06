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
 *   - **Whoever parked a view is the one who un-parks it** (issue #75). Two kinds of park reach
 *     this module and they are NOT the same fact:
 *
 *       `release()`  the CLIENT is not drawing that pane any more (hidden, workspace switched,
 *                    tab closed, pane closed). The books forget it, and only a new report from
 *                    the client can bring it back. That restriction is #34's safety argument:
 *                    a pane parked on purpose must never be re-placed by anything but its owner.
 *
 *       `park()`     THIS SHELL took the view off screen for a reason the client cannot see: the
 *                    user hid or minimised the window, or the window momentarily had no metrics
 *                    to place into. The placement is KEPT with `parked: true`, and `refresh()`
 *                    puts it back. Before #75 this went through `release()` too, so hiding the
 *                    window (⌘H, ⌘M, the global hotkey's second press) left every web pane an
 *                    empty hole with its chrome still drawn round it, for ever: the client's
 *                    reporter dedupes an identical re-render, so nothing on the wire ever
 *                    contradicted the state.
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
    /**
     * Return a pane's view to the holder and FORGET the placement: the client is no longer
     * drawing that pane, so only a new report of its own may put it back.
     */
    release(paneID: string, reason?: string): boolean;
    releaseAll(reason?: string): void;
    /**
     * Return a pane's view to the holder and REMEMBER where it was (#75): a park this shell
     * performed for a reason the client cannot see, undone by `refresh()`.
     */
    park(paneID: string, reason?: string): boolean;
    parkAll(reason?: string): void;
    /** A view is being destroyed: drop it from the books without touching it. */
    forget(view: V): boolean;
    /** The pane itself is gone: release it and forget the rect it used to be reported at. */
    forgetPane(paneID: string, reason?: string): void;
    /**
     * Re-apply the last geometry for every pane in the books, parked ones included (the view set
     * changed, or the window came back). A parked placement that can be honoured is placed again
     * and stops being parked; one that still cannot be (no window yet) stays parked.
     */
    refresh(): void;
    /**
     * Re-apply the last geometry this pane was given, even though it is no longer placed.
     *
     * `refresh()` walks the PLACED panes, so it cannot help a pane whose only view was just
     * destroyed: `forget` deleted the placement, and the pane is now a stranger. That is the
     * state a dead renderer leaves behind (issue #76), and it is why a rebuilt view used to sit
     * in the holder with the client seeing no reason to re-state a rect that never changed.
     *
     * The remembered report is the last one this controller ACCEPTED, hidden reports included,
     * which is what makes replaying it safe: a pane parked because its workspace went away
     * remembers `visible:false` and re-applying it releases again rather than putting a page on
     * a screen the user is not looking at.
     *
     * Returns true when a remembered report was re-applied and the pane ended up placed.
     */
    reapply(paneID: string): boolean;
    /** Panes whose view is in the window right now. */
    readonly embeddedPaneIDs: readonly string[];
    /** Panes this shell parked and still owes a placement to (#75). */
    readonly parkedPaneIDs: readonly string[];
    /**
     * Where a pane's view actually IS: the rounded, clamped DIP box the shell placed it at, plus
     * the client report that produced it. Issue #12's poster hangs off the pair — a still frame
     * has to be laid out on the box the view occupied, not on the CSS box the client measured,
     * and only this side knows what the rounding did to it.
     */
    placementOf(paneID: string): {
        view: V;
        bounds: ViewBounds;
        geometry: PaneGeometry;
        scaleFactor: number;
    } | null;
}

interface Placement<V> {
    view: V;
    bounds: ViewBounds;
    geometry: PaneGeometry;
    /**
     * The display scale the bounds were computed under.
     *
     * Kept because the two halves of the CSS↔DIP conversion come from different moments: the
     * client's `devicePixelRatio` is whatever it last REPORTED, and the window's `scaleFactor` is
     * read live. Drag a window between a 2× and a 1× display while a menu is open and mixing the
     * two produces a factor that was never true, so the poster's box is checked against this and
     * withheld when it no longer holds (issue #12).
     */
    scaleFactor: number;
    /**
     * True while the view is in the holder because THIS SHELL put it there (#75), with the
     * placement kept so `refresh()` can undo it. False means the view is in the window.
     *
     * There is deliberately no third state for "the client parked it": that placement is not in
     * the map at all, which is what makes it impossible for a restore to resurrect it.
     */
    parked: boolean;
}

export function createEmbedController<V>(options: EmbedOptions<V>): EmbedController<V> {
    const placed = new Map<string, Placement<V>>();
    /**
     * The last report this controller accepted for each pane, placed or not (issue #76).
     *
     * Separate from `placed` on purpose: `placed` is "where a view IS" and is emptied by every
     * park, every close and every `forget`, while this is "where the client last said the hole
     * is" and survives all three. Only `reapply` reads it, and only for a pane the host is
     * rebuilding a view for.
     */
    const reported = new Map<string, PaneGeometry>();

    const report = (error: unknown, context: string): void => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)), context);
    };

    const announce = (paneID: string, outcome: EmbedOutcome, bounds: ViewBounds | null, reason: string): void => {
        options.onChange?.({ paneID, outcome, bounds, reason });
    };

    /** The hook, on a view that IS in the window. Never called for an already-parked placement. */
    const detachView = (paneID: string, placement: Placement<V>): void => {
        try {
            options.hooks.detach(placement.view);
        } catch (error) {
            report(error, `embed-detach ${paneID}`);
        }
    };

    const release = (paneID: string, reason = 'released'): boolean => {
        const placement = placed.get(paneID);
        if (placement === undefined) return false;
        placed.delete(paneID);
        if (placement.parked) {
            // Already in the holder: the view must not be detached twice, but the CLAIM has
            // changed (a park this shell owed a placement to is now a park the client asked
            // for), and the log line is the only place that is visible from outside.
            announce(paneID, 'released', null, reason);
            return true;
        }
        detachView(paneID, placement);
        announce(paneID, 'released', null, reason);
        return true;
    };

    /** #75: the same detach, with the placement kept so `refresh()` can undo it. */
    const park = (paneID: string, reason = 'parked'): boolean => {
        const placement = placed.get(paneID);
        if (placement === undefined || placement.parked) return false;
        placement.parked = true;
        detachView(paneID, placement);
        announce(paneID, 'released', null, reason);
        return true;
    };

    const place = (geometry: PaneGeometry, metrics: WindowMetrics): EmbedOutcome => {
        const bounds = viewBounds(geometry, metrics);
        if (bounds === null) {
            /*
             * Nowhere to put it. Which of the two parks this is depends on WHO made it true:
             *
             *   - `visible:false` is the client saying it is not drawing the pane. Forget it,
             *     or a later restore would put a deliberately hidden page back on screen (#34).
             *   - a window with no content area at all is not the client's doing (#75's second
             *     route: a display reconfiguration hands the window a 0x0 box for an instant).
             *     Remember it, or the pane stays an empty hole until its rect changes for some
             *     unrelated reason.
             *   - anything else is a pane scrolled or dragged out of the window while the client
             *     still believes it is placed. Forget it: the scroll that brings it back reports
             *     a different rect, so the client's own dedupe cannot swallow the recovery.
             */
            if (!geometry.visible) release(geometry.paneID, 'hidden');
            else if (metrics.contentWidth < 1 || metrics.contentHeight < 1) park(geometry.paneID, 'no-content-area');
            else release(geometry.paneID, 'off-screen');
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
            // top of the one that just became active. A parked outgoing view is already in the
            // holder, so only the book entry goes.
            if (!current.parked) detachView(geometry.paneID, current);
            placed.delete(geometry.paneID);
        }
        const attached = placed.get(geometry.paneID);
        // A parked placement is a memory, not a view in the window: it has to be re-attached,
        // not merely moved, or `setBounds` would position a child of the holder.
        const inWindow = attached !== undefined && !attached.parked;
        try {
            if (!inWindow) options.hooks.attach(view, bounds);
            else if (!sameBounds(attached.bounds, bounds)) options.hooks.setBounds(view, bounds);
        } catch (error) {
            report(error, `embed-place ${geometry.paneID}`);
            return 'ignored';
        }
        const changed = !inWindow || !sameBounds(attached.bounds, bounds);
        placed.set(geometry.paneID, { view, bounds, geometry, scaleFactor: metrics.scaleFactor, parked: false });
        if (changed) announce(geometry.paneID, 'placed', bounds, inWindow ? 'moved' : 'attached');
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
            // Past both gates: this report is ours, so it is worth remembering whatever it then
            // does with the view (see `reported` above).
            reported.set(geometry.paneID, geometry);
            const metrics = options.metrics();
            if (metrics === null) {
                /*
                 * No window to embed into: closed, destroyed, or hidden/minimised by the user
                 * (`windowMetrics()` refuses all three). #75: this is a park with memory, not a
                 * forget. A report that lands in the instant the window is not visible used to
                 * delete the placement, and nothing on either side would ever restate it - the
                 * client's reporter dedupes an identical re-render, so the pane stayed an empty
                 * hole. A view REMEMBERED here is put back by `refresh()` when the window comes
                 * back, and dropped for real by `releaseAll` when the window closes.
                 *
                 * A `visible:false` report still forgets: the client parking a pane is the one
                 * park a restore must never undo, whatever the window is doing.
                 */
                if (!geometry.visible) release(geometry.paneID, 'hidden');
                else park(geometry.paneID, 'no-window');
                return 'released';
            }
            return place(geometry, metrics);
        },

        release,

        releaseAll(reason = 'release-all') {
            for (const paneID of [...placed.keys()]) release(paneID, reason);
        },

        park,

        parkAll(reason = 'park-all') {
            for (const paneID of [...placed.keys()]) park(paneID, reason);
        },

        forget(view) {
            for (const [paneID, placement] of placed) {
                if (placement.view !== view) continue;
                // No hook call: the view is being destroyed, and `removeChildView` on a
                // destroyed view is exactly the throw this exists to avoid. A parked entry goes
                // the same way: its view is dying, so the memory of where it sat is worthless.
                placed.delete(paneID);
                announce(paneID, 'released', null, 'view-destroyed');
                return true;
            }
            return false;
        },

        forgetPane(paneID, reason = 'pane-closed') {
            release(paneID, reason);
            reported.delete(paneID);
        },

        refresh() {
            const metrics = options.metrics();
            for (const [paneID, placement] of [...placed]) {
                if (metrics === null) {
                    // Still nowhere to place into. Keep the books rather than emptying them:
                    // this is exactly the state `restoreViews()` is called again for (#75).
                    park(paneID, 'no-window');
                    continue;
                }
                place(placement.geometry, metrics);
            }
        },

        reapply(paneID) {
            if (placed.has(paneID)) return true;
            const geometry = reported.get(paneID);
            if (geometry === undefined) return false;
            const metrics = options.metrics();
            if (metrics === null) return false;
            return place(geometry, metrics) === 'placed';
        },

        get embeddedPaneIDs() {
            return [...placed].filter(([, placement]) => !placement.parked).map(([paneID]) => paneID);
        },

        get parkedPaneIDs() {
            return [...placed].filter(([, placement]) => placement.parked).map(([paneID]) => paneID);
        },

        placementOf(paneID) {
            const placement = placed.get(paneID);
            // A parked placement is a memory of where the view WAS. Issue #12's poster hangs off
            // this, and a picture laid out on the box of a view that is in the holder is exactly
            // the wrong-box bug §3.6 refuses: "where the view actually IS" has to stay true.
            return placement === undefined || placement.parked
                ? null
                : {
                      view: placement.view,
                      bounds: placement.bounds,
                      geometry: placement.geometry,
                      scaleFactor: placement.scaleFactor
                  };
        }
    };
}
