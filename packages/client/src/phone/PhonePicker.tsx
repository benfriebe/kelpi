/**
 * The picker: one card above the location bar, three levels of the same place.
 *
 *   Hosts       every host with its reachability and its waiting count; tapping one goes to Home on
 *               that host. Add a host (Scan code, Paste URL) and Settings sit at the foot.
 *   Workspaces  the host's workspaces in sidebar order, its groups folding as the daemon has them;
 *               tapping one opens it. New workspace at the foot.
 *   Panes       the workspace's panes; tapping one shows it (by focusing it, `phone/view.ts`). The
 *               New pane grid at the foot opens a terminal, an agent, a web page, a scratchpad or a
 *               plugin's view in this workspace.
 *
 * The tabs along the top name the two levels that are not open by what is CURRENT there (the host,
 * the workspace) and the open one by its count, so the card always says where the person is while
 * showing them where else they could be. It replaces the drawer and the pane sheet: those were two
 * surfaces over two levels of one tree, and this is one surface over all three.
 *
 * It writes nothing itself. Every row is a callback the shell owns, the same verbs the drawer and
 * the pane sheet used, so a workspace opened here and one opened from Home take one path.
 */

import { useState, type ReactElement, type ReactNode } from 'react';
import { useStore } from 'zustand';

import type { WorkspaceState } from '@kelpi/daemon/store';

import type { ChromeBucket } from '../chrome/theme';
import { tokens } from '../chrome/tokens';
import { homeAbbreviated, type PaneModel } from '../grid';
import { usePlugins } from '../plugins/client';
import { selectSidebarEntries, type KelpiRuntime } from '../state';
import { workspaceKey, type PhoneAttention } from './attention';
import type { PhoneHostReading } from './fleet';
import { PhoneGlyph } from './glyphs';
import type { PhoneHostModel } from './model';
import { PHONE_NEW_PANE_OPTIONS, type PhoneNewPaneKind } from './new-pane';
import { PHONE_PICKER_BOTTOM, type PhonePickerLevel } from './PhoneLocationBar';
import { GlyphTile, HostDot, WaitingBadge, WorkspaceAvatar, WorkspaceSwatch, hostKindLabel, hostReachability, paneTypeGlyph, phonePaneTitle } from './parts';
import { phoneStyle } from './style';
import { PhoneFloatingCard } from './ui';

export interface PhonePickerProps {
    readonly open: boolean;
    readonly level: PhonePickerLevel;
    readonly onLevel: (level: PhonePickerLevel) => void;
    readonly fleet: readonly PhoneHostReading[];
    readonly attention: PhoneAttention;
    readonly bucket: ChromeBucket;
    /** The host the bar names: the one on screen, or Home's. */
    readonly host: PhoneHostModel;
    /** The workspace on screen; null on Home, where the picker has no Panes level. */
    readonly workspace: WorkspaceState | null;
    readonly shownPaneID: string | null;
    readonly homeDirectory: string;
    readonly onHost: (hostKey: string) => void;
    readonly onRemoveHost: (hostKey: string) => void;
    readonly onRetryHost: (hostKey: string) => void;
    readonly onScanHost: () => void;
    readonly onPasteHost: () => void;
    readonly onSettings: () => void;
    readonly onWorkspace: (workspaceID: string) => void;
    readonly onNewWorkspace: () => void;
    readonly onPane: (paneID: string) => void;
    readonly onNewPane: (kind: PhoneNewPaneKind) => void;
    readonly onPluginView: (pluginID: string, viewID: string) => void;
    readonly onClose: () => void;
}

