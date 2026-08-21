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
import { useRef, useState, type ReactElement } from 'react';

import type { ConnectionStatus } from '../connection';
import { ContextMenu, type MenuItemSpec } from './ContextMenu';
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
    /** §WS-137/§WS-152: the trailing workspace inspector's toggle. */
    readonly onToggleInspector?: (() => void) | undefined;
    readonly inspectorVisible?: boolean | undefined;
    /**
     * APP-052/APP-053 — the ••• menu's rows, built by the app (`WindowTitleBar.swift:243-251`).
     *
     * Supplied as data rather than as callbacks so the same menu can carry items that only
     * exist inside the Electron shell (Install CLI, Check for Updates) without this component
     * knowing what a shell is. Absent or empty = no ••• button at all.
     */
    readonly overflowItems?: readonly MenuItemSpec[] | undefined;
    /**
     * §APP-046 — leading room to keep clear for the window's traffic lights, in CSS pixels.
     *
     * The shell creates its window with a HIDDEN title bar, so this strip is drawn underneath the
     * three macOS window buttons and has to get out of their way; `?trafficLightInset=` carries
     * the number the shell positioned them with. 0 (the default) is the browser tab and the
     * Linux window, where there are no buttons to clear — and where reserving space for them
     * would be a macOS feature leaking somewhere it does not apply.
     */
    readonly trafficLightInset?: number | undefined;
    /**
     * Make the strip the window's drag region (§APP-046: "empty bar area drags the window").
     *
     * Only true inside a shell window: `-webkit-app-region` is inert in a browser, but the
     * attribute is what the audit reads to tell "the drawn strip IS the title bar" from "there is
     * a native one above it", so it is not set where it would be a lie.
     */
    readonly dragRegion?: boolean | undefined;
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
    const [overflowAt, setOverflowAt] = useState<{ x: number; y: number } | null>(null);
    const overflowRef = useRef<HTMLButtonElement | null>(null);
    const hasWorkspace = props.workspaceName !== null;
    const paneCount = props.panes.length;
    const syncable = (props.syncedPaneCount ?? 0) >= 2;
    const overflowItems = props.overflowItems ?? [];

    const trafficLightInset = Math.max(0, props.trafficLightInset ?? 0);

    return (
        <div
            data-testid="top-bar"
            /* §APP-046: the audit reads both of these off the DOM — the gutter it must find the
               first control beyond, and whether this strip claims the drag region. */
            data-traffic-light-inset={String(trafficLightInset)}
            data-titlebar-drag={props.dragRegion === true ? 'true' : undefined}
            className="relative flex h-8 shrink-0 items-center border-b pr-3"
            style={{
                background: tokens.footerBackground,
                borderColor: tokens.divider,
                color: tokens.textPrimary,
                /* The 12px the bar has always had, unless the traffic lights need more. The
                   height is untouched: the strip is drawn INTO the title-bar row, not below a
                   second one, which is the half of §APP-046 a taller bar would give away. */
                paddingLeft: Math.max(12, trafficLightInset)
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
                {props.onToggleInspector === undefined ? null : (
                    <button
                        type="button"
                        data-testid="toggle-inspector"
                        aria-label="Toggle inspector"
                        aria-pressed={props.inspectorVisible ?? false}
                        title="Toggle inspector (⌘I)"
                        style={{
                            color:
                                props.inspectorVisible === true ? tokens.textPrimary : tokens.textSecondary
                        }}
                        onClick={props.onToggleInspector}
                    >
                        <ChromeIcon name="stack" size={13} />
                    </button>
                )}
                {overflowItems.length === 0 ? null : (
                    <button
                        ref={overflowRef}
                        type="button"
                        data-testid="titlebar-menu-toggle"
                        aria-label="More actions"
                        aria-haspopup="menu"
                        aria-expanded={overflowAt !== null}
                        title="More actions"
                        style={{ color: tokens.textSecondary }}
                        onClick={() => {
                            if (overflowAt !== null) {
                                setOverflowAt(null);
                                return;
                            }
                            // Anchored under the button, the way a native menu drops: the menu
                            // is a portal (`ContextMenu`), so it needs viewport coordinates
                            // rather than a position inside this bar.
                            const box = overflowRef.current?.getBoundingClientRect();
                            setOverflowAt(
                                box === undefined
                                    ? { x: 8, y: 32 }
                                    : { x: Math.round(box.left), y: Math.round(box.bottom + 4) }
                            );
                        }}
                    >
                        <ChromeIcon name="ellipsis" size={13} />
                    </button>
                )}
            </div>
            {overflowAt === null ? null : (
                <ContextMenu
                    x={overflowAt.x}
                    y={overflowAt.y}
                    items={overflowItems}
                    label="Window menu"
                    onClose={() => {
                        setOverflowAt(null);
                    }}
                />
            )}

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
