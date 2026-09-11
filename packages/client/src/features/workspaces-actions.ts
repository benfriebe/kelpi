/** Workspaces feature commands. Retained callbacks resolve the current mirror on invocation. */
import type { WorkspaceColor } from '@kelpi/daemon/store';
import type { Dispatch, SetStateAction } from 'react';
import { DEFAULT_PROFILE_NAME, defaultGroupName, type WorkspaceWorktreeRequest } from '../chrome';
import { isOkReply, replyError, replyText, type CommandClient, type CommandReply } from '../connection';
import { selectActiveWorkspace, selectVisibleWorkspaceIDs, type KelpiStoreApi } from '../state';
import type { WorkspacesFeatureLifecycle } from './workspaces';

export interface WorkspacesActionHost {
    readonly store: KelpiStoreApi;
    readonly commands: Pick<CommandClient, 'addRepoAssociation' | 'createGroup' | 'createGroupForWorkspaces' | 'createWorkspace' | 'deleteGroup' | 'deleteWorkspace' | 'labelWorkspace' | 'moveWorkspace' | 'moveWorkspaces' | 'renameGroup' | 'renameWorkspace' | 'setBulkColor' | 'setBulkLabel' | 'setGroupCollapsed' | 'setGroupColor' | 'setGroupIcon' | 'setWorkspaceIcon' | 'setWorkspaceProfile'>;
    readonly run: (label: string, command: Promise<CommandReply>) => boolean;
    readonly notifyFailure: (label: string, message: string) => void;
    readonly activateWorkspaceAndReveal: (workspaceID: string) => void;
    readonly setSidebarVisible: Dispatch<SetStateAction<boolean>>;
    readonly lifecycle: WorkspacesFeatureLifecycle;
}