function Row(props: {
    readonly testID: string;
    readonly workspaceID?: string;
    readonly current?: boolean;
    readonly dim?: boolean;
    readonly indent?: number;
    readonly onClick: () => void;
    readonly children: ReactNode;
}): ReactElement {
    return (
        <button
            type="button"
            data-testid={props.testID}
            data-workspace-id={props.workspaceID}
            data-current={props.current === true ? 'true' : 'false'}
            className="flex min-h-[50px] w-full min-w-0 items-center gap-3 rounded-[12px] pr-[10px] text-left"
            style={{
                paddingLeft: 10 + (props.indent ?? 0),
                background: props.current === true ? phoneStyle.selected : 'transparent',
                color: tokens.textPrimary,
                opacity: props.dim === true ? 0.65 : 1
            }}
            onClick={props.onClick}
        >
            {props.children}
        </button>
    );
}

function RowText(props: { readonly title: ReactNode; readonly sub: ReactNode; readonly subColor?: string }): ReactElement {
    return (
        <span className="flex min-w-0 flex-1 flex-col gap-[1px]">
            <span className="flex min-w-0 items-center gap-[6px] truncate text-[15px] font-medium">{props.title}</span>
            <span className="truncate text-[12px]" style={{ color: props.subColor ?? tokens.textSecondary }}>
                {props.sub}
            </span>
        </span>
    );
}

function Heading(props: { readonly children: ReactNode }): ReactElement {
    return (
        <h3 className="m-0 px-[10px] pt-[6px] text-[12px] font-semibold tracking-[0.6px] uppercase" style={{ color: tokens.textSecondary }}>
            {props.children}
        </h3>
    );
}

function Check(): ReactElement {
    return (
        <span className="flex shrink-0" style={{ color: tokens.accent }}>
            <PhoneGlyph name="check" size={18} weight={2.4} label="Current" />
        </span>
    );
}

function plural(count: number, one: string): string {
    return `${String(count)} ${one}${count === 1 ? '' : 's'}`;
}

// ── hosts ───────────────────────────────────────────────────────────────────────────────

