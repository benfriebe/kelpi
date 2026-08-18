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

export interface CreateTabInput {
    readonly paneID: string;
    readonly tabID: string;
    readonly url: string;
    readonly isPrivate: boolean;
}

export type DestroyReason = 'tab-close' | 'pane-close' | 'private-flip' | 'reconcile' | 'dispose';

export interface RegistryHooks<V> {
    /** Build the view and start loading `url` (an empty URL loads nothing). */
    create(input: CreateTabInput): V;
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
    readonly tabs: readonly RegistryTab<V>[];
    /** May be stale for an instant after a close; read `activeView` for the resolved tab. */
    readonly activeTabID: string | null;
}

export interface TabRegistry<V> {
    openPane(spec: RegistryPaneSpec): void;
    closePane(paneID: string): boolean;
    setPrivate(spec: RegistryPaneSpec): void;
    openTab(paneID: string, tabID: string, url: string, makeActive: boolean): boolean;
    closeTab(paneID: string, tabID: string): boolean;
    selectTab(paneID: string, tabID: string): boolean;
    /** Drop a tab whose view died on its own (crash, `window.close()`) — nothing to destroy. */
    forgetTab(paneID: string, tabID: string): boolean;
    view(paneID: string, tabID: string): V | null;
    /** §17.2: the active tab always falls back to `tabs[0]`. */
    activeView(paneID: string): V | null;
    activeTabID(paneID: string): string | null;
    pane(paneID: string): RegistryPane<V> | null;
    paneIDs(): readonly string[];
    /** Reverse lookup for view-driven events (a `did-navigate` knows only its view). */
    locate(predicate: (view: V) => boolean): { paneID: string; tabID: string; view: V } | null;
    dispose(): void;
}

interface MutablePane<V> {
    paneID: string;
    isPrivate: boolean;
    tabs: RegistryTab<V>[];
    activeTabID: string | null;
}

export function createTabRegistry<V>(hooks: RegistryHooks<V>): TabRegistry<V> {
    const panes = new Map<string, MutablePane<V>>();

    const resolveActive = (pane: MutablePane<V>): RegistryTab<V> | null => {
        const named = pane.tabs.find((tab) => tab.id === pane.activeTabID);
        if (named !== undefined) return named;
        return pane.tabs[0] ?? null;
    };

    /** Exactly one visible view per pane, recomputed after every mutation. */
    const applyVisibility = (pane: MutablePane<V>): void => {
        const active = resolveActive(pane);
        for (const tab of pane.tabs) hooks.show(tab.view, tab === active);
    };

    const destroyPane = (pane: MutablePane<V>, reason: DestroyReason): void => {
        for (const tab of pane.tabs) hooks.destroy(tab.view, reason);
        pane.tabs = [];
    };

    const build = (spec: RegistryPaneSpec): MutablePane<V> => {
        const pane: MutablePane<V> = {
            paneID: spec.paneID,
            isPrivate: spec.isPrivate,
            tabs: [],
            activeTabID: spec.activeTabID
        };
        for (const tab of spec.tabs) {
            pane.tabs.push({
                id: tab.id,
                view: hooks.create({
                    paneID: spec.paneID,
                    tabID: tab.id,
                    url: tab.url,
                    isPrivate: spec.isPrivate
                })
            });
        }
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
            // Reconcile in place so a re-announced pane keeps its live pages.
            const wanted = new Map(spec.tabs.map((tab) => [tab.id, tab]));
            for (const tab of [...existing.tabs]) {
                if (wanted.has(tab.id)) continue;
                hooks.destroy(tab.view, 'reconcile');
                existing.tabs = existing.tabs.filter((candidate) => candidate !== tab);
            }
            const byID = new Map(existing.tabs.map((tab) => [tab.id, tab]));
            existing.tabs = spec.tabs.map((tab) => {
                const known = byID.get(tab.id);
                if (known !== undefined) return known;
                return {
                    id: tab.id,
                    view: hooks.create({
                        paneID: spec.paneID,
                        tabID: tab.id,
                        url: tab.url,
                        isPrivate: spec.isPrivate
                    })
                };
            });
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
            pane.tabs.push({
                id: tabID,
                view: hooks.create({ paneID, tabID, url, isPrivate: pane.isPrivate })
            });
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
            hooks.destroy(tab.view, 'tab-close');
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
            if (tab === undefined) return false;
            const index = pane.tabs.indexOf(tab);
            pane.tabs = pane.tabs.filter((candidate) => candidate !== tab);
            if (pane.activeTabID === tabID) {
                const next = pane.tabs[Math.max(index - 1, 0)];
                pane.activeTabID = next?.id ?? null;
            }
            applyVisibility(pane);
            return true;
        },

        view(paneID, tabID) {
            const pane = panes.get(paneID);
            if (pane === undefined) return null;
            return pane.tabs.find((tab) => tab.id === tabID)?.view ?? null;
        },

        activeView(paneID) {
            const pane = panes.get(paneID);
            if (pane === undefined) return null;
            return resolveActive(pane)?.view ?? null;
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
                tabs: [...pane.tabs],
                activeTabID: pane.activeTabID
            };
        },

        paneIDs() {
            return [...panes.keys()];
        },

        locate(predicate) {
            for (const pane of panes.values()) {
                for (const tab of pane.tabs) {
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
