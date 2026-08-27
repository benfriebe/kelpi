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
import { useCallback, useLayoutEffect, useRef, useState, type ReactElement, type RefObject } from 'react';

import type { ConnectionStatus } from '../connection';
import { ContextMenu, type MenuItemSpec } from './ContextMenu';
import { useDismissable } from './dismissable';
import { hoverFill, hoverText, useHoverKey } from './hover';
import { ChromeIcon } from './icons';
import { useOverlayPresence } from './modal-presence';
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

/**
 * SPACING-REVIEW S22 — the inset each leading glyph button takes around its 13 px icon.
 *
 * The glyph does not move: the padding grows the BOX (13 → 19 px), which is what a pointer
 * has to hit. AppKit gives the shipped pair the same courtesy through the borderless menu /
 * plain button cell that wraps their 13 pt images (`WindowTitleBar.swift:243-268`).
 */
const GLYPH_BUTTON_PAD_PX = 3;

/**
 * SPACING-REVIEW S4 — the gutter the identity keeps between itself and each side cluster.
 *
 * The Swift's own number is `.padding(.trailing, 86)` over a ~52 pt cluster, i.e. the cluster
 * plus room to breathe; 12 is this bar's own `pr-3`, so the identity stops exactly where the
 * bar's trailing padding starts.
 */
const IDENTITY_GUTTER_PX = 12;

/** The reserve used before the first measurement (and wherever `ResizeObserver` is absent). */
const IDENTITY_FALLBACK_RESERVE_PX = 256;

/**
 * SPACING-REVIEW S4 — how much room the identity must leave on EACH side.
 *
 * `WindowTitleBar.swift:89-90` pads the identity cluster 80 leading / 86 trailing and then
 * centres it, so those insets are not an offset — they are a *minimum clearance* that makes a
 * long name truncate instead of running under the traffic lights or the trailing controls. A
 * centred box is bound by the LARGER of the two clearances, which is why this is one number
 * rather than two: reserving 80 on the left and 256 on the right would centre the name 88 px
 * left of the window centre, which no version of this bar has ever done.
 *
 * The port's clusters are not the Swift's (this bar carries the sidebar / inspector / ••• trio
 * on the LEADING side, where the shipped app hangs them off a trailing accessory), and both
 * sides change width with the traffic-light inset, the layout name and the sync label — so the
 * number is measured rather than declared.
 */
export function identityReserve(
    bar: { readonly left: number; readonly right: number },
    leading: { readonly right: number } | null,
    trailing: { readonly left: number } | null,
    gutter = IDENTITY_GUTTER_PX
): number {
    const leadingSide = leading === null ? 0 : leading.right - bar.left;
    const trailingSide = trailing === null ? 0 : bar.right - trailing.left;
    return Math.ceil(Math.max(leadingSide, trailingSide, 0)) + gutter;
}