function HostsLevel(props: PhonePickerProps): ReactElement {
    // Forgetting a host drops its pairing from this phone, so it takes a second, deliberate tap.
    const [confirming, setConfirming] = useState<string | null>(null);
    return (
        <>
            <div className="flex flex-col" data-testid="phone-picker-hosts">
                {props.fleet.map((reading) => {
                    const { host, connection } = reading;
                    const waiting = props.attention.waitingByHost.get(host.key) ?? 0;
                    const reachable = connection === 'connected';
                    const status = reading.known && reachable
                        ? `${hostKindLabel(host.kind)} · ${plural(reading.workspaces.length, 'workspace')}`
                        : `${hostKindLabel(host.kind)} · ${hostReachability(connection)}`;
                    return (
                        <div key={host.key} className="flex items-center gap-1" data-testid={`phone-host-${host.key}`} data-host-kind={host.kind} data-status={connection}>
                            <Row testID={`phone-picker-host-${host.key}`} current={host.key === props.host.key} dim={!reachable} onClick={() => props.onHost(host.key)}>
                                <GlyphTile name="server" size={34} />
                                <RowText
                                    title={host.name}
                                    sub={
                                        <span className="flex items-center gap-[6px]">
                                            <HostDot status={connection} size={6} />
                                            {status}
                                        </span>
                                    }
                                />
                                {waiting > 0 ? <WaitingBadge testID={`phone-host-waiting-${host.key}`}>{`${String(waiting)} waiting`}</WaitingBadge> : null}
                                {host.key === props.host.key ? <Check /> : null}
                            </Row>
                            {connection === 'closed' || connection === 'rejected' ? (
                                <button
                                    type="button"
                                    data-testid={`phone-host-retry-${host.key}`}
                                    className="h-[44px] shrink-0 rounded-[12px] border px-3 text-[14px]"
                                    style={{ borderColor: phoneStyle.raisedBorder, color: tokens.textPrimary }}
                                    onClick={() => props.onRetryHost(host.key)}
                                >
                                    Retry
                                </button>
                            ) : null}
                            {host.removable && confirming === host.key ? (
                                <button
                                    type="button"
                                    data-testid={`phone-host-remove-confirm-${host.key}`}
                                    aria-label={`Forget ${host.name} on this phone`}
                                    className="h-[44px] shrink-0 rounded-[12px] px-3 text-[14px] font-semibold"
                                    style={{ color: '#FFFFFF', background: '#C9393E' }}
                                    onClick={() => {
                                        setConfirming(null);
                                        props.onRemoveHost(host.key);
                                    }}
                                >
                                    Remove
                                </button>
                            ) : host.removable ? (
                                <button
                                    type="button"
                                    data-testid={`phone-host-remove-${host.key}`}
                                    aria-label={`Remove ${host.name}`}
                                    className="flex h-[44px] w-[44px] shrink-0 items-center justify-center"
                                    style={{ color: tokens.textTertiary }}
                                    onClick={() => setConfirming(host.key)}
                                >
                                    <PhoneGlyph name="x" size={16} />
                                </button>
                            ) : null}
                        </div>
                    );
                })}
            </div>
            <Heading>Add a host</Heading>
            <div className="grid grid-cols-2 gap-[6px]">
                <button
                    type="button"
                    data-testid="phone-picker-scan"
                    className="flex h-[52px] items-center justify-center gap-2 rounded-[14px] text-[14px] font-semibold"
                    style={{ background: phoneStyle.accentFill, color: phoneStyle.onAccent }}
                    onClick={props.onScanHost}
                >
                    <PhoneGlyph name="qr" size={18} weight={2} />
                    Scan code
                </button>
                <button
                    type="button"
                    data-testid="phone-add-host"
                    className="flex h-[52px] items-center justify-center gap-2 rounded-[14px] border text-[14px] font-medium"
                    style={{ background: phoneStyle.card, borderColor: phoneStyle.raisedBorder, color: tokens.textPrimary }}
                    onClick={props.onPasteHost}
                >
                    <PhoneGlyph name="clipboard" size={18} />
                    Paste URL
                </button>
            </div>
            <button
                type="button"
                data-testid="phone-picker-settings"
                className="flex min-h-[48px] items-center gap-3 border-t px-[10px] text-left text-[15px]"
                style={{ borderColor: phoneStyle.raisedBorder, color: tokens.textPrimary }}
                onClick={props.onSettings}
            >
                <PhoneGlyph name="gear" size={18} />
                <span className="flex-1">Settings</span>
                <span style={{ color: tokens.textTertiary }}>
                    <PhoneGlyph name="chevron-right" size={16} />
                </span>
            </button>
        </>
    );
}

// ── workspaces ──────────────────────────────────────────────────────────────────────────

function workspaceSummary(workspace: WorkspaceState, waiting: number): { text: string; color: string } {
    const panes = plural(workspace.panes.length, 'pane');
    if (waiting > 0) return { text: `${panes} · ${String(waiting)} waiting`, color: phoneStyle.waitingText };
    if (workspace.panes.some((pane) => pane.status === 'running')) return { text: `${panes} · running`, color: tokens.statusRunning };
    return { text: `${panes} · ${workspace.muted ? 'idle · muted' : 'idle'}`, color: tokens.textSecondary };
}

