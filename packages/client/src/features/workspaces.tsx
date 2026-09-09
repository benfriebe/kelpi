/** Bundled Workspaces model, view lifecycle and host binding. */
import { activeAgentCount } from '@kelpi/daemon/store';
import { useCallback, useMemo, useRef, useState, type ReactElement } from 'react';
import { RemoteDaemonSections, type RemoteSelection } from '../app/RemoteDaemonSections';
import type { RemoteDaemonRuntime } from '../app/remote-daemons';
import type { InspectorData } from '../app/inspector';
import { isOkReply, replyError } from '../connection';
import { Sidebar, type SidebarProps, type SidebarSelectionCommands } from '../chrome/Sidebar';
import type { ChromeBucket } from '../chrome/theme';
import { selectActiveWorkspace, selectFilteredSidebarEntries, selectGroupForWorkspace, type KelpiStoreApi } from '../state';
import type { KelpiState } from '../state/store';
import { WORKSPACES_FEATURE } from './definitions';
import type { BundledFeatureBinding } from './feature';
import type { WorkspacesActions } from './workspaces-actions';

/** Lives with the workbench so hidden views can receive a queued reveal or form request. */
export function useWorkspacesFeatureLifecycle() {
    const [scrollToWorkspaceID, setScrollToWorkspaceID] = useState<string | null>(null);
    const [scrollToGroupID, setScrollToGroupID] = useState<string | null>(null);
    const [sidebarRenameRequest, setSidebarRenameRequest] = useState<{ kind: 'workspace' | 'group'; id: string } | null>(null);
    const [sidebarCreateRequest, setSidebarCreateRequest] = useState<{ kind: 'workspace' | 'group'; groupID: string | null; seq: number } | null>(null);
    const [createSheetOpen, setCreateSheetOpen] = useState(false);
    const sidebarEscapeRef = useRef<(() => boolean) | null>(null);
    const pendingSelectAllRef = useRef(false);
    // Mounting publishes the handle and drains an earlier Select All request atomically.
    const sidebarSelectionRef = useMemo<{ current: SidebarSelectionCommands | null }>(() => {
        let handle: SidebarSelectionCommands | null = null;
        return {
            get current() { return handle; },
            set current(next) {
                handle = next;
                if (next === null || !pendingSelectAllRef.current) return;
                pendingSelectAllRef.current = false;
                next.selectAll();
            }
        };
    }, []);
    const onScrollHandled = useCallback(() => { setScrollToWorkspaceID(null); setScrollToGroupID(null); }, []);
    return {
        scrollToWorkspaceID, setScrollToWorkspaceID, scrollToGroupID, setScrollToGroupID,
        sidebarRenameRequest, setSidebarRenameRequest, sidebarCreateRequest, setSidebarCreateRequest,
        createSheetOpen, setCreateSheetOpen, sidebarEscapeRef, sidebarSelectionRef, pendingSelectAllRef,
        onScrollHandled
    };
}
export type WorkspacesFeatureLifecycle = ReturnType<typeof useWorkspacesFeatureLifecycle>;

/** Derives the native model from the same mirror used by panes and command routing. */
export function useWorkspacesFeatureModel(state: KelpiState) {
    return useMemo(() => {
        const workspace = selectActiveWorkspace(state);
        return {
            entries: selectFilteredSidebarEntries(state),
            activeWorkspaceID: workspace?.id ?? null,
            filter: state.ui.sidebarFilter,
            labelPresets: state.daemon.state.labelPresets,
            profiles: state.settings.value.profiles.map(profile => profile.name),
            remoteNames: state.settings.value.remoteDaemons.map(daemon => daemon.name),
            confirmDeleteWhenActive: state.settings.value.general.confirmWorkspaceDeleteWhenActive,
            inheritGroupID: !state.settings.value.general.inheritGroupOnNewWorkspace || workspace === null
                ? null : selectGroupForWorkspace(state, workspace.id)?.id ?? null,
            activeAgentCount: (workspaceID: string): number => {
                const target = state.daemon.state.workspaces.find(candidate => candidate.id === workspaceID);
                return target === undefined ? 0 : activeAgentCount(target);
            }
        };
    }, [state]);
}
export type WorkspacesFeatureModel = ReturnType<typeof useWorkspacesFeatureModel>;

