/**
 * Dismiss-on-outside-click and dismiss-on-Escape — the contract every transient panel owes.
 *
 * Lifted out of `ContextMenu`, which was the only surface in the client that had it. The
 * footer's agent-count popover (`StatusFooter.tsx`) and the title bar's layout dropdown
 * (`TopBar.tsx`) were dismissed ONLY by re-clicking the control that opened them, so they stayed
 * parked over the pane grid while the user typed. The shipped app gets this for free: both are
 * an `NSPopover` / `NSMenu`, which close on any outside click and on Escape
 * (`StatusBarView.swift:272-283` — `.popover(isPresented:arrowEdge:)`).
 *
 * `keep` is the set of boxes an outside-click must NOT dismiss through: the panel itself, plus
 * **the control that opened it**. The anchor matters — without it, a click on the open chip is
 * "outside" on `mousedown` (closing the panel) and then a toggle on `click` (opening it again),
 * so the control that owns the panel could never close it.
 *
 * Both listeners are CAPTURE-phase on the document, so a pane's own key or pointer handling
 * cannot swallow the way out of a panel, and Escape is consumed (`stopPropagation`) so it
 * dismisses the panel rather than also reaching the window-level key dispatcher behind it.
 */

import { useEffect, useRef, type RefObject } from 'react';

export function useDismissable(
    active: boolean,
    onDismiss: () => void,
    keep: readonly RefObject<HTMLElement | null>[]
): void {
    /*
     * The keep-list lives in a ref rather than in the dependency list: callers pass a fresh
     * array literal every render, so a dependency on it would re-subscribe both listeners on
     * every render — wasteful, and a way to miss the event that arrives mid-swap.
     */
    const latest = useRef(keep);
    latest.current = keep;

    useEffect(() => {
        if (!active) return undefined;
        const inside = (target: EventTarget | null): boolean => {
            if (!(target instanceof Node)) return false;
            return latest.current.some((ref) => ref.current?.contains(target) === true);
        };
        const onPointerDown = (event: Event): void => {
            if (inside(event.target)) return;
            onDismiss();
        };
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            onDismiss();
        };
        const doc = globalThis.document;
        doc.addEventListener('mousedown', onPointerDown, true);
        doc.addEventListener('keydown', onKeyDown, true);
        return () => {
            doc.removeEventListener('mousedown', onPointerDown, true);
            doc.removeEventListener('keydown', onKeyDown, true);
        };
    }, [active, onDismiss]);
}
