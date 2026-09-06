/**
 * A parked view must not keep the keyboard (issue #33).
 *
 * A web pane's page is a native `WebContentsView`, and on macOS the window's keyboard belongs to
 * a *widget*: `isFocused()` is `RenderWidgetHostViewMac::HasFocus()`, "where a keystroke would
 * actually go" (`./index.ts` ▸ `keyboardOwner`). Parking a view moves it into the off-screen
 * holder window, and nothing in that path ever touched focus - so a view that held the keyboard
 * kept holding it from a window nobody can see. Every subsequent keystroke went to a page that
 * is not on screen: not to the client's dispatcher, and not to this shell's chord relay either,
 * because the relay only ever sees what the FOCUSED view is sent.
 *
 * Two reports, one cause, and both are "it works exactly once":
 *
 *   - ⌘⇧] cycles the tab, the outgoing view is parked still holding the keyboard, and the next
 *     ⌘⇧] reaches nothing. The strip moves once and then stops.
 *   - ⌥⌘↓ switches workspace, the pane hides, its view is parked still holding the keyboard, and
 *     no shortcut works afterwards at all.
 *
 * Neither is new. ⌘⇧[ / ⌘⇧] were in the relay's original twelve, and a workspace switch made
 * with the MOUSE after clicking a page stranded the keyboard the same way. Deriving the set from
 * the binding map only made the second one reachable from the keyboard, which is how it surfaced.
 *
 * ## Two moments, and getting only one of them is the same bug
 *
 * A view stops being on screen at one of two points, and BOTH drop its keyboard focus as a side
 * effect - so the sample has to happen before whichever one is about to run:
 *
 *   - **hidden** (`registry.ts` ▸ the activate loop → `show(view, false)` → `setVisible(false)`).
 *     This is the tab-switch path, and it arrives one notify EARLIER than the park;
 *   - **parked** (`./embed.ts` ▸ `detach`), for everything else: a hidden pane, a workspace
 *     change, a closing window. Nothing hid the view first, so it is still holding the keyboard
 *     when it gets here.
 *
 * The first version of this fix sampled only at the park. For a tab switch that is too late by a
 * whole round trip: hiding had already taken the focus, the census answered "this view does not
 * have the keyboard", the handoff declined, and the keyboard was left with nothing at all.
 * Measured as ⌘⇧] cycling exactly once and then going dead - the same symptom the fix was for,
 * which is why the log showing zero handoffs was the thing that gave it away.
 *
 * ## Why the client, and not the incoming view
 *
 * On a tab switch there IS another view arriving, and a browser would put the keyboard in it.
 * The keyboard goes to the client's renderer instead, for three reasons:
 *
 *   - it is the answer that is always available. A park with no incoming view (hidden pane,
 *     workspace switch, closed window) is the majority case, and one rule for all of them cannot
 *     stray;
 *   - the client is where the chord dispatcher lives, so it is the state in which every binding
 *     works - which is the defect being fixed. Focusing the incoming page would fix the tab
 *     strip and leave the ⌥⌘ arrows broken;
 *   - `attach` runs AFTER `detach` on a switch (`./embed.ts` ▸ `place`), so focusing the incoming
 *     view here would be focusing a view that is still in the holder.
 *
 * The cost is that after ⌘⇧] you click once to type into the new tab's page. §N29 reports that
 * click and the ring never moves, so it costs a click and nothing else.
 *
 * ## Why it is safe
 *
 * `restore` is `window.webContents.focus()`, which `./index.ts` explains at length: it is NOT
 * `focusOnWebView`, and it cannot activate the app. The window-focused guard makes the same
 * structural fact explicit that `restoreKeyboard` relies on - with the window inactive there is
 * no keyboard in this window to move, and every `isFocused()` in the census reads false anyway.
 */

export interface ParkKeyboardInput {
    /** Did the view being parked hold the window's keyboard? Sampled BEFORE it is re-parented. */
    readonly viewHeldKeyboard: boolean;
    /** Is this shell window the one being typed into? */
    readonly windowIsFocused: boolean;
}

export type ParkKeyboardDecision =
    /** Hand the keyboard to the client's renderer. */
    | 'restore-to-client'
    /** Nothing to do: the view did not have it, or this window has no keyboard to move. */
    | 'leave';

export function parkKeyboardDecision(input: ParkKeyboardInput): ParkKeyboardDecision {
    if (!input.viewHeldKeyboard) return 'leave';
    if (!input.windowIsFocused) return 'leave';
    return 'restore-to-client';
}

/**
 * Wrap a registry's `show` hook so a view gives the keyboard up BEFORE it is hidden.
 *
 * A function rather than two lines at the call site, because the thing that has to stay true is
 * the ORDER, and an order is only guarded if something asserts it. Reversing these two lines
 * reproduces the original defect exactly - `setVisible(false)` drops the focus, the sample then
 * reads false, and the keyboard is stranded - and nothing about the code would look wrong.
 */
export function releaseBeforeHide<T>(
    show: (tab: T, visible: boolean) => void,
    release: (tab: T) => void
): (tab: T, visible: boolean) => void {
    return (tab, visible) => {
        if (!visible) release(tab);
        show(tab, visible);
    };
}