export function createWorkspacesActions(host: WorkspacesActionHost) {
    const { store, commands, run, notifyFailure, activateWorkspaceAndReveal, setSidebarVisible } = host;
    const { setScrollToGroupID, setSidebarRenameRequest, setSidebarCreateRequest, sidebarSelectionRef, pendingSelectAllRef } = host.lifecycle;
    const activeWorkspaceID = (): string | null => selectActiveWorkspace(store.getState())?.id ?? null;

    const runCreateGroup = (
        promise: Promise<CommandReply>,
        options: { readonly rename?: boolean } = {}
    ): true => {
        void promise.then(
            (reply) => {
                if (!isOkReply(reply)) {
                    notifyFailure('New group', replyError(reply));
                    return;
                }
                const created = replyText(reply, 'group_id');
                if (created === undefined) return;
                setScrollToGroupID(created);
                // §WS-052 / §APP-019: the gestures that mint a PLACEHOLDER name drop
                // straight into inline rename on the header the reply named — the id
                // exists nowhere else, so this is the only place the request can be made.
                if (options.rename === true) {
                    setSidebarVisible(true);
                    setSidebarRenameRequest({ kind: 'group', id: created });
                }
            },
            (error: unknown) => {
                notifyFailure('New group', error instanceof Error ? error.message : String(error));
            }
        );
        return true;
    };

    const runCreateWorkspace = (
        promise: Promise<CommandReply>,
        repoPaths: readonly string[] = []
    ): true => {
        void promise.then(
            (reply) => {
                if (!isOkReply(reply)) {
                    notifyFailure('New workspace', replyError(reply));
                    return;
                }
                const created = replyText(reply, 'workspace_id');
                if (created !== undefined) {
                    activateWorkspaceAndReveal(created);
                    // §WS-075's Repositories section: one association per chosen repo,
                    // pointing at the repo's own path, once the workspace exists. The
                    // create verb carries no repo list (only `--worktree` does), so these
                    // ride the same `add-repo-association` the inspector uses.
                    for (const path of repoPaths) {
                        void commands
                            .addRepoAssociation({ workspaceID: created, path })
                            .then((association) => {
                                if (!isOkReply(association)) {
                                    notifyFailure('Add repository', replyError(association));
                                }
                            })
                            .catch((error: unknown) => {
                                notifyFailure(
                                    'Add repository',
                                    error instanceof Error ? error.message : String(error)
                                );
                            });
                    }
                }
            },
            (error: unknown) => {
                notifyFailure('New workspace', error instanceof Error ? error.message : String(error));
            }
        );
        return true;
    };

    return {
        activateWorkspace(workspaceID: string): boolean {
            activateWorkspaceAndReveal(workspaceID);
            return true;
        },

        switchToIndex(index: number): boolean {
            const id = selectVisibleWorkspaceIDs(store.getState())[index];
            if (id === undefined) return false;
            activateWorkspaceAndReveal(id);
            return true;
        },

        switchRelative(delta: 1 | -1): boolean {
            const ids = selectVisibleWorkspaceIDs(store.getState());
            if (ids.length === 0) return false;
            const at = ids.indexOf(activeWorkspaceID() ?? '');
            // app-state-core.md §3.2: a no-op when the active workspace is not in the
            // visible order (its group just got collapsed) or there is none (issue #57
            // asc-06). Stepping from index 0 instead jumped to an unrelated row at the top
            // of the sidebar.
            if (at < 0) return false;
            const id = ids[(at + delta + ids.length) % ids.length];
            if (id === undefined) return false;
            // §WS-100: next/previous workspace, which is exactly the case where the row
            // being activated can be off the bottom of a long sidebar.
            activateWorkspaceAndReveal(id);
            return true;
        },

        newWorkspace(): boolean {
            setSidebarVisible(true);
            setSidebarCreateRequest((previous) => ({
                kind: 'workspace',
                // null: the SHEET applies §SET-011 itself, through the `inheritGroupID`
                // prop, so scoping the request to a group here would override a user who
                // had turned inheritance off.
                groupID: null,
                seq: (previous?.seq ?? 0) + 1
            }));
            return true;
        },

        createWorkspace(
            name: string,
            groupID: string | null,
            options: {
                color?: WorkspaceColor | undefined;
                profile?: string | null | undefined;
                repoPaths?: readonly string[] | undefined;
            } = {}
        ): boolean {
            const trimmed = name.trim();
            const repoPaths = options.repoPaths ?? [];
            // Issue #38: with exactly one repo chosen there is no doubt where the shell
            // belongs, so the first pane opens in it. None or several stay at home; a repo
            // gone from disk falls back to home at spawn (`resolveSpawnCwd`).
            const onlyRepo = repoPaths.length === 1 ? repoPaths[0] : undefined;
            return runCreateWorkspace(
                commands.createWorkspace({
                    ...(trimmed.length > 0 ? { name: trimmed } : {}),
                    ...(onlyRepo === undefined ? {} : { path: onlyRepo }),
                    ...(groupID === null ? {} : { group: groupID }),
                    ...(options.color === undefined ? {} : { color: options.color }),
                    // `default` (or null) means "no assignment" — the daemon's own
                    // normalization — so it is simply not sent.
                    ...(options.profile === undefined ||
                    options.profile === null ||
                    options.profile === DEFAULT_PROFILE_NAME
                        ? {}
                        : { profile: options.profile })
                }),
                repoPaths
            );
        },

        deleteWorkspace(
            workspaceID: string,
            options: { allowLast?: boolean } = {}
        ): boolean {
            // The sidebar runs its own confirmation first, which is the GUI's
            // "delete anyway?" — so the command goes out forced, as the app's own
            // delete path does once the user has said yes.
            //
            // `allowLast` defaults OFF, so the sidebar's Delete keeps the shipped app's
            // `.disabled(store.workspaces.count <= 1)` rule; only the ⌘W gate passes it on
            // (§WS-156).
            return run(
                'Delete workspace',
                commands.deleteWorkspace({
                    workspace: workspaceID,
                    force: true,
                    ...(options.allowLast === true ? { allowLast: true } : {})
                })
            );
        },

        renameWorkspace(workspaceID: string, name: string): boolean {
            const trimmed = name.trim();
            if (trimmed.length === 0) return false;
            return run('Rename workspace', commands.renameWorkspace({ workspaceID, name: trimmed }));
        },

        moveWorkspace(request: { workspaceID: string; groupID: string | null; index: number }): boolean {
            return run(
                'Move workspace',
                commands.moveWorkspace({
                    workspace: request.workspaceID,
                    ...(request.groupID === null ? {} : { group: request.groupID }),
                    index: request.index
                })
            );
        },

        moveWorkspaces(request: {
            workspaceIDs: readonly string[];
            groupID: string | null;
            index: number;
        }): boolean {
            return run(
                'Move workspaces',
                commands.moveWorkspaces({
                    workspaceIDs: request.workspaceIDs,
                    groupID: request.groupID,
                    index: request.index
                })
            );
        },

        setWorkspaceIcon(workspaceID: string, icon: string | null): boolean {
            return run('Change icon', commands.setWorkspaceIcon({ workspaceID, icon }));
        },

        setGroupIcon(groupID: string, icon: string | null): boolean {
            return run('Change icon', commands.setGroupIcon({ groupID, icon }));
        },

        setGroupColor(groupID: string, color: WorkspaceColor | null): boolean {
            return run('Group color', commands.setGroupColor({ groupID, color }));
        },

        toggleWorkspaceLabel(workspaceID: string, label: string, applied: boolean): boolean {
            return run(
                'Label workspace',
                commands.labelWorkspace({
                    workspace: workspaceID,
                    op: applied ? 'add' : 'remove',
                    values: [label]
                })
            );
        },

        createGroup(name: string, color?: WorkspaceColor | null | undefined): boolean {
            const trimmed = name.trim();
            if (trimmed.length === 0) return false;
            return runCreateGroup(
                commands.createGroup({
                    name: trimmed,
                    ...(color === undefined || color === null ? {} : { color })
                })
            );
        },

        newGroupWithRename(): boolean {
            const existing = store.getState().daemon.state.groups.map((group) => group.name);
            return runCreateGroup(
                commands.createGroupForWorkspaces({
                    name: defaultGroupName(existing),
                    workspaceIDs: []
                }),
                { rename: true }
            );
        },

        beginRenameActiveWorkspace(): boolean {
            const id = activeWorkspaceID();
            if (id === null) return false;
            setSidebarVisible(true);
            setSidebarRenameRequest({ kind: 'workspace', id });
            return true;
        },

        selectAllWorkspaces(): boolean {
            setSidebarVisible(true);
            if (sidebarSelectionRef.current !== null) return sidebarSelectionRef.current.selectAll();
            // Nothing to ask yet — the sidebar was hidden. It drains this the moment it
            // publishes its handle (see `sidebarSelectionRef`'s setter).
            pendingSelectAllRef.current = true;
            return true;
        },

        deselectAllWorkspaces(): boolean {
            return sidebarSelectionRef.current?.deselectAll() ?? false;
        },

        renameGroup(groupID: string, name: string): boolean {
            const trimmed = name.trim();
            if (trimmed.length === 0) return false;
            return run('Rename group', commands.renameGroup({ group: groupID, newName: trimmed }));
        },

        deleteGroup(groupID: string, cascade: boolean): boolean {
            return run('Delete group', commands.deleteGroup({ group: groupID, cascade }));
        },

        setGroupCollapsed(groupID: string, collapsed: boolean): boolean {
            return run('Collapse group', commands.setGroupCollapsed({ groupID, collapsed }));
        },

        toggleSidebar(): boolean {
            setSidebarVisible((visibleNow) => !visibleNow);
            return true;
        },

        setWorkspaceColor(workspaceID: string, color: WorkspaceColor): boolean {
            return run('Workspace color', commands.setBulkColor({ workspaceIDs: [workspaceID], color }));
        },

        setBulkColor(workspaceIDs: readonly string[], color: WorkspaceColor): boolean {
            return run('Workspace color', commands.setBulkColor({ workspaceIDs, color }));
        },

        setBulkLabel(workspaceIDs: readonly string[], label: string, apply: boolean): boolean {
            return run('Label workspaces', commands.setBulkLabel({ workspaceIDs, label, apply }));
        },

        createGroupForWorkspaces(
            name: string,
            workspaceIDs: readonly string[],
            color?: WorkspaceColor | null | undefined
        ): boolean {
            const trimmed = name.trim();
            if (trimmed.length === 0) return false;
            return runCreateGroup(
                commands.createGroupForWorkspaces({
                    name: trimmed,
                    workspaceIDs,
                    ...(color === undefined || color === null ? {} : { color })
                })
            );
        },

        newGroupForWorkspace(workspaceID: string): boolean {
            const existing = store.getState().daemon.state.groups.map((group) => group.name);
            return runCreateGroup(
                commands.createGroupForWorkspaces({
                    name: defaultGroupName(existing),
                    workspaceIDs: [workspaceID]
                }),
                { rename: true }
            );
        },

        deleteWorkspaces(workspaceIDs: readonly string[]): boolean {
            for (const workspaceID of workspaceIDs) {
                run('Delete workspaces', commands.deleteWorkspace({ workspace: workspaceID, force: true }));
            }
            return true;
        },

        setWorkspaceProfile(workspaceID: string, profile: string | null): boolean {
            return run(
                'Workspace profile',
                commands.setWorkspaceProfile({
                    workspace: workspaceID,
                    ...(profile === null ? {} : { profile })
                })
            );
        },

        async createWorkspaceWithWorktree(
            name: string,
            groupID: string | null,
            worktree: WorkspaceWorktreeRequest,
            repoPath: string,
            extras: { color?: WorkspaceColor | undefined; profile?: string | null | undefined } = {}
        ): Promise<string | null> {
            try {
                const reply = await commands.createWorkspace({
                    ...(name.trim().length > 0 ? { name: name.trim() } : {}),
                    ...(groupID === null ? {} : { group: groupID }),
                    ...(extras.color === undefined ? {} : { color: extras.color }),
                    ...(extras.profile === undefined ||
                    extras.profile === null ||
                    extras.profile === DEFAULT_PROFILE_NAME
                        ? {}
                        : { profile: extras.profile }),
                    repo: repoPath,
                    worktree: worktree.name,
                    branch: worktree.branch,
                    updateMain: worktree.updateMain
                });
                if (!isOkReply(reply)) return replyError(reply);
                const created = replyText(reply, 'workspace_id');
                if (created !== undefined) activateWorkspaceAndReveal(created);
                return null;
            } catch (error) {
                return error instanceof Error ? error.message : String(error);
            }
        }
    };
}

export type WorkspacesActions = ReturnType<typeof createWorkspacesActions>;
