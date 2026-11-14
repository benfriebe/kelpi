/**
 * The window's workspace-tab intents (workspace-feature.md §12): the title bar, the keyboard,
 * the native menu, the palette and the pane menus all raise these, and each is one WS verb
 * (`daemon/src/ws/workspace-tabs.ts`). Tab state itself is daemon state; nothing here is
 * optimistic.
 */

import { activeTabIDOf, onScreenPaneIDs, workspaceTabs, type WorkspaceState } from '@kelpi/daemon/store';
import { wireEdgeForDropZone, type WireMoveEdge } from '@kelpi/core/layout';
import type { TabDropTarget } from '../chrome/tab-drop';
import { wirePayload, type CommandClient, type CommandReply } from '../connection/commands';

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
    readonly confirmClose?: ((workspace: WorkspaceState, tabIDs: readonly string[], close: () => boolean) => boolean) | undefined;
}

export interface WorkspaceTabActions {
    /** No kind = Settings ▸ Workspaces "A new tab opens" (the daemon decides). */
    newTab(kind?: NewTabKind, index?: number): boolean;
    selectTab(tabID: string): boolean;
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
}

export function createWorkspaceTabActions(host: WorkspaceTabActionHost): WorkspaceTabActions {
    const send = (label: string, command: string, fields: Record<string, string | number | boolean | null | undefined>): boolean =>
        host.run(label, host.commands.raw(wirePayload(command, fields)));

    const withWorkspace = (body: (workspace: WorkspaceState) => boolean): boolean => {
        const workspace = host.activeWorkspace();
        return workspace === null ? false : body(workspace);
    };

    const tabAt = (workspace: WorkspaceState, index: number): string | null => workspaceTabs(workspace)[index]?.id ?? null;

    const gateClose = (workspace: WorkspaceState, tabIDs: readonly string[], close: () => boolean): boolean =>
        host.confirmClose === undefined || tabIDs.length === 0 ? close() : host.confirmClose(workspace, tabIDs, close);

    const select = (workspace: WorkspaceState, tabID: string | null): boolean => {
        if (tabID === null) return false;
        // Selecting the tab already on screen is a no-op, but still the key's (it is handled).
        if (tabID === activeTabIDOf(workspace)) return true;
        return send('Switch tab', 'workspace-tab-select', { workspace_id: workspace.id, tab_id: tabID });
    };

    return {
        newTab(kind, index) {
            return withWorkspace((workspace) =>
                send('New tab', 'workspace-tab-new', { workspace_id: workspace.id, kind, index })
            );
        },
        selectTab(tabID) {
            return withWorkspace((workspace) => select(workspace, tabID));
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
            return withWorkspace((workspace) =>
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
            const beside = target.beside;
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
        }
    };
}
