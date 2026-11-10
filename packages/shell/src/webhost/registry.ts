/**
 * The pane → tab → view registry (web-pane.md §1's "runtime browser objects" layer).
 *
 * The daemon owns which panes are web panes, what tabs they have and which one is active; this
 * is the mirror image on the host side — one live browser view per tab, created and destroyed
 * to match the lifecycle notifications (`pane-open`, `tab-open`, `tab-select`, …).
 *
 * Two rules from the protocol shape the whole module:
 *
 *   - **`pane-open` is idempotent.** The daemon replays one per existing web pane on every host
 *     registration, so a shell that reconnects after a crash rebuilds exactly the pane set the
 *     daemon has. Reconciling (create what is missing, drop what is gone) rather than rebuilding
 *     keeps live pages alive across a daemon reconnect.
 *   - **The storage partition is sealed into a view at creation** (§6), so flipping `isPrivate`
 *     destroys and rebuilds every view of the pane. Live JS state is expected to be lost.
 *
 * **A tab can be held without a view** (issue #467). A tab nobody has shown or driven for a while
 * is discarded: its view is destroyed and the registry keeps what `./tab.ts` saved instead (the
 * address, the title and a restore record). The tab stays in the pane, in its place, and
 * `restore` rebuilds its view from that record when something needs the page. `view`,
 * `activeView`, `pane().tabs` and `locate` see live views only, so nothing that merely looks at
 * the views (a keyboard census, a disarm) brings a discarded page back.
 *
 * It is generic over the view type and takes its create/destroy/show behaviour as hooks, so the
 * bookkeeping is unit-testable without Electron.
 */

export interface RegistryTabSpec {
    readonly id: string;
    readonly url: string;
    readonly title?: string;
}

export interface RegistryPaneSpec {
    readonly paneID: string;
    readonly isPrivate: boolean;
    readonly activeTabID: string | null;
    readonly tabs: readonly RegistryTabSpec[];
}

export interface CreateTabInput<R = unknown> {
    readonly paneID: string;
    readonly tabID: string;
    readonly url: string;
    readonly isPrivate: boolean;
    /** #467: a discarded tab being rebuilt, with what its view saved when it was discarded. */
    readonly restore?: R | undefined;
}

/** #467: what the registry holds for a tab whose view was discarded. */
export interface DiscardedTab<R = unknown> {
    /** What the tab was showing, as `TabController.url()` reported it. */
    readonly url: string;
    readonly title: string;
    readonly restore: R;
}

export type DestroyReason =
    | 'tab-close'
    | 'pane-close'
    | 'private-flip'
    | 'reconcile'
    | 'dispose'
    /** The tab's renderer died (or the page destroyed itself); the view object is still ours. */
    | 'renderer-gone'
    /** #467: nobody used the tab for a while; its view's contents are already closed. */
    | 'discard';

export interface RegistryHooks<V, R = unknown> {
    /** Build the view and start loading `url` (an empty URL loads nothing), or restore it. */
    create(input: CreateTabInput<R>): V;
    destroy(view: V, reason: DestroyReason): void;
    /** Only the active tab is shown; background tabs keep running JS (§5). */
    show(view: V, visible: boolean): void;
}

export interface RegistryTab<V> {
    readonly id: string;
    readonly view: V;
}

export interface RegistryPane<V> {
    readonly paneID: string;
    readonly isPrivate: boolean;
    /** The tabs with a live view. A discarded tab is not here (#467). */
    readonly tabs: readonly RegistryTab<V>[];
    /** May be stale for an instant after a close; read `activeView` for the resolved tab. */
    readonly activeTabID: string | null;
}

