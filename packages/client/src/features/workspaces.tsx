/** Bundled Workspaces model, view lifecycle and host binding. */
import { activeAgentCount, type WorkspaceColor } from '@kelpi/daemon/store';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { RemoteDaemonSections, type RemoteSelection } from '../app/RemoteDaemonSections';
import type { RemoteDaemonRuntime } from '../app/remote-daemons';
import type { InspectorData } from '../app/inspector';
import { isOkReply, replyError } from '../connection';
import { Sidebar, type SidebarProps, type SidebarSelectionCommands } from '../chrome/Sidebar';
import { NewEntrySheet } from '../chrome/NewWorkspaceSheet';
import { defaultGroupName, nextCreateColor } from '../chrome/sidebar-model';
import type { ChromeBucket } from '../chrome/theme';
import type { NewWorkspaceExtras, SubmitResult, WorkspaceWorktreeRequest } from '../chrome/types';
import { useSidebarNativeMounted } from '../plugins/Workbench';
import type { SidebarPlacement } from '../plugins/registry';
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

/**
 * Everything §WS-075's create sheet needs, wherever it is hosted: the native sidebar's own sheet
 * and `WorkspacesCreateSheetHost` below hand a submitted draft to the same two functions.
 */
export type WorkspacesCreateHost = Pick<WorkspacesFeatureViewProps,
    'model' | 'actions' | 'lifecycle' | 'repos' | 'remotes' | 'bucket' | 'reportFailure'>;

/** §1.7: a group destined for another daemon is created THERE: no local row exists. */
function createRemoteGroup(host: WorkspacesCreateHost, daemonName: string, name: string, color: WorkspaceColor | null): void {
    const held = host.remotes.get(daemonName);
    if (held === undefined) return;
    void held.runtime.commands.createGroup({ name, ...(color !== null ? { color } : {}) })
        .then(reply => { if (!isOkReply(reply)) host.reportFailure('New remote group', replyError(reply)); })
        .catch(error => host.reportFailure('New remote group', error instanceof Error ? error.message : String(error)));
}

/** §WS-078: the worktree variant needs the repo's PATH, which only the registry here knows. */
function createWorkspaceFromSheet(
    host: WorkspacesCreateHost,
    name: string,
    groupID: string | null,
    worktree?: WorkspaceWorktreeRequest | undefined,
    extras?: NewWorkspaceExtras | undefined
): SubmitResult {
    if (worktree === undefined) return host.actions.createWorkspace(name, groupID, extras ?? {});
    const repo = host.repos.find(candidate => candidate.id === worktree.repoID);
    if (repo === undefined) return 'that repository is no longer registered';
    return host.actions.createWorkspaceWithWorktree(name, groupID, worktree, repo.path, extras ?? {});
}

export function WorkspacesFeatureView(props: WorkspacesFeatureViewProps): ReactElement {
    const { model, actions, lifecycle } = props;
    return <Sidebar
        entries={model.entries}
        remoteDaemons={model.remoteNames}
        onCreateRemoteGroup={(daemonName, name, color) => { createRemoteGroup(props, daemonName, name, color); }}
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
        onCreateWorkspace={(name, groupID, worktree, extras) => createWorkspaceFromSheet(props, name, groupID, worktree, extras)}
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

export type WorkspacesCreateSheetProps = WorkspacesCreateHost & {
    /** The placement the bundled Workspaces view would occupy: assembly's `workspacesPlacement`. */
    readonly placement: SidebarPlacement;
};

/**
 * §WS-075's create sheet, hosted where the SIDEBAR's selected view cannot take it away.
 *
 * The sheet is a window modal, not a piece of the workspace list: `ContentView.swift:289-294`
 * hangs it off the window, and every route that raises it (⌘N, File ▸ New Workspace, the
 * palette's New Workspace row, the empty state's Create Workspace button) posts one
 * `sidebarCreateRequest` through `act.newWorkspace`. While the bundled view draws the placement,
 * the native `Sidebar` consumes that request and renders the sheet exactly as it always has, and
 * this host renders nothing. With a PLUGIN view in the placement the native sidebar is not
 * mounted, so the request had no consumer at all and the gesture did nothing and said nothing
 * (issue #201). That is the case this host covers.
 *
 * Rendered only for that case, so the two can never both be up: the branch is
 * `useSidebarNativeMounted`, the same walk the slot itself makes, which counts a plugin container
 * that WRAPS the bundled view as the native sidebar being mounted (it is).
 */
export function WorkspacesCreateSheetHost(props: WorkspacesCreateSheetProps): ReactElement | null {
    const native = useSidebarNativeMounted(props.placement, WORKSPACES_FEATURE.id);
    return native ? null : <WorkspacesCreateSheet {...props} />;
}

function WorkspacesCreateSheet(props: WorkspacesCreateSheetProps): ReactElement | null {
    const { lifecycle, model } = props;
    const { setSidebarCreateRequest, setCreateSheetOpen } = lifecycle;
    const [form, setForm] = useState<{ kind: 'workspace' | 'group'; groupID: string | null } | null>(null);

    /**
     * The same one-shot contract the sidebar applies (`chrome/Sidebar.tsx`, §APP-018's other
     * half): consumed once and cleared immediately, so ⌘N pressed twice re-opens the sheet the
     * second time and a re-render after a cancel cannot bring it back.
     */
    const request = lifecycle.sidebarCreateRequest;
    useEffect(() => {
        if (request === null) return;
        setForm({ kind: request.kind, groupID: request.groupID });
        setSidebarCreateRequest(null);
    }, [request, setSidebarCreateRequest]);

    /** …and the same publication upward: a modal is a whole-window fact, not a sidebar one. */
    const open = form !== null;
    useEffect(() => {
        setCreateSheetOpen(open);
        return () => { if (open) setCreateSheetOpen(false); };
    }, [open, setCreateSheetOpen]);

    const groups = useMemo(
        () => model.entries.filter((entry): entry is Extract<WorkspacesFeatureModel['entries'][number], { kind: 'group' }> => entry.kind === 'group').map(entry => entry.group),
        [model.entries]
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open-edge only, as the sidebar rolls
    // it: the swatch belongs to the OPENING of the form, not to the entries it read on the way.
    const color = useMemo(() => nextCreateColor(model.entries), [form]);

    if (form === null) return null;
    return <NewEntrySheet
        kind={form.kind}
        bucket={props.bucket}
        repos={props.repos}
        groups={groups}
        profiles={model.profiles}
        remoteDaemons={model.remoteNames}
        defaultColor={color}
        // §WS-076 then §SET-011, the order the sidebar's own sheet resolves them in.
        defaultGroupID={form.groupID ?? model.inheritGroupID}
        {...(form.kind === 'group' ? { defaultName: defaultGroupName(groups.map(group => group.name)) } : {})}
        onCancel={() => { setForm(null); }}
        onSubmit={async draft => {
            if (form.kind === 'group') {
                if (draft.remoteDaemon !== null) createRemoteGroup(props, draft.remoteDaemon, draft.name, draft.color);
                else props.actions.createGroup(draft.name, draft.color);
                setForm(null);
                return null;
            }
            const result = await createWorkspaceFromSheet(props, draft.name, draft.groupID, draft.worktree, {
                ...(draft.color === null ? {} : { color: draft.color }),
                profile: draft.profile,
                repoPaths: draft.repoPaths
            });
            // §WS-079: a failed worktree create keeps the SHEET open, with the message inline.
            if (typeof result === 'string') return result;
            setForm(null);
            return null;
        }}
    />;
}
