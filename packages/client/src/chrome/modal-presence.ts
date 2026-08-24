/**
 * Which app-modal surfaces are on screen right now — as one number the whole client can read.
 *
 * **Why a registry rather than a boolean expression.** A web pane's page is a native
 * `WebContentsView` the Electron shell composites ON TOP of this document, so no z-index,
 * backdrop or `opacity` in here can get above it: a dialog drawn while a page is live is sliced
 * at the page's edge (`docs/audit/run-O/53-agent-lifecycle-quit-dialog.png` — "Quit Nex?" with
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
 */

import { useEffect, useSyncExternalStore } from 'react';

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
 */
export function useModalPresence(active = true): void {
    useEffect(() => {
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
