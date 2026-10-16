/**
 * Issue #351 - a page asked for the keyboard while its view was parked.
 *
 * Closing a modal hands the keyboard back to the focused pane (§10.4), and for a web pane that is
 * the client's `focus-view` (`App.tsx` ▸ `handBackPaneCaret`). The hand-back runs in the close
 * handler, before React unmounts the modal and drops its modal presence, so while it is on the
 * wire every web view is still parked in the off-screen holder (`client/src/chrome/modal-presence.ts`).
 * `contents.focus()` on a view in the holder does nothing useful, and the next geometry report puts
 * the view back in the window (`./embed.ts` ▸ `place`) without touching focus. The page came back
 * without the keyboard: typing reached nothing until the page was clicked. Measured on a9a87df,
 * page target `document.hasFocus()`: the palette closed with ⌘W, Settings, Help and the ⌃Tab
 * switcher's never-mind all failed; only the palette's Escape passed, because its presenter hands
 * back 200 ms later, after the view is placed.
 *
 * So a `focus-view` that reaches a parked view is remembered here, and honoured by the placement
 * that puts that view back (`./index.ts` ▸ the attach hook). One slot for the whole host, because
 * the keyboard is one thing: the last request wins, and every other way the keyboard is spoken for
 * clears it.
 *
 * ## What clears a claim
 *
 *   - the claimed pane is placed showing ANOTHER tab (a tab switch while parked): dropped, or the
 *     old tab would take the keyboard whenever it is shown again;
 *   - any other tab's `focus-view` that runs, deferred or not (last request wins);
 *   - `blur-view`: the client took the keyboard back for itself (its ring left the web panes);
 *   - a user's press into any page (§N29): the person chose a widget;
 *   - the claimed tab being destroyed.
 *
 * No timer. §N29 and §N30 removed every focus timer this module family had, because a window in
 * which a real gesture could be swallowed is worse than the bug it bounds. Every clear above is an
 * event. The one residual is a pane that stays hidden (its workspace went away) after its claim:
 * it keeps the claim until one of those events, and the client's ring leaving the pane sends
 * `blur-view` in the ordinary case.
 *
 * ## Never at the cost of an app activation
 *
 * `contents.focus()` activates the app on macOS (`./view-focus.ts` ▸ `viewKeyboardRoute`). A claim
 * is consumed by a placement nobody connected to the request, possibly long after it (a window
 * shown again by the #75 reconciler), so it is honoured only where the window already has the
 * keyboard, or where the window can never be key (a test lane, which focuses over CDP and cannot
 * activate anything). Otherwise it is dropped and says so. The modal-close case always has a
 * focused window.
 */

export interface DeferredFocusClaim {
    readonly paneID: string;
    readonly tabID: string;
}

/** What the window can do with a keyboard right now. */
export interface KeyboardWindowState {
    /** False for a test lane window (`../audit-window.ts`), which may never become key. */
    readonly windowMayBeKey: boolean;
    /** Is this window the one being typed into? */
    readonly windowIsFocused: boolean;
}

export type PlacedOutcome =
    /** Nothing was waiting for this pane. */
    | 'none'
    /** The claim was for this tab: give its page the keyboard now. */
    | 'focus'
    /** The pane came back showing another tab; the claim is gone. */
    | 'dropped-other-tab'
    /** The window does not have the keyboard, and taking it would activate the app. */
    | 'dropped-window-inactive';

export interface DeferredFocus {
    /**
     * A `focus-view` reached a parked view. Replaces any earlier claim and returns true, or
     * returns false (and leaves any earlier claim alone) for a tab that is not its pane's active
     * one: a pane is only ever placed showing its active tab, so that claim could never be
     * honoured, and answering "deferred" would promise a hand-back that cannot happen.
     */
    defer(claim: DeferredFocusClaim): boolean;
    /**
     * A view of `paneID` was just put in the window. Consumes the claim when it is for this pane,
     * whatever the outcome; a placement of any other pane leaves it alone.
     */
    placed(paneID: string, tabID: string, window: KeyboardWindowState): PlacedOutcome;
    /** Something else spoke for the keyboard. Returns the claim it dropped, if any. */
    cancel(): DeferredFocusClaim | null;
    /** A tab is being destroyed: drop its claim, and only its claim. */
    forgetTab(paneID: string, tabID: string): DeferredFocusClaim | null;
    /** The claim waiting right now, for logs and tests. */
    readonly pending: DeferredFocusClaim | null;
}

export interface DeferredFocusOptions {
    /** Is this tab the one its pane shows? Absent means every tab is (a single-tab host). */
    readonly isActiveTab?: ((paneID: string, tabID: string) => boolean) | undefined;
}

export function createDeferredFocus(options: DeferredFocusOptions = {}): DeferredFocus {
    let pending: DeferredFocusClaim | null = null;

    const take = (): DeferredFocusClaim | null => {
        const claim = pending;
        pending = null;
        return claim;
    };

    return {
        defer(claim) {
            if (options.isActiveTab !== undefined && !options.isActiveTab(claim.paneID, claim.tabID)) return false;
            pending = { paneID: claim.paneID, tabID: claim.tabID };
            return true;
        },

        placed(paneID, tabID, window) {
            if (pending === null || pending.paneID !== paneID) return 'none';
            const claim = take();
            if (claim === null || claim.tabID !== tabID) return 'dropped-other-tab';
            if (window.windowMayBeKey && !window.windowIsFocused) return 'dropped-window-inactive';
            return 'focus';
        },

        cancel: take,

        forgetTab(paneID, tabID) {
            if (pending === null || pending.paneID !== paneID || pending.tabID !== tabID) return null;
            return take();
        },

        get pending() {
            return pending;
        }
    };
}
