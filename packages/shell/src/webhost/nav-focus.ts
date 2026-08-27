/**
 * §N30 — a navigation must not move the keyboard.
 *
 * A web pane's page is a native `WebContentsView` composited over the client's renderer, so
 * "who has the keyboard" is a fact about a *widget*, not about anything in the client's DOM.
 * When a navigation commits in an embedded view, Chromium can focus the newly committed widget:
 * the user typing in a terminal stops typing anywhere they can see, the ring stays where it was,
 * and nothing on screen says so. That is the §N19/§N20 ring/caret divergence, arriving by a
 * route neither of those rows could see.
 *
 * **Swift has no equivalent, and the reason is the whole specification of this module.** A
 * `WKWebView` loading a page does not become first responder, so `nex web navigate` there leaves
 * the caret exactly where the user put it — in a terminal, in the URL bar, or in the page if
 * that is where it was. So the rule is not "decide who should have the keyboard after a
 * navigation"; it is **preserve**: a commit hands the keyboard back to whoever held it when the
 * navigation started, and does nothing at all when that was already this view.
 *
 * ## Why preserve rather than "is this pane focused?"
 *
 * The obvious alternative — push the client's focused-pane fact into the shell and re-focus the
 * client whenever a commit lands in a pane that is not focused — needs a new wire fact, and it
 * gets the URL-bar case wrong: a web pane can be the focused pane while the caret is in the
 * client's own address field (WEB-043's chrome-text exemption), and "focused pane ⇒ leave the
 * keyboard in the page" would eat that caret. Preserving the pre-navigation owner reproduces
 * both cases with one rule and no new state on the wire.
 *
 * ## The three things that make it safe
 *
 *   - **The snapshot is taken at `did-start-navigation`**, before the commit that moves focus,
 *     so it records the owner as they were *before* the navigation — the only moment where the
 *     answer is not already contaminated by the steal.
 *   - **A deliberate claim cancels it.** If the client asks for the page to take the keyboard
 *     (WEB-043's `focus-view`) or the user presses into the page (§N29's gesture) while a load
 *     is in flight, the page is legitimately focused and the commit must leave it alone.
 *     Without this, `nex web open` — which creates a pane, focuses it, and loads a URL, all
 *     racing each other — would have its handoff undone by its own load.
 *   - **Parked views are ignored.** A view in the off-screen holder is on nobody's screen and
 *     cannot hold the window's keyboard; there is nothing to hand back.
 *
 * There is no timer anywhere in here (§N29's rule, kept): every decision is made from facts that
 * are true at the instant it is made, so no window of time can swallow or invent a handoff.
 *
 * ## The one residual, stated rather than hidden
 *
 * The snapshot is taken when the navigation starts and spent when it commits, and in between the
 * keyboard can move for reasons this tab never hears about. Concretely: the user is typing in a
 * terminal, an agent navigates pane Y, and while Y is loading the user clicks into a DIFFERENT
 * web pane's page. Y's commit then takes the keyboard from that page, and this guard hands it
 * back to the client rather than to the page the user just clicked — the two claims that DO
 * reach this tab (`focus-view` for itself, its own §N29 gesture) cannot see a press that landed
 * somewhere else. It is a sub-second window, and the outcome is strictly better than the
 * unfixed behaviour (where the keyboard ends up in the navigated page, which nobody asked for);
 * closing it entirely would mean every tab telling every other tab where the keyboard went, and
 * that cross-tab coupling costs more than the residual does.
 */

/** Who holds the keyboard inside the shell window right now. */
export type KeyboardOwner =
    /** The client's own renderer — the document that draws the panes. */
    | { readonly kind: 'client' }
    /** Another web pane's page (or this one's): a native view, addressed by its tab id. */
    | { readonly kind: 'view'; readonly tabID: string }
    /** Nobody in this window (no window, or the app is not the one being typed into). */
    | { readonly kind: 'none' };

export function describeKeyboardOwner(owner: KeyboardOwner): string {
    return owner.kind === 'view' ? `view:${owner.tabID}` : owner.kind;
}

export interface NavFocusGuardOptions {
    /** The tab this guard belongs to: an owner naming it is "the page already had it". */
    readonly tabID: string;
}

export interface NavFocusGuard {
    /**
     * A main-frame navigation started in this tab. `owner` is who holds the keyboard *now*,
     * which is before the commit and therefore before any steal.
     */
    navigationStarted(owner: KeyboardOwner): void;
    /**
     * The page was deliberately given the keyboard (the client's WEB-043 handoff, or §N29's
     * user gesture). Any pending snapshot is void: the page is meant to have it.
     */
    pageClaimedKeyboard(): void;
    /**
     * A main-frame navigation committed. Returns the owner to hand the keyboard back to, or
     * null when there is nothing to do (nobody was displaced, the view is parked, the page
     * already had the keyboard, or a claim intervened).
     */
    navigationCommitted(context: { readonly viewHasKeyboard: boolean; readonly embedded: boolean }): KeyboardOwner | null;
    /** The tab is going away. */
    dispose(): void;
}

export function createNavFocusGuard(options: NavFocusGuardOptions): NavFocusGuard {
    /** Who had the keyboard when the in-flight navigation started; null = no snapshot. */
    let displaced: KeyboardOwner | null = null;
    let disposed = false;

    const isThisView = (owner: KeyboardOwner): boolean =>
        owner.kind === 'view' && owner.tabID === options.tabID;

    return {
        navigationStarted(owner: KeyboardOwner): void {
            if (disposed) return;
            // A navigation started while the page already had the keyboard is a page the user is
            // in: nothing to restore, and remembering it would only risk restoring it to itself.
            displaced = isThisView(owner) ? null : owner;
        },

        pageClaimedKeyboard(): void {
            if (disposed) return;
            displaced = null;
        },

        navigationCommitted(context: { viewHasKeyboard: boolean; embedded: boolean }): KeyboardOwner | null {
            if (disposed) return null;
            const owner = displaced;
            // One commit consumes one snapshot: a redirect chain re-arms it from its own
            // `did-start-navigation`, and a commit with nothing pending decides nothing.
            displaced = null;
            if (owner === null) return null;
            // A parked view cannot have taken the window's keyboard, so nothing was displaced.
            if (!context.embedded) return null;
            // The commit did NOT take the keyboard (the common case on same-process loads):
            // there is nothing to hand back, and handing it back anyway would move focus that
            // this navigation never touched.
            if (!context.viewHasKeyboard) return null;
            // Nobody held it — the app is not the one being typed into. Taking focus off the
            // page would mean choosing a new owner, which is a decision this module refuses to
            // make; the window's own first responder is left as Chromium set it.
            if (owner.kind === 'none') return null;
            return owner;
        },

        dispose(): void {
            disposed = true;
            displaced = null;
        }
    };
}
