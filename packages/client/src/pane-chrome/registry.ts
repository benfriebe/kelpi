/**
 * Where each pane's chrome model and its write path are published, so one presenter can read all
 * of them.
 *
 * ── Why a registry and not a second model ───────────────────────────────────────────
 *
 * A pane chrome presenter draws EVERY pane, and the facts it draws from are built per pane by
 * `grid/PaneHeader.tsx` out of the grid's props, the shared ticker and the plugin contributions
 * resolved for that pane. Rebuilding that in the presenter slot would be a second call to
 * `paneChromeModel` with a second set of inputs, and phase A's whole argument is that two answers
 * to "what does this header say" is how a presenter comes to disagree with the header it replaced.
 * The audit's own words: two copies of `badgeFit` would be two answers to which badges fit.
 *
 * So the model is built exactly once, where it always was, and the header publishes it here. The
 * presenter's frame is then provably the header that would have been drawn - a property no amount
 * of care in a second builder could give.
 *
 * The surface is published with it for the same reason. `surface.ts` re-resolves every call against
 * a FRESH model, and the fresh model is the one the header holds; a surface created beside the
 * presenter would re-resolve against a copy and could run a control the header had already dropped.
 *
 * ── Why a module store ──────────────────────────────────────────────────────────────
 *
 * `height.ts`'s reason verbatim: `PaneGrid`, `PaneHeader` and the presenter slot all have to keep
 * working standalone in their own tests and none of them shares a provider, and the writer (one
 * header) and the reader (one slot) are in different subtrees of the grid.
 *
 * Entries are published from a LAYOUT EFFECT rather than during render. A module store written
 * during render is a store written from a render React may discard, and notifying a subscriber from
 * inside a render is the "cannot update a component while rendering another" warning by
 * construction. One commit's delay costs nothing here: the presenter's feed is microtask-queued and
 * de-duplicated by frame content anyway, so a frame published a commit later is the same frame.
 */

import { useCallback, useEffect, useLayoutEffect, useSyncExternalStore } from 'react';

import type { PaneChromeDescriptor } from './contract';
import type { PaneChromeSurface } from './surface';

/** One pane's chrome, as the presenter slot reads it. */
export interface PaneChromeEntry {
    readonly descriptor: PaneChromeDescriptor;
    /** The header's own surface: ids in, no closures out, every call re-resolved. */
    readonly surface: PaneChromeSurface;
}

const entries = new Map<string, PaneChromeEntry & { readonly key: string }>();
const listeners = new Set<() => void>();
/**
 * How many times the published set has actually MOVED.
 *
 * The reader is `PaneGrid` through `useSyncExternalStore`, and a store that returned a fresh value
 * on every read would re-render the grid on every render - which is a re-measure of every terminal
 * in it. A monotonic counter is stable between real changes by construction.
 */
let version = 0;

function republish(): void {
    version += 1;
    // Copied before iterating: a listener that unsubscribes in response would otherwise mutate the
    // set mid-walk (`height.ts`'s rule, for the same reason).
    for (const listener of [...listeners]) listener();
}

/**
 * Publish (or replace) one pane's chrome.
 *
 * Compared by CONTENT, not by identity, and that is load-bearing. `PaneHeader` rebuilds its
 * descriptor on every render and the grid hands it a fresh `headerCommands` array on every render
 * of its own, so identity moves constantly and means nothing. Notifying on a descriptor that reads
 * the same would close a loop: grid renders, header publishes, store notifies, grid renders. The
 * JSON is the honest comparison and it is cheap - one descriptor is a few hundred bytes, and the
 * frame it feeds is serialised anyway.
 */
export function publishPaneChrome(paneID: string, entry: PaneChromeEntry): void {
    const key = JSON.stringify(entry.descriptor);
    const current = entries.get(paneID);
    if (current !== undefined && current.key === key && current.surface === entry.surface) {
        // Same content: keep the store's own object rather than swapping in an equal one, so a
        // reader holding an entry across renders keeps holding the same one.
        return;
    }
    entries.set(paneID, { descriptor: entry.descriptor, surface: entry.surface, key });
    republish();
}

/** Drop a pane's chrome. Its header has unmounted, so there is nothing left to re-resolve against. */
export function withdrawPaneChrome(paneID: string): void {
    if (!entries.delete(paneID)) return;
    republish();
}

/** A token that moves only when something published, unpublished or changed. */
export function paneChromeRegistryVersion(): number {
    return version;
}

/** What one pane published, or undefined for a pane with no mounted header. */
export function paneChromeEntry(paneID: string): PaneChromeEntry | undefined {
    return entries.get(paneID);
}

/** How many panes have published. Test seam. */
export function paneChromeEntryCount(): number {
    return entries.size;
}

/** Test seam: one page is one window, so a suite has to be able to start from a clean one. */
export function resetPaneChromeRegistry(): void {
    if (entries.size === 0) return;
    entries.clear();
    republish();
}

export function subscribePaneChrome(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/**
 * Publish this render's chrome for one pane, and withdraw it when the header goes.
 *
 * Two effects rather than one, and deliberately: the publish has to run after EVERY commit (the
 * descriptor changes on an agent tick, a divider drag, a focus change), while the withdrawal has
 * to run exactly once, when the pane's header unmounts. Folding them into one effect with a
 * cleanup would withdraw and re-publish on every tick, which is a removed pane and a new pane to
 * every reader of this store.
 */
/**
 * Re-render when the published set moves - but only where somebody is reading it.
 *
 * `enabled` is not an optimisation. Headers publish whatever is selected, so that the moment a
 * presenter IS selected the whole workspace is already in the store and no pane spends a commit
 * without a header. An unconditional subscription would then re-render `PaneGrid` on every agent
 * tick in a window with no presenter at all, which is a re-measure of every terminal in the grid
 * once a second for nothing.
 */
export function usePaneChromeRegistry(enabled: boolean): number {
    const subscribe = useCallback(
        (listener: () => void) => (enabled ? subscribePaneChrome(listener) : () => {}),
        [enabled]
    );
    const read = useCallback(() => (enabled ? version : 0), [enabled]);
    return useSyncExternalStore(subscribe, read, () => 0);
}

export function usePublishedPaneChrome(paneID: string, entry: PaneChromeEntry): void {
    useLayoutEffect(() => {
        publishPaneChrome(paneID, entry);
    });
    useEffect(
        () => () => {
            withdrawPaneChrome(paneID);
        },
        [paneID]
    );
}