export interface TabRegistry<V, R = unknown> {
    openPane(spec: RegistryPaneSpec): void;
    closePane(paneID: string): boolean;
    setPrivate(spec: RegistryPaneSpec): void;
    openTab(paneID: string, tabID: string, url: string, makeActive: boolean): boolean;
    closeTab(paneID: string, tabID: string): boolean;
    selectTab(paneID: string, tabID: string): boolean;
    /**
     * Drop a tab whose RENDERER died on its own (a crash, `window.close()`).
     *
     * Issue #76: this used to drop the bookkeeping and stop, on the reading that a dead tab has
     * nothing to destroy. It has. Only the renderer process is gone; the `WebContentsView` is
     * still a child of whichever window it was placed in, still in the embed controller's
     * books, and still covering the pane's page area with a blank rectangle nobody can navigate
     * or reload. So it goes through the destroy hook like every other death, which takes it out
     * of the embed controller's books (`beforeDestroy` -> `embed.releaseView`), un-parents it and
     * closes its contents. Nothing is left placed, and the daemon's rebuild `pane-open` then
     * lands on a pane with no view for that tab, which is exactly the case `openPane` reconciles
     * by creating one.
     *
     * That release is also issue #72's requirement of this path: a dead renderer left embedded in
     * the shell window is a rectangle of nothing that swallows every click landing on it, and the
     * placement books are the only party that can move it. #72 closed that with a separate
     * `forget` hook, written against a `forgetTab` that still destroyed nothing; the destroy hook
     * reaches the same books AND closes the contents, so the hook would only be a second way to
     * say it.
     */
    forgetTab(paneID: string, tabID: string): boolean;
    /**
     * #467: destroy an unused tab's view and keep `record` in its place. The tab stays in the
     * pane, at the same index, and keeps being the active one if it was. False when there is no
     * such tab or it has no live view.
     */
    discard(paneID: string, tabID: string, record: DiscardedTab<R>): boolean;
    /**
     * #467: the tab's live view, rebuilding a discarded one from its record first. `tabID` null
     * means the pane's active tab (§17.2's fallback). Use this when the page itself is needed
     * (placing it on screen, an automation verb); `view` for everything that only looks.
     */
    restore(paneID: string, tabID: string | null): V | null;
    /** #467: the record of a discarded tab (`tabID` null: the active tab), or null. */
    discarded(paneID: string, tabID: string | null): DiscardedTab<R> | null;
    /** Every tab of the pane in order, discarded ones included (#467). Empty for no pane. */
    tabIDs(paneID: string): readonly string[];
    /** The tab's live view; null for an unknown tab and for a discarded one (#467). */
    view(paneID: string, tabID: string): V | null;
    /** §17.2: the active tab always falls back to `tabs[0]`. Null while it is discarded. */
    activeView(paneID: string): V | null;
    /** The resolved active tab's id, discarded or not. */
    activeTabID(paneID: string): string | null;
    pane(paneID: string): RegistryPane<V> | null;
    paneIDs(): readonly string[];
    /** Reverse lookup for view-driven events (a `did-navigate` knows only its view). */
    locate(predicate: (view: V) => boolean): { paneID: string; tabID: string; view: V } | null;
    dispose(): void;
}

/** One tab: exactly one of `view` (live) and `discarded` (#467) is set. */
interface Entry<V, R> {
    readonly id: string;
    view: V | null;
    discarded: DiscardedTab<R> | null;
}

interface MutablePane<V, R> {
    paneID: string;
    isPrivate: boolean;
    tabs: Entry<V, R>[];
    activeTabID: string | null;
}

