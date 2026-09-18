/**
 * How tall each pane's chrome band is - as one store the whole window reads.
 *
 * **Why a store rather than a prop.** The band is the one thing a pane chrome presenter declares
 * that the HOST has to act on, and every consumer of it is somewhere else: `PaneGrid` lays the
 * body out under it, the terminal measures its cols and rows from the box that leaves, the web
 * pane's native view is placed into the hole that leaves, and the shell turns that hole into DIP
 * bounds. Threading a per-pane number from wherever a presenter call lands, through the assembly,
 * into the grid, would be a second copy of the layout tree; and a stale copy of it resizes a live
 * shell (`docs/plugin-roadmap.md`'s own warning about `bodyFrame`'s hard-wired 24 px).
 *
 * So the declarations live here, keyed by pane, and the grid reads them the way a web pane reads
 * `chrome/modal-presence.ts` - a module-level store with `useSyncExternalStore`, deliberately not
 * a context, because `PaneGrid`, `PaneHeader` and the web pane surface all have to keep working
 * standalone in their own tests and none of them shares a provider.
 *
 * **Nothing declares a height in phase A.** No presenter is mounted, `setPaneChromeHeight` has no
 * caller outside these tests and the temporary measurement recorded in
 * `docs/plugin-validation.md`, and `paneChromeHeight(null, …)` returns the host's own band
 * untouched. The on-screen result is therefore identical, which is what the terminal geometry
 * scenario is run to prove.
 *
 * ── Parking (ratified decision 5) ────────────────────────────────────────────────────
 *
 * A band taller than the native one over a WEB pane enrols itself in `chrome/modal-presence`, and
 * the web pane parks its page exactly as it does for the `•••` menu. The reason is the reason
 * everything in this area has one: nothing in this document composites above a native
 * `WebContentsView`, so a band drawn into pixels the view still holds is invisible. At rest the
 * two boxes are adjacent rather than overlapping - the page hole begins where the band ends - so
 * `overlayCovers` reports no cover and nothing parks; the registration earns its keep in the
 * frames BETWEEN the band growing and the shell moving the view down, which is the window in
 * which a user would otherwise watch the new chrome get sliced. See `contract.ts`'s
 * `paneChromeParks` for the predicate and the validation record for the measured cost.
 */

import { useCallback, useSyncExternalStore, type RefObject } from 'react';

import { useOverlayPresence } from '../chrome/modal-presence';

import { PANE_CHROME_LIMITS, paneChromeHeight, paneChromeParks, type PaneChromeKind } from './contract';

/** The declarations, by pane id. A pane with no entry is a pane wearing the host's own band. */
const declarations = new Map<string, number>();
const listeners = new Set<() => void>();

/**
 * A stable snapshot for `useSyncExternalStore`, rebuilt only when a declaration actually changes.
 *
 * A fresh map on every read would re-render every pane in the grid on every unrelated render,
 * which is the mistake `modal-presence.ts`'s `overlaySnapshot` exists to avoid and costs more here:
 * a re-render of the grid is a re-measure of every terminal in it.
 */
let snapshot: PaneChromeHeights = Object.freeze(new Map<string, number>());
const EMPTY: PaneChromeHeights = Object.freeze(new Map<string, number>());

/** Declared band heights by pane id, as the grid reads them. */
export type PaneChromeHeights = ReadonlyMap<string, number>;

function republish(): void {
    snapshot = Object.freeze(new Map(declarations));
    // Copied before iterating: a listener that unsubscribes in response would otherwise mutate
    // the set mid-walk.
    for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/**
 * Declare (or withdraw) a pane's band.
 *
 * `null` withdraws, which is what a reload, a fallback or a pane closing does: the pane goes back
 * to the host's own band on the next frame. The value is stored RAW and clamped at read, because
 * the ceiling is a fraction of a pane height this module cannot see - the same split the
 * notification box makes between `setNotificationBoxHeight` and `notificationBoxHeight`.
 *
 * A non-finite or negative declaration is refused outright rather than stored as 0: it is not a
 * height, and storing it would make the withdrawal path ambiguous.
 */
export function setPaneChromeHeight(paneID: string, pixels: number | null): void {
    if (pixels === null) {
        if (!declarations.delete(paneID)) return;
        republish();
        return;
    }
    if (!Number.isFinite(pixels) || pixels < 0) return;
    const value = Math.round(pixels);
    if (declarations.get(paneID) === value) return;
    declarations.set(paneID, value);
    republish();
}

/**
 * Drop every declaration.
 *
 * Phase B's fallback calls this: a declaration belongs to the view that made it, so a failed
 * presenter, a reload or a different selection returns every pane to the native band at once
 * (ratified decision 8's all-or-nothing, which exists precisely so no PTY is left sized against a
 * dead header).
 */
export function clearPaneChromeHeights(): void {
    if (declarations.size === 0) return;
    declarations.clear();
    republish();
}

/** What a pane has declared, raw and unclamped. Test seam; the grid reads the hook. */
export function paneChromeDeclaration(paneID: string): number | null {
    return declarations.get(paneID) ?? null;
}

/** How many panes have declared anything. Test seam. */
export function paneChromeDeclarationCount(): number {
    return declarations.size;
}

/** Every declared band, as one stable map. The grid subscribes once for the whole workspace. */
export function usePaneChromeHeights(): PaneChromeHeights {
    return useSyncExternalStore(
        subscribe,
        () => snapshot,
        () => EMPTY
    );
}

/**
 * The band one pane is painting at: its declaration clamped against its own height, or the host's
 * own band when it has not declared.
 *
 * Exported beside the hook because the grid cannot call a hook per pane - it subscribes once with
 * `usePaneChromeHeights` and folds each pane through this.
 */
export function paneChromeBand(
    heights: PaneChromeHeights,
    paneID: string,
    paneHeight: number,
    native: number = PANE_CHROME_LIMITS.nativeHeight
): number {
    return paneChromeHeight(heights.get(paneID) ?? null, paneHeight, native);
}

/**
 * Enrol a declared band over a web pane, so the page parks while the two overlap.
 *
 * A thin wrapper over `useOverlayPresence` on purpose: the registration, the re-measure on every
 * render, the `ResizeObserver` and the "an unmeasurable rect covers everything" safety rule are
 * all `chrome/modal-presence.ts`'s already, and a second implementation of them would be a second
 * answer to which panes park. All this adds is the predicate - and the predicate is the whole
 * decision.
 */
export function usePaneChromeParking(
    ref: RefObject<Element | null>,
    kind: PaneChromeKind,
    height: number
): void {
    useOverlayPresence(ref, paneChromeParks(kind, height));
}

/**
 * A stable `setPaneChromeHeight` bound to one pane, for a host that holds a presenter call.
 *
 * Nothing calls it in phase A. It exists so the store has one shape of writer rather than two when
 * phase B wires `ui.setPaneChromeHeight` to it.
 */
export function usePaneChromeDeclaration(paneID: string): (pixels: number | null) => void {
    return useCallback((pixels: number | null) => setPaneChromeHeight(paneID, pixels), [paneID]);
}
