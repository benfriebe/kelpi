/**
 * The assembled client (WP3.6).
 *
 * Every other module under `src/` is deliberately store-free and props-driven; this is the one
 * place where the socket, the mirror and the surfaces are wired to each other. The rules it
 * follows are the ones the other work packages were written against:
 *
 *   - **The daemon is the app.** Nothing here mutates domain state. A gesture becomes a command
 *     (`CommandClient`), the daemon answers with a delta, the mirror advances, the UI re-renders.
 *     The only client-owned state is UI state: which workspace THIS client looks at, whether the
 *     sidebar is open, the palette, toasts.
 *   - **Pane identity is sacred.** `renderPane` returns a `TerminalPane` keyed by pane id inside
 *     a grid wrapper that never unmounts, and every callback handed to it is `useCallback`-stable,
 *     so a workspace-wide relayout cannot cost a terminal its scrollback or its PTY.
 *   - **Reads are scalars or memoized.** zustand v5 subscribes through `useSyncExternalStore`,
 *     which spins forever if a selector mints a fresh array per call — so the component
 *     subscribes to the store object once and derives everything else in `useMemo`.
 *   - **Callbacks read the store, not the render.** Anything invoked from an event handler
 *     (key dispatch, palette, menus) resolves the active workspace through `store.getState()`,
 *     which is why the handler set can be built once instead of on every render.
 *
 * Content panes (markdown/diff/scratchpad) are M5's bodies and subscribe through one shared
 * `ContentClient`; a web pane still renders an honest placeholder card rather than an empty box
 * (its renderer is M6), because the pane is real daemon state either way.
 */

import { PREDEFINED_LAYOUT_ORDER, type DropZone, type SplitDirection } from '@nex/core/layout';
import {
    layoutPaneOrder,
    syncedPaneIDs,
    type Pane,
    type PredefinedLayoutKind,
    type WorkspaceState
} from '@nex/daemon/store';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useStore } from 'zustand';

import { ContentPanePlaceholder } from './app/ContentPanePlaceholder';
import { describeTarget, type DaemonTarget } from './app/config';
import {
    CommandPalette,
    Sidebar,
    StatusFooter,
    ThemeProvider,
    TopBar,
    buildPaletteItems,
    clientKeyBindings,
    createFaviconController,
    createKeyDispatcher,
    installKeyDispatcher,
    tokens as chromeTokens,
    useChromeTheme,
    workspaceSwitchHandlers,
    type AgentBucket,
    type FaviconController,
    type KeyActionRegistry,
    type PaletteItem,
    type StatusBarItem
} from './chrome';
import { isOkReply, replyError, type CommandReply } from './connection';
import { DiffPane, MarkdownPane, ScratchpadPane, createContentClient } from './content';
import { PaneGrid, type PaneModel, type RenderPane } from './grid';
import {
    selectActiveWorkspace,
    selectAgentSummary,
    selectFilteredSidebarEntries,
    selectFocusedPaneID,
    selectPane,
    selectVisibleWorkspaceIDs,
    type NexRuntime,
    type Toast
} from './state';
import {
    TerminalPane,
    createMountPolicy,
    resolveTerminalTheme,
    visiblePaneIDs,
    type TerminalGeometry,
    type TerminalRendererFactory,
    type TerminalTheme
} from './terminal';

/** `@nex/core/layout`'s geometric drop zones → the wire's `pane-move-adjacent` vocabulary. */
const WIRE_DROP_ZONE: Readonly<Record<DropZone, 'above' | 'below' | 'left-of' | 'right-of'>> = {
    top: 'above',
    bottom: 'below',
    left: 'left-of',
    right: 'right-of'
};

/** Command-error toasts clear themselves; a failed command is news, not a permanent banner. */
const ERROR_TOAST_MS = 6000;

let errorSequence = 0;

export interface AppProps {
    readonly runtime: NexRuntime;
    /** What the connection screens name as the target (main.tsx passes the resolved one). */
    readonly target?: DaemonTarget | undefined;
    /** Engine override for tests; the app uses `VITE_TERMINAL_ENGINE`. */
    readonly createRenderer?: TerminalRendererFactory | undefined;
    /** Live-renderer cap (`terminal/mount-policy.ts`). */
    readonly mountLimit?: number | undefined;
    /** Skip the `runtime.connect()` / `dispose()` lifecycle (a test driving it by hand). */
    readonly autoConnect?: boolean | undefined;
}

export function App(props: AppProps): ReactElement {
    return (
        <ThemeProvider appearance="system" applyToDocument className="contents">
            <Shell {...props} />
        </ThemeProvider>
    );
}

