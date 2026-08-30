/**
 * Web-pane reducers: the tab list, the active tab, the private flag and the pane-header title.
 *
 * Spec: docs/current/web-pane.md §5 (tabs), §4.2/§4.4 (navigate + URL/title mirroring),
 * §6 (private mode), §17 (invariants).
 *
 * The split of ownership in the port: **the daemon owns this state** (it persists, it is what
 * `kelpi web tabs` reads, it survives the shell restarting), while the actual browser views live
 * in the Electron shell and are driven over the host RPC channel (`daemon/src/webpane/`). So
 * every action here is a pure state mutation; the forwarding to a real page is the handler's
 * job, never the reducer's.
 *
 * Invariants preserved from the Swift app:
 *  - `activeTab` is always resolved with a `tabs.first` fallback (§17.2) — `activeTabID` may be
 *    momentarily stale after a close, and every consumer shares the fallback;
 *  - duplicate tab ids are rejected on open (§17.1);
 *  - closing the active tab activates the LEFT neighbour (`max(idx-1, 0)` of the new array);
 *  - the pane header title tracks the resolved active tab's display label ("Web" when there is
 *    no tab at all);
 *  - a URL update of `""` / `about:blank` is a placeholder and never overwrites a real URL
 *    (§4.4) — titles are always taken.
 */

import type { WebTab } from '@kelpi/core/codec';

import type { DaemonState, DomainAction, WebPaneState, WorkspaceState } from '../types.js';
import { mutateVisiblePane, updateWorkspace } from './helpers.js';
import { normalizeURLInput } from './url.js';

/** §2 `displayLabel(tab)`: title, else host, else url, else "New Tab". */
export function tabDisplayLabel(tab: WebTab): string {
    if (tab.title !== '') return tab.title;
    const host = hostOf(tab.url);
    if (host !== null && host !== '') return host;
    if (tab.url !== '') return tab.url;
    return 'New Tab';
}

function hostOf(url: string): string | null {
    if (url === '') return null;
    try {
        return new URL(url).hostname;
    } catch {
        return null;
    }
}

/** §17.2: the active tab, always with the `tabs[0]` fallback. */
export function resolvedActiveTab(web: WebPaneState): WebTab | null {
    if (web.tabs.length === 0) return null;
    const active = web.tabs.find((tab) => tab.id === web.activeTabID);
    return active ?? (web.tabs[0] as WebTab);
}

function sidecarOf(workspace: WorkspaceState, paneID: string): WebPaneState | null {
    return workspace.webPanes[paneID] ?? null;
}

function withSidecar(
    workspace: WorkspaceState,
    paneID: string,
    next: WebPaneState
): WorkspaceState {
    return { ...workspace, webPanes: { ...workspace.webPanes, [paneID]: next } };
}

/** `syncWebPaneHeader` (§4.4): the pane title mirrors the resolved active tab. */
function syncHeader(workspace: WorkspaceState, paneID: string): WorkspaceState {
    const web = sidecarOf(workspace, paneID);
    if (web === null) return workspace;
    const active = resolvedActiveTab(web);
    const title = active === null ? 'Web' : tabDisplayLabel(active);
    return mutateVisiblePane(workspace, paneID, (pane) =>
        pane.title === title ? pane : { ...pane, title }
    );
}

function openTab(
    workspace: WorkspaceState,
    action: Extract<DomainAction, { type: 'web-tab-open' }>
): WorkspaceState {
    const web = sidecarOf(workspace, action.paneID);
    if (web === null) return workspace;
    // §5: a duplicate tab id is dropped (the initiator minted it; a repeat is a replay).
    if (web.tabs.some((tab) => tab.id === action.tabID)) return workspace;
    const tab: WebTab = { id: action.tabID, url: normalizeURLInput(action.url), title: '' };
    const makeActive = action.makeActive ?? true;
    const next: WebPaneState = {
        ...web,
        tabs: [...web.tabs, tab],
        activeTabID: makeActive ? action.tabID : web.activeTabID
    };
    return syncHeader(withSidecar(workspace, action.paneID, next), action.paneID);
}

function closeTab(
    workspace: WorkspaceState,
    action: Extract<DomainAction, { type: 'web-tab-close' }>
): WorkspaceState {
    const web = sidecarOf(workspace, action.paneID);
    if (web === null) return workspace;
    const index = web.tabs.findIndex((tab) => tab.id === action.tabID);
    if (index < 0) return workspace;
    // The wire refuses this case with an error and the GUI turns it into a whole-pane close;
    // the reducer simply refuses to leave a web pane in a state no caller asked for.
    if (web.tabs.length === 1) return workspace;

    const tabs = web.tabs.filter((tab) => tab.id !== action.tabID);
    const wasActive = (web.activeTabID ?? web.tabs[0]?.id) === action.tabID;
    const neighbour = tabs[Math.max(index - 1, 0)];
    const next: WebPaneState = {
        ...web,
        tabs,
        activeTabID: wasActive ? (neighbour?.id ?? null) : web.activeTabID
    };
    return syncHeader(withSidecar(workspace, action.paneID, next), action.paneID);
}

