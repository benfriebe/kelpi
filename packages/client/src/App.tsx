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

import { parseKeyTrigger, type KelpiAction } from '@kelpi/core/config';
import { PREDEFINED_LAYOUT_ORDER, type DropZone, type SplitDirection } from '@kelpi/core/layout';
import type { JsonObject } from '@kelpi/protocol';
import {
    activeAgentCount,
    layoutPaneOrder,
    syncedPaneIDs,
    type Pane,
    type PredefinedLayoutKind,
    type WorkspaceColor,
    type WorkspaceState
} from '@kelpi/daemon/store';
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type DragEvent,
    type MouseEvent as ReactMouseEvent,
    type ReactElement,
    type ReactNode
} from 'react';
import { useStore } from 'zustand';

import { ContentPanePlaceholder } from './app/ContentPanePlaceholder';
import { describeTarget, type DaemonTarget } from './app/config';
import {
    OPEN_PANEL_MESSAGE,
    cellFromPoint,
    dragCarriesFile,
    dropDecision,
    terminalDropText
} from './app/open-file';
import {
    ChromeIcon,
    CommandPalette,
    ContextMenu,
    DEFAULT_PROFILE_NAME,
    HelpOverlay,
    INSPECTOR_WIDTH_PX,
    Inspector,
    QuitGate,
    Sidebar,
    SidebarResizer,
    StatusFooter,
    ThemeProvider,
    TopBar,
    menuAnchorFromEvent,
    readStoredSidebarWidth,
    storeSidebarWidth,
    actionForTrigger,
    buildPaletteItems,
    clientKeyBindings,
    createFaviconController,
    createKeyDispatcher,
    defaultGroupName,
    flattenOver,
    hoverFill,
    isSidebarMounted,
    normalizeHexColor,
    presetChromeTheme,
    sidebarPhaseAfterSettle,
    sidebarPhaseFor,
    sidebarSettleDelayMs,
    sidebarSlideStyle,
    sidebarTintCssVars,
    installKeyDispatcher,
    shortcutForAction,
    triggerFromEvent,
    tokens as chromeTokens,
    useAnyModalOpen,
    useChromeTheme,
    useHoverKey,
    useModalPresence,
    withAlpha,
    workspaceSwitchHandlers,
    type AgentBucket,
    type ChromeAppearance,
    type FaviconController,
    type KeyActionRegistry,
    type MenuItemSpec,
    type PaletteItem,
    type SidebarPhase,
    type SidebarSelectionCommands,
    type StatusBarItem,
    type SystemStatsView,
    type WorkspaceWorktreeRequest
} from './chrome';
import {
    COMMAND_PALETTE_COMMAND,
    DESELECT_ALL_WORKSPACES_COMMAND,
    NEW_GROUP_COMMAND,
    NEW_WEB_PANE_COMMAND,
    SELECT_ALL_WORKSPACES_COMMAND,
    switchWorkspacePosition,
    workspaceSelectionReport
} from './app/file-menu';
import { useGraft } from './app/graft';
import { useInspectorData } from './app/inspector';
import { focusPaneSurface, releaseFocusedPaneCaret } from './app/pane-focus';
import { useRemoteDaemons } from './app/remote-daemons';
import { RemoteDaemonSections, type RemoteSelection } from './app/RemoteDaemonSections';
import { RemoteWorkspaceView } from './app/RemoteWorkspaceView';
import { createSearchNeedleScheduler, type SearchNeedleScheduler } from './app/search-needle';
import {
    SEED_TEST_GROUP_COMMAND,
    consumeSuppressedReveal,
    seedTestGroup,
    suppressReveal
} from './app/seed-test-group';
import {
    CLOSE_PANE_CHORD_COMMAND,
    createShellCloseBridge,
    installShellCloseBridge
} from './app/shell-close';
import {
    isOkReply,
    replyError,
    replySearchMatch,
    replyText,
    type CommandReply
} from './connection';
import {
    DiffPane,
    MarkdownPane,
    ScratchpadPane,
    chordKeysForBindings,
    createContentClient,
    type FontSizeStep
} from './content';
import { PaneGrid, PaneSearchOverlay, paneDisplayTitle, type PaneModel, type RenderPane } from './grid';
import {
    DEFAULT_SETTINGS_TAB,
    SettingsOverlay,
    globalHotkeyErrorFrom,
    type SettingsActions,
    type SettingsTabID
} from './settings';
import {
    isAppActive,
    selectActiveWorkspace,
    selectActiveWorkspaceID,
    selectAgentSummary,
    selectFilteredSidebarEntries,
    selectFocusedPaneID,
    selectGroupForWorkspace,
    selectPane,
    selectVisibleWorkspaceIDs,
    recentlyClosedCount,
    type KelpiRuntime,
    type Toast
} from './state';
import {
    TerminalPane,
    createMountPolicy,
    mergeTerminalPalette,
    resolveTerminalTheme,
    terminalFontStack,
    terminalPaletteCssVars,
    terminalThemePreset,
    visiblePaneIDs,
    type TerminalGeometry,
    type TerminalRendererFactory,
    type TerminalTheme
} from './terminal';
import {
    WebPane,
    batchDestinations,
    chromeTextIsFocused,
    replayChordCommand,
    createWebPanePriority,
    navStateKey,
    useBlankWebPaneURLFocus,
    useWebPaneUI,
    type BlankURLTarget,
    type FocusedWebPane,
    type WebUIConnection,
    createGeometryReporter,
    createWebPaneCommands,
    parseRevealMessage,
    parseViewFocusMessage,
    readShellWindowID,
    readTrafficLightInset,
    readWindowTransparent,
    revealAppliesHere,
    viewFocusAppliesHere,
    type WebPaneTab
} from './webpane';

/** `@kelpi/core/layout`'s geometric drop zones → the wire's `pane-move-adjacent` vocabulary. */
const WIRE_DROP_ZONE: Readonly<Record<DropZone, 'above' | 'below' | 'left-of' | 'right-of'>> = {
    top: 'above',
    bottom: 'below',
    left: 'left-of',
    right: 'right-of'
};

/** Command-error toasts clear themselves; a failed command is news, not a permanent banner. */
const ERROR_TOAST_MS = 6000;

let errorSequence = 0;

/** A plain JSON object (used to read the shell's `menu-command` relay defensively). */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** §WS-151: the "nothing is selected" report, hoisted so the mount-time one is not a new Set. */
const EMPTY_WORKSPACE_SELECTION: ReadonlySet<string> = new Set<string>();

export interface AppProps {
    readonly runtime: KelpiRuntime;
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
 * `--kelpi-term-bg` is overridden here with the ghostty background AT THE GHOSTTY OPACITY:
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
    const chromeSettings = settings.value.chrome;
    const style = useMemo(() => {
        if (!settings.loaded) return undefined;
        return {
            '--kelpi-term-bg': paneFill,
            /*
             * §APP-014: the resolved `theme = <name>` palette, as the terminal tokens.
             *
             * `TERMINAL_TOKEN_NAMES` documents these variables as the seam that "unifies the
             * palette" for everything that reads a terminal colour out of CSS; the light/dark
             * preset defines them in `styles.css` and this overlays the theme's own values on
             * top — which is the same layering the engines get through `setTheme` below, so a
             * canvas and the CSS around it cannot disagree. `--kelpi-term-bg` is NOT among them
             * (see `terminalPaletteCssVars`): the pane fill is the background at the ghostty
             * OPACITY, and the theme reaches it daemon-side instead.
             */
            ...terminalPaletteCssVars(appearance.terminalTheme.palette),
            // SET-037/038's sidebar tint knobs. They ride here as CSS variables rather than as
            // props for the reason `sidebarTintCssVars` documents: the three places that read
            // them are deep inside `Sidebar.tsx`, and one assignment on this container reaches
            // all of them without anything in between learning a new prop.
            ...sidebarTintCssVars(
                {
                    intensity: chromeSettings.sidebarColorIntensity,
                    avatarFill: chromeSettings.sidebarAvatarFill,
                    avatarStroke: chromeSettings.sidebarAvatarStroke,
                    groupFill: chromeSettings.sidebarGroupFill,
                    groupStroke: chromeSettings.sidebarGroupStroke
                },
                presetChromeTheme(appearance.isDark ? 'dark' : 'light')
            )
        } as CSSProperties;
    }, [settings.loaded, paneFill, chromeSettings, appearance.isDark, appearance.terminalTheme]);
    /**
     * SET-031: the chrome's light/dark is now a **user preference** (`chrome-appearance`), not
     * a derivation. `'system'` — the shipped default — keeps exactly the behaviour this client
     * has always had: the ghostty background's luminance decides, so chrome, content panes and
     * terminals agree by construction (content-panes.md port note 9). Choosing Light or Dark
     * overrides that for the CHROME only; the terminal palette is untouched, which is the
     * independence §2 promises and SET-031 states outright.
     */
    const chromeAppearance = useMemo<ChromeAppearance>(() => {
        if (!settings.loaded) return 'system';
        if (chromeSettings.appearance !== 'system') return chromeSettings.appearance;
        return appearance.isDark ? 'dark' : 'light';
    }, [settings.loaded, chromeSettings.appearance, appearance.isDark]);

    /**
     * APP-012 / SET-049 — the window fill follows the ghostty opacity, but ONLY inside a shell
     * window the Electron main process actually created transparent (`?windowTransparent=1`).
     * In a browser tab the same rgba would composite over the page's white canvas and wash the
     * chrome out, so a browser keeps the opaque fill it has always had.
     */
    const windowOpacity =
        readWindowTransparent() && settings.loaded ? appearance.backgroundOpacity : 1;