function Shell(props: AppProps): ReactElement {
    const { runtime, createRenderer, mountLimit } = props;
    const store = runtime.store;
    const commands = runtime.commands;
    const { bucket } = useChromeTheme();

    const nex = useStore(store);
    const daemon = nex.daemon;
    const ui = nex.ui;

    const [sidebarVisible, setSidebarVisible] = useState(true);
    const [terminalTheme, setTerminalTheme] = useState<TerminalTheme | undefined>(undefined);

    // ── connection lifecycle ────────────────────────────────────────────────────────

    useEffect(() => {
        if (props.autoConnect === false) return;
        runtime.connect();
        return () => runtime.dispose();
    }, [runtime, props.autoConnect]);

    useEffect(() => {
        if (typeof document === 'undefined') return;
        const report = (): void => runtime.setDocumentVisible(document.visibilityState !== 'hidden');
        document.addEventListener('visibilitychange', report);
        report();
        return () => document.removeEventListener('visibilitychange', report);
    }, [runtime]);

    // Browsers only grant notification permission from a user gesture, so the first click in
    // the window is the prompt (agent-lifecycle.md §7 client half).
    useEffect(() => {
        const ask = (): void => {
            window.removeEventListener('pointerdown', ask);
            void runtime.notifications?.request();
        };
        window.addEventListener('pointerdown', ask);
        return () => window.removeEventListener('pointerdown', ask);
    }, [runtime]);

    // ── derived reads ───────────────────────────────────────────────────────────────

    const workspace = useMemo(() => selectActiveWorkspace(nex), [nex]);
    const focusedPaneID = useMemo(() => selectFocusedPaneID(nex), [nex]);
    const filteredEntries = useMemo(() => selectFilteredSidebarEntries(nex), [nex]);
    const agentSummary = useMemo(() => selectAgentSummary(nex), [nex]);

    const panes = workspace?.panes ?? EMPTY_PANES;
    const paneByID = useMemo(() => new Map(panes.map((pane) => [pane.id, pane])), [panes]);
    const paneOrder = useMemo(() => (workspace === null ? EMPTY_IDS : layoutPaneOrder(workspace)), [workspace]);
    const synced = useMemo(() => (workspace === null ? EMPTY_IDS : syncedPaneIDs(workspace)), [workspace]);
    const visible = useMemo(
        () =>
            visiblePaneIDs({
                paneOrder,
                zoomedPaneID: workspace?.zoomedPaneID ?? null,
                workspaceActive: true
            }),
        [paneOrder, workspace]
    );
    const currentLayout = useMemo<PredefinedLayoutKind | null>(() => {
        const index = workspace?.currentLayoutIndex ?? null;
        return index === null ? null : (PREDEFINED_LAYOUT_ORDER[index] ?? null);
    }, [workspace]);

    // ── command plumbing ────────────────────────────────────────────────────────────

    const notifyFailure = useCallback(
        (label: string, detail: string): void => {
            errorSequence += 1;
            const id = `cmd-error-${errorSequence}`;
            const toast: Toast = {
                id,
                kind: 'info',
                title: label,
                body: detail,
                paneID: null,
                workspaceID: null,
                createdAt: Date.now()
            };
            store.getState().pushToast(toast);
            setTimeout(() => store.getState().dismissToast(id), ERROR_TOAST_MS);
        },
        [store]
    );

    /** Fire a command and surface a failure as a toast; never throw into an event handler. */
    const run = useCallback(
        (label: string, promise: Promise<CommandReply>): true => {
            void promise.then(
                (reply) => {
                    if (!isOkReply(reply)) notifyFailure(label, replyError(reply));
                },
                (error: unknown) => {
                    notifyFailure(label, error instanceof Error ? error.message : String(error));
                }
            );
            return true;
        },
        [notifyFailure]
    );

    /** `run` for anything that is not a raw command reply (the content verbs resolve to void). */
    const runTask = useCallback(
        (label: string, task: Promise<unknown>): true => {
            void task.catch((error: unknown) => {
                notifyFailure(label, error instanceof Error ? error.message : String(error));
            });
            return true;
        },
        [notifyFailure]
    );

    /**
     * One content client for the whole window (M5). It multiplexes the per-pane subscriptions
     * the bodies open, re-subscribes after a reconnect, and owns the typing debounce — so a
     * closing tab still owes the daemon whatever the editor is holding, which is why it is
     * disposed rather than garbage-collected.
     */
    const content = useMemo(
        () =>
            createContentClient({
                connection: runtime.connection,
                commands,
                // A content verb resolves rather than rejects (the pane reads its own error
                // state), so the toast is raised here or a failed refresh is silent. A drop
                // fails every in-flight command at once and the banner already says why, so
                // those are left to it.
                onError: (message, context) => {
                    if (runtime.connection.status !== 'connected') return;
                    notifyFailure(`Content pane (${context})`, message);
                }
            }),
        [runtime, commands, notifyFailure]
    );
    useEffect(() => () => content.dispose(), [content]);

    /**
     * Every intent the UI can raise, bound once. Each reads the CURRENT mirror through
     * `store.getState()` rather than closing over a render's values, so the object is stable
     * and the key dispatcher / menus never go stale.
     */
    const act = useMemo(() => {
        const activeWorkspace = (): WorkspaceState | null => selectActiveWorkspace(store.getState());
        const activeWorkspaceID = (): string | null => activeWorkspace()?.id ?? null;
        const focused = (): string | null => selectFocusedPaneID(store.getState());
        const toggleMarkdownEdit = (paneID: string): boolean => {
            const pane = selectPane(store.getState(), paneID);
            if (pane === null || pane.type !== 'markdown') return false;
            return runTask('Toggle markdown edit', content.setMode(paneID, pane.isEditing ? 'view' : 'edit'));
        };

        return {
            focusPane(paneID: string | null): boolean {
                const id = activeWorkspaceID();
                if (id === null) return false;
                runtime.focusPane(id, paneID);
                return true;
            },

            focusStep(delta: 1 | -1): boolean {
                const current = activeWorkspace();
                if (current === null) return false;
                const order = layoutPaneOrder(current);
                if (order.length === 0) return false;
                const at = order.indexOf(focused() ?? '');
                const next = order[(((at < 0 ? 0 : at) + delta + order.length) % order.length)];
                if (next === undefined) return false;
                runtime.focusPane(current.id, next);
                return true;
            },

            activateWorkspace(workspaceID: string): boolean {
                runtime.activateWorkspace(workspaceID);
                return true;
            },

            switchToIndex(index: number): boolean {
                const id = selectVisibleWorkspaceIDs(store.getState())[index];
                if (id === undefined) return false;
                runtime.activateWorkspace(id);
                return true;
            },

            switchRelative(delta: 1 | -1): boolean {
                const ids = selectVisibleWorkspaceIDs(store.getState());
                if (ids.length === 0) return false;
                const at = ids.indexOf(activeWorkspaceID() ?? '');
                const id = ids[(((at < 0 ? 0 : at) + delta + ids.length) % ids.length)];
                if (id === undefined) return false;
                runtime.activateWorkspace(id);
                return true;
            },

            splitPane(paneID: string, direction: SplitDirection): boolean {
                return run('Split pane', commands.splitPane({ paneID, direction }));
            },

            splitFocused(direction: SplitDirection): boolean {
                const paneID = focused();
                if (paneID === null) return false;
                return run('Split pane', commands.splitPane({ paneID, direction }));
            },

            createPane(): boolean {
                const id = activeWorkspaceID();
                if (id === null) return false;
                return run('New pane', commands.createPane({ workspace: id }));
            },

            closePane(paneID: string): boolean {
                return run('Close pane', commands.closePane({ paneID }));
            },

            closeFocused(): boolean {
                const paneID = focused();
                if (paneID === null) return false;
                return run('Close pane', commands.closePane({ paneID }));
            },

            renamePane(paneID: string, name: string): boolean {
                return run('Rename pane', commands.renamePane({ paneID, name }));
            },

            toggleZoom(paneID: string): boolean {
                return run('Zoom pane', commands.toggleZoom({ paneID }));
            },

            toggleZoomFocused(): boolean {
                const paneID = focused();
                if (paneID === null) return false;
                return run('Zoom pane', commands.toggleZoom({ paneID }));
            },

            movePaneDirection(direction: 'left' | 'right' | 'up' | 'down'): boolean {
                const paneID = focused();
                if (paneID === null) return false;
                return run('Move pane', commands.movePane({ paneID, direction }));
            },

            movePaneAdjacent(paneID: string, anchorID: string, zone: DropZone): boolean {
                return run(
                    'Move pane',
                    commands.movePaneAdjacent({
                        target: paneID,
                        anchor: anchorID,
                        zone: WIRE_DROP_ZONE[zone]
                    })
                );
            },

            setSplitRatio(paneID: string, share: number): boolean {
                return run('Resize pane', commands.setSplitRatio(paneID, share));
            },

            cycleLayout(): boolean {
                const paneID = focused();
                if (paneID === null) return false;
                return run('Cycle layout', commands.cycleLayout({ paneID }));
            },

            selectLayout(layout: PredefinedLayoutKind): boolean {
                const paneID = focused();
                if (paneID === null) return false;
                return run('Select layout', commands.selectLayout({ paneID, layout }));
            },

            toggleSyncInput(): boolean {
                const id = activeWorkspaceID();
                if (id === null) return false;
                return run('Synchronise input', commands.setSyncInput({ action: 'toggle', workspace: id }));
            },

            /**
             * ⌘E / the header's pencil-eye button (content-panes.md §4.1). The mode lives in the
             * daemon, so the toggle reads the pane's current `isEditing` and asks for the other
             * one; a non-markdown pane declines, which lets the keystroke fall through.
             */
            toggleMarkdownEdit,

            toggleMarkdownEditFocused(): boolean {
                const paneID = focused();
                if (paneID === null) return false;
                return toggleMarkdownEdit(paneID);
            },

            /** The diff header's refresh button (§5.2 trigger 2) — re-runs `git diff`. */
            refreshDiff(paneID: string): boolean {
                return runTask('Refresh diff', content.refresh(paneID));
            },

            newWorkspace(): boolean {
                return run('New workspace', commands.createWorkspace({}));
            },

            createWorkspace(name: string, groupID: string | null): boolean {
                const trimmed = name.trim();
                return run(
                    'New workspace',
                    commands.createWorkspace({
                        ...(trimmed.length > 0 ? { name: trimmed } : {}),
                        ...(groupID === null ? {} : { group: groupID })
                    })
                );
            },

            deleteWorkspace(workspaceID: string): boolean {
                // The sidebar runs its own confirmation first, which is the GUI's
                // "delete anyway?" — so the command goes out forced, as the app's own
                // delete path does once the user has said yes.
                return run('Delete workspace', commands.deleteWorkspace({ workspace: workspaceID, force: true }));
            },

            renameWorkspace(workspaceID: string, name: string): boolean {
                const trimmed = name.trim();
                if (trimmed.length === 0) return false;
                return run('Rename workspace', commands.renameWorkspace({ workspaceID, name: trimmed }));
            },

            moveWorkspace(request: { workspaceID: string; groupID: string | null; index: number }): boolean {
                return run(
                    'Move workspace',
                    commands.moveWorkspace({
                        workspace: request.workspaceID,
                        ...(request.groupID === null ? {} : { group: request.groupID }),
                        index: request.index
                    })
                );
            },

            toggleWorkspaceLabel(workspaceID: string, label: string, applied: boolean): boolean {
                return run(
                    'Label workspace',
                    commands.labelWorkspace({
                        workspace: workspaceID,
                        op: applied ? 'add' : 'remove',
                        values: [label]
                    })
                );
            },

            createGroup(name: string): boolean {
                const trimmed = name.trim();
                if (trimmed.length === 0) return false;
                return run('New group', commands.createGroup({ name: trimmed }));
            },

            renameGroup(groupID: string, name: string): boolean {
                const trimmed = name.trim();
                if (trimmed.length === 0) return false;
                return run('Rename group', commands.renameGroup({ group: groupID, newName: trimmed }));
            },

            deleteGroup(groupID: string, cascade: boolean): boolean {
                return run('Delete group', commands.deleteGroup({ group: groupID, cascade }));
            },

            setGroupCollapsed(groupID: string, collapsed: boolean): boolean {
                return run('Collapse group', commands.setGroupCollapsed({ groupID, collapsed }));
            },

            togglePalette(): boolean {
                store.getState().togglePalette();
                return true;
            },

            toggleSidebar(): boolean {
                setSidebarVisible((visibleNow) => !visibleNow);
                return true;
            }
        };
    }, [commands, content, run, runTask, runtime, store]);

    // ── terminal mounting ───────────────────────────────────────────────────────────

    const policyRef = useRef(createMountPolicy());
    const [mounted, setMounted] = useState<readonly string[]>(EMPTY_IDS);

    const terminalCandidates = useMemo(
        () => visible.filter((paneID) => paneByID.get(paneID)?.type === 'shell'),
        [visible, paneByID]
    );
    const candidateKey = terminalCandidates.join(',');

    useEffect(() => {
        const desired = candidateKey.length === 0 ? [] : candidateKey.split(',');
        const decision = policyRef.current.plan({
            desired,
            focusedPaneID,
            ...(mountLimit === undefined ? {} : { limit: mountLimit })
        });
        setMounted((current) => (sameOrder(current, decision.mounted) ? current : decision.mounted));
    }, [candidateKey, focusedPaneID, mountLimit]);

    const mountedSet = useMemo(() => new Set(mounted), [mounted]);

    // What this client actually shows the user — the daemon uses it for notification
    // suppression and for its "app is active" answer (`ws/sync.ts` `visibilityReport`). It is
    // the LAYOUT-visible set, not the mounted-terminal set: a content pane the user is looking
    // at, and a terminal the mount cap evicted, are both on screen.
    const visibleKey = visible.join(',');
    useEffect(() => {
        if (workspace === null) return;
        runtime.reportVisiblePanes(workspace.id, visibleKey.length === 0 ? [] : visibleKey.split(','));
    }, [runtime, workspace, visibleKey]);

    // A workspace switch re-asserts focus so the daemon's suppression math knows which pane
    // this client is looking at (its per-connection focus starts empty).
    const workspaceID = workspace?.id ?? null;
    const workspaceFocusRef = useRef<string | null>(null);
    useEffect(() => {
        if (workspaceID === null || workspaceFocusRef.current === workspaceID) return;
        workspaceFocusRef.current = workspaceID;
        const current = selectActiveWorkspace(store.getState());
        if (current !== null) runtime.focusPane(current.id, current.focusedPaneID);
    }, [workspaceID, runtime, store]);

    // The engines want concrete colors, and the palette only exists on the DOM after the theme
    // provider's effect has run — so it is read one commit later, per bucket.
    useEffect(() => {
        setTerminalTheme(resolveTerminalTheme());
    }, [bucket]);

    // ── pane dimensions (the grid's resize badge) ───────────────────────────────────

    const dimensionsRef = useRef(new Map<string, TerminalGeometry>());
    const [, setDimensionsTick] = useState(0);

    const onDimensionsChange = useCallback((paneID: string, geometry: TerminalGeometry): void => {
        const previous = dimensionsRef.current.get(paneID);
        if (previous?.cols === geometry.cols && previous.rows === geometry.rows) return;
        dimensionsRef.current.set(paneID, geometry);
        setDimensionsTick((tick) => tick + 1);
    }, []);

    const getPaneDimensions = useCallback(
        (paneID: string): TerminalGeometry | null => dimensionsRef.current.get(paneID) ?? null,
        []
    );

    const onTerminalFocus = useCallback(
        (paneID: string): void => {
            act.focusPane(paneID);
        },
        [act]
    );

    // ── favicon / tab badge ─────────────────────────────────────────────────────────

    const faviconRef = useRef<FaviconController | null>(null);
    useEffect(() => {
        const controller = createFaviconController({ title: 'Nex' });
        faviconRef.current = controller;
        return () => {
            controller.dispose();
            faviconRef.current = null;
        };
    }, []);
    useEffect(() => {
        faviconRef.current?.update({ running: agentSummary.running, waiting: agentSummary.waiting });
    }, [agentSummary]);

    // ── keybindings ─────────────────────────────────────────────────────────────────

    const keyActions = useMemo<KeyActionRegistry>(
        () => ({
            split_right: () => act.splitFocused('horizontal'),
            split_down: () => act.splitFocused('vertical'),
            close_pane: () => act.closeFocused(),
            focus_next_pane: () => act.focusStep(1),
            focus_previous_pane: () => act.focusStep(-1),
            move_pane_left: () => act.movePaneDirection('left'),
            move_pane_right: () => act.movePaneDirection('right'),
            move_pane_up: () => act.movePaneDirection('up'),
            move_pane_down: () => act.movePaneDirection('down'),
            toggle_zoom: () => act.toggleZoomFocused(),
            cycle_layout: () => act.cycleLayout(),
            // Conditional binding (§4.1): only a focused markdown pane consumes ⌘E — anything
            // else returns false and the keystroke falls through to the pane.
            toggle_markdown_edit: () => act.toggleMarkdownEditFocused(),
            toggle_sync_input: () => act.toggleSyncInput(),
            command_palette: () => act.togglePalette(),
            toggle_sidebar: () => act.toggleSidebar(),
            new_workspace: () => act.newWorkspace(),
            next_workspace: () => act.switchRelative(1),
            previous_workspace: () => act.switchRelative(-1),
            ...workspaceSwitchHandlers((index) => act.switchToIndex(index))
        }),
        [act]
    );

    const keyActionsRef = useRef(keyActions);
    useEffect(() => {
        keyActionsRef.current = keyActions;
    }, [keyActions]);

    useEffect(() => {
        const bindings = clientKeyBindings();
        const dispatcher = createKeyDispatcher({
            bindings,
            actions: () => keyActionsRef.current,
            isPaletteOpen: () => store.getState().ui.palette.open,
            hasActiveWorkspace: () => selectActiveWorkspace(store.getState()) !== null
        });
        return installKeyDispatcher(window, dispatcher);
    }, [store]);

    // ── palette ─────────────────────────────────────────────────────────────────────

    const paletteCommands = useMemo<PaletteItem[]>(
        () => [
            paletteCommand('cmd:new-pane', 'terminal', 'New Pane', 'split the focused pane right', () =>
                act.splitFocused('horizontal')
            ),
            paletteCommand('cmd:split-down', 'terminal', 'Split Down', 'split the focused pane down', () =>
                act.splitFocused('vertical')
            ),
            paletteCommand('cmd:close-pane', 'terminal', 'Close Pane', 'close the focused pane', () =>
                act.closeFocused()
            ),
            paletteCommand('cmd:toggle-zoom', 'rectangle.stack', 'Toggle Zoom', 'zoom the focused pane', () =>
                act.toggleZoomFocused()
            ),
            paletteCommand('cmd:cycle-layout', 'rectangle.stack', 'Cycle Layout', 'next predefined layout', () =>
                act.cycleLayout()
            ),
            paletteCommand('cmd:sync-input', 'terminal', 'Toggle Synchronise Input', 'mirror typing across panes', () =>
                act.toggleSyncInput()
            ),
            paletteCommand('cmd:new-workspace', 'rectangle.stack', 'New Workspace', 'create an empty workspace', () =>
                act.newWorkspace()
            )
        ],
        [act]
    );

    const paletteItems = useMemo(
        () => buildPaletteItems(daemon.state.workspaces, { commands: paletteCommands }),
        [daemon.state.workspaces, paletteCommands]
    );

    const onPaletteConfirm = useCallback(
        (item: PaletteItem): void => {
            store.getState().setPaletteOpen(false);
            if (item.kind === 'command') {
                item.run?.();
                return;
            }
            if (item.workspaceID === null) return;
            // §8.5 ordering: activate the workspace, then focus the pane.
            runtime.activateWorkspace(item.workspaceID);
            if (item.paneID !== null) runtime.focusPane(item.workspaceID, item.paneID);
        },
        [runtime, store]
    );

    const onFocusHandoff = useCallback(
        (paneID: string | null): void => {
            if (paneID === null) return;
            act.focusPane(paneID);
            focusTerminalElement(paneID);
        },
        [act]
    );

    // ── status footer ───────────────────────────────────────────────────────────────

    const bucketItems = useCallback(
        (agentBucket: AgentBucket): readonly StatusBarItem[] => statusItems(daemon.state.workspaces, agentBucket),
        [daemon.state.workspaces]
    );

    const onSelectStatusPane = useCallback(
        (targetWorkspaceID: string, paneID: string): void => {
            runtime.activateWorkspace(targetWorkspaceID);
            runtime.focusPane(targetWorkspaceID, paneID);
        },
        [runtime]
    );

    // ── pane bodies ─────────────────────────────────────────────────────────────────

    const renderPane = useCallback<RenderPane>(
        (paneID, _frame, focused, renderState) => {
            const pane = paneByID.get(paneID);
            if (pane === undefined) return null;

            // Content bodies subscribe on mount and unsubscribe on unmount, so the daemon only
            // reads and watches files somebody is actually looking at (M5).
            if (pane.type === 'markdown') {
                return (
                    <MarkdownPane
                        paneID={paneID}
                        content={content}
                        focused={focused}
                        visible={renderState.visible}
                        onFocusRequest={onTerminalFocus}
                        onToggleEdit={act.toggleMarkdownEdit}
                    />
                );
            }
            if (pane.type === 'diff') {
                return (
                    <DiffPane
                        paneID={paneID}
                        content={content}
                        focused={focused}
                        visible={renderState.visible}
                        onFocusRequest={onTerminalFocus}
                    />
                );
            }
            if (pane.type === 'scratchpad') {
                return (
                    <ScratchpadPane
                        paneID={paneID}
                        content={content}
                        focused={focused}
                        visible={renderState.visible}
                        onFocusRequest={onTerminalFocus}
                    />
                );
            }
            if (pane.type !== 'shell') {
                return <ContentPanePlaceholder pane={pane} url={webPaneURL(workspace, paneID)} />;
            }
            if (!mountedSet.has(paneID)) {
                return <ContentPanePlaceholder pane={pane} variant="detached" />;
            }
            return (
                <TerminalPane
                    paneID={paneID}
                    ptyApi={runtime.pty}
                    focused={focused}
                    visible={renderState.visible}
                    theme={terminalTheme}
                    onFocusRequest={onTerminalFocus}
                    onDimensionsChange={onDimensionsChange}
                    createRenderer={createRenderer}
                />
            );
        },
        [
            act,
            content,
            paneByID,
            workspace,
            mountedSet,
            runtime,
            terminalTheme,
            onTerminalFocus,
            onDimensionsChange,
            createRenderer
        ]
    );

    // ── render ──────────────────────────────────────────────────────────────────────

    const ready = daemon.hasSnapshot;
    const target = props.target ?? { url: undefined, token: undefined, fromQuery: false };

    return (
        <div
            data-testid="nex-app"
            data-connection={ui.connection}
            /* `relative`: the connection banner and the toast stack position against the
               window, not against the pane grid (which is its own positioned container). */
            className="relative flex h-full w-full overflow-hidden"
            style={{ background: chromeTokens.windowBackground, color: chromeTokens.textPrimary }}
        >
            {sidebarVisible ? (
                <Sidebar
                    entries={filteredEntries}
                    activeWorkspaceID={workspace?.id ?? null}
                    filter={ui.sidebarFilter}
                    onFilterChange={(filter) => store.getState().setSidebarFilter(filter)}
                    labelPresets={daemon.state.labelPresets}
                    bucket={bucket}
                    onActivateWorkspace={act.activateWorkspace}
                    onToggleGroupCollapse={act.setGroupCollapsed}
                    onRenameWorkspace={act.renameWorkspace}
                    onDeleteWorkspace={act.deleteWorkspace}
                    onToggleWorkspaceLabel={act.toggleWorkspaceLabel}
                    onMoveWorkspace={act.moveWorkspace}
                    onRenameGroup={act.renameGroup}
                    onDeleteGroup={act.deleteGroup}
                    onCreateWorkspace={act.createWorkspace}
                    onCreateGroup={act.createGroup}
                />
            ) : null}

            <div className="flex min-w-0 flex-1 flex-col">
                <TopBar
                    workspaceName={workspace?.name ?? null}
                    workspaceColor={workspace?.color}
                    panes={panes}
                    bucket={bucket}
                    connection={ui.connection}
                    connectionError={ui.connectionError}
                    currentLayout={currentLayout}
                    onCycleLayout={act.cycleLayout}
                    onSelectLayout={act.selectLayout}
                    syncInputActive={workspace?.isSyncInputActive ?? false}
                    syncedPaneCount={synced.length}
                    onToggleSyncInput={act.toggleSyncInput}
                    onToggleSidebar={act.toggleSidebar}
                    sidebarVisible={sidebarVisible}
                />

                <div className="relative min-h-0 flex-1">
                    <PaneGrid
                        layout={workspace?.layout ?? EMPTY_LAYOUT}
                        panes={panes}
                        focusedPaneID={focusedPaneID}
                        zoomedPaneID={workspace?.zoomedPaneID ?? null}
                        syncActive={workspace?.isSyncInputActive ?? false}
                        syncExcludedPaneIDs={workspace?.syncInputExcluded ?? EMPTY_IDS}
                        renderPane={renderPane}
                        getPaneDimensions={getPaneDimensions}
                        onFocusPane={act.focusPane}
                        onClosePane={act.closePane}
                        onRenamePane={act.renamePane}
                        onSplitPane={act.splitPane}
                        onToggleZoom={act.toggleZoom}
                        onToggleMarkdownEdit={act.toggleMarkdownEdit}
                        onRefreshDiff={act.refreshDiff}
                        onMovePane={act.movePaneAdjacent}
                        onCreatePane={act.createPane}
                        onSetRatio={(_splitPath, _ratio, commit) => {
                            // No wire verb addresses a split whose children are both splits;
                            // the grid still previewed it, so silently keep the daemon's tree.
                            if (commit.paneID === null) return;
                            act.setSplitRatio(commit.paneID, commit.share);
                        }}
                    />
                    {ready ? null : <ConnectionSplash runtime={runtime} state={nex} target={target} />}
                </div>

                <StatusFooter
                    summary={agentSummary}
                    focusedPane={focusedPaneID === null ? null : (paneByID.get(focusedPaneID) ?? null)}
                    bucket={bucket}
                    bucketItems={bucketItems}
                    onSelectPane={onSelectStatusPane}
                />
            </div>

            {ready && ui.connection !== 'connected' ? (
                <ConnectionBanner status={ui.connection} error={ui.connectionError} runtime={runtime} />
            ) : null}

            <CommandPalette
                open={ui.palette.open}
                query={ui.palette.query}
                onQueryChange={(query) => store.getState().setPaletteQuery(query)}
                items={paletteItems}
                onConfirm={onPaletteConfirm}
                onDismiss={() => store.getState().setPaletteOpen(false)}
                onFocusHandoff={onFocusHandoff}
                fallbackPaneID={focusedPaneID}
                bucket={bucket}
            />

            <ToastStack toasts={ui.toasts} onDismiss={(id) => store.getState().dismissToast(id)} />
        </div>
    );
}