function selectTab(
    workspace: WorkspaceState,
    action: Extract<DomainAction, { type: 'web-tab-select' }>
): WorkspaceState {
    const web = sidecarOf(workspace, action.paneID);
    if (web === null) return workspace;
    if (!web.tabs.some((tab) => tab.id === action.tabID)) return workspace;
    if (web.activeTabID === action.tabID) return workspace;
    const next: WebPaneState = { ...web, activeTabID: action.tabID };
    return syncHeader(withSidecar(workspace, action.paneID, next), action.paneID);
}

/**
 * WEB-016: reorder only when the supplied sequence is an **exact permutation** of the pane's
 * current tabs. A sequence that drops, duplicates or invents an id is dropped whole rather than
 * applied partially — a truncating reorder would silently destroy tabs (and their live views,
 * which the host still holds) on a mis-sent drag.
 */
function reorderTabs(
    workspace: WorkspaceState,
    action: Extract<DomainAction, { type: 'web-tab-reorder' }>
): WorkspaceState {
    const web = sidecarOf(workspace, action.paneID);
    if (web === null) return workspace;
    const current = web.tabs.map((tab) => tab.id);
    if (action.order.length !== current.length) return workspace;
    const wanted = new Set(action.order);
    // Set sizes catch a duplicate; the membership walk catches an unknown id.
    if (wanted.size !== current.length) return workspace;
    if (!current.every((id) => wanted.has(id))) return workspace;
    if (action.order.every((id, index) => id === current[index])) return workspace;
    const byID = new Map(web.tabs.map((tab) => [tab.id, tab]));
    const tabs = action.order.map((id) => byID.get(id) as WebTab);
    return withSidecar(workspace, action.paneID, { ...web, tabs });
}

function navigate(
    workspace: WorkspaceState,
    action: Extract<DomainAction, { type: 'web-navigate' }>
): WorkspaceState {
    const web = sidecarOf(workspace, action.paneID);
    if (web === null) return workspace;
    const active = resolvedActiveTab(web);
    if (active === null) return workspace;
    const url = normalizeURLInput(action.url);
    if (url === '' || url === active.url) return workspace;
    // §4.2: the normalized URL is written optimistically so a save right now persists intent.
    const next: WebPaneState = {
        ...web,
        tabs: web.tabs.map((tab) => (tab.id === active.id ? { ...tab, url } : tab))
    };
    return syncHeader(withSidecar(workspace, action.paneID, next), action.paneID);
}

function setPrivate(
    workspace: WorkspaceState,
    action: Extract<DomainAction, { type: 'web-set-private' }>
): WorkspaceState {
    const web = sidecarOf(workspace, action.paneID);
    if (web === null || web.isPrivate === action.isPrivate) return workspace;
    return withSidecar(workspace, action.paneID, { ...web, isPrivate: action.isPrivate });
}

function tabState(
    workspace: WorkspaceState,
    action: Extract<DomainAction, { type: 'web-tab-state' }>
): WorkspaceState {
    const web = sidecarOf(workspace, action.paneID);
    if (web === null) return workspace;
    const current = web.tabs.find((tab) => tab.id === action.tabID);
    if (current === undefined) return workspace;

    // §4.4 placeholder guard: `""` / `about:blank` show up early in loads and after failures
    // and must not wipe the URL bar or the persisted URL. Titles are always taken.
    const url =
        action.url === undefined || action.url === '' || action.url === 'about:blank'
            ? current.url
            : action.url;
    const title = action.title ?? current.title;
    if (url === current.url && title === current.title) return workspace;

    const next: WebPaneState = {
        ...web,
        tabs: web.tabs.map((tab) => (tab.id === action.tabID ? { ...tab, url, title } : tab))
    };
    return syncHeader(withSidecar(workspace, action.paneID, next), action.paneID);
}

export function reduceWebAction(state: DaemonState, action: DomainAction): DaemonState {
    switch (action.type) {
        case 'web-tab-open':
            return updateWorkspace(state, action.workspaceID, (workspace) =>
                openTab(workspace, action)
            );
        case 'web-tab-close':
            return updateWorkspace(state, action.workspaceID, (workspace) =>
                closeTab(workspace, action)
            );
        case 'web-tab-select':
            return updateWorkspace(state, action.workspaceID, (workspace) =>
                selectTab(workspace, action)
            );
        case 'web-tab-reorder':
            return updateWorkspace(state, action.workspaceID, (workspace) =>
                reorderTabs(workspace, action)
            );
        case 'web-navigate':
            return updateWorkspace(state, action.workspaceID, (workspace) =>
                navigate(workspace, action)
            );
        case 'web-set-private':
            return updateWorkspace(state, action.workspaceID, (workspace) =>
                setPrivate(workspace, action)
            );
        case 'web-tab-state':
            return updateWorkspace(state, action.workspaceID, (workspace) =>
                tabState(workspace, action)
            );
        default:
            return state;
    }
}
