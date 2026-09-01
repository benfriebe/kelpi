/**
 * The sidebar's remote-daemon sections (§1.7 multi-daemon groups) — one ACCORDION per
 * configured `remote-daemon`, rendered through the Sidebar's `trailingSections` slot.
 *
 * Below the accordion header, remote rows are the LOCAL sidebar's own components —
 * `WorkspaceRow` and `GroupHeaderRow`, exported from `chrome/Sidebar.tsx` — fed by
 * `selectSidebarEntries` over the remote store's mirror. A remote workspace or group is
 * therefore pixel-identical to a local one by construction: same avatars, status dots,
 * label chips, agent-count badges, group bands, nesting indents and §WS-007 guide rules,
 * with one implementation to drift from. What a remote row deliberately does NOT wire is
 * the local list's drag/multi-select/rename/context machinery — those callbacks are inert
 * (the house rule: an unwired gesture is inert, never half-working).
 *
 * The accordion header (status dot · name · chevron) collapses the whole host; that choice
 * is per-client convenience in `localStorage` (guarded — a blocked store defaults to
 * expanded). A remote GROUP's chevron, by contrast, toggles `set-group-collapsed` over the
 * remote daemon's own connection: its persisted state, mirrored back live.
 */

import { useState, type ReactElement } from 'react';
import { useStore } from 'zustand';

import { hoverFill, hoverText, useHoverKey } from '../chrome/hover';
import { ChromeIcon } from '../chrome/icons';
import { agentCounts, groupGuideColor, GroupHeaderRow, WorkspaceRow } from '../chrome/Sidebar';
import { tokens } from '../chrome/tokens';
import type { ChromeBucket } from '../chrome/theme';
import type { ChromeLabelPreset, ChromeWorkspace } from '../chrome/types';
import type { ConnectionStatus } from '../connection';
import { selectSidebarEntries } from '../state';
import type { RemoteDaemonRuntime } from './remote-daemons';

export interface RemoteSelection {
    readonly daemon: string;
    readonly workspaceID: string;
}

export interface RemoteDaemonSectionsProps {
    readonly daemons: readonly RemoteDaemonRuntime[];
    readonly selection: RemoteSelection | null;
    readonly onSelect: (selection: RemoteSelection) => void;
    /** The chrome's light/dark bucket — the rows read colours exactly as local ones do. */
    readonly bucket?: ChromeBucket | undefined;
}

function statusColor(status: ConnectionStatus): string {
    if (status === 'connected') return tokens.statusRunning;
    if (status === 'connecting' || status === 'reconnecting') return tokens.activeAgent;
    return tokens.statusInactive;
}

/** Per-client accordion memory. A blocked or absent store reads as "expanded". */
const COLLAPSE_KEY_PREFIX = 'kelpi.remote-daemon-collapsed.';

function readCollapsed(name: string): boolean {
    try {
        return globalThis.localStorage?.getItem(COLLAPSE_KEY_PREFIX + name) === '1';
    } catch {
        return false;
    }
}

function writeCollapsed(name: string, collapsed: boolean): void {
    try {
        if (collapsed) globalThis.localStorage?.setItem(COLLAPSE_KEY_PREFIX + name, '1');
        else globalThis.localStorage?.removeItem(COLLAPSE_KEY_PREFIX + name);
    } catch {
        // Convenience only; the accordion still works for this page's life.
    }
}

const noop = (): void => {};