// ── connection surfaces ─────────────────────────────────────────────────────────────

const SPLASH_TITLE: Readonly<Record<string, string>> = {
    idle: 'Connecting to nexd…',
    connecting: 'Connecting to nexd…',
    connected: 'Loading workspaces…',
    reconnecting: 'Reconnecting to nexd…',
    closed: 'Disconnected from nexd',
    rejected: 'The daemon refused this connection'
};

const SPLASH_HINT: Readonly<Record<string, string>> = {
    idle: '',
    connecting: '',
    connected: 'the daemon accepted the handshake; waiting for the first state snapshot',
    reconnecting: 'the socket dropped — retrying with backoff',
    closed: 'nothing is listening; start it with `nexd start`',
    rejected: 'check the token (?token=…) and that the client and daemon speak the same protocol version'
};

interface ConnectionSplashProps {
    readonly runtime: NexRuntime;
    readonly state: { readonly ui: { readonly connection: string; readonly connectionError: string | null } };
    readonly target: DaemonTarget;
}

/** Full-cover state for a client that has never had a snapshot: there is nothing to show yet. */
function ConnectionSplash({ runtime, state, target }: ConnectionSplashProps): ReactElement {
    const status = state.ui.connection;
    const retryable = status === 'closed' || status === 'rejected';
    return (
        <div
            data-testid="connection-splash"
            data-status={status}
            className="absolute inset-0 z-30 flex items-center justify-center p-6"
            style={{ background: chromeTokens.windowBackground }}
        >
            <div
                className="flex w-full max-w-sm flex-col items-center gap-2 rounded-lg px-6 py-5 text-center"
                style={{ background: chromeTokens.surfaceBackground, border: `1px solid ${chromeTokens.divider}` }}
            >
                <span className="text-[13px] font-semibold" style={{ color: chromeTokens.textPrimary }}>
                    {SPLASH_TITLE[status] ?? 'Connecting…'}
                </span>
                <span className="font-mono text-[11px]" style={{ color: chromeTokens.textTertiary }}>
                    {describeTarget(target)}
                </span>
                {state.ui.connectionError === null ? null : (
                    <span data-testid="connection-error" className="text-[11px]" style={{ color: '#E0655C' }}>
                        {state.ui.connectionError}
                    </span>
                )}
                <span className="text-[11px]" style={{ color: chromeTokens.textSecondary }}>
                    {SPLASH_HINT[status] ?? ''}
                </span>
                {retryable ? (
                    <button
                        type="button"
                        data-testid="connection-retry"
                        className="mt-1 rounded px-3 py-1 text-[12px]"
                        style={{
                            background: chromeTokens.headerBackground,
                            color: chromeTokens.textPrimary,
                            border: `1px solid ${chromeTokens.divider}`
                        }}
                        onClick={() => runtime.connect()}
                    >
                        Try again
                    </button>
                ) : null}
            </div>
        </div>
    );
}

