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
 * `ContentClient`. A **web pane** is the one body this client cannot draw: it renders the
 * browser chrome and reports where it left the page-area hole, and the Electron shell moves a
 * real `WebContentsView` there (`webpane/`). In any other client the same hole holds an "open in
 * the app" card — the pane is real daemon state either way.
 */

import type { NexAction } from '@nex/core/config';
import { PREDEFINED_LAYOUT_ORDER, type DropZone, type SplitDirection } from '@nex/core/layout';
import type { JsonObject } from '@nex/protocol';
import {
    layoutPaneOrder,
    syncedPaneIDs,
    type Pane,
    type PredefinedLayoutKind,
    type WorkspaceState
} from '@nex/daemon/store';
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type ReactElement
} from 'react';
import { useStore } from 'zustand';

import { ContentPanePlaceholder } from './app/ContentPanePlaceholder';
import { describeTarget, type DaemonTarget } from './app/config';
import {
    CommandPalette,
    Sidebar,
    StatusFooter,
    ThemeProvider,
    TopBar,
    actionForTrigger,
    buildPaletteItems,
    clientKeyBindings,
    createFaviconController,
    createKeyDispatcher,
    normalizeHexColor,
    installKeyDispatcher,
    shortcutForAction,
    triggerFromEvent,
    tokens as chromeTokens,
    useChromeTheme,
    withAlpha,
    workspaceSwitchHandlers,
    type AgentBucket,
    type FaviconController,
    type KeyActionRegistry,
    type PaletteItem,
    type StatusBarItem
} from './chrome';
import { isOkReply, replyError, replyText, type CommandReply } from './connection';
import { DiffPane, MarkdownPane, ScratchpadPane, createContentClient, type FontSizeStep } from './content';
import { PaneGrid, type PaneModel, type RenderPane } from './grid';
import { SettingsOverlay, type SettingsActions, type SettingsTabID } from './settings';
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
    terminalFontStack,
    visiblePaneIDs,
    type TerminalGeometry,
    type TerminalRendererFactory,
    type TerminalTheme
} from './terminal';
import {
    WebPane,
    createGeometryReporter,
    createWebPaneCommands,
    parseRevealMessage,
    readShellWindowID,
    revealAppliesHere,
    type WebPaneTab
} from './webpane';

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

/**
 * The root provider reads ONE thing from the store: the daemon's synced settings.
 *
 * Light vs dark is the ghostty background's luminance, not the OS scheme (content-panes.md
 * port note 9) — the daemon computes `isDark` from the same color it renders markdown and
 * diff HTML against, so chrome, content panes and terminals cannot disagree. Until settings
 * arrive (an older daemon, or the moment before `welcome`) the OS probe stands in, which is
 * what the client did before M8.
 *
 * `--nex-term-bg` is overridden here with the ghostty background AT THE GHOSTTY OPACITY:
 * every pane fill in the tree (terminal, markdown, diff, scratchpad, the placeholder cards)
 * already resolves that variable, so one assignment tints all of them (§3.8).
 */
