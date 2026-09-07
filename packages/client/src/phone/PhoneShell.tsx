/**
 * The phone shell (B1/B2/B3/B4/B6 of docs/MOBILE-PLAN.md, plus the owner's two requests of
 * 2026-09-08: a switch between one pane and the full layout, and more than one host).
 *
 * **Every phone rule in this program is an owner-directed divergence from the shipped Swift app**
 * (there is no Swift phone UI; `chrome/form-factor.ts` says so once for all of it).
 *
 * Assembly (`App.tsx`) renders this INSTEAD of the desktop's title bar, sidebar, grid, inspector
 * and footer when the form factor is `phone`, and it renders it inside the same root with the
 * same store, the same `act` verbs, the same `renderPane` and the same overlays. Nothing here
 * reaches into App's internals: everything arrives as props, collected into one object at the
 * one place App builds it. The desktop branch is untouched and byte-identical.
 *
 * What is on screen:
 *
 *   header   workspaces button · "host · workspace ▸ pane" title · agent dot · view toggle ·
 *            panes button · overflow
 *   content  `pane` mode: the focused pane filling the box (`phone/view.ts` says why "focused"),
 *            `layout` mode: the workspace's `PaneGrid`, at phone size
 *   sheets   the workspace drawer (hosts and their workspaces), the pane sheet, the overflow
 *            menu, the add-host form, the rename prompt
 *
 * Hosts: the origin (this page's daemon), the origin's configured `remote-daemon` peers (already
 * dialled by assembly, §1.7), and the phone's own list (`phone/hosts.ts`), each with its own
 * runtime. A remote host's workspace renders through `PhoneRemoteWorkspace`; the origin's through
 * assembly's `renderPane`, so a content pane, a web-pane card and an external-editor terminal on
 * the origin all draw exactly as they do on the Mac.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode, type TouchEvent } from 'react';
import { useStore } from 'zustand';

import { layoutPaneOrder, type WorkspaceState } from '@kelpi/daemon/store';

import type { DaemonTarget, StorageLike } from '../app/config';
import { ConnectionSplash } from '../app/ConnectionScreen';
import { useRemoteDaemons, type RemoteDaemonRuntime, type RemoteRuntimeFactory } from '../app/remote-daemons';
import { ChromeIcon } from '../chrome/icons';
import { agentCounts } from '../chrome/Sidebar';
import type { ChromeBucket } from '../chrome/theme';
import { tokens } from '../chrome/tokens';
import type { ChromeWorkspace } from '../chrome/types';
import { PaneGrid, paneDisplayTitle, type PaneGridProps, type RenderPane } from '../grid';
import type { KelpiRuntime, KelpiState } from '../state';
import { PhoneKeyBar, type TerminalRendererFactory } from '../terminal';
import { usePhoneHosts } from './hosts';
import { originHostName } from './hosts';
import { ORIGIN_HOST_KEY, type PhoneHostModel, type PhoneWorkspaceSelection } from './model';
import { PhoneHostSheet } from './PhoneHostSheet';
import { PhoneMenuSheet, type PhoneMenuItem } from './PhoneMenuSheet';
import { PhonePaneSheet } from './PhonePaneSheet';
import { PhonePromptSheet } from './PhonePromptSheet';
import { PhoneRemoteWorkspace, remoteShownPane } from './PhoneRemoteWorkspace';
import { PhoneWorkspaceDrawer } from './PhoneWorkspaceDrawer';
import { PHONE_ROW_MIN_PX, PHONE_SAFE_AREA, PhoneButton, statusDotColor } from './ui';
import type { PhoneView } from './view';

/** The origin's verbs the shell needs, bound by assembly to its `act`. */
export interface PhoneShellActions {
    activateWorkspace(workspaceID: string): void;
    /** Create a workspace named by the phone's prompt (the desktop's form is a sidebar's). */
    createWorkspace(name: string): void;
    focusPane(paneID: string): void;
    closePane(paneID: string): void;
    renamePane(paneID: string, name: string): void;
    createPane(): void;
    toggleSyncInput(): void;
    openPalette(): void;
    openSettings(): void;
}

