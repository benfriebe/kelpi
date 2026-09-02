/**
 * When a web pane's page is laid out at the AUTOMATION viewport - the rule, kept pure so it can
 * be tested without Electron (`./tab.ts` applies it).
 *
 * A tab has two homes and they want opposite layouts. In the shell window the pane's rect is the
 * viewport: the page lays out at the widget's real size and the display's real scale, which is
 * what the person is looking at. In the off-screen holder the tab is an automation surface, and
 * web-pane.md §8.4 specifies `capture`, element rects and `wait` against one fixed viewport - * `DEFAULT_VIEWPORT`, 1280×800 @1×, pinned with `Emulation.setDeviceMetricsOverride` - so they
 * answer the same on every machine whatever the holder window happens to be.
 *
 * The first cut pinned the moment a view went back to the holder, and that is the defect this
 * module exists to name. Most parks are TRANSIENT - a context menu over the pane, a popover, a
 * tab the user will switch back to in a second - and a pin is a reflow: the page lays out at
 * 1280 px, a page wider than the pane loses its sideways scroll (nothing overflows at 1280 px),
 * media queries flip to their desktop branch, resize handlers run, desktop-only content mounts.
 * Coming back it reflows again and comes back scrolled somewhere else, because Chromium's scroll
 * anchoring restores the vertical axis and not the horizontal one. Measured on the tree that
 * shipped issue #12's poster: a 1200 px page in a 525 px pane, scrolled to x=300, came back from
 * a header menu at x=0 - the whole page 300 px to the right of the still frame that had just
 * shown it where it was. That is the sideways jump the owner reported on closing the menu; the
 * poster did not cause it, it made a reflow that had always happened visible.
 *
 * So the pin is LAZY:
 *
 *   - **A park changes nothing.** The view keeps the size and the layout it had on screen, and
 *     a view nobody reads while it is parked comes back exactly as it left.
 *   - **A placement clears the pin**, if an automation read left one - otherwise the hole shows
 *     the clipped top-left corner of a 1280 px page at 1× (run-B L2).
 *   - **An automation read on a parked view pins first.** `capture`, the actuator and `exec`
 *     still answer against 1280×800 @1× exactly as §8.4 says; only the moment the pin is
 *     applied has moved, from "when the view leaves the screen" to "when something needs it".
 *     A read on a view that is ON screen pins nothing: the pane's rect is its viewport, which
 *     is what those verbs already answered against for an embedded pane.
 *
 * What is given up is the guarantee that a parked view is ALREADY at the automation viewport
 * when a read arrives: that read pays one `setDeviceMetricsOverride` round trip and a layout
 * first. A fresh tab is still pinned at birth (`bootstrap`), so an agent-driven pane that is
 * never placed never pays it.
 */

export interface ViewportPinState {
    /** The view is in the shell window at the pane's rect. */
    readonly embedded: boolean;
    /** The emulated 1280×800 @1× metrics are in effect on the page. */
    readonly pinned: boolean;
}

export type ViewportPinEvent =
    /** The view was placed in the shell window (`HostTab.setEmbedded(true)`). */
    | 'placed'
    /** The view went back to the holder (`setEmbedded(false)`). */
    | 'parked'
    /** An automation read is about to run on the view (`HostTab.pinViewport`). */
    | 'automation-read';

export type ViewportPinAction = 'pin' | 'unpin' | 'keep';

/**
 * What to do to the page's viewport for `event`, given where the view is and what is on it.
 *
 * Decided against the state at the moment the transition RUNS rather than when it was asked
 * for: the transitions are CDP round trips that `./tab.ts` serialises, so a read queued behind
 * a placement must see that the view is now on screen and pin nothing.
 */
export function viewportPinAction(state: ViewportPinState, event: ViewportPinEvent): ViewportPinAction {
    switch (event) {
        case 'placed':
            return state.pinned ? 'unpin' : 'keep';
        case 'parked':
            return 'keep';
        case 'automation-read':
            return state.embedded || state.pinned ? 'keep' : 'pin';
    }
}
