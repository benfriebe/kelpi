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

function onBlur(): void {
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

/** Test seam: how many gestures are registered right now. */
export function registeredGestureCount(): number {
    return resets.size;
}