export function App(props: AppProps): ReactElement {
    const settings = useStore(props.runtime.store, (state) => state.settings);
    const appearance = settings.value.appearance;
    const paneFill = useMemo(
        () => withAlpha(appearance.backgroundColor, appearance.backgroundOpacity),
        [appearance.backgroundColor, appearance.backgroundOpacity]
    );
    const style = useMemo(
        () => (settings.loaded ? ({ '--nex-term-bg': paneFill } as CSSProperties) : undefined),
        [settings.loaded, paneFill]
    );

    return (
        <ThemeProvider
            appearance={settings.loaded ? (appearance.isDark ? 'dark' : 'light') : 'system'}
            applyToDocument
            className="contents"
            {...(style !== undefined ? { style } : {})}
        >
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
    const settings = nex.settings.value;

    const [sidebarVisible, setSidebarVisible] = useState(true);
    const [terminalTheme, setTerminalTheme] = useState<TerminalTheme | undefined>(undefined);
    /**
     * Two pieces of purely client-local UI state that only assembly can own:
     *   - which content pane was last asked to open its find bar, and how many times (the pane
     *     re-opens on every bump, so ⌘F twice on the same pane still works);
     *   - the workspace THIS client just created, scrolled into view once (§15).
     */
    const [findRequest, setFindRequest] = useState<{ paneID: string; seq: number } | null>(null);
    const [scrollToWorkspaceID, setScrollToWorkspaceID] = useState<string | null>(null);
    /**
     * The Settings window (M8): open flag + which tab, so a deep link ("Manage labels…") can
     * name one. It is client-local UI state like the sidebar's visibility — the daemon owns the
     * SETTINGS, not the window showing them.
     */
    const [settingsTab, setSettingsTab] = useState<SettingsTabID | null>(null);
    /** Pending §8.5 focus hand-offs, cleared on unmount so none fires into a dead tree. */
    const revealTimers = useRef(new Set<ReturnType<typeof setTimeout>>());

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

    // ── web panes ───────────────────────────────────────────────────────────────────

    /**
     * Whether this client IS the page inside a Nex shell window (`?shellWindow=`). It decides
     * two things: whether web panes get real pixels (the shell moves a native view into the
     * hole the chrome leaves) and whether a reveal aimed at that window is ours to act on.
     * Read once — the marker cannot change without a reload.
     */
    const shellWindowID = useMemo(() => readShellWindowID(), []);
    /**
     * One reporter for the whole client: it dedupes and throttles per pane, so a divider drag
     * across a workspace full of web panes is a handful of frames rather than one per render.
     */
    const webGeometry = useMemo(
        () =>
            createGeometryReporter({
                send: (report) => {
                    runtime.connection.send({
                        type: 'web-geometry-report',
                        paneID: report.paneID,
                        ...(report.tabID === undefined || report.tabID === null
                            ? {}
                            : { tabID: report.tabID }),
                        rect: report.rect,
                        visible: report.visible,
                        devicePixelRatio: report.devicePixelRatio,
                        // The claim the daemon matches against the host's own window id.
                        ...(shellWindowID === null ? {} : { shellWindowID })
                    });
                }
            }),
        [runtime, shellWindowID]
    );
    useEffect(() => () => webGeometry.dispose(), [webGeometry]);

    /**
     * A clicked desktop notification, arriving the long way round: shell → daemon → every
     * client. §8.5's ordering is the reason it is done here rather than in the shell — activate
     * the workspace first, focus the pane LAST (a tick later, after the window has restored its
     * own focus, or the restoration re-selects the pane the user came from).
     */
    useEffect(() => {
        const timers = revealTimers.current;
        const off = runtime.connection.on('message', (message) => {
            const target = parseRevealMessage(message);
            if (target === null || !revealAppliesHere(target, shellWindowID)) return;
            runtime.activateWorkspace(target.workspaceID);
            const timer = setTimeout(() => {
                timers.delete(timer);
                runtime.focusPane(target.workspaceID, target.paneID);
                focusTerminalElement(target.paneID);
            }, 0);
            timers.add(timer);
        });
        return () => {
            off();
            for (const timer of timers) clearTimeout(timer);
            timers.clear();
        };
    }, [runtime, shellWindowID]);

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

    /**
     * The web-pane chrome's verbs, routed through `run` so a refusal (`no web pane host
     * connected` when the desktop app is not there, a tab ref the daemon rejects) surfaces as
     * the same error toast every other command uses — and never as an unhandled rejection,
     * since the buttons deliberately do not await their acks (they are optimistic by design,
     * web-pane.md §17.4).
     */
    const webCommands = useMemo(
        () =>
            createWebPaneCommands({
                raw: (payload) => {
                    const promise = commands.raw(payload);
                    run(webCommandLabel(payload), promise);
                    return promise;
                }
            }),
        [commands, run]
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

        /**
         * §15's one-shot "scroll the new entry into view". The reply carries the id, so this
         * client knows the row is ITS doing — a `workspace-created` delta caused by another
         * client (or by the CLI) must not move this one's viewport.
         */
        const runCreateWorkspace = (promise: Promise<CommandReply>): true => {
            void promise.then(
                (reply) => {
                    if (!isOkReply(reply)) {
                        notifyFailure('New workspace', replyError(reply));
                        return;
                    }
                    const created = replyText(reply, 'workspace_id');
                    if (created !== undefined) setScrollToWorkspaceID(created);
                },
                (error: unknown) => {
                    notifyFailure('New workspace', error instanceof Error ? error.message : String(error));
                }
            );
            return true;
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

            /**
             * §3.16 — the header's +/- buttons and ⌘= / ⌘- / ⌘0. Only a markdown pane in VIEW
             * mode has a preview font size, so anything else declines and the keystroke falls
             * through to the pane (the same conditional-binding rule ⌘E follows).
             */
            setFontSize(paneID: string, step: FontSizeStep): boolean {
                const pane = selectPane(store.getState(), paneID);
                if (pane === null || pane.type !== 'markdown' || pane.isEditing) return false;
                return runTask('Font size', content.setFontSize(paneID, step));
            },

            setFontSizeFocused(step: FontSizeStep): boolean {
                const paneID = focused();
                if (paneID === null) return false;
                const pane = selectPane(store.getState(), paneID);
                if (pane === null || pane.type !== 'markdown' || pane.isEditing) return false;
                return runTask('Font size', content.setFontSize(paneID, step));
            },

            /**
             * §3.13 — ⌘F over a content pane opens ITS find bar. The needle, the marks and the
             * counts are per client (they live in the pane's iframe and its host component), so
             * this only nudges the pane that has focus; a terminal pane declines and the
             * binding falls through to whatever the terminal search will be.
             */
            openFind(): boolean {
                const paneID = focused();
                if (paneID === null) return false;
                const pane = selectPane(store.getState(), paneID);
                if (pane === null || (pane.type !== 'markdown' && pane.type !== 'diff')) return false;
                setFindRequest((current) =>
                    current?.paneID === paneID ? { paneID, seq: current.seq + 1 } : { paneID, seq: 1 }
                );
                return true;
            },

            /**
             * The 600 ms focus-dwell acknowledgment (agent-lifecycle.md §5.8). The grid runs the
             * timer (it knows which pane this client shows); the daemon owns the mutation, so a
             * cleared status reaches every other client as a delta.
             */
            dwellClear(paneID: string): boolean {
                return run('Clear pane status', commands.clearPaneStatus({ paneID }));
            },

            /** The header's restart button: the daemon types the pane's resume command. */
            restartAgent(paneID: string): boolean {
                return run('Restart agent', commands.restartPaneAgent({ paneID }));
            },

            newWorkspace(): boolean {
                return runCreateWorkspace(commands.createWorkspace({}));
            },

            createWorkspace(name: string, groupID: string | null): boolean {
                const trimmed = name.trim();
                return runCreateWorkspace(
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

            /** A multi-row drag: ONE atomic bulk move, never N `workspace-move`s (§5.5). */
            moveWorkspaces(request: {
                workspaceIDs: readonly string[];
                groupID: string | null;
                index: number;
            }): boolean {
                return run(
                    'Move workspaces',
                    commands.moveWorkspaces({
                        workspaceIDs: request.workspaceIDs,
                        groupID: request.groupID,
                        index: request.index
                    })
                );
            },

            /** "Change Icon" (§5.6). `icon` is the flat DB token; `null` resets to the letter. */
            setWorkspaceIcon(workspaceID: string, icon: string | null): boolean {
                return run('Change icon', commands.setWorkspaceIcon({ workspaceID, icon }));
            },

            setGroupIcon(groupID: string, icon: string | null): boolean {
                return run('Change icon', commands.setGroupIcon({ groupID, icon }));
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

    // The ghostty background overrides whatever the chrome palette says, and it must stay an
    // opaque hex: ghostty-web's parser maps `rgba()` (and every other non-hex form) to BLACK.
    // The pane container behind the canvas gets the alpha instead — `paneFill` below — which
    // is exactly the Swift split (renderer takes the color, container takes the opacity, §3.8).
    const paneTheme = useMemo<TerminalTheme | undefined>(() => {
        const background = normalizeHexColor(settings.appearance.backgroundColor);
        if (background === null) return terminalTheme;
        return { ...(terminalTheme ?? {}), background };
    }, [terminalTheme, settings.appearance.backgroundColor]);

    const paneFill = useMemo(
        () => withAlpha(settings.appearance.backgroundColor, settings.appearance.backgroundOpacity),
        [settings.appearance.backgroundColor, settings.appearance.backgroundOpacity]
    );

    // Memoized so `renderPane`'s dependency list only changes when the FONT changes: the
    // engines take a font at construction, so a new object here would rebuild every engine.
    //
    // The user's ghostty `font-family` is the HEAD of a stack, never the whole of it: whatever
    // it is missing — Powerline separators, Nerd Font icons — has to come from the bundled
    // face rather than from tofu, which is exactly what libghostty did for the Swift app
    // (`terminal/fonts.ts`).
    const terminalFont = useMemo(
        () => ({
            fontFamily: terminalFontStack(settings.appearance.fontFamily),
            fontSize: settings.appearance.fontSize
        }),
        [settings.appearance.fontFamily, settings.appearance.fontSize]
    );

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

    // ── settings window ─────────────────────────────────────────────────────────────

    /**
     * The Settings verbs, bound once. Every one of them WRITES A FILE (or, for the label
     * presets, the daemon's database) and comes back as a broadcast the store applies — so
     * nothing here echoes optimistically, and a failure is the same toast every other command
     * raises rather than a form that silently did nothing.
     */
    const settingsActions = useMemo<SettingsActions>(
        () => ({
            setKeybinding: (action, trigger) =>
                void run('Set keybinding', commands.setKeybinding({ action, trigger })),
            resetKeybindings: (action) => void run('Reset keybindings', commands.resetKeybindings({ action })),
            setGeneralSetting: (key, value) => void run('Change setting', commands.setGeneralSetting({ key, value })),
            setProfiles: (profiles) => void run('Save profiles', commands.setProfiles({ profiles })),
            addLabelPreset: (input) => void run('Add label preset', commands.addLabelPreset(input)),
            updateLabelPreset: (input) => void run('Update label preset', commands.updateLabelPreset(input)),
            removeLabelPreset: (id) => void run('Delete label preset', commands.removeLabelPreset({ id }))
        }),
        [commands, run]
    );

    const openSettings = useCallback((tab: SettingsTabID = 'keybindings'): void => {
        setSettingsTab(tab);
    }, []);

    /**
     * Closing hands the keyboard back to the pane the user came from — the same choreography
     * the palette follows (§10.4). Without it the window is left with focus on a button that
     * no longer exists, and the next keystroke goes nowhere.
     */
    const closeSettings = useCallback((): void => {
        setSettingsTab(null);
        const paneID = selectFocusedPaneID(store.getState());
        if (paneID !== null) focusTerminalElement(paneID);
    }, [store]);

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
            // §3.16: same conditional shape — markdown, and not editing, or fall through.
            increase_markdown_font_size: () => act.setFontSizeFocused('increase'),
            decrease_markdown_font_size: () => act.setFontSizeFocused('decrease'),
            reset_markdown_font_size: () => act.setFontSizeFocused('reset'),
            // §3.13: ⌘F over a markdown/diff pane opens that pane's find bar.
            toggle_search: () => act.openFind(),
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

    /** Read inside the dispatcher's predicates, which are built once and must not go stale. */
    const settingsOpenRef = useRef(settingsTab !== null);
    settingsOpenRef.current = settingsTab !== null;

    // The dispatcher is rebuilt whenever the daemon's `keybind` lines change: `clientKeyBindings`
    // is the seam, `@nex/core/config` resolves the same overrides the daemon parsed, and the
    // store only mints a new settings object on a REAL change — so a `settings-changed` that
    // touched only the appearance does not re-install the listener.
    const keybindLines = settings.keybindLines;
    useEffect(() => {
        const bindings = clientKeyBindings(keybindLines);
        const dispatcher = createKeyDispatcher({
            bindings,
            actions: () => keyActionsRef.current,
            // §7.2 step 1's rule, applied to the Settings window for the same reason: while a
            // modal overlay is up every keystroke belongs to IT — a ⌘D behind the sheet must not
            // split a pane, and the key recorder needs to see combos the map would have eaten.
            isPaletteOpen: () => store.getState().ui.palette.open || settingsOpenRef.current,
            hasActiveWorkspace: () => selectActiveWorkspace(store.getState()) !== null
        });
        return installKeyDispatcher(window, dispatcher);
    }, [store, keybindLines]);

    /**
     * ⌘, opens Settings — the platform convention, and NOT a `NexAction`: the Swift app reaches
     * it through the OS menu bar (there is no `open_settings` in §4's 51), so inventing one
     * would put a value in the config file the shipped app cannot parse. It therefore lives
     * outside the binding map and, to stay honest about that, yields whenever the user's own map
     * claims ⌘, for something else.
     */
    useEffect(() => {
        const bindings = clientKeyBindings(keybindLines);
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.code !== 'Comma' || !event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
            const trigger = triggerFromEvent(event);
            if (trigger !== null && actionForTrigger(bindings, trigger) !== null) return;
            event.preventDefault();
            setSettingsTab((current) => (current === null ? 'keybindings' : current));
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [keybindLines]);

    // ── palette ─────────────────────────────────────────────────────────────────────

    /**
     * The binding map the chrome shows hints from. It is the SAME map the interceptor resolves,
     * built from the daemon's `keybind` lines, so a rebound ⌘P is reflected in the palette row
     * rather than the hint claiming a shortcut that no longer fires.
     */
    const bindings = useMemo(() => clientKeyBindings(keybindLines), [keybindLines]);
    const hint = useCallback(
        (action: NexAction): string | undefined => shortcutForAction(bindings, action),
        [bindings]
    );

    const paletteCommands = useMemo<PaletteItem[]>(
        () => [
            paletteCommand(
                'cmd:new-pane',
                'terminal',
                'New Pane',
                'split the focused pane right',
                () => act.splitFocused('horizontal'),
                hint('split_right')
            ),
            paletteCommand(
                'cmd:split-down',
                'terminal',
                'Split Down',
                'split the focused pane down',
                () => act.splitFocused('vertical'),
                hint('split_down')
            ),
            paletteCommand(
                'cmd:close-pane',
                'terminal',
                'Close Pane',
                'close the focused pane',
                () => act.closeFocused(),
                hint('close_pane')
            ),
            paletteCommand(
                'cmd:toggle-zoom',
                'rectangle.stack',
                'Toggle Zoom',
                'zoom the focused pane',
                () => act.toggleZoomFocused(),
                hint('toggle_zoom')
            ),
            paletteCommand(
                'cmd:cycle-layout',
                'rectangle.stack',
                'Cycle Layout',
                'next predefined layout',
                () => act.cycleLayout(),
                hint('cycle_layout')
            ),
            paletteCommand(
                'cmd:sync-input',
                'terminal',
                'Toggle Synchronise Input',
                'mirror typing across panes',
                () => act.toggleSyncInput(),
                hint('toggle_sync_input')
            ),
            paletteCommand(
                'cmd:new-workspace',
                'rectangle.stack',
                'New Workspace',
                'create an empty workspace',
                () => act.newWorkspace(),
                hint('new_workspace')
            ),
            // ⌘, is not a bindable action (see the listener above), so the hint is literal.
            paletteCommand(
                'cmd:settings',
                'gearshape',
                'Settings…',
                'keybindings, appearance, labels, profiles',
                () => {
                    openSettings('keybindings');
                },
                '⌘,'
            )
        ],
        [act, hint, openSettings]
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
                        findToken={findRequest?.paneID === paneID ? findRequest.seq : 0}
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
                        findToken={findRequest?.paneID === paneID ? findRequest.seq : 0}
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
            // The one pane whose body this client cannot draw: the page lives in a native view
            // the Electron shell owns. The chrome is ours, the page area is a measured hole
            // (`webpane/WebPane.tsx`), and in a browser that hole holds an honest card.
            if (pane.type === 'web') {
                const web = workspace?.webPanes[paneID];
                return (
                    <WebPane
                        paneID={paneID}
                        tabs={web?.tabs ?? EMPTY_WEB_TABS}
                        activeTabID={web?.activeTabID ?? null}
                        isPrivate={web?.isPrivate ?? false}
                        focused={focused}
                        visible={renderState.visible}
                        embedded={shellWindowID !== null}
                        commands={webCommands}
                        onGeometry={webGeometry.report}
                        onHidden={webGeometry.hide}
                        onFocusRequest={onTerminalFocus}
                    />
                );
            }
            if (pane.type !== 'shell') {
                return <ContentPanePlaceholder pane={pane} />;
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
                    theme={paneTheme}
                    background={paneFill}
                    {...(terminalFont.fontFamily !== null ? { fontFamily: terminalFont.fontFamily } : {})}
                    {...(terminalFont.fontSize !== null ? { fontSize: terminalFont.fontSize } : {})}
                    onFocusRequest={onTerminalFocus}
                    onDimensionsChange={onDimensionsChange}
                    createRenderer={createRenderer}
                />
            );
        },
        [
            act,
            content,
            findRequest,
            paneByID,
            workspace,
            mountedSet,
            runtime,
            paneTheme,
            paneFill,
            terminalFont,
            onTerminalFocus,
            onDimensionsChange,
            createRenderer,
            webCommands,
            webGeometry,
            shellWindowID
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
                    onMoveWorkspaces={act.moveWorkspaces}
                    onSetWorkspaceIcon={act.setWorkspaceIcon}
                    onSetGroupIcon={act.setGroupIcon}
                    onRenameGroup={act.renameGroup}
                    onDeleteGroup={act.deleteGroup}
                    onCreateWorkspace={act.createWorkspace}
                    onCreateGroup={act.createGroup}
                    keyBindings={bindings}
                    scrollToWorkspaceID={scrollToWorkspaceID}
                    onScrollHandled={() => setScrollToWorkspaceID(null)}
                    onOpenSettings={(section) => {
                        openSettings(section === 'labels' ? 'labels' : 'keybindings');
                    }}
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
                        // §10: the daemon's config file drives hover-focus; the grid owns the
                        // cancel-on-re-hover timer semantics.
                        focusFollowsMouse={settings.general.focusFollowsMouse}
                        focusFollowsMouseDelayMs={settings.general.focusFollowsMouseDelay}
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
                        onSetFontSize={act.setFontSize}
                        onRestartAgent={act.restartAgent}
                        onDwellClear={act.dwellClear}
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

            <SettingsOverlay
                open={settingsTab !== null}
                initialTab={settingsTab ?? 'keybindings'}
                settings={settings}
                domain={{ labelPresets: daemon.state.labelPresets, workspaces: daemon.state.workspaces }}
                actions={settingsActions}
                bucket={bucket}
                onClose={closeSettings}
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
    // A rejection is almost always a missing/stale token, and there is exactly one command that
    // produces a working link — so name it rather than describing the problem in the abstract.
    rejected: 'open this page from `nexd url`, which includes the daemon token'
};

interface ConnectionSplashProps {
    readonly runtime: NexRuntime;
    readonly state: { readonly ui: { readonly connection: string; readonly connectionError: string | null } };
    readonly target: DaemonTarget;
}

/** Full-cover state for a client that has never had a snapshot: there is nothing to show yet. */
function ConnectionSplash({ runtime, state, target }: ConnectionSplashProps): ReactElement {
    const status = state.ui.connection;
    const rejected = status === 'rejected';
    const retryable = status === 'closed' || rejected;
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
                    <span
                        data-testid="connection-error"
                        /* A refusal is the whole message when the daemon has said why: it gets
                           the body text, not a footnote's size, so "invalid or missing daemon
                           token" is the first thing read rather than something to squint at. */
                        className={rejected ? 'text-[13px] font-medium' : 'text-[11px]'}
                        style={{ color: '#E0655C' }}
                    >
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
    const rejected = status === 'rejected';
    const dead = status === 'closed' || rejected;
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
            <span>
                {rejected
                    ? 'The daemon refused this connection'
                    : dead
                      ? 'Disconnected — the view may be stale'
                      : 'Reconnecting…'}
            </span>
            {error === null ? null : (
                // A refusal's text is the actionable part ("open the client via `nexd url`"),
                // so it is not dimmed into a footnote the way a transient socket error is.
                <span data-testid="connection-banner-error" style={{ color: rejected ? '#E0655C' : chromeTokens.textTertiary }}>
                    {error}
                </span>
            )}
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
                    {/* `break-words`: a body carrying a filesystem path or a URL is one
                        unbreakable token whose min-content width blows straight through
                        `max-w-[320px]`, pushing the toast off the right edge of the window. */}
                    <span
                        className="block break-words text-[11px]"
                        style={{ color: chromeTokens.textSecondary }}
                    >
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
/** A web pane whose sidecar has not arrived yet renders its (empty) chrome, not nothing. */
const EMPTY_WEB_TABS: readonly WebPaneTab[] = [];

/** Toast titles for the web verbs: the wire name without its `web-` prefix, sentence-cased. */
function webCommandLabel(payload: JsonObject): string {
    const command = typeof payload['command'] === 'string' ? payload['command'] : 'web';
    const words = command.replace(/^web-/, '').replace(/-/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

function paletteCommand(
    id: string,
    icon: string,
    title: string,
    subtitle: string,
    action: () => void,
    shortcut?: string | undefined
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
        run: action,
        ...(shortcut === undefined ? {} : { shortcut })
    };
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