/** The desktop grid's props that are NOT the workspace itself: assembly's bindings pass through. */
export type PhoneGridProps = Omit<
    PaneGridProps,
    'layout' | 'panes' | 'focusedPaneID' | 'zoomedPaneID' | 'syncActive' | 'syncExcludedPaneIDs' | 'homeDirectory' | 'renderPane' | 'focusFollowsMouse' | 'focusFollowsMouseDelayMs'
>;

export interface PhoneShellProps {
    readonly runtime: KelpiRuntime;
    /** The whole client state, for the connection splash; `ready` is its `daemon.hasSnapshot`. */
    readonly state: KelpiState;
    readonly ready: boolean;
    readonly target: DaemonTarget;
    readonly workspace: WorkspaceState | null;
    /** Assembly's echo-aware focused pane (`selectFocusedPaneID`). */
    readonly focusedPaneID: string | null;
    readonly view: PhoneView;
    readonly bucket: ChromeBucket;
    readonly homeDirectory: string;
    /** The origin's configured `remote-daemon` runtimes, alive in assembly. */
    readonly configuredDaemons: readonly RemoteDaemonRuntime[];
    readonly renderPane: RenderPane;
    readonly grid: PhoneGridProps;
    readonly actions: PhoneShellActions;
    /** The command palette element, rendered by assembly with its own props. */
    readonly palette: ReactNode;
    readonly createRenderer?: TerminalRendererFactory | undefined;
    /** Test seams: where the host list is remembered, how a host runtime is built, the page's host. */
    readonly hostStorage?: StorageLike | null | undefined;
    readonly remoteRuntimeFactory?: RemoteRuntimeFactory | undefined;
    readonly location?: { readonly hostname: string } | null | undefined;
}

type Sheet = 'none' | 'workspaces' | 'panes' | 'menu' | 'host' | 'rename' | 'new-workspace';

/** How far in from the left edge a touch may start and still be the drawer's swipe. */
export const PHONE_EDGE_SWIPE_START_PX = 24;
/** How far right it must travel (and how little vertically) before the drawer opens. */
export const PHONE_EDGE_SWIPE_DISTANCE_PX = 48;
const PHONE_EDGE_SWIPE_DRIFT_PX = 40;

const ZERO_RECT = { x: 0, y: 0, width: 0, height: 0 } as const;
const EMPTY_IDS: readonly string[] = [];

function defaultLocation(): { readonly hostname: string } | null {
    const loc = (globalThis as { location?: { hostname: string } }).location;
    return loc ?? null;
}