interface ConnectionBannerProps {
    readonly status: string;
    readonly error: string | null;
    readonly runtime: NexRuntime;
}

/** The mirror is still on screen (and still true as of the drop); this says it may be stale. */
function ConnectionBanner({ status, error, runtime }: ConnectionBannerProps): ReactElement {
    const dead = status === 'closed' || status === 'rejected';
    return (
        <div
            data-testid="connection-banner"
            data-status={status}
            role="status"
            className="pointer-events-auto absolute left-1/2 top-2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full px-3 py-1 text-[11px]"
            style={{
                background: chromeTokens.surfaceBackground,
                border: `1px solid ${chromeTokens.divider}`,
                color: chromeTokens.textSecondary,
                boxShadow: '0 6px 20px rgba(0,0,0,0.3)'
            }}
        >
            <span
                aria-hidden
                className="h-[7px] w-[7px] rounded-full"
                style={{ background: dead ? '#E0655C' : chromeTokens.activeAgent }}
            />
            <span>{dead ? 'Disconnected — the view may be stale' : 'Reconnecting…'}</span>
            {error === null ? null : <span style={{ color: chromeTokens.textTertiary }}>{error}</span>}
            {dead ? (
                <button
                    type="button"
                    className="underline"
                    style={{ color: chromeTokens.textPrimary }}
                    onClick={() => runtime.connect()}
                >
                    retry
                </button>
            ) : null}
        </div>
    );
}

