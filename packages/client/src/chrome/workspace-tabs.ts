/**
 * The title bar's tabs, as data (workspace-feature.md §12, shell-ui.md §3.3).
 *
 * One view per tab of the active workspace: what the tab is called, what kind of pane it is
 * named after, its busiest status, how many panes it holds and the states the bar draws
 * (on screen, needs attention, never visited, zoomed). Pure, so the bar, the phone's chip row
 * and the tests all read the same answers.
 */

import {
    activeTabIDOf,
    onScreenPaneIDs,
    paneTabTitle,
    tabLayout,
    tabPaneIDs,
    workspaceTabs,
    type Pane,
    type WorkspaceState
} from '@kelpi/daemon/store';

export type WorkspaceTabKind = 'terminal' | 'agent' | 'web' | 'document' | 'scratchpad' | 'image';
export type WorkspaceTabStatus = 'idle' | 'running' | 'waitingForInput';

export interface WorkspaceTabView {
    readonly id: string;
    /** 0-based position; ⌥⌘1-9 count from 1. */
    readonly index: number;
    readonly title: string;
    /** True when the user named it; false = named after its focused pane. */
    readonly named: boolean;
    readonly kind: WorkspaceTabKind;
    /** The busiest pane wins: waiting, then running, then idle. */
    readonly status: WorkspaceTabStatus;
    readonly paneCount: number;
    readonly paneIDs: readonly string[];
    readonly active: boolean;
    /** A background tab with a pane waiting for input, in a workspace that is not muted. */
    readonly attention: boolean;
    /** Opened in the background (an agent's tab) and not yet shown. */
    readonly unvisited: boolean;
    readonly zoomed: boolean;
}

const ON_SCREEN = new WeakMap<WorkspaceState, readonly Pane[]>();

/**
 * The panes of the tab on screen, for a pane grid: the lane holds every tab's panes, and a grid
 * mounts (hidden) any pane it is handed that the layout does not place. Cached per workspace
 * object (the mirror never mutates one), so a grid sees the same array until the workspace moves.
 */
export function onScreenPanes(workspace: WorkspaceState): readonly Pane[] {
    const cached = ON_SCREEN.get(workspace);
    if (cached !== undefined) return cached;
    const ids = new Set(onScreenPaneIDs(workspace));
    const panes = ids.size === workspace.panes.length ? workspace.panes : workspace.panes.filter((pane) => ids.has(pane.id));
    ON_SCREEN.set(workspace, panes);
    return panes;
}

function kindOf(pane: Pane | undefined): WorkspaceTabKind {
    if (pane === undefined) return 'terminal';
    switch (pane.type) {
        case 'shell':
            return pane.agentKind !== null && pane.agentSessionID !== null ? 'agent' : 'terminal';
        case 'web':
            return 'web';
        case 'scratchpad':
            return 'scratchpad';
        case 'image':
            return 'image';
        default:
            return 'document';
    }
}

/** What a tab named after `pane` is called; the daemon's rule, so `kelpi tab` finds tabs by it. */
export { paneTabTitle };

function busiest(panes: readonly (Pane | undefined)[]): WorkspaceTabStatus {
    if (panes.some((pane) => pane?.status === 'waitingForInput')) return 'waitingForInput';
    if (panes.some((pane) => pane?.status === 'running')) return 'running';
    return 'idle';
}

export function workspaceTabViews(workspace: WorkspaceState): WorkspaceTabView[] {
    const byID = new Map(workspace.panes.map((pane) => [pane.id, pane]));
    const activeID = activeTabIDOf(workspace);
    return workspaceTabs(workspace).map((tab, index) => {
        const tuple = tabLayout(workspace, tab);
        const paneIDs = tabPaneIDs(workspace, tab);
        const panes = paneIDs.map((id) => byID.get(id));
        const focused = byID.get(tuple.focusedPaneID ?? '') ?? panes.find((pane) => pane !== undefined);
        const status = busiest(panes);
        const active = tab.id === activeID;
        return {
            id: tab.id,
            index,
            title: tab.name ?? paneTabTitle(workspace, focused),
            named: tab.name !== null,
            kind: kindOf(focused),
            status,
            paneCount: paneIDs.length,
            paneIDs,
            active,
            attention: !active && !workspace.muted && status === 'waitingForInput',
            unvisited: !tab.seen && !active,
            zoomed: tuple.zoomedPaneID !== null
        };
    });
}

/** The close-tab gate's count (workspace-feature.md §12.5), shared with the CLI's refusal. */
export { tabsAgentSummary } from '@kelpi/daemon/store';
