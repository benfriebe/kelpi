/**
 * The one thing a search presenter declares that the HOST has to act on: how big its bar is.
 *
 * **Why a store rather than a prop.** The declaration arrives on a presenter call, which lands in
 * the slot; the box it sizes is computed by `PaneGrid`, which owns the pane rectangles; and the
 * native bar's stand-down is decided beside it. Threading a number from the call site through the
 * assembly and into the grid would be a second copy of the layout tree, and the same module-store
 * argument `pane-chrome/height.ts` and `chrome/modal-presence.ts` make applies verbatim: `PaneGrid`
 * and the slot are in different subtrees and share no provider, and both have to keep working
 * standalone in their own tests.
 *
 * Keyed by pane id even though one search is open at a time. The calls are `(paneID, …)` because
 * the host re-validates every one of them against the pane the published frame names (decision 8),
 * and a store keyed by the same id is a store whose entries can be checked against that name rather
 * than assumed to belong to it. It also makes the withdrawal rule expressible: a declaration
 * belongs to the pane it was made for, and the moment the search moves to another pane the previous
 * pane's entry is not "the current box", it is stale.
 *
 * ── Withdrawal (lesson from #244) ───────────────────────────────────────────────────
 *
 * Every declaration goes back on every stand-down path, and every one of them is an UNMOUNT
 * cleanup or a host-side retain rather than a render branch:
 *
 *   - the selection changing to bundled, the plugin being disabled or uninstalled, and the
 *     generation moving all unmount `PaneSearchPresenterSlot`, which is where
 *     `clearPaneSearchBoxes` runs (a render branch would never run, because the component that
 *     would hold it is the one that goes away);
 *   - a failure clears them in the same tick the latch is set, because the native bar has to take
 *     the box back in the same commit;
 *   - the search closing, the pane closing and the workspace changing all leave no searched pane,
 *     and `retainPaneSearchBox(paneID | null)` drops everything that is not the pane being searched
 *     right now - the host's own withdrawal, which runs whether or not a presenter is still there
 *     to make it;
 *   - the connection dropping stands the placement down through the same slot unmount;
 *   - `usePaneSearchBoxScope` drops every declaration when the grid changes what it is showing.
 *
 * Nothing here clamps. The value is stored RAW and clamped at READ against the pane's own measured
 * box, which is the only place both numbers are in hand - the same split
 * `setNotificationBoxHeight` / `notificationBoxHeight` makes and the same one `height.ts` makes.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { paneSearchBox, type PaneSearchSize } from './contract';

const declarations = new Map<string, PaneSearchSize>();
const listeners = new Set<() => void>();

/** Declared sizes by pane id, as the grid reads them. */
export type PaneSearchBoxes = ReadonlyMap<string, PaneSearchSize>;

/**
 * A stable snapshot for `useSyncExternalStore`, rebuilt only when a declaration actually changes.
 *
 * A fresh map on every read would re-render the grid on every unrelated render, which here is a
 * re-measure of every terminal in it.
 */
let snapshot: PaneSearchBoxes = Object.freeze(new Map<string, PaneSearchSize>());
const EMPTY: PaneSearchBoxes = Object.freeze(new Map<string, PaneSearchSize>());

function republish(): void {
    snapshot = Object.freeze(new Map(declarations));
    // Copied before iterating: a listener that unsubscribes in response would otherwise mutate the
    // set mid-walk.
    for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/**
 * Declare (or withdraw) a pane's search box. Three inputs, three answers, and no fourth case - the
 * same three `setPaneChromeHeight` gives, because two declaration stores that disagreed about what
 * a negative number means would be two answers to the same question:
 *
 *   - **`null` withdraws.** The bar goes back to the native box on the next frame, and a presenter
 *     can hand it back without waiting to be torn down.
 *   - **A negative number is 0.** The clamp already says `[0, ceiling]`, so this agrees with it
 *     rather than inventing a second floor. A presenter that asks for -40 is asking for nothing,
 *     and nothing is a legal box.
 *   - **A non-finite number is refused, and the previous box stands.** NaN and the infinities are
 *     not sizes; treating them as a withdrawal would make one arithmetic slip inside a presenter
 *     look exactly like a deliberate hand-back.
 */
export function setPaneSearchBox(paneID: string, size: PaneSearchSize | null): void {
    if (size === null) {
        if (!declarations.delete(paneID)) return;
        republish();
        return;
    }
    if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) return;
    const next = { width: Math.max(0, Math.round(size.width)), height: Math.max(0, Math.round(size.height)) };
    const current = declarations.get(paneID);
    if (current !== undefined && current.width === next.width && current.height === next.height) return;
    declarations.set(paneID, next);
    republish();
}

