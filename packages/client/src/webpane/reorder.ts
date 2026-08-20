/**
 * WEB-016's client half: what a drag across the tab strip means.
 *
 * The daemon owns the rule that matters (an order that is not an exact permutation is dropped
 * whole, `store/reducers/web.ts`), so what is left here is the *gesture*: given the ids in the
 * strip, the one being dragged and the one under the pointer, what order does the user mean?
 *
 * Kept pure and separate from the component for two reasons. It is the half a test can pin
 * without layout (jsdom has none, so a drag in a unit test is only ever a sequence of ids), and
 * the strip's own handlers stay small enough to read.
 *
 * The gesture is POINTER-based, not HTML5 drag-and-drop. `Input.dispatchMouseEvent` — how the
 * visual audit drives a real window, and how any automation drives a browser — cannot start a
 * native DnD session, so an `ondragstart` strip would be untestable end to end. Pointer events
 * are also what the pane grid's own drag already uses, so the two gestures read the same.
 */

/** Move `movingID` so it sits where `targetID` is now. Anything unknown is a no-op. */
export function reorderedTabs(
    ids: readonly string[],
    movingID: string,
    targetID: string
): readonly string[] {
    if (movingID === targetID) return ids;
    const from = ids.indexOf(movingID);
    const to = ids.indexOf(targetID);
    if (from < 0 || to < 0) return ids;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, movingID);
    return next;
}

/** True when two orders differ — the caller only sends a changed one (WEB-016's no-op rule). */
export function orderChanged(before: readonly string[], after: readonly string[]): boolean {
    if (before.length !== after.length) return true;
    return before.some((id, index) => id !== after[index]);
}

/**
 * The tab whose pill contains a pointer x, given each pill's measured box.
 *
 * The strip is horizontal and scrollable, so the hit test is one-dimensional: a pointer past a
 * pill's midpoint is heading for its neighbour, which is what makes the preview feel like a
 * drag rather than a swap-on-release.
 */
export interface PillBox {
    readonly id: string;
    readonly left: number;
    readonly right: number;
}

export function tabUnderPointer(boxes: readonly PillBox[], x: number): string | null {
    for (const box of boxes) {
        if (x >= box.left && x <= box.right) return box.id;
    }
    // Past either end: clamp to the nearest pill, so a drag that overshoots still lands.
    const first = boxes[0];
    const last = boxes[boxes.length - 1];
    if (first === undefined || last === undefined) return null;
    if (x < first.left) return first.id;
    if (x > last.right) return last.id;
    return null;
}
