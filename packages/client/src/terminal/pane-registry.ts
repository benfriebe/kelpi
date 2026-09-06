/**
 * Live handles onto the mounted terminal panes, keyed by pane id (#81).
 *
 * ## Why a registry, and why a live READ
 *
 * `copy` has to answer one question at the instant the chord is pressed: **what is selected in
 * the focused pane right now?** `TerminalPane` owns the renderer that knows, the app owns the
 * dispatcher that asks, and nothing connected the two: the `onSelectionChange` prop existed and
 * was never passed at either render site (`App.tsx`), so the app kept only a selection *length*
 * for a `data-` attribute.
 *
 * The obvious repair, wiring that prop and caching the last selection in the app, is wrong here,
 * and the vendored engine says exactly why. `SelectionManager.clearSelection()` does **not** fire
 * the change emitter (`vendor/ghostty-web-patched/source/lib/selection-manager.ts:227`), and the
 * mousedown that starts a new selection calls it directly (`:439`). So clicking on blank space
 * after selecting something clears the highlight and tells nobody. A cached selection would still
 * hold the old text, and ⌘C would copy something the user can no longer see highlighted, which is
 * a worse bug than the one being fixed. `renderer.selection()` is already a live read
 * (`renderer.ts:170`, `§TERM-034`); this module is only the wire that lets the app reach it.
 *
 * ## Why module-level rather than a prop or a context
 *
 * The same reason `chrome/modal-presence.ts` is: the reader is the key dispatcher, which is built
 * once from refs and must not go stale, and the writers are pane components mounted anywhere in
 * the grid (including the markdown pane that becomes a terminal for an external `$EDITOR`
 * session). A prop would have to be threaded through the grid's render callbacks to two separate
 * `TerminalPane` sites; a context would have to sit above them and would still need a ref to be
 * readable from the dispatcher. A registry is one map and one lookup.
 *
 * **The registry is also the pane-type test.** `paneHandle(id)` is non-null exactly for panes
 * that have a live terminal renderer, so `copy` needs no knowledge of pane types to decline for a
 * markdown pane, a diff pane or a web pane, and it keeps declining for a terminal pane whose
 * engine has not finished opening. Declining is the dispatcher's fall-through (`chrome/keys.ts`
 * step 7), which is what leaves the Edit menu's own Copy in charge everywhere else.
 */

export interface TerminalPaneHandle {
    /**
     * The engine's live selection for this pane, `''` when there is none.
     *
     * Read at call time, never pushed: see the module header.
     */
    selection(): string;
}

const handles = new Map<string, TerminalPaneHandle>();

/**
 * Publish a pane's handle for as long as its renderer is live. Returns the release.
 *
 * The release deletes only if this exact handle is still the registered one, so a remount that
 * registers before the old effect's cleanup runs (React 18 StrictMode, a pane id reused after a
 * fast close/reopen) cannot have its fresh handle removed by the stale cleanup.
 */
export function registerTerminalPane(paneID: string, handle: TerminalPaneHandle): () => void {
    handles.set(paneID, handle);
    return () => {
        if (handles.get(paneID) === handle) handles.delete(paneID);
    };
}

/** The live handle for a pane, or `null` when that pane has no mounted terminal renderer. */
export function paneHandle(paneID: string | null | undefined): TerminalPaneHandle | null {
    if (paneID === null || paneID === undefined) return null;
    return handles.get(paneID) ?? null;
}

/** How many panes are registered. Test seam only. */
export function registeredPaneCount(): number {
    return handles.size;
}
