/**
 * The status bar's running-services chip and its popover (docs/running-services.md §7).
 *
 * One line per service: the workspace's avatar and name (the sidebar's, so the eye matches them),
 * the service, its ports and its memory. A workspace's later services leave its column blank, so
 * there is no heading per workspace. Below a rule, what was left running with no workspace,
 * grouped by the worktree it ran in (a deleted worktree's stacks list together, once), and last,
 * collapsed, what was started outside Kelpi (D2). A port opens in a web pane; a workspace's name
 * switches to it. Uptime is in each name's tooltip, not a column.
 *
 * Nothing is drawn until a scan finds something to list.
 */

import { useCallback, useRef, useState, type ReactElement } from 'react';

import type { RunningServiceEntry, RunningServicePort } from '@kelpi/protocol';

import { useDismissable } from './dismissable';
import { avatarLetter, ChromeIcon, iconGlyph, iconIsTintable } from './icons';
import { useOverlayPresence } from './modal-presence';
import { ageText, memoryText, portURL, uptimeText, type WorkspaceLook } from './running';
import { ROUNDED_FONT_STACK } from './Sidebar';
import { SIDEBAR_TINT_VARS, tintedColor, withAlpha, workspaceColorHex, type ChromeBucket } from './theme';
import { tokens } from './tokens';

export interface RunningServicesChipProps {
    readonly services: readonly RunningServiceEntry[];
    readonly scannedAt: string | null;
    readonly homeDirectory: string;
    readonly bucket: ChromeBucket;
    /** Each workspace's color and icon, keyed by uppercase id; a missing one draws a plain letter. */
    readonly looks?: ReadonlyMap<string, WorkspaceLook> | undefined;
    readonly onOpenPort?: ((service: RunningServiceEntry, port: RunningServicePort) => void) | undefined;
    readonly onSelectWorkspace?: ((workspaceID: string) => void) | undefined;
}

/** workspace · service · ports · memory, shared by every workspace row so the columns line up. */
const ROW = 'grid h-[26px] grid-cols-[96px_minmax(0,1fr)_auto_46px] items-center gap-x-2.5 rounded-[5px] px-1.5';

/** The sidebar's avatar at 18px: the same tint, border, icon and letter. */
function MiniAvatar(props: { readonly name: string; readonly look: WorkspaceLook | undefined; readonly bucket: ChromeBucket }): ReactElement {
    const color = props.look?.color ?? null;
    const hex = color === null ? tokens.textSecondary : workspaceColorHex(color, props.bucket);
    const icon = props.look?.icon ?? null;
    const glyph = iconGlyph(icon);
    return (
        <span
            aria-hidden
            className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[4px]"
            style={{
                background: tintedColor(hex, SIDEBAR_TINT_VARS.avatarFill, 0.2),
                border: `1px solid ${tintedColor(hex, SIDEBAR_TINT_VARS.avatarStroke, 0.45)}`
            }}
        >
            <span
                className={glyph === null ? 'text-[10px] font-bold' : 'text-[11px] font-semibold'}
                style={{
                    ...(glyph === null || iconIsTintable(icon) ? { color: hex } : {}),
                    ...(glyph === null ? { fontFamily: ROUNDED_FONT_STACK } : {})
                }}
            >
                {glyph ?? avatarLetter(props.name)}
            </span>
        </span>
    );
}

function PortLinks(props: {
    readonly service: RunningServiceEntry;
    readonly shown: number;
    readonly onOpenPort?: RunningServicesChipProps['onOpenPort'];
}): ReactElement {
    const { service } = props;
    const ports = service.ports.slice(0, props.shown);
    const more = service.ports.slice(props.shown);
    return (
        <span className="flex items-baseline justify-end gap-2 font-mono text-[11px]">
            {ports.map((port) => (
                <button
                    key={`${String(port.port)}:${port.address}`}
                    type="button"
                    className="hover:underline"
                    style={{ color: tokens.statusRunning }}
                    title={`Open ${portURL(port)} in a web pane`}
                    onClick={() => props.onOpenPort?.(service, port)}
                >
                    :{port.port}
                </button>
            ))}
            {more.length > 0 ? (
                <span style={{ color: tokens.textTertiary }} title={more.map((port) => `:${String(port.port)}`).join(' ')}>
                    +{more.length}
                </span>
            ) : null}
        </span>
    );
}

/** What is worth saying after a service's name: an agent started it, or it outlived its pane. */
function serviceNote(service: RunningServiceEntry): string | null {
    if (service.agent === 'claude') return 'Claude';
    if (service.agent === 'codex') return 'Codex';
    if (service.pane_id === null && service.started_by !== 'compose') return 'detached';
    return null;
}

