import { TerminalFeaturePane } from '../features/TerminalFeaturePane';
import { BrowserFeaturePane } from '../features/BrowserFeaturePane';
import { PluginView } from '../plugins/PluginView';
import { DocumentPane, isDocumentPane } from '../features/DocumentPane';
import { PluginContributionItems } from '../plugins/contributions-ui';
import { paneChromeItemDescriptors } from '../plugins/contributions';
import { usePluginCommands } from '../plugins/commands';
/**
 * A REMOTE daemon's workspace, rendered in this window (multi-daemon groups, §1.7).
 *
 * The same `PaneGrid` + `TerminalPane` the primary workspace area uses, fed from the remote
 * runtime's own store mirror and PTY client — terminals here are the remote machine's, byte
 * for byte, with focus, splits, close, rename, zoom, pane moves and divider drags routed to
 * the remote daemon's commands.
 *
 * Native documents and their selected replacements use the owning runtime's content host.
 * Browser controls use the owning daemon; native page pixels remain in its desktop shell.
 *
 * The rule that comes with that, and the one thing a new render site has to remember: every
 * place that draws a REMOTE daemon's terminal pane must pass `editingShortcuts` to
 * `TerminalFeaturePane` (#172, #170). The window dispatcher stands down here, so the pane is the
 * only layer left to answer copy, paste and the three line edits. This file and
 * `phone/PhoneRemoteWorkspace.tsx` are the two that do.
 */

import { useEffect, type ReactElement, type ReactNode } from 'react';
import { useStore } from 'zustand';

import { wireEdgeForDropZone } from '@kelpi/core/layout';

import { tokens } from '../chrome/tokens';
import { PaneGrid } from '../grid';
import type { KelpiRuntime } from '../state';

export interface RemoteWorkspaceViewProps {
    readonly visible?: boolean | undefined;
    readonly daemonName: string;
    readonly runtime: KelpiRuntime;
    readonly workspaceID: string;
}

const NO_WINDOW_CHORDS: readonly string[] = [];
const blockWindowShortcuts = (): boolean => true;