function WorkspacesLevel(props: PhonePickerProps & { readonly runtime: KelpiRuntime }): ReactElement {
    const entries = useStore(props.runtime.store, selectSidebarEntries);
    const row = (workspace: WorkspaceState, indent: number): ReactElement => {
        const waiting = props.attention.waitingByWorkspace.get(workspaceKey(props.host.key, workspace.id)) ?? 0;
        const summary = workspaceSummary(workspace, waiting);
        const current = props.workspace?.id === workspace.id;
        return (
            <Row key={workspace.id} testID={`phone-picker-workspace-${workspace.id}`} workspaceID={workspace.id} current={current} indent={indent} onClick={() => props.onWorkspace(workspace.id)}>
                <WorkspaceAvatar workspace={workspace} bucket={props.bucket} size={indent > 0 ? 24 : 28} />
                <RowText
                    title={
                        <>
                            <span className="truncate">{workspace.name}</span>
                            {workspace.muted ? (
                                <span className="flex shrink-0" style={{ color: tokens.textSecondary }}>
                                    <PhoneGlyph name="bell-off" size={13} label="Muted" />
                                </span>
                            ) : null}
                        </>
                    }
                    sub={summary.text}
                    subColor={summary.color}
                />
                {current ? <Check /> : null}
            </Row>
        );
    };
    const withNested = (workspace: WorkspaceState, nested: ReadonlyMap<string, readonly WorkspaceState[]> | undefined, indent: number): ReactElement[] => [
        row(workspace, indent),
        ...(workspace.childrenCollapsed === true ? [] : (nested?.get(workspace.id) ?? []).map((child) => row(child, indent + 24)))
    ];

    return (
        <>
            <div className="flex min-h-0 flex-col overflow-y-auto" data-testid="phone-picker-workspaces">
                {entries.length === 0 ? (
                    <span className="px-[10px] py-3 text-[14px]" style={{ color: tokens.textSecondary }}>
                        {`No workspaces on ${props.host.name} yet.`}
                    </span>
                ) : null}
                {entries.flatMap((entry) => {
                    if (entry.kind === 'workspace') return withNested(entry.workspace, entry.nested, 0);
                    const group = entry.group;
                    return [
                        <button
                            key={group.id}
                            type="button"
                            data-testid={`phone-picker-group-${group.id}`}
                            aria-expanded={!group.isCollapsed}
                            className="flex min-h-[48px] items-center gap-3 rounded-[12px] px-[10px] text-left text-[14px] font-semibold"
                            style={{ color: tokens.textPrimary }}
                            onClick={() => {
                                // The daemon's own collapse state, over that host's connection, as
                                // the sidebar's group header sends it.
                                void props.runtime.commands.setGroupCollapsed({ groupID: group.id, collapsed: !group.isCollapsed });
                            }}
                        >
                            <span className="flex shrink-0" style={{ color: tokens.textSecondary }}>
                                <PhoneGlyph name="folder" size={18} />
                            </span>
                            <span className="flex-1 truncate">{group.name}</span>
                            <span className="text-[12px] font-normal" style={{ color: tokens.textSecondary }}>
                                {String(entry.workspaces.length)}
                            </span>
                            <span className="flex shrink-0" style={{ color: tokens.textTertiary }}>
                                <PhoneGlyph name={group.isCollapsed ? 'chevron-right' : 'chevron-down'} size={16} />
                            </span>
                        </button>,
                        ...(group.isCollapsed ? [] : entry.workspaces.flatMap((workspace) => withNested(workspace, entry.nested, 24)))
                    ];
                })}
            </div>
            <button
                type="button"
                data-testid="phone-new-workspace"
                className="flex min-h-[48px] shrink-0 items-center gap-3 border-t px-[10px] text-left text-[15px] font-semibold"
                style={{ borderColor: phoneStyle.raisedBorder, color: tokens.accent }}
                onClick={props.onNewWorkspace}
            >
                <PhoneGlyph name="plus" size={18} weight={2} />
                New workspace
            </button>
        </>
    );
}

// ── panes ───────────────────────────────────────────────────────────────────────────────

function paneSubtitle(pane: PaneModel & { readonly plugin?: { readonly pluginID: string } | undefined }, homeDirectory: string): string {
    if (pane.agentKind !== null) {
        const tasks = pane.backgroundTaskCount > 0 ? ` · ${plural(pane.backgroundTaskCount, 'background task')}` : '';
        return `agent${tasks}`;
    }
    if (pane.type === 'plugin') return `plugin · ${pane.plugin?.pluginID ?? 'view'}`;
    if (pane.type !== 'shell' && pane.filePath !== null) return `${pane.type} · ${homeAbbreviated(pane.filePath, homeDirectory)}`;
    if (pane.workingDirectory !== null && pane.workingDirectory.length > 0) return homeAbbreviated(pane.workingDirectory, homeDirectory);
    return pane.type === 'shell' ? 'terminal' : pane.type;
}

