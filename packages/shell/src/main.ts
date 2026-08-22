/**
 * The Electron main process (M4).
 *
 * The shell is deliberately thin (ARCHITECTURE.md): it owns a window, a tray, a dock badge, a
 * global hotkey and the quit dialog. It owns **no product logic** — the UI is loaded from the
 * daemon's own HTTP server, so app code and daemon code always update together, and every
 * mutation the user makes travels over the renderer's WebSocket to the daemon.
 *
 * Order of operations on launch:
 *
 *   1. take the single-instance lock (a second launch raises the existing window);
 *   2. discover or spawn the daemon (`./daemon.ts`) — never stop one;
 *   3. open the window on `http://127.0.0.1:<port>/?token=…`, with the frame restored from
 *      disk and clamped back on-screen;
 *   4. open the main process's own status WebSocket for the tray/badge (`./status.ts`);
 *   5. register the config file's global hotkey, install the quit gate.
 *
 * Security posture (docs/research/stack.md §1 "BrowserWindow settings"): the daemon URL is
 * treated as remote content even though it is ours. `contextIsolation` and `sandbox` stay on,
 * `nodeIntegration` stays off, and there is **no preload script at all** — the renderer needs
 * nothing from the shell, because the main process gets its state from its own daemon socket
 * rather than from the page. Navigation is allowlisted to the daemon origin and every other
 * link is handed to the system browser.
 */

