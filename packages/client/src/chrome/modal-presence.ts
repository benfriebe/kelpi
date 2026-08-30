/**
 * Which app-modal surfaces are on screen right now — as one number the whole client can read.
 *
 * **Why a registry rather than a boolean expression.** A web pane's page is a native
 * `WebContentsView` the Electron shell composites ON TOP of this document, so no z-index,
 * backdrop or `opacity` in here can get above it: a dialog drawn while a page is live is sliced
 * at the page's edge (`docs/audit/run-O/53-agent-lifecycle-quit-dialog.png` — "Quit Kelpi?" with
 * Cancel entirely off-screen). The only fix is to park the view for as long as the modal is up,
 * which means the assembly has to KNOW a modal is up.
 *
 * `App.tsx` used to answer that with a hand-written predicate over the four modals it owns state
 * for, and the modals it does NOT own state for — the shell's quit dialog, the graft swap prompt
 * inside the inspector, every `ContextMenu` — were simply missing from it. A predicate over other
 * components' internals cannot be kept honest: `GraftSwapDialog` renders only while the inspector
 * is open, from a prompt the assembly CAN see, so an assembly-side predicate on that prompt would
 * park the view for a dialog nobody can see.
 *
 * So the surfaces register themselves. A modal calls `useModalPresence()` while it is mounted;
 * the count is the number of them on screen; `useAnyModalOpen()` is the assembly's read. A
 * surface added later is covered by adding one hook call to it, and a surface whose exit
 * animation is still playing is counted for exactly as long as it is painted.
 *
 * Deliberately a module-level store rather than a context: a provider would have to sit above
 * every portal root, and several of these surfaces (`QuitGate`, `ContextMenu`, the inspector's
 * sheets) render into `document.body` from components that must keep working standalone in their
 * own tests.
 *
 * ── Two precisions, one mechanism (§N26) ────────────────────────────────────────────
 *
 * H1 enrolled the app-MODAL surfaces and parked every web view in the window for them, which is
 * right for a dialog: it owns the window while it is up. The owner's 2026-08-26 frame is the
 * other half of the class — the sidebar's delete confirmation, the title bar's layout dropdown,
 * the footer's gauge popover, the web chrome's bookmarks menu and the pane-drag drop zone were
 * never enrolled at all, so each was painted UNDER a live page (`docs/audit/n26-popup-layering`).
 *
 * Enrolling them as modals would have worked and been too blunt: the gauge popover opens on
 * HOVER, so sweeping the pointer along the footer would have blanked every page in the window,
 * over and over, one native attach/detach per pass. So a second, finer registration sits beside
 * the count: a floating surface can register its **rect**, and a web pane parks only when a
 * registered rect actually intersects the pane's page hole (`overlayCovers`, applied in
 * `webpane/WebPane.tsx`). A menu that stays inside the sidebar now parks nothing.
 *
 * The safety rule that makes the finer path as safe as the blunt one: **an unmeasurable rect
 * covers everything.** A zero-area registration — jsdom, a surface measured before layout — is
 * read as "position unknown", and an unknown position parks the pane exactly as H1 did. The
 * precision can only ever REMOVE a park it can prove is unnecessary.
 */

import { useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from 'react';

let mounted = 0;
const listeners = new Set<() => void>();

function notify(): void {
    // Copied before iterating: a listener that unsubscribes in response would otherwise mutate
    // the set mid-walk.
    for (const listener of [...listeners]) listener();
}

/**
 * Count one modal as on screen. Returns its release — idempotent, so a double-release (a
 * StrictMode double-invoke, an unmount racing a manual release) cannot drive the count negative.
 */
export function registerModal(): () => void {
    mounted += 1;
    notify();
    let released = false;
    return () => {
        if (released) return;
        released = true;
        mounted = Math.max(0, mounted - 1);
        notify();
    };
}

/** How many modal surfaces are mounted. Test seam; the app reads `useAnyModalOpen`. */
export function modalPresenceCount(): number {
    return mounted;
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/**
 * Declare "this component is an app-modal surface" for as long as it is mounted.
 *
 * `active` exists for the surfaces whose MOUNT is unconditional but whose paint is not —
 * `ToastStack` is always in the tree and draws only while it holds a toast.
 *
 * A LAYOUT effect, not a passive one (§N26): the registration has to land before the browser
 * paints the frame the surface first appears in, or that frame is guaranteed to show the dialog
 * under a still-attached page. React flushes the re-render this schedules before paint, so the
 * geometry report leaves in the same frame the surface arrives in.
 */
export function useModalPresence(active = true): void {
    useLayoutEffect(() => {
        if (!active) return undefined;
        return registerModal();
    }, [active]);
}

/** Whether ANY modal surface is on screen (the web pane's cue to hand its view back). */
export function useAnyModalOpen(): boolean {
    return useSyncExternalStore(
        subscribe,
        () => mounted > 0,
        () => false
    );
}

// ── the finer half: floating surfaces that register WHERE they are ──────────────────

/** A viewport-space box in CSS pixels — the same space `getBoundingClientRect` reports in. */
export interface OverlayRect {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
}

/**
 * What a registration holds before (or without) a measurement.
 *
 * Zero-area, and read by `overlayCovers` as "somewhere" — so an unmeasured surface parks every
 * pane, which is H1's behaviour and the safe default. See the module header.
 */
export const UNMEASURED_OVERLAY: OverlayRect = { x: 0, y: 0, w: 0, h: 0 };

let overlaySeq = 0;
const overlayRects = new Map<number, OverlayRect>();
/**
 * A stable array for `useSyncExternalStore`, rebuilt only when the set actually changes — a
 * fresh array on every read would re-render every web pane on every unrelated render.
 */
let overlaySnapshot: readonly OverlayRect[] = [];
const EMPTY_OVERLAYS: readonly OverlayRect[] = [];

function sameRect(a: OverlayRect, b: OverlayRect): boolean {
    return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function republishOverlays(): void {
    overlaySnapshot = [...overlayRects.values()];
    notify();
}

export interface OverlayHandle {
    /** Re-report where the surface is now (a submenu opened, the window resized). */
    update(rect: OverlayRect | null): void;
    /** Idempotent, for the same reason `registerModal`'s release is. */
    release(): void;
}

/**
 * Count one floating surface as on screen AT a place. `null` means "not measured yet", which is
 * deliberately the widest possible answer.
 */
export function registerOverlay(rect: OverlayRect | null = null): OverlayHandle {
    overlaySeq += 1;
    const id = overlaySeq;
    overlayRects.set(id, rect ?? UNMEASURED_OVERLAY);
    republishOverlays();
    let released = false;
    return {
        update(next) {
            if (released) return;
            const value = next ?? UNMEASURED_OVERLAY;
            const current = overlayRects.get(id);
            if (current !== undefined && sameRect(current, value)) return;
            overlayRects.set(id, value);
            republishOverlays();
        },
        release() {
            if (released) return;
            released = true;
            overlayRects.delete(id);
            republishOverlays();
        }
    };
}

/** How many floating surfaces are registered. Test seam. */
export function overlayPresenceCount(): number {
    return overlayRects.size;
}

/**
 * The union of an element's own box and every box inside it.
 *
 * The union, not the element's own rect, because a menu's *submenu* is an absolutely-positioned
 * child that sticks out past its parent panel: `getBoundingClientRect()` on the panel would
 * report the 190 px column and miss the 179 px of submenu hanging off its side — and a web pane
 * under only the submenu would then stay live, which is N26 all over again.
 */
export function measureOverlayRect(element: Element | null | undefined): OverlayRect | null {
    if (element === null || element === undefined) return null;
    if (typeof element.getBoundingClientRect !== 'function') return null;
    const own = element.getBoundingClientRect();
    let left = own.left;
    let top = own.top;
    let right = own.right;
    let bottom = own.bottom;
    let seen = own.width > 0 && own.height > 0;
    for (const child of element.querySelectorAll('*')) {
        const box = child.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) continue;
        left = seen ? Math.min(left, box.left) : box.left;
        top = seen ? Math.min(top, box.top) : box.top;
        right = seen ? Math.max(right, box.right) : box.right;
        bottom = seen ? Math.max(bottom, box.bottom) : box.bottom;
        seen = true;
    }
    if (!seen) return null;
    return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * Does any registered floating surface sit over this box?
 *
 * Fails OPEN in both directions: a zero-area OVERLAY is a surface whose position is unknown, and
 * a zero-area TARGET is a hole that has not been laid out yet. Either way the honest answer is
 * "assume it is covered" — the cost is a park that was not needed, and the cost of the other
 * mistake is a menu painted under a page.
 */
export function overlayCovers(target: OverlayRect | null, overlays: readonly OverlayRect[]): boolean {
    if (overlays.length === 0) return false;
    if (target === null || target.w <= 0 || target.h <= 0) return true;
    return overlays.some((rect) => {
        if (rect.w <= 0 || rect.h <= 0) return true;
        return (
            rect.x < target.x + target.w &&
            target.x < rect.x + rect.w &&
            rect.y < target.y + target.h &&
            target.y < rect.y + rect.h
        );
    });
}

/**
 * Declare "this element floats above the document" for as long as it is mounted, and keep its
 * measured box current.
 *
 * Measured after EVERY render of the owner (no dependency list) for the same reason
 * `WebPane`'s geometry publish is: a submenu opening, a list filling in, a popover flipping to
 * the other side are all renders, and each one moves the box that decides which panes park. A
 * `ResizeObserver` and the window's own `resize` cover the changes no render announces.
 */
export function useOverlayPresence(ref: RefObject<Element | null>, active = true): void {
    const handle = useRef<OverlayHandle | null>(null);

    useLayoutEffect(() => {
        if (!active) return undefined;
        const registration = registerOverlay(measureOverlayRect(ref.current));
        handle.current = registration;

        const remeasure = (): void => {
            registration.update(measureOverlayRect(ref.current));
        };
        const view = globalThis as {
            ResizeObserver?: new (callback: () => void) => { observe(target: Element): void; disconnect(): void };
            addEventListener?: (type: string, listener: () => void, options?: unknown) => void;
            removeEventListener?: (type: string, listener: () => void, options?: unknown) => void;
        };
        const element = ref.current;
        const observer =
            element !== null && view.ResizeObserver !== undefined ? new view.ResizeObserver(remeasure) : null;
        if (element !== null) observer?.observe(element);
        view.addEventListener?.('resize', remeasure);
        return () => {
            observer?.disconnect();
            view.removeEventListener?.('resize', remeasure);
            handle.current = null;
            registration.release();
        };
    }, [active, ref]);

    useLayoutEffect(() => {
        handle.current?.update(measureOverlayRect(ref.current));
    });
}

/** Every registered floating surface's box (the web pane's cue to park just itself). */
export function useOverlayRects(): readonly OverlayRect[] {
    return useSyncExternalStore(
        subscribe,
        () => overlaySnapshot,
        () => EMPTY_OVERLAYS
    );
}