function PluginViewTiles(props: { readonly runtime: KelpiRuntime; readonly onOpen: (pluginID: string, viewID: string) => void }): ReactElement | null {
    const { plugins } = usePlugins(props.runtime);
    const views = plugins
        .filter((plugin) => plugin.enabled && plugin.status !== 'failed')
        .flatMap((plugin) =>
            plugin.manifest.contributes.views
                .filter((view) => view.placements.includes('pane'))
                .map((view) => ({ pluginID: plugin.manifest.id, viewID: view.id, title: view.title }))
        );
    if (views.length === 0) return null;
    return (
        <>
            {views.map((view) => (
                <NewPaneTile
                    key={`${view.pluginID}/${view.viewID}`}
                    testID={`phone-new-pane-plugin-${view.pluginID}-${view.viewID}`}
                    label={view.title}
                    glyph="plugin"
                    onClick={() => props.onOpen(view.pluginID, view.viewID)}
                />
            ))}
        </>
    );
}

function NewPaneTile(props: { readonly testID: string; readonly label: string; readonly glyph: Parameters<typeof PhoneGlyph>[0]['name']; readonly onClick: () => void }): ReactElement {
    return (
        <button
            type="button"
            data-testid={props.testID}
            className="flex h-[64px] min-w-0 flex-col items-center justify-center gap-[6px] rounded-[14px] border px-1 text-[12px]"
            style={{ background: phoneStyle.card, borderColor: phoneStyle.cardBorder, color: tokens.textPrimary }}
            onClick={props.onClick}
        >
            <PhoneGlyph name={props.glyph} size={19} />
            <span className="max-w-full truncate">{props.label}</span>
        </button>
    );
}

function PanesLevel(props: PhonePickerProps & { readonly workspace: WorkspaceState; readonly runtime: KelpiRuntime }): ReactElement {
    const panes = props.workspace.panes;
    return (
        <>
            <div className="flex min-h-0 flex-col overflow-y-auto" data-testid="phone-pane-list">
                {panes.length === 0 ? (
                    <span className="px-[10px] py-3 text-[14px]" style={{ color: tokens.textSecondary }}>
                        No panes in this workspace.
                    </span>
                ) : null}
                {panes.map((pane) => {
                    const shown = pane.id === props.shownPaneID;
                    // A muted workspace raises no attention signal, here as everywhere.
                    const waiting = pane.status === 'waitingForInput' && !(props.workspace?.muted ?? false);
                    return (
                        <div key={pane.id} data-testid={`phone-pane-row-${pane.id}`} data-shown={shown ? 'true' : 'false'}>
                            <Row testID={`phone-pane-show-${pane.id}`} current={shown} onClick={() => props.onPane(pane.id)}>
                                <GlyphTile name={paneTypeGlyph(pane)} waiting={waiting} />
                                <RowText title={<span className="truncate">{phonePaneTitle(pane, props.homeDirectory)}</span>} sub={paneSubtitle(pane, props.homeDirectory)} />
                                {waiting ? <WaitingBadge testID={`phone-pane-status-${pane.id}`}>waiting</WaitingBadge> : null}
                                {pane.status === 'running' ? (
                                    <span className="shrink-0 text-[12px]" data-testid={`phone-pane-status-${pane.id}`} style={{ color: tokens.statusRunning }}>
                                        running
                                    </span>
                                ) : null}
                            </Row>
                        </div>
                    );
                })}
            </div>
            <Heading>New pane</Heading>
            <div className="grid shrink-0 grid-cols-3 gap-[6px]" data-testid="phone-new-pane-grid">
                {PHONE_NEW_PANE_OPTIONS.map((option) => (
                    <NewPaneTile
                        key={option.kind}
                        testID={`phone-new-pane-${option.kind}`}
                        label={option.label}
                        glyph={option.kind === 'terminal' ? 'terminal' : option.kind === 'web' ? 'globe' : option.kind === 'scratchpad' ? 'note' : option.kind === 'diff' ? 'diff' : 'agent'}
                        onClick={() => props.onNewPane(option.kind)}
                    />
                ))}
                <PluginViewTiles runtime={props.runtime} onOpen={props.onPluginView} />
            </div>
        </>
    );
}