import { BrowserWindow, Menu, Notification, app, dialog, globalShortcut, screen, session, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';

import {
    bundledCliLauncher,
    describeCliInstall,
    healCliSymlink,
    installCliSymlink,
    nodeCliFs,
    resolveCliLinkPath,
    type CliInstallResult
} from './cli-install.js';
import {
    createOpenFileQueue,
    runCliInstallPolicy,
    runDaemonConnectSequence,
    runLaunchSequence
} from './launch.js';
import {
    readSearchPalette,
    transparencyNeedsRelaunch,
    windowTransparency
} from './appearance.js';
import { sendControlCommand } from './control.js';
import {
    DaemonUnavailableError,
    clientUrl,
    ensureDaemon,
    type DaemonLocation
} from './daemon.js';
import {
    hotkeyStatusReport,
    readGlobalHotkeySettings,
    swapGlobalHotkey,
    type HotkeyRegistrar,
    type HotkeyStatusReport,
    type HotkeySwapResult
} from './hotkey.js';
import { log, logError, warn } from './log.js';
import {
    appMenuTemplate,
    applyWorkspaceSelection,
    debugMenuSection,
    fileMenuTemplate,
    menuLogLine,
    viewMenuTemplate,
    workspaceSelectionLogLine
} from './menu.js';
import { isForwardableOpenPath } from './shell-actions.js';
import { titleBarLogLine, titleBarStyleFor, trafficLightQuery } from './titlebar.js';
import { describeSkillRefresh, refreshBundledSkill } from './skill.js';
import { createStatusController, type StatusController } from './status.js';
import { canCheckForUpdates, checkForUpdatesNow, maybeStartAutoUpdate } from './updater.js';
import { installQuitGate, settingsFile, type QuitGate } from './quit.js';
import { EMPTY_COUNTS } from './agents.js';
import {
    markQuitConfirmationMigrated,
    pendingQuitConfirmationMigration,
    readShellSettings,
    writeShellSettings
} from './settings.js';
import { createWebPaneHost, type WebPaneHost } from './webhost/index.js';
import { setWebFindPalette } from './webhost/scripts.js';
import {
    MIN_WINDOW_HEIGHT,
    MIN_WINDOW_WIDTH,
    clampBoundsToDisplays,
    defaultBounds,
    readWindowState,
    windowStateFile,
    writeWindowState,
    type Rect
} from './window-state.js';

const SAVE_DEBOUNCE_MS = 400;
const RELOAD_BACKOFF_MS = 1_500;
const MAX_LOAD_RETRIES = 5;

let daemon: DaemonLocation | null = null;
let mainWindow: BrowserWindow | null = null;
let status: StatusController | null = null;
/** M6: the web-pane host — a third daemon connection that owns the browser views. */
let webHost: WebPaneHost | null = null;
let quitGate: QuitGate | null = null;
let hotkeyAccelerator: string | null = null;
/**
 * §SET-200/§SET-201: the last registration outcome, kept so it can be (re)sent whenever the
 * status socket connects. The launch attempt happens before that socket exists, and a hotkey
 * refused at startup is precisely the case Settings has to be able to explain.
 */
let lastHotkeyReport: HotkeyStatusReport | null = null;
/**
 * APP-012 / SET-049 — was THIS window created transparent? Electron fixes `transparent` at
 * creation, so the answer is a property of the window, not of the current settings, and the two
 * can legitimately disagree until the next launch.
 */
let windowIsTransparent = false;
/** True once the user has been told that a transparency change needs a relaunch (once per run). */
let relaunchNoticeShown = false;
let hotkeyHideOnRepress = true;
let saveTimer: NodeJS.Timeout | null = null;
let loadRetries = 0;
/** True once `maybeStartAutoUpdate` actually initialised a feed (APP-026's manual check). */
let updaterStarted = false;
/**
 * Files handed to us by Finder before the daemon was ready live in `openFiles` (declared with
 * the rest of the Finder route below, because it needs `showWindow`).
 */

/**
 * This shell window's identity, minted once per process.
 *
 * It is the thread that ties three parties together without a preload bridge: the web-pane host
 * declares it to the daemon, the UI is loaded with `?shellWindow=<id>` and repeats it on every
 * geometry report, and a reveal request names it so only this window's UI jumps. A browser (or
 * another machine's shell) carries a different id — or none — and is therefore never mistaken
 * for the page that shares this process's window.
 */
const shellWindowID = randomUUID();

app.setName('Nex');

// ── window ──────────────────────────────────────────────────────────────────────────

function stateFile(): string {
    return windowStateFile(app.getPath('userData'));
}

function restoreBounds(): { bounds: Rect; fullScreen: boolean; visibleOnAllWorkspaces: boolean } {
    const stored = readWindowState(stateFile());
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const bounds =
        stored.bounds === null
            ? defaultBounds(primary)
            : clampBoundsToDisplays(stored.bounds, displays, primary);
    return {
        bounds,
        fullScreen: stored.fullScreen,
        visibleOnAllWorkspaces: stored.visibleOnAllWorkspaces
    };
}

/**
 * §APP-060: apply (and optionally persist) "show this window on every desktop".
 *
 * Electron's `setVisibleOnAllWorkspaces` is the `.canJoinAllSpaces` collection behaviour the
 * Swift app set from the Dock's `com.apple.spaces` binding. That plist is private and
 * unreadable from here, so the toggle is ours and the answer lives in `window-state.json` —
 * see `ShellWindowState.visibleOnAllWorkspaces` for the divergence note.
 */
function applyVisibleOnAllWorkspaces(value: boolean, persist: boolean): void {
    const window = mainWindow;
    if (window !== null && !window.isDestroyed()) {
        try {
            window.setVisibleOnAllWorkspaces(value, { visibleOnFullScreen: value });
        } catch (error) {
            warn(`assign-to-all-desktops failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (!persist) return;
    const stored = readWindowState(stateFile());
    writeWindowState(stateFile(), { ...stored, visibleOnAllWorkspaces: value });
    log(`window: assign to all desktops ${value ? 'on' : 'off'}`);
}

function isVisibleOnAllWorkspaces(): boolean {
    return readWindowState(stateFile()).visibleOnAllWorkspaces;
}

function scheduleBoundsSave(window: BrowserWindow): void {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        // shell-ui.md §1: never store a fullscreen (or transitioning) frame — the stored one
        // must always be the windowed frame, or restore comes back with a screen-sized window.
        if (window.isDestroyed() || window.isFullScreen() || window.isMinimized()) return;
        // Spread the stored state: the frame is not the only thing in this file any more
        // (§APP-060's all-desktops flag lives here too, and a debounced frame save must not
        // silently reset it).
        writeWindowState(stateFile(), {
            ...readWindowState(stateFile()),
            bounds: window.getNormalBounds(),
            fullScreen: false
        });
    }, SAVE_DEBOUNCE_MS);
    saveTimer.unref?.();
}

function saveFullScreenFlag(window: BrowserWindow, fullScreen: boolean): void {
    const stored = readWindowState(stateFile());
    writeWindowState(stateFile(), {
        ...stored,
        bounds: fullScreen ? stored.bounds : window.getNormalBounds(),
        fullScreen
    });
}

function isDaemonOrigin(target: string): boolean {
    if (daemon === null) return false;
    try {
        return new URL(target).origin === new URL(daemon.url).origin;
    } catch {
        return false;
    }
}

function openExternally(target: string): void {
    try {
        const parsed = new URL(target);
        // Only ever hand the OS an http(s) URL: `file:`, `javascript:` and custom schemes
        // are how "open externally" turns into arbitrary local execution.
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
        void shell.openExternal(parsed.toString());
    } catch {
        // Not a URL at all: nothing to open.
    }
}

function applySecurityPolicy(window: BrowserWindow): void {
    const contents = window.webContents;

    contents.on('will-navigate', (event, target) => {
        if (isDaemonOrigin(target)) return;
        event.preventDefault();
        openExternally(target);
    });

    contents.setWindowOpenHandler(({ url }) => {
        // The UI never needs a second Chromium window; anything it tries to open is a link.
        openExternally(url);
        return { action: 'deny' };
    });

    // Defense in depth: the daemon never serves a <webview>, so an attempt to attach one
    // means the page is not the page we think it is.
    contents.on('will-attach-webview', (event) => {
        event.preventDefault();
    });

    contents.on('render-process-gone', (_event, details) => {
        logError(`renderer gone (${details.reason}); reloading`);
        if (!window.isDestroyed()) window.reload();
    });
}

function applyPermissionPolicy(): void {
    // stack.md §1: clipboard + notifications for the daemon origin only, everything else
    // denied. The UI has no camera/mic/geolocation features, so a request for one is a signal.
    const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write', 'notifications']);
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
        const origin = contents.getURL();
        callback(allowed.has(permission) && isDaemonOrigin(origin));
    });
    session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) =>
        allowed.has(permission) && isDaemonOrigin(origin)
    );
}

/**
 * APP-046 — the frame decision, taken once for this process.
 *
 * `titleBarStyle` is fixed at window construction (like `transparent`), so it cannot be a runtime
 * setting; and `loadDaemonUrl` needs the same decision to tell the page what to reserve. One
 * module-level constant rather than two calls that could disagree.
 */
const TITLE_BAR = titleBarStyleFor(process.platform);

function loadDaemonUrl(window: BrowserWindow): void {
    if (daemon === null) return;
    // `shellWindow` marks the page as "the UI inside this shell window" — it is what makes the
    // client's web-pane geometry reports actionable and scopes reveal requests to this window.
    // The client keeps it (only `daemon`/`token` are stripped from the visible URL).
    const target =
        `${clientUrl(daemon)}&shellWindow=${encodeURIComponent(shellWindowID)}` +
        // APP-012: the page cannot know whether the frame around it is transparent, and it must
        // not paint an rgba window fill in an ordinary browser tab (there it would composite
        // over white). The window that DOES know says so.
        (windowIsTransparent ? '&windowTransparent=1' : '') +
        // APP-046: the same shape of answer for the traffic lights. With `hiddenInset` the page
        // is drawn UNDER them, so it is told how much leading room to keep clear; a browser tab
        // (and a Linux window) gets no parameter and reserves nothing.
        trafficLightQuery(TITLE_BAR);
    // The token rides in the query string (the client reads it, remembers it, and strips it
    // from the address bar). It must never reach a log file, so redact it here — which also
    // makes the log line proof that a token WAS attached.
    log(`loading ${target.replace(daemon.token, '<token>')}`);
    void window.loadURL(target).catch((error: unknown) => {
        logError(`loadURL failed for ${daemon?.url ?? '(unknown)'}`, error);
    });
}

function createWindow(): BrowserWindow {
    const { bounds, fullScreen, visibleOnAllWorkspaces } = restoreBounds();
    /*
     * APP-012 / SET-049 — window compositing follows the ghostty `background-opacity`.
     *
     * The Swift app set `window.isOpaque = opacity >= 1.0` whenever the slider moved. Electron
     * has no equivalent: `transparent` is fixed at construction, so the decision is taken HERE,
     * from the config file, before the window exists. Below 1 the window is created transparent
     * with a fully transparent `backgroundColor` and the PAGE paints the fill (the client
     * publishes `--nex-bg` at the same alpha), so the desktop shows through the window fill and
     * the terminal panes while the sidebar and header stay opaque.
     *
     * At opacity 1 nothing changes: an opaque window with the same `#16161a` flash colour it
     * has always had. A transparent window has no drop shadow on macOS and cannot show one, so
     * this is opt-in by configuration rather than the default.
     */
    const transparency = windowTransparency();
    windowIsTransparent = transparency.transparent;
    log(
        `window: ${windowIsTransparent ? 'transparent' : 'opaque'} ` +
            `(background-opacity ${transparency.opacity.toFixed(2)})`
    );
    const window = new BrowserWindow({
        ...bounds,
        minWidth: MIN_WINDOW_WIDTH,
        minHeight: MIN_WINDOW_HEIGHT,
        show: false,
        title: 'Nex',
        ...(windowIsTransparent ? { transparent: true } : {}),
        backgroundColor: windowIsTransparent ? '#00000000' : '#16161a',
        /*
         * APP-046 — the hidden title bar, at last.
         *
         * The shipped app is `.hiddenTitleBar` with its 32pt strip drawn up into the traffic-light
         * row. This window was a standard frame on purpose until now ("the client's top bar does
         * not reserve the traffic lights' inset yet"), which stacked a native strip above the
         * client's own. The client reserves it now — `?trafficLightInset=` above, `TopBar`'s
         * leading gutter — so the frame goes away and the drawn strip becomes the title bar,
         * drag region and all. `./titlebar.ts` owns every number in that sentence.
         */
        ...(TITLE_BAR.titleBarStyle === undefined ? {} : { titleBarStyle: TITLE_BAR.titleBarStyle }),
        ...(TITLE_BAR.trafficLightPosition === undefined
            ? {}
            : { trafficLightPosition: { ...TITLE_BAR.trafficLightPosition } }),
        webPreferences: {
            // Electron defaults, restated because they are load-bearing (stack.md §1).
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webviewTag: false,
            webSecurity: true,
            spellcheck: false
        }
    });

    /*
     * APP-046, reported rather than assumed.
     *
     * An application window's frame is not observable from outside the process, and the defect
     * this replaces — a native title bar stacked ABOVE the client's drawn one — shows up as
     * exactly one number: the height the frame keeps for itself. With a hidden title bar it is 0.
     * `scripts/smoke.mjs` and `docs/audit`'s `mac-chrome` read this line.
     */
    try {
        const frame = window.getBounds();
        const content = window.getContentBounds();
        log(
            titleBarLogLine({
                decision: TITLE_BAR,
                frameHeight: frame.height,
                contentHeight: content.height
            })
        );
    } catch (error) {
        warn(`titlebar report failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (fullScreen) window.setFullScreen(true);
    // §APP-060: reapply the stored "all desktops" assignment. `mainWindow` is not assigned until
    // `createWindow` returns, so this one call targets the new window directly rather than going
    // through `applyVisibleOnAllWorkspaces`; the persist half has nothing to do (this IS the
    // stored value).
    if (visibleOnAllWorkspaces) {
        try {
            window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
            log('window: restored assign-to-all-desktops');
        } catch (error) {
            warn(`assign-to-all-desktops failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    applySecurityPolicy(window);

    window.once('ready-to-show', () => window.show());
    window.on('resize', () => scheduleBoundsSave(window));
    window.on('move', () => scheduleBoundsSave(window));
    window.on('enter-full-screen', () => saveFullScreenFlag(window, true));
    window.on('leave-full-screen', () => saveFullScreenFlag(window, false));
    window.on('focus', () => {
        // agent-lifecycle.md §8.4: activating the app clears the badge immediately.
        status?.acknowledgeActivation();
        // §AGNT-056: …and the pane grid re-schedules its 600 ms status clear, which is the
        // Swift's `didBecomeActive` half. The grid lives in the renderer, so the fact has to
        // travel — shell → daemon → this window's client — rather than being read off a
        // notification in the same process.
        status?.reportActivation(true);
    });
    window.on('blur', () => {
        // The other half, and the reason the timer is a GATE rather than a bare re-arm: a
        // `stop` that lands while nobody is looking must not clear its own "awaiting input"
        // badge 600 ms later. Suspended here, re-armed on the next focus.
        status?.reportActivation(false);
    });
    window.on('closed', () => {
        mainWindow = null;
        // Embedded web-pane views outlive the window: back to the host's off-screen holder, or
        // the next placement would address a destroyed window (and `capture` would break for a
        // pane whose view is parented to nothing).
        webHost?.releaseViews('window-closed');
    });
    window.on('hide', () => webHost?.releaseViews('window-hidden'));
    // Resizing/moving the window changes the content area under every embedded view; the client
    // re-measures and reports, so nothing is recomputed here — but a window that leaves the
    // screen entirely must not keep views parented to it.
    window.on('minimize', () => webHost?.releaseViews('window-minimized'));

    window.webContents.on('did-finish-load', () => {
        loadRetries = 0;
        log(`did-finish-load ${window.webContents.getURL()}`);
        if (!window.isVisible()) window.show();
    });
    window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
        if (!isMainFrame || code === -3 /* ERR_ABORTED: a navigation we replaced */) return;
        logError(`did-fail-load ${url} (${String(code)} ${description})`);
        if (loadRetries >= MAX_LOAD_RETRIES) return;
        loadRetries += 1;
        setTimeout(() => {
            if (!window.isDestroyed()) loadDaemonUrl(window);
        }, RELOAD_BACKOFF_MS).unref?.();
    });

    loadDaemonUrl(window);
    return window;
}

function showWindow(): void {
    if (mainWindow === null || mainWindow.isDestroyed()) {
        mainWindow = createWindow();
        mainWindow.show();
        return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (process.platform === 'darwin') app.focus({ steal: true });
}

// ── global hotkey (config-keybindings.md §8) ────────────────────────────────────────

const registrar: HotkeyRegistrar = {
    register: (accelerator, handler) => globalShortcut.register(accelerator, handler),
    unregister: (accelerator) => globalShortcut.unregister(accelerator),
    isRegistered: (accelerator) => globalShortcut.isRegistered(accelerator)
};

/** §8.2 `toggleAppFrontmost`. */
function toggleFrontmost(): void {
    const frontmost = BrowserWindow.getAllWindows().some((window) => window.isFocused());
    if (hotkeyHideOnRepress && frontmost) {
        if (process.platform === 'darwin') app.hide();
        else mainWindow?.hide();
        return;
    }
    showWindow();
}

/**
 * Register (or re-register) the global hotkey and REPORT what happened (§SET-200/§SET-201).
 *
 * The report is the half that used to be missing. `swapGlobalHotkey` already gets the Swift
 * staged-swap right — a rejected chord leaves the working one registered and returns the reason
 * — but the reason went to `logError` and stopped there, so Settings ▸ Keybindings showed a
 * hotkey that quietly did nothing. It now travels shell → daemon → every window, where
 * `GlobalHotkeySection` renders it in the same orange warning the Swift view uses.
 *
 * Three outcomes are reported, and all three matter:
 *   - **unspellable trigger** — a keyCode Electron has no accelerator for. Swift's Carbon path
 *     cannot produce this, so the wording is the port's own; without it the row shows a chord
 *     nothing ever tried to register.
 *   - **rejected** — the OS refused (usually another app owns the combo). §8.4: the configured
 *     value is KEPT so the user can see and edit it, which is exactly why the warning is needed.
 *   - **accepted / none configured** — `ok: true`, which CLEARS a standing warning.
 */
function registerGlobalHotkey(source: 'launch' | 'settings'): void {
    const settings = readGlobalHotkeySettings();
    hotkeyHideOnRepress = settings.hideOnRepress;
    /*
     * Remembered as well as sent: the launch registration happens before the status socket is
     * up, and `daemonSettingsReady` (which fires on every connect and reconnect) replays it.
     * Without that, the one report a user most needs — "the hotkey in your config file was
     * refused at startup" — would be the one that never arrives.
     */
    const report = (result: HotkeySwapResult | null): void => {
        lastHotkeyReport = hotkeyStatusReport(settings, result, source);
        status?.reportHotkeyStatus(lastHotkeyReport);
    };
    if (settings.trigger !== null && settings.accelerator === null) {
        warn(`global-hotkey "${settings.configString ?? '?'}" has no Electron accelerator; ignored`);
        report(null);
        return;
    }
    const result = swapGlobalHotkey(registrar, hotkeyAccelerator, settings.accelerator, toggleFrontmost);
    hotkeyAccelerator = result.accelerator;
    report(result);
    if (settings.accelerator === null) {
        log('global-hotkey: none configured');
        return;
    }
    if (result.ok) {
        log(`global-hotkey registered ${settings.accelerator} (${settings.configString ?? ''})`);
        return;
    }
    // §8.4 launch-path failure: keep the configured value and surface the error rather than
    // silently dropping the user's hotkey.
    logError(`global-hotkey ${settings.accelerator} could not be registered: ${result.error ?? 'rejected'}`);
}

// ── appearance (APP-012 / SET-049, SET-219) ─────────────────────────────────────────

/**
 * Re-read the two appearance facts this process owns after a config write.
 *
 * The find palette applies to every context created from now on, which is the same granularity
 * every injected script has. Transparency cannot be re-applied at all — Electron fixes it at
 * window creation — so a change that CROSSES the 1.0 boundary is reported instead of pretended:
 * one notification, once per run, saying it takes effect on the next launch. Recreating the
 * window under the user would tear down every embedded web view and the renderer's whole state
 * for a preference change, which is a worse trade than a sentence.
 */
function applyAppearanceSettings(): void {
    setWebFindPalette(readSearchPalette());
    const { opacity } = windowTransparency();
    if (!transparencyNeedsRelaunch(windowIsTransparent, opacity)) return;
    const wanted = opacity < 1 ? 'transparent' : 'opaque';
    log(`window transparency change to ${wanted} needs a relaunch (background-opacity ${opacity.toFixed(2)})`);
    if (relaunchNoticeShown || !Notification.isSupported()) return;
    relaunchNoticeShown = true;
    new Notification({
        title: 'Window transparency changes on next launch',
        body:
            `background-opacity is now ${opacity.toFixed(2)}. Panes already follow it; ` +
            'the window itself becomes ' +
            wanted +
            ' the next time Nex starts.'
    }).show();
}

// ── Finder "Open With" ──────────────────────────────────────────────────────────────

/**
 * The two-stage cold-launch queue (CONT-125/127, APP-101). The sequencing — park while there is
 * no connection, replay in arrival order, snapshot-and-clear, raise the window only where a file
 * actually goes out — lives in `./launch.ts` so it can be tested without Electron; what is here
 * is the three effects it drives.
 */
const openFiles = createOpenFileQueue({
    ready: () => daemon !== null,
    send: ({ path: filePath, paneID }) => {
        if (daemon === null) return;
        void sendControlCommand(daemon.paths.socket, {
            command: 'open',
            path: filePath,
            // The pane that asked, when one did (the ⌘O route). `open` routes into that pane's
            // workspace exactly as `nex md` from inside a pane does; Finder's route names none.
            ...(paneID === null ? {} : { pane_id: paneID })
        }).then((result) => {
            if (!result.ok) warn(`open ${filePath} failed: ${result.error ?? 'no reply'}`);
        });
    },
    activate: () => {
        showWindow();
        // CONT-125 is "an open while minimised/hidden becomes visible", and a window raise is
        // not observable from outside this process — so it is logged rather than inferred, the
        // same way the tray item and the application menu are, and `scripts/smoke.mjs` asserts
        // the line after handing the app a file.
        log('open: raised the window for the file just forwarded');
    }
});

function forwardOpen(filePath: string, paneID: string | null = null): void {
    openFiles.forward(filePath, paneID);
}

/**
 * CONT-120 — "Preview Markdown…"'s native open panel.
 *
 * Byte-for-byte the Swift panel (`AppReducer+SearchNotify.swift:83-99`): `md` only, single
 * selection, files only, and the same message. The chosen path goes back out as an ordinary
 * `open` control command, so the daemon sees one file-open route no matter who raised it.
 */
function promptOpenFile(paneID: string | null): void {
    // Audit seam. A native `NSOpenPanel` is an OS window: CDP cannot click it and a screenshot
    // cannot see it, so `scripts/ui-audit` scripts the ANSWER and lets the rest of the round
    // trip (client → daemon → shell → `open` → a markdown pane) run for real. The file is
    // consumed on read, so a second ⌘O in the same run shows the real panel unless the harness
    // wrote a new answer. Off unless the env var names a path, which no shipped launch does.
    const scripted = process.env['NEX_AUDIT_OPEN_FILE'];
    if (scripted !== undefined && scripted !== '') {
        let answer = '';
        try {
            answer = readFileSync(scripted, 'utf8').trim();
            unlinkSync(scripted);
        } catch {
            answer = '';
        }
        log(`open-file dialog: scripted answer ${answer === '' ? '(cancelled)' : answer}`);
        if (answer !== '') forwardOpen(answer, paneID);
        return;
    }
    const parent = mainWindow !== null && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const options: Electron.OpenDialogOptions = {
        title: 'Open Markdown File',
        message: 'Choose a Markdown file to open',
        properties: ['openFile'],
        filters: [{ name: 'Markdown', extensions: ['md'] }]
    };
    const shown = parent === undefined ? dialog.showOpenDialog(options) : dialog.showOpenDialog(parent, options);
    void shown
        .then((answer) => {
            const chosen = answer.canceled ? undefined : answer.filePaths[0];
            if (chosen === undefined || chosen === '') {
                log('open-file dialog: cancelled');
                return;
            }
            log(`open-file dialog: ${chosen}`);
            forwardOpen(chosen, paneID);
        })
        .catch((error: unknown) => {
            logError('open-file dialog failed', error);
        });
}

/** APP-026 — the menu's "Check for Updates…", which always answers rather than sitting grey. */
function checkForUpdates(): void {
    const result = checkForUpdatesNow({
        host: { isPackaged: app.isPackaged, platform: process.platform },
        started: updaterStarted
    });
    if (result.kind === 'checking') {
        void dialog.showMessageBox({
            type: 'info',
            message: 'Checking for updates',
            detail: 'Nex is asking the update feed. If one is available it installs on the next launch.'
        });
        return;
    }
    void dialog.showMessageBox({
        type: result.kind === 'failed' ? 'warning' : 'info',
        message: result.kind === 'failed' ? 'Update check failed' : 'Updates are disabled in this build',
        detail: result.message
    });
}

function drainPendingOpens(): void {
    openFiles.drain();
}

// ── the global `nex` CLI (APP-003…005) ──────────────────────────────────────────────

/**
 * Keep `/usr/local/bin/nex` pointing at THIS bundle's CLI, and offer to create it once.
 *
 * The decision logic — what counts as ours, when to touch it, when to give up — is in
 * `./cli-install.ts` and has no Electron in it. What lives here is the part only the app can do:
 * ask the user, show a notification, and write the "already asked" flag.
 *
 * Everything is best-effort and off the boot path's critical line: a CLI that could not be
 * installed must never be the reason the window does not open.
 */
function cliSettingsFile(): string {
    return settingsFile(app.getPath('userData'));
}

function reportCliInstall(result: CliInstallResult, announce: boolean): void {
    log(describeCliInstall(result));
    if (result.kind !== 'blocked') return;

    // APP-005: one notification per app build, so a machine where /usr/local/bin is locked down
    // does not nag on every launch. `announce` is true when the user asked for this explicitly,
    // and then the dedupe is skipped — they are waiting for an answer.
    const version = app.getVersion();
    const settings = readShellSettings(cliSettingsFile());
    if (!announce && settings.cliInstallNotifiedVersion === version) return;
    if (!announce) writeShellSettings(cliSettingsFile(), { ...settings, cliInstallNotifiedVersion: version });

    if (!Notification.isSupported()) return;
    new Notification({
        title: 'Nex CLI is out of date',
        body: `Could not update ${result.plan.linkPath}. Run this in a terminal:\n${result.plan.manualCommand}`
    }).show();
}

/** The tray's "Install CLI" item, and the accepted first-launch offer. */
function installCliNow(announce: boolean): void {
    const target = bundledCliLauncher(process.resourcesPath);
    const result = installCliSymlink({ linkPath: resolveCliLinkPath(process.env), target }, nodeCliFs);
    reportCliInstall(result, announce);
    if (!announce || result.kind === 'blocked') return;
    const detail =
        result.kind === 'linked'
            ? `${result.plan.linkPath} now points at this build. Run \`nex install-hooks\` to wire agent status tracking.`
            : result.kind === 'ok'
              ? `${result.plan.linkPath} already points at this build.`
              : result.reason;
    void dialog.showMessageBox({
        type: result.kind === 'skipped' ? 'warning' : 'info',
        message: result.kind === 'skipped' ? 'Nex did not change the CLI' : 'Nex CLI installed',
        detail
    });
}

function offerCliInstall(): void {
    const settings = readShellSettings(cliSettingsFile());
    writeShellSettings(cliSettingsFile(), { ...settings, cliInstallPrompted: true });
    void dialog
        .showMessageBox({
            type: 'question',
            message: 'Install the nex command line tool?',
            detail:
                `This creates a symlink at ${resolveCliLinkPath(process.env)} pointing at the CLI inside Nex.app, ` +
                'so `nex` works in any terminal and Claude Code hooks can report agent status. ' +
                'You can do it later from the Nex tray menu.',
            buttons: ['Install', 'Not Now'],
            defaultId: 0,
            cancelId: 1
        })
        .then((answer) => {
            if (answer.response === 0) installCliNow(true);
            else log('cli-install: offer declined');
        })
        .catch((error: unknown) => {
            logError('cli-install: offer failed', error);
        });
}

/**
 * The launch-time CLI policy. The ordering — heal first in every case, so a user who already has
 * the CLI installed is never asked about it, and the answer to "does one exist?" is the heal's
 * own `absent` result — is `runCliInstallPolicy` in `./launch.ts`, where it has tests.
 */
/**
 * §APP-006's launch step — live again, under the two rules the scar bought.
 *
 * The Swift app re-copies its bundled agent documentation into the user's config directory at
 * launch. A port of that ran here once and landed in a REAL home while every harness in this
 * repo was pointed at a throwaway one, because Electron's `app.getPath('home')` asks the OS and
 * ignores `$HOME`. So the destination is resolved from `process.env` — the same `$HOME` the CLI,
 * `install-hooks` and Claude Code itself use — and the decision lives in `./skill.ts`, which
 * imports no Electron and can therefore be driven, in full, against a sandbox home.
 *
 * `app.getPath('home')` MUST NOT appear in this function. The second rule (never overwrite a
 * document this app cannot prove it wrote) is enforced inside the module and is what keeps a
 * real home safe even if this call site is ever wired up wrongly again.
 */
function applySkillRefreshIfEnabled(): void {
    const result = refreshBundledSkill({
        env: process.env,
        resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
        appVersion: app.getVersion()
    });
    log(describeSkillRefresh(result));
}

function applyCliInstallPolicy(): void {
    runCliInstallPolicy({
        env: process.env,
        isPackaged: app.isPackaged,
        alreadyPrompted: readShellSettings(cliSettingsFile()).cliInstallPrompted,
        target: bundledCliLauncher(process.resourcesPath),
        linkPath: resolveCliLinkPath(process.env),
        heal: (options) => healCliSymlink(options, nodeCliFs),
        installNow: () => installCliNow(false),
        report: (result) => reportCliInstall(result, false),
        offer: () => offerCliInstall(),
        log
    });
}

// ── application menu ────────────────────────────────────────────────────────────────

/**
 * §WS-151: the last workspace multi-selection count this window's client reported.
 *
 * Kept here rather than read at build time because it outlives a menu: `buildMenu()` runs at
 * launch and on nothing else, while a selection changes with every ⌘-click. It is also what a
 * REBUILD would have to seed the row from, so the two facts stay one variable.
 */
let workspaceSelectionCount = 0;

/**
 * Move File ▸ Deselect All Workspaces to match the reported selection.
 *
 * Applied to the LIVE menu rather than by rebuilding one: rebuilding drops any open menu and
 * re-registers every accelerator in it, which is a lot of collateral for one greyed row. The
 * log line is the only trace visible from outside the process, so the smoke and the audit can
 * assert a menu state that is otherwise unobservable — the same reason `menuLogLine` exists.
 */
function applyWorkspaceSelectionCount(selectedCount: number): void {
    workspaceSelectionCount = selectedCount;
    applyWorkspaceSelection(Menu.getApplicationMenu(), selectedCount);
    log(workspaceSelectionLogLine(selectedCount));
}

function buildMenu(): void {
    // Keep it minimal: the UI owns its own commands, but macOS needs an app menu for ⌘Q,
    // and Edit needs its roles for copy/paste to reach the web contents.
    //
    // Every PRODUCT row lives in `./menu.ts`, where its click can be exercised without an
    // Electron process; what is left here is the wiring — the relay, the native panel fallback,
    // and the two menus (Edit, Window) that are pure roles.
    const relay = {
        sendMenuRequest: (command: string) => status?.sendMenuRequest(command) === true,
        onUndelivered: (command: string) => warn(`menu: no window took "${command}"`)
    };
    // §APP-026: read once, here, and reported in the log line below — the row is greyed in a dev
    // or unsigned build exactly as Sparkle's was when `canCheckForUpdates` was false.
    const updatesAvailable = canCheckForUpdates({ isPackaged: app.isPackaged, platform: process.platform });
    const template: Electron.MenuItemConstructorOptions[] = [
        ...(process.platform === 'darwin'
            ? ([
                  {
                      label: 'Nex',
                      submenu: appMenuTemplate({
                          checkForUpdates: () => checkForUpdates(),
                          canCheckForUpdates: updatesAvailable
                      })
                  }
              ] as Electron.MenuItemConstructorOptions[])
            : []),
        {
            // §APP-018 / §WS-151: the shipped app's whole File group in place of the stock New
            // Window — New Workspace (⌘N), New Group (⌘⇧G), Preview Markdown… (⌘O), New Web
            // Pane (⌘⇧O), Command Palette (⌘P), Switch to Workspace 1–9 (⌘1…⌘9), Select All /
            // Deselect All Workspaces. Every one relays to the client, which owns the sheet, the
            // picker, the palette and the sidebar's selection; ⌘O alone falls back to raising
            // the native panel from here.
            label: 'File',
            submenu: fileMenuTemplate({
                ...relay,
                promptOpenFile: () => promptOpenFile(null),
                platform: process.platform,
                // A rebuild (there is only the launch one today) must not un-grey a row the
                // client has already told us belongs greyed.
                hasWorkspaceSelection: workspaceSelectionCount > 0
            })
        },
        { role: 'editMenu' },
        {
            // §WS-001 / §APP-025: View ▸ Toggle Sidebar (⌘⇧S) + Toggle Inspector (⌘I), the
            // shipped app's own View group. Both relay to the client, which owns the visibility
            // of both panels.
            label: 'View',
            submenu: viewMenuTemplate(relay)
        },
        { role: 'windowMenu' },
        // §APP-028 / §SET-194: the Swift's `#if DEBUG` Debug ▸ Seed Test Group. `app.isPackaged`
        // is this port's compile-time condition, and it is read HERE — the template module never
        // imports Electron, which is what lets `menu.test.ts` build the menu both ways.
        ...debugMenuSection({ ...relay, isPackaged: app.isPackaged }),
        {
            // APP-027: the Help menu is replaced by a single "Nex Help" item bound to ⌘?. The
            // window it opens is the client's overlay (`client/src/chrome/HelpOverlay.tsx`),
            // reached through the daemon because this shell has no preload.
            role: 'help',
            submenu: [
                {
                    label: 'Nex Help',
                    accelerator: 'CommandOrControl+?',
                    click: () => {
                        if (status?.sendMenuRequest('help') !== true) {
                            void dialog.showMessageBox({
                                type: 'info',
                                message: 'Nex Help',
                                detail: 'The window is still connecting — try again in a moment.'
                            });
                        }
                    }
                }
            ]
        }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    // Logged rather than inferred, for the same reason the tray item is: an application menu is
    // not observable from outside the process, so `scripts/smoke.mjs` asserts this line and
    // "the items are there" becomes a check instead of a hope.
    log(menuLogLine({ canCheckForUpdates: updatesAvailable, isPackaged: app.isPackaged }));
}

// ── boot ────────────────────────────────────────────────────────────────────────────

async function connectDaemon(): Promise<void> {
    daemon = await ensureDaemon({
        env: process.env,
        appDir: app.getAppPath(),
        resourcesPath: process.resourcesPath
    });
    log(`daemon ready ${daemon.url} (spawned=${String(daemon.spawned)})`);
}

function startStatusController(): void {
    const location = daemon;
    if (location === null) return;
    if (status === null) {
        const cliInstallable = bundledCliLauncher(process.resourcesPath) !== '';
        // Logged rather than inferred: the tray menu is not observable from outside the process,
        // and `scripts/packaged-smoke.mjs` asserts this line so "the item is there" is a check.
        log(`cli-install: tray item ${cliInstallable ? 'enabled' : 'hidden (no CLI payload)'}`);
        status = createStatusController({
            location,
            windowID: shellWindowID,
            host: {
                showWindow,
                isWindowFocused: () => BrowserWindow.getAllWindows().some((window) => window.isFocused()),
                startDaemon: () => {
                    void startDaemonAndConnect().catch((error: unknown) => {
                        logError('daemon restart failed', error);
                    });
                },
                quit: () => app.quit(),
                // §APP-060: the tray owns the "all desktops" assignment, because the Dock's own
                // binding lives in a private plist Electron cannot read. `window-state.json`
                // makes it survive a relaunch.
                isVisibleOnAllWorkspaces: () => isVisibleOnAllWorkspaces(),
                setVisibleOnAllWorkspaces: (value) => {
                    applyVisibleOnAllWorkspaces(value, true);
                },
                // Tray ▸ "Install CLI" — offered only when this build actually carries a CLI to
                // install, and always explicit, so it reports its result in a dialog.
                ...(cliInstallable ? { installCLI: () => installCliNow(true) } : {}),
                // The ••• menu's shell rows and ⌘O's native panel, all arriving as
                // `shell-action` broadcasts (`daemon/src/ws/desktop.ts`). `installCLINow` is
                // offered unconditionally — unlike the tray item, the menu row already exists
                // and its answer ("no CLI payload in this build") is worth showing.
                promptOpenFile: (paneID) => promptOpenFile(paneID),
                /**
                 * §AGNT-117's one-shot migration.
                 *
                 * `confirm-quit-when-active` used to live in this process's own
                 * `shell-settings.json`. A user who ticked "Don't ask again" before the move
                 * would otherwise get the dialog back on the next launch, so the first
                 * handshake pushes that old `false` into the daemon settings and marks the file
                 * migrated. A default install has nothing to push and is marked anyway, so this
                 * runs once per install and never again.
                 */
                daemonSettingsReady: () => {
                    // §SET-200/§SET-201: this fires on every (re)connect, which is the only
                    // moment the launch-time registration outcome can actually be delivered —
                    // it happened before there was a socket. Re-sending on a reconnect is
                    // harmless: the daemon keeps only the latest and re-broadcasts it.
                    if (lastHotkeyReport !== null) status?.reportHotkeyStatus(lastHotkeyReport);
                    const file = settingsFile(app.getPath('userData'));
                    const local = readShellSettings(file);
                    if (local.quitConfirmationMigrated) return;
                    if (pendingQuitConfirmationMigration(local)) {
                        const sent = status?.setGeneralSetting('confirm-quit-when-active', 'false') ?? false;
                        // Only mark it done when the write actually went out; a socket that was
                        // not ready must get another chance on the next connect.
                        if (!sent) return;
                        log('quit: migrated the local “Don\u2019t ask again” into the daemon settings');
                    }
                    markQuitConfirmationMigrated(file, local);
                },
                checkForUpdates: () => checkForUpdates(),
                installCLINow: () => installCliNow(true),
                revealPane: (workspaceID, paneID) => {
                    // §8.5's ordering, split across the two processes that can each do half:
                    // the shell raises/activates the window FIRST (only it can), then asks the
                    // daemon to tell this window's UI to switch workspace and focus the pane
                    // LAST (only the client can, and only it knows when the DOM is ready).
                    // The route is the daemon rather than a preload bridge on purpose — the
                    // renderer surface stays empty, and the same message works for a client
                    // that is still loading, or attached from another machine.
                    showWindow();
                    const routed = status?.revealPane(workspaceID, paneID) ?? false;
                    log(
                        `reveal requested for pane ${paneID} in workspace ${workspaceID}` +
                            (routed ? '' : ' (daemon socket not ready; window raised only)')
                    );
                },
                /**
                 * The pane context menu's "Open in Finder" (TERM-110). `showItemInFolder`
                 * reveals a file *inside* its folder and selects it; `openPath` opens a
                 * directory as itself. Both are fire-and-forget — Finder's own error surface is
                 * what a user acts on, so a failure is logged and nothing else.
                 */
                revealPath: (target, select) => {
                    if (select) {
                        shell.showItemInFolder(target);
                        log(`reveal-path: revealed ${target}`);
                        return;
                    }
                    void shell.openPath(target).then((error) => {
                        if (error !== '') logError(`reveal-path failed for ${target}: ${error}`);
                        else log(`reveal-path: opened ${target}`);
                    });
                },
                /**
                 * SET-081: Settings can now record the global hotkey, and the write lands in
                 * the config file THIS process reads. Before this it was read once at launch,
                 * so a recorded hotkey did nothing until the app was restarted.
                 *
                 * Safe to fire on every settings write, including ones that have nothing to do
                 * with hotkeys: `swapGlobalHotkey` short-circuits when the accelerator has not
                 * changed, so the common case does not touch `globalShortcut` at all.
                 */
                settingsChanged: () => {
                    registerGlobalHotkey('settings');
                    applyAppearanceSettings();
                },
                /**
                 * §WS-151: the sidebar's multi-selection, arriving from the page the long way
                 * round so File ▸ Deselect All Workspaces can be greyed while it is empty —
                 * `.disabled(store.selectedWorkspaceIDs.isEmpty)` in `NexCommands.swift`, where
                 * the menu and the selection are one process apart instead of two.
                 */
                workspaceSelectionChanged: (selectedCount) => {
                    applyWorkspaceSelectionCount(selectedCount);
                }
            }
        });
        status.start();
    } else {
        status.setLocation(location);
    }
}

// The web-pane host claims the daemon's `web-pane` role and owns one WebContentsView per
// tab (`./webhost/`). It is a separate connection from the status socket on purpose: losing
// one role must not disturb the other, and both work while the window is closed.
function startWebPaneHost(): void {
    const location = daemon;
    if (location === null) return;
    if (webHost === null) {
        webHost = createWebPaneHost({
            location,
            version: app.getVersion(),
            // Embedding: the host places a pane's view in THIS window when the UI running in it
            // (same `windowID`) reports where it drew the page area. Looked up lazily — the
            // window is created after this, and can be closed and re-opened under it.
            window: () => mainWindow,
            windowID: shellWindowID
        });
        webHost.start();
    } else {
        webHost.setLocation(location);
    }
}

/**
 * Steps 2 and 4 of the launch order, plus the cold-launch drain. The order is
 * `runDaemonConnectSequence` in `./launch.ts` (and tested there): the drain is last, because a
 * file replayed before the sockets exist would be sent into a connection nobody is listening on,
 * and it is unconditional, because this function also runs on a reconnect.
 */
async function startDaemonAndConnect(): Promise<void> {
    await runDaemonConnectSequence({
        connect: connectDaemon,
        startStatus: startStatusController,
        startWebHost: startWebPaneHost,
        drainPendingOpens
    });
}

/**
 * The launch order itself lives in `runLaunchSequence` (`./launch.ts`), where it is tested; this
 * is the effects it drives, one per step, in the same order the file header describes.
 */
async function boot(): Promise<void> {
    await runLaunchSequence({
        applyPermissionPolicy,
        buildMenu,
        connectDaemon: startDaemonAndConnect,
        reportDaemonUnavailable: (error) => {
            const repair = error instanceof DaemonUnavailableError ? error.repair : '';
            const message = error instanceof Error ? error.message : String(error);
            logError(`daemon unavailable: ${message}${repair === '' ? '' : ` — ${repair}`}`);
            dialog.showErrorBox('Nex cannot reach its daemon', `${message}\n\n${repair}`);
            app.exit(1);
        },
        // SET-219: the web pane's find colours live in this process (they are pasted into a page
        // stylesheet by an injected script), so they are read before the first tab can exist.
        applyFindPalette: () => {
            setWebFindPalette(readSearchPalette());
        },
        createWindow: () => {
            mainWindow = createWindow();
        },
        // §SET-201: the config-LOAD path. A failure here keeps the configured value (the file
        // is never rewritten) and reports the reason, so Settings can show the user what their
        // own config line did rather than leaving them with a dead chord.
        registerGlobalHotkey: () => registerGlobalHotkey('launch'),
        // Best-effort and never blocking: a CLI that could not be linked is a log line (and, when
        // it is a real repair we could not do, one notification per build), not a failed launch.
        runCliInstallPolicy: applyCliInstallPolicy,
        refreshBundledSkill: applySkillRefreshIfEnabled,
        // Disabled unless NEX_AUTO_UPDATE=1 — see ./updater.ts for why (public-repo feed, and a
        // signed build) and what it logs when it declines. No network call happens by default.
        // §APP-013: RETURNED rather than fired-and-forgotten, so the launch wave owns it — it
        // runs beside the hotkey / CLI / skill steps instead of after them, and the sequence does
        // not call itself ready while an `import('update-electron-app')` is still resolving.
        startUpdater: () =>
            maybeStartAutoUpdate({ isPackaged: app.isPackaged, platform: process.platform }).then(
                (outcome) => {
                    updaterStarted = outcome.started;
                },
                () => {
                    updaterStarted = false;
                }
            ),
        installQuitGate: () => {
            quitGate = installQuitGate({
                counts: () => status?.counts ?? EMPTY_COUNTS,
                settingsPath: settingsFile(app.getPath('userData')),
                window: () => mainWindow,
                // §AGNT-117: the suppression is a DAEMON setting now, so the ⌘Q dialog and
                // Settings ▸ Workspaces are one switch rather than two that drift.
                confirmWhenActive: () => status?.daemonSettings.confirmQuitWhenActive ?? null,
                suppress: (value) =>
                    status?.setGeneralSetting('confirm-quit-when-active', value ? 'true' : 'false') ?? false,
                // §AGNT-114 step 1: the daemon holds the markdown buffers, so the pre-flight is a
                // round trip rather than a local call. Bounded inside the gate.
                flushPendingSaves: async () => {
                    await status?.flushPendingSaves();
                },
                onQuit: () => {
                    globalShortcut.unregisterAll();
                    status?.stop();
                    webHost?.stop();
                }
            });
        },
        logError
    });
}

// A second launch must never start a second shell: raise the window we already have.
if (!app.requestSingleInstanceLock()) {
    log('another Nex shell owns the single-instance lock; exiting');
    app.exit(0);
} else {
    app.on('second-instance', (_event, argv) => {
        showWindow();
        for (const arg of argv.slice(1)) {
            // CONT-124's filter: `open` renders whatever path it is handed AS MARKDOWN, so an
            // unfiltered forward would turn `open -a Nex.app photo.png` into a pane showing PNG
            // bytes as markdown source. `AppDelegate.swift:45-51` filtered for the same reason.
            if (!arg.startsWith('-') && isForwardableOpenPath(arg)) forwardOpen(arg);
        }
    });

    app.on('open-file', (event, filePath) => {
        event.preventDefault();
        if (!isForwardableOpenPath(filePath)) {
            log(`open-file: ignoring ${filePath} (not a markdown file)`);
            return;
        }
        forwardOpen(filePath);
    });

    app.whenReady().then(
        () => {
            void boot();
        },
        (error: unknown) => {
            logError('app failed to become ready', error);
        }
    );

    app.on('activate', () => {
        // macOS dock click with no window open: the sessions never went anywhere, so this is
        // just a new view onto them.
        if (BrowserWindow.getAllWindows().length === 0 && daemon !== null) {
            mainWindow = createWindow();
            mainWindow.show();
        } else {
            showWindow();
        }
        status?.acknowledgeActivation();
    });

    app.on('window-all-closed', () => {
        // macOS: stay alive in the dock (and in the tray) — closing the window is not
        // quitting, and quitting is not stopping the daemon either way.
        if (process.platform !== 'darwin') app.quit();
    });

    app.on('will-quit', () => {
        globalShortcut.unregisterAll();
        status?.stop();
        // Releases the host role explicitly, then destroys every browser view and the off-screen
        // holder window. The daemon keeps the panes; only the views die with the app.
        webHost?.stop();
        quitGate?.dispose();
        // Deliberately absent: anything that would signal, kill or stop the daemon.
    });

    // ^C / SIGTERM from a terminal (and from `scripts/smoke.mjs`) should run the same quit
    // path as ⌘Q rather than half-killing the process.
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        process.on(signal, () => {
            log(`received ${signal}`);
            app.quit();
        });
    }
}
