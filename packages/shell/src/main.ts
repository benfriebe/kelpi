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

import { BrowserWindow, Menu, app, dialog, globalShortcut, screen, session, shell } from 'electron';
import { randomUUID } from 'node:crypto';

import { sendControlCommand } from './control.js';
import {
    DaemonUnavailableError,
    clientUrl,
    ensureDaemon,
    type DaemonLocation
} from './daemon.js';
import { readGlobalHotkeySettings, swapGlobalHotkey, type HotkeyRegistrar } from './hotkey.js';
import { log, logError, warn } from './log.js';
import { createStatusController, type StatusController } from './status.js';
import { installQuitGate, settingsFile, type QuitGate } from './quit.js';
import { createWebPaneHost, type WebPaneHost } from './webhost/index.js';
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
let hotkeyHideOnRepress = true;
let saveTimer: NodeJS.Timeout | null = null;
let loadRetries = 0;
/** Files handed to us by Finder before the daemon was ready. */
const pendingOpens: string[] = [];

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

function restoreBounds(): { bounds: Rect; fullScreen: boolean } {
    const stored = readWindowState(stateFile());
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const bounds =
        stored.bounds === null
            ? defaultBounds(primary)
            : clampBoundsToDisplays(stored.bounds, displays, primary);
    return { bounds, fullScreen: stored.fullScreen };
}

function scheduleBoundsSave(window: BrowserWindow): void {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        // shell-ui.md §1: never store a fullscreen (or transitioning) frame — the stored one
        // must always be the windowed frame, or restore comes back with a screen-sized window.
        if (window.isDestroyed() || window.isFullScreen() || window.isMinimized()) return;
        writeWindowState(stateFile(), { bounds: window.getNormalBounds(), fullScreen: false });
    }, SAVE_DEBOUNCE_MS);
    saveTimer.unref?.();
}

