/**
 * Bundled Inspector behavior. Its model lives for the workbench lifetime, independently of
 * the sidebar view: the footer and New Workspace sheet also consume its repository data,
 * and graft events must remain current while the Inspector is closed.
 */

import type { WorkspaceState } from '@kelpi/daemon/store';
import { useMemo, type ReactElement, type ReactNode } from 'react';

import { useGraft, type GraftCommands, type UseGraftResult } from '../app/graft';
import { useInspectorData, type InspectorData, type InspectorReader } from '../app/inspector';
import { Inspector } from '../chrome/Inspector';
import type { ChromeBucket } from '../chrome/theme';
import type { ChromeLabelPreset, ChromeWorkspace, WorkspaceWorktreeRequest } from '../chrome/types';
import { isOkReply, replyError, type CommandClient, type CommandReply, type ConnectionStatus, type KelpiConnection } from '../connection';
import { INSPECTOR_FEATURE } from './definitions';
import type { BundledFeatureBinding } from './feature';

/** The mirror fields owned or displayed by the feature; no App/store object is required. */
export type InspectorFeatureWorkspace = ChromeWorkspace & Pick<WorkspaceState, 'repoAssociations'>;

export interface InspectorFeatureLifecycle {
    readonly visible: boolean;
    readonly connection: ConnectionStatus;
    /** A workspace activation forces one read after that destination becomes current. */
    readonly forceRefreshFor?: { readonly workspaceID: string; readonly seq: number } | null | undefined;
}

export type InspectorFeatureCommands = InspectorReader & GraftCommands;

export interface InspectorFeatureInput {
    readonly commands: InspectorFeatureCommands;
    readonly events: Pick<KelpiConnection, 'on'>;
    readonly workspace: InspectorFeatureWorkspace | null;
    readonly repos: readonly { readonly id: string }[];
    readonly lifecycle: InspectorFeatureLifecycle;
    /** Tests may disable the normal 30 second status poll. */
    readonly pollMs?: number | undefined;
}

export interface InspectorFeatureModel extends InspectorData {
    readonly workspace: InspectorFeatureWorkspace | null;
    readonly graft: UseGraftResult;
}

/** Mount once in the host, including when a contributed view replaces the Inspector. */
export function useInspectorFeature(input: InspectorFeatureInput): InspectorFeatureModel {
    const associationsKey = useMemo(
        () => (input.workspace?.repoAssociations ?? [])
            .map(association => `${association.id}:${association.worktreePath}:${association.branchName ?? ''}`)
            .join('|'),
        [input.workspace]
    );
    const registryKey = useMemo(() => input.repos.map(repo => repo.id).join('|'), [input.repos]);
    const data = useInspectorData({
        commands: input.commands,
        events: input.events,
        workspaceID: input.workspace?.id ?? null,
        // The closed panel still feeds the footer, using the daemon's cached status. Arrival
        // and provider invalidation remain explicit forced reads in useInspectorData.
        enabled: input.lifecycle.visible || associationsKey !== '',
        refreshOnRead: input.lifecycle.visible,
        forceRefreshFor: input.lifecycle.forceRefreshFor,
        associationsKey,
        registryKey,
        pollMs: input.pollMs
    });
    const graft = useGraft({
        commands: input.commands,
        events: input.events,
        // Reconnects and opening the panel re-scan interrupted grafts. The subscription itself
        // is unconditional, so a closed panel does not miss another client's graft changes.
        syncKey: `${input.lifecycle.connection}:${input.lifecycle.visible ? 'open' : 'closed'}`
    });
    return { workspace: input.workspace, ...data, graft };
}

export type InspectorActionCommands = Pick<CommandClient,
    'openDiff' | 'createPane' | 'splitPane' | 'addRepoAssociation' | 'addWorktree' |
    'removeRepoAssociation' | 'scanRepos'>;

export interface InspectorActionHost {
    readonly commands: InspectorActionCommands;
    /** Live getters keep a retained menu/action from targeting a workspace the user left. */
    readonly activeWorkspace: () => { readonly id: string; readonly panes: readonly { readonly id: string }[] } | null;
    readonly focusedPaneID: () => string | null;
    /** Shared host error presentation for commands whose buttons do not await their replies. */
    readonly run: (label: string, command: Promise<CommandReply>) => boolean;
    readonly refresh: () => void;
}

export interface InspectorActions {
    openRepoDiff(repoPath: string): boolean;
    openTerminalAt(repoPath: string, options: { vertical: boolean }): boolean;
    /** null is success; errors stay in the sheet instead of closing behind a toast. */
    addRepoAssociation(path: string): Promise<string | null>;
    addWorktree(request: WorkspaceWorktreeRequest): Promise<string | null>;
    removeRepoAssociation(associationID: string, deleteWorktree: boolean): boolean;
    scanForRepos(path: string): boolean;
}