// ── the card ────────────────────────────────────────────────────────────────────────────

function Tab(props: { readonly testID: string; readonly selected: boolean; readonly onClick: () => void; readonly children: ReactNode }): ReactElement {
    return (
        <button
            type="button"
            data-testid={props.testID}
            aria-pressed={props.selected}
            className="flex min-h-[44px] min-w-0 items-center justify-center gap-[5px] truncate rounded-[11px] px-1 text-[13px]"
            style={{
                background: props.selected ? phoneStyle.selected : 'transparent',
                color: props.selected ? tokens.textPrimary : tokens.textSecondary,
                fontWeight: props.selected ? 600 : 400
            }}
            onClick={props.onClick}
        >
            {props.children}
        </button>
    );
}

export function PhonePicker(props: PhonePickerProps): ReactElement | null {
    const reading = props.fleet.find((entry) => entry.host.key === props.host.key);
    const level = props.workspace === null && props.level === 'panes' ? 'workspaces' : props.level;
    const shownPane = props.workspace?.panes.find((pane) => pane.id === props.shownPaneID) ?? null;
    const label = level === 'hosts' ? 'Switch host' : level === 'workspaces' ? 'Switch workspace' : 'Switch pane';

    return (
        <PhoneFloatingCard open={props.open} label={label} testID="phone-picker" bottom={PHONE_PICKER_BOTTOM} onClose={props.onClose}>
            <div
                role="group"
                aria-label="Level"
                data-testid="phone-picker-tabs"
                data-level={level}
                className="grid shrink-0 gap-[3px] rounded-[14px] p-[3px]"
                style={{ background: phoneStyle.sunken, gridTemplateColumns: `repeat(${props.workspace === null ? 2 : 3}, minmax(0, 1fr))` }}
            >
                <Tab testID="phone-picker-tab-hosts" selected={level === 'hosts'} onClick={() => props.onLevel('hosts')}>
                    {level === 'hosts' ? (
                        `Hosts · ${String(props.fleet.length)}`
                    ) : (
                        <>
                            {reading === undefined ? null : <HostDot status={reading.connection} size={6} />}
                            <span className="truncate">{props.host.name}</span>
                        </>
                    )}
                </Tab>
                <Tab testID="phone-picker-tab-workspaces" selected={level === 'workspaces'} onClick={() => props.onLevel('workspaces')}>
                    {level === 'workspaces' || props.workspace === null ? (
                        `Workspaces · ${String(reading?.workspaces.length ?? 0)}`
                    ) : (
                        <>
                            <WorkspaceSwatch color={props.workspace.color} bucket={props.bucket} />
                            <span className="truncate">{props.workspace.name}</span>
                        </>
                    )}
                </Tab>
                {props.workspace === null ? null : (
                    <Tab testID="phone-picker-tab-panes" selected={level === 'panes'} onClick={() => props.onLevel('panes')}>
                        {level === 'panes' || shownPane === null ? (
                            `Panes · ${String(props.workspace.panes.length)}`
                        ) : (
                            <span className="truncate">{phonePaneTitle(shownPane, props.homeDirectory)}</span>
                        )}
                    </Tab>
                )}
            </div>
            {level === 'hosts' ? <HostsLevel {...props} /> : null}
            {level === 'workspaces' ? <WorkspacesLevel {...props} runtime={props.host.runtime} /> : null}
            {level === 'panes' && props.workspace !== null ? (
                <PanesLevel {...props} workspace={props.workspace} runtime={props.host.runtime} />
            ) : null}
        </PhoneFloatingCard>
    );
}