function RemoteDaemonSection(props: {
    readonly held: RemoteDaemonRuntime;
    readonly selection: RemoteSelection | null;
    readonly bucket: ChromeBucket;
    readonly onSelect: (selection: RemoteSelection) => void;
}): ReactElement {
    const { held } = props;
    const entries = useStore(held.runtime.store, selectSidebarEntries);
    const presets = useStore(held.runtime.store, (state) => state.daemon.state.labelPresets);
    const connection = useStore(held.runtime.store, (state) => state.ui.connection);
    const [collapsed, setCollapsed] = useState(() => readCollapsed(held.name));
    const [hovered, hover] = useHoverKey();

    const toggle = (): void => {
        setCollapsed((current) => {
            writeCollapsed(held.name, !current);
            return !current;
        });
    };

    const activate = (workspaceID: string): void => {
        props.onSelect({ daemon: held.name, workspaceID });
    };

    const row = (
        workspace: ChromeWorkspace,
        options: {
            depth: 0 | 1;
            groupID?: string;
            guideColor?: string;
            guideExtendUp?: boolean;
            guideExtendDown?: boolean;
        }
    ): ReactElement => (
        <WorkspaceRow
            key={workspace.id}
            workspace={workspace}
            depth={options.depth}
            {...(options.groupID === undefined ? {} : { groupID: options.groupID })}
            active={
                props.selection !== null &&
                props.selection.daemon === held.name &&
                props.selection.workspaceID === workspace.id
            }
            selected={false}
            badgeIndex={-1}
            bucket={props.bucket}
            presets={presets as readonly ChromeLabelPreset[]}
            renaming={false}
            dragging={false}
            groupCaption={null}
            {...(options.guideColor === undefined ? {} : { guideColor: options.guideColor })}
            {...(options.guideExtendUp === undefined ? {} : { guideExtendUp: options.guideExtendUp })}
            {...(options.guideExtendDown === undefined ? {} : { guideExtendDown: options.guideExtendDown })}
            onActivate={activate}
            onContextMenu={noop}
            onDragStart={noop}
            onCommitRename={noop}
            onCancelRename={noop}
            registerRow={noop}
        />
    );

    return (
        <div className="mt-2 flex shrink-0 flex-col" data-testid={`remote-daemon-${held.name}`}>
            <button
                type="button"
                data-testid={`remote-daemon-toggle-${held.name}`}
                aria-expanded={!collapsed}
                className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left"
                data-hovered={hovered === 'header' ? 'true' : 'false'}
                style={{ background: hoverFill(hovered === 'header') }}
                {...hover('header')}
                onClick={toggle}
            >
                <span style={{ color: tokens.textTertiary }} className="flex shrink-0 items-center">
                    <ChromeIcon name={collapsed ? 'chevron-right' : 'chevron-down'} size={9} />
                </span>
                <span
                    aria-hidden
                    className="h-[6px] w-[6px] shrink-0 rounded-full"
                    data-testid={`remote-daemon-status-${held.name}`}
                    data-status={connection}
                    style={{ background: statusColor(connection) }}
                />
                <span
                    className="truncate text-[11px] font-semibold uppercase tracking-wide"
                    style={{ color: hoverText(hovered === 'header', tokens.textTertiary) }}
                >
                    {held.name}
                </span>
            </button>
            {collapsed ? null : (
                <div className="flex flex-col" data-testid={`remote-daemon-body-${held.name}`}>
                    {connection !== 'connected' && entries.length === 0 ? (
                        <span className="px-2 pb-1 pl-6 text-[11px]" style={{ color: tokens.textTertiary }}>
                            {connection === 'rejected'
                                ? 'connection refused — check the pairing URL'
                                : 'connecting…'}
                        </span>
                    ) : null}
                    {entries.map((entry) => {
                        if (entry.kind === 'workspace') {
                            return row(entry.workspace as ChromeWorkspace, { depth: 0 });
                        }
                        const group = entry.group;
                        const guide = groupGuideColor(group.color, props.bucket);
                        return (
                            <div key={group.id} className="flex flex-col" data-testid={`remote-group-${held.name}-${group.id}`}>
                                <GroupHeaderRow
                                    group={group}
                                    collapsed={group.isCollapsed}
                                    counts={agentCounts(entry.workspaces as readonly ChromeWorkspace[])}
                                    bucket={props.bucket}
                                    renaming={false}
                                    dropPreview={false}
                                    onToggle={(groupID) => {
                                        // The REMOTE daemon's own persisted collapse state,
                                        // toggled over its own connection; the mirror echoes
                                        // it back, exactly as on that machine's sidebar.
                                        void held.runtime.commands.setGroupCollapsed({
                                            groupID,
                                            collapsed: !group.isCollapsed
                                        });
                                    }}
                                    onContextMenu={noop}
                                    onDragStart={noop}
                                    onCommitRename={noop}
                                    onCancelRename={noop}
                                    registerRow={noop}
                                />
                                {group.isCollapsed
                                    ? null
                                    : entry.workspaces.map((workspace, index) =>
                                          row(workspace as ChromeWorkspace, {
                                              depth: 1,
                                              groupID: group.id,
                                              guideColor: guide,
                                              guideExtendUp: index > 0,
                                              guideExtendDown: index < entry.workspaces.length - 1
                                          })
                                      )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

export function RemoteDaemonSections(props: RemoteDaemonSectionsProps): ReactElement | null {
    if (props.daemons.length === 0) return null;
    const bucket = props.bucket ?? 'dark';
    return (
        <div className="shrink-0" data-testid="remote-daemon-sections">
            {props.daemons.map((held) => (
                <RemoteDaemonSection
                    key={held.name}
                    held={held}
                    selection={props.selection}
                    bucket={bucket}
                    onSelect={props.onSelect}
                />
            ))}
        </div>
    );
}