    return (
        <ThemeProvider
            appearance={chromeAppearance}
            // SET-032/033: `"<bucket>:<key>" → "RRGGBB"`, resolved per bucket by
            // `resolveChromeTheme`. An empty map leaves the shipped preset untouched.
            overrides={chromeSettings.colors}
            windowOpacity={windowOpacity}
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
    const { bucket, theme: chromeTheme } = useChromeTheme();

    const kelpi = useStore(store);
    const daemon = kelpi.daemon;
    /** The DAEMON's home, for `~/…` abbreviation (§APP-069) and §TERM-036's accessible name. */
    const daemonHome = daemon.info?.home ?? '';
    const ui = kelpi.ui;
    const settings = kelpi.settings.value;
    /** §SET-200/§SET-201: the shell's last global-hotkey registration outcome, or null. */
    const hotkeyStatus = kelpi.settings.hotkeyStatus;

    /**
     * §1.7 multi-daemon groups: one live runtime per configured `remote-daemon`, and which
     * remote workspace (if any) the workspace area is showing. A LOCAL activation clears the
     * selection (`activateWorkspaceAndReveal`); a vanished daemon clears it below.
     */
    const remoteDaemonRuntimes = useRemoteDaemons(settings.remoteDaemons);
    const [remoteSelection, setRemoteSelection] = useState<RemoteSelection | null>(null);
    const remoteSelectionRef = useRef(remoteSelection);
    remoteSelectionRef.current = remoteSelection;
    const activeRemote =
        remoteSelection === null ? null : (remoteDaemonRuntimes.get(remoteSelection.daemon) ?? null);
    useEffect(() => {
        if (remoteSelection !== null && !remoteDaemonRuntimes.has(remoteSelection.daemon)) {
            setRemoteSelection(null);
        }
    }, [remoteSelection, remoteDaemonRuntimes]);

    const [sidebarVisible, setSidebarVisible] = useState(true);
    /**
     * §WS-001: the show/hide SLIDE. `sidebarVisible` is still the one boolean everything writes
     * (the keybinding, the top-bar button, the View menu, every gesture that reveals the sidebar
     * before opening a rename field); `sidebarPhase` is the animation's own state, derived from
     * it by `sidebar-reveal.ts`, and it is what keeps the panel mounted while a close plays out.
     * The two are married by the effect below rather than by every caller.
     */
    const [sidebarPhase, setSidebarPhase] = useState<SidebarPhase>(() => (sidebarVisible ? 'open' : 'hidden'));
    /**
     * §WS-002 / §APP-065: the sidebar's width is client-local UI state (the shipped app keeps it
     * in a view-local `@State`), clamped to 180–300 and remembered across reloads.
     */
    const [sidebarWidth, setSidebarWidth] = useState(() => readStoredSidebarWidth());
    /**
     * True while §WS-002's edge handle is being dragged.
     *
     * §WS-001's slide animates the slot's `width` — the same property this drag writes on every
     * pointer move — so with the transition always attached the edge chases the cursor on a
     * 250 ms ease instead of tracking it. The gesture takes the transition off for its length,
     * which is the split SwiftUI makes too: only the visibility toggle is inside `withAnimation`.
     */
    const [sidebarResizing, setSidebarResizing] = useState(false);
    /** §WS-137: the trailing inspector, opened from the top bar or `toggle_inspector`. */
    const [inspectorVisible, setInspectorVisible] = useState(false);
    /**
     * §APP-066: the inspector's slide, driven by the SAME phase machine as the sidebar's
     * (`sidebar-reveal.ts`). `inspectorVisible` stays the one boolean everything writes; this is
     * the animation's own state, and it is what keeps the panel mounted while a close plays out.
     */
    const [inspectorPhase, setInspectorPhase] = useState<SidebarPhase>(() =>
        inspectorVisible ? 'open' : 'hidden'
    );
    const [terminalTheme, setTerminalTheme] = useState<TerminalTheme | undefined>(undefined);
    /**
     * Two pieces of purely client-local UI state that only assembly can own:
     *   - which content pane was last asked to open its find bar, and how many times (the pane
     *     re-opens on every bump, so ⌘F twice on the same pane still works);
     *   - the workspace THIS client just created, scrolled into view once (§15).
     */
    const [findRequest, setFindRequest] = useState<{ paneID: string; seq: number } | null>(null);
    const [scrollToWorkspaceID, setScrollToWorkspaceID] = useState<string | null>(null);
    /** §WS-100's group half: a group this client just created is revealed by its header. */
    const [scrollToGroupID, setScrollToGroupID] = useState<string | null>(null);
    /**
     * §APP-037's second half: the forced `git status` a workspace switch owes.
     *
     * The Swift merges `.refreshGitStatus` into `setActiveWorkspace`'s effects and the palette's
     * confirm sends it inline, so arriving anywhere re-reads git rather than trusting whatever
     * the watcher last knew. Carried as `{ workspaceID, seq }` rather than a bare counter because
     * the mirror's active workspace lags the local activation by a round trip — see
     * `app/inspector.ts` ▸ `forceRefreshFor`, which spends the token only once the named
     * workspace is the one being read.
     */
    const [gitRefreshRequest, setGitRefreshRequest] = useState<{ workspaceID: string; seq: number } | null>(
        null
    );
    /**
     * §WS-100: **every** path that makes a workspace active queues the reveal.
     *
     * The Swift sets `sidebarScrollTarget` inside `setActiveWorkspace` itself, so ⌘1–9,
     * next/previous, a sidebar or filter click, the menu-bar popover, a notification's "Open"
     * and the command palette all inherit it; the port's activation is a bridge call, so the
     * one-shot rides alongside it here and every caller goes through this instead of
     * `runtime.activateWorkspace`. What is deliberately NOT here is the Swift's exclusion list
     * — state restore, deletes and move reflow never call this, exactly as `AppReducer` never
     * sets the target on those paths.
     *
     * §APP-037: the same funnel carries the forced git refresh, for the same reason — the Swift
     * puts it inside `setActiveWorkspace`, so every gesture that lands on a workspace inherits
     * it, the palette's confirm included.
     */
    const activateWorkspaceAndReveal = useCallback(
        (workspaceID: string): void => {
            // §1.7: landing on a LOCAL workspace leaves remote mode; the state setter is
            // identity-stable so the callback's deps are unchanged.
            setRemoteSelection(null);
            runtime.activateWorkspace(workspaceID);
            setScrollToWorkspaceID(workspaceID);
            setGitRefreshRequest((previous) => ({
                workspaceID,
                seq: (previous?.seq ?? 0) + 1
            }));
        },
        [runtime]
    );
    /**
     * §SET-153 / §SET-144: the row the sidebar should open its inline rename field on, set by
     * the `rename_workspace` and `new_group` keybindings (the sidebar owns the field itself).
     * One-shot — the sidebar clears it through `onRenameRequestHandled`.
     */
    const [sidebarRenameRequest, setSidebarRenameRequest] = useState<{
        kind: 'workspace' | 'group';
        id: string;
    } | null>(null);
    /**
     * §APP-018 / §WS-156: "raise the New Workspace sheet", set by ⌘N, by the Electron File ▸ New
     * Workspace row, by the command palette and by the no-workspace empty state's Create button.
     *
     * The shipped app's ⌘N is `showNewWorkspaceSheet()` — a SHEET, not a create — and this is
     * exactly that: `NewEntrySheet`, a modal over the window, the one place the port collects a
     * name, a colour, a group, a profile and repositories in one submit (§WS-075). One-shot; the
     * sidebar clears it through `onCreateRequestHandled`, and it carries a `seq` so pressing ⌘N
     * again after cancelling is a NEW request rather than an unchanged prop the effect ignores.
     */
    const [sidebarCreateRequest, setSidebarCreateRequest] = useState<{
        kind: 'workspace' | 'group';
        groupID: string | null;
        seq: number;
    } | null>(null);
    /**
     * Whether that sheet is on screen. It is a MODAL, so it is a whole-window fact rather than a
     * sidebar one: it joins `modalOpen` (which parks a web pane's native view, since no z-index
     * in this document can get above one) and the key dispatcher's overlay gate (so a ⌘D behind
     * the sheet does not split a pane). The sidebar owns the sheet and reports the transition.
     */
    const [createSheetOpen, setCreateSheetOpen] = useState(false);
    /**
     * Where the terminal search's selected match sits, for the pane whose renderer has to scroll
     * to it. The search itself is DAEMON state (needle, total, selected all ride the workspace's
     * delta stream); this is only the reply's transient "and it is here" — carrying a `seq` so
     * pressing Return on the same match twice scrolls back to it (`TerminalPane`'s reveal effect).
     */
    const [searchReveal, setSearchReveal] = useState<
        { paneID: string; linesFromBottom: number; col: number; length: number; seq: number } | null
    >(null);
    /** Right-click on a pane header: where the menu opened and which pane it acts on. */
    const [paneMenu, setPaneMenu] = useState<{ paneID: string; x: number; y: number } | null>(null);
    /**
     * The ⌘W-on-the-last-pane gate (TERM-077 / WS-109). Closing the last pane deletes the
     * workspace, and the Swift app puts an alert in front of that ONLY when the workspace still
     * has running agents and `confirm-workspace-delete` is on — so this is null in every other
     * case and the delete goes straight out.
     */
    const [closeGate, setCloseGate] = useState<
        { workspaceID: string; name: string; activeAgents: number; allowLast?: boolean } | null
    >(null);
    /**
     * The Settings window (M8): open flag + which tab, so a deep link ("Manage labels…") can
     * name one. It is client-local UI state like the sidebar's visibility — the daemon owns the
     * SETTINGS, not the window showing them.
     */
    const [settingsTab, setSettingsTab] = useState<SettingsTabID | null>(null);
    /**
     * The Help overlay (APP-027 / APP-063). Client-local like Settings: the Swift app opened a
     * second window scene, and a daemon-served UI that also runs in a browser tab has one
     * document, so the same content is a modal in the window it belongs to.
     */
    const [helpOpen, setHelpOpen] = useState(false);
    /** Pending §8.5 focus hand-offs, cleared on unmount so none fires into a dead tree. */
    const revealTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
    /**
     * §APP-028: workspace ids whose next `reveal-pane` this window should ignore, each with a
     * deadline (see `suppressReveal`). Exactly one gesture writes here — Debug ▸ Seed Test Group,
     * which creates workspaces the user did not ask to be taken to.
     */
    const suppressedReveals = useRef(new Map<string, number>());

    // ── §WS-001: the sidebar's show/hide slide ──────────────────────────────────────
    //
    // Two effects, because the animation has two clocks. The first turns a visibility change
    // into a phase; the second is the phase's own settle — one frame for `opening` (the browser
    // needs a paint at the collapsed geometry to transition FROM) and the full slide for
    // `closing` (the panel stays mounted until it has finished travelling).

    useEffect(() => {
        setSidebarPhase((phase) => sidebarPhaseFor(phase, sidebarVisible));
    }, [sidebarVisible]);

    useEffect(() => {
        const delay = sidebarSettleDelayMs(sidebarPhase);
        if (delay === null) return;
        const advance = (): void => setSidebarPhase((phase) => sidebarPhaseAfterSettle(phase));
        // `requestAnimationFrame` for the mount frame — a 0ms timeout can be coalesced into the
        // same paint as the mount, which is precisely the frame the transition needs to see.
        if (delay === 0) {
            if (typeof requestAnimationFrame !== 'function') {
                const immediate = setTimeout(advance, 0);
                return () => clearTimeout(immediate);
            }
            const frame = requestAnimationFrame(() => requestAnimationFrame(advance));
            return () => cancelAnimationFrame(frame);
        }
        const timer = setTimeout(advance, delay);
        return () => clearTimeout(timer);
    }, [sidebarPhase]);

    const sidebarMounted = isSidebarMounted(sidebarPhase);
    const sidebarSlide = sidebarSlideStyle(sidebarPhase, sidebarWidth, !sidebarResizing);

    // ── §APP-066: the INSPECTOR's show/hide slide, the same machine mirrored ─────────
    //
    // §APP-066 is one sentence — "sidebar and inspector show/hide are animated" — and the
    // sidebar half shipped in burn-down 5 while the inspector still appeared and vanished
    // instantly. This is deliberately not a second animation: the same four phases, the same
    // ~0.25s SwiftUI `.default` curve, the same "keep it mounted for the length of a close"
    // rule, differing only in which edge the panel travels off (`edge: 'trailing'`).
    //
    // No resize opt-out is passed, and that is a property of the panel rather than an oversight:
    // the inspector is a FIXED 280px (`INSPECTOR_WIDTH_PX`), so nothing writes the width the
    // slot transitions and there is none of the chase §WS-002's drag had. The parameter exists
    // on `sidebarSlideStyle` for the day it gains an edge handle.

    useEffect(() => {
        setInspectorPhase((phase) => sidebarPhaseFor(phase, inspectorVisible));
    }, [inspectorVisible]);

    useEffect(() => {
        const delay = sidebarSettleDelayMs(inspectorPhase);
        if (delay === null) return;
        const advance = (): void => setInspectorPhase((phase) => sidebarPhaseAfterSettle(phase));
        if (delay === 0) {
            if (typeof requestAnimationFrame !== 'function') {
                const immediate = setTimeout(advance, 0);
                return () => clearTimeout(immediate);
            }
            const frame = requestAnimationFrame(() => requestAnimationFrame(advance));
            return () => cancelAnimationFrame(frame);
        }
        const timer = setTimeout(advance, delay);
        return () => clearTimeout(timer);
    }, [inspectorPhase]);

    const inspectorMounted = isSidebarMounted(inspectorPhase);
    const inspectorSlide = sidebarSlideStyle(inspectorPhase, INSPECTOR_WIDTH_PX, true, 'trailing');

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
     * Whether this client IS the page inside a Kelpi shell window (`?shellWindow=`). It decides
     * two things: whether web panes get real pixels (the shell moves a native view into the
     * hole the chrome leaves) and whether a reveal aimed at that window is ours to act on.
     * Read once — the marker cannot change without a reload.
     */
    const shellWindowID = useMemo(() => readShellWindowID(), []);
    /**
     * §APP-046: how much leading room the title bar must keep clear for the window's traffic
     * lights. The shell says so with `?trafficLightInset=` — like `shellWindow` and
     * `windowTransparent`, it is something only the party that CREATED the window can know. 0 in
     * a browser tab, and on any platform whose frame has no such buttons.
     */
    const trafficLightInset = useMemo(() => readTrafficLightInset(), []);
    /**
     * The same value, reachable from `act` without putting it in that memo's dependency list.
     * It cannot change without a reload, so a ref is the honest expression of that.
     */
    const shellWindowRef = useRef(shellWindowID);
    shellWindowRef.current = shellWindowID;

    /**
     * §WS-151 — tell the shell how many workspaces the sidebar has multi-selected, so File ▸
     * "Deselect All Workspaces" can be greyed exactly as `.disabled(selectedWorkspaceIDs.isEmpty)`
     * greys it in the shipped app.
     *
     * Deduped against the last value SENT rather than debounced: the count only changes on a
     * click, and what matters is that a shift-click over forty rows produces one report rather
     * than forty. It is deliberately not React state — a ⌘-click must not re-render assembly.
     *
     * The 0 on mount is not redundant. A page RELOAD leaves a shell whose menu still carries
     * the last selection this page reported before it went away, and the reloaded page has no
     * selection at all; the socket queues the frame until the handshake settles, so it costs
     * nothing to state it. (`connection.send` is the queue.)
     */
    const reportedSelectionRef = useRef<number | null>(null);
    const reportWorkspaceSelection = useCallback(
        (ids: ReadonlySet<string>): void => {
            const selected = ids.size;
            if (reportedSelectionRef.current === selected) return;
            reportedSelectionRef.current = selected;
            runtime.connection.send(workspaceSelectionReport(selected, shellWindowID));
        },
        [runtime, shellWindowID]
    );
    useEffect(() => {
        reportWorkspaceSelection(EMPTY_WORKSPACE_SELECTION);
    }, [reportWorkspaceSelection]);

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
            // §APP-028: one reveal this window asked the daemon NOT to act on — see
            // `suppressReveal` and the Seed Test Group branch below.
            if (consumeSuppressedReveal(suppressedReveals.current, target.workspaceID)) return;
            // §WS-100: the SOCKET creation paths reach the sidebar here. The daemon reveals
            // every `workspace create` (and every notification "Open") to its clients, and this
            // is the client's `setActiveWorkspace` for that message — so it queues the reveal
            // like the rest, which is what makes `kelpi workspace create` from a terminal scroll
            // the new row into view in an already-scrolled sidebar.
            activateWorkspaceAndReveal(target.workspaceID);
            const timer = setTimeout(() => {
                timers.delete(timer);
                runtime.focusPane(target.workspaceID, target.paneID);
                focusPaneSurface(target.paneID);
            }, 0);
            timers.add(timer);
        });
        return () => {
            off();
            for (const timer of timers) clearTimeout(timer);
            timers.clear();
        };
    }, [activateWorkspaceAndReveal, runtime, shellWindowID]);

    // ── derived reads ───────────────────────────────────────────────────────────────

    const workspace = useMemo(() => selectActiveWorkspace(kelpi), [kelpi]);
    const focusedPaneID = useMemo(() => selectFocusedPaneID(kelpi), [kelpi]);
    const filteredEntries = useMemo(() => selectFilteredSidebarEntries(kelpi), [kelpi]);
    const agentSummary = useMemo(() => selectAgentSummary(kelpi), [kelpi]);
    /**
     * SET-011: the group the New Workspace form preselects when it was not opened scoped to one
     * — the active workspace's, while "Inherit group when creating a new workspace" is on
     * (§WS-076).
     *
     * This is now the ONLY place the rule is applied. ⌘N used to carry its own copy of it,
     * because ⌘N used to create a workspace outright with no sheet to preselect in; §APP-018
     * gave it the sheet, so the rule lives where the picker the user can override it in is.
     */
    const inheritGroupID = useMemo(
        () =>
            !settings.general.inheritGroupOnNewWorkspace || workspace === null
                ? null
                : (selectGroupForWorkspace(kelpi, workspace.id)?.id ?? null),
        [kelpi, settings.general.inheritGroupOnNewWorkspace, workspace]
    );

    /**
     * §WS-137's data feed. The key is a signature of the workspace's associations, so a delta
     * that moves a branch (a HEAD change the daemon's watcher noticed) re-reads git; the hook's
     * own 30 s poll covers dirtiness that never touches HEAD.
     */
    const associationsKey = useMemo(
        () =>
            (workspace?.repoAssociations ?? [])
                .map((association) => `${association.id}:${association.worktreePath}:${association.branchName ?? ''}`)
                .join('|'),
        [workspace]
    );
    const registryKey = useMemo(
        () => daemon.state.repos.map((repo) => repo.id).join('|'),
        [daemon.state.repos]
    );
    const inspectorData = useInspectorData({
        commands,
        workspaceID: workspace?.id ?? null,
        // §APP-071: the FOOTER reads the same associations for its `doc N +A -B`, so the feed
        // runs whenever the active workspace has any — not only while the panel is open. With
        // the panel shut it reads the daemon watcher's last known values rather than forcing a
        // `git status` (`refreshOnRead`), so an always-visible footer costs no extra git.
        enabled: inspectorVisible || associationsKey !== '',
        refreshOnRead: inspectorVisible,
        // §APP-037: …except on arrival. Activating a workspace — from the palette, ⌘1–9, a
        // sidebar click, the status popover — forces one real `git status`, exactly as the Swift
        // reducer's `.refreshGitStatus` does, so a switch never lands on a stale badge.
        forceRefreshFor: gitRefreshRequest,
        associationsKey,
        registryKey
    });

    /**
     * Graft (§GIT-035…§GIT-051). The daemon owns the engine and broadcasts `graft-changed` /
     * `graft-orphans`; this hook keeps the client half — the optimistic `.starting` row, the
     * `.error` placeholder, the swap prompt and the orphan list — and drives the WS verbs.
     * Unconditional, not gated on the inspector being open: a `graft-changed` that arrives
     * while the panel is closed must already be in state when it opens.
     */
    const graft = useGraft({
        commands,
        events: runtime.connection,
        // Re-sync on (re)connect AND whenever the inspector opens: the second is when an
        // interrupted graft in a repo registered since boot has to be able to surface
        // (`graft-session-list --refresh`, `daemon/src/ws/graft.ts`).
        syncKey: `${ui.connection}:${inspectorVisible ? 'open' : 'closed'}`
    });

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
    /** §TERM-116's scheduler is built once, before `notifyFailure` can be closed over. */
    const notifyFailureRef = useRef(notifyFailure);
    notifyFailureRef.current = notifyFailure;

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

    // ── web panes: favourites, batch sessions, and the browser key layer ─────────────
    //
    // Favourites and batch sessions are daemon state that no `DomainEvent` describes, so they
    // arrive on their own broadcasts (`webpane/hooks.ts`) rather than through the mirror.
    const webPaneIDs = useMemo(
        () => panes.filter((pane) => pane.type === 'web').map((pane) => pane.id),
        [panes]
    );
    const webUI = useWebPaneUI({
        connection: runtime.connection as unknown as WebUIConnection,
        commands: webCommands,
        webPaneIDs
    });

    /**
     * ⌘F / ⌘L for a web pane, as per-pane tokens — the same shape a content pane's find uses,
     * because both mean "open the thing and take the caret", which is an event, not a state.
     */
    const [webFindRequest, setWebFindRequest] = useState<{ paneID: string; seq: number } | null>(null);
    const [webURLRequest, setWebURLRequest] = useState<{ paneID: string; seq: number } | null>(null);

    /** WEB-002's input: every web pane on screen, with the URL its active tab is showing. */
    const blankURLTargets = useMemo<readonly BlankURLTarget[]>(
        () =>
            webPaneIDs.map((paneID) => {
                const web = workspace?.webPanes[paneID];
                const tabs = web?.tabs ?? [];
                const tab = tabs.find((candidate) => candidate.id === web?.activeTabID) ?? tabs[0] ?? null;
                return { paneID, activeTabID: tab?.id ?? null, activeURL: tab?.url ?? '' };
            }),
        [webPaneIDs, workspace]
    );

    /**
     * The web verbs, each gated on the focused pane actually being a web pane (WEB-155). They
     * back BOTH the bindable `web_*` actions and the hard-coded priority layer, so the two
     * cannot disagree about what ⌘R does.
     */
    const webAct = useMemo(() => {
        const focusedWebPane = (): FocusedWebPane | null => {
            const state = store.getState();
            const paneID = selectFocusedPaneID(state);
            if (paneID === null) return null;
            const pane = selectPane(state, paneID);
            if (pane === null || pane.type !== 'web') return null;
            const active = selectActiveWorkspace(state);
            const web = active?.webPanes[paneID];
            const tabs = web?.tabs ?? [];
            const activeID = web?.activeTabID ?? null;
            const tab = tabs.find((candidate) => candidate.id === activeID) ?? tabs[0] ?? null;
            return { paneID, tabID: tab?.id ?? null, tabCount: tabs.length };
        };
        const bump = (
            setter: (next: { paneID: string; seq: number } | null) => void,
            paneID: string
        ): void => {
            setter(null);
            // Read-modify-write through the setter so two bumps in one tick still differ.
            setter({ paneID, seq: Date.now() });
        };
        return {
            focusedWebPane,
            /** ⌘F over a web pane. Declines (falls through) for every other pane type. */
            openFind(): boolean {
                const pane = focusedWebPane();
                if (pane === null) return false;
                setWebFindRequest((current) =>
                    current?.paneID === pane.paneID
                        ? { paneID: pane.paneID, seq: current.seq + 1 }
                        : { paneID: pane.paneID, seq: 1 }
                );
                return true;
            },
            focusURLBar(paneID: string): void {
                bump(setWebURLRequest, paneID);
            },
            reload: (paneID: string) => void webCommands.reload(paneID),
            back: (paneID: string) => void webCommands.back(paneID),
            forward: (paneID: string) => void webCommands.forward(paneID),
            newTab: (paneID: string) => void webCommands.newTab(paneID),
            closeTab: (paneID: string, tabID: string) => void webCommands.closeTab(paneID, tabID),
            cycleTab(paneID: string, offset: number): void {
                const state = store.getState();
                const web = selectActiveWorkspace(state)?.webPanes[paneID];
                const tabs = web?.tabs ?? [];
                if (tabs.length < 2) return;
                const at = Math.max(
                    0,
                    tabs.findIndex((tab) => tab.id === web?.activeTabID)
                );
                const next = tabs[(at + offset + tabs.length) % tabs.length];
                if (next !== undefined) void webCommands.selectTab(paneID, next.id);
            },
            zoom(paneID: string, direction: 'in' | 'out' | 'reset'): void {
                const pane = focusedWebPane();
                const tabID = pane?.paneID === paneID ? pane.tabID : null;
                if (tabID === null) return;
                void webCommands.zoom(paneID, tabID, direction);
            },
            /** The bindable half (WEB-155): a no-op unless a web pane has focus. */
            run(action: (pane: FocusedWebPane) => void): boolean {
                const pane = focusedWebPane();
                if (pane === null) return false;
                action(pane);
                return true;
            }
        };
    }, [store, webCommands]);

    /**
     * The overlay-close handoff, for every pane type — including the one whose surface is not in
     * this document (§N29, and N19's rule one pane type further on).
     *
     * `focusPaneSurface` resolves a pane's marked surface and focuses it: the terminal host for a
     * shell pane, the textarea for an editor. A WEB pane has no such element — its page is a
     * native view in the shell's process — so every handoff below (Settings, Help, the pane
     * search bar, the palette's §10.4 close, a status-popover jump) was a silent no-op there: the
     * ring stayed on the web pane while the keyboard sat in this renderer, and the user had to
     * click the page again. Handing it back over the wire is the same WEB-043 verb the pane's own
     * focus effect uses.
     *
     * The pane's own effect covers the case where focus MOVED to it; this covers the case it
     * cannot see, where the pane was focused all along and only an overlay went away.
     *
     * Deliberately NOT under WEB-043's chrome-text exemption. That guard protects a caret the
     * user is USING — the URL bar mid-edit, a rename — from a focus transition happening around
     * them. Here the chrome text field holding the caret is the overlay that is closing, which is
     * exactly what the handoff exists to take it back from: `focusPaneSurface` claims it for
     * every other pane type without asking, and a web pane must not be the one that declines.
     */
    const handBackPaneCaret = useCallback(
        (paneID: string | null): void => {
            if (paneID === null) return;
            focusPaneSurface(paneID);
            const state = store.getState();
            if (selectPane(state, paneID)?.type !== 'web') return;
            const web = selectActiveWorkspace(state)?.webPanes[paneID];
            const tabID = web?.activeTabID ?? web?.tabs[0]?.id ?? null;
            if (tabID === null) return;
            void webCommands.focusView(paneID, tabID);
        },
        [store, webCommands]
    );

    // WEB-002: a web pane (or tab) that arrives BLANK hands the caret to the URL bar; one that
    // arrives with a URL is loading a page, so focus belongs to the page. Same token the ⌘L
    // path bumps, so the two cannot disagree about what "focus the URL bar" means.
    //
    // §N35: `hasSnapshot` is what tells the rule an ARRIVAL from an OPENING. A client that
    // reloads is handed every web pane the workspace already had, and none of them was opened
    // here — see the hook's own note.
    useBlankWebPaneURLFocus(blankURLTargets, webAct.focusURLBar, daemon.hasSnapshot);

    /**
     * §7.3's tri-state layer, behind a ref so the key dispatcher (rebuilt only on a keybinding
     * change) always calls the current one.
     */
    const webPriority = useMemo(
        () =>
            createWebPanePriority({
                focusedWebPane: webAct.focusedWebPane,
                isChromeTextEditing: () =>
                    chromeTextIsFocused(typeof document === 'undefined' ? null : document.activeElement),
                focusURLBar: webAct.focusURLBar,
                reload: webAct.reload,
                back: webAct.back,
                forward: webAct.forward,
                newTab: webAct.newTab,
                closeTab: webAct.closeTab,
                cycleTab: webAct.cycleTab,
                zoom: webAct.zoom
            }),
        [webAct]
    );
    const webPriorityRef = useRef(webPriority);
    webPriorityRef.current = webPriority;

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
     * §TERM-116's timer, owned by the window rather than by the overlay: the bar is unmounted
     * and remounted as it moves between panes, and a debounce that died with it would let a
     * short needle escape the cancel. One scheduler, `store`-scoped, cancelled on unmount.
     */
    const searchNeedleRef = useRef<SearchNeedleScheduler>(
        createSearchNeedleScheduler({
            send: (needle: string) => {
                const id = selectActiveWorkspaceID(store.getState());
                if (id === null) return;
                void commands.setTerminalSearchNeedle({ workspaceID: id, needle }).then(
                    (reply) => {
                        if (!isOkReply(reply)) notifyFailureRef.current('Search', replyError(reply));
                    },
                    (error: unknown) => {
                        notifyFailureRef.current(
                            'Search',
                            error instanceof Error ? error.message : String(error)
                        );
                    }
                );
            }
        })
    );
    useEffect(() => {
        const scheduler = searchNeedleRef.current;
        return () => scheduler.cancel();
    }, []);

    /**
     * §WS-151 — File ▸ Select All Workspaces / Deselect All Workspaces.
     *
     * The sidebar fills this while it is mounted (`SidebarProps.selectionCommandsRef`), exactly
     * as it fills §SET-186's Escape predicate: the multi-selection and the full workspace set
     * (collapsed groups included) are both its own, and assembly's part is to hold the ref and
     * ask.
     *
     * It is a ref-LIKE object rather than a `useRef` for one reason: Select All on a HIDDEN
     * sidebar has to show the sidebar first, and the sidebar does not exist to be asked until
     * React has committed that. Parking the request and letting the arriving handle drain it is
     * deterministic where a `queueMicrotask` or a `setTimeout(0)` would be a race with the
     * scheduler. The shipped app has no such problem — its selection is reducer state that
     * exists whether or not anything is drawing it.
     */
    const pendingSelectAllRef = useRef(false);
    const sidebarSelectionRef = useMemo<{ current: SidebarSelectionCommands | null }>(() => {
        let handle: SidebarSelectionCommands | null = null;
        return {
            get current(): SidebarSelectionCommands | null {
                return handle;
            },
            set current(next: SidebarSelectionCommands | null) {
                handle = next;
                if (next === null || !pendingSelectAllRef.current) return;
                pendingSelectAllRef.current = false;
                next.selectAll();
            }
        };
    }, []);

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
            // CONT-090: ⌘E out of an EXTERNAL editor session ends the session (the PTY dies and
            // the pane goes back to preview) rather than toggling the built-in editor behind it.
            if (pane.externalEditorCommand !== null) {
                return run('Close editor', commands.markdownExternalEditor({ paneID, action: 'close' }));
            }
            return runTask('Toggle markdown edit', content.setMode(paneID, pane.isEditing ? 'view' : 'edit'));
        };

        /**
         * §15's one-shot "scroll the new entry into view", plus the switch to it.
         *
         * The reply carries the id, so this client knows the row is ITS doing — a
         * `workspace-created` delta caused by another client must not move this one's
         * viewport. **Creating a workspace switches to it** (the Swift app's behaviour,
         * app-state-core.md §3 `createWorkspace` → `activeWorkspaceID = new`), which is what
         * makes "New Workspace, then type" work; without it the row appeared and the window
         * stayed on the old workspace forever (run-B L3). The daemon reveals a create to every
         * attached client as well (`handlers/app/workspaces.ts`) — this is the local, instant
         * half, and the two are idempotent.
         */
        /**
         * §WS-100: a group this client created is revealed by its header, the same one-shot the
         * workspace create path uses. `run` cannot do it — the id is in the reply.
         */
        const runCreateGroup = (
            promise: Promise<CommandReply>,
            options: { readonly rename?: boolean } = {}
        ): true => {
            void promise.then(
                (reply) => {
                    if (!isOkReply(reply)) {
                        notifyFailure('New group', replyError(reply));
                        return;
                    }
                    const created = replyText(reply, 'group_id');
                    if (created === undefined) return;
                    setScrollToGroupID(created);
                    // §WS-052 / §APP-019: the gestures that mint a PLACEHOLDER name drop
                    // straight into inline rename on the header the reply named — the id
                    // exists nowhere else, so this is the only place the request can be made.
                    if (options.rename === true) {
                        setSidebarVisible(true);
                        setSidebarRenameRequest({ kind: 'group', id: created });
                    }
                },
                (error: unknown) => {
                    notifyFailure('New group', error instanceof Error ? error.message : String(error));
                }
            );
            return true;
        };

        const runCreateWorkspace = (
            promise: Promise<CommandReply>,
            repoPaths: readonly string[] = []
        ): true => {
            void promise.then(
                (reply) => {
                    if (!isOkReply(reply)) {
                        notifyFailure('New workspace', replyError(reply));
                        return;
                    }
                    const created = replyText(reply, 'workspace_id');
                    if (created !== undefined) {
                        activateWorkspaceAndReveal(created);
                        // §WS-075's Repositories section: one association per chosen repo,
                        // pointing at the repo's own path, once the workspace exists. The
                        // create verb carries no repo list (only `--worktree` does), so these
                        // ride the same `add-repo-association` the inspector uses.
                        for (const path of repoPaths) {
                            void commands
                                .addRepoAssociation({ workspaceID: created, path })
                                .then((association) => {
                                    if (!isOkReply(association)) {
                                        notifyFailure('Add repository', replyError(association));
                                    }
                                })
                                .catch((error: unknown) => {
                                    notifyFailure(
                                        'Add repository',
                                        error instanceof Error ? error.message : String(error)
                                    );
                                });
                        }
                    }
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

            // §WS-100: the sidebar's own row/filter clicks land here, and every one of them
            // queues the reveal — a row activated from the filter is usually somewhere the
            // main list is not scrolled to.
            activateWorkspace(workspaceID: string): boolean {
                activateWorkspaceAndReveal(workspaceID);
                return true;
            },

            /** ⌘1–9 (§WS-100). */
            switchToIndex(index: number): boolean {
                const id = selectVisibleWorkspaceIDs(store.getState())[index];
                if (id === undefined) return false;
                activateWorkspaceAndReveal(id);
                return true;
            },

            switchRelative(delta: 1 | -1): boolean {
                const ids = selectVisibleWorkspaceIDs(store.getState());
                if (ids.length === 0) return false;
                const at = ids.indexOf(activeWorkspaceID() ?? '');
                const id = ids[(((at < 0 ? 0 : at) + delta + ids.length) % ids.length)];
                if (id === undefined) return false;
                // §WS-100: next/previous workspace, which is exactly the case where the row
                // being activated can be off the bottom of a long sidebar.
                activateWorkspaceAndReveal(id);
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

            /**
             * ⌘W (TERM-077 / WS-109), the Swift rule verbatim.
             *
             * On the LAST pane of a workspace, closing the pane deletes the WORKSPACE instead —
             * anything else leaves an empty workspace showing the grid's "No panes" placeholder,
             * which is the state the sweep found. The alert only comes up when that workspace
             * still has running agents AND `confirm-workspace-delete` is on; with neither, ⌘W
             * deletes silently, exactly as `KelpiCommands.handleClosePane` does.
             *
             * §WS-156: this is the ONE route that may reach zero workspaces, which is the Swift's
             * own asymmetry (the CLI and the sidebar's Delete both refuse at one) and the only
             * way to arrive at §APP-067's "No workspace selected" state. `allowLast` says so on
             * the wire; the daemon's guard is otherwise unchanged.
             */
            closeFocused(): boolean {
                const workspace = activeWorkspace();
                const paneID = focused();
                if (workspace === null || paneID === null) return false;
                if (workspace.panes.length > 1) {
                    return run('Close pane', commands.closePane({ paneID }));
                }
                const agents = activeAgentCount(workspace);
                if (agents > 0 && store.getState().settings.value.general.confirmWorkspaceDeleteWhenActive) {
                    setCloseGate({
                        workspaceID: workspace.id,
                        name: workspace.name,
                        activeAgents: agents,
                        allowLast: true
                    });
                    return true;
                }
                return run(
                    'Delete workspace',
                    commands.deleteWorkspace({ workspace: workspace.id, force: true, allowLast: true })
                );
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

            /**
             * §LAY-061 — the same drag, addressed by SPLIT PATH. Used for the dividers
             * `setSplitRatio` cannot express: `pane-resize` names a pane and only ever resolves
             * that pane's *enclosing* split, so a divider whose two children are both splits
             * (the root of a 2×2 `tiled` layout) is unreachable through it.
             */
            setSplitRatioAtPath(splitPath: string, ratio: number): boolean {
                const id = activeWorkspaceID();
                if (id === null) return false;
                return run(
                    'Resize pane',
                    commands.setSplitRatioAtPath({ workspaceID: id, splitPath, ratio })
                );
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
             *
             * §CONT-051: a markdown pane in EDIT mode declines, exactly as the Swift reducer
             * does — the find bar searches the rendered preview, and there is no preview while
             * the editor is up. The keystroke falls through to the host's own find, which is
             * the port's stand-in for `NSTextView`'s native find bar (§CONT-072).
             */
            openFind(): boolean {
                const paneID = focused();
                if (paneID === null) return false;
                const pane = selectPane(store.getState(), paneID);
                if (pane === null || (pane.type !== 'markdown' && pane.type !== 'diff')) return false;
                if (pane.type === 'markdown' && pane.isEditing) return false;
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

            // ── terminal search (TERM-113…TERM-120) ─────────────────────────────────
            //
            // The daemon owns everything a person reads off the overlay: which pane hosts the
            // bar, the needle, the total and the selected index all live on the workspace and
            // ride the delta stream, so a second window watching the same pane shows the same
            // counter. What comes back in the REPLY is the one thing that is not state — where
            // the selected match sits — and it is applied to this client's renderer only.

            /**
             * ⌘F. One binding, three backends — the split the Swift reducer makes by pane type
             * (`WorkspaceFeature.swift:1742-1835`): a markdown/diff pane's find runs inside its
             * own sandboxed frame, a terminal's runs against the daemon's scrollback buffer, and
             * a web pane's would run in the host's `webContents` (not wired yet, so ⌘F over one
             * falls through rather than opening a bar that could not count).
             */
            toggleSearch(): boolean {
                const paneID = focused();
                if (paneID === null) return false;
                const pane = selectPane(store.getState(), paneID);
                if (pane === null) return false;
                if (pane.type === 'markdown' || pane.type === 'diff') {
                    // §CONT-051: preview only. A markdown pane in edit mode declines and the
                    // keystroke falls through to the host's own find (§CONT-072) — the same
                    // split the daemon reducer makes in `canHostSearch`, which admits a
                    // markdown pane only while `!pane.isEditing`.
                    if (pane.type === 'markdown' && pane.isEditing) return false;
                    setFindRequest((current) =>
                        current?.paneID === paneID ? { paneID, seq: current.seq + 1 } : { paneID, seq: 1 }
                    );
                    return true;
                }
                if (pane.type !== 'shell') return false;
                const id = activeWorkspaceID();
                if (id === null) return false;
                setSearchReveal(null);
                return run('Search', commands.toggleTerminalSearch({ workspaceID: id }));
            },

            /** Escape / the ✕. Declines when no bar is open so the keystroke falls through. */
            closeSearch(): boolean {
                const workspace = activeWorkspace();
                if (workspace === null || workspace.searchingPaneID === null) return false;
                // §TERM-116: a deferred short needle must not land after the bar has gone.
                searchNeedleRef.current.cancel();
                setSearchReveal(null);
                return run('Search', commands.closeTerminalSearch({ workspaceID: workspace.id }));
            },

            /**
             * §TERM-116. The needle is DEBOUNCED below three characters (300 ms), exactly as
             * `WorkspaceFeature.swift:1775-1781` does, because the port's search is a socket
             * round trip that flushes the pane's write queue and scans up to 10 000 lines: a
             * one-character needle typed into a full buffer used to cost one full scan per
             * keystroke. `search-needle.ts` owns the rule (and the shared cancel-in-flight);
             * the field itself never lags, because the overlay echoes the draft locally.
             */
            setSearchNeedle(needle: string): boolean {
                if (activeWorkspaceID() === null) return false;
                searchNeedleRef.current.push(needle);
                return true;
            },

            stepSearch(direction: 'next' | 'prev'): boolean {
                const workspace = activeWorkspace();
                const paneID = workspace?.searchingPaneID ?? null;
                if (workspace === null || paneID === null) return false;
                void commands.stepTerminalSearch({ workspaceID: workspace.id, direction }).then(
                    (reply) => {
                        if (!isOkReply(reply)) {
                            notifyFailure('Search', replyError(reply));
                            return;
                        }
                        const match = replySearchMatch(reply);
                        if (match === null) return;
                        // A fresh seq every time: Return on the SAME match has to scroll back to
                        // it after the user has scrolled away.
                        setSearchReveal((current) => ({
                            paneID,
                            linesFromBottom: match.linesFromBottom,
                            col: match.col,
                            length: match.length,
                            seq: (current?.seq ?? 0) + 1
                        }));
                    },
                    (error: unknown) => {
                        notifyFailure('Search', error instanceof Error ? error.message : String(error));
                    }
                );
                return true;
            },

            // ── reopen / scratchpad / pane menu (TERM-075, CONT-113, TERM-107…111) ───

            /** ⇧⌘T. The daemon pops its undo stack and replays the agent resume (AGNT-072). */
            reopenClosedPane(): boolean {
                const workspace = activeWorkspace();
                if (workspace === null) return false;
                // An empty stack is not a failure worth a toast, and the daemon publishes the
                // depth (`recentlyClosedCount`) precisely so the client can stay quiet about it.
                if (recentlyClosedCount(workspace) <= 0) return false;
                return run('Reopen pane', commands.reopenClosedPane({ workspaceID: workspace.id }));
            },

            /** ⇧⌘N — a "Scratchpad" pane split off the focused one, already in edit mode. */
            createScratchpad(): boolean {
                const id = activeWorkspaceID();
                if (id === null) return false;
                return run('New scratchpad', commands.createScratchpad({ workspaceID: id }));
            },

            /**
             * "Copy Working Directory" (TERM-111). The Clipboard API needs a secure context; a
             * menu click supplies the gesture, but a plain-HTTP client has no `clipboard` at
             * all, so a refusal is reported rather than swallowed.
             */
            /**
             * "New Web Pane" — the header's globe button and the context menu's item (WEB-011).
             *
             * `target` is the pane the new one splits off and `direction` which way: the globe
             * splits right on a plain click and DOWN on ⇧-click, and the context menu is always
             * right. Swift does this in-process (`openWebPanePath(url:fromPaneID:direction:)`);
             * here the same two arguments ride the `web-open` verb, which is why the ⇧ is a real
             * vertical split rather than a hint the daemon drops. `pane_id` still scopes which
             * workspace the pane lands in — it is what a CLI caller sends, and it is the only
             * routing input when no anchor is named.
             */
            newWebPane(paneID: string, direction: 'horizontal' | 'vertical' = 'horizontal'): boolean {
                return run(
                    'New web pane',
                    commands.raw({
                        command: 'web-open',
                        url: 'about:blank',
                        private: false,
                        pane_id: paneID,
                        target: paneID,
                        direction
                    })
                );
            },

            /**
             * §SET-145 / §APP-021 / §WEB-154 — `open_web_pane` (⌘⇧O): the keyboard route to the
             * same blank web pane the header globe and the pane context menu open. The anchor is
             * the focused pane, else any pane of the active workspace — `pane_id` only scopes
             * which workspace the new pane lands in, and without one the daemon would fall back
             * to a `lastActiveWorkspaceID` it may never have been told.
             */
            newWebPaneFocused(): boolean {
                const paneID = focused() ?? activeWorkspace()?.panes[0]?.id ?? null;
                if (paneID === null) return false;
                return run(
                    'New web pane',
                    commands.raw({ command: 'web-open', url: 'about:blank', private: false, pane_id: paneID })
                );
            },

            /**
             * §CONT-133 — `open_diff` (default unbound): a diff pane for the FOCUSED pane's
             * working directory, unscoped (no `target_path`), which is what the Swift menu item
             * does. The inspector's plusminus (`openRepoDiff`) is the same verb scoped to a repo.
             */
            openDiffForFocusedPane(): boolean {
                const paneID = focused() ?? activeWorkspace()?.panes[0]?.id ?? null;
                if (paneID === null) return false;
                const pane = selectPane(store.getState(), paneID);
                if (pane === null || pane.workingDirectory === '') return false;
                return run('Open diff', commands.openDiff({ repoPath: pane.workingDirectory, paneID }));
            },

            copyWorkingDirectory(paneID: string): boolean {
                const pane = selectPane(store.getState(), paneID);
                if (pane === null) return false;
                const clipboard = globalThis.navigator?.clipboard;
                if (clipboard === undefined) {
                    notifyFailure('Copy working directory', 'this browser exposes no clipboard');
                    return true;
                }
                void clipboard.writeText(pane.workingDirectory).catch((error: unknown) => {
                    notifyFailure(
                        'Copy working directory',
                        error instanceof Error ? error.message : String(error)
                    );
                });
                return true;
            },

            /**
             * "Open in Finder" (TERM-110). A markdown/diff pane with a file path REVEALS that
             * file inside its folder; everything else opens the pane's working directory. Only
             * the Electron shell can act on it, so the menu item is hidden in a plain browser.
             */
            revealPane(paneID: string): boolean {
                const pane = selectPane(store.getState(), paneID);
                if (pane === null) return false;
                const file =
                    (pane.type === 'markdown' || pane.type === 'diff') &&
                    pane.filePath !== null &&
                    pane.filePath !== ''
                        ? pane.filePath
                        : null;
                return run(
                    'Open in Finder',
                    commands.revealPath({ path: file ?? pane.workingDirectory, select: file !== null })
                );
            },

            /** The context menu's Status submenu (TERM-107 / AGNT-057). Shell panes only. */
            setPaneStatus(paneID: string, status: 'idle' | 'running' | 'waitingForInput'): boolean {
                return run('Set pane status', commands.setPaneStatus({ paneID, status }));
            },

            /** The context menu's "Move to Workspace ▸" (TERM-108). */
            movePaneToWorkspace(paneID: string, workspaceID: string): boolean {
                return run('Move pane', commands.movePaneToWorkspace({ paneID, workspace: workspaceID }));
            },

            /** The context menu's Exclude / Include in Sync (TERM-109). */
            setSyncExcluded(paneID: string, excluded: boolean): boolean {
                const id = activeWorkspaceID();
                if (id === null) return false;
                return run(
                    'Synchronise input',
                    commands.setSyncExcluded({ target: paneID, excluded, workspace: id })
                );
            },

            /** The header's restart button: the daemon types the pane's resume command. */
            restartAgent(paneID: string): boolean {
                return run('Restart agent', commands.restartPaneAgent({ paneID }));
            },

            /**
             * ⌘N — **open the New Workspace sheet** (§APP-018).
             *
             * The shipped app spends ⌘N on `showNewWorkspaceSheet()` (`NexCommands.swift:10-13`),
             * which is a form: a name, a colour, a group, a profile and repositories, submitted
             * once. This used to create a workspace outright, named by the daemon, with no way to
             * say any of that — the create was there and the SHEET was not, which is what kept
             * the item partial.
             *
             * The sheet is `chrome/NewWorkspaceSheet.tsx` ▸ `NewEntrySheet` — a MODAL centred over
             * the window, which is how `ContentView.swift:289-294` presents it. The sidebar is
             * still revealed first, and the reason is now the RESULT rather than the form: the
             * created workspace's row is the confirmation the gesture worked, and a row that
             * appears in a panel nobody can see confirms nothing. (It is also what mounts the
             * sheet's owner — the sidebar raises it, since the sidebar is where every other route
             * to it lives.) The footer button, the chevron's first row, the group menu's "New
             * Workspace", File ▸ New Workspace, the palette and §WS-156's empty state all land on
             * this one action, so there is a single sheet with a single set of rules.
             *
             * SET-011's group inheritance is preserved and moves INTO the sheet: the picker opens
             * preselected on the active workspace's group (`inheritGroupID`, which the sidebar
             * already reads), which is the preselection `NewWorkspaceSheet.swift:66` makes. The
             * wire verb is untouched, so `kelpi workspace create` still lands at top level.
             */
            newWorkspace(): boolean {
                setSidebarVisible(true);
                setSidebarCreateRequest((previous) => ({
                    kind: 'workspace',
                    // null: the SHEET applies §SET-011 itself, through the `inheritGroupID`
                    // prop, so scoping the request to a group here would override a user who
                    // had turned inheritance off.
                    groupID: null,
                    seq: (previous?.seq ?? 0) + 1
                }));
                return true;
            },

            /**
             * The New Workspace form's submit. Unlike ⌘N this carries an EXPLICIT group (the
             * form's picker, itself preselected by the same inheritance rule), so "No group"
             * is honoured rather than being re-inherited here.
             *
             * `options` is what the shipped sheet collects beside the name: the colour swatch,
             * the profile, and the repositories to associate once the workspace exists
             * (§WS-075). Every field is optional, so the older two-argument call sites are
             * unchanged.
             */
            createWorkspace(
                name: string,
                groupID: string | null,
                options: {
                    color?: WorkspaceColor | undefined;
                    profile?: string | null | undefined;
                    repoPaths?: readonly string[] | undefined;
                } = {}
            ): boolean {
                const trimmed = name.trim();
                const repoPaths = options.repoPaths ?? [];
                return runCreateWorkspace(
                    commands.createWorkspace({
                        ...(trimmed.length > 0 ? { name: trimmed } : {}),
                        ...(groupID === null ? {} : { group: groupID }),
                        ...(options.color === undefined ? {} : { color: options.color }),
                        // `default` (or null) means "no assignment" — the daemon's own
                        // normalization — so it is simply not sent.
                        ...(options.profile === undefined ||
                        options.profile === null ||
                        options.profile === DEFAULT_PROFILE_NAME
                            ? {}
                            : { profile: options.profile })
                    }),
                    repoPaths
                );
            },

            deleteWorkspace(
                workspaceID: string,
                options: { allowLast?: boolean } = {}
            ): boolean {
                // The sidebar runs its own confirmation first, which is the GUI's
                // "delete anyway?" — so the command goes out forced, as the app's own
                // delete path does once the user has said yes.
                //
                // `allowLast` defaults OFF, so the sidebar's Delete keeps the shipped app's
                // `.disabled(store.workspaces.count <= 1)` rule; only the ⌘W gate passes it on
                // (§WS-156).
                return run(
                    'Delete workspace',
                    commands.deleteWorkspace({
                        workspace: workspaceID,
                        force: true,
                        ...(options.allowLast === true ? { allowLast: true } : {})
                    })
                );
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

            /** §WS-065's "Color ▸". `null` is the submenu's "None": a group's colour is optional. */
            setGroupColor(groupID: string, color: WorkspaceColor | null): boolean {
                return run('Group color', commands.setGroupColor({ groupID, color }));
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

            /** `color` is the New Group form's swatch; `null`/absent is its "None" (§WS-082). */
            createGroup(name: string, color?: WorkspaceColor | null | undefined): boolean {
                const trimmed = name.trim();
                if (trimmed.length === 0) return false;
                return runCreateGroup(
                    commands.createGroup({
                        name: trimmed,
                        ...(color === undefined || color === null ? {} : { color })
                    })
                );
            },

            /**
             * §SET-144 / §APP-019 / §WS-123 — `new_group` (⌘⇧G). The Swift menu item does not
             * ask for a name: it mints `New Group` / `New Group 2` / … , drops straight into
             * inline rename and queues the new header's scroll-into-view. Same here, so the
             * keystroke path never opens the sidebar's New Group *form* (that stays the footer
             * button's affordance) — and it goes through `runCreateGroup`, which owns both
             * one-shots.
             *
             * The verb is `create-group-for-workspaces` **with no workspaces**, and that is not
             * a workaround: both halves need the new group's id, and the id only exists in a
             * reply. The wire's `group-create` is fire-and-forget (wire-protocol.md §7) and its
             * ack carries nothing, so the previous version of this — a `.then` reading
             * `reply['group_id']` off that ack — silently did neither the rename nor the reveal
             * for every ⌘⇧G ever pressed. The audit's `workspace-edges` flow is what found it:
             * it timed out waiting for a rename field that never opened.
             */
            newGroupWithRename(): boolean {
                const existing = store.getState().daemon.state.groups.map((group) => group.name);
                return runCreateGroup(
                    commands.createGroupForWorkspaces({
                        name: defaultGroupName(existing),
                        workspaceIDs: []
                    }),
                    { rename: true }
                );
            },

            /**
             * §SET-153 — `rename_workspace` (⌘⇧R): begin inline rename of the ACTIVE workspace
             * in the sidebar (the same field the row menu's "Rename…" opens).
             */
            beginRenameActiveWorkspace(): boolean {
                const id = activeWorkspaceID();
                if (id === null) return false;
                setSidebarVisible(true);
                setSidebarRenameRequest({ kind: 'workspace', id });
                return true;
            },

            /**
             * §WS-151 — File ▸ Select All Workspaces / Deselect All Workspaces.
             *
             * Menu-only in the shipped app: two plain `Button`s outside the binding map
             * (`NexCommands.swift:49-57`), so there is no action name to bind and nothing here
             * is reachable from the key dispatcher. Both open the sidebar first — a selection
             * nobody can see is not a selection — and then run the sidebar's OWN closures, the
             * same ones its context menu's rows run (§WS-053).
             *
             * A hidden sidebar has published no handle on the tick the menu row arrives, so
             * Select All PARKS the request and the arriving handle drains it, rather than
             * declining a click the user did make. Deselect All never needs that: an unmounted
             * sidebar has no selection to clear.
             */
            selectAllWorkspaces(): boolean {
                setSidebarVisible(true);
                if (sidebarSelectionRef.current !== null) return sidebarSelectionRef.current.selectAll();
                // Nothing to ask yet — the sidebar was hidden. It drains this the moment it
                // publishes its handle (see `sidebarSelectionRef`'s setter).
                pendingSelectAllRef.current = true;
                return true;
            },

            deselectAllWorkspaces(): boolean {
                return sidebarSelectionRef.current?.deselectAll() ?? false;
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
            },

            /** §WS-137: the trailing inspector. Client-local, like the sidebar's visibility. */
            toggleInspector(): boolean {
                setInspectorVisible((visibleNow) => !visibleNow);
                return true;
            },

            // ── file opening (CONT-120…122, APP-020/APP-103) ─────────────────────────

            /**
             * ⌘O / File ▸ Preview Markdown… (CONT-120).
             *
             * Inside the Electron shell this asks the shell for a NATIVE open panel, the long
             * way round: the shell has no preload, so the request travels client → daemon →
             * shell, the shell runs `dialog.showOpenDialog` and sends the chosen path back as an
             * ordinary `open` verb (`daemon/src/ws/desktop.ts` documents the loop).
             *
             * In a plain browser there is no shell to ask and `<input type=file>` is NOT an
             * equivalent — it yields bytes, and the daemon needs a path on ITS filesystem, which
             * may be another machine entirely. So a browser gets an honest prompt for a path.
             */
            openFile(): boolean {
                if (shellWindowRef.current !== null) {
                    return run(
                        'Open file',
                        commands.shellAction({
                            action: 'open-file-dialog',
                            windowID: shellWindowRef.current,
                            paneID: focused()
                        })
                    );
                }
                const typed = globalThis.prompt?.(
                    `${OPEN_PANEL_MESSAGE} — type a path on the machine running kelpid`
                );
                const path = typed?.trim() ?? '';
                if (path === '') return true;
                const caller = focused();
                return run(
                    'Open file',
                    commands.openFile({ path, ...(caller === null ? {} : { paneID: caller }) })
                );
            },

            /** A drop that named a `.md` path (CONT-121 / APP-103). */
            openDroppedPath(path: string): boolean {
                return run('Open file', commands.openFile({ path }));
            },

            /**
             * ⌘-click on a terminal cell (CONT-122 / TERM-052).
             *
             * The daemon decides: only a `.md` file that exists becomes a pane. Anything else
             * comes back described, and a URL is handed to the OS opener — which is exactly what
             * returning `false` to ghostty's action callback did in the Swift app.
             */
            openTerminalTarget(paneID: string, row: number, col: number): boolean {
                void commands.openTerminalTarget({ paneID, row, col }).then(
                    (reply) => {
                        if (!isOkReply(reply)) {
                            notifyFailure('Open path', replyError(reply));
                            return;
                        }
                        const opened = replyText(reply, 'opened');
                        if (opened === 'external') {
                            const url = replyText(reply, 'url');
                            if (url !== undefined) globalThis.open?.(url, '_blank', 'noreferrer');
                            return;
                        }
                        if (opened === 'missing') {
                            notifyFailure('Open path', `${replyText(reply, 'path') ?? 'that file'} does not exist`);
                        }
                    },
                    (error: unknown) => {
                        notifyFailure('Open path', error instanceof Error ? error.message : String(error));
                    }
                );
                return true;
            },

            /** CONT-081: host `$VISUAL`/`$EDITOR` on this markdown pane's file. */
            openExternalEditor(paneID: string): boolean {
                return run('Open in $EDITOR', commands.markdownExternalEditor({ paneID, action: 'open' }));
            },

            /** CONT-090: end the session — the PTY dies and the pane returns to preview. */
            closeExternalEditor(paneID: string): boolean {
                return run('Close editor', commands.markdownExternalEditor({ paneID, action: 'close' }));
            },

            // ── the ••• menu's shell + daemon items (APP-053/APP-054) ────────────────

            /** APP-054: rebind the control listeners. Every PTY survives; only the CLI transport cycles. */
            restartControlServer(): boolean {
                void commands.restartControlServer().then(
                    (reply) => {
                        if (!isOkReply(reply)) {
                            notifyFailure('Restart Socket Server', replyError(reply));
                            return;
                        }
                        notifyFailure(
                            'Socket server restarted',
                            `listening again on ${replyText(reply, 'socket_path') ?? 'the control socket'}`
                        );
                    },
                    (error: unknown) => {
                        notifyFailure(
                            'Restart Socket Server',
                            error instanceof Error ? error.message : String(error)
                        );
                    }
                );
                return true;
            },

            /**
             * TERM-040 — a path dropped onto a terminal is TYPED, not opened. Bare, because the
             * user is composing a command around it, and that is what the Swift drop did.
             */
            typeDroppedPaths(paneID: string, text: string): boolean {
                return run('Drop path', commands.sendText({ target: paneID, text, bare: true }));
            },

            /** TERM-043 — hand a pasted image to the daemon, which writes it and types its path. */
            pasteImage(paneID: string, file: Blob): boolean {
                void file
                    .arrayBuffer()
                    .then(async (buffer) => {
                        const bytes = new Uint8Array(buffer);
                        // Chunked so a multi-megabyte screenshot does not blow the call stack the
                        // way `String.fromCharCode(...bytes)` would.
                        let binary = '';
                        for (let index = 0; index < bytes.length; index += 8192) {
                            binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
                        }
                        const reply = await commands.pasteImage({ paneID, data: btoa(binary) });
                        if (!isOkReply(reply)) notifyFailure('Paste image', replyError(reply));
                    })
                    .catch((error: unknown) => {
                        notifyFailure('Paste image', error instanceof Error ? error.message : String(error));
                    });
                return true;
            },

            /** Install CLI / Check for Updates — things only the Electron shell can do. */
            shellAction(action: 'install-cli' | 'check-for-updates'): boolean {
                return run(
                    action === 'install-cli' ? 'Install CLI' : 'Check for Updates',
                    commands.shellAction({ action, windowID: shellWindowRef.current })
                );
            },

            // ── bulk workspace operations (§5.6's multi-select menu) ─────────────────
            //
            // Each is ONE command for the whole selection (§WS-056…§WS-060): N single-workspace
            // commands would arrive as N deltas and could half-apply.

            setWorkspaceColor(workspaceID: string, color: WorkspaceColor): boolean {
                return run('Workspace color', commands.setBulkColor({ workspaceIDs: [workspaceID], color }));
            },

            setBulkColor(workspaceIDs: readonly string[], color: WorkspaceColor): boolean {
                return run('Workspace color', commands.setBulkColor({ workspaceIDs, color }));
            },

            setBulkLabel(workspaceIDs: readonly string[], label: string, apply: boolean): boolean {
                return run('Label workspaces', commands.setBulkLabel({ workspaceIDs, label, apply }));
            },

            createGroupForWorkspaces(
                name: string,
                workspaceIDs: readonly string[],
                color?: WorkspaceColor | null | undefined
            ): boolean {
                const trimmed = name.trim();
                if (trimmed.length === 0) return false;
                return runCreateGroup(
                    commands.createGroupForWorkspaces({
                        name: trimmed,
                        workspaceIDs,
                        ...(color === undefined || color === null ? {} : { color })
                    })
                );
            },

            /**
             * §WS-052 — a row's "Move to Group ▸ New Group…".
             *
             * The Swift sends ONE `createGroup` carrying `initialWorkspaceIDs: [workspaceID]`
             * and `autoRename: true`; the port's equivalent is the `create-group-for-workspaces`
             * verb (which is `create-group` WITH members, atomically) plus the reply-driven
             * rename. A create followed by a move would show the row jumping twice and could
             * half-apply, which is the whole reason that verb exists.
             *
             * The name is the same placeholder the ⌘⇧G path mints, so a second one is
             * "New Group 2" rather than a duplicate-name refusal.
             */
            newGroupForWorkspace(workspaceID: string): boolean {
                const existing = store.getState().daemon.state.groups.map((group) => group.name);
                return runCreateGroup(
                    commands.createGroupForWorkspaces({
                        name: defaultGroupName(existing),
                        workspaceIDs: [workspaceID]
                    }),
                    { rename: true }
                );
            },

            /**
             * "Delete N Workspaces…" after the sidebar's single confirmation. The confirmation
             * IS the GUI's "delete anyway?", so each delete goes out forced — the same reasoning
             * as the single-row delete above.
             */
            deleteWorkspaces(workspaceIDs: readonly string[]): boolean {
                for (const workspaceID of workspaceIDs) {
                    run('Delete workspaces', commands.deleteWorkspace({ workspace: workspaceID, force: true }));
                }
                return true;
            },

            // ── workspace inspector ─────────────────────────────────────────────────

            setWorkspaceProfile(workspaceID: string, profile: string | null): boolean {
                return run(
                    'Workspace profile',
                    commands.setWorkspaceProfile({
                        workspace: workspaceID,
                        ...(profile === null ? {} : { profile })
                    })
                );
            },

            /**
             * The inspector's "plusminus": a diff pane for that repo path (§WS-141).
             *
             * The focused pane rides along as `pane_id` — the shipped app's `fromPaneID`. It is
             * not decoration: the daemon routes an `open`/`diff` without one to
             * `lastActiveWorkspaceID`, which a freshly booted daemon has not been told yet, and
             * the pane would silently never appear.
             */
            openRepoDiff(repoPath: string): boolean {
                // Anchor: the focused pane, else ANY pane of the workspace on screen. Without
                // one the daemon falls back to `lastActiveWorkspaceID`, which it has not
                // necessarily been told yet — and the pane would silently never appear.
                const paneID = focused() ?? activeWorkspace()?.panes[0]?.id ?? null;
                return run(
                    'Open diff',
                    commands.openDiff({ repoPath, ...(paneID === null ? {} : { paneID }) })
                );
            },

            /**
             * The inspector's "terminal": a shell at that path — a split of the focused pane
             * (Shift = vertical, matching the shipped tooltip), or a first pane when the
             * workspace has none.
             */
            openTerminalAt(repoPath: string, options: { vertical: boolean }): boolean {
                const paneID = focused() ?? activeWorkspace()?.panes[0]?.id ?? null;
                if (paneID === null) {
                    const id = activeWorkspaceID();
                    if (id === null) return false;
                    return run('Open terminal', commands.createPane({ workspace: id, path: repoPath }));
                }
                return run(
                    'Open terminal',
                    commands.splitPane({
                        paneID,
                        direction: options.vertical ? 'vertical' : 'horizontal',
                        path: repoPath
                    })
                );
            },

            /**
             * The three inspector mutations that can FAIL in a way the user must see: they
             * answer with the daemon's own message so the sheet stays open and says why
             * (§WS-079/§WS-148), instead of closing behind a toast.
             */
            async addRepoAssociation(path: string): Promise<string | null> {
                const id = activeWorkspaceID();
                if (id === null) return 'no active workspace';
                try {
                    const reply = await commands.addRepoAssociation({ workspaceID: id, path });
                    return isOkReply(reply) ? null : replyError(reply);
                } catch (error) {
                    return error instanceof Error ? error.message : String(error);
                }
            },

            async addWorktree(request: WorkspaceWorktreeRequest): Promise<string | null> {
                const id = activeWorkspaceID();
                if (id === null) return 'no active workspace';
                try {
                    const reply = await commands.addWorktree({
                        workspaceID: id,
                        repoID: request.repoID,
                        name: request.name,
                        branch: request.branch,
                        updateMain: request.updateMain
                    });
                    return isOkReply(reply) ? null : replyError(reply);
                } catch (error) {
                    return error instanceof Error ? error.message : String(error);
                }
            },

            /**
             * §WS-078: the New Workspace form's worktree route rides `workspace-create
             * --worktree` — the CLI's own path, so sanitization, the branch default and
             * `--update-main` all stay daemon-side. A failure comes back as text for the form.
             */
            async createWorkspaceWithWorktree(
                name: string,
                groupID: string | null,
                worktree: WorkspaceWorktreeRequest,
                repoPath: string,
                extras: { color?: WorkspaceColor | undefined; profile?: string | null | undefined } = {}
            ): Promise<string | null> {
                try {
                    const reply = await commands.createWorkspace({
                        ...(name.trim().length > 0 ? { name: name.trim() } : {}),
                        ...(groupID === null ? {} : { group: groupID }),
                        ...(extras.color === undefined ? {} : { color: extras.color }),
                        ...(extras.profile === undefined ||
                        extras.profile === null ||
                        extras.profile === DEFAULT_PROFILE_NAME
                            ? {}
                            : { profile: extras.profile }),
                        repo: repoPath,
                        worktree: worktree.name,
                        branch: worktree.branch,
                        updateMain: worktree.updateMain
                    });
                    if (!isOkReply(reply)) return replyError(reply);
                    const created = replyText(reply, 'workspace_id');
                    if (created !== undefined) activateWorkspaceAndReveal(created);
                    return null;
                } catch (error) {
                    return error instanceof Error ? error.message : String(error);
                }
            },

            removeRepoAssociation(associationID: string, deleteWorktree: boolean): boolean {
                const id = activeWorkspaceID();
                if (id === null) return false;
                return run(
                    deleteWorktree ? 'Remove worktree' : 'Remove repository',
                    commands.removeRepoAssociation({ workspaceID: id, associationID, deleteWorktree })
                );
            }
        };
    }, [activateWorkspaceAndReveal, commands, content, notifyFailure, run, runTask, runtime, store]);

    /**
     * `act` reachable from effects that must not re-subscribe when it is rebuilt (the shell's
     * menu relay). Same pattern as `keyActionsRef` below, and the same reason.
     */
    const actRef = useRef(act);
    actRef.current = act;

    // ── terminal mounting ───────────────────────────────────────────────────────────

    const policyRef = useRef(createMountPolicy());
    const [mounted, setMounted] = useState<readonly string[]>(EMPTY_IDS);

    const terminalCandidates = useMemo(
        () =>
            visible.filter((paneID) => {
                const pane = paneByID.get(paneID);
                if (pane === undefined) return false;
                // CONT-081: a markdown pane hosting `$EDITOR` has a real PTY and must be
                // mounted like any terminal — it is `externalEditorCommand`, not the pane type,
                // that decides whether there is a surface to draw.
                return pane.type === 'shell' || pane.externalEditorCommand !== null;
            }),
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

    /**
     * The engines want concrete colors, so the palette is read off the DOM — but the answer is
     * anchored to the bucket THIS render resolved, never to whatever the stylesheet currently
     * says.
     *
     * Two things make that safe now (run-B L4). `ThemeProvider` stamps `data-kelpi-theme` in a
     * LAYOUT effect, which React flushes before this passive one, so the read sees this
     * commit's bucket rather than the previous one's; and the bucket's own preset is the
     * fallback, so a host that defines no `--kelpi-term-*` variables still gets the right column
     * instead of the dark one. Before both, the first light→dark transition left the terminal
     * painting a `#2B2B2E` foreground on a `#0A0A0C` background — text that reads as SGR-dim.
     */
    /*
     * §APP-014 adds a third layer, and adds it HERE rather than in a parallel path: the
     * daemon's resolved `theme = <name>` palette is merged over the DOM answer, so the theme
     * decides the colours it names and the preset keeps the rest. Because it rides the settings
     * snapshot, a `theme` line edited in the config file (or picked in Settings) re-runs this
     * effect and every mounted renderer takes `setTheme` — live, with no relaunch, which is
     * what libghostty's `ghostty_app_update_config` did for the Swift app.
     */
    const themePalette = settings.appearance.terminalTheme.palette;
    useEffect(() => {
        setTerminalTheme(
            mergeTerminalPalette(resolveTerminalTheme(null, terminalThemePreset(bucket)), themePalette)
        );
    }, [bucket, themePalette]);

    // The ghostty background overrides whatever the chrome palette says, and it must stay an
    // opaque hex: ghostty-web's parser maps `rgba()` (and every other non-hex form) to BLACK.
    // The pane container behind the canvas gets the alpha instead — `paneFill` below — which
    // is exactly the Swift split (renderer takes the color, container takes the opacity, §3.8).
    //
    // APP-012's limit, stated where the reason lives: under a TRANSPARENT window (see the root
    // provider's `windowOpacity`) the desktop shows through the window fill, the grid gutters
    // and the pane padding, but NOT through the terminal's own canvas — the engine paints that
    // with this opaque hex. The Swift app got the other behaviour because libghostty applied
    // `background-opacity` inside the surface; no engine here exposes that, and handing
    // ghostty-web an `rgba()` would paint every terminal black.
    const paneTheme = useMemo<TerminalTheme | undefined>(() => {
        const background = normalizeHexColor(settings.appearance.backgroundColor);
        if (background === null) return terminalTheme;
        return { ...(terminalTheme ?? {}), background };
    }, [terminalTheme, settings.appearance.backgroundColor]);

    /**
     * §N17 — is `paneFill` actually translucent? Then the engine canvas must let it through.
     *
     * The comment above states the port's old limit: "the desktop shows through the window
     * fill, the grid gutters and the pane padding, but NOT through the terminal's own canvas —
     * the engine paints that with this opaque hex". That limit is gone. `ghostty-web`
     * `0.4.0-nex.3` implements the `allowTransparency` option it always accepted and never
     * read: with it on, the DEFAULT background is cleared rather than filled, so `paneFill`'s
     * `rgba()` is what shows in every blank cell — the composite libghostty produced inside the
     * surface in the shipped app (`PaneGridView.swift:370-378` leaves a shell pane's wrapper
     * unpainted for exactly that reason). The colour still goes to the engine as an opaque hex
     * (`paneTheme` above): the opacity is the container's job, the palette is the renderer's.
     */
    const paneTransparency = settings.appearance.backgroundOpacity < 1;

    const paneFill = useMemo(
        () => withAlpha(settings.appearance.backgroundColor, settings.appearance.backgroundOpacity),
        [settings.appearance.backgroundColor, settings.appearance.backgroundOpacity]
    );

    /**
     * The fill a CONTENT pane's sandboxed frame paints inside itself (run-B L1).
     *
     * `paneFill` is what the pane container paints, and for a terminal that is the end of it —
     * the canvas composites through it. A markdown/diff document cannot: it is a `srcdoc` frame
     * sandboxed to `allow-scripts`, which gives it an opaque origin, which Chromium isolates
     * into its own process, and an out-of-process frame paints its own surface over a WHITE base
     * rather than inheriting the embedder's transparency (`content/bridge.ts` → `frameBaseStyle`).
     * Flattening the same two colors the container composites — the ghostty background at the
     * ghostty opacity, over the window fill — reproduces that composite as one opaque value, so
     * the document is pixel-identical to the container it can no longer see through.
     */
    const contentDocumentFill = useMemo(
        () =>
            flattenOver(
                settings.appearance.backgroundColor,
                settings.appearance.backgroundOpacity,
                chromeTheme.windowBackground
            ),
        [settings.appearance.backgroundColor, settings.appearance.backgroundOpacity, chromeTheme.windowBackground]
    );

    /**
     * SET-219 / TERM-021 — the user-overridable search-highlight palette.
     *
     * The Swift app laid a Kelpi-managed ghostty defaults file UNDER the user's own config so
     * libghostty resolved `search-background` and friends with the user's value winning. There
     * is no libghostty here: every search highlight this app draws is ours, so the same four
     * colours are kelpi-config keys and this is where they reach the two surfaces that paint a
     * match — the content panes' injected find script, and (below) the terminal's search
     * selection.
     */
    const findPalette = useMemo(
        () => ({
            match: settings.chrome.searchMatchColor,
            matchText: settings.chrome.searchMatchTextColor,
            current: settings.chrome.searchMatchCurrentColor,
            currentText: settings.chrome.searchMatchCurrentTextColor
        }),
        [
            settings.chrome.searchMatchColor,
            settings.chrome.searchMatchTextColor,
            settings.chrome.searchMatchCurrentColor,
            settings.chrome.searchMatchCurrentTextColor
        ]
    );

    /** `paneTheme` with the search-match colours in the selection slots (see `renderPane`). */
    const searchPaneTheme = useMemo<TerminalTheme>(
        () => ({
            ...(paneTheme ?? {}),
            selectionBackground: findPalette.current,
            selectionForeground: findPalette.currentText
        }),
        [paneTheme, findPalette]
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
            fontSize: settings.appearance.fontSize,
            // ghostty `window-padding-x`/`-y` (Settings ▸ Appearance ▸ Terminal padding);
            // null = the pane's shipped 4px defaults.
            paddingX: settings.appearance.windowPaddingX,
            paddingY: settings.appearance.windowPaddingY
        }),
        [
            settings.appearance.fontFamily,
            settings.appearance.fontSize,
            settings.appearance.windowPaddingX,
            settings.appearance.windowPaddingY
        ]
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

    /**
     * §N29 — a click that lands in a web pane's PAGE, arriving the long way round.
     *
     * Every other pane body hears its own click: the DOM delivers a `pointerdown` and the body
     * calls `onFocusRequest`. A web pane's page cannot, because it is a native `WebContentsView`
     * composited over this document — the press reaches Chromium and stops there, and the ring
     * used to sit on whatever pane it was on while the user typed into the page. (The Swift app
     * has no gap, and not by first responder: a click recogniser on the pane's container view
     * reports the gesture itself — `PaneFocusView.swift:35-49` →
     * `SurfaceView.paneFocusedNotification` → `ContentView`'s `.focusPane`. First responder is
     * the TERMINAL's path there, which is why the port's weaker signal needs filtering.)
     *
     * So the shell reports the gesture (`webContents` `focus`, filtered against the two things
     * that fire it and are not the user: its own focus claim, and a committing navigation —
     * `webhost/view-focus.ts`), the daemon fans it out, and this listener runs the
     * SAME path a terminal body click runs: `onTerminalFocus`, i.e. `act.focusPane`. One path
     * means the consequences follow for free — pane-scoped keybindings retarget, the header
     * badge lights, the palette's §10.4 handoff comes back here — rather than a second focus
     * mechanism that has to be kept in step with the first.
     *
     * The caret release before it is the N19/N20 half: the DOM heard nothing, so the pane that
     * is losing focus still holds `document.activeElement` (a terminal's hidden textarea, an
     * editor's field). Left alone, the next keystroke after the renderer gets focus back would
     * go to a pane that no longer wears the ring.
     */
    useEffect(() => {
        const off = runtime.connection.on('message', (message) => {
            const focus = parseViewFocusMessage(message);
            if (focus === null || !viewFocusAppliesHere(focus, shellWindowID)) return;
            // The click can only have landed on a view this window is showing, so a report for
            // another workspace is stale (a switch raced it) — acting on it would move the ring
            // to a pane that is not on screen.
            if (selectActiveWorkspaceID(store.getState()) !== focus.workspaceID) return;
            releaseFocusedPaneCaret();
            onTerminalFocus(focus.paneID);
        });
        return off;
    }, [onTerminalFocus, runtime, shellWindowID, store]);

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
            // The ghostty file's five appearance keys (SET-039…041). A separate verb because it
            // is a separate file — one ghostty owns and the daemon only borrows from.
            setGhosttySetting: (key, value) =>
                void run('Change appearance', commands.setGhosttySetting({ key, value })),
            setProfiles: (profiles) => void run('Save profiles', commands.setProfiles({ profiles })),
            setRemoteDaemons: (daemons) => void run('Save remote daemons', commands.setRemoteDaemons({ daemons })),
            addLabelPreset: (input) => void run('Add label preset', commands.addLabelPreset(input)),
            updateLabelPreset: (input) => void run('Update label preset', commands.updateLabelPreset(input)),
            removeLabelPreset: (id) => void run('Delete label preset', commands.removeLabelPreset({ id })),
            moveLabelPreset: (input) => void run('Reorder label presets', commands.moveLabelPreset(input)),
            // Settings ▸ Repositories (§GIT-065…§GIT-072). A registry change lands as a
            // `repos-changed` delta, so nothing here caches a list — the tab re-renders from
            // the mirror the way every other settings surface does.
            addRepo: (input) => void run('Add repository', commands.addRepo(input)),
            removeRepo: (input) => void run('Remove repository', commands.removeRepo(input)),
            renameRepo: (input) => void run('Rename repository', commands.renameRepo(input)),
            scanRepos: (input) => void run('Scan for repositories', commands.scanRepos(input))
        }),
        [commands, run]
    );

    // H13: `SettingsView.swift:13` opens the window on `.general`. Every route that does not
    // deep-link a tab (⌘,, the ••• menu, the palette, the sidebar's Settings…) lands there.
    const openSettings = useCallback((tab: SettingsTabID = DEFAULT_SETTINGS_TAB): void => {
        setSettingsTab(tab);
    }, []);

    /**
     * Closing hands the keyboard back to the pane the user came from — the same choreography
     * the palette follows (§10.4). Without it the window is left with focus on a button that
     * no longer exists, and the next keystroke goes nowhere.
     */
    const closeSettings = useCallback((): void => {
        setSettingsTab(null);
        handBackPaneCaret(selectFocusedPaneID(store.getState()));
    }, [handBackPaneCaret, store]);

    // ── favicon / tab badge ─────────────────────────────────────────────────────────

    const faviconRef = useRef<FaviconController | null>(null);
    useEffect(() => {
        const controller = createFaviconController({ title: 'Kelpi' });
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

    /**
     * N14 — the shell's File ▸ Close (⌘W) routes THROUGH this page rather than closing the
     * window, exactly as `KeyBinding.swift:285-296` keeps `close_pane` out of the menu-bar set
     * so the Swift's own monitor always wins. `request()` replays the chord into the dispatcher
     * below; the shell closes the window only if that answers "nothing to close".
     */
    const shellClose = useMemo(
        () => createShellCloseBridge({ replay: () => replayChordCommand(CLOSE_PANE_CHORD_COMMAND) }),
        []
    );
    useEffect(() => installShellCloseBridge(shellClose), [shellClose]);

    const keyActions = useMemo<KeyActionRegistry>(
        () => ({
            split_right: () => act.splitFocused('horizontal'),
            split_down: () => act.splitFocused('vertical'),
            // The mark is N14's double-close guard: a menu-routed ⌘W that lands on the heels of
            // this one is answered "already handled" instead of taking a second pane.
            close_pane: () => {
                const closed = act.closeFocused();
                if (closed !== false) shellClose.noteKeyboardClose();
                return closed;
            },
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
            // §3.13 / §7.14: ⌘F routes by pane type — a markdown/diff pane's own find bar, or
            // the daemon-backed scrollback search for a terminal (TERM-113).
            // A web pane's find is its own (the marks live in a page the host owns), so it is
            // tried first; every other pane type falls through to the content/terminal split.
            toggle_search: () => webAct.openFind() || act.toggleSearch(),
            // Conditional binding: Escape only belongs to the search while one is OPEN, so an
            // idle Escape falls straight through to the terminal (TERM-115).
            close_search: () => act.closeSearch(),
            reopen_closed_pane: () => act.reopenClosedPane(),
            create_scratchpad: () => act.createScratchpad(),
            // CONT-120 / APP-020. Default ⌘O, and the File menu's "Preview Markdown…" reaches
            // the same handler through the shell's `menu-command` relay.
            open_file: () => act.openFile(),
            toggle_sync_input: () => act.toggleSyncInput(),
            command_palette: () => act.togglePalette(),
            toggle_sidebar: () => act.toggleSidebar(),
            toggle_inspector: () => act.toggleInspector(),
            new_workspace: () => act.newWorkspace(),
            next_workspace: () => act.switchRelative(1),
            previous_workspace: () => act.switchRelative(-1),
            // The four actions this registry used to advertise and not dispatch (index gap #6):
            // §SET-144/§APP-019, §SET-153, §SET-145/§APP-021/§WEB-154 and §CONT-133. Each has a
            // gesture elsewhere (the sidebar footer, the row menu, the header globe); these are
            // the keyboard halves, and each falls through when its precondition is unmet.
            new_group: () => act.newGroupWithRename(),
            rename_workspace: () => act.beginRenameActiveWorkspace(),
            open_web_pane: () => act.newWebPaneFocused(),
            open_diff: () => act.openDiffForFocusedPane(),
            // The `web_*` family (WEB-154/WEB-155). All ship unbound; each is a no-op unless
            // the focused pane is a web pane, and `web_tab_close` additionally needs a second
            // tab — so an unmet condition falls through instead of swallowing the chord.
            web_focus_url_bar: () => webAct.run((pane) => webAct.focusURLBar(pane.paneID)),
            web_back: () => webAct.run((pane) => webAct.back(pane.paneID)),
            web_forward: () => webAct.run((pane) => webAct.forward(pane.paneID)),
            web_reload: () => webAct.run((pane) => webAct.reload(pane.paneID)),
            web_tab_new: () => webAct.run((pane) => webAct.newTab(pane.paneID)),
            web_tab_close: () => {
                const pane = webAct.focusedWebPane();
                if (pane === null) return false;
                // §WEB-013: the Swift reducer turns a single-tab close into `closePane` (the
                // WIRE keeps refusing it and names `kelpi pane close` instead — a CLI that closes
                // a pane when it was asked to close a tab is a different contract). So the GUI
                // is where the last tab becomes a pane close, exactly as the reducer has it.
                if (pane.tabCount <= 1 || pane.tabID === null) return act.closePane(pane.paneID);
                webAct.closeTab(pane.paneID, pane.tabID);
                return true;
            },
            web_tab_prev: () => webAct.run((pane) => webAct.cycleTab(pane.paneID, -1)),
            web_tab_next: () => webAct.run((pane) => webAct.cycleTab(pane.paneID, 1)),
            web_zoom_in: () => webAct.run((pane) => webAct.zoom(pane.paneID, 'in')),
            web_zoom_out: () => webAct.run((pane) => webAct.zoom(pane.paneID, 'out')),
            web_zoom_reset: () => webAct.run((pane) => webAct.zoom(pane.paneID, 'reset')),
            ...workspaceSwitchHandlers((index) => act.switchToIndex(index))
        }),
        [act, webAct, shellClose]
    );

    const keyActionsRef = useRef(keyActions);
    useEffect(() => {
        keyActionsRef.current = keyActions;
    }, [keyActions]);

    /** Read inside the dispatcher's predicates, which are built once and must not go stale. */
    const settingsOpenRef = useRef(settingsTab !== null);
    settingsOpenRef.current = settingsTab !== null;
    const helpOpenRef = useRef(helpOpen);
    helpOpenRef.current = helpOpen;
    /** §WS-075's create sheet is modal too — same gate, same reason (see `createSheetOpen`). */
    const createSheetOpenRef = useRef(createSheetOpen);
    createSheetOpenRef.current = createSheetOpen;
    // SET-187's input, as a ref: the dispatcher is installed once and must see the CURRENT
    // global hotkey, not the one that was configured when it was built.
    const globalHotkeyRef = useRef(settings.general.globalHotkey);
    globalHotkeyRef.current = settings.general.globalHotkey;
    /**
     * SET-186 / APP-109 — Escape clears a sidebar multi-selection before any binding lookup.
     *
     * The sidebar fills this while it is mounted (`SidebarProps.escapeRef`): it is the only
     * place that knows both whether a selection exists and whether one of its own overlays is
     * up and should eat the key instead. Assembly's whole part is to hold the ref and ask.
     */
    const sidebarEscapeRef = useRef<(() => boolean) | null>(null);

    /**
     * N14's named residual — ⌘W while a modal overlay owns the keyboard.
     *
     * Before this, step 1 declined the chord, `__kelpiShellClosePane()` answered `false`, and the
     * shell's Close row did the only other thing it knows: it closed the WINDOW. The Swift is no
     * help as a spec — its monitor stands down for the palette too (`NexCommands.swift:200-203`)
     * and `CommandPaletteView.swift:92-105` binds only ↑ / ↓ / Escape, so what happens there is
     * whatever SwiftUI's default File ▸ Close does, which nothing chose. The port states the
     * decision instead: **⌘W closes the topmost closeable overlay, and never the window.**
     *
     * The overlays are mutually exclusive in practice (this same guard is what stops one being
     * opened over another), so the order below is a tie-break rather than a z-order. Each closes
     * exactly the way its own dismiss does, focus handoff included — a window left with the caret
     * on an element that no longer exists types nowhere (the reason `closeSettings` and the Help
     * overlay hand off, §10.4).
     *
     * **Two are deliberately consumed-but-not-closed**, and returning `true` for them is the
     * point: the chord is answered, so the shell's window fallback never runs.
     *
     *   - **Settings**, because its key recorder must be able to record ⌘W. `KeybindingsTab`
     *     arms a capture listener on `window` while a row is recording *precisely* because the
     *     overlay gates the dispatcher, and closing the overlay out from under it would fight
     *     the one gesture the surface exists for. (Our `stopPropagation` does not silence that
     *     listener — same node, registered later — so recording keeps working unchanged.)
     *     Escape and the close button are still its dismiss; ⌘W is a no-op there.
     *   - **The sidebar's create sheet**, because this assembly cannot close it (the sidebar
     *     owns that state; `onCreateSheetOpenChange` only reports it up) — and a swallowed ⌘W is
     *     what AppKit does under a sheet anyway, where File ▸ Close is disabled.
     */
    const closeModalOverlay = useCallback((): boolean => {
        const handOff = (): void => {
            handBackPaneCaret(selectFocusedPaneID(store.getState()));
        };
        // Consumed, not closed — see the two cases in the header.
        if (createSheetOpenRef.current || settingsOpenRef.current) return true;
        if (store.getState().ui.palette.open) {
            store.getState().setPaletteOpen(false);
            handOff();
        } else if (helpOpenRef.current) {
            setHelpOpen(false);
            handOff();
        } else {
            return false; // no overlay after all (a state change raced the keystroke)
        }
        /*
         * The same mark a keyboard `close_pane` leaves. If the native accelerator fires anyway
         * after this preventDefault — a Chromium/AppKit redispatch detail that is not observable
         * from in here — the menu-routed request that follows must not then take a PANE as well.
         */
        shellClose.noteKeyboardClose();
        return true;
    }, [handBackPaneCaret, store, shellClose]);

    // The dispatcher is rebuilt whenever the daemon's `keybind` lines change: `clientKeyBindings`
    // is the seam, `@kelpi/core/config` resolves the same overrides the daemon parsed, and the
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
            isPaletteOpen: () =>
                store.getState().ui.palette.open ||
                settingsOpenRef.current ||
                helpOpenRef.current ||
                createSheetOpenRef.current,
            // N14's residual: the one chord that guard does NOT hand to the overlay's text field.
            onCloseChordWhileModal: closeModalOverlay,
            // §1.7: while a REMOTE workspace fills the area, the local pane keymap stands
            // down — a ⌘D here must not split the hidden local workspace. The remote grid's
            // header buttons carry those gestures; chords fall through to the terminal.
            hasActiveWorkspace: () =>
                remoteSelectionRef.current === null && selectActiveWorkspace(store.getState()) !== null,
            // §7.2 step 2 (SET-186 / APP-109). Returning false leaves Escape to the normal
            // lookup, which is `close_search` by default.
            onEscape: () => sidebarEscapeRef.current?.() ?? false,
            /*
             * SET-187 — never dispatch an in-app binding that shadows the system-wide hotkey.
             *
             * Electron's `globalShortcut` consumes the combo at the OS level, so this layer is
             * belt-and-braces exactly as the Swift monitor's was on top of Carbon; it matters
             * when the OS registration was REFUSED (another app owns the combo, SET-083), where
             * the app would otherwise be the only thing that reacts to a hotkey the user
             * believes is global. Read through a ref so a re-recorded hotkey applies without
             * rebuilding the dispatcher.
             */
            globalHotkey: () => {
                const configured = globalHotkeyRef.current;
                return configured === null || configured === '' ? null : parseKeyTrigger(configured);
            },
            // §7.3 / TERM-156: a web pane's browser shortcuts run BEFORE the binding lookup, so
            // every other pane type keeps the global defaults on ⌘W / ⌘R / ⌘= and friends.
            webPanePriority: (trigger, event) => webPriorityRef.current(trigger, event)
        });
        return installKeyDispatcher(window, dispatcher);
    }, [store, keybindLines, closeModalOverlay]);

    /**
     * ⌘, opens Settings — the platform convention, and NOT a `KelpiAction`: the Swift app reaches
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
            // Both halves, like `createKeyDispatcher`'s `consume`: `preventDefault` alone stops
            // the browser's default but NOT the terminal engine's own keydown listener, so the
            // character still reaches the PTY (the audit caught this with ⌘? typing "?" into a
            // shell).
            event.preventDefault();
            event.stopPropagation();
            setSettingsTab((current) => (current === null ? DEFAULT_SETTINGS_TAB : current));
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [keybindLines]);

    /**
     * ⌘? / ⌘/ opens Help (APP-027). Same reasoning as ⌘, above: `HelpCommands` in the Swift app
     * binds ⌘? through the OS menu bar and there is no `open_help` among §4's 51 actions, so
     * inventing one would write a line the shipped app cannot parse. It therefore lives outside
     * the binding map and yields whenever the user's own map claims that key.
     *
     * Both ⌘/ and ⌘? (which is ⇧ of the same physical key) are accepted — the Swift shortcut is
     * declared as `?`, and a user pressing the key they see on the keycap should not have to
     * know which one the app meant.
     */
    useEffect(() => {
        const bindings = clientKeyBindings(keybindLines);
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.code !== 'Slash' || !event.metaKey || event.ctrlKey || event.altKey) return;
            const trigger = triggerFromEvent(event);
            if (trigger !== null && actionForTrigger(bindings, trigger) !== null) return;
            event.preventDefault();
            event.stopPropagation();
            setHelpOpen((open) => !open);
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [keybindLines]);

    /**
     * The shell's native menu bar, arriving the long way round: shell → daemon → every client,
     * and only the UI running in the named window acts (`ws/desktop.ts`). It is the mirror of
     * the reveal listener above, and exists for the same reason — no preload, so the daemon is
     * the only channel between the main process and this page.
     */
    useEffect(() => {
        const off = runtime.connection.on('message', (message) => {
            if (!isRecord(message) || message['type'] !== 'menu-command') return;
            const windowID = message['windowID'];
            if (typeof windowID === 'string' && windowID !== shellWindowID) return;
            const command = message['command'];
            if (command === 'help') setHelpOpen(true);
            else if (command === 'open-file') actRef.current.openFile();
            else if (command === 'settings') setSettingsTab((current) => current ?? DEFAULT_SETTINGS_TAB);
            // §WS-001: View ▸ Show/Hide Sidebar. It lands on the SAME `act.toggleSidebar` the
            // ⌘⇧S binding and the top-bar button use, so the menu item and the chord are one
            // state, and the shell never has to know whether the sidebar is out.
            else if (command === 'toggle-sidebar') actRef.current.toggleSidebar();
            // §APP-025 / §WS-152: View ▸ Toggle Inspector, the same shape one row down — ⌘I,
            // the top-bar button, the ••• menu's Show/Hide Inspector and this row are four
            // gestures onto one piece of client-local state.
            else if (command === 'toggle-inspector') actRef.current.toggleInspector();
            // §APP-018: File ▸ New Workspace. It opens the SHEET, exactly as ⌘N does inside the
            // page — the main process never creates a workspace of its own.
            else if (command === 'new-workspace') actRef.current.newWorkspace();
            /*
             * §WS-151: the rest of the shipped app's File group. Each row lands on the SAME
             * `act.*` its keybinding does — ⌘⇧G, ⌘⇧O, ⌘P and ⌘1…⌘9 — so a menu click and a
             * chord are one gesture by two routes, and neither can drift from the other.
             *
             * `switch-workspace-N` is parsed with the shell's own parser rather than a second
             * regex here, so the two sides cannot disagree about the format they share.
             */
            else if (command === NEW_GROUP_COMMAND) actRef.current.newGroupWithRename();
            else if (command === NEW_WEB_PANE_COMMAND) actRef.current.newWebPaneFocused();
            else if (command === COMMAND_PALETTE_COMMAND) actRef.current.togglePalette();
            // The two menu-only rows: no binding in the Swift, so none here either.
            else if (command === SELECT_ALL_WORKSPACES_COMMAND) actRef.current.selectAllWorkspaces();
            else if (command === DESELECT_ALL_WORKSPACES_COMMAND) actRef.current.deselectAllWorkspaces();
            else if (typeof command === 'string' && switchWorkspacePosition(command) !== null) {
                // ⌘1…⌘9 by another route. `switchToIndex` is 0-based over the sidebar's visible
                // order — the same resolution `switch_to_workspace_N` uses, so the row and the
                // chord always land on the same workspace.
                actRef.current.switchToIndex((switchWorkspacePosition(command) as number) - 1);
            }
            /*
             * §APP-028 / §SET-194: Debug ▸ Seed Test Group, a row the shell only builds in a dev
             * build (`shell/src/menu.ts` ▸ `debugMenuSection`). The fixture is composed out of
             * the ordinary create verbs (`app/seed-test-group.ts`).
             *
             * …and the view stays put, which needs a word. The Swift seed appends reducer state
             * directly and never touches `activeWorkspaceID`: the group appears and the user
             * stays where they were. Composing it out of `workspace-create` cannot inherit that,
             * because the daemon deliberately broadcasts a REVEAL for every workspace it creates
             * (`handlers/app/workspaces.ts` ▸ `revealCreatedWorkspace`, the run-B L3 fix, so a
             * `kelpi workspace create` from a terminal cannot leave the window behind).
             *
             * So the two reveals this gesture is about to cause are declined BEFORE they arrive
             * rather than undone afterwards — undoing loses the race, since the create's reply
             * is sent before its broadcast and an "activate what I came from" written in the
             * reply's own microtask is simply overwritten by the reveal that follows it. The
             * suppression is one-shot, expires, and is keyed on the exact workspace ids this
             * seed made, so nothing else's reveal can be swallowed by it.
             */
            else if (command === SEED_TEST_GROUP_COMMAND) {
                const pendingReveals = suppressedReveals.current;
                void seedTestGroup({
                    commands: {
                        createGroup: (input) => commands.createGroup(input),
                        createWorkspace: (input) => commands.createWorkspace(input),
                        // `group-create` is fire-and-forget on the wire and settles as a bare
                        // `{ok:true}` (`ws/sync.ts`), so the group's id is read back rather than
                        // assumed — see the module note.
                        listGroups: () => commands.listGroups()
                    },
                    onWorkspaceCreated: (workspaceID) => {
                        suppressReveal(pendingReveals, workspaceID);
                    },
                    onFailure: (title, message) => notifyFailureRef.current(title, message)
                });
            }
            // A browser chord an embedded page swallowed, relayed back by the shell
            // (`shell/webhost/keys.ts`). Replayed as a real `keydown`, so the page-focused path
            // and the chrome-focused path go through the very same interceptor.
            else if (typeof command === 'string') replayChordCommand(command);
        });
        return off;
    }, [runtime, shellWindowID]);

    // ── palette ─────────────────────────────────────────────────────────────────────

    /**
     * The binding map the chrome shows hints from. It is the SAME map the interceptor resolves,
     * built from the daemon's `keybind` lines, so a rebound ⌘P is reflected in the palette row
     * rather than the hint claiming a shortcut that no longer fires.
     */
    const bindings = useMemo(() => clientKeyBindings(keybindLines), [keybindLines]);
    const hint = useCallback(
        (action: KelpiAction): string | undefined => shortcutForAction(bindings, action),
        [bindings]
    );

    /**
     * H9 — the chord set a content pane's sandboxed frame hands back.
     *
     * A markdown/diff preview is a cross-origin iframe, so its keydowns never reach the
     * dispatcher installed on this window, and every pane binding died the moment a preview
     * took focus. The Swift has no boundary to cross (`NexCommands.swift:142-155` monitors
     * `NSEvent` for whatever holds first responder, `WKWebView` included), so the frame is
     * given the same map the dispatcher resolves and relays exactly the chords it claims —
     * nothing else, so a ⌘C inside the document still copies its selection.
     *
     * ⌘, and ⌘/ ⌘? ride along because they are dispatched by their own window listeners here
     * (in the Swift they are OS menu-bar items, which fire from any responder). `8/…` is the
     * `chordKey` bitmask for ⌘, `12/…` for ⇧⌘.
     */
    const contentPaneChords = useMemo(
        () => [...new Set([...chordKeysForBindings(bindings), '8/Comma', '8/Slash', '12/Slash'])].sort(),
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
                'cmd:reopen-closed-pane',
                'terminal',
                'Reopen Closed Pane',
                'restore the last pane closed in this workspace',
                () => act.reopenClosedPane(),
                hint('reopen_closed_pane')
            ),
            paletteCommand(
                'cmd:new-scratchpad',
                'note',
                'New Scratchpad',
                'an unsaved note pane, split off the focused one',
                () => act.createScratchpad(),
                hint('create_scratchpad')
            ),
            paletteCommand(
                'cmd:search-pane',
                'terminal',
                'Find in Pane…',
                'search the focused pane’s scrollback',
                () => act.toggleSearch(),
                hint('toggle_search')
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
                    openSettings();
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
            /*
             * A command item has ALREADY run by the time this is called — `CommandPalette`'s
             * own `confirm` invokes `item.run?.()` and its unit test pins that. This branch
             * used to call it a second time, so a single ⌘P → Enter fired every palette
             * command twice: "New Scratchpad" made two panes (measured live in the audit's
             * `scratchpad-create` step — `1 → 3, 2 scratchpad(s)`), "Split Right" split twice,
             * and any toggle looked inert because the second call undid the first. It survived
             * since `1628def` because neither side's tests count effects: the component's pass
             * a mock `onConfirm`, and the App's palette tests assert routing, not repetition.
             */
            if (item.kind === 'command') return;
            if (item.workspaceID === null) return;
            // §8.5 ordering: activate the workspace, then focus the pane.
            //
            // §APP-037 / §WS-100: activation queues the sidebar's scroll target, so a workspace
            // that was off-screen (or inside a collapsed group) scrolls into view rather than
            // being activated somewhere the user cannot see.
            activateWorkspaceAndReveal(item.workspaceID);
            if (item.paneID !== null) runtime.focusPane(item.workspaceID, item.paneID);
        },
        [activateWorkspaceAndReveal, runtime, store]
    );

    const onFocusHandoff = useCallback(
        (paneID: string | null): void => {
            if (paneID === null) return;
            /*
             * §10.4 hands the caret back to THE focused pane. For Escape, a backdrop click and
             * a jump the confirm has already performed, that is `paneID` — the target the
             * palette captured when it closed.
             *
             * N19: it is not `paneID` when the command the palette ran MOVED focus. "New
             * Scratchpad" creates a pane and focuses it, and the target was captured 200 ms
             * earlier — before the new pane existed — so the handoff would take the caret out
             * of the fresh scratchpad and put it back in the terminal it was split from. The
             * client's own focused pane is the authority; the captured id is only the
             * fallback for the window that has not answered yet.
             */
            const target = selectFocusedPaneID(store.getState()) ?? paneID;
            act.focusPane(target);
            handBackPaneCaret(target);
        },
        [act, handBackPaneCaret, store]
    );

    // ── status footer ───────────────────────────────────────────────────────────────

    const bucketItems = useCallback(
        (agentBucket: AgentBucket): readonly StatusBarItem[] => statusItems(daemon.state.workspaces, agentBucket),
        [daemon.state.workspaces]
    );

    /** WS-108's input: agents (visible AND parked panes) a workspace delete would terminate. */
    const workspaceAgentCount = useCallback(
        (workspaceID: string): number => {
            const target = daemon.state.workspaces.find((candidate) => candidate.id === workspaceID);
            return target === undefined ? 0 : activeAgentCount(target);
        },
        [daemon.state.workspaces]
    );

    const onSelectStatusPane = useCallback(
        (targetWorkspaceID: string, paneID: string): void => {
            // §WS-100: the menu-bar popover is one of the paths the Swift names explicitly.
            activateWorkspaceAndReveal(targetWorkspaceID);
            runtime.focusPane(targetWorkspaceID, paneID);
            // §APP-076: the popover row is a button that is about to unmount, so the caret has
            // to be handed to the destination explicitly — the same handoff the palette and the
            // Settings close path make, and without it typing after a jump goes nowhere until
            // the user clicks. Twice on purpose: now for a jump inside this workspace (the host
            // is already mounted), and again after the next frame for a jump that crosses
            // workspaces, where the destination pane does not exist yet.
            handBackPaneCaret(paneID);
            const soon = globalThis.requestAnimationFrame;
            const again = (): void => handBackPaneCaret(paneID);
            if (typeof soon === 'function') soon(again);
            else setTimeout(again, 0);
        },
        [activateWorkspaceAndReveal, handBackPaneCaret, runtime]
    );

    /**
     * The footer's gauge row (APP-078…085): the daemon's latest `system-stats` broadcast joined
     * to the settings that shape it. `null` until the sampler has actually spoken — the footer
     * then renders no gauges at all, which is the honest thing to draw when nothing has told us
     * what the machine is doing (a 0 % CPU would be a fabrication).
     */
    const statsView = useMemo<SystemStatsView | null>(() => {
        if (!kelpi.systemStats.loaded) return null;
        return {
            stats: kelpi.systemStats.stats,
            history: kelpi.systemStats.history,
            intervalMs: kelpi.systemStats.intervalMs,
            showSystemStats: settings.chrome.showSystemStats,
            enabled: settings.chrome.enabledSystemStats,
            showGraphs: settings.chrome.showSystemStatGraphs,
            graphStyle: settings.chrome.sparklineStyle,
            graphColor: settings.chrome.sparklineColor,
            graphWidth: settings.chrome.sparklineWidth
        };
    }, [kelpi.systemStats, settings.chrome]);

    // ── pane context menu (TERM-106…TERM-111) ───────────────────────────────────────

    /** "Rename…" opens the header's own inline field (TERM-112's accepted divergence). */
    const [renameRequest, setRenameRequest] = useState<{ paneID: string; seq: number } | null>(null);
    const startPaneRename = useCallback((paneID: string): void => {
        setRenameRequest((current) =>
            current?.paneID === paneID ? { paneID, seq: current.seq + 1 } : { paneID, seq: 1 }
        );
    }, []);

    /**
     * §TERM-103: the markdown header's copy button. Same token shape as the rename field — the
     * menu belongs to the content frame (rich text needs its iframe), so the header asks and
     * the frame opens; asking twice re-opens it after the first menu was dismissed.
     */
    const [copyRequest, setCopyRequest] = useState<{ paneID: string; seq: number } | null>(null);
    const onCopyDocument = useCallback((paneID: string): void => {
        setCopyRequest((current) =>
            current?.paneID === paneID ? { paneID, seq: current.seq + 1 } : { paneID, seq: 1 }
        );
    }, []);

    const onPaneContextMenu = useCallback(
        (paneID: string, event: { clientX: number; clientY: number }): void => {
            setPaneMenu({ paneID, ...menuAnchorFromEvent(event) });
        },
        []
    );

    /**
     * The header's right-click menu, item for item from `PaneHeaderView.swift:353-364`:
     * Rename…, Close Pane (destructive), Split Right, Split Down, New Web Pane, Status ▸
     * (shell panes only, current value checkmarked), Move to Workspace ▸ (every OTHER
     * workspace), Exclude/Include in Sync (only while the workspace's sync is on), Open in
     * Finder, Copy Working Directory.
     *
     * Two deliberate differences, both stated where they happen: "Rename…" opens the header's
     * INLINE field rather than a sheet (TERM-112's accepted divergence — the field is already
     * the port's rename affordance), and "Open in Finder" is hidden outside the Electron shell,
     * because a browser tab has no file manager to reveal into and an item that silently does
     * nothing is worse than an absent one.
     */
    const paneMenuItems = useMemo<readonly MenuItemSpec[]>(() => {
        if (paneMenu === null) return [];
        const pane = paneByID.get(paneMenu.paneID);
        if (pane === undefined) return [];
        const paneID = pane.id;
        const others = daemon.state.workspaces.filter((candidate) => candidate.id !== workspace?.id);
        const syncActive = workspace?.isSyncInputActive ?? false;
        const excluded = (workspace?.syncInputExcluded ?? EMPTY_IDS).includes(paneID);
        const items: MenuItemSpec[] = [
            {
                id: 'rename',
                label: 'Rename…',
                onSelect: () => startPaneRename(paneID)
            },
            { id: 'close', label: 'Close Pane', danger: true, onSelect: () => act.closePane(paneID) },
            { id: 'sep-split', label: '', kind: 'separator' },
            {
                id: 'split-right',
                label: 'Split Right',
                onSelect: () => act.splitPane(paneID, 'horizontal')
            },
            {
                id: 'split-down',
                label: 'Split Down',
                onSelect: () => act.splitPane(paneID, 'vertical')
            },
            { id: 'new-web', label: 'New Web Pane', onSelect: () => act.newWebPane(paneID) }
        ];

        // §5.10: status is a shell-only concept, so the submenu is too — the daemon's state
        // machine no-ops for anything else and an inert submenu would be a lie.
        if (pane.type === 'shell') {
            items.push(
                { id: 'sep-status', label: '', kind: 'separator' },
                {
                    id: 'status',
                    label: 'Status',
                    submenu: [
                        {
                            id: 'status-idle',
                            label: 'Idle',
                            checked: pane.status === 'idle',
                            onSelect: () => act.setPaneStatus(paneID, 'idle')
                        },
                        {
                            id: 'status-running',
                            label: 'Running',
                            checked: pane.status === 'running',
                            onSelect: () => act.setPaneStatus(paneID, 'running')
                        },
                        {
                            id: 'status-waiting',
                            label: 'Awaiting Input',
                            checked: pane.status === 'waitingForInput',
                            onSelect: () => act.setPaneStatus(paneID, 'waitingForInput')
                        }
                    ]
                }
            );
        }

        /*
         * SPACING-REVIEW S43 (OWNER-DIRECTED, 2026-08-29) — the two chrome buttons a narrow web
         * pane SHEDS, kept reachable here.
         *
         * `webpane/WebPane.tsx` ▸ `webChromeFit` drops the dev-tools button below ~272 px of
         * pane and the element-pickup button below ~244 px, so the address bar stops collapsing
         * to a 16 px stub. Shedding a control is only honest if it still has a route, and these
         * two had none anywhere else in the client: the `web_*` bindable actions cover
         * back/forward/reload/tabs/zoom/url and neither of these, and the web pane's own menus
         * are bookmarks and element pickup's destination picker.
         *
         * Added at EVERY width, not only while shed: a menu whose contents change as a pane is
         * dragged narrower is a worse affordance than a stable one, and this is also where the
         * shipped app would have put them if it had them (`PaneHeaderView.swift:353-364` is the
         * pane's own menu). A deliberate addition to that list, and the only one.
         */
        if (pane.type === 'web') {
            items.push(
                { id: 'sep-web', label: '', kind: 'separator' },
                {
                    id: 'web-batch-toggle',
                    label: 'Element Pickup',
                    onSelect: () => void webCommands.batchToggle(paneID)
                },
                {
                    id: 'web-devtools',
                    label: 'Toggle Developer Tools',
                    // Only the shell can open dev tools; in a browser the row would lie, exactly
                    // as the button it stands in for is disabled there.
                    disabled: shellWindowID === null,
                    onSelect: () => void webCommands.toggleDevTools(paneID, null)
                }
            );
        }

        if (others.length > 0) {
            items.push(
                { id: 'sep-move', label: '', kind: 'separator' },
                {
                    id: 'move-to-workspace',
                    label: 'Move to Workspace',
                    submenu: others.map((candidate) => ({
                        id: `move-${candidate.id}`,
                        label: candidate.name,
                        onSelect: () => act.movePaneToWorkspace(paneID, candidate.id)
                    }))
                }
            );
        }

        if (syncActive) {
            items.push(
                { id: 'sep-sync', label: '', kind: 'separator' },
                {
                    id: 'sync-exclude',
                    label: excluded ? 'Include in Sync' : 'Exclude from Sync',
                    onSelect: () => act.setSyncExcluded(paneID, !excluded)
                }
            );
        }

        items.push({ id: 'sep-fs', label: '', kind: 'separator' });
        if (shellWindowID !== null) {
            items.push({ id: 'reveal', label: 'Open in Finder', onSelect: () => act.revealPane(paneID) });
        }
        items.push({
            id: 'copy-cwd',
            label: 'Copy Working Directory',
            onSelect: () => act.copyWorkingDirectory(paneID)
        });
        return items;
    }, [act, daemon.state.workspaces, paneByID, paneMenu, shellWindowID, startPaneRename, webCommands, workspace]);

    /**
     * The ••• title-bar menu (APP-052/APP-053/APP-054).
     *
     * `WindowTitleBar.swift:243-251` had three rows — Settings…, a Show/Hide Inspector item
     * whose TITLE reflects the current state, a divider, then Restart Socket Server. All three
     * are here, plus the two items that only mean something inside the desktop app (Install CLI,
     * Check for Updates) and Help. The shell-only rows are omitted entirely in a browser rather
     * than shown disabled: a row that can never do anything is worse than a shorter menu.
     */
    const overflowMenuItems = useMemo<MenuItemSpec[]>(() => {
        const items: MenuItemSpec[] = [
            { id: 'settings', label: 'Settings…', onSelect: () => openSettings() },
            {
                id: 'inspector',
                label: inspectorVisible ? 'Hide Inspector' : 'Show Inspector',
                onSelect: () => act.toggleInspector()
            },
            { id: 'help', label: 'Kelpi Help', onSelect: () => setHelpOpen(true) }
        ];
        if (shellWindowID !== null) {
            items.push(
                { id: 'sep-shell', label: '', kind: 'separator' },
                { id: 'install-cli', label: 'Install CLI', onSelect: () => act.shellAction('install-cli') },
                {
                    id: 'check-updates',
                    label: 'Check for Updates…',
                    onSelect: () => act.shellAction('check-for-updates')
                }
            );
        }
        items.push(
            { id: 'sep-socket', label: '', kind: 'separator' },
            {
                id: 'restart-socket',
                label: 'Restart Socket Server',
                onSelect: () => act.restartControlServer()
            }
        );
        return items;
    }, [act, inspectorVisible, openSettings, shellWindowID]);

    /**
     * The search overlay, drawn over the pane the DAEMON says is being searched.
     *
     * `searchingPaneID` is workspace state, so a second window watching the same workspace shows
     * the bar in the same place with the same counter — and closing it in one closes it in both.
     */
    const renderPaneOverlay = useCallback(
        (paneID: string): ReactNode => {
            if (workspace === null || workspace.searchingPaneID !== paneID) return null;
            // Markdown/diff panes have their own in-frame find bar (`content/ContentFrame.tsx`);
            // this overlay is the terminal's, and the daemon only counts for a terminal.
            const pane = paneByID.get(paneID);
            if (pane === undefined || pane.type !== 'shell') return null;
            return (
                <PaneSearchOverlay
                    paneID={paneID}
                    needle={workspace.searchNeedle}
                    total={workspace.searchTotal}
                    selected={workspace.searchSelected}
                    onNeedleChange={act.setSearchNeedle}
                    onNext={() => act.stepSearch('next')}
                    onPrevious={() => act.stepSearch('prev')}
                    onClose={() => {
                        act.closeSearch();
                        handBackPaneCaret(paneID);
                    }}
                />
            );
        },
        [act, paneByID, workspace]
    );

    // ── pane bodies ─────────────────────────────────────────────────────────────────

    /**
     * A modal is up, so every embedded web view has to go back to the holder.
     *
     * A web pane's page is a native `WebContentsView` layered ON TOP of this renderer by the
     * Electron shell — it is not part of the DOM and no z-index, backdrop or `opacity` in here
     * can get above it. Left in place, a live page would keep painting over the settings window
     * or the command palette, so the pane reports itself hidden for as long as the modal is open
     * and the shell parks the view off-screen (`webpane/geometry.ts` → `shell/webhost/embed.ts`).
     * The page keeps running; only its placement is suspended.
     *
     * **UI-FIDELITY H1** — this used to be only the four modals THIS component owns state for,
     * and every other app-modal surface was missing: the shell's quit dialog, the graft swap
     * prompt, the agent-delete gate, every `ContextMenu`, the toast stack, the inspector's
     * sheets. All of them were therefore painted UNDER a live page —
     * `docs/audit/run-O/53-agent-lifecycle-quit-dialog.png` is "Quit Kelpi?" sliced at the page's
     * left edge with **Cancel entirely off-screen**, and `run-O/83-graft-swap-prompt-prompt.png`
     * is the swap prompt cut to "Kee".
     *
     * So the predicate is the assembly's own state PLUS `useAnyModalOpen()` — the registry each
     * modal surface counts itself into for as long as it is painted
     * (`chrome/modal-presence.ts`). The assembly's four stay written out because they ARE this
     * component's state; everything it cannot see (a dialog the SHELL opens, a prompt rendered
     * inside the inspector, a portal menu) registers instead, which is also why a surface added
     * later cannot be forgotten here.
     */
    const anyModalMounted = useAnyModalOpen();
    const modalOpen =
        settingsTab !== null || ui.palette.open || helpOpen || createSheetOpen || anyModalMounted;

    // ── drag-and-drop + ⌘-click (CONT-121/122, APP-103, TERM-040/041/052) ────────────

    /** Whether a file-shaped drag is over the window (the highlight; TERM-041). */
    const [dropActive, setDropActive] = useState(false);
    /**
     * `dragenter`/`dragleave` fire for every child the pointer crosses, so a plain boolean
     * flickers. Counting enters and leaves is the standard fix and the only state that survives
     * crossing a pane divider mid-drag.
     */
    const dragDepth = useRef(0);

    const onDragOver = useCallback((event: DragEvent<HTMLDivElement>): void => {
        // ALWAYS prevented, even for a drag we will refuse: Chromium's default for a file
        // dropped on a page is to NAVIGATE to it, which would replace the whole app with a text
        // file. `dropEffect` is what actually communicates the refusal to the user.
        event.preventDefault();
        const accepted = dragCarriesFile(event.dataTransfer?.types);
        if (event.dataTransfer !== null) event.dataTransfer.dropEffect = accepted ? 'copy' : 'none';
    }, []);

    const onDragEnter = useCallback((event: DragEvent<HTMLDivElement>): void => {
        event.preventDefault();
        dragDepth.current += 1;
        if (dragCarriesFile(event.dataTransfer?.types)) setDropActive(true);
    }, []);

    const onDragLeave = useCallback((): void => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDropActive(false);
    }, []);

    const onDrop = useCallback(
        (event: DragEvent<HTMLDivElement>): void => {
            event.preventDefault();
            dragDepth.current = 0;
            setDropActive(false);
            const data = event.dataTransfer;
            if (data === null) return;

            // TERM-040: a drop onto a TERMINAL types the paths instead of opening them —
            // shell-escaped and space-separated, exactly what `SurfaceView.swift:660-701` did.
            // It is the only route that handles several files, and the only one that accepts a
            // non-markdown path, because a shell can do something useful with either.
            const target = event.target;
            const host = target instanceof Element ? target.closest('[data-terminal-host]') : null;
            const terminalPaneID = host?.closest('[data-pane-id]')?.getAttribute('data-pane-id') ?? null;
            if (terminalPaneID !== null) {
                const text = terminalDropText(data);
                // TERM-041: a drag offering none of the accepted types is refused outright —
                // nothing is typed, and the window-level route is not consulted either.
                if (text === null) return;
                act.typeDroppedPaths(terminalPaneID, text);
                return;
            }

            const decision = dropDecision(data);
            if (decision.kind === 'open') act.openDroppedPath(decision.path);
            else if (decision.kind === 'reject') notifyFailure('Open file', decision.reason);
        },
        [act, notifyFailure]
    );

    /**
     * TERM-043 — pasting an image into a terminal.
     *
     * The rule is the Swift one (`GhosttyApp.swift:92-99`): only when the clipboard carries NO
     * text. The bytes go to the daemon, which writes them next to the other clipboard images and
     * types the escaped path — the file has to exist on the DAEMON's filesystem, which is where
     * the agent reading it runs, so the client cannot do this half itself.
     */
    const onPasteCapture = useCallback(
        (event: ClipboardEvent): void => {
            const data = event.clipboardData;
            if (data === null) return;
            if (data.getData('text/plain') !== '') return;
            const image = [...data.items].find((item) => item.kind === 'file' && item.type.startsWith('image/'));
            if (image === undefined) return;
            const target = event.target;
            const host = target instanceof Element ? target.closest('[data-terminal-host]') : null;
            const paneID = host?.closest('[data-pane-id]')?.getAttribute('data-pane-id')
                ?? selectFocusedPaneID(store.getState());
            if (paneID === null) return;
            const file = image.getAsFile();
            if (file === null) return;
            event.preventDefault();
            event.stopPropagation();
            actRef.current.pasteImage(paneID, file);
        },
        [store]
    );

    useEffect(() => {
        window.addEventListener('paste', onPasteCapture, true);
        return () => window.removeEventListener('paste', onPasteCapture, true);
    }, [onPasteCapture]);

    /**
     * ⌘-click a path in a terminal (CONT-122 / TERM-052).
     *
     * The cell is computed here from the host element's box and the grid the pane is rendered
     * at — both engines paint a uniform grid, and neither exposes a point-to-cell API. The
     * daemon reads the token at that cell and decides what it is (`ws/desktop.ts`).
     */
    const onRootClickCapture = useCallback(
        (event: ReactMouseEvent<HTMLDivElement>): void => {
            if (!event.metaKey || event.button !== 0) return;
            const target = event.target;
            if (!(target instanceof Element)) return;
            const host = target.closest('[data-terminal-host]');
            if (host === null) return;
            const paneID = host.closest('[data-pane-id]')?.getAttribute('data-pane-id') ?? null;
            if (paneID === null) return;
            const geometry = getPaneDimensions(paneID);
            if (geometry === null) return;
            const rect = host.getBoundingClientRect();
            const cell = cellFromPoint({
                rect,
                cols: geometry.cols,
                rows: geometry.rows,
                clientX: event.clientX,
                clientY: event.clientY
            });
            if (cell === null) return;
            event.preventDefault();
            event.stopPropagation();
            act.openTerminalTarget(paneID, cell.row, cell.col);
        },
        [act, getPaneDimensions]
    );

    const renderPane = useCallback<RenderPane>(
        (paneID, _frame, focused, renderState) => {
            const pane = paneByID.get(paneID);
            if (pane === undefined) return null;

            // Content bodies subscribe on mount and unsubscribe on unmount, so the daemon only
            // reads and watches files somebody is actually looking at (M5).
            // CONT-081: an external `$EDITOR` session turns a markdown pane into a terminal
            // for as long as the editor runs. Checked BEFORE the type switch, because the pane
            // is still a markdown pane throughout — that is what lets the daemon flip it back
            // to preview when the editor exits (CONT-091) without recreating anything.
            if (pane.externalEditorCommand !== null && mountedSet.has(paneID)) {
                return (
                    <TerminalPane
                        paneID={paneID}
                        ptyApi={runtime.pty}
                        focused={focused}
                        visible={renderState.visible}
                        // §TERM-036: the accessible name is what the header shows, not the id.
                        accessibilityName={paneDisplayTitle(pane, daemonHome)}
                        theme={paneTheme}
                        background={paneFill}
                        allowTransparency={paneTransparency}
                        {...(terminalFont.fontFamily !== null ? { fontFamily: terminalFont.fontFamily } : {})}
                        {...(terminalFont.fontSize !== null ? { fontSize: terminalFont.fontSize } : {})}
                        {...(terminalFont.paddingX !== null ? { paddingX: terminalFont.paddingX } : {})}
                        {...(terminalFont.paddingY !== null ? { paddingY: terminalFont.paddingY } : {})}
                        onFocusRequest={onTerminalFocus}
                        onDimensionsChange={onDimensionsChange}
                        reveal={null}
                        createRenderer={createRenderer}
                    />
                );
            }
            if (pane.type === 'markdown') {
                return (
                    <MarkdownPane
                        paneID={paneID}
                        content={content}
                        focused={focused}
                        visible={renderState.visible}
                        background={paneFill}
                        documentBackground={contentDocumentFill}
                        onFocusRequest={onTerminalFocus}
                        onToggleEdit={act.toggleMarkdownEdit}
                        findToken={findRequest?.paneID === paneID ? findRequest.seq : 0}
                        // §TERM-103: the header's copy button opens the frame's Copy menu.
                        copyToken={copyRequest?.paneID === paneID ? copyRequest.seq : 0}
                        findPalette={findPalette}
                        // H9: the preview is cross-origin, so it hands claimed chords back.
                        claimedChords={contentPaneChords}
                        onOpenExternalEditor={act.openExternalEditor}
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
                        background={paneFill}
                        documentBackground={contentDocumentFill}
                        onFocusRequest={onTerminalFocus}
                        findToken={findRequest?.paneID === paneID ? findRequest.seq : 0}
                        findPalette={findPalette}
                        // H9: same relay as the preview — a focused diff must still answer ⌘D.
                        claimedChords={contentPaneChords}
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
                        background={paneFill}
                        onFocusRequest={onTerminalFocus}
                    />
                );
            }
            // The one pane whose body this client cannot draw: the page lives in a native view
            // the Electron shell owns. The chrome is ours, the page area is a measured hole
            // (`webpane/WebPane.tsx`), and in a browser that hole holds an honest card.
            if (pane.type === 'web') {
                const web = workspace?.webPanes[paneID];
                // WEB-032/WEB-033/WEB-034: the ACTIVE tab's own last report. Reading it per tab
                // is what makes a switch snap to the new tab's state instead of stranding the
                // old one's bar.
                const activeWebTab =
                    (web?.tabs ?? []).find((tab) => tab.id === web?.activeTabID) ?? web?.tabs[0] ?? null;
                const nav = webUI.navStates[navStateKey(paneID, activeWebTab?.id ?? null)];
                return (
                    <WebPane
                        paneID={paneID}
                        tabs={web?.tabs ?? EMPTY_WEB_TABS}
                        activeTabID={web?.activeTabID ?? null}
                        isPrivate={web?.isPrivate ?? false}
                        loading={nav?.loading ?? false}
                        canGoBack={nav?.canGoBack ?? false}
                        canGoForward={nav?.canGoForward ?? false}
                        focused={focused}
                        visible={renderState.visible && !modalOpen}
                        embedded={shellWindowID !== null}
                        commands={webCommands}
                        onGeometry={webGeometry.report}
                        onHidden={webGeometry.hide}
                        onFocusRequest={onTerminalFocus}
                        findToken={webFindRequest?.paneID === paneID ? webFindRequest.seq : 0}
                        focusURLToken={webURLRequest?.paneID === paneID ? webURLRequest.seq : 0}
                        batch={webUI.batches[paneID] ?? null}
                        batchDestinations={batchDestinations(panes, paneID)}
                        favourites={webUI.favourites}
                        onManageFavourites={() => setSettingsTab('web')}
                    />
                );
            }
            if (pane.type !== 'shell') {
                return <ContentPanePlaceholder pane={pane} />;
            }
            if (!mountedSet.has(paneID)) {
                return <ContentPanePlaceholder pane={pane} variant="detached" />;
            }
            /*
             * SET-219 / TERM-021's terminal half. A terminal search match is shown by the
             * engine SELECTING it (`renderer.revealMatch`), so the selection colours ARE the
             * search-match colours while a search is open on this pane — which is exactly what
             * ghostty's `search-selected-background` / `-foreground` did for the Swift app.
             * Off the search path the palette is untouched, so an ordinary drag-selection keeps
             * the theme's own colours.
             */
            const searching = workspace !== null && workspace.searchingPaneID === paneID;
            const theme = searching ? searchPaneTheme : paneTheme;
            return (
                <TerminalPane
                    paneID={paneID}
                    ptyApi={runtime.pty}
                    focused={focused}
                    visible={renderState.visible}
                    // §TERM-036: the accessible name is what the header shows, not the id.
                    accessibilityName={paneDisplayTitle(pane, daemonHome)}
                    theme={theme}
                    background={paneFill}
                    allowTransparency={paneTransparency}
                    {...(terminalFont.fontFamily !== null ? { fontFamily: terminalFont.fontFamily } : {})}
                    {...(terminalFont.fontSize !== null ? { fontSize: terminalFont.fontSize } : {})}
                    {...(terminalFont.paddingX !== null ? { paddingX: terminalFont.paddingX } : {})}
                    {...(terminalFont.paddingY !== null ? { paddingY: terminalFont.paddingY } : {})}
                    onFocusRequest={onTerminalFocus}
                    onDimensionsChange={onDimensionsChange}
                    reveal={searchReveal?.paneID === paneID ? searchReveal : null}
                    createRenderer={createRenderer}
                />
            );
        },
        [
            act,
            content,
            findRequest,
            // §TERM-103: without this the frame would be frozen at the token it had when the
            // callback was last built, and the header's copy button would open nothing.
            copyRequest,
            // H9: a re-recorded keybinding has to reach a preview that is already open.
            contentPaneChords,
            searchPaneTheme,
            searchReveal,
            paneByID,
            workspace,
            mountedSet,
            runtime,
            // §TERM-036: the accessible name is home-abbreviated, so it moves with the answer.
            daemonHome,
            paneTheme,
            paneFill,
            contentDocumentFill,
            terminalFont,
            onTerminalFocus,
            onDimensionsChange,
            createRenderer,
            webCommands,
            webGeometry,
            // The web pane's own per-client state: ⌘F / ⌘L tokens, the batch session, the
            // favourites list. Omitting any of them freezes the rendered pane at the value it
            // had when the callback was last built — the find bar simply never opens.
            webFindRequest,
            webURLRequest,
            webUI,
            panes,
            shellWindowID,
            modalOpen
        ]
    );

    // ── render ──────────────────────────────────────────────────────────────────────

    const ready = daemon.hasSnapshot;
    const target = props.target ?? { url: undefined, token: undefined, fromQuery: false };

    return (
        <div
            data-testid="kelpi-app"
            data-connection={ui.connection}
            data-drop-active={dropActive ? 'true' : 'false'}
            /* `relative`: the connection banner and the toast stack position against the
               window, not against the pane grid (which is its own positioned container). */
            /* §APP-046: a COLUMN, so the title bar spans the window the way the shipped
               app's does (shell-ui.md §1's diagram: the strip is above the sidebar, not
               beside it) — and so the traffic lights drawn over its leading edge land on the
               strip rather than on the sidebar's filter field. */
            className="relative flex h-full w-full flex-col overflow-hidden"
            /* §N17: `windowFill`, not `windowBackground` — this element is the app's GROUND, the
               port's `RootChromeView` backdrop, and `RootChromeView.swift:32-39` paints that
               backdrop only while `background-opacity >= 1` ("an opaque backdrop here would
               defeat" a non-opaque window). Below 1 the token is `transparent`, so the desktop
               reaches the pane fills instead of being multiplied away by stacked 0.85 grounds. */
            style={{ background: chromeTokens.windowFill, color: chromeTokens.textPrimary }}
            onDragEnter={onDragEnter}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onClickCapture={onRootClickCapture}
        >
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
                // terminal-surface.md §5.1: the chip renders ONLY on a non-owner — a known owner that is not this
                // client. The owner (and a client with no owner known) sees nothing.
                sizeControlledElsewhere={
                    kelpi.daemon.sizeControlOwnerID !== null &&
                    kelpi.daemon.clientID !== null &&
                    kelpi.daemon.sizeControlOwnerID !== kelpi.daemon.clientID
                }
                onTakeSizeControl={() => {
                    commands.takeSizeControl();
                }}
                onToggleSidebar={act.toggleSidebar}
                sidebarVisible={sidebarVisible}
                onToggleInspector={act.toggleInspector}
                inspectorVisible={inspectorVisible}
                overflowItems={overflowMenuItems}
                // §APP-046: this strip IS the title bar inside a shell window — the shell
                // creates the window with a hidden one and draws the page up into the
                // traffic-light row, so the bar clears the buttons and takes the drag.
                trafficLightInset={trafficLightInset}
                dragRegion={shellWindowID !== null}
            />

            {/*
              * §APP-046 / shell-ui.md §1 — the middle row: sidebar | pane grid | inspector,
              * under one full-width title bar. It is a row inside a column rather than the
              * whole window being a row, which is what puts the drawn strip above the sidebar
              * instead of beside it.
              *
              * `relative` because UI-FIDELITY M53 mounts the command palette's overlay on THIS
              * row (see its block at the row's end) — the Swift hangs it off the content
              * `HStack`, not off the window.
              */}
            <div className="relative flex min-h-0 flex-1">
            {sidebarMounted ? (
                /* §WS-001: the slot animates its WIDTH (that is what the pane grid is pushed
                   by); the panel inside keeps its full width and translates, so a 220px
                   sidebar never relayouts to 3px and back on the way out. The clip lives on
                   the middle div so the resizer's ±3px overhang is not shaved off with it. */
                <div
                    data-testid="sidebar-slot"
                    data-sidebar-phase={sidebarPhase}
                    className="flex h-full shrink-0"
                    style={{ width: sidebarSlide.slot.width, transition: sidebarSlide.slot.transition }}
                >
                    {/* §N31: the clip carries the panel's own ground for the full animated width,
                        so the reveal is the sidebar's colour from the first frame rather than
                        whatever lies behind the row — `<body>`'s ground, which is `transparent`
                        (the desktop) under a window created transparent. */}
                    <div
                        data-testid="sidebar-clip"
                        className="h-full min-w-0 flex-1 overflow-hidden"
                        style={{
                            background: sidebarSlide.clip.background,
                            position: sidebarSlide.clip.position
                        }}
                    >
                    <div
                        data-testid="sidebar-panel"
                        className="h-full"
                        style={{
                            width: sidebarSlide.panel.width,
                            opacity: sidebarSlide.panel.opacity,
                            transform: sidebarSlide.panel.transform,
                            transition: sidebarSlide.panel.transition,
                            pointerEvents: sidebarSlide.panel.pointerEvents,
                            position: sidebarSlide.panel.position,
                            top: sidebarSlide.panel.top,
                            bottom: sidebarSlide.panel.bottom,
                            left: sidebarSlide.panel.left,
                            right: sidebarSlide.panel.right
                        }}
                    >
                <Sidebar
                    entries={filteredEntries}
                    remoteDaemons={settings.remoteDaemons.map((daemon) => daemon.name)}
                    onCreateRemoteGroup={(daemonName, name, color) => {
                        const held = remoteDaemonRuntimes.get(daemonName);
                        if (held === undefined) return;
                        void held.runtime.commands.createGroup({ name, ...(color !== null ? { color } : {}) });
                    }}
                    trailingSections={
                        <RemoteDaemonSections
                            daemons={[...remoteDaemonRuntimes.values()]}
                            selection={remoteSelection}
                            onSelect={setRemoteSelection}
                        />
                    }
                    activeWorkspaceID={workspace?.id ?? null}
                    filter={ui.sidebarFilter}
                    onFilterChange={(filter) => store.getState().setSidebarFilter(filter)}
                    labelPresets={daemon.state.labelPresets}
                    bucket={bucket}
                    onActivateWorkspace={act.activateWorkspace}
                    onToggleGroupCollapse={act.setGroupCollapsed}
                    onRenameWorkspace={act.renameWorkspace}
                    onDeleteWorkspace={act.deleteWorkspace}
                    // WS-108: the sidebar's confirmation becomes the agent alert when the
                    // workspace still has running agents and the daemon's setting is on.
                    activeAgentCount={workspaceAgentCount}
                    confirmDeleteWhenActive={settings.general.confirmWorkspaceDeleteWhenActive}
                    onSuppressDeleteConfirm={() => {
                        settingsActions.setGeneralSetting('confirm-workspace-delete', 'false');
                    }}
                    onToggleWorkspaceLabel={act.toggleWorkspaceLabel}
                    onMoveWorkspace={act.moveWorkspace}
                    onMoveWorkspaces={act.moveWorkspaces}
                    onSetWorkspaceIcon={act.setWorkspaceIcon}
                    onSetGroupIcon={act.setGroupIcon}
                    // §WS-049 / §WS-065: the two row-menu submenus the port was missing.
                    onSetWorkspaceProfile={act.setWorkspaceProfile}
                    onSetGroupColor={act.setGroupColor}
                    // SET-186 / APP-109: the sidebar publishes "did I consume this Escape?".
                    escapeRef={sidebarEscapeRef}
                    // §WS-151: …and its two selection verbs, for File ▸ Select/Deselect All.
                    selectionCommandsRef={sidebarSelectionRef}
                    // §WS-151's other direction: how big the selection is now, so the shell can
                    // grey File ▸ Deselect All Workspaces while it is empty. Observer only —
                    // the sidebar keeps owning the selection (no `selectedWorkspaceIDs` prop),
                    // so nothing about the existing gesture changes.
                    onSelectionChange={reportWorkspaceSelection}
                    onRenameGroup={act.renameGroup}
                    onDeleteGroup={act.deleteGroup}
                    onCreateWorkspace={(name, groupID, worktree, extras) => {
                        if (worktree === undefined) return act.createWorkspace(name, groupID, extras ?? {});
                        const repo = inspectorData.repos.find((candidate) => candidate.id === worktree.repoID);
                        if (repo === undefined) return 'that repository is no longer registered';
                        return act.createWorkspaceWithWorktree(name, groupID, worktree, repo.path, extras ?? {});
                    }}
                    onCreateGroup={act.createGroup}
                    // §WS-075/§SET-214/SET-011: the form's Profile picker and its preselected
                    // group. Both are assembly's to resolve — the sidebar renders them.
                    profiles={settings.profiles.map((profile) => profile.name)}
                    inheritGroupID={inheritGroupID}
                    scrollToWorkspaceID={scrollToWorkspaceID}
                    scrollToGroupID={scrollToGroupID}
                    onScrollHandled={() => {
                        setScrollToWorkspaceID(null);
                        setScrollToGroupID(null);
                    }}
                    // §SET-153 / §SET-144: the keyboard's "start renaming this row".
                    renameRequest={sidebarRenameRequest}
                    onRenameRequestHandled={() => setSidebarRenameRequest(null)}
                    // §APP-018 / §WS-156: ⌘N, File ▸ New Workspace, the palette and the
                    // no-workspace empty state all open THIS form.
                    createRequest={sidebarCreateRequest}
                    onCreateRequestHandled={() => setSidebarCreateRequest(null)}
                    // …and the sheet's own open/closed edge, for `modalOpen` and the key gate.
                    onCreateSheetOpenChange={setCreateSheetOpen}
                    onOpenSettings={(section) => {
                        openSettings(section === 'labels' ? 'labels' : DEFAULT_SETTINGS_TAB);
                    }}
                    onSetWorkspaceColor={act.setWorkspaceColor}
                    onSetBulkColor={act.setBulkColor}
                    onSetBulkLabel={act.setBulkLabel}
                    onCreateGroupForWorkspaces={act.createGroupForWorkspaces}
                    // §WS-052: "Move to Group ▸ New Group…" — one gesture from a row to a new
                    // group with that row already in it, then straight into inline rename.
                    onCreateGroupWithWorkspace={act.newGroupForWorkspace}
                    // §WS-004 / §WS-123: the footer chevron's "New Group" is ⌘⇧G's own gesture,
                    // not the footer form — mint the placeholder, drop into inline rename,
                    // reveal the header. Same closure the chord and File ▸ New Group run, so
                    // all three routes land on one set of rules.
                    onNewGroupWithRename={act.newGroupWithRename}
                    onDeleteWorkspaces={act.deleteWorkspaces}
                    repos={inspectorData.repos}
                />
                    </div>
                    </div>
                    {/* §WS-002: the invisible 6 px handle straddling the sidebar's edge. It is
                        rendered only at rest — mid-slide there is no edge to grab. */}
                    {sidebarPhase === 'closing' ? null : (
                        <SidebarResizer
                            width={sidebarWidth}
                            onResizeStart={() => setSidebarResizing(true)}
                            onResize={setSidebarWidth}
                            onCommit={(width) => {
                                setSidebarResizing(false);
                                storeSidebarWidth(width);
                            }}
                        />
                    )}
                </div>
            ) : null}

            <div className="flex min-w-0 flex-1 flex-col">
                <div className="relative min-h-0 flex-1">
                    {/*
                      * §APP-067 / §WS-156 — "No workspace selected".
                      *
                      * It REPLACES the grid rather than sitting over it, which is what the
                      * shipped app does (`ContentView.swift:237-249`: the `else` branch of the
                      * `if let workspace`) and what stops two empty-state placeholders — this one
                      * and the grid's own "No panes" — from being on screen at once.
                      *
                      * `ready &&` because a client with no snapshot yet has no workspace either,
                      * and the honest thing to show THERE is the connection splash below.
                      */}
                    {remoteSelection !== null && activeRemote !== null ? (
                        /* §1.7: a REMOTE daemon's workspace fills the area — same grid, that
                           daemon's mirror, PTY stream and commands (`RemoteWorkspaceView`). */
                        <RemoteWorkspaceView
                            daemonName={activeRemote.name}
                            runtime={activeRemote.runtime}
                            workspaceID={remoteSelection.workspaceID}
                        />
                    ) : ready && workspace === null ? (
                        <NoWorkspaceSelected onCreate={() => act.newWorkspace()} />
                    ) : (
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
                        // §H4: the DAEMON's home, the same value the footer gets — without it
                        // `PaneHeader` falls back to `homeDirectory = ''` and prints the raw
                        // `/Users/…` path while the footer, describing the same pane, prints
                        // `~/…` (`PaneHeaderView.swift:503` abbreviates unconditionally).
                        homeDirectory={daemon.info?.home}
                        renderPane={renderPane}
                        renderPaneOverlay={renderPaneOverlay}
                        renameRequest={renameRequest}
                        getPaneDimensions={getPaneDimensions}
                        onPaneContextMenu={onPaneContextMenu}
                        onNewWebPane={act.newWebPane}
                        onFocusPane={act.focusPane}
                        onClosePane={act.closePane}
                        onRenamePane={act.renamePane}
                        onSplitPane={act.splitPane}
                        onToggleZoom={act.toggleZoom}
                        onToggleMarkdownEdit={act.toggleMarkdownEdit}
                        onRefreshDiff={act.refreshDiff}
                        onCopyDocument={onCopyDocument}
                        onSetFontSize={act.setFontSize}
                        onRestartAgent={act.restartAgent}
                        onDwellClear={act.dwellClear}
                        /*
                         * §AGNT-056: the 600 ms clear runs only while somebody is looking, and
                         * is re-scheduled when they come back. `appActive` is the shell's
                         * `shell-activation` relay (about THIS window); `documentVisible` is the
                         * browser's own answer to the same question, for a client with no shell.
                         */
                        dwellEnabled={isAppActive(ui)}
                        onMovePane={act.movePaneAdjacent}
                        onCreatePane={act.createPane}
                        onSetRatio={(splitPath, ratio, commit) => {
                            // A divider whose two children are BOTH splits has no pane whose
                            // enclosing split it is, so `pane-resize` cannot name it (§LAY-061);
                            // it goes by split path instead, which is what the layout model and
                            // Swift's own GUI use. Everything else keeps the pane spelling, so
                            // a GUI drag and `kelpi pane resize` stay one pipeline.
                            if (commit.paneID === null) {
                                act.setSplitRatioAtPath(splitPath, ratio);
                                return;
                            }
                            act.setSplitRatio(commit.paneID, commit.share);
                        }}
                    />
                    )}
                    {ready ? null : <ConnectionSplash runtime={runtime} state={kelpi} target={target} />}
                </div>
            </div>

            {/*
              * §WS-137: the trailing inspector, scoped to the ACTIVE workspace. It is a sibling
              * of the pane column (not an overlay) so it takes width from the grid the way the
              * shipped 280 pt panel does, and it renders nothing when no workspace is active.
              *
              * §APP-066: and it SLIDES, on §WS-001's machine mirrored to the trailing edge — the
              * slot's width is what moves the grid, the panel inside keeps its full 280px and
              * translates, so the inspector's contents never reflow mid-flight. `inspectorMounted`
              * rather than `inspectorVisible` is what keeps it in the tree for the length of a
              * close; a conditional mount has nothing to transition from.
              */}
            {inspectorMounted && workspace !== null ? (
                <div
                    data-testid="inspector-slot"
                    data-inspector-phase={inspectorPhase}
                    className="flex h-full shrink-0"
                    style={{ width: inspectorSlide.slot.width, transition: inspectorSlide.slot.transition }}
                >
                    {/* §N31: the same clip fill and the same edge anchor as the sidebar's. The
                        inspector needed BOTH — its panel travels off the trailing edge while
                        flow lays it out at the clip's leading one, so the first half of every
                        slide revealed a strip the panel was not even inside. */}
                    <div
                        data-testid="inspector-clip"
                        className="h-full min-w-0 flex-1 overflow-hidden"
                        style={{
                            background: inspectorSlide.clip.background,
                            position: inspectorSlide.clip.position
                        }}
                    >
                        <div
                            data-testid="inspector-panel"
                            className="h-full"
                            style={{
                                width: inspectorSlide.panel.width,
                                opacity: inspectorSlide.panel.opacity,
                                transform: inspectorSlide.panel.transform,
                                transition: inspectorSlide.panel.transition,
                                pointerEvents: inspectorSlide.panel.pointerEvents,
                                position: inspectorSlide.panel.position,
                                top: inspectorSlide.panel.top,
                                bottom: inspectorSlide.panel.bottom,
                                left: inspectorSlide.panel.left,
                                right: inspectorSlide.panel.right
                            }}
                        >
                <Inspector
                    workspace={workspace}
                    focusedPaneID={focusedPaneID}
                    associations={inspectorData.associations}
                    repos={inspectorData.repos}
                    profiles={settings.profiles.map((profile) => profile.name)}
                    labelPresets={daemon.state.labelPresets}
                    bucket={bucket}
                    refreshing={inspectorData.refreshing}
                    onClose={act.toggleInspector}
                    onRenameWorkspace={(name) => act.renameWorkspace(workspace.id, name)}
                    onSetWorkspaceColor={(color) => act.setWorkspaceColor(workspace.id, color)}
                    onSetProfile={(profile) => act.setWorkspaceProfile(workspace.id, profile)}
                    onOpenDiff={act.openRepoDiff}
                    onOpenTerminal={act.openTerminalAt}
                    onRemoveAssociation={(associationID, deleteWorktree) => {
                        act.removeRepoAssociation(associationID, deleteWorktree);
                        // The removal lands as a delta; the git read is ours to re-run.
                        inspectorData.refresh();
                    }}
                    onAddAssociation={async (path) => {
                        const error = await act.addRepoAssociation(path);
                        if (error === null) inspectorData.refresh();
                        return error;
                    }}
                    /* §GIT-066 inside §GIT-073's picker: register what a folder holds, then
                       re-read the registry so the new rows appear in the open sheet. */
                    onScanForRepos={(path) => {
                        void commands.scanRepos({ path }).then(() => {
                            inspectorData.refresh();
                        });
                    }}
                    onCreateWorktree={async (request) => {
                        const error = await act.addWorktree(request);
                        if (error === null) inspectorData.refresh();
                        return error;
                    }}
                    onFocusPane={act.focusPane}
                    onClosePane={act.closePane}
                    /* graft: state from the hook, gestures straight into its controller. */
                    graftSessions={graft.state.sessions}
                    graftOrphans={graft.state.orphans}
                    graftSwapPrompt={graft.state.swapPrompt}
                    onToggleGraft={(association) => {
                        void graft.controller.toggle({
                            id: association.id,
                            worktreePath: association.worktreePath,
                            branch: association.branch
                        });
                    }}
                    onConfirmGraftSwap={(prompt) => {
                        void graft.controller.confirmSwap(prompt);
                    }}
                    onCancelGraftSwap={graft.controller.cancelSwap}
                    onRestoreGraftOrphan={(orphan) => {
                        void graft.controller.recoverOrphan(orphan);
                    }}
                    onDismissGraftOrphan={(orphan) => {
                        void graft.controller.dismissOrphan(orphan);
                    }}
                />
                        </div>
                    </div>
                </div>
            ) : null}

            {/*
              * UI-FIDELITY M53 — the palette is an overlay on the CONTENT ROW.
              *
              * `ContentView.swift:262-285` hangs it off the `sidebar | grid | inspector` HStack
              * with `.padding(.top, 40)`, so its card starts 40 pt below the row — 32 + 40 = 72
              * from the window's top, which clears the 24 pt pane header underneath it — and the
              * `Color.black.opacity(0.001)` hit target covers the row ALONE: the title bar and
              * the status footer stay live behind it. Mounted as a sibling of `StatusFooter` the
              * port's `absolute inset-0` measured from the window instead, which put the card at
              * 40 px (flush with the pane header, `docs/audit/run-O/104`) and swallowed both
              * strips. One level in is the whole fix; the panel's own `mt-10` is unchanged.
              */}
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
            </div>

            {/*
              * §APP-070 / UI-FIDELITY H2 — the status bar spans the WINDOW.
              *
              * `ContentView.swift:14-16, 609-610`: `StatusBarView` is a sibling of the whole
              * `sidebar | grid | inspector` HStack, so the 24 pt bar and its 1 px top divider run
              * edge to edge UNDER both side panels. The port had it nested inside the centre
              * column, which started it at the sidebar's trailing edge and stopped it at the
              * inspector's leading one — the divider stopped with it, the sidebar's own
              * "New Workspace / New Group" bar sat at the window's bottom instead of above the
              * status bar, and the row lost ~500 px of the width §N7's fitting logic then had to
              * fight over (`docs/audit/run-N/01-fresh-boot.png`).
              *
              * Hoisting it here is the whole fix: same component, same props, one level out. §N7
              * still measures the row it is actually given (`useFooterGaugeBudget` observes the
              * row, not the window), so a wider row simply affords more gauges before it starts
              * dropping them from the tail.
              */}
            <StatusFooter
                summary={agentSummary}
                focusedPane={focusedPaneID === null ? null : (paneByID.get(focusedPaneID) ?? null)}
                // §APP-071 / §GIT-092: `doc N +A -B` for the association the focused pane
                // sits in. The same rows the inspector renders, matched by longest prefix.
                associations={inspectorData.associations}
                // §APP-069: the DAEMON's home, so a cwd under it renders as `~/…`.
                {...(daemon.info?.home === undefined ? {} : { homeDirectory: daemon.info.home })}
                bucket={bucket}
                bucketItems={bucketItems}
                onSelectPane={onSelectStatusPane}
                {...(statsView === null ? {} : { systemStats: statsView })}
            />

            {ready && ui.connection !== 'connected' ? (
                <ConnectionBanner status={ui.connection} error={ui.connectionError} runtime={runtime} />
            ) : null}

            <SettingsOverlay
                open={settingsTab !== null}
                initialTab={settingsTab ?? DEFAULT_SETTINGS_TAB}
                settings={settings}
                domain={{
                    labelPresets: daemon.state.labelPresets,
                    workspaces: daemon.state.workspaces,
                    repos: daemon.state.repos
                }}
                actions={settingsActions}
                bucket={bucket}
                /* §SET-021: what the daemon's TCP listener actually did, for Settings ▸ Network. */
                transport={daemon.transport}
                /*
                 * §SET-200/§SET-201/§APP-014: the shell's registration failure, for Settings ▸
                 * Keybindings ▸ Global. Null (no error) until a shell has reported, and cleared
                 * the moment one reports success — so clearing the hotkey, or re-recording a
                 * chord that works, takes the message away without anything having to remember
                 * it was there. The rule lives in `globalHotkeyErrorFrom` rather than in this
                 * ternary because it also has to answer the case the OS gives no reason for.
                 */
                globalHotkeyError={globalHotkeyErrorFrom(hotkeyStatus)}
                onClose={closeSettings}
                web={{
                    favourites: webUI.favourites,
                    actions: {
                        renameFavourite: (id, title) => void webCommands.favouriteRename(id, title),
                        removeFavourite: (id) => void webCommands.favouriteRemove(id),
                        moveFavourite: (from, to) => void webCommands.favouriteMove(from, to)
                    }
                }}
                /* Settings ▸ Remote: the pair/devices/tailnet flow (daemon ws/remote.ts). */
                remote={{
                    status: () => commands.remoteStatus(),
                    pair: (name, tailnet) => commands.remotePair(name, tailnet),
                    revoke: (target) => commands.remoteRevoke(target)
                }}
                /*
                 * No `onBrowseForFolder`: the shell's dialog loop is one-way (it answers
                 * `open-file-dialog` by sending the chosen path back to the DAEMON as an `open`
                 * verb), so nothing can return a directory to this page today. The tab's path
                 * field is the input on every client — and the only one that can name a
                 * directory on a REMOTE daemon's filesystem anyway.
                 */
            />

            {/*
             * §AGNT-116: the ⌘Q confirmation, for the quits where the shell decides to ask HERE
             * rather than with `dialog.showMessageBox` — the only route on which Quit can be
             * painted destructive with Cancel as the default. Inert until the main process opens
             * one, so a browser tab (which no shell will ever call into) draws nothing.
             */}
            <QuitGate />

            {helpOpen ? (
                <HelpOverlay
                    bindings={bindings}
                    version={daemon.info?.version ?? 'unknown'}
                    onClose={() => {
                        setHelpOpen(false);
                        handBackPaneCaret(selectFocusedPaneID(store.getState()));
                    }}
                    onOpenKeybindings={() => {
                        setHelpOpen(false);
                        openSettings('keybindings');
                    }}
                />
            ) : null}

            {/*
              * UI-FIDELITY H20 — there is no drop overlay, deliberately.
              *
              * `ContentView.swift:598-607` takes the drop with `isTargeted: nil`: the binding
              * that would tell SwiftUI to paint something is explicitly absent, and
              * `SurfaceView.swift:660-666` returns an operation and paints nothing either. The
              * OS drag image is the whole feedback the shipped app gives, and the refusal is
              * communicated the way the OS communicates one — through `dropEffect` (`onDragOver`
              * above), which is `none` for a drag this window will not take.
              *
              * What was here was an invented full-window `#6F9BD8` wash with a 2 px dashed accent
              * border and a "Drop a .md file to open it" chip, fired on any drag carrying
              * `Files` / `text/uri-list` / `text/plain` — so it fired on plain TEXT drags, and on
              * file drags headed for a terminal pane, where its caption was simply wrong (a file
              * dropped on a terminal types its escaped path, §TERM-040). No ledger item claimed
              * it. `dropActive` survives as the classification itself, published on the root as
              * `data-drop-active` for §TERM-041's accept/refuse assertions — it paints nothing.
              */}

            {paneMenu === null || paneMenuItems.length === 0 ? null : (
                <ContextMenu
                    x={paneMenu.x}
                    y={paneMenu.y}
                    items={paneMenuItems}
                    label="Pane"
                    onClose={() => setPaneMenu(null)}
                />
            )}

            {closeGate === null ? null : (
                <AgentDeleteGate
                    name={closeGate.name}
                    activeAgents={closeGate.activeAgents}
                    onCancel={() => setCloseGate(null)}
                    onConfirm={(suppress) => {
                        if (suppress) settingsActions.setGeneralSetting('confirm-workspace-delete', 'false');
                        // §WS-156: the gate was raised BY ⌘W, so the confirmation inherits ⌘W's
                        // permission to reach zero workspaces. A gate raised anywhere else does
                        // not, and goes through the ordinary sidebar delete.
                        act.deleteWorkspace(closeGate.workspaceID, {
                            allowLast: closeGate.allowLast === true
                        });
                        setCloseGate(null);
                    }}
                    onSuppressOnly={() => {
                        settingsActions.setGeneralSetting('confirm-workspace-delete', 'false');
                    }}
                />
            )}

            <ToastStack toasts={ui.toasts} onDismiss={(id) => store.getState().dismissToast(id)} />
        </div>
    );
}

