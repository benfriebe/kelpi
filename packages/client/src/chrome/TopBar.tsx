/**
 * The title bar (shell-ui.md §3), adapted to the web client.
 *
 * The macOS bar is a 32pt strip with a perfectly centered, non-interactive identity cluster
 * (`● WorkspaceName · 3 panes`) and trailing controls. The dot rule is exact: any pane
 * `waitingForInput` → `statusWaiting`, else any `running` → `statusRunning`, else the
 * workspace's own color; no active workspace → `textTertiary` and the name falls back to
 * "Nex" with no pane count.
 *
 * Three controls that have no macOS equivalent live here because a browser client needs them
 * in the chrome rather than a menu: the layout cycle/select control (`layout-cycle` /
 * `layout-select`), the sync-input indicator (`pane-sync`), and the connection pill — the one
 * piece of UI that tells a remote user the daemon link is down.
 */

import { PREDEFINED_LAYOUT_DISPLAY_NAMES, PREDEFINED_LAYOUT_ORDER } from '@nex/core/layout';
import type { PredefinedLayoutKind, WorkspaceColor } from '@nex/daemon/store';
import { useState, type ReactElement } from 'react';

import type { ConnectionStatus } from '../connection';
import { ChromeIcon } from './icons';
import { withAlpha, workspaceColorHex, type ChromeBucket } from './theme';
import { tokens } from './tokens';
import type { ChromePane } from './types';

export interface TopBarProps {
    readonly workspaceName: string | null;
    readonly workspaceColor?: WorkspaceColor | undefined;
    readonly panes: readonly ChromePane[];
    readonly bucket?: ChromeBucket | undefined;
    readonly connection: ConnectionStatus;
    readonly connectionError?: string | null | undefined;
    /** The workspace's current predefined layout, or null when hand-modified (§11.1). */
    readonly currentLayout?: PredefinedLayoutKind | null | undefined;
    readonly onCycleLayout?: (() => void) | undefined;
    readonly onSelectLayout?: ((layout: PredefinedLayoutKind) => void) | undefined;
    readonly syncInputActive?: boolean | undefined;
    /** Size of the broadcast group (`syncedPaneIDs`); < 2 means nothing would mirror. */
    readonly syncedPaneCount?: number | undefined;
    readonly onToggleSyncInput?: (() => void) | undefined;
    readonly onToggleSidebar?: (() => void) | undefined;
    readonly sidebarVisible?: boolean | undefined;
}

const CONNECTION_LABEL: Readonly<Record<ConnectionStatus, string>> = {
    idle: 'offline',
    connecting: 'connecting',
    connected: 'connected',
    reconnecting: 'reconnecting',
    closed: 'disconnected',
    /** The daemon refused the handshake — retrying cannot fix it (token / protocol version). */
    rejected: 'refused'
};

function connectionColor(status: ConnectionStatus): string {
    if (status === 'connected') return tokens.statusRunning;
    if (status === 'connecting' || status === 'reconnecting') return tokens.activeAgent;
    if (status === 'rejected') return '#E0655C';
    return tokens.statusInactive;
}

/** §3: waiting beats running beats the workspace color; no workspace → tertiary. */
export function identityDotColor(
    panes: readonly ChromePane[],
    color: WorkspaceColor | undefined,
    bucket: ChromeBucket
): string {
    if (color === undefined) return tokens.textTertiary;
    if (panes.some((pane) => pane.status === 'waitingForInput')) return tokens.statusWaiting;
    if (panes.some((pane) => pane.status === 'running')) return tokens.statusRunning;
    return workspaceColorHex(color, bucket);
}

