/**
 * A REMOTE daemon's workspace, rendered in this window (multi-daemon groups, §1.7).
 *
 * The same `PaneGrid` + `TerminalPane` the primary workspace area uses, fed from the remote
 * runtime's own store mirror and PTY client — terminals here are the remote machine's, byte
 * for byte, with focus, splits, close, rename, zoom and divider drags routed to the remote
 * daemon's commands.
 *
 * Deliberately terminal-first: a remote CONTENT pane (markdown/diff) or WEB pane renders an
 * honest placeholder instead of a half-working body — content subscriptions and browser
 * views are deep per-daemon machinery, staged behind this view rather than faked by it.
 */

import { useEffect, type ReactElement, type ReactNode } from 'react';
import { useStore } from 'zustand';

import { tokens } from '../chrome/tokens';
import { PaneGrid } from '../grid';
import type { KelpiRuntime } from '../state';
import { TerminalPane } from '../terminal';

export interface RemoteWorkspaceViewProps {
    readonly daemonName: string;
    readonly runtime: KelpiRuntime;
    readonly workspaceID: string;
}

export function RemoteWorkspaceView(props: RemoteWorkspaceViewProps): ReactElement {
    const { runtime, workspaceID } = props;
    const workspace = useStore(runtime.store, (state) =>
        state.daemon.state.workspaces.find((entry) => entry.id === workspaceID)
    );
    const focusEcho = useStore(runtime.store, (state) => state.ui.focusEcho);
    const connection = useStore(runtime.store, (state) => state.ui.connection);

    // The remote daemon fans PTY bytes out by what this connection REPORTS it is showing —
    // the same activation contract the primary window keeps.
    useEffect(() => {
        if (workspace !== undefined) runtime.activateWorkspace(workspaceID);
    }, [runtime, workspaceID, workspace !== undefined]);

    if (workspace === undefined) {
        return (
            <div
                className="flex h-full items-center justify-center text-[12px]"
                data-testid="remote-workspace-missing"
                style={{ color: tokens.textTertiary }}
            >
                {connection === 'connected'
                    ? 'This workspace is gone on the remote daemon.'
                    : `Connecting to ${props.daemonName}…`}
            </div>
        );
    }

    const focusedPaneID =
        focusEcho !== null && focusEcho.workspaceID === workspaceID
            ? focusEcho.paneID
            : workspace.focusedPaneID;

    const renderPane = (paneID: string, _frame: unknown, focused: boolean, state: { visible: boolean }): ReactNode => {
        const pane = workspace.panes.find((entry) => entry.id === paneID);
        if (pane === undefined) return null;
        if (pane.type !== 'shell') {
            return (
                <div
                    className="flex h-full items-center justify-center px-4 text-center text-[12px]"
                    data-testid={`remote-pane-placeholder-${paneID}`}
                    style={{ color: tokens.textTertiary, background: tokens.surfaceBackground }}
                >
                    {pane.type} panes are not supported on remote daemons yet - open them on the
                    daemon's own machine.
                </div>
            );
        }
        return (
            <TerminalPane
                paneID={paneID}
                ptyApi={runtime.pty}
                focused={focused}
                visible={state.visible}
                onFocusRequest={(id) => runtime.focusPane(workspaceID, id)}
            />
        );
    };

    return (
        <PaneGrid
            layout={workspace.layout}
            panes={workspace.panes}
            focusedPaneID={focusedPaneID}
            zoomedPaneID={workspace.zoomedPaneID ?? null}
            renderPane={renderPane}
            onFocusPane={(paneID) => runtime.focusPane(workspaceID, paneID)}
            onClosePane={(paneID) => void runtime.commands.closePane({ paneID })}
            onSplitPane={(paneID, direction) => void runtime.commands.splitPane({ paneID, direction })}
            onRenamePane={(paneID, name) => void runtime.commands.renamePane({ paneID, name })}
            onToggleZoom={(paneID) => void runtime.commands.toggleZoom({ paneID })}
            onSetRatio={(splitPath, ratio, commit) => {
                // Same two spellings as the primary window (pane-layout.md §7.4, App.tsx
                // `onSetRatio`): `paneID === null` is a divider whose two children are BOTH
                // splits (the root of a 2×2 tiled layout), which `pane-resize` cannot name, so it
                // goes by split path over the WS-only `set-split-ratio` verb (§LAY-061). The
                // remote runtime's `commands` is the same CommandClient over that daemon's own
                // socket, so the verb reaches it exactly as `toggleZoom` above does. Dropping the
                // commit here made the divider preview and snap back on release (#54).
                if (commit.paneID === null) {
                    void runtime.commands.setSplitRatioAtPath({ workspaceID, splitPath, ratio });
                    return;
                }
                void runtime.commands.setSplitRatio(commit.paneID, commit.share);
            }}
        />
    );
}