interface AgentDeleteGateProps {
    readonly name: string;
    readonly activeAgents: number;
    readonly onCancel: () => void;
    readonly onConfirm: (suppress: boolean) => void;
    /** Suppression is honoured on Cancel too (macOS HIG, `WorkspaceDeleteGate.swift:78`). */
    readonly onSuppressOnly: () => void;
}

/**
 * The active-agents delete gate (WS-108 / WS-109) — the port of `WorkspaceDeleteGate`'s NSAlert.
 *
 * Four behaviours are the alert's, not this component's invention: **Cancel is the default**
 * (Return activates it, so an accidental confirm cannot kill a live session), **Delete is
 * destructive** (red), the message names the count ("This workspace has N active agent(s)…"),
 * and **"Don't ask again" is honoured whichever button was clicked** — which is why the
 * suppression is applied on the Cancel path too.
 *
 * **UI-FIDELITY H18** — and it is a real modal now. `WorkspaceDeleteGate.swift:59-81` is
 * `alert.runModal()`: app-modal, click-through blocked, Escape = Cancel. The port drew a bare
 * `fixed left-1/2 top-1/3` panel with no scrim, no `aria-modal`, no key handling and two bare
 * coloured words for buttons — so the most destructive confirmation in the app was
 * click-through onto the live sidebar and panes, and Escape did nothing. This is
 * `QuitConfirmDialog`'s contract (`chrome/QuitConfirmDialog.tsx:228-257`), which was already
 * getting it right two components away: a 0.4 backdrop, capture-phase Escape → Cancel and
 * Return → the default (Cancel, so a stray Return cannot kill a live session), the default
 * button drawn as one, and `useModalPresence` so a live web pane's view is parked (H1).
 */
