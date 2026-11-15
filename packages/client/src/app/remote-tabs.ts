/**
 * A remote daemon's workspace in this window's title bar (workspace-feature.md §12, §1.7).
 *
 * While a paired daemon's workspace fills the pane area, the tabs in the title bar are THAT
 * workspace's, read from that daemon's own mirror and driven over its own connection. Every
 * tab gesture (the bar, the native menu rows, ⌥⌘T and its family, the palette) acts on the one
 * workspace this module names, so none of them can reach the hidden local workspace behind it.
 */

import { useCallback, useSyncExternalStore } from 'react';

import type { WorkspaceState } from '@kelpi/daemon/store';
import type { CommandClient } from '../connection/commands';
import type { RemoteDaemonRuntime } from './remote-daemons';
import type { RemoteSelection } from './RemoteDaemonSections';

/** What the tab actions act on: whose commands, which workspace, its focused pane. */
export interface TabTarget {
    readonly commands: Pick<CommandClient, 'raw'>;
    readonly workspace: WorkspaceState | null;
    readonly focusedPaneID: string | null;
    /** That daemon's workspaces, for Move Tab to Workspace; absent = none to offer. */
    readonly workspaces?: readonly WorkspaceState[] | undefined;
    /** A paired daemon's runtime (its settings, for the close-tab gate); absent = this window's. */
    readonly runtime?: RemoteDaemonRuntime['runtime'] | undefined;
}

/** A remote daemon's workspace as its mirror holds it now, or null (gone, or not synced yet). */
export function remoteWorkspaceOf(remote: RemoteDaemonRuntime | null, workspaceID: string | null): WorkspaceState | null {
    if (remote === null || workspaceID === null) return null;
    return remote.runtime.store.getState().daemon.state.workspaces.find((workspace) => workspace.id === workspaceID) ?? null;
}

/**
 * The selected remote workspace when there is one (its mirror, its connection), else the local
 * target. `useRemoteWorkspaceSelection` only reports a selection while its daemon is there. A
 * remote workspace the mirror does not hold (gone, not synced yet) is `workspace: null`, so a
 * tab chord does nothing rather than act on the hidden local workspace.
 */
export function tabTargetFor(
    selection: RemoteSelection | null,
    remote: RemoteDaemonRuntime | null,
    local: () => TabTarget
): TabTarget {
    if (selection === null || remote === null) return local();
    const workspace = remoteWorkspaceOf(remote, selection.workspaceID);
    const echo = remote.runtime.store.getState().ui.focusEcho;
    const focusedPaneID =
        workspace === null ? null : echo !== null && echo.workspaceID === workspace.id ? echo.paneID : workspace.focusedPaneID;
    return {
        commands: remote.runtime.commands,
        workspace,
        focusedPaneID,
        workspaces: remote.runtime.store.getState().daemon.state.workspaces,
        runtime: remote.runtime
    };
}

/** The selected remote workspace, re-rendering with that daemon's mirror. */
export function useRemoteWorkspace(remote: RemoteDaemonRuntime | null, workspaceID: string | null): WorkspaceState | null {
    const subscribe = useCallback(
        (listener: () => void): (() => void) => (remote === null ? () => {} : remote.runtime.store.subscribe(listener)),
        [remote]
    );
    const snapshot = useCallback((): WorkspaceState | null => remoteWorkspaceOf(remote, workspaceID), [remote, workspaceID]);
    return useSyncExternalStore(subscribe, snapshot, snapshot);
}
