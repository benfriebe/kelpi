/**
 * The sidebar's remote-daemon sections (§1.7 multi-daemon groups) — one per configured
 * `remote-daemon`, rendered through the Sidebar's `trailingSections` slot so the sidebar
 * itself stays ignorant of remote stores.
 *
 * Each section reads its own runtime's mirror: a header (name + connection dot + the remote's
 * group count folded into a subtitle) and one row per remote workspace. Selecting a row hands
 * `(daemon, workspaceID)` up — assembly swaps the workspace area to the remote view. The rows
 * are deliberately plainer than the local sidebar's (no drag, no context menus, no labels):
 * those gestures are staged behind the core loop of seeing and using remote terminals.
 */

import { type ReactElement } from 'react';
import { useStore } from 'zustand';

import { hoverFill, hoverText, useHoverKey } from '../chrome/hover';
import { tokens } from '../chrome/tokens';
import type { ConnectionStatus } from '../connection';
import type { RemoteDaemonRuntime } from './remote-daemons';

export interface RemoteSelection {
    readonly daemon: string;
    readonly workspaceID: string;
}

export interface RemoteDaemonSectionsProps {
    readonly daemons: readonly RemoteDaemonRuntime[];
    readonly selection: RemoteSelection | null;
    readonly onSelect: (selection: RemoteSelection) => void;
}

function statusColor(status: ConnectionStatus): string {
    if (status === 'connected') return tokens.statusRunning;
    if (status === 'connecting' || status === 'reconnecting') return tokens.activeAgent;
    return tokens.statusInactive;
}

function RemoteDaemonSection(props: {
    readonly held: RemoteDaemonRuntime;
    readonly selection: RemoteSelection | null;
    readonly onSelect: (selection: RemoteSelection) => void;
}): ReactElement {
    const { held } = props;
    const workspaces = useStore(held.runtime.store, (state) => state.daemon.state.workspaces);
    const connection = useStore(held.runtime.store, (state) => state.ui.connection);
    const [hovered, hover] = useHoverKey();

    return (
        <div className="mt-2 flex shrink-0 flex-col" data-testid={`remote-daemon-${held.name}`}>
            <div className="flex items-center gap-1.5 px-2 py-1">
                <span
                    aria-hidden
                    className="h-[6px] w-[6px] rounded-full"
                    data-testid={`remote-daemon-status-${held.name}`}
                    data-status={connection}
                    style={{ background: statusColor(connection) }}
                />
                <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: tokens.textTertiary }}>
                    {held.name}
                </span>
            </div>
            {connection !== 'connected' && workspaces.length === 0 ? (
                <span className="px-2 pb-1 text-[11px]" style={{ color: tokens.textTertiary }}>
                    {connection === 'rejected' ? 'connection refused — check the pairing URL' : 'connecting…'}
                </span>
            ) : null}
            {workspaces.map((workspace) => {
                const selected =
                    props.selection !== null &&
                    props.selection.daemon === held.name &&
                    props.selection.workspaceID === workspace.id;
                const key = `ws:${workspace.id}`;
                return (
                    <button
                        key={workspace.id}
                        type="button"
                        data-testid={`remote-workspace-${held.name}-${workspace.id}`}
                        data-selected={selected ? 'true' : 'false'}
                        className="flex items-center gap-2 rounded px-2 py-1 text-left text-[12px]"
                        style={{
                            color: selected
                                ? tokens.textPrimary
                                : hoverText(hovered === key, tokens.textSecondary),
                            background: selected ? tokens.selectionFill : hoverFill(hovered === key)
                        }}
                        {...hover(key)}
                        onClick={() => {
                            props.onSelect({ daemon: held.name, workspaceID: workspace.id });
                        }}
                    >
                        <span className="truncate">{workspace.name}</span>
                        <span className="ml-auto shrink-0 text-[10px]" style={{ color: tokens.textTertiary }}>
                            {workspace.panes.length}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}

export function RemoteDaemonSections(props: RemoteDaemonSectionsProps): ReactElement | null {
    if (props.daemons.length === 0) return null;
    return (
        <div className="shrink-0" data-testid="remote-daemon-sections">
            {props.daemons.map((held) => (
                <RemoteDaemonSection
                    key={held.name}
                    held={held}
                    selection={props.selection}
                    onSelect={props.onSelect}
                />
            ))}
        </div>
    );
}
