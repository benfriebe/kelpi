/**
 * The sidebar's remote-daemon sections (§1.7 multi-daemon groups) — one ACCORDION per
 * configured `remote-daemon`, rendered through the Sidebar's `trailingSections` slot.
 *
 * Below the accordion header, remote rows are the LOCAL sidebar's own components —
 * `WorkspaceRow` and `GroupHeaderRow`, exported from `chrome/Sidebar.tsx` — fed by
 * `selectSidebarEntries` over the remote store's mirror. A remote workspace or group is
 * therefore pixel-identical to a local one by construction: same avatars, status dots,
 * label chips, agent-count badges, group bands, nesting indents and §WS-007 guide rules,
 * with one implementation to drift from. Remote workspace rows also retain the local
 * sidebar's basic reorder gesture: a drop among their current siblings sends the same
 * `workspace-move` command through THAT daemon's client, then its mirror supplies the
 * canonical new order. The local list's multi-select/rename/context machinery remains
 * deliberately unwired here.
 *
 * The accordion header (status dot · name · chevron) collapses the whole host; that choice
 * is per-client convenience in `localStorage` (guarded — a blocked store defaults to
 * expanded). A remote GROUP's chevron, by contrast, toggles `set-group-collapsed` over the
 * remote daemon's own connection: its persisted state, mirrored back live.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
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

const REMOTE_DRAG_THRESHOLD_PX = 5;

interface RemoteWorkspaceDrag {
    readonly workspaceID: string;
    /** `null` means the daemon's top-level workspace list. */
    readonly groupID: string | null;
    /** Post-remove command index that returns this row to its original slot. */
    readonly sourceIndex: number;
    /** The sibling ids as the remote mirror looked when the user pressed. */
    readonly siblingIDs: readonly string[];
    /** Each sibling's index in the daemon container before the dragged row is removed. */
    readonly containerIndices: ReadonlyMap<string, number>;
    readonly startY: number;
    active: boolean;
}