export function TopBar(props: TopBarProps): ReactElement {
    const bucket = props.bucket ?? 'dark';
    const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
    const hasWorkspace = props.workspaceName !== null;
    const paneCount = props.panes.length;
    const syncable = (props.syncedPaneCount ?? 0) >= 2;

    return (
        <div
            data-testid="top-bar"
            className="relative flex h-8 shrink-0 items-center border-b px-3"
            style={{
                background: tokens.footerBackground,
                borderColor: tokens.divider,
                color: tokens.textPrimary
            }}
        >
            <div className="flex items-center gap-2">
                {props.onToggleSidebar === undefined ? null : (
                    <button
                        type="button"
                        aria-label="Toggle sidebar"
                        aria-pressed={props.sidebarVisible ?? true}
                        title="Toggle sidebar"
                        style={{ color: tokens.textSecondary }}
                        onClick={props.onToggleSidebar}
                    >
                        <ChromeIcon name="sidebar" size={13} />
                    </button>
                )}
            </div>

            <div
                data-testid="top-bar-identity"
                className="pointer-events-none absolute left-1/2 flex -translate-x-1/2 items-center gap-1.5 text-[12px]"
            >
                <span
                    data-testid="identity-dot"
                    aria-hidden
                    className="h-[7px] w-[7px] rounded-full"
                    style={{ background: identityDotColor(props.panes, props.workspaceColor, bucket) }}
                />
                <span className="max-w-[280px] truncate font-semibold">{props.workspaceName ?? 'Nex'}</span>
                {hasWorkspace ? (
                    <span style={{ color: tokens.textTertiary }}>
                        · {paneCount} {paneCount === 1 ? 'pane' : 'panes'}
                    </span>
                ) : null}
            </div>

            <div className="ml-auto flex items-center gap-2 text-[11px]">
                <div className="relative flex items-center">
                    <button
                        type="button"
                        data-testid="layout-cycle"
                        aria-label="Cycle layout"
                        title="Cycle layout (⇧⌘Space)"
                        className="flex items-center gap-1 rounded px-1.5 py-0.5"
                        style={{ color: tokens.textSecondary, background: withAlpha('#E6E6EA', 0.05) }}
                        onClick={props.onCycleLayout}
                    >
                        <ChromeIcon name="layout" size={11} />
                        <span>
                            {props.currentLayout === null || props.currentLayout === undefined
                                ? 'custom'
                                : PREDEFINED_LAYOUT_DISPLAY_NAMES[props.currentLayout]}
                        </span>
                    </button>
                    <button
                        type="button"
                        data-testid="layout-menu-toggle"
                        aria-label="Select layout"
                        aria-expanded={layoutMenuOpen}
                        className="px-1"
                        style={{ color: tokens.textTertiary }}
                        onClick={() => {
                            setLayoutMenuOpen(!layoutMenuOpen);
                        }}
                    >
                        <ChromeIcon name="chevron-down" size={10} />
                    </button>
                    {layoutMenuOpen ? (
                        <div
                            data-testid="layout-menu"
                            role="menu"
                            className="absolute right-0 top-7 z-40 min-w-[160px] rounded-lg p-1"
                            style={{
                                background: tokens.surfaceBackground,
                                border: `1px solid ${tokens.divider}`,
                                boxShadow: '0 12px 32px rgba(0,0,0,0.38)'
                            }}
                        >
                            {PREDEFINED_LAYOUT_ORDER.map((layout) => (
                                <button
                                    key={layout}
                                    type="button"
                                    role="menuitem"
                                    className="block w-full rounded px-2 py-1 text-left text-[12px]"
                                    style={{
                                        color:
                                            layout === props.currentLayout
                                                ? tokens.textPrimary
                                                : tokens.textSecondary
                                    }}
                                    onClick={() => {
                                        setLayoutMenuOpen(false);
                                        props.onSelectLayout?.(layout);
                                    }}
                                >
                                    {PREDEFINED_LAYOUT_DISPLAY_NAMES[layout]}
                                </button>
                            ))}
                        </div>
                    ) : null}
                </div>

                <button
                    type="button"
                    data-testid="sync-toggle"
                    aria-label="Toggle synchronise input"
                    aria-pressed={props.syncInputActive === true}
                    title={
                        syncable
                            ? 'Synchronise input across this workspace'
                            : 'Needs two or more shell panes to mirror input'
                    }
                    className="flex items-center gap-1 rounded px-1.5 py-0.5"
                    style={{
                        color: props.syncInputActive === true ? tokens.accent : tokens.textTertiary,
                        background:
                            props.syncInputActive === true ? withAlpha('#6F9BD8', 0.16) : 'transparent'
                    }}
                    onClick={props.onToggleSyncInput}
                >
                    <ChromeIcon name="broadcast" size={11} />
                    <span>
                        {props.syncInputActive === true ? `sync ${props.syncedPaneCount ?? 0}` : 'sync'}
                    </span>
                </button>

                <span
                    data-testid="connection-pill"
                    data-status={props.connection}
                    title={props.connectionError ?? undefined}
                    className="flex items-center gap-1 rounded-full px-2 py-0.5"
                    style={{ background: withAlpha('#E6E6EA', 0.06), color: tokens.textSecondary }}
                >
                    <span
                        aria-hidden
                        className="h-[6px] w-[6px] rounded-full"
                        style={{ background: connectionColor(props.connection) }}
                    />
                    {CONNECTION_LABEL[props.connection]}
                </span>
            </div>
        </div>
    );
}