export interface WorkspacesFeatureViewProps {
    readonly model: WorkspacesFeatureModel;
    readonly actions: WorkspacesActions;
    readonly lifecycle: WorkspacesFeatureLifecycle;
    readonly store: KelpiStoreApi;
    readonly repos: InspectorData['repos'];
    readonly remotes: ReadonlyMap<string, RemoteDaemonRuntime>;
    readonly remoteSelection: RemoteSelection | null;
    readonly selectRemote: (selection: RemoteSelection) => void;
    readonly bucket: ChromeBucket;
    readonly reportSelection: NonNullable<SidebarProps['onSelectionChange']>;
    readonly suppressDeleteConfirm: () => void;
    readonly openSettings: NonNullable<SidebarProps['onOpenSettings']>;
    readonly reportFailure: (label: string, message: string) => void;
}

export function WorkspacesFeatureView(props: WorkspacesFeatureViewProps): ReactElement {
    const { model, actions, lifecycle } = props;
    return <Sidebar
        entries={model.entries}
        remoteDaemons={model.remoteNames}
        onCreateRemoteGroup={(daemonName, name, color) => {
            const held = props.remotes.get(daemonName);
            if (held === undefined) return;
            void held.runtime.commands.createGroup({ name, ...(color !== null ? { color } : {}) })
                .then(reply => { if (!isOkReply(reply)) props.reportFailure('New remote group', replyError(reply)); })
                .catch(error => props.reportFailure('New remote group', error instanceof Error ? error.message : String(error)));
        }}
        trailingSections={<RemoteDaemonSections daemons={[...props.remotes.values()]} selection={props.remoteSelection} onSelect={props.selectRemote} bucket={props.bucket} />}
        activeWorkspaceID={model.activeWorkspaceID}
        filter={model.filter}
        onFilterChange={filter => props.store.getState().setSidebarFilter(filter)}
        labelPresets={model.labelPresets}
        bucket={props.bucket}
        onActivateWorkspace={actions.activateWorkspace}
        onToggleGroupCollapse={actions.setGroupCollapsed}
        onRenameWorkspace={actions.renameWorkspace}
        onDeleteWorkspace={actions.deleteWorkspace}
        activeAgentCount={model.activeAgentCount}
        confirmDeleteWhenActive={model.confirmDeleteWhenActive}
        onSuppressDeleteConfirm={props.suppressDeleteConfirm}
        onToggleWorkspaceLabel={actions.toggleWorkspaceLabel}
        onMoveWorkspace={actions.moveWorkspace}
        onMoveWorkspaces={actions.moveWorkspaces}
        onSetWorkspaceIcon={actions.setWorkspaceIcon}
        onSetGroupIcon={actions.setGroupIcon}
        onSetWorkspaceProfile={actions.setWorkspaceProfile}
        onSetGroupColor={actions.setGroupColor}
        escapeRef={lifecycle.sidebarEscapeRef}
        selectionCommandsRef={lifecycle.sidebarSelectionRef}
        onSelectionChange={props.reportSelection}
        onRenameGroup={actions.renameGroup}
        onDeleteGroup={actions.deleteGroup}
        onCreateWorkspace={(name, groupID, worktree, extras) => {
            if (worktree === undefined) return actions.createWorkspace(name, groupID, extras ?? {});
            const repo = props.repos.find(candidate => candidate.id === worktree.repoID);
            if (repo === undefined) return 'that repository is no longer registered';
            return actions.createWorkspaceWithWorktree(name, groupID, worktree, repo.path, extras ?? {});
        }}
        onCreateGroup={actions.createGroup}
        profiles={model.profiles}
        inheritGroupID={model.inheritGroupID}
        scrollToWorkspaceID={lifecycle.scrollToWorkspaceID}
        scrollToGroupID={lifecycle.scrollToGroupID}
        onScrollHandled={lifecycle.onScrollHandled}
        renameRequest={lifecycle.sidebarRenameRequest}
        onRenameRequestHandled={() => lifecycle.setSidebarRenameRequest(null)}
        createRequest={lifecycle.sidebarCreateRequest}
        onCreateRequestHandled={() => lifecycle.setSidebarCreateRequest(null)}
        onCreateSheetOpenChange={lifecycle.setCreateSheetOpen}
        onOpenSettings={props.openSettings}
        onSetWorkspaceColor={actions.setWorkspaceColor}
        onSetBulkColor={actions.setBulkColor}
        onSetBulkLabel={actions.setBulkLabel}
        onCreateGroupForWorkspaces={actions.createGroupForWorkspaces}
        onCreateGroupWithWorkspace={actions.newGroupForWorkspace}
        onNewGroupWithRename={actions.newGroupWithRename}
        onDeleteWorkspaces={actions.deleteWorkspaces}
        repos={props.repos}
    />;
}

export function bindWorkspacesFeature(props: WorkspacesFeatureViewProps): BundledFeatureBinding {
    return { definition: WORKSPACES_FEATURE, render: () => <WorkspacesFeatureView {...props} /> };
}