function saveFullScreenFlag(window: BrowserWindow, fullScreen: boolean): void {
    const stored = readWindowState(stateFile());
    writeWindowState(stateFile(), {
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

function loadDaemonUrl(window: BrowserWindow): void {
    if (daemon === null) return;
    // `shellWindow` marks the page as "the UI inside this shell window" — it is what makes the
    // client's web-pane geometry reports actionable and scopes reveal requests to this window.
    // The client keeps it (only `daemon`/`token` are stripped from the visible URL).
    const target = `${clientUrl(daemon)}&shellWindow=${encodeURIComponent(shellWindowID)}`;
    // The token rides in the query string (the client reads it, remembers it, and strips it
    // from the address bar). It must never reach a log file, so redact it here — which also
    // makes the log line proof that a token WAS attached.
    log(`loading ${target.replace(daemon.token, '<token>')}`);
    void window.loadURL(target).catch((error: unknown) => {
        logError(`loadURL failed for ${daemon?.url ?? '(unknown)'}`, error);
    });
}

function createWindow(): BrowserWindow {
    const { bounds, fullScreen } = restoreBounds();
    const window = new BrowserWindow({
        ...bounds,
        minWidth: MIN_WINDOW_WIDTH,
        minHeight: MIN_WINDOW_HEIGHT,
        show: false,
        title: 'Nex',
        backgroundColor: '#16161a',
        // A standard frame on purpose. `titleBarStyle: 'hiddenInset'` would look closer to the
        // Swift app, but the client's top bar does not reserve the traffic lights' inset yet,
        // so the buttons would sit on top of its controls. Flip this once the client does.
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

    if (fullScreen) window.setFullScreen(true);
    applySecurityPolicy(window);

    window.once('ready-to-show', () => window.show());
    window.on('resize', () => scheduleBoundsSave(window));
    window.on('move', () => scheduleBoundsSave(window));
    window.on('enter-full-screen', () => saveFullScreenFlag(window, true));
    window.on('leave-full-screen', () => saveFullScreenFlag(window, false));
    window.on('focus', () => {
        // agent-lifecycle.md §8.4: activating the app clears the badge immediately.
        status?.acknowledgeActivation();
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

function registerGlobalHotkey(): void {
    const settings = readGlobalHotkeySettings();
    hotkeyHideOnRepress = settings.hideOnRepress;
    if (settings.trigger !== null && settings.accelerator === null) {
        warn(`global-hotkey "${settings.configString ?? '?'}" has no Electron accelerator; ignored`);
        return;
    }
    const result = swapGlobalHotkey(registrar, hotkeyAccelerator, settings.accelerator, toggleFrontmost);
    hotkeyAccelerator = result.accelerator;
    if (settings.accelerator === null) {
        log('global-hotkey: none configured');
        return;
    }
    if (result.ok) log(`global-hotkey registered ${settings.accelerator} (${settings.configString ?? ''})`);
    // §8.4 launch-path failure: keep the configured value and surface the error rather than
    // silently dropping the user's hotkey.
    else logError(`global-hotkey ${settings.accelerator} could not be registered: ${result.error ?? 'rejected'}`);
}

// ── Finder "Open With" ──────────────────────────────────────────────────────────────

function forwardOpen(filePath: string): void {
    if (daemon === null) {
        pendingOpens.push(filePath);
        return;
    }
    void sendControlCommand(daemon.paths.socket, { command: 'open', path: filePath }).then((result) => {
        if (!result.ok) warn(`open ${filePath} failed: ${result.error ?? 'no reply'}`);
    });
    showWindow();
}

function drainPendingOpens(): void {
    const queued = pendingOpens.splice(0, pendingOpens.length);
    for (const filePath of queued) forwardOpen(filePath);
}

// ── application menu ────────────────────────────────────────────────────────────────

function buildMenu(): void {
    // Keep it minimal: the UI owns its own commands, but macOS needs an app menu for ⌘Q,
    // and Edit needs its roles for copy/paste to reach the web contents.
    const template: Electron.MenuItemConstructorOptions[] = [
        ...(process.platform === 'darwin'
            ? ([
                  {
                      label: 'Nex',
                      submenu: [
                          { role: 'about' },
                          { type: 'separator' },
                          { role: 'hide' },
                          { role: 'hideOthers' },
                          { role: 'unhide' },
                          { type: 'separator' },
                          { role: 'quit' }
                      ]
                  }
              ] as Electron.MenuItemConstructorOptions[])
            : []),
        {
            label: 'File',
            submenu: [
                { label: 'New Window', click: () => showWindow() },
                { type: 'separator' },
                process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
            ]
        },
        { role: 'editMenu' },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'togglefullscreen' }
            ]
        },
        { role: 'windowMenu' }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── boot ────────────────────────────────────────────────────────────────────────────

async function startDaemonAndConnect(): Promise<void> {
    daemon = await ensureDaemon({
        env: process.env,
        appDir: app.getAppPath(),
        resourcesPath: process.resourcesPath
    });
    log(`daemon ready ${daemon.url} (spawned=${String(daemon.spawned)})`);

    if (status === null) {
        status = createStatusController({
            location: daemon,
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
                }
            }
        });
        status.start();
    } else {
        status.setLocation(daemon);
    }

    // The web-pane host claims the daemon's `web-pane` role and owns one WebContentsView per
    // tab (`./webhost/`). It is a separate connection from the status socket on purpose: losing
    // one role must not disturb the other, and both work while the window is closed.
    if (webHost === null) {
        webHost = createWebPaneHost({
            location: daemon,
            version: app.getVersion(),
            // Embedding: the host places a pane's view in THIS window when the UI running in it
            // (same `windowID`) reports where it drew the page area. Looked up lazily — the
            // window is created after this, and can be closed and re-opened under it.
            window: () => mainWindow,
            windowID: shellWindowID
        });
        webHost.start();
    } else {
        webHost.setLocation(daemon);
    }
    drainPendingOpens();
}

async function boot(): Promise<void> {
    applyPermissionPolicy();
    buildMenu();

    try {
        await startDaemonAndConnect();
    } catch (error) {
        const repair = error instanceof DaemonUnavailableError ? error.repair : '';
        const message = error instanceof Error ? error.message : String(error);
        logError(`daemon unavailable: ${message}${repair === '' ? '' : ` — ${repair}`}`);
        dialog.showErrorBox('Nex cannot reach its daemon', `${message}\n\n${repair}`);
        app.exit(1);
        return;
    }

    mainWindow = createWindow();
    registerGlobalHotkey();
    quitGate = installQuitGate({
        counts: () => status?.counts ?? { running: 0, waiting: 0, workspaces: [], panes: [], waitingPaneIDs: [] },
        settingsPath: settingsFile(app.getPath('userData')),
        window: () => mainWindow,
        onQuit: () => {
            globalShortcut.unregisterAll();
            status?.stop();
            webHost?.stop();
        }
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
            if (!arg.startsWith('-')) forwardOpen(arg);
        }
    });

    app.on('open-file', (event, filePath) => {
        event.preventDefault();
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