interface ToastStackProps {
    readonly toasts: readonly Toast[];
    readonly onDismiss: (id: string) => void;
}

/** The in-app fallback for a notification the browser would not (or could not) show. */
function ToastStack({ toasts, onDismiss }: ToastStackProps): ReactElement | null {
    if (toasts.length === 0) return null;
    return (
        <div data-testid="toast-stack" className="absolute bottom-8 right-3 z-40 flex flex-col gap-2">
            {toasts.map((toast) => (
                <button
                    key={toast.id}
                    type="button"
                    data-testid={`toast-${toast.id}`}
                    className="max-w-[320px] rounded-md px-3 py-2 text-left"
                    style={{
                        background: chromeTokens.surfaceBackground,
                        border: `1px solid ${chromeTokens.divider}`,
                        boxShadow: '0 8px 24px rgba(0,0,0,0.35)'
                    }}
                    onClick={() => onDismiss(toast.id)}
                >
                    <span className="block text-[12px] font-medium" style={{ color: chromeTokens.textPrimary }}>
                        {toast.title}
                    </span>
                    <span className="block text-[11px]" style={{ color: chromeTokens.textSecondary }}>
                        {toast.body}
                    </span>
                </button>
            ))}
        </div>
    );
}

// ── helpers ─────────────────────────────────────────────────────────────────────────