/** `identityReserve` over the live boxes, kept fresh while the window (or a label) changes. */
function useIdentityReserve(
    barRef: RefObject<HTMLDivElement | null>,
    leadingRef: RefObject<HTMLDivElement | null>,
    trailingRef: RefObject<HTMLDivElement | null>,
    key: string
): number | null {
    const [reserve, setReserve] = useState<number | null>(null);
    useLayoutEffect(() => {
        const bar = barRef.current;
        if (bar === null || typeof ResizeObserver === 'undefined') return undefined;
        const measure = (): void => {
            const box = bar.getBoundingClientRect();
            if (box.width <= 0) return;
            const next = identityReserve(
                box,
                leadingRef.current?.getBoundingClientRect() ?? null,
                trailingRef.current?.getBoundingClientRect() ?? null
            );
            setReserve((current) => (current === next ? current : next));
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(bar);
        if (trailingRef.current !== null) observer.observe(trailingRef.current);
        if (leadingRef.current !== null) observer.observe(leadingRef.current);
        return () => {
            observer.disconnect();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, barRef, leadingRef, trailingRef]);
    return reserve;
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
    /** §H15: the dropdown panel and the chevron that opens it — the two boxes a click may land in. */
    const layoutMenuRef = useRef<HTMLDivElement | null>(null);
    const layoutToggleRef = useRef<HTMLButtonElement | null>(null);
    /** S4: the three boxes the identity's truncation gutter is measured from. */
    const barRef = useRef<HTMLDivElement | null>(null);
    const leadingRef = useRef<HTMLDivElement | null>(null);
    const trailingRef = useRef<HTMLDivElement | null>(null);
    /** §H11: one hover slot for the whole bar (see `hover.ts`). */
    const [hovered, hover] = useHoverKey();
    const closeLayoutMenu = useCallback(() => {
        setLayoutMenuOpen(false);
    }, []);
    /*
     * §H15 — an `NSMenu` closes on any outside click and on Escape; this dropdown was dismissed
     * only by re-clicking its own chevron, so it stayed open over the pane grid while the user
     * typed. Same hook the pane context menu uses.
     */
    useDismissable(layoutMenuOpen, closeLayoutMenu, [layoutMenuRef, layoutToggleRef]);
    /*
     * §N26 — and it drops STRAIGHT onto the grid. Right-aligned under the title bar, this panel
     * lands over whatever pane is top-right, so over a web pane it was painted under the page
     * (`docs/audit/n26-popup-layering`, step `03-layout-menu`). Same registry as the context
     * menu it sits beside, at the same precision: only the panes its box reaches park.
     */
    useOverlayPresence(layoutMenuRef, layoutMenuOpen);
    const hasWorkspace = props.workspaceName !== null;
    const paneCount = props.panes.length;
    const syncable = (props.syncedPaneCount ?? 0) >= 2;
    const overflowItems = props.overflowItems ?? [];

    const trafficLightInset = Math.max(0, props.trafficLightInset ?? 0);
    /*
     * S4 — remeasure whenever anything that changes a cluster's width changes: the traffic-light
     * inset, the ••• button appearing, the layout name, and the sync chip's `sync N` label.
     */
    const identityReservePx = useIdentityReserve(
        barRef,
        leadingRef,
        trailingRef,
        [
            String(trafficLightInset),
            String((props.overflowItems ?? []).length),
            String(props.currentLayout ?? 'custom'),
            String(props.syncInputActive === true ? (props.syncedPaneCount ?? 0) : -1),
            props.connection
        ].join('|')
    );

    return (
        <div
            ref={barRef}
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
            {/*
             * S22 — `TitlebarTrailingControls` is `HStack(spacing: 14)` (`WindowTitleBar.swift:
             * 243`), so the shipped glyphs sit FOURTEEN points apart; three of them 8 px apart
             * read as one blob. The per-button inset is `GLYPH_BUTTON_PAD_PX` — the glyph does
             * not move, the target grows 13 → 19 px.
             */}
            <div ref={leadingRef} className="flex items-center gap-3.5">
                {props.onToggleSidebar === undefined ? null : (
                    <button
                        type="button"
                        aria-label="Toggle sidebar"
                        aria-pressed={props.sidebarVisible ?? true}
                        title="Toggle sidebar"
                        data-hovered={hovered === 'sidebar' ? 'true' : 'false'}
                        style={{ padding: GLYPH_BUTTON_PAD_PX, color: hoverText(hovered === 'sidebar', tokens.textSecondary) }}
                        {...hover('sidebar')}
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
                        data-hovered={hovered === 'inspector' ? 'true' : 'false'}
                        style={{
                            padding: GLYPH_BUTTON_PAD_PX,
                            color: hoverText(
                                hovered === 'inspector',
                                props.inspectorVisible === true ? tokens.textPrimary : tokens.textSecondary
                            )
                        }}
                        {...hover('inspector')}
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
                        data-hovered={hovered === 'overflow' ? 'true' : 'false'}
                        style={{ padding: GLYPH_BUTTON_PAD_PX, color: hoverText(hovered === 'overflow', tokens.textSecondary) }}
                        {...hover('overflow')}
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
                data-identity-reserve={identityReservePx === null ? undefined : String(identityReservePx)}
                /* UI-FIDELITY L55: `identityCluster` is `HStack(spacing: 7)` — 7 pt between every
                   member, the `·` included, because the separator is its own `Text`. */
                className="pointer-events-none absolute left-1/2 flex -translate-x-1/2 items-center gap-[7px] text-[12px]"
                /*
                 * S4 — the truncation gutter. `.padding(.leading, 80).padding(.trailing, 86)` on a
                 * CENTRED cluster is a minimum clearance, not an offset ("so a long name truncates
                 * instead of overlapping the menu / sidebar buttons on a narrow window"), and a
                 * centred box is bound by the larger of the two — hence one reserve on both sides.
                 * Without it the port reserved nothing at all: at the shell's own 600 px minimum
                 * (`shell/src/window-state.ts:32`) the 280 px-capped name ran straight under the
                 * trailing cluster.
                 */
                style={{ maxWidth: `calc(100% - ${String(2 * (identityReservePx ?? IDENTITY_FALLBACK_RESERVE_PX))}px)` }}
            >
                <span
                    data-testid="identity-dot"
                    aria-hidden
                    className="h-[7px] w-[7px] shrink-0 rounded-full"
                    style={{ background: identityDotColor(props.panes, props.workspaceColor, bucket) }}
                />
                {/* `min-w-0` is what makes `.truncationMode(.tail)` real: a flex item's automatic
                    minimum is its min-content width, so a nowrap name would otherwise refuse to
                    shrink and simply overflow the reserve above. */}
                <span className="min-w-0 max-w-[280px] truncate font-semibold">{props.workspaceName ?? 'Nex'}</span>
                {hasWorkspace ? (
                    <>
                        {/* L55: the separator is a member of the stack, so it gets the full 7 px
                            on BOTH sides. As one span the port had 6 px before it and a literal
                            space (~3-4 px) after, which pulled the count in toward the dot. */}
                        <span aria-hidden className="shrink-0" style={{ color: tokens.textTertiary }}>
                            ·
                        </span>
                        <span className="shrink-0" style={{ color: tokens.textTertiary }}>
                            {paneCount} {paneCount === 1 ? 'pane' : 'panes'}
                        </span>
                    </>
                ) : null}
            </div>

            <div ref={trailingRef} className="ml-auto flex items-center gap-2 text-[11px]">
                <div className="relative flex items-center">
                    <button
                        type="button"
                        data-testid="layout-cycle"
                        aria-label="Cycle layout"
                        title="Cycle layout (⇧⌘Space)"
                        className="flex items-center gap-1 rounded px-1.5 py-0.5"
                        data-hovered={hovered === 'layout-cycle' ? 'true' : 'false'}
                        style={{
                            color: hoverText(hovered === 'layout-cycle', tokens.textSecondary),
                            background: hoverFill(hovered === 'layout-cycle', withAlpha('#E6E6EA', 0.05))
                        }}
                        {...hover('layout-cycle')}
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
                        ref={layoutToggleRef}
                        type="button"
                        data-testid="layout-menu-toggle"
                        aria-label="Select layout"
                        aria-expanded={layoutMenuOpen}
                        /* S58: `px-1` alone left a 10 px-tall caret beside two 19.4 px chips —
                           the vertical is what makes it a target rather than a glyph. */
                        className="px-1 py-[3px]"
                        data-hovered={hovered === 'layout-menu' ? 'true' : 'false'}
                        style={{ color: hoverText(hovered === 'layout-menu', tokens.textTertiary) }}
                        {...hover('layout-menu')}
                        onClick={() => {
                            setLayoutMenuOpen(!layoutMenuOpen);
                        }}
                    >
                        <ChromeIcon name="chevron-down" size={10} />
                    </button>
                    {layoutMenuOpen ? (
                        <div
                            ref={layoutMenuRef}
                            data-testid="layout-menu"
                            role="menu"
                            /* S54/S55: `MENU_ITEM_GAP` between rows so two adjacent hover
                               rectangles cannot touch — the same `flex flex-col gap-0.5` the
                               shared `ContextMenu` panel and the preview's copy menu carry, so
                               the three menus in this client stay one family. */
                            className="absolute right-0 top-7 z-40 flex min-w-[160px] flex-col gap-0.5 rounded-lg p-1"
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
                                    /* S55: `px-2.5` is `MenuRow`'s own leading inset, so the
                                       label clears the panel wall by 4 (the `p-1`) + 10 rather
                                       than sitting on it. */
                                    className="block w-full rounded px-2.5 py-1 text-left text-[12px]"
                                    data-hovered={hovered === `layout:${layout}` ? 'true' : 'false'}
                                    style={{
                                        color: hoverText(
                                            hovered === `layout:${layout}`,
                                            layout === props.currentLayout
                                                ? tokens.textPrimary
                                                : tokens.textSecondary
                                        ),
                                        background: hoverFill(hovered === `layout:${layout}`)
                                    }}
                                    {...hover(`layout:${layout}`)}
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
                    data-hovered={hovered === 'sync' ? 'true' : 'false'}
                    style={{
                        // Active keeps its accent tint under the pointer — the wash would only
                        // muddy it — so hover moves the LABEL here and the box only when inert.
                        color:
                            props.syncInputActive === true
                                ? tokens.accent
                                : hoverText(hovered === 'sync', tokens.textTertiary),
                        background:
                            props.syncInputActive === true
                                ? withAlpha('#6F9BD8', 0.16)
                                : hoverFill(hovered === 'sync')
                    }}
                    {...hover('sync')}
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