export function createTabRegistry<V, R = unknown>(hooks: RegistryHooks<V, R>): TabRegistry<V, R> {
    const panes = new Map<string, MutablePane<V, R>>();

    const resolveActive = (pane: MutablePane<V, R>): Entry<V, R> | null => {
        const named = pane.tabs.find((tab) => tab.id === pane.activeTabID);
        if (named !== undefined) return named;
        return pane.tabs[0] ?? null;
    };

    const entryOf = (paneID: string, tabID: string | null): { pane: MutablePane<V, R>; entry: Entry<V, R> } | null => {
        const pane = panes.get(paneID);
        if (pane === undefined) return null;
        const entry = tabID === null ? resolveActive(pane) : pane.tabs.find((tab) => tab.id === tabID);
        return entry === null || entry === undefined ? null : { pane, entry };
    };

    const live = (pane: MutablePane<V, R>): RegistryTab<V>[] =>
        pane.tabs.flatMap((tab) => (tab.view === null ? [] : [{ id: tab.id, view: tab.view }]));

    /** Exactly one visible view per pane, recomputed after every mutation. */
    const applyVisibility = (pane: MutablePane<V, R>): void => {
        const active = resolveActive(pane);
        for (const tab of pane.tabs) {
            if (tab.view !== null) hooks.show(tab.view, tab === active);
        }
    };

    /** A discarded tab has no view to destroy; its record simply goes with the entry. */
    const destroyEntry = (tab: Entry<V, R>, reason: DestroyReason): void => {
        const view = tab.view;
        tab.view = null;
        tab.discarded = null;
        if (view !== null) hooks.destroy(view, reason);
    };

    const destroyPane = (pane: MutablePane<V, R>, reason: DestroyReason): void => {
        for (const tab of pane.tabs) destroyEntry(tab, reason);
        pane.tabs = [];
    };

    const fresh = (paneID: string, tabID: string, url: string, isPrivate: boolean): Entry<V, R> => ({
        id: tabID,
        view: hooks.create({ paneID, tabID, url, isPrivate }),
        discarded: null
    });

    const build = (spec: RegistryPaneSpec): MutablePane<V, R> => {
        const pane: MutablePane<V, R> = {
            paneID: spec.paneID,
            isPrivate: spec.isPrivate,
            tabs: [],
            activeTabID: spec.activeTabID
        };
        for (const tab of spec.tabs) pane.tabs.push(fresh(spec.paneID, tab.id, tab.url, spec.isPrivate));
        applyVisibility(pane);
        return pane;
    };

    return {
        openPane(spec) {
            const existing = panes.get(spec.paneID);
            if (existing === undefined) {
                panes.set(spec.paneID, build(spec));
                return;
            }
            if (existing.isPrivate !== spec.isPrivate) {
                // The partition is sealed into the views: the only way to change it is a rebuild.
                destroyPane(existing, 'private-flip');
                panes.set(spec.paneID, build(spec));
                return;
            }
            // Reconcile in place so a re-announced pane keeps its live pages, and its discarded
            // tabs stay discarded (#467): a host registration is not a reason to load them.
            const wanted = new Map(spec.tabs.map((tab) => [tab.id, tab]));
            for (const tab of [...existing.tabs]) {
                if (wanted.has(tab.id)) continue;
                existing.tabs = existing.tabs.filter((candidate) => candidate !== tab);
                destroyEntry(tab, 'reconcile');
            }
            const byID = new Map(existing.tabs.map((tab) => [tab.id, tab]));
            existing.tabs = spec.tabs.map(
                (tab) => byID.get(tab.id) ?? fresh(spec.paneID, tab.id, tab.url, spec.isPrivate)
            );
            existing.activeTabID = spec.activeTabID;
            applyVisibility(existing);
        },

        closePane(paneID) {
            const pane = panes.get(paneID);
            if (pane === undefined) return false;
            panes.delete(paneID);
            destroyPane(pane, 'pane-close');
            return true;
        },

        setPrivate(spec) {
            const existing = panes.get(spec.paneID);
            if (existing !== undefined) destroyPane(existing, 'private-flip');
            panes.set(spec.paneID, build(spec));
        },

        openTab(paneID, tabID, url, makeActive) {
            const pane = panes.get(paneID);
            if (pane === undefined) return false;
            // §5: a duplicate tab id is dropped rather than creating a second view for it.
            if (pane.tabs.some((tab) => tab.id === tabID)) return false;
            pane.tabs.push(fresh(paneID, tabID, url, pane.isPrivate));
            if (makeActive) pane.activeTabID = tabID;
            applyVisibility(pane);
            return true;
        },

        closeTab(paneID, tabID) {
            const pane = panes.get(paneID);
            if (pane === undefined) return false;
            const tab = pane.tabs.find((candidate) => candidate.id === tabID);
            if (tab === undefined) return false;
            const index = pane.tabs.indexOf(tab);
            pane.tabs = pane.tabs.filter((candidate) => candidate !== tab);
            destroyEntry(tab, 'tab-close');
            if (pane.activeTabID === tabID) {
                // §5: the LEFT neighbour takes over.
                const next = pane.tabs[Math.max(index - 1, 0)];
                pane.activeTabID = next?.id ?? null;
            }
            applyVisibility(pane);
            return true;
        },

        selectTab(paneID, tabID) {
            const pane = panes.get(paneID);
            if (pane === undefined) return false;
            if (!pane.tabs.some((tab) => tab.id === tabID)) return false;
            if (pane.activeTabID === tabID) return true;
            pane.activeTabID = tabID;
            applyVisibility(pane);
            return true;
        },

        forgetTab(paneID, tabID) {
            const pane = panes.get(paneID);
            if (pane === undefined) return false;
            const tab = pane.tabs.find((candidate) => candidate.id === tabID);
            // A discarded tab has no renderer to lose (#467).
            if (tab === undefined || tab.view === null) return false;
            const index = pane.tabs.indexOf(tab);
            pane.tabs = pane.tabs.filter((candidate) => candidate !== tab);
            // Issue #76: the view object outlives its renderer, so it has to be taken down like
            // any other. The hook is written to survive a half-dead view (every step is guarded)
            // because that is the only state it is ever called in from here. It is also what
            // takes the view off the screen, which is #72's requirement of this path.
            destroyEntry(tab, 'renderer-gone');
            if (pane.activeTabID === tabID) {
                const next = pane.tabs[Math.max(index - 1, 0)];
                pane.activeTabID = next?.id ?? null;
            }
            applyVisibility(pane);
            return true;
        },

        discard(paneID, tabID, record) {
            const found = entryOf(paneID, tabID);
            if (found === null || found.entry.view === null) return false;
            const view = found.entry.view;
            // The record first: a lookup made while the view is being taken down already sees a
            // discarded tab rather than a view on its way out.
            found.entry.view = null;
            found.entry.discarded = record;
            hooks.destroy(view, 'discard');
            return true;
        },

        restore(paneID, tabID) {
            const found = entryOf(paneID, tabID);
            if (found === null) return null;
            const { pane, entry } = found;
            if (entry.view !== null) return entry.view;
            const record = entry.discarded;
            if (record === null) return null;
            entry.view = hooks.create({
                paneID,
                tabID: entry.id,
                url: record.url,
                isPrivate: pane.isPrivate,
                restore: record.restore
            });
            entry.discarded = null;
            hooks.show(entry.view, entry === resolveActive(pane));
            return entry.view;
        },

        discarded(paneID, tabID) {
            return entryOf(paneID, tabID)?.entry.discarded ?? null;
        },

        tabIDs(paneID) {
            return panes.get(paneID)?.tabs.map((tab) => tab.id) ?? [];
        },

        view(paneID, tabID) {
            return entryOf(paneID, tabID)?.entry.view ?? null;
        },

        activeView(paneID) {
            return entryOf(paneID, null)?.entry.view ?? null;
        },

        activeTabID(paneID) {
            const pane = panes.get(paneID);
            if (pane === undefined) return null;
            return resolveActive(pane)?.id ?? null;
        },

        pane(paneID) {
            const pane = panes.get(paneID);
            if (pane === undefined) return null;
            return {
                paneID: pane.paneID,
                isPrivate: pane.isPrivate,
                tabs: live(pane),
                activeTabID: pane.activeTabID
            };
        },

        paneIDs() {
            return [...panes.keys()];
        },

        locate(predicate) {
            for (const pane of panes.values()) {
                for (const tab of live(pane)) {
                    if (predicate(tab.view)) return { paneID: pane.paneID, tabID: tab.id, view: tab.view };
                }
            }
            return null;
        },

        dispose() {
            for (const pane of [...panes.values()]) destroyPane(pane, 'dispose');
            panes.clear();
        }
    };
}
