/**
 * A pointer press inside a plugin frame, as the host document learns of it.
 *
 * A `pointerdown` in a child document never reaches the host document, so host code that has to
 * stand down the moment the user presses somewhere cannot hear a press inside a plugin view - a
 * plugin terminal renderer, a presenter's frame, a sidebar view. The SDK already reports its own
 * capture-phase `pointerdown` as a `focus` message; it marks that one `pointer: true`, and
 * `PluginView` relays it here. A `focusin` inside the frame is NOT relayed: a frame can be focused
 * programmatically, and only a press says the user chose it.
 *
 * Its one reader is the find bar's fallback caret re-assertion (`pane-search/presenter-slot.tsx`),
 * which must never take the caret back from a user who clicked a plugin-rendered terminal. A
 * neutral module rather than a call into `pane-search/`, so `plugins/` never imports a placement.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/** A press landed inside a plugin frame. */
export function noteFramePointerDown(): void {
    for (const listener of [...listeners]) listener();
}

/** Hear every press inside a plugin frame until the returned function is called. */
export function onFramePointerDown(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