export function PhoneShell(props: PhoneShellProps): ReactElement {
    const { view, actions } = props;
    const [sheet, setSheet] = useState<Sheet>('none');
    const closeSheet = useCallback(() => setSheet('none'), []);
    /**
     * C9 - the content box, for the phone's ONE key bar (`terminal/PhoneKeyBar.tsx`). The bar
     * sits out of flow at this box's bottom edge and pads the box by its own height plus the
     * software keyboard's inset, so whatever is on screen - one pane or the whole grid, the
     * origin's or a remote host's - shrinks above it. The desktop mounts the same component on
     * its content row; on a phone that row is not on screen, so it is mounted here instead.
     */
    const contentRef = useRef<HTMLDivElement | null>(null);

    // ── hosts ───────────────────────────────────────────────────────────────────────

    const phoneHosts = usePhoneHosts(props.hostStorage);
    const phoneEntries = useMemo(
        () => phoneHosts.hosts.map((entry) => ({ name: entry.id, url: entry.url })),
        [phoneHosts.hosts]
    );
    const phoneRuntimes = useRemoteDaemons(phoneEntries, props.remoteRuntimeFactory);

    const hosts = useMemo<readonly PhoneHostModel[]>(() => {
        const origin: PhoneHostModel = {
            key: ORIGIN_HOST_KEY,
            name: originHostName(props.location === undefined ? defaultLocation() : props.location),
            kind: 'origin',
            runtime: props.runtime,
            removable: false
        };
        const configured = props.configuredDaemons.map<PhoneHostModel>((held) => ({
            key: `configured:${held.name}`,
            name: held.name,
            kind: 'configured',
            runtime: held.runtime,
            removable: false
        }));
        const own: PhoneHostModel[] = [];
        for (const entry of phoneHosts.hosts) {
            const held = phoneRuntimes.get(entry.id);
            if (held === undefined) continue;
            own.push({ key: `phone:${entry.id}`, name: entry.name, kind: 'phone', runtime: held.runtime, removable: true });
        }
        return [origin, ...configured, ...own];
    }, [props.location, props.runtime, props.configuredDaemons, phoneHosts.hosts, phoneRuntimes]);

    const remoteHost = view.remote === null ? null : (hosts.find((host) => host.key === view.remote?.host) ?? null);

    // A host that is gone (removed from the phone, dropped from the origin's config) takes its
    // selection with it: the shell falls back to the origin's active workspace.
    useEffect(() => {
        if (view.remote !== null && remoteHost === null) view.selectRemote(null);
    }, [view, remoteHost]);

    // ── the workspace on screen ─────────────────────────────────────────────────────

    const activeStore = (remoteHost ?? hosts[0] ?? { runtime: props.runtime }).runtime.store;
    const remoteWorkspaceID = view.remote?.workspaceID ?? null;
    const remoteWorkspace = useStore(activeStore, (state) =>
        remoteHost === null || remoteWorkspaceID === null
            ? null
            : (state.daemon.state.workspaces.find((entry) => entry.id === remoteWorkspaceID) ?? null)
    );
    const remoteEcho = useStore(activeStore, (state) => state.ui.focusEcho);

    const workspace = remoteHost === null ? props.workspace : remoteWorkspace;
    const shownPaneID =
        remoteHost === null
            ? view.shownPaneID
            : remoteWorkspace === null
              ? null
              : remoteShownPane(remoteWorkspace, remoteEcho);
    const panes = workspace?.panes ?? [];
    const shownPane = shownPaneID === null ? null : (panes.find((pane) => pane.id === shownPaneID) ?? null);
    const counts = useMemo(() => agentCounts(workspace === null ? [] : [workspace as unknown as ChromeWorkspace]), [workspace]);
    const agentDot = counts.waiting > 0 ? tokens.statusWaiting : counts.running > 0 ? tokens.statusRunning : null;

    const selection: PhoneWorkspaceSelection | null =
        remoteHost !== null && remoteWorkspaceID !== null
            ? { host: remoteHost.key, workspaceID: remoteWorkspaceID }
            : props.workspace === null
              ? null
              : { host: ORIGIN_HOST_KEY, workspaceID: props.workspace.id };

    /** The verbs for whichever host is on screen: assembly's for the origin, the runtime's for a remote. */
    const verbs = useMemo(() => {
        if (remoteHost === null) {
            return {
                focusPane: actions.focusPane,
                createPane: actions.createPane,
                closePane: actions.closePane,
                renamePane: actions.renamePane
            };
        }
        const runtime = remoteHost.runtime;
        const workspaceID = remoteWorkspaceID;
        return {
            focusPane: (paneID: string): void => {
                if (workspaceID !== null) runtime.focusPane(workspaceID, paneID);
            },
            createPane: (): void => {
                if (workspaceID !== null) void runtime.commands.createPane({ workspace: workspaceID });
            },
            closePane: (paneID: string): void => {
                void runtime.commands.closePane({ paneID });
            },
            renamePane: (paneID: string, name: string): void => {
                void runtime.commands.renamePane({ paneID, name });
            }
        };
    }, [remoteHost, remoteWorkspaceID, actions]);

    const onSelectWorkspace = useCallback(
        (next: PhoneWorkspaceSelection): void => {
            if (next.host === ORIGIN_HOST_KEY) {
                view.selectRemote(null);
                actions.activateWorkspace(next.workspaceID);
                return;
            }
            view.selectRemote({ host: next.host, workspaceID: next.workspaceID });
        },
        [view, actions]
    );

    // ── the drawer's edge swipe ─────────────────────────────────────────────────────

    const swipe = useRef<{ x: number; y: number } | null>(null);
    const onTouchStart = (event: TouchEvent<HTMLDivElement>): void => {
        const touch = event.touches[0];
        if (touch === undefined || event.touches.length !== 1) {
            swipe.current = null;
            return;
        }
        swipe.current = touch.clientX <= PHONE_EDGE_SWIPE_START_PX ? { x: touch.clientX, y: touch.clientY } : null;
    };
    const onTouchMove = (event: TouchEvent<HTMLDivElement>): void => {
        const start = swipe.current;
        const touch = event.touches[0];
        if (start === null || touch === undefined) return;
        const dx = touch.clientX - start.x;
        const dy = Math.abs(touch.clientY - start.y);
        if (dy > PHONE_EDGE_SWIPE_DRIFT_PX) {
            swipe.current = null;
            return;
        }
        if (dx >= PHONE_EDGE_SWIPE_DISTANCE_PX) {
            swipe.current = null;
            setSheet('workspaces');
        }
    };
    const onTouchEnd = (): void => {
        swipe.current = null;
    };

    // ── the overflow menu ───────────────────────────────────────────────────────────

    const menuItems = useMemo<readonly PhoneMenuItem[]>(() => {
        const items: PhoneMenuItem[] = [];
        if (workspace !== null) {
            items.push({ id: 'new-pane', label: 'New pane', onSelect: verbs.createPane });
            if (shownPane !== null) {
                items.push({ id: 'rename-pane', label: 'Rename pane', onSelect: () => setSheet('rename') });
            }
            if (remoteHost === null) {
                const on = workspace.isSyncInputActive;
                items.push({ id: 'sync-input', label: on ? 'Stop syncing input' : 'Sync input to all panes', onSelect: actions.toggleSyncInput });
            }
        }
        items.push({ id: 'palette', label: 'Command palette', onSelect: actions.openPalette });
        items.push({ id: 'settings', label: 'Settings', onSelect: actions.openSettings });
        if (shownPane !== null) {
            items.push({ id: 'close-pane', label: 'Close pane', danger: true, onSelect: () => verbs.closePane(shownPane.id) });
        }
        return items;
    }, [workspace, shownPane, remoteHost, verbs, actions]);

    // ── render ──────────────────────────────────────────────────────────────────────

    const paneTitle = shownPane === null ? null : paneDisplayTitle(shownPane, props.homeDirectory);
    const hostLabel = remoteHost === null ? null : remoteHost.name;
    const workspaceLabel = workspace?.name ?? (props.ready ? 'No workspace' : 'Kelpi');

    let content: ReactNode;
    if (remoteHost !== null && remoteWorkspaceID !== null) {
        content = (
            <PhoneRemoteWorkspace
                hostName={remoteHost.name}
                runtime={remoteHost.runtime}
                workspaceID={remoteWorkspaceID}
                mode={view.mode}
                createRenderer={props.createRenderer}
            />
        );
    } else if (props.workspace === null) {
        content = props.ready ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center" data-testid="phone-no-workspace">
                <span className="text-[15px]" style={{ color: tokens.textSecondary }}>
                    No workspace selected
                </span>
                <PhoneButton testID="phone-no-workspace-create" onClick={() => setSheet('new-workspace')}>
                    <ChromeIcon name="plus" size={12} />
                    New workspace
                </PhoneButton>
            </div>
        ) : null;
    } else if (view.mode === 'layout') {
        content = (
            <PaneGrid
                {...props.grid}
                layout={props.workspace.layout}
                panes={props.workspace.panes}
                focusedPaneID={props.focusedPaneID}
                zoomedPaneID={props.workspace.zoomedPaneID ?? null}
                syncActive={props.workspace.isSyncInputActive}
                syncExcludedPaneIDs={props.workspace.syncInputExcluded ?? EMPTY_IDS}
                homeDirectory={props.homeDirectory}
                renderPane={props.renderPane}
            />
        );
    } else if (shownPane === null) {
        content = (
            <div className="flex h-full items-center justify-center text-[13px]" data-testid="phone-empty-workspace" style={{ color: tokens.textTertiary }}>
                No panes in this workspace.
            </div>
        );
    } else {
        // The same attributes the grid's wrapper carries (`data-pane-id`, `data-focused`,
        // `pane-body-<id>`): the audit's phone lane finds the pane it borrowed by them.
        content = (
            <div
                data-testid={`pane-${shownPane.id}`}
                data-pane-id={shownPane.id}
                data-hidden="false"
                data-focused="true"
                data-zoomed="false"
                className="flex h-full w-full flex-col overflow-hidden"
            >
                <div data-testid={`pane-body-${shownPane.id}`} className="relative min-h-0 flex-1">
                    {props.renderPane(shownPane.id, ZERO_RECT, true, { visible: true, zoomed: false, dragging: false })}
                </div>
            </div>
        );
    }

    return (
        <div
            data-testid="phone-shell"
            data-phone-mode={view.mode}
            data-phone-host={remoteHost?.key ?? ORIGIN_HOST_KEY}
            className="flex min-h-0 flex-1 flex-col"
            style={{ paddingLeft: PHONE_SAFE_AREA.left, paddingRight: PHONE_SAFE_AREA.right, paddingBottom: PHONE_SAFE_AREA.bottom }}
        >
            <div
                data-testid="phone-header"
                className="flex shrink-0 items-center border-b"
                style={{
                    background: tokens.headerBackground,
                    borderColor: tokens.divider,
                    minHeight: `${String(PHONE_ROW_MIN_PX)}px`,
                    paddingTop: PHONE_SAFE_AREA.top
                }}
            >
                <PhoneButton testID="phone-open-workspaces" ariaLabel="Workspaces" ariaExpanded={sheet === 'workspaces'} onClick={() => setSheet('workspaces')}>
                    <ChromeIcon name="sidebar" size={16} />
                </PhoneButton>
                <button
                    type="button"
                    data-testid="phone-title"
                    className="flex min-w-0 flex-1 items-center gap-2 px-1 text-left"
                    style={{ minHeight: `${String(PHONE_ROW_MIN_PX)}px`, color: tokens.textPrimary }}
                    onClick={() => setSheet('panes')}
                >
                    <span className="flex min-w-0 flex-col">
                        <span className="truncate text-[12px]" style={{ color: tokens.textTertiary }} data-testid="phone-title-workspace">
                            {hostLabel === null ? workspaceLabel : `${hostLabel} · ${workspaceLabel}`}
                        </span>
                        {shownPane === null ? null : (
                            <span
                                className="truncate text-[14px] font-semibold"
                                data-testid={`pane-header-${shownPane.id}`}
                                data-focused="true"
                            >
                                {paneTitle}
                            </span>
                        )}
                    </span>
                    {agentDot === null ? null : (
                        <span
                            aria-label={`${String(counts.waiting)} waiting, ${String(counts.running)} running`}
                            data-testid="phone-agent-dot"
                            data-waiting={counts.waiting}
                            data-running={counts.running}
                            className="h-[8px] w-[8px] shrink-0 rounded-full"
                            style={{ background: agentDot }}
                        />
                    )}
                    {shownPane === null ? null : statusDotColor(shownPane.status) === null ? null : (
                        <span
                            aria-hidden
                            data-testid="phone-pane-status"
                            data-status={shownPane.status}
                            className="h-[6px] w-[6px] shrink-0 rounded-full"
                            style={{ background: statusDotColor(shownPane.status) ?? undefined }}
                        />
                    )}
                </button>
                <PhoneButton
                    testID="phone-view-toggle"
                    ariaLabel={view.mode === 'pane' ? 'Show full layout' : 'Show one pane'}
                    onClick={view.toggleMode}
                    className={view.mode === 'layout' ? 'opacity-100' : 'opacity-70'}
                >
                    <ChromeIcon name="layout" size={16} filled={view.mode === 'layout'} />
                </PhoneButton>
                <PhoneButton testID="phone-open-panes" ariaLabel="Panes" ariaExpanded={sheet === 'panes'} onClick={() => setSheet('panes')}>
                    <ChromeIcon name="stack" size={16} />
                    <span className="text-[12px]" data-testid="phone-pane-count">
                        {panes.length}
                    </span>
                </PhoneButton>
                <PhoneButton testID="phone-more" ariaLabel="More" ariaExpanded={sheet === 'menu'} onClick={() => setSheet('menu')}>
                    <ChromeIcon name="ellipsis" size={16} />
                </PhoneButton>
            </div>

            <div
                ref={contentRef}
                data-testid="phone-content"
                className="relative min-h-0 flex-1"
                onTouchStartCapture={onTouchStart}
                onTouchMoveCapture={onTouchMove}
                onTouchEndCapture={onTouchEnd}
                onTouchCancelCapture={onTouchEnd}
            >
                {content}
                {props.ready ? null : <ConnectionSplash runtime={props.runtime} state={props.state} target={props.target} />}
                {props.palette}
                {/* Last in the box, so it paints over the pane and under the palette's scrim. The
                    bar aims at the pane that holds the caret's claim: the shown pane in `pane`
                    mode, the focused one in the grid, on whichever host is on screen. */}
                <PhoneKeyBar paneID={view.mode === 'pane' ? shownPaneID : remoteHost === null ? props.focusedPaneID : shownPaneID} contentRow={contentRef} />
            </div>

            <PhoneWorkspaceDrawer
                open={sheet === 'workspaces'}
                hosts={hosts}
                selection={selection}
                bucket={props.bucket}
                onSelect={onSelectWorkspace}
                onNewWorkspace={() => setSheet('new-workspace')}
                onAddHost={() => setSheet('host')}
                onRemoveHost={(hostKey) => {
                    const entry = phoneHosts.hosts.find((candidate) => `phone:${candidate.id}` === hostKey);
                    if (entry !== undefined) phoneHosts.remove(entry.id);
                }}
                onClose={closeSheet}
            />
            <PhonePaneSheet
                open={sheet === 'panes'}
                workspaceName={workspace?.name ?? null}
                panes={panes}
                shownPaneID={shownPaneID}
                homeDirectory={props.homeDirectory}
                onShow={verbs.focusPane}
                onNewPane={workspace === null ? null : verbs.createPane}
                onClosePane={workspace === null ? null : verbs.closePane}
                onClose={closeSheet}
            />
            <PhoneMenuSheet open={sheet === 'menu'} title={paneTitle ?? workspaceLabel} items={menuItems} onClose={closeSheet} />
            <PhoneHostSheet
                open={sheet === 'host'}
                existingNames={hosts.map((host) => host.name)}
                onAdd={(name, url) => {
                    phoneHosts.add(name, url);
                }}
                onClose={() => setSheet('workspaces')}
            />
            <PhonePromptSheet
                open={sheet === 'new-workspace'}
                title="New workspace"
                initial=""
                placeholder="workspace name"
                submitLabel="Create"
                onSubmit={actions.createWorkspace}
                onClose={closeSheet}
            />
            <PhonePromptSheet
                open={sheet === 'rename'}
                title="Rename pane"
                initial={shownPane?.label ?? paneTitle ?? ''}
                placeholder="pane name"
                onSubmit={(name) => {
                    if (shownPane !== null) verbs.renamePane(shownPane.id, name);
                }}
                onClose={closeSheet}
            />
        </div>
    );
}