export function RemoteWorkspaceView(props: RemoteWorkspaceViewProps): ReactElement {
    const { runtime, workspaceID } = props;
    // These controls belong to the remote pane. The primary shell owns window shortcuts,
    // top/status bars and shared prompts, so this host never dispatches a window shortcut.
    const contributions = usePluginCommands(runtime, NO_WINDOW_CHORDS, blockWindowShortcuts);
    const workspace = useStore(runtime.store, (state) =>
        state.daemon.state.workspaces.find((entry) => entry.id === workspaceID)
    );
    const focusEcho = useStore(runtime.store, (state) => state.ui.focusEcho);
    const connection = useStore(runtime.store, (state) => state.ui.connection);
    /*
     * §APP-069/§H4: the home `PaneHeader` abbreviates against, from the daemon that OWNS these
     * paths. Every path in this grid is the REMOTE machine's, and §APP-069 is explicit that `~`
     * needs "the daemon's home rather than the viewer's" - the local window's home would match
     * nothing and print the raw `/Users/…` the primary window stopped printing (#216). The
     * mirror strips `homeDirectory` deliberately, so this daemon's handshake (`welcome.daemon`)
     * is the only place it lives.
     */
    const homeDirectory = useStore(runtime.store, (state) => state.daemon.info?.home);
    /*
     * §10/shell-ui §4.6: hover-focus is a config-file setting, and the config that describes
     * this grid is the one that rode THIS daemon's handshake - the same `settings.general` read
     * the primary mount makes against its own runtime. Unpassed, hover-focus was simply dead on
     * a remote daemon's workspace (#216).
     */
    const general = useStore(runtime.store, (state) => state.settings.value.general);

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
        if (pane.type === 'plugin' && pane.plugin) return <PluginView runtime={runtime} pluginID={pane.plugin.pluginID} viewID={pane.plugin.viewID} descriptor={pane.plugin} focused={focused} paneID={paneID} workspaceID={workspaceID} visible={state.visible} />;
        if (isDocumentPane(pane.type) && pane.externalEditorCommand == null) return <DocumentPane runtime={runtime} workspaceID={workspaceID} paneID={paneID} kind={pane.type} focused={focused} visible={state.visible} onFocusRequest={id => runtime.focusPane(workspaceID, id)} />;
        if (pane.type === 'web') return <BrowserFeaturePane runtime={runtime} workspaceID={workspaceID} paneID={paneID} focused={focused} visible={state.visible} embedded={false} onFocusRequest={id => runtime.focusPane(workspaceID, id)} />;
        if (pane.type !== 'shell' && pane.externalEditorCommand == null) {
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
            <TerminalFeaturePane
                runtime={runtime}
                workspaceID={workspaceID}
                paneID={paneID}
                ptyApi={runtime.pty}
                focused={focused}
                visible={state.visible}
                // #172/#170: the same stance as `blockWindowShortcuts` above, for the other half
                // of the keyboard. The window dispatcher stands down while a remote workspace
                // fills the pane area (`App.tsx` reports `hasActiveWorkspace: false`), so copy,
                // paste and the three line edits have to be answered by the pane that took the
                // chord, against THIS daemon's runtime. In the primary window the dispatcher
                // still owns them and this stays off.
                editingShortcuts
                onFocusRequest={(id) => runtime.focusPane(workspaceID, id)}
            />
        );
    };

    return (
        <PaneGrid
            visible={props.visible}
            focusFollowsMouse={general.focusFollowsMouse}
            focusFollowsMouseDelayMs={general.focusFollowsMouseDelay}
            layout={workspace.layout}
            panes={workspace.panes}
            focusedPaneID={focusedPaneID}
            zoomedPaneID={workspace.zoomedPaneID ?? null}
            /* Sync input is the remote daemon's own standing state, mirrored like the layout:
               a workspace put in sync from that machine wears the same SYNC / SYNC OFF badges
               here. Display only - both badges are read-only in the header. */
            syncActive={workspace.isSyncInputActive}
            syncExcludedPaneIDs={workspace.syncInputExcluded}
            homeDirectory={homeDirectory}
            headerCommandsFor={paneID => contributions.menu('pane.header', paneID)}
            headerExtras={paneID => {
                const items = contributions.items('pane.header', paneID);
                return items.length ? <PluginContributionItems items={items} paneID={paneID} compact
                    execute={(_command, target, itemID) => { if (itemID) contributions.runItem('pane.header', itemID, target); }} /> : null;
            }}
            /* The projection half of the same items, and the run reached by id rather than by
               closure (pane chrome phase A, ratified decision 7). The remote view resolves and
               runs `pane.header` contributions through its own `usePluginCommands` already, so
               there is no reason for its panes' chrome model to be the poorer of the two - and
               #144's parity guard is what says so. */
            headerItemsFor={paneID => paneChromeItemDescriptors(contributions.items('pane.header', paneID))}
            onRunHeaderItem={(paneID, itemID) => { contributions.runItem('pane.header', itemID, paneID); }}
            renderPane={renderPane}
            onFocusPane={(paneID) => runtime.focusPane(workspaceID, paneID)}
            onClosePane={(paneID) => void runtime.commands.closePane({ paneID })}
            onSplitPane={(paneID, direction) => void runtime.commands.splitPane({ paneID, direction })}
            onRenamePane={(paneID, name) => void runtime.commands.renamePane({ paneID, name })}
            onToggleZoom={(paneID) => void runtime.commands.toggleZoom({ paneID })}
            /*
             * The header drag ends in `onMovePane?.(...)`, so an unwired mount swallows the
             * drop: the pane lifts, the drop zone highlights, and nothing moves (#144). The
             * remote runtime's `commands` is the same CommandClient over that daemon's socket,
             * so `pane-move-adjacent` reaches it exactly as `splitPane` above does. The wire
             * spells the zone `above`/`below`/`left-of`/`right-of`, not the grid's geometric
             * `top`/`bottom`/`left`/`right`, hence the conversion the primary window also does.
             */
            onMovePane={(paneID, anchorID, zone) =>
                void runtime.commands.movePaneAdjacent({
                    target: paneID,
                    anchor: anchorID,
                    zone: wireEdgeForDropZone(zone)
                })
            }
            /* The empty-layout "New Pane" affordance, same swallow if left unwired. */
            onCreatePane={() => void runtime.commands.createPane({ workspace: workspaceID })}
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
