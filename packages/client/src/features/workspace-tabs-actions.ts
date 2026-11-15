/**
 * The window's workspace-tab intents (workspace-feature.md §12): the title bar, the keyboard,
 * the native menu, the palette and the pane menus all raise these, and each is one WS verb
 * (`daemon/src/ws/workspace-tabs.ts`). Tab state itself is daemon state; nothing here is
 * optimistic.
 */

import { activeTabIDOf, onScreenPaneIDs, tabByID, tabPaneIDs, workspaceTabs, type WorkspaceState } from '@kelpi/daemon/store';
import { wireEdgeForDropZone, type WireMoveEdge } from '@kelpi/core/layout';
import type { TabDropTarget } from '../chrome/tab-drop';
import { wirePayload, type CommandClient, type CommandReply } from '../connection/commands';
import type { KelpiRuntime } from '../state';

/**
 * The close-tab gate's setting, read and written on the daemon the workspace belongs to: a paired
 * daemon's workspace asks under that daemon's `confirm-workspace-delete`, and its "Don't ask
 * again" turns that one off (workspace-feature.md §12.5).
 */
export interface TabCloseOwner {
    readonly confirmWhenActive: () => boolean;
    readonly suppress: () => void;
}

export function tabCloseOwner(runtime: Pick<KelpiRuntime, 'store' | 'commands'>): TabCloseOwner {
    return {
        confirmWhenActive: () => runtime.store.getState().settings.value.general.confirmWorkspaceDeleteWhenActive,
        suppress: () => {
            void runtime.commands.setGeneralSetting({ key: 'confirm-workspace-delete', value: 'false' });
        }
    };
}

export type NewTabKind = 'terminal' | 'same' | 'agent' | 'web' | 'scratchpad';

export interface WorkspaceTabActionHost {
    readonly commands: Pick<CommandClient, 'raw'>;
    readonly activeWorkspace: () => WorkspaceState | null;
    readonly focusedPaneID: () => string | null;
    readonly run: (label: string, command: Promise<CommandReply>) => boolean;
    /**
     * Closing these tabs closes their panes: the host may ask first (agents in them) and call
     * `close` itself once confirmed. Absent, they close at once.
     */
    readonly confirmClose?:
        | ((workspace: WorkspaceState, tabIDs: readonly string[], close: () => boolean, owner?: TabCloseOwner) => boolean)
        | undefined;
    /** The daemon the workspace belongs to, when it is not this window's (a paired one). */
    readonly closeOwner?: (() => TabCloseOwner | undefined) | undefined;
    /** The daemon's workspaces the target workspace lives among (Move Tab to Workspace). */
    readonly workspaces?: (() => readonly WorkspaceState[]) | undefined;
}

export interface WorkspaceTabActions {
    /** No kind = Settings ▸ Workspaces "A new tab opens" (the daemon decides). */
    newTab(kind?: NewTabKind, index?: number): boolean;
    /** `force`: ask even when the window already shows that tab (a spring going home). */
    selectTab(tabID: string, force?: boolean): boolean;
    /** A tab of a named workspace of the same daemon, on screen or not (a spring going home). */
    selectTabInWorkspace(workspaceID: string, tabID: string): boolean;
    /** ⌥⌘] / ⌥⌘[: the next or previous tab, wrapping. */
    selectTabStep(delta: 1 | -1): boolean;
    /** ⌥⌘1-9: the Nth tab (1-based); false when there is no such tab. */
    selectTabNumber(number: number): boolean;
    closeTab(tabID: string): boolean;
    /** ⌥⌘W: the tab on screen, unless it is the only one. */
    closeActiveTab(): boolean;
    closeOtherTabs(tabID: string): boolean;
    renameTab(tabID: string, name: string | null): boolean;
    moveTab(tabID: string, index: number): boolean;
    movePaneToNewTab(paneID: string, index?: number): boolean;
    /** ⇧⌥⌘T: the focused pane, when its tab holds others. */
    moveFocusedPaneToNewTab(): boolean;
    movePaneToTab(paneID: string, tabID: string, targetPaneID?: string, zone?: WireMoveEdge): boolean;
    /** A pane dropped on the title bar or into a tab a drag opened (`chrome/tab-drop.ts`). */
    movePaneOntoTab(paneID: string, target: TabDropTarget): boolean;
    splitTabPanes(tabID: string): boolean;
    mergeTabIntoPrevious(tabID: string): boolean;
    moveTabToWorkspace(tabID: string, workspaceID: string): boolean;
    /** A copy of the tab just after it: the same layout, with new panes of the same kinds. */
    duplicateTab(tabID: string): boolean;
    /** The palette's Duplicate Tab: the tab on screen. */
    duplicateActiveTab(): boolean;
    /** The palette's rows for the tab on screen (the tab menu's, for the keyboard). */
    closeOtherTabsOnScreen(): boolean;
    mergeActiveTabIntoPrevious(): boolean;
    splitActiveTabPanes(): boolean;
    moveActiveTabToWorkspace(workspaceID: string): boolean;
    /** The workspaces Move Tab to Workspace offers: the tab's daemon's others, in its order. */
    moveTabTargets(): readonly { readonly id: string; readonly name: string }[];
}