function basename(path: string): string {
    const trimmed = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;
    return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

interface LeftoverGroup {
    readonly key: string;
    readonly folder: string | null;
    readonly deleted: boolean;
    readonly services: readonly RunningServiceEntry[];
    /** The oldest stack's start, for the group's age. */
    readonly startedAt: string | null;
}

/** Leftovers by the worktree they ran in, in the scan's order. */
export function leftoverGroups(services: readonly RunningServiceEntry[]): LeftoverGroup[] {
    const groups = new Map<string, RunningServiceEntry[]>();
    for (const service of services) {
        const key = service.worktree ?? service.directory ?? service.id;
        groups.set(key, [...(groups.get(key) ?? []), service]);
    }
    return [...groups.entries()].map(([key, members]) => {
        const starts = members
            .map((service) => service.started_at)
            .filter((at): at is string => at !== null)
            .sort();
        return {
            key,
            folder: members[0]?.worktree ?? members[0]?.directory ?? null,
            deleted: members.some((service) => service.directory_missing),
            services: members,
            startedAt: starts[0] ?? null
        };
    });
}

export function RunningServicesChip(props: RunningServicesChipProps): ReactElement | null {
    const [open, setOpen] = useState(false);
    const [showOutside, setShowOutside] = useState(false);
    const chipRef = useRef<HTMLButtonElement | null>(null);
    const popoverRef = useRef<HTMLDivElement | null>(null);
    const close = useCallback(() => setOpen(false), []);
    useDismissable(open, close, [chipRef, popoverRef]);
    useOverlayPresence(popoverRef, open);

    const owned = props.services.filter((service) => service.category === 'workspace');
    const unattached = props.services.filter((service) => service.category === 'unattached');
    const outside = props.services.filter((service) => service.category === 'outside');
    if (owned.length + unattached.length === 0) return null;
    const memory = owned.reduce((sum, service) => sum + (service.rss_bytes ?? 0), 0);
    const warn = workspaceColorHex('orange', props.bucket);
    const groups = leftoverGroups(unattached);
    const allDeleted = groups.every((group) => group.deleted);

    // Workspaces in the scan's order, which is the sidebar's.
    const byWorkspace = new Map<string, RunningServiceEntry[]>();
    for (const service of owned) {
        const key = service.workspace_id ?? '';
        byWorkspace.set(key, [...(byWorkspace.get(key) ?? []), service]);
    }
    const hover = withAlpha(tokens.textPrimary, 0.05);

    return (
        <>
            <button
                ref={chipRef}
                type="button"
                data-testid="footer-running"
                data-count={owned.length}
                aria-expanded={open}
                aria-label={`${String(owned.length)} running services${unattached.length > 0 ? `, ${String(unattached.length)} leftover` : ''}`}
                className="flex shrink-0 items-center gap-1 whitespace-nowrap"
                style={{ color: open ? tokens.textPrimary : tokens.textSecondary }}
                onClick={() => setOpen((value) => !value)}
            >
                <span style={{ color: tokens.statusRunning }}>
                    <ChromeIcon name="plug" size={11} />
                </span>
                <span className="font-mono tabular-nums">{owned.length}</span>
                <span>{owned.length === 1 ? 'service' : 'services'}</span>
                {unattached.length > 0 ? <span style={{ color: warn }}>· {unattached.length} leftover</span> : null}
            </button>
            {!open ? null : (
                <div
                    ref={popoverRef}
                    data-testid="running-popover"
                    role="dialog"
                    aria-label="Running services"
                    className="absolute bottom-7 right-3 z-40 flex max-h-[60vh] w-[440px] max-w-[calc(100vw-24px)] flex-col overflow-y-auto rounded-lg text-[12px]"
                    style={{
                        background: tokens.surfaceBackground,
                        border: `1px solid ${tokens.divider}`,
                        boxShadow: '0 12px 32px rgba(0,0,0,0.38)'
                    }}
                >
                    <div className="flex shrink-0 items-center gap-1.5 px-3.5 pb-2 pt-2.5 font-semibold" style={{ color: tokens.textPrimary }}>
                        <span style={{ color: tokens.statusRunning }}>
                            <ChromeIcon name="plug" />
                        </span>
                        Services
                        {memory > 0 ? (
                            <span className="ml-auto font-mono text-[11px] font-normal" style={{ color: tokens.textTertiary }} title="Memory used by your workspaces' services">
                                {memoryText(memory)}
                            </span>
                        ) : null}
                    </div>

                    {owned.length === 0 ? null : (
                        <div className="flex shrink-0 flex-col px-2 pb-2" data-testid="running-popover-workspaces">
                            {[...byWorkspace.entries()].flatMap(([workspaceID, services]) =>
                                services.map((service, index) => {
                                    const note = serviceNote(service);
                                    const name = service.workspace_name ?? 'Workspace';
                                    return (
                                        <div
                                            key={service.id}
                                            data-testid="running-popover-service"
                                            data-workspace-id={workspaceID}
                                            className={`${ROW} hover:bg-[var(--running-row-hover)]`}
                                            style={{ ['--running-row-hover' as string]: hover }}
                                        >
                                            {index > 0 ? (
                                                <span />
                                            ) : (
                                                <button
                                                    type="button"
                                                    className="flex min-w-0 items-center gap-[7px] text-left"
                                                    title={`Go to ${name}`}
                                                    onClick={() => {
                                                        props.onSelectWorkspace?.(workspaceID);
                                                        setOpen(false);
                                                    }}
                                                >
                                                    <MiniAvatar name={name} look={props.looks?.get(workspaceID.toUpperCase())} bucket={props.bucket} />
                                                    <span className="min-w-0 truncate" style={{ color: tokens.textPrimary }}>
                                                        {name}
                                                    </span>
                                                </button>
                                            )}
                                            <span
                                                className="min-w-0 truncate"
                                                style={{ color: tokens.textSecondary }}
                                                title={`${service.command}\nup ${uptimeText(service.started_at, props.scannedAt)}`}
                                            >
                                                {service.name}
                                                {note === null ? null : <span style={{ color: tokens.textTertiary }}> · {note}</span>}
                                            </span>
                                            <PortLinks service={service} shown={2} onOpenPort={props.onOpenPort} />
                                            <span className="text-right font-mono text-[10.5px]" style={{ color: tokens.textSecondary }}>
                                                {service.rss_bytes === null ? '' : memoryText(service.rss_bytes)}
                                            </span>
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    )}

                    {groups.length === 0 ? null : (
                        <div
                            className="flex shrink-0 flex-col gap-1.5 px-3.5 pb-2 pt-2.5"
                            style={{ borderTop: `1px solid ${tokens.divider}` }}
                            data-testid="running-popover-unattached"
                        >
                            <div className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: warn }}>
                                <ChromeIcon name="warning" />
                                {allDeleted ? 'Left running after their worktree was deleted' : 'Not in a workspace'}
                            </div>
                            <div className="flex flex-col">
                                {groups.map((group, index) => {
                                    const age = ageText(group.startedAt, props.scannedAt);
                                    const meta = [
                                        group.deleted && !allDeleted ? 'deleted' : null,
                                        `${String(group.services.length)} ${group.services.length === 1 ? 'stack' : 'stacks'}`,
                                        age
                                    ].filter((part): part is string => part !== null);
                                    return (
                                        <div key={group.key} className={`flex flex-col ${index > 0 ? 'mt-1' : ''}`} data-testid="running-popover-worktree">
                                            <div className="flex h-[22px] min-w-0 items-baseline gap-2">
                                                <span className="min-w-0 truncate font-medium" style={{ color: tokens.textPrimary }} title={group.folder ?? undefined}>
                                                    {group.folder === null ? 'Unknown folder' : basename(group.folder)}
                                                </span>
                                                <span className="shrink-0 text-[11px]" style={{ color: tokens.textTertiary }}>
                                                    {meta.join(' · ')}
                                                </span>
                                            </div>
                                            {group.services.map((service) => (
                                                <div
                                                    key={service.id}
                                                    className="grid h-[22px] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 pl-3"
                                                    data-testid="running-popover-service"
                                                >
                                                    <span className="min-w-0 truncate" style={{ color: tokens.textSecondary }} title={service.directory ?? service.command}>
                                                        {service.name}
                                                    </span>
                                                    <PortLinks service={service} shown={1} onOpenPort={props.onOpenPort} />
                                                </div>
                                            ))}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {outside.length === 0 ? null : (
                        <div className="flex shrink-0 flex-col" style={{ borderTop: `1px solid ${tokens.divider}` }} data-testid="running-popover-outside">
                            <button
                                type="button"
                                className="flex h-8 shrink-0 items-center gap-1.5 px-3.5 text-left text-[11px]"
                                style={{ color: tokens.textSecondary }}
                                aria-expanded={showOutside}
                                onClick={() => setShowOutside((value) => !value)}
                            >
                                <ChromeIcon name={showOutside ? 'chevron-down' : 'chevron-right'} size={10} />
                                Started outside Kelpi
                                <span className="ml-auto" style={{ color: tokens.textTertiary }}>
                                    {outside.length}
                                </span>
                            </button>
                            {!showOutside ? null : (
                                <div className="flex flex-col px-3.5 pb-2">
                                    {outside.map((service) => (
                                        <div
                                            key={service.id}
                                            className="grid h-[22px] grid-cols-[minmax(0,1fr)_auto_46px] items-center gap-x-2.5"
                                            data-testid="running-popover-service"
                                        >
                                            <span
                                                className="min-w-0 truncate"
                                                style={{ color: tokens.textSecondary }}
                                                title={`${service.command}\nup ${uptimeText(service.started_at, props.scannedAt)}`}
                                            >
                                                {service.name}
                                            </span>
                                            <PortLinks service={service} shown={1} onOpenPort={props.onOpenPort} />
                                            <span className="text-right font-mono text-[10.5px]" style={{ color: tokens.textTertiary }}>
                                                {service.rss_bytes === null ? '' : memoryText(service.rss_bytes)}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}
        </>
    );
}
