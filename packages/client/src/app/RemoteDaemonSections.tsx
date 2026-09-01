/**
 * The sidebar's remote-daemon sections (§1.7 multi-daemon groups) — one ACCORDION per
 * configured `remote-daemon`, rendered through the Sidebar's `trailingSections` slot so the
 * sidebar itself stays ignorant of remote stores.
 *
 * Each accordion header (status dot · name · chevron) collapses the whole host; the state is
 * per-client convenience, so it lives in `localStorage` (guarded — a blocked store just
 * defaults to expanded) rather than in either daemon's config. The BODY is the remote
 * daemon's own sidebar structure, verbatim: `selectSidebarEntries` — the exact selector the
 * local sidebar renders from — applied to the remote store's mirror, so top-level order,
 * groups, group membership and group collapse state all read as they do on that machine.
 * Toggling a remote GROUP goes through the remote daemon's own `set-group-collapsed`, so it
 * is that daemon's persisted state, mirrored back live — never a local imitation of it.
 *
 * The rows stay plainer than the local sidebar's (no drag, no context menus, no labels):
 * those gestures are staged behind the core loop of seeing and using remote terminals.
 */

import { useState, type ReactElement } from 'react';
import { useStore } from 'zustand';

import { hoverFill, hoverText, useHoverKey } from '../chrome/hover';
import { ChromeIcon } from '../chrome/icons';
import { workspaceColorHex, type ChromeBucket } from '../chrome/theme';
import { tokens } from '../chrome/tokens';
import type { ChromeWorkspace } from '../chrome/types';
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
    /** The chrome's light/dark bucket, for the same colour dots the local rows carry. */
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

function RemoteWorkspaceRow(props: {
    readonly held: RemoteDaemonRuntime;
    readonly workspace: ChromeWorkspace;
    readonly indented: boolean;
    readonly selected: boolean;
    readonly bucket: ChromeBucket;
    readonly onSelect: (selection: RemoteSelection) => void;
}): ReactElement {
    const [hovered, hover] = useHoverKey();
    const key = `ws:${props.workspace.id}`;
    return (
        <button
            type="button"
            data-testid={`remote-workspace-${props.held.name}-${props.workspace.id}`}
            data-selected={props.selected ? 'true' : 'false'}
            className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] ${props.indented ? 'pl-6' : ''}`}
            style={{
                color: props.selected
                    ? tokens.textPrimary
                    : hoverText(hovered === key, tokens.textSecondary),
                background: props.selected ? tokens.selectionFill : hoverFill(hovered === key)
            }}
            {...hover(key)}
            onClick={() => {
                props.onSelect({ daemon: props.held.name, workspaceID: props.workspace.id });
            }}
        >
            <span
                aria-hidden
                className="h-[7px] w-[7px] shrink-0 rounded-full"
                style={{ background: workspaceColorHex(props.workspace.color, props.bucket) }}
            />
            <span className="truncate">{props.workspace.name}</span>
            <span className="ml-auto shrink-0 text-[10px]" style={{ color: tokens.textTertiary }}>
                {props.workspace.panes.length}
            </span>
        </button>
    );
}

function RemoteDaemonSection(props: {
    readonly held: RemoteDaemonRuntime;
    readonly selection: RemoteSelection | null;
    readonly bucket: ChromeBucket;
    readonly onSelect: (selection: RemoteSelection) => void;
}): ReactElement {
    const { held } = props;
    const entries = useStore(held.runtime.store, selectSidebarEntries);
    const connection = useStore(held.runtime.store, (state) => state.ui.connection);
    const [collapsed, setCollapsed] = useState(() => readCollapsed(held.name));
    const [hovered, hover] = useHoverKey();

    const toggle = (): void => {
        setCollapsed((current) => {
            writeCollapsed(held.name, !current);
            return !current;
        });
    };

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
                            return (
                                <RemoteWorkspaceRow
                                    key={entry.workspace.id}
                                    held={held}
                                    workspace={entry.workspace as ChromeWorkspace}
                                    indented={false}
                                    bucket={props.bucket}
                                    selected={
                                        props.selection !== null &&
                                        props.selection.daemon === held.name &&
                                        props.selection.workspaceID === entry.workspace.id
                                    }
                                    onSelect={props.onSelect}
                                />
                            );
                        }
                        const group = entry.group;
                        return (
                            <div key={group.id} className="flex flex-col">
                                <button
                                    type="button"
                                    data-testid={`remote-group-${held.name}-${group.id}`}
                                    aria-expanded={!group.isCollapsed}
                                    className="flex w-full items-center gap-1.5 rounded px-2 py-1 pl-4 text-left text-[11px]"
                                    style={{ color: tokens.textTertiary }}
                                    onClick={() => {
                                        // The REMOTE daemon's own persisted collapse state,
                                        // toggled over its own connection — the mirror echoes
                                        // it back, exactly as on that machine's sidebar.
                                        void held.runtime.commands.setGroupCollapsed({
                                            groupID: group.id,
                                            collapsed: !group.isCollapsed
                                        });
                                    }}
                                >
                                    <span className="flex shrink-0 items-center">
                                        <ChromeIcon
                                            name={group.isCollapsed ? 'chevron-right' : 'chevron-down'}
                                            size={8}
                                        />
                                    </span>
                                    <span
                                        aria-hidden
                                        className="h-[6px] w-[6px] shrink-0 rounded-full"
                                        style={{ background: workspaceColorHex(group.color, props.bucket) }}
                                    />
                                    <span className="truncate font-semibold">{group.name}</span>
                                    <span className="ml-auto shrink-0 text-[10px]">
                                        {entry.workspaces.length}
                                    </span>
                                </button>
                                {group.isCollapsed
                                    ? null
                                    : entry.workspaces.map((workspace) => (
                                          <RemoteWorkspaceRow
                                              key={workspace.id}
                                              held={held}
                                              workspace={workspace as ChromeWorkspace}
                                              indented
                                              bucket={props.bucket}
                                              selected={
                                                  props.selection !== null &&
                                                  props.selection.daemon === held.name &&
                                                  props.selection.workspaceID === workspace.id
                                              }
                                              onSelect={props.onSelect}
                                          />
                                      ))}
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