/** The only list a remote drag may reorder: its source's current container. */
function remoteSiblings(
    entries: ReturnType<typeof selectSidebarEntries>,
    workspaceID: string
): {
    readonly groupID: string | null;
    readonly siblingIDs: readonly string[];
    readonly containerIndices: ReadonlyMap<string, number>;
} | null {
    // `workspace-move` indexes the full top-level order, groups included. The rows we may
    // reorder are only its workspace siblings, so retain both coordinate systems.
    const topLevel: string[] = [];
    const topLevelIndices = new Map<string, number>();
    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (entry?.kind !== 'workspace') continue;
        topLevel.push(entry.workspace.id);
        topLevelIndices.set(entry.workspace.id, index);
    }
    if (topLevel.includes(workspaceID)) {
        return { groupID: null, siblingIDs: topLevel, containerIndices: topLevelIndices };
    }
    for (const entry of entries) {
        if (entry.kind !== 'group') continue;
        const siblingIDs = entry.workspaces.map((workspace) => workspace.id);
        if (siblingIDs.includes(workspaceID)) {
            return {
                groupID: entry.group.id,
                siblingIDs,
                containerIndices: new Map(siblingIDs.map((id, index) => [id, index]))
            };
        }
    }
    return null;
}

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
    const [draggingWorkspaceID, setDraggingWorkspaceID] = useState<string | null>(null);
    const entriesRef = useRef(entries);
    const rowElements = useRef(new Map<string, HTMLElement>());
    const dragRef = useRef<RemoteWorkspaceDrag | null>(null);
    const suppressActivateRef = useRef(false);
    entriesRef.current = entries;

    const toggle = (): void => {
        setCollapsed((current) => {
            writeCollapsed(held.name, !current);
            return !current;
        });
    };

    const activate = (workspaceID: string): void => {
        // Mouseup after a drag is followed by click on this same row. Reordering must not also
        // navigate the remote workspace as a side effect of the drop.
        if (suppressActivateRef.current) return;
        props.onSelect({ daemon: held.name, workspaceID });
    };

    const dragStart = (workspaceID: string, event: React.MouseEvent): void => {
        if (event.button !== 0) return;
        const target = event.target as HTMLElement | null;
        if (target?.closest('input, button') !== null) return;
        const source = remoteSiblings(entriesRef.current, workspaceID);
        if (source === null || source.siblingIDs.length < 2) return;
        const sourceIndex = source.containerIndices.get(workspaceID);
        if (sourceIndex === undefined) return;
        dragRef.current = {
            workspaceID,
            groupID: source.groupID,
            sourceIndex,
            siblingIDs: source.siblingIDs,
            containerIndices: source.containerIndices,
            startY: event.clientY,
            active: false
        };
    };

    useEffect(() => {
        const insertionIndex = (drag: RemoteWorkspaceDrag, clientY: number): number | null => {
            const remaining = drag.siblingIDs.filter((workspaceID) => workspaceID !== drag.workspaceID);
            const commandIndex = (workspaceID: string, after: boolean): number | null => {
                const beforeRemoval = drag.containerIndices.get(workspaceID);
                if (beforeRemoval === undefined) return null;
                const afterRemoval = beforeRemoval - (drag.sourceIndex < beforeRemoval ? 1 : 0);
                return afterRemoval + (after ? 1 : 0);
            };
            let measured = false;
            for (let index = 0; index < remaining.length; index += 1) {
                const element = rowElements.current.get(`ws:${remaining[index]}`);
                if (element === undefined) continue;
                const rect = element.getBoundingClientRect();
                if (rect.height <= 0) continue;
                measured = true;
                if (clientY < rect.top + rect.height / 2) return commandIndex(remaining[index] as string, false);
            }
            // A pointer below the last sibling appends. Without a measured sibling (the sidebar
            // is hidden/unmounted), there is no trustworthy drop target and no command to send.
            const last = remaining.at(-1);
            return measured && last !== undefined ? commandIndex(last, true) : null;
        };

        const onMove = (event: MouseEvent): void => {
            const drag = dragRef.current;
            if (drag === null) return;
            if (!drag.active) {
                if (Math.abs(event.clientY - drag.startY) < REMOTE_DRAG_THRESHOLD_PX) return;
                drag.active = true;
                setDraggingWorkspaceID(drag.workspaceID);
            }
            event.preventDefault();
        };

        const onUp = (event: MouseEvent): void => {
            const drag = dragRef.current;
            dragRef.current = null;
            setDraggingWorkspaceID(null);
            if (drag === null || !drag.active) return;
            suppressActivateRef.current = true;
            // Retire only after the browser has delivered the click caused by this mouseup.
            globalThis.setTimeout(() => {
                suppressActivateRef.current = false;
            }, 0);
            const index = insertionIndex(drag, event.clientY);
            if (index === null || index === drag.sourceIndex) return;
            void held.runtime.commands.moveWorkspace({
                workspace: drag.workspaceID,
                ...(drag.groupID === null ? {} : { group: drag.groupID }),
                index
            });
        };

        globalThis.window.addEventListener('mousemove', onMove);
        globalThis.window.addEventListener('mouseup', onUp);
        return () => {
            globalThis.window.removeEventListener('mousemove', onMove);
            globalThis.window.removeEventListener('mouseup', onUp);
        };
    }, [held.runtime.commands]);

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
            dragging={draggingWorkspaceID === workspace.id}
            groupCaption={null}
            {...(options.guideColor === undefined ? {} : { guideColor: options.guideColor })}
            {...(options.guideExtendUp === undefined ? {} : { guideExtendUp: options.guideExtendUp })}
            {...(options.guideExtendDown === undefined ? {} : { guideExtendDown: options.guideExtendDown })}
            onActivate={activate}
            onContextMenu={noop}
            onDragStart={dragStart}
            onCommitRename={noop}
            onCancelRename={noop}
            registerRow={(key, element) => {
                if (element === null) rowElements.current.delete(key);
                else rowElements.current.set(key, element);
            }}
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
                                ? 'connection refused - check the pairing URL'
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
