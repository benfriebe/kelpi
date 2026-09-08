/**
 * The workspace drawer (B3's left drawer, grown for the owner's multi-host request): one section
 * per host, each listing that daemon's workspaces and groups with the LOCAL sidebar's own row
 * components - `WorkspaceRow` and `GroupHeaderRow` from `chrome/Sidebar.tsx`, fed by
 * `selectSidebarEntries` over that host's store mirror - so a row on the phone is pixel-identical
 * to the same row on the Mac, with one implementation to drift from (the same choice
 * `app/RemoteDaemonSections.tsx` made). What a row deliberately does NOT wire is the desktop list's
 * drag/multi-select/rename/context machinery: an unwired gesture is inert, never half-working.
 *
 * A section header shows the host's connection as a dot, collapses the host, and - for the
 * phone's own entries - removes it. The origin's section has no remove: it is the page.
 */

import { useState, type ReactElement } from 'react';
import { useStore } from 'zustand';

import { ChromeIcon } from '../chrome/icons';
import { agentCounts, groupGuideColor, GroupHeaderRow, WorkspaceRow } from '../chrome/Sidebar';
import { tokens } from '../chrome/tokens';
import type { ChromeBucket } from '../chrome/theme';
import type { ChromeLabelPreset, ChromeWorkspace } from '../chrome/types';
import type { ConnectionStatus } from '../connection';
import { selectSidebarEntries } from '../state';
import type { PhoneHostModel, PhoneWorkspaceSelection } from './model';
import { PHONE_ROW_MIN_PX, PhoneButton, PhoneRow, PhoneSheet, PhoneSheetHeader } from './ui';

export interface PhoneWorkspaceDrawerProps {
    readonly open: boolean;
    readonly hosts: readonly PhoneHostModel[];
    readonly selection: PhoneWorkspaceSelection | null;
    readonly bucket: ChromeBucket;
    readonly onSelect: (selection: PhoneWorkspaceSelection) => void;
    readonly onNewWorkspace: () => void;
    readonly onAddHost: () => void;
    readonly onRemoveHost: (hostKey: string) => void;
    /** B7: back to the landing page, the drawer's half of the two ways out (the header's is the other). */
    readonly onShowLanding: () => void;
    readonly onClose: () => void;
}

export function connectionDotColor(status: ConnectionStatus): string {
    if (status === 'connected') return tokens.statusRunning;
    if (status === 'connecting' || status === 'reconnecting') return tokens.activeAgent;
    return tokens.statusInactive;
}

const noop = (): void => {};

export interface PhoneHostWorkspaceListProps {
    readonly host: PhoneHostModel;
    readonly selection: PhoneWorkspaceSelection | null;
    readonly bucket: ChromeBucket;
    readonly onSelect: (selection: PhoneWorkspaceSelection) => void;
}

/**
 * One host's workspaces and groups, as the local sidebar's own rows.
 *
 * Extracted for B7's landing page, which lists the same rows under a host card: one
 * implementation to drift from was the whole point of building the drawer out of `WorkspaceRow`
 * and `GroupHeaderRow`, and a second copy on the landing page would have thrown that away.
 */