function AgentDeleteGate(props: AgentDeleteGateProps): ReactElement {
    const [suppress, setSuppress] = useState(false);
    const noun = props.activeAgents === 1 ? 'agent' : 'agents';
    const them = props.activeAgents === 1 ? 'it' : 'them';
    useModalPresence();
    /*
     * H11's fill tone, the same recipe the sidebar's `ConfirmDialog` draws: the global reset
     * strips the user-agent hover response, so without this neither button answered the pointer.
     * Delete takes the `selectionFill` wash with the border lifted to the selection stroke (its
     * red is untouched — the colour is what marks it destructive); Cancel already wears the
     * default button's accent ring and wash, so its wash deepens instead of being repainted in
     * the selection grey, which would read as losing the default state.
     */
    const [hoveredAction, bindHover] = useHoverKey();

    const { onCancel, onSuppressOnly } = props;
    const cancel = useCallback((): void => {
        if (suppress) onSuppressOnly();
        onCancel();
    }, [onCancel, onSuppressOnly, suppress]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            // Escape AND Return both take the safe answer: Cancel is the alert's default button,
            // so the key one row from ⌘W cannot confirm a destructive delete by itself.
            if (event.key !== 'Escape' && event.key !== 'Enter') return;
            event.preventDefault();
            event.stopPropagation();
            cancel();
        };
        // Capture, so a pane's own key handling cannot swallow the way out of a modal.
        globalThis.window.addEventListener('keydown', onKeyDown, true);
        return () => {
            globalThis.window.removeEventListener('keydown', onKeyDown, true);
        };
    }, [cancel]);

    return (
        <div
            data-testid="agent-delete-backdrop"
            className="fixed inset-0 z-50"
            style={{ background: 'rgba(0,0,0,0.4)' }}
            /* A destructive alert is not dismissed by a stray click on the dimming — `runModal`
               beeps at one — so the backdrop blocks the window behind and nothing else. */
            onMouseDown={(event) => {
                event.stopPropagation();
            }}
        >
            <div
                data-testid="agent-delete-gate"
                data-active-agents={String(props.activeAgents)}
                role="dialog"
                aria-modal="true"
                aria-label="Delete workspace with active agents"
                className="fixed left-1/2 top-1/3 z-50 w-[340px] -translate-x-1/2 rounded-lg p-4 text-[12px]"
                style={{
                    background: chromeTokens.surfaceBackground,
                    border: `1px solid ${chromeTokens.divider}`,
                    color: chromeTokens.textPrimary,
                    boxShadow: '0 16px 48px rgba(0,0,0,0.45)'
                }}
            >
                <div className="mb-1 font-semibold">{`Delete “${props.name}”?`}</div>
                <div className="mb-3 text-[11px]" style={{ color: chromeTokens.textSecondary }}>
                    {`This workspace has ${String(props.activeAgents)} active ${noun}. Deleting it will terminate ${them}.`}
                </div>
                <label
                    className="mb-3 flex items-center gap-2 text-[11px]"
                    style={{ color: chromeTokens.textSecondary }}
                >
                    <input
                        type="checkbox"
                        data-testid="agent-delete-suppress"
                        checked={suppress}
                        onChange={(event) => setSuppress(event.target.checked)}
                    />
                    Don&apos;t ask again
                </label>
                <div className="flex justify-end gap-2">
                    <button
                        type="button"
                        data-testid="agent-delete-cancel"
                        data-default="true"
                        autoFocus
                        className="rounded px-2 py-1"
                        {...bindHover('cancel')}
                        style={{
                            color: chromeTokens.textPrimary,
                            border: `1px solid ${chromeTokens.accent}`,
                            background:
                                hoveredAction === 'cancel' ? 'rgba(111,155,216,0.28)' : 'rgba(111,155,216,0.16)'
                        }}
                        onClick={cancel}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        data-testid="agent-delete-confirm"
                        data-destructive="true"
                        className="rounded px-2 py-1"
                        {...bindHover('delete')}
                        style={{
                            color: '#E0655C',
                            border: `1px solid ${
                                hoveredAction === 'delete' ? chromeTokens.selectionStroke : 'transparent'
                            }`,
                            background: hoverFill(hoveredAction === 'delete')
                        }}
                        onClick={() => props.onConfirm(suppress)}
                    >
                        Delete
                    </button>
                </div>
            </div>
        </div>
    );
}