export function createInspectorActions(host: InspectorActionHost): InspectorActions {
    const { commands } = host;
    const sourcePane = (): string | null => host.focusedPaneID() ?? host.activeWorkspace()?.panes[0]?.id ?? null;
    const mutation = async (operation: () => Promise<CommandReply>): Promise<string | null> => {
        try {
            const reply = await operation();
            if (!isOkReply(reply)) return replyError(reply);
            host.refresh();
            return null;
        } catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
    };
    return {
        openRepoDiff(repoPath) {
            // Source identity anchors the daemon to this client's workspace, even before the
            // first active-workspace report has reached it.
            const paneID = sourcePane();
            return host.run('Open diff', commands.openDiff({ repoPath, ...(paneID === null ? {} : { paneID }) }));
        },
        openTerminalAt(repoPath, options) {
            const paneID = sourcePane();
            if (paneID === null) {
                const workspaceID = host.activeWorkspace()?.id ?? null;
                if (workspaceID === null) return false;
                return host.run('Open terminal', commands.createPane({ workspace: workspaceID, path: repoPath }));
            }
            return host.run('Open terminal', commands.splitPane({
                paneID,
                direction: options.vertical ? 'vertical' : 'horizontal',
                path: repoPath
            }));
        },
        async addRepoAssociation(path) {
            const workspaceID = host.activeWorkspace()?.id ?? null;
            if (workspaceID === null) return 'no active workspace';
            return mutation(() => commands.addRepoAssociation({ workspaceID, path }));
        },
        async addWorktree(request) {
            const workspaceID = host.activeWorkspace()?.id ?? null;
            if (workspaceID === null) return 'no active workspace';
            return mutation(() => commands.addWorktree({
                workspaceID,
                repoID: request.repoID,
                name: request.name,
                branch: request.branch,
                updateMain: request.updateMain
            }));
        },
        removeRepoAssociation(associationID, deleteWorktree) {
            const workspaceID = host.activeWorkspace()?.id ?? null;
            if (workspaceID === null) return false;
            const sent = host.run(
                deleteWorktree ? 'Remove worktree' : 'Remove repository',
                commands.removeRepoAssociation({ workspaceID, associationID, deleteWorktree })
            );
            // The removal itself arrives as a delta; retain the Inspector's immediate reread.
            host.refresh();
            return sent;
        },
        scanForRepos(path) {
            // A completed scan may have registered new rows even if some paths were refused.
            // The host runner also consumes transport failures instead of leaking a rejection
            // from a button which intentionally does not await its command.
            return host.run('Scan repositories', commands.scanRepos({ path }).then(reply => {
                host.refresh();
                return reply;
            }));
        }
    };
}

/** Shared workbench gestures used by the Inspector, in addition to its own repo actions. */
export interface InspectorViewActions extends InspectorActions {
    toggleInspector(): void;
    renameWorkspace(workspaceID: string, name: string): void;
    setWorkspaceColor(workspaceID: string, color: ChromeWorkspace['color']): void;
    setWorkspaceProfile(workspaceID: string, profile: string | null): void;
    focusPane(paneID: string): void;
    closePane(paneID: string): void;
}

export interface InspectorFeatureViewProps {
    readonly model: InspectorFeatureModel;
    readonly actions: InspectorViewActions;
    readonly focusedPaneID: string | null;
    readonly profiles: readonly { readonly name: string }[];
    readonly labelPresets: readonly ChromeLabelPreset[];
    readonly bucket: ChromeBucket;
    readonly side?: 'left' | 'right';
    readonly viewPicker?: ReactNode;
}

/** The existing Inspector remains the pure view; all feature-specific binding lives here. */
export function InspectorFeatureView(props: InspectorFeatureViewProps): ReactElement | null {
    const { model, actions } = props;
    const workspace = model.workspace;
    if (workspace === null) return null;
    return <Inspector
        side={props.side ?? 'right'}
        viewPicker={props.viewPicker}
        workspace={workspace}
        focusedPaneID={props.focusedPaneID}
        associations={model.associations}
        repos={model.repos}
        profiles={props.profiles.map(profile => profile.name)}
        labelPresets={props.labelPresets}
        bucket={props.bucket}
        refreshing={model.refreshing}
        onClose={actions.toggleInspector}
        onRenameWorkspace={name => actions.renameWorkspace(workspace.id, name)}
        onSetWorkspaceColor={color => actions.setWorkspaceColor(workspace.id, color)}
        onSetProfile={profile => actions.setWorkspaceProfile(workspace.id, profile)}
        onOpenDiff={actions.openRepoDiff}
        onOpenTerminal={actions.openTerminalAt}
        onRemoveAssociation={actions.removeRepoAssociation}
        onAddAssociation={actions.addRepoAssociation}
        onScanForRepos={actions.scanForRepos}
        onCreateWorktree={actions.addWorktree}
        onFocusPane={actions.focusPane}
        onClosePane={actions.closePane}
        graftSessions={model.graft.state.sessions}
        graftOrphans={model.graft.state.orphans}
        graftSwapPrompt={model.graft.state.swapPrompt}
        onToggleGraft={association => {
            void model.graft.controller.toggle({ id: association.id, worktreePath: association.worktreePath, branch: association.branch });
        }}
        onConfirmGraftSwap={prompt => { void model.graft.controller.confirmSwap(prompt); }}
        onCancelGraftSwap={model.graft.controller.cancelSwap}
        onRestoreGraftOrphan={orphan => { void model.graft.controller.recoverOrphan(orphan); }}
        onDismissGraftOrphan={orphan => { void model.graft.controller.dismissOrphan(orphan); }}
    />;
}

export type InspectorFeatureBindingOptions = Omit<InspectorFeatureViewProps, 'side' | 'viewPicker'>;

/** Placement is chosen by the shared registry; its slot supplies the chrome orientation. */
export function bindInspectorFeature(options: InspectorFeatureBindingOptions): BundledFeatureBinding {
    return {
        definition: INSPECTOR_FEATURE,
        render: context => <InspectorFeatureView {...options} side={context.side ?? 'right'} viewPicker={context.viewPicker} />
    };
}
