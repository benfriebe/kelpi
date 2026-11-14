/**
 * What a workspace tab is called and how busy it is (workspace-feature.md §12): the one answer
 * the window's tab bar, the phone's chips and the control socket's `workspace-tab-list` all
 * give, so `kelpi tab select build` finds the tab the bar calls "build".
 */

import type { Pane } from '@kelpi/core/layout';

import { resolvedActiveTab, tabDisplayLabel } from './reducers/web.js';
import { tabLayout, tabPaneIDs } from './tabs.js';
import type { WorkspaceState, WorkspaceTab } from './types.js';

export type WorkspaceTabStatus = 'idle' | 'running' | 'waitingForInput';

function basename(path: string): string {
    const parts = path.split('/').filter((part) => part.length > 0);
    return parts.length === 0 ? path : (parts[parts.length - 1] as string);
}

/** What a tab named after `pane` is called: its label, else what its header would say, shortened. */
export function paneTabTitle(workspace: WorkspaceState, pane: Pane | undefined): string {
    if (pane === undefined) return 'Tab';
    if (pane.label !== null && pane.label !== '') return pane.label;
    switch (pane.type) {
        case 'shell': {
            if (pane.agentSessionID !== null && pane.agentKind !== null) return pane.agentKind;
            // A shell's title is usually its directory or the command it runs; either way the
            // last path component is the part that tells tabs apart.
            const fromTitle = basename((pane.title ?? '').trim());
            if (fromTitle !== '') return fromTitle;
            return basename(pane.workingDirectory) || 'Terminal';
        }
        case 'web': {
            const sidecar = workspace.webPanes[pane.id];
            const tab = sidecar === undefined ? null : resolvedActiveTab(sidecar);
            return tab === null ? 'New Tab' : tabDisplayLabel(tab);
        }
        case 'plugin':
            return pane.title ?? 'Plugin view';
        case 'scratchpad':
            return 'Scratchpad';
        case 'markdown':
        case 'csv':
        case 'image':
            return basename(pane.filePath ?? pane.workingDirectory);
        case 'diff': {
            // Empty-as-unscoped, as the pane header reads it: a diff of the whole repository is
            // named after the repository's directory.
            const target = pane.filePath ?? '';
            return `diff: ${basename(target === '' ? pane.workingDirectory : target)}`;
        }
    }
}

/** The pane a tab is named after: the one focused in it, else its first. */
export function tabTitlePane(workspace: WorkspaceState, tab: WorkspaceTab): Pane | undefined {
    const byID = new Map(workspace.panes.map((pane) => [pane.id, pane]));
    const focused = tabLayout(workspace, tab).focusedPaneID;
    if (focused !== null && byID.has(focused)) return byID.get(focused);
    for (const id of tabPaneIDs(workspace, tab)) {
        const pane = byID.get(id);
        if (pane !== undefined) return pane;
    }
    return undefined;
}

/** What the tab bar shows for `tab`: its name, else its focused pane's. */
export function workspaceTabTitle(workspace: WorkspaceState, tab: WorkspaceTab): string {
    return tab.name ?? paneTabTitle(workspace, tabTitlePane(workspace, tab));
}

/** The busiest of a tab's panes: waiting, then running, then idle. */
export function workspaceTabStatus(workspace: WorkspaceState, tab: WorkspaceTab): WorkspaceTabStatus {
    const ids = new Set(tabPaneIDs(workspace, tab));
    const panes = workspace.panes.filter((pane) => ids.has(pane.id));
    if (panes.some((pane) => pane.status === 'waitingForInput')) return 'waitingForInput';
    if (panes.some((pane) => pane.status === 'running')) return 'running';
    return 'idle';
}