export function createWorkspaceTabActions(host: WorkspaceTabActionHost): WorkspaceTabActions {
    const send = (label: string, command: string, fields: Record<string, string | number | boolean | null | undefined>): boolean =>
        host.run(label, host.commands.raw(wirePayload(command, fields)));

    const withWorkspace = (body: (workspace: WorkspaceState) => boolean): boolean => {
        const workspace = host.activeWorkspace();
        return workspace === null ? false : body(workspace);
    };

    const tabAt = (workspace: WorkspaceState, index: number): string | null => workspaceTabs(workspace)[index]?.id ?? null;

    /** The workspace holding this tab: the one on screen, else another of the same daemon. */
    const withTabOwner = (tabID: string, body: (workspace: WorkspaceState) => boolean): boolean => {
        const active = host.activeWorkspace();
        if (active !== null && workspaceTabs(active).some((tab) => tab.id === tabID)) return body(active);
        const owner = (host.workspaces?.() ?? []).find((workspace) => workspaceTabs(workspace).some((tab) => tab.id === tabID));
        return owner === undefined ? false : body(owner);
    };

    const gateClose = (workspace: WorkspaceState, tabIDs: readonly string[], close: () => boolean): boolean =>
        host.confirmClose === undefined || tabIDs.length === 0 ? close() : host.confirmClose(workspace, tabIDs, close, host.closeOwner?.());

    const select = (workspace: WorkspaceState, tabID: string | null, force = false): boolean => {
        if (tabID === null) return false;
        // Selecting the tab already on screen is a no-op, but still the key's (it is handled).
        if (!force && tabID === activeTabIDOf(workspace)) return true;
        return send('Switch tab', 'workspace-tab-select', { workspace_id: workspace.id, tab_id: tabID });
    };

    const actions: WorkspaceTabActions = {
        newTab(kind, index) {
            return withWorkspace((workspace) =>
                send('New tab', 'workspace-tab-new', { workspace_id: workspace.id, kind, index })
            );
        },
        selectTab(tabID, force) {
            return withWorkspace((workspace) => select(workspace, tabID, force === true));
        },
        selectTabInWorkspace(workspaceID, tabID) {
            return send('Switch tab', 'workspace-tab-select', { workspace_id: workspaceID, tab_id: tabID });
        },
        selectTabStep(delta) {
            return withWorkspace((workspace) => {
                const tabs = workspaceTabs(workspace);
                if (tabs.length <= 1) return false;
                const at = tabs.findIndex((tab) => tab.id === activeTabIDOf(workspace));
                return select(workspace, tabAt(workspace, (at + delta + tabs.length) % tabs.length));
            });
        },
        selectTabNumber(number) {
            return withWorkspace((workspace) => select(workspace, tabAt(workspace, number - 1)));
        },
        closeTab(tabID) {
            return withWorkspace((workspace) =>
                workspaceTabs(workspace).length <= 1
                    ? false
                    : gateClose(workspace, [tabID], () =>
                          send('Close tab', 'workspace-tab-close', { workspace_id: workspace.id, tab_id: tabID })
                      )
            );
        },
        closeActiveTab() {
            return withWorkspace((workspace) => {
                if (workspaceTabs(workspace).length <= 1) return false;
                const tabID = activeTabIDOf(workspace);
                return gateClose(workspace, [tabID], () =>
                    send('Close tab', 'workspace-tab-close', { workspace_id: workspace.id, tab_id: tabID })
                );
            });
        },
        closeOtherTabs(tabID) {
            return withWorkspace((workspace) => {
                const others = workspaceTabs(workspace)
                    .map((tab) => tab.id)
                    .filter((id) => id !== tabID);
                return gateClose(workspace, others, () =>
                    send('Close other tabs', 'workspace-tab-close-others', { workspace_id: workspace.id, tab_id: tabID })
                );
            });
        },
        renameTab(tabID, name) {
            // By the tab's own workspace: a rename committed as its field went away can land after
            // another workspace came on screen.
            return withTabOwner(tabID, (workspace) =>
                send('Rename tab', 'workspace-tab-rename', { workspace_id: workspace.id, tab_id: tabID, name })
            );
        },
        moveTab(tabID, index) {
            return withWorkspace((workspace) =>
                send('Move tab', 'workspace-tab-move', { workspace_id: workspace.id, tab_id: tabID, index })
            );
        },
        movePaneToNewTab(paneID, index) {
            return send('Move to new tab', 'pane-move-to-new-tab', { pane_id: paneID, index });
        },
        moveFocusedPaneToNewTab() {
            return withWorkspace((workspace) => {
                // The focused pane is in the tab on screen; alone there, it already has a tab.
                const paneID = host.focusedPaneID();
                if (paneID === null || onScreenPaneIDs(workspace).length <= 1) return false;
                return send('Move to new tab', 'pane-move-to-new-tab', { pane_id: paneID });
            });
        },
        movePaneToTab(paneID, tabID, targetPaneID, zone) {
            return send('Move to tab', 'pane-move-to-tab', { pane_id: paneID, tab_id: tabID, target_pane_id: targetPaneID, zone });
        },
        movePaneOntoTab(paneID, target) {
            if (target.kind === 'slot') return send('Move to new tab', 'pane-move-to-new-tab', { pane_id: paneID, index: target.index });
            // Beside a pane only when that pane really is in the tab: a release over a grid that
            // still drew another tab must not name a pane the daemon would look for in vain.
            const workspace = host.activeWorkspace();
            const tab = workspace === null ? null : tabByID(workspace, target.tabID);
            const beside =
                target.beside !== undefined && workspace !== null && tab !== null && tabPaneIDs(workspace, tab).includes(target.beside.paneID)
                    ? target.beside
                    : undefined;
            return send('Move to tab', 'pane-move-to-tab', {
                pane_id: paneID,
                tab_id: target.tabID,
                target_pane_id: beside?.paneID,
                zone: beside === undefined ? undefined : wireEdgeForDropZone(beside.zone)
            });
        },
        splitTabPanes(tabID) {
            return withWorkspace((workspace) =>
                send('Give each pane its own tab', 'workspace-tab-split-panes', { workspace_id: workspace.id, tab_id: tabID })
            );
        },
        mergeTabIntoPrevious(tabID) {
            return withWorkspace((workspace) =>
                send('Merge tab', 'workspace-tab-merge-previous', { workspace_id: workspace.id, tab_id: tabID })
            );
        },
        moveTabToWorkspace(tabID, workspaceID) {
            return withWorkspace((workspace) =>
                send('Move tab to workspace', 'workspace-tab-move-to-workspace', {
                    workspace_id: workspace.id,
                    tab_id: tabID,
                    to_workspace_id: workspaceID
                })
            );
        },
        duplicateTab(tabID) {
            return withWorkspace((workspace) =>
                send('Duplicate tab', 'workspace-tab-duplicate', { workspace_id: workspace.id, tab_id: tabID })
            );
        },
        duplicateActiveTab() {
            return withWorkspace((workspace) =>
                send('Duplicate tab', 'workspace-tab-duplicate', { workspace_id: workspace.id, tab_id: activeTabIDOf(workspace) })
            );
        },
        closeOtherTabsOnScreen() {
            return withWorkspace((workspace) => (workspaceTabs(workspace).length <= 1 ? false : actions.closeOtherTabs(activeTabIDOf(workspace))));
        },
        mergeActiveTabIntoPrevious() {
            return withWorkspace((workspace) => {
                const tabID = activeTabIDOf(workspace);
                return workspaceTabs(workspace)[0]?.id === tabID ? false : actions.mergeTabIntoPrevious(tabID);
            });
        },
        splitActiveTabPanes() {
            return withWorkspace((workspace) => (onScreenPaneIDs(workspace).length <= 1 ? false : actions.splitTabPanes(activeTabIDOf(workspace))));
        },
        moveActiveTabToWorkspace(workspaceID) {
            return withWorkspace((workspace) =>
                workspaceID === workspace.id ? false : actions.moveTabToWorkspace(activeTabIDOf(workspace), workspaceID)
            );
        },
        moveTabTargets() {
            const workspace = host.activeWorkspace();
            if (workspace === null) return [];
            return (host.workspaces?.() ?? [])
                .filter((candidate) => candidate.id !== workspace.id)
                .map((candidate) => ({ id: candidate.id, name: candidate.name }));
        }
    };
    return actions;
}
