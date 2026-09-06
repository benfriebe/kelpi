/**
 * The client's gesture escape hatch (issue #79, shell-ui.md §4.4 / §WS-002).
 *
 * A pointer gesture in this app is a pair of `window` listeners plus a ref holding the state
 * the gesture started from: the sidebar's resize handle (`SidebarResizer.tsx`) and the pane
 * grid's divider drag (`PaneGrid.tsx`) are both that shape. The shape has one failure mode and
 * it is the one the issue reports: if the `pointerup` never arrives, nothing ends the gesture.
 * The sidebar then tracks the BARE cursor for the rest of the session, re-entering a full grid
 * resize on every mouse move, and the app never settles again ("have to restart").
 *
 * A pointer-up can genuinely go missing here, which is why `pointercancel` alone is not enough:
 *
 *   - the pointer is released over a native `WebContentsView` (a web pane). The view is a
 *     sibling layer the renderer never sees events from, so the release lands in a different
 *     web contents and the renderer's window gets no `pointerup` at all.
 *   - the user switches Space or hides the app mid-drag (the window loses the pointer, and on
 *     macOS the release goes wherever the pointer now is).
 *   - the element that owns the gesture unmounts mid-drag. `App.tsx` stops rendering
 *     `SidebarResizer` the moment the sidebar starts closing, so ⇧⌘S during a drag removes
 *     the component while its window listeners are still installed.
 *
 * So gestures register a reset here, and this module fires every one of them on the two events
 * that mean "the pointer is no longer ours": `window` losing focus, and the document becoming
 * hidden. `resetGestures` is also exported on its own, because the shell's recovery chord
 * (shell-ui.md §"Recovering a stuck window") needs to run exactly this from the outside.
 *
 * ## The one blur that means nothing of the sort
 *
 * "The window lost focus" is not the same statement as "the keyboard left this document", and in
 * a window that hosts native `WebContentsView` siblings the two come apart. Focusing a WEB pane
 * makes the client send `web-focus-view` (`webpane/WebPane.tsx`'s claim effect), the shell
 * answers it with `contents.focus()` on that pane's view (`shell/webhost/index.ts`), and Blink
 * takes page focus off the client's renderer: a `blur` on this `window`, with the pointer still
 * held, the gesture still ours, and the app still the one the user is looking at.
 *
 * That is not hypothetical. Pressing a web pane's HEADER both arms the pane-move gesture and
 * focuses the pane, so the claim's blur landed about two milliseconds after the `pointerdown`
 * and cancelled the move before it had crossed the drag threshold. A web pane could not be
 * dragged onto another one at all: no drop highlight was ever published, so nothing parked the
 * target's view and nothing was ever dropped.
 *
 * {@link expectOwnFocusHandoff} is the seam. The client is the only party that can tell its own
 * handoff from the user's, because it is the one asking for it, and it asks through exactly one
 * door (`webpane/commands.ts` ▸ `focusView`). A blur it has predicted ends no gesture; every
 * other blur still ends all of them. A release landing IN a page never comes through here: that
 * focus change is the shell's own answer to a click (`shell/webhost/view-focus.ts` §N29), so
 * the case this module was written for is untouched.
 *
 * A reset is not a cancel: each gesture decides what ending early means. Both of today's
 * callers COMMIT what the user has already dragged to, because a gesture that vanishes should
 * leave the divider (or the sidebar edge) where the user last saw it, not snap it back.
 *
 * Listeners are installed on the first registration and removed when the last one goes, so a
 * jsdom test that renders nothing leaves no global state behind.
 */

export type GestureReset = (reason: GestureResetReason) => void;

/** Why the reset ran. Gestures may log it; none of them branch on it today. */
export type GestureResetReason = 'blur' | 'hidden' | 'manual';

const resets = new Set<GestureReset>();
let installed = false;

/**
 * How long a predicted blur stays predicted.
 *
 * The wait is a round trip (client → daemon → shell → `contents.focus()` → Blink's `blur` back
 * into this document), which `scripts/ui-audit/audit.mjs`'s `web-popup-layering` step measured
 * at one to two milliseconds. This is that with room for a machine under load, and it is still
 * far too short to hold a state in: leaving the app inside the same few frames as focusing a web
 * pane is not a gesture a person can make, and the cost if one somehow did is the pre-#79
 * behaviour for a single blur.
 */
const OWN_FOCUS_HANDOFF_MS = 250;

/** When the predicted blur stops being expected. `0` = nothing is expected. */
let ownHandoffUntil = 0;

/** The clock, as a seam: the unit tests drive it rather than sleeping. */
let now: () => number = () => Date.now();

function onBlur(): void {
    if (ownHandoffUntil > now()) {
        // One handoff, one blur: consumed here so the NEXT blur is read normally even if it
        // arrives inside the same window.
        ownHandoffUntil = 0;
        return;
    }
    runResets('blur');
}

function onVisibilityChange(): void {
    if (typeof document === 'undefined') return;
    if (document.visibilityState !== 'hidden') return;
    runResets('hidden');
}

function install(): void {
    if (installed) return;
    if (typeof window === 'undefined') return;
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);
    installed = true;
}

function uninstall(): void {
    if (!installed) return;
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    installed = false;
    // Nothing is registered any more, so a prediction made for the gestures that just went away
    // must not outlive them: a jsdom test that renders nothing leaves no global state behind.
    ownHandoffUntil = 0;
}

function runResets(reason: GestureResetReason): number {
    // A copy: a reset is allowed to unregister itself (an unmount teardown does exactly that)
    // and mutating the set mid-iteration would skip its neighbour.
    const pending = [...resets];
    for (const reset of pending) {
        try {
            reset(reason);
        } catch {
            // One gesture's teardown must never leave the others live: that is the whole point.
        }
    }
    return pending.length;
}

/**
 * Register a gesture's "end whatever is running" callback. Returns the unregistration, which
 * the caller runs on unmount.
 *
 * The callback must be safe to call when NO gesture is running: blur fires constantly, and
 * every registered gesture is asked each time.
 */
export function registerGestureReset(reset: GestureReset): () => void {
    resets.add(reset);
    install();
    return () => {
        resets.delete(reset);
        if (resets.size === 0) uninstall();
    };
}

/**
 * End every live gesture now. Returns how many resets ran, so the caller can log something
 * truthful (the recovery chord reports it).
 */
export function resetGestures(reason: GestureResetReason = 'manual'): number {
    return runResets(reason);
}

/**
 * "The blur that is about to arrive is one I asked for."
 *
 * Called by `webpane/commands.ts` ▸ `focusView`, the client's single door to
 * `contents.focus()` on a web pane's native view. The `blur` that answers it is this document
 * handing the keyboard to a sibling widget of its own window, not the pointer leaving (see the
 * module note), so it ends no gesture. Exactly one blur is absorbed, and only within
 * {@link OWN_FOCUS_HANDOFF_MS}; a prediction nothing answers simply expires.
 *
 * Safe with no window and no gestures registered: it is a timestamp, not a listener.
 */
export function expectOwnFocusHandoff(): void {
    ownHandoffUntil = now() + OWN_FOCUS_HANDOFF_MS;
}

/** Test seam: how many gestures are registered right now. */
export function registeredGestureCount(): number {
    return resets.size;
}

/**
 * Test seam: drive the clock this module reads, and the prediction it holds.
 *
 * `setGestureResetClock(null)` restores `Date.now` and clears any live prediction, which is what
 * a suite's `afterEach` wants.
 */
export function setGestureResetClock(clock: (() => number) | null): void {
    now = clock ?? (() => Date.now());
    ownHandoffUntil = 0;
}