// ── connection surfaces ─────────────────────────────────────────────────────────────

const SPLASH_TITLE: Readonly<Record<string, string>> = {
    idle: 'Connecting to kelpid…',
    connecting: 'Connecting to kelpid…',
    connected: 'Loading workspaces…',
    reconnecting: 'Reconnecting to kelpid…',
    closed: 'Disconnected from kelpid',
    rejected: 'The daemon refused this connection'
};

const SPLASH_HINT: Readonly<Record<string, string>> = {
    idle: '',
    connecting: '',
    connected: 'the daemon accepted the handshake; waiting for the first state snapshot',
    reconnecting: 'the socket dropped — retrying with backoff',
    closed: 'nothing is listening; start it with `kelpid start`',
    // A rejection is almost always a missing/stale token, and there is exactly one command that
    // produces a working link — so name it rather than describing the problem in the abstract.
    rejected: 'open this page from `kelpid url`, which includes the daemon token'
};

/**
 * §APP-067 / §WS-156 — the detail area with no active workspace.
 *
 * `ContentView.swift:237-249`, one for one: a 48pt terminal glyph at the faintest tint, "No
 * workspace selected" in secondary text, and a "Create Workspace" button that raises the new
 * workspace sheet (`showNewWorkspaceSheet()`, which here is §APP-018's `act.newWorkspace`).
 *
 * It is a real state, not a decoration. ⌘W on the last pane of the last workspace deletes that
 * workspace (§TERM-077 / §WS-109's rule, which the shipped app also lets reach zero) and this is
 * what the window lands on — a window with no workspaces and no way back would otherwise be a
 * dead end, which is exactly why the Swift put a button in it.
 *
 * L30 — three metrics that had drifted from those ten Swift lines, all pulling the same way:
 * this placeholder was louder than the shipped one.
 *
 *  - **Spacing 8, not 12.** `VStack(spacing: 8)` (`ContentView.swift:238`). The one at 12 is the
 *    GRID's "No panes" placeholder (`PaneGridView.swift:493`); the two are deliberately different
 *    sizes and the port had run them together.
 *  - **The glyph is `.quaternary`** (`:241`) — AppKit's quaternaryLabelColor, the label colour at
 *    10%, transcribed here the way the empty grid already transcribes it. `textTertiary` is a
 *    whole tier brighter, which made a ghost read as a solid icon.
 *  - **No `autoFocus`.** `ContentView.swift:244` is a plain `Button` with no `.keyboardShortcut`;
 *    it is the grid's "New Pane" that binds Return (`PaneGridView.swift:504`). Autofocusing here
 *    also meant the first Return after ⌘W-ing the last workspace away raised a sheet.
 */