/** What a pane has declared, raw and unclamped. Test seam; the grid reads the hook. */
export function paneSearchDeclaration(paneID: string): PaneSearchSize | null {
    return declarations.get(paneID) ?? null;
}

/** How many panes have declared anything. Test seam. */
export function paneSearchDeclarationCount(): number {
    return declarations.size;
}

/**
 * Drop every declaration.
 *
 * The call every stand-down path uses: a failure, the placement standing down, the slot unmounting,
 * a generation change. A declaration belongs to the view that made it, so a presenter that has gone
 * leaves no box behind for whoever comes next to be drawn at.
 */
export function clearPaneSearchBoxes(): void {
    if (declarations.size === 0) return;
    declarations.clear();
    republish();
}

/**
 * Keep only the pane being searched right now, and drop every other declaration.
 *
 * The HOST's own withdrawal, and the answer to a box nobody can hand back. A presenter declares for
 * the pane the frame names; the moment the search closes, moves to another pane, or the pane goes
 * from the workspace, that entry is not the current box any more - and the presenter cannot fix it
 * on its own, because a pane the frame does not name is a pane whose calls are refused, which is
 * correct for a WRITE and would be a trap for a withdrawal. So the host withdraws, every render,
 * from the one place that knows which pane is being searched.
 *
 * `null` means nothing is being searched, which drops everything.
 */
export function retainPaneSearchBox(paneID: string | null): void {
    if (declarations.size === 0) return;
    let changed = false;
    for (const key of [...declarations.keys()]) {
        if (key === paneID) continue;
        declarations.delete(key);
        changed = true;
    }
    if (changed) republish();
}

/** Every declared box, as one stable map. The grid subscribes once for the whole workspace. */
export function usePaneSearchBoxes(): PaneSearchBoxes {
    return useSyncExternalStore(
        subscribe,
        () => snapshot,
        () => EMPTY
    );
}

/**
 * The box one pane's bar is actually painted at: its declaration clamped against the pane's own
 * measured rectangle, or the native bar's own box when it has not declared.
 *
 * Exported beside the hook because the grid cannot call a hook per pane - it subscribes once with
 * `usePaneSearchBoxes` and folds the searched pane through this.
 */
export function paneSearchBoxFor(
    boxes: PaneSearchBoxes,
    paneID: string,
    pane: { readonly width: number; readonly height: number }
): PaneSearchSize {
    return paneSearchBox(boxes.get(paneID) ?? null, pane);
}

/** A stable `setPaneSearchBox` bound to one pane, for a host that holds a presenter call. */
export function usePaneSearchDeclaration(paneID: string): (size: PaneSearchSize | null) => void {
    return useCallback((size: PaneSearchSize | null) => setPaneSearchBox(paneID, size), [paneID]);
}

/**
 * Drop every declaration when the grid changes what it is showing.
 *
 * `retainPaneSearchBox` covers the searched pane moving; this covers the WINDOW moving. The
 * displayed workspace changing, a remote workspace being selected, the daemon connection dropping
 * and the grid itself unmounting all end the session a declaration belonged to. `scope` is whatever
 * the host calls "the thing being shown"; `PaneGrid` passes its workspace id, and `undefined` opts
 * out for a host that has no such notion and for every standalone render.
 */
export function usePaneSearchBoxScope(scope: string | undefined): void {
    useEffect(() => {
        if (scope === undefined) return undefined;
        return () => {
            clearPaneSearchBoxes();
        };
    }, [scope]);
}