const EMPTY_PANES: readonly Pane[] = [];
const EMPTY_IDS: readonly string[] = [];
const EMPTY_LAYOUT = { kind: 'empty' } as const;

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

function paletteCommand(
    id: string,
    icon: string,
    title: string,
    subtitle: string,
    action: () => void
): PaletteItem {
    return {
        id,
        kind: 'command',
        icon,
        title,
        subtitle,
        workspaceID: null,
        workspaceName: '',
        paneID: null,
        workspaceColor: null,
        run: action
    };
}

/** The active tab's URL for a web pane; the daemon keeps it beside the pane record. */
function webPaneURL(workspace: WorkspaceState | null, paneID: string): string | null {
    const web = workspace?.webPanes[paneID];
    if (web === undefined) return null;
    const active = web.tabs.find((tab) => tab.id === web.activeTabID) ?? web.tabs[0];
    return active?.url ?? null;
}

/** agent-lifecycle.md §9.3 buckets, over every workspace's visible panes. */
function statusItems(workspaces: readonly WorkspaceState[], bucket: AgentBucket): readonly StatusBarItem[] {
    const items: StatusBarItem[] = [];
    for (const workspace of workspaces) {
        for (const pane of workspace.panes) {
            const matches =
                bucket === 'running'
                    ? pane.status === 'running'
                    : bucket === 'waiting'
                      ? pane.status === 'waitingForInput'
                      : pane.status === 'idle' && pane.agentSessionID !== null;
            if (!matches) continue;
            items.push({
                paneID: pane.id,
                workspaceID: workspace.id,
                workspaceName: workspace.name,
                workspaceColor: workspace.color,
                paneTitle: pane.label ?? pane.title ?? pane.workingDirectory,
                status: pane.status,
                agentStartedAt: pane.agentStartedAt
            });
        }
    }
    return items;
}

/**
 * Hand the caret back to a terminal after an overlay closes. The renderer owns whatever is
 * actually focusable inside the host (a textarea for both engines today), so this asks the DOM
 * rather than the engine — the engine seam deliberately exposes no such handle.
 */
function focusTerminalElement(paneID: string): void {
    if (typeof document === 'undefined') return;
    const host = document.querySelector<HTMLElement>(`[data-pane-id="${paneID}"] [data-terminal-host]`);
    if (host === null) return;
    const focusable = host.querySelector<HTMLElement>('textarea, canvas[tabindex], [tabindex]') ?? host;
    focusable.focus?.();
}