export function PhoneHostWorkspaceList(props: PhoneHostWorkspaceListProps): ReactElement {
    const { host } = props;
    const entries = useStore(host.runtime.store, selectSidebarEntries);
    const presets = useStore(host.runtime.store, (state) => state.daemon.state.labelPresets);
    const connection = useStore(host.runtime.store, (state) => state.ui.connection);

    const activate = (workspaceID: string): void => {
        props.onSelect({ host: host.key, workspaceID });
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
                props.selection.host === host.key &&
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
        <div className="flex flex-col pb-1" data-testid={`phone-host-body-${host.key}`}>
            {connection !== 'connected' && entries.length === 0 ? (
                <span className="px-3 pb-2 pl-8 text-[12px]" style={{ color: tokens.textTertiary }}>
                    {connection === 'rejected'
                        ? 'connection refused - the pairing URL may have been revoked'
                        : connection === 'closed'
                          ? 'unreachable'
                          : 'connecting…'}
                </span>
            ) : null}
            {entries.map((entry) => {
                if (entry.kind === 'workspace') return row(entry.workspace as ChromeWorkspace, { depth: 0 });
                const group = entry.group;
                const guide = groupGuideColor(group.color, props.bucket);
                return (
                    <div key={group.id} className="flex flex-col" data-testid={`phone-group-${host.key}-${group.id}`}>
                        <GroupHeaderRow
                            group={group}
                            collapsed={group.isCollapsed}
                            counts={agentCounts(entry.workspaces as readonly ChromeWorkspace[])}
                            bucket={props.bucket}
                            renaming={false}
                            dropPreview={false}
                            onToggle={(groupID) => {
                                // The daemon's own persisted collapse state, over that
                                // host's connection; the mirror echoes it back.
                                void host.runtime.commands.setGroupCollapsed({ groupID, collapsed: !group.isCollapsed });
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
    );
}

function HostSection(props: {
    readonly host: PhoneHostModel;
    readonly selection: PhoneWorkspaceSelection | null;
    readonly bucket: ChromeBucket;
    readonly onSelect: (selection: PhoneWorkspaceSelection) => void;
    readonly onRemove: (() => void) | null;
}): ReactElement {
    const { host } = props;
    const connection = useStore(host.runtime.store, (state) => state.ui.connection);
    const [collapsed, setCollapsed] = useState(false);

    return (
        <div className="flex shrink-0 flex-col" data-testid={`phone-host-${host.key}`} data-host-kind={host.kind}>
            <div className="flex items-center" style={{ minHeight: `${String(PHONE_ROW_MIN_PX)}px` }}>
                <button
                    type="button"
                    data-testid={`phone-host-toggle-${host.key}`}
                    aria-expanded={!collapsed}
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 text-left"
                    style={{ minHeight: `${String(PHONE_ROW_MIN_PX)}px` }}
                    onClick={() => setCollapsed((current) => !current)}
                >
                    <span style={{ color: tokens.textTertiary }} className="flex shrink-0 items-center">
                        <ChromeIcon name={collapsed ? 'chevron-right' : 'chevron-down'} size={10} />
                    </span>
                    <span
                        aria-hidden
                        className="h-[7px] w-[7px] shrink-0 rounded-full"
                        data-testid={`phone-host-status-${host.key}`}
                        data-status={connection}
                        style={{ background: connectionDotColor(connection) }}
                    />
                    <span className="truncate text-[12px] font-semibold uppercase tracking-wide" style={{ color: tokens.textSecondary }}>
                        {host.name}
                    </span>
                </button>
                {props.onRemove === null ? null : (
                    <PhoneButton testID={`phone-host-remove-${host.key}`} ariaLabel={`Remove ${host.name}`} onClick={props.onRemove}>
                        <ChromeIcon name="clear" size={12} />
                    </PhoneButton>
                )}
            </div>
            {collapsed ? null : (
                <PhoneHostWorkspaceList host={host} selection={props.selection} bucket={props.bucket} onSelect={props.onSelect} />
            )}
        </div>
    );
}

export function PhoneWorkspaceDrawer(props: PhoneWorkspaceDrawerProps): ReactElement | null {
    return (
        <PhoneSheet open={props.open} side="left" label="Workspaces" testID="phone-workspace-drawer" onClose={props.onClose}>
            <PhoneSheetHeader title="Workspaces" testID="phone-workspace-drawer-header" onClose={props.onClose} />
            {/* B7's second way back to the landing page, at the drawer's top where the owner said
                it could live; the header's Hosts button is the first. Both close the drawer. */}
            <PhoneRow
                testID="phone-drawer-landing"
                onClick={() => {
                    props.onShowLanding();
                    props.onClose();
                }}
            >
                <span className="flex shrink-0 items-center" style={{ color: tokens.textSecondary }}>
                    <ChromeIcon name="network" size={14} />
                </span>
                <span className="truncate">All hosts</span>
            </PhoneRow>
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto py-1" data-testid="phone-host-list">
                {props.hosts.map((host) => (
                    <HostSection
                        key={host.key}
                        host={host}
                        selection={props.selection}
                        bucket={props.bucket}
                        onSelect={(selection) => {
                            props.onSelect(selection);
                            props.onClose();
                        }}
                        onRemove={host.removable ? () => props.onRemoveHost(host.key) : null}
                    />
                ))}
            </div>
            <div className="flex shrink-0 items-center justify-between border-t px-1" style={{ borderColor: tokens.divider }}>
                <PhoneButton testID="phone-new-workspace" onClick={props.onNewWorkspace}>
                    <ChromeIcon name="plus" size={12} />
                    New workspace
                </PhoneButton>
                <PhoneButton testID="phone-add-host" onClick={props.onAddHost}>
                    Add host
                </PhoneButton>
            </div>
        </PhoneSheet>
    );
}
