import { PluginView } from '../plugins/PluginView';
/**
 * A REMOTE host's workspace on the phone.
 *
 * `layout` mode is `app/RemoteWorkspaceView.tsx` unchanged: the same `PaneGrid` the desktop's
 * multi-daemon groups draw, over that host's own mirror, PTY stream and commands. `pane` mode is
 * that view's one-pane half: the focused pane (echo-fast, then the daemon's) filling the box as a
 * `TerminalPane` over the remote PTY client, or the same honest placeholder the desktop draws for
 * a remote content or web pane. The remote daemon fans PTY bytes out by what this connection
 * reports, so the report names exactly the pane on screen.
 */

import { useEffect, type ReactElement } from 'react';
import { useStore } from 'zustand';

import { layoutPaneOrder, type WorkspaceState } from '@kelpi/daemon/store';

import { RemoteWorkspaceView } from '../app/RemoteWorkspaceView';
import { tokens } from '../chrome/tokens';
import type { KelpiRuntime } from '../state';
import { TerminalPane, type TerminalRendererFactory } from '../terminal';
import type { PhoneViewMode } from './view';
import { resolveShownPane } from './view';

export interface PhoneRemoteWorkspaceProps {
    readonly hostName: string;
    readonly runtime: KelpiRuntime;
    readonly workspaceID: string;
    readonly mode: PhoneViewMode;
    readonly createRenderer?: TerminalRendererFactory | undefined;
}

/** The pane a remote workspace shows in `pane` mode: its focus, echo first. */
export function remoteShownPane(
    workspace: WorkspaceState,
    focusEcho: { readonly workspaceID: string; readonly paneID: string | null } | null
): string | null {
    const focused =
        focusEcho !== null && focusEcho.workspaceID === workspace.id ? focusEcho.paneID : workspace.focusedPaneID;
    return resolveShownPane(focused, layoutPaneOrder(workspace));
}

export function PhoneRemoteWorkspace(props: PhoneRemoteWorkspaceProps): ReactElement {
    const { runtime, workspaceID, mode } = props;
    const workspace = useStore(runtime.store, (state) =>
        state.daemon.state.workspaces.find((entry) => entry.id === workspaceID)
    );
    const focusEcho = useStore(runtime.store, (state) => state.ui.focusEcho);
    const connection = useStore(runtime.store, (state) => state.ui.connection);
    const shownPaneID = workspace === undefined || mode !== 'pane' ? null : remoteShownPane(workspace, focusEcho);

    // `layout` mode's activation is `RemoteWorkspaceView`'s own effect; `pane` mode reports the
    // one pane it shows, so the remote daemon streams that pane and not the five beside it.
    useEffect(() => {
        if (mode !== 'pane' || workspace === undefined) return;
        runtime.activateWorkspace(workspaceID, shownPaneID === null ? [] : [shownPaneID]);
    }, [runtime, workspaceID, mode, workspace !== undefined, shownPaneID]);

    if (mode === 'layout') {
        return <RemoteWorkspaceView daemonName={props.hostName} runtime={runtime} workspaceID={workspaceID} />;
    }

    if (workspace === undefined) {
        return (
            <div
                className="flex h-full items-center justify-center px-4 text-center text-[13px]"
                data-testid="remote-workspace-missing"
                style={{ color: tokens.textTertiary }}
            >
                {connection === 'connected' ? `This workspace is gone on ${props.hostName}.` : `Connecting to ${props.hostName}…`}
            </div>
        );
    }

    const pane = shownPaneID === null ? undefined : workspace.panes.find((entry) => entry.id === shownPaneID);
    if (pane === undefined) {
        return (
            <div className="flex h-full items-center justify-center text-[13px]" data-testid="phone-remote-empty" style={{ color: tokens.textTertiary }}>
                No panes in this workspace.
            </div>
        );
    }

    return (
        <div
            data-testid={`pane-${pane.id}`}
            data-pane-id={pane.id}
            data-hidden="false"
            data-focused="true"
            data-zoomed="false"
            data-phone-remote-pane={props.hostName}
            className="flex h-full w-full flex-col overflow-hidden"
        >
            <div data-testid={`pane-body-${pane.id}`} className="relative min-h-0 flex-1">
                {pane.type === 'plugin' && pane.plugin ? <PluginView runtime={runtime} pluginID={pane.plugin.pluginID} viewID={pane.plugin.viewID} descriptor={pane.plugin} paneID={pane.id} workspaceID={workspaceID} visible /> : pane.type !== 'shell' ? (
                    <div
                        className="flex h-full items-center justify-center px-4 text-center text-[13px]"
                        data-testid={`remote-pane-placeholder-${pane.id}`}
                        style={{ color: tokens.textTertiary, background: tokens.surfaceBackground }}
                    >
                        {pane.type} panes are not supported on remote daemons yet - open them on the daemon's own machine.
                    </div>
                ) : (
                    <TerminalPane
                        paneID={pane.id}
                        ptyApi={runtime.pty}
                        focused
                        visible
                        onFocusRequest={(id) => runtime.focusPane(workspaceID, id)}
                        createRenderer={props.createRenderer}
                    />
                )}
            </div>
        </div>
    );
}