function NoWorkspaceSelected({ onCreate }: { readonly onCreate: () => void }): ReactElement {
    return (
        <div
            data-testid="no-workspace-empty"
            className="absolute inset-0 flex flex-col items-center justify-center gap-2"
            style={{ background: chromeTokens.windowBackground, color: chromeTokens.textTertiary }}
        >
            <span
                data-testid="no-workspace-glyph"
                style={{ color: `color-mix(in srgb, ${chromeTokens.textPrimary} 10%, transparent)` }}
            >
                <ChromeIcon name="terminal" size={48} />
            </span>
            <span className="text-sm" style={{ color: chromeTokens.textSecondary }}>
                No workspace selected
            </span>
            <button
                type="button"
                data-testid="no-workspace-create"
                className="rounded px-3 py-1 text-sm"
                style={{
                    background: chromeTokens.surfaceBackground,
                    color: chromeTokens.textPrimary,
                    border: `1px solid ${chromeTokens.divider}`
                }}
                onClick={onCreate}
            >
                Create Workspace
            </button>
        </div>
    );
}

interface ConnectionSplashProps {
    readonly runtime: KelpiRuntime;
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
    readonly runtime: KelpiRuntime;
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
                // A refusal's text is the actionable part ("open the client via `kelpid url`"),
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
    /*
     * H1 — a toast is DOM and a web pane's page is a native view drawn over it, so an unparked
     * page simply eats the notification: the one message that says why a gesture did nothing
     * would be painted underneath the thing the user is looking at. `active` rather than an
     * unconditional call because this component is always mounted and paints only when it holds
     * something; the page is handed back the moment the last toast is dismissed or expires.
     */
    useModalPresence(toasts.length > 0);
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

/*
 * N19 — `focusTerminalElement` was exactly that: it looked for `[data-terminal-host]` and gave
 * up on anything else, so every overlay-close handoff below (Settings, Help, the pane search
 * bar, the palette's §10.4 handoff, a status-popover jump, a socket-driven focus) was a silent
 * no-op when the focused pane was a scratchpad or a markdown editor — the window came back with
 * the caret nowhere. `focusPaneSurface` (app/pane-focus.ts) resolves the pane's marked surface
 * instead, which is the terminal host for a shell pane and the textarea for an editor.
 */
