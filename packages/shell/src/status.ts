/**
 * The main process's own connection to the daemon (M4).
 *
 * This is a **second** WebSocket, entirely separate from the one the renderer opens. Two
 * reasons, both from docs/research/stack.md §1:
 *
 *   - the preload surface stays empty — the shell's native features (dock badge, bounce,
 *     tray, notifications) never have to ask the renderer for state, so there is no IPC and
 *     no `contextBridge` API for a compromised page to reach;
 *   - they work *before and after* the page: the tray shows agent counts while the window is
 *     still loading, while it is closed (macOS keeps the app alive in the dock), and while
 *     the renderer is reloading.
 *
 * It is deliberately a near-read-only connection: `hello` → `welcome` → `snapshot` → `delta`,
 * and nothing else. It never attaches a pane (no binary frames), never sends a command, and
 * never mutates daemon state. Everything it learns goes through `./agents.ts` into two numbers.
 *
 * The one thing it *writes* is `reveal-request` (`revealPane`), and it is worth being explicit
 * about why it belongs here rather than in a new connection: a clicked notification has to
 * reach the UI, the UI is a different process, and the daemon is the only channel between them
 * that exists in every state this socket already handles (window closed, page reloading, a
 * second machine attached). It is a routing hint, not domain state — the daemon simply fans it
 * out and the client does the §8.5 focus dance.
 *
 * Reconnect is exponential-with-jitter and never gives up except on a fatal handshake
 * rejection (bad token / protocol mismatch — retrying those is a hot loop against a refusal,
 * exactly as `client/src/connection/socket.ts` reasons). A dropped connection immediately
 * clears the badge and flips the tray to its disconnected state: a stale "3 waiting" badge for
 * a daemon that is gone is worse than no badge.
 */

import { Menu, Notification, Tray, app, nativeImage, nativeTheme } from 'electron';
import { WebSocket } from 'ws';

import { type JsonObject, type WsDeltaEvent } from '@kelpi/protocol';

import {
    AgentModel,
    EMPTY_COUNTS,
    dockBadgeLabel,
    newlyWaitingPanes,
    noLongerWaitingPanes,
    trayIndicator,
    trayMenuRows,
    trayTooltip,
    type AgentCounts
} from './agents.js';
// §TERM-046: the OSC 52 clipboard bridge's decode + log line (pure, so it can be tested).
import { clipboardWriteLogLine, parseClipboardWrite } from './clipboard.js';
import type { DaemonLocation } from './daemon.js';
import { shellHello } from './hello.js';
// §SET-200/§SET-201: the report shape belongs to the module that produces it.
import type { HotkeyStatusReport } from './hotkey.js';
import {
    resolveTrayStatusPalette,
    trayIconDataUrl,
    trayIconIsTemplate,
    trayPaletteSignature,
    type IconIndicator,
    type TrayStatusPalette
} from './icon.js';
// §AGNT-073: the `kelpi-agent` category — its two actions and the index→action mapping.
import { agentNotificationSpec, notificationActionID, notificationLogLine } from './notify.js';
import {
    parseShellAction,
    parseWorkspaceSelection,
    shellActionAppliesHere
} from './shell-actions.js';
import { log, logError, warn } from './log.js';

const RECONNECT_INITIAL_MS = 500;
const RECONNECT_MAX_MS = 15_000;
const RECONNECT_FACTOR = 2;
const RECONNECT_JITTER = 0.2;
/** At most one dock bounce per burst of waiting transitions. */
const BOUNCE_COOLDOWN_MS = 3_000;

export interface StatusHost {
    /**
     * Tray "Show Kelpi", a tray pane row's reveal, or a clicked notification.
     *
     * Deliberately NOT the tray icon's own click: the shipped status item only toggles its
     * popover (`StatusBarController.swift:32-39,117-126`), so raising the window is always a
     * row the user chose, never a side effect of opening the menu (see `updateTray`).
     */
    showWindow(): void;
    /** Bounce suppression: §7.1's `isAppActive`. */
    isWindowFocused(): boolean;
    /** Tray "Start Daemon" — spawn/adopt and re-point this connection. */
    startDaemon(): void;
    /** Tray "Quit Kelpi" (goes through the quit gate). */
    quit(): void;
    /**
     * §APP-060: is the window assigned to every Mission Control desktop, and set it.
     *
     * The Swift app read the Dock's own "Assign To → All Desktops" binding out of
     * `com.apple.spaces` and reapplied it when the window was parented. That plist is private
     * and Electron cannot read it, so the port owns the toggle instead: it lives on the tray
     * (the one menu that is always available, even with the window closed) and persists in the
     * shell's `window-state.json`. Absent on a host that has no window to assign.
     */
    isVisibleOnAllWorkspaces?(): boolean;
    setVisibleOnAllWorkspaces?(value: boolean): void;
    /** Tray "Install CLI" — links /usr/local/bin/kelpi at this bundle (`./cli-install.ts`). */
    installCLI?(): void;
    /** A notification's default action: activate, switch workspace, focus the pane. */
    revealPane?(workspaceID: string, paneID: string): void;
    /**
     * The pane context menu's "Open in Finder" (TERM-110). The daemon has no file manager, so
     * it broadcasts `reveal-path` and whichever shell is attached runs it — the same
     * daemon-decides / shell-acts split `notification` and `reveal-pane` already use. `select`
     * reveals a FILE inside its folder (a markdown/diff pane's path); false opens a directory.
     */
    revealPath?(path: string, select: boolean): void;
    /**
     * §TERM-046: put text on THIS machine's clipboard, because a program in a pane asked to
     * (OSC 52) and the daemon's `clipboard-write` setting allowed it.
     *
     * The same daemon-decides / shell-acts split as `revealPath` above, and here it is load
     * bearing rather than merely tidy: the PTY runs on the daemon's machine, the clipboard
     * belongs to the machine a client is displayed on, and the main process is the only writer
     * that is not subject to a page's transient-activation rules. The page running inside this
     * window sees the same broadcast and deliberately stands down (`client/src/state/
     * clipboard.ts`) so there is exactly one writer per machine.
     *
     * The text is never logged — `./clipboard.ts` logs the pane and the byte count instead.
     */
    writeClipboard?(text: string): void;
    /**
     * The daemon's config files changed (SET-081's other half).
     *
     * `./hotkey.ts` reads `global-hotkey` from the config file, and until now it read it ONCE,
     * at launch — so a hotkey recorded in Settings did nothing until the app was restarted.
     * The daemon already broadcasts `settings-changed` to every attached socket and this is
     * one of them, so the shell learns about the write the same way the window does. The
     * re-registration itself stays a staged swap (§8.3): the new accelerator is registered
     * before the old one is dropped, so a rejected hotkey costs the user nothing.
     *
     * Deliberately carries no payload. The shell's own parser is the authority on what that
     * file means — it has to agree with itself across a launch and a re-read — so this is a
     * signal to RE-READ, not a value to trust.
     */
    settingsChanged?(): void;
    /**
     * The handshake delivered a settings payload (§AGNT-117).
     *
     * Separate from `settingsChanged`, which fires only on a *write*: this one fires on every
     * (re)connect, which is when the one-shot "migrate the old local quit suppression into the
     * daemon" pass can finally run — before that there is nowhere to migrate it to.
     */
    daemonSettingsReady?(settings: ShellDaemonSettings): void;
    /**
     * CONT-120's shell half: show the NATIVE open panel and forward the chosen file.
     *
     * The client cannot open one itself — a browser `<input type=file>` yields bytes, and the
     * daemon opens files by PATH on its own machine — so the request travels client → daemon →
     * here, and the answer goes back out as an ordinary `open` control command
     * (`daemon/src/ws/desktop.ts`). `paneID` is the pane that asked, so the new markdown pane
     * lands in that pane's workspace exactly as `kelpi md` would.
     */
    promptOpenFile?(paneID: string | null): void;
    /** The ••• menu's "Check for Updates…" (APP-026). */
    checkForUpdates?(): void;
    /** The ••• menu's "Install CLI" — the same action the tray item runs. */
    installCLINow?(): void;
    /**
     * §WS-151: this window's sidebar reported how many workspaces it has multi-selected.
     *
     * The mirror of `sendActivation` below — the shipped app's File ▸ "Deselect All Workspaces"
     * is disabled while the selection is empty, and the selection is client-local state in the
     * page. The count travels client → daemon → here so the row's enabled state can follow it.
     */
    workspaceSelectionChanged?(selectedCount: number): void;
}

/**
 * The slice of the daemon's settings snapshot the MAIN process acts on (§AGNT-117).
 *
 * Deliberately not the whole snapshot: everything else in it is the window's business, and a
 * main process that mirrored all of it would be a second source of truth for the renderer's
 * settings. Only what the shell's own native surfaces need lives here.
 */
export interface ShellDaemonSettings {
    /** §10 step 2: `confirm-quit-when-active`. Null until the daemon has said. */
    readonly confirmQuitWhenActive: boolean | null;
}

export interface StatusController {
    start(): void;
    stop(): void;
    /**
     * Ask the attached clients to go to a pane (a clicked notification, a tray jump). Returns
     * false when the socket is not ready — the caller has still raised the window, which is the
     * half of §8.5 the shell owns.
     */
    revealPane(workspaceID: string, paneID: string): boolean;
    /**
     * Ask the UI in this shell's window to run a menu item it owns (`menu-command`): ⌘O's
     * picker entry point, "Kelpi Help". Returns false when the socket is not ready.
     */
    sendMenuRequest(command: string): boolean;
    /**
     * §SET-200/§SET-201: tell the daemon — and through it every Settings window — what the OS
     * said about the global hotkey.
     *
     * Only this process can know: `globalShortcut` lives here, and the reason a chord was
     * refused ("This shortcut is already claimed by another app.") had nowhere else to go, so
     * Settings showed a hotkey that silently did nothing. Returns false when the socket is not
     * ready; the report is repeated on the next attempt, and a window that attaches later gets
     * the daemon's remembered copy.
     */
    reportHotkeyStatus(status: HotkeyStatusReport): boolean;
    /** Re-point at a (re)discovered daemon and redial. */
    setLocation(location: DaemonLocation): void;
    /** Force a redial now (tray "Reconnect"). */
    reconnect(): void;
    readonly counts: AgentCounts;
    readonly connected: boolean;
    /**
     * §AGNT-117: the daemon's settings, as far as the main process cares. Every field is null
     * until a `welcome` (or a `settings-changed`) has delivered one — "not told yet" is a
     * different state from any value, and the quit gate falls back to its legacy local flag
     * rather than guessing.
     */
    readonly daemonSettings: ShellDaemonSettings;
    /**
     * Write one general setting through the daemon (the ⌘Q dialog's "Don't ask again").
     * Fire-and-forget: the reply is a `command-reply` this connection ignores, and the value
     * comes back as a `settings-changed` broadcast like any other client's write. False when
     * the socket is not ready, which is the caller's cue to fall back to the local file.
     */
    setGeneralSetting(key: string, value: string): boolean;
    /**
     * §AGNT-114 step 1: ask the daemon to write out every pending editor autosave now. Resolves
     * false when the socket is not ready or the daemon did not answer in time — the caller
     * treats that as "carry on", never as "block the quit".
     */
    flushPendingSaves(timeoutMs?: number): Promise<boolean>;
    /** §8.4: the badge clears the moment the user activates the app. */
    acknowledgeActivation(): void;
    /**
     * §AGNT-056: tell the clients in this window that the app became active (or stopped being
     * active), so the pane grid can re-schedule — or suspend — its 600 ms status-clear timer.
     * Returns false when the socket is not up; the client's own default (active) then stands.
     */
    reportActivation(active: boolean): boolean;
    /** Rebuild the tray (host state, e.g. window visibility, changed). */
    refresh(): void;
}

interface JsonRecord {
    readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: JsonRecord, key: string): string | undefined {
    const value = source[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export interface StatusOptions {
    readonly location: DaemonLocation;
    readonly host: StatusHost;
    /**
     * This shell window's id, so a reveal lands only on the UI running in it (a second machine
     * attached to the same daemon must not jump because someone clicked a toast here).
     */
    readonly windowID?: string | undefined;
    /** Test seam; production uses the real `ws`. */
    readonly socketFactory?: ((url: string, headers: Record<string, string>) => WebSocket) | undefined;
    readonly random?: (() => number) | undefined;
}

export function createStatusController(options: StatusOptions): StatusController {
    const { host } = options;
    const model = new AgentModel();

    let location = options.location;
    let socket: WebSocket | null = null;
    let ready = false;
    let stopped = true;
    let fatal = false;
    let attempt = 0;
    let reconnectTimer: NodeJS.Timeout | null = null;

    let counts: AgentCounts = EMPTY_COUNTS;
    let waiting: ReadonlySet<string> = new Set();
    /**
     * False until the first publish after a (re)connect. Attaching to a daemon that already
     * has waiting agents is not a *transition* — bouncing the dock for state that has been
     * true for an hour would make every reconnect feel like an event.
     */
    let primed = false;
    let lastBounceAt = 0;
    let indicator: IconIndicator | null = null;
    let tray: Tray | null = null;
    /** Last logged tray-menu shape, so an unchanged menu does not re-log on every delta. */
    let lastMenuSignature = '';
    /** Last painted dot palette, so a recolour on an unchanged indicator still repaints (§M25). */
    let lastPaletteSignature = '';
    /** §AGNT-117: the daemon's answer, or null until it has given one. */
    let daemonSettings: ShellDaemonSettings = { confirmQuitWhenActive: null };
    /**
     * §M25: `chrome-appearance` + `chrome-colors`, as delivered by the daemon's settings
     * snapshot. Undefined / empty until a `welcome` has spoken, which resolves to the shipped
     * light column — the tray exists before the socket does.
     */
    let chromeAppearance: string | undefined;
    let chromeColors: Readonly<Record<string, string>> = {};
    /** OS dark/light, or null in a headless test host with no `nativeTheme`. */
    let systemDarkListener: (() => void) | null = null;
    /** In-flight `flush-saves-request` resolvers, keyed by the id we sent. */
    const pendingFlushes = new Map<string, (ok: boolean) => void>();
    let requestSeq = 0;
    /** `kelpi-<paneID>` replace-on-repost identity (agent-lifecycle.md §7.5). */
    const liveNotifications = new Map<string, Notification>();

    /**
     * Pull the fields the main process acts on out of a settings payload.
     *
     * Defensive field by field, like `AgentModel`: this is a wire object, an older daemon may
     * not carry the key at all, and a missing key must read as "not told" rather than `false`.
     */
    function readDaemonSettings(payload: unknown): void {
        if (!isRecord(payload)) return;
        const general = payload['general'];
        if (!isRecord(general)) return;
        const value = general['confirmQuitWhenActive'];
        if (typeof value !== 'boolean') return;
        daemonSettings = { confirmQuitWhenActive: value };
    }

    /**
     * §M25: the two chrome fields the TRAY acts on, from the same settings payload.
     *
     * Separate from `readDaemonSettings` because it reads a different sub-object and must
     * survive that one bailing out early (an older daemon with no `general.confirmQuitWhenActive`
     * still has a palette). Defensive field by field for the same reason: a wire object with a
     * missing or misshapen `chrome` block leaves the previous answer standing rather than
     * blanking the palette to a guess.
     */
    function readChromePalette(payload: unknown): void {
        if (!isRecord(payload)) return;
        const chrome = payload['chrome'];
        if (!isRecord(chrome)) return;
        const appearance = chrome['appearance'];
        if (typeof appearance === 'string') chromeAppearance = appearance;
        const colors = chrome['colors'];
        if (isRecord(colors)) {
            const next: Record<string, string> = {};
            for (const [key, value] of Object.entries(colors)) {
                if (typeof value === 'string') next[key] = value;
            }
            chromeColors = next;
        }
    }

    /**
     * §AGNT-056: shell → daemon → this window's clients, "the app is (not) active".
     *
     * Scoped to THIS window, like a reveal — two shell windows on one daemon are independently
     * active, and the pane grid whose 600 ms dwell timers this gates is the one inside this
     * window. A shell with no window id (single-window dev runs) sends it unscoped, which every
     * client applies. The log line is the only externally visible trace of a message that
     * otherwise leaves nothing behind, and `scripts/smoke.mjs` asserts it.
     */
    function sendActivation(active: boolean): boolean {
        const sent = sendJson(
            {
                type: 'shell-activation',
                active,
                ...(options.windowID === undefined ? {} : { windowID: options.windowID })
            },
            'activation report'
        );
        if (sent) log(`activation report: ${active ? 'active' : 'inactive'}`);
        return sent;
    }

    function sendJson(message: Record<string, unknown>, what: string): boolean {
        const current = socket;
        if (!ready || current === null || current.readyState !== WebSocket.OPEN) return false;
        try {
            current.send(JSON.stringify(message));
        } catch (error) {
            warn(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
        return true;
    }

    // ── native chrome ───────────────────────────────────────────────────────────────

    function setBadge(label: string): void {
        try {
            app.dock?.setBadge(label);
        } catch (error) {
            warn(`dock badge failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    function bounce(): void {
        try {
            app.dock?.bounce('informational');
        } catch {
            // Non-macOS, or no dock: the tray still carries the signal.
        }
    }

    /**
     * §AGNT-093 from the tray: raise the window, then ask this window's UI to switch workspace
     * and focus the pane. Exactly the sequence a clicked notification already uses — the shell
     * can only do the raising, the client owns the rest, and the daemon is the channel between
     * them (`host.revealPane` documents the ordering).
     */
    function revealFromTray(workspaceID: string, paneID: string): void {
        host.showWindow();
        if (host.revealPane === undefined) {
            log(`tray reveal for pane ${paneID}: host cannot reveal (window raised only)`);
            return;
        }
        host.revealPane(workspaceID, paneID);
    }

    function trayMenu(): Menu {
        const connected = ready;
        // §AGNT-090…093: workspace headers + one clickable row per non-idle pane. The rows
        // themselves are derived in `./agents.ts` (pure, and therefore tested); only the click
        // wiring is here.
        const rows = trayMenuRows(counts, connected).map((row) =>
            row.kind === 'pane'
                ? {
                      label: row.label,
                      click: () => {
                          revealFromTray(row.workspaceID, row.paneID);
                      }
                  }
                : { label: row.label, enabled: false }
        );
        return Menu.buildFromTemplate([
            ...rows,
            { type: 'separator' },
            { label: 'Show Kelpi', click: () => host.showWindow() },
            // §APP-060. A checkbox row rather than a submenu: it is one boolean, and the tray is
            // the only menu that still exists when the window is closed — which is exactly when
            // a user wants to change where the window will come back.
            ...(host.setVisibleOnAllWorkspaces === undefined
                ? []
                : ([
                      {
                          label: 'Show on All Desktops',
                          type: 'checkbox' as const,
                          checked: host.isVisibleOnAllWorkspaces?.() ?? false,
                          click: () => {
                              const next = !(host.isVisibleOnAllWorkspaces?.() ?? false);
                              host.setVisibleOnAllWorkspaces?.(next);
                              // Rebuild so the tick matches immediately rather than at the next
                              // agent delta (a menu that lags its own click reads as broken).
                              updateTray();
                          }
                      }
                  ] as const)),
            connected
                ? // Deliberately NOT a "restart": stopping the daemon would kill every
                  // session, which is the one thing the shell must never do
                  // (ARCHITECTURE.md). Reconnecting is the honest repair action.
                  { label: 'Reconnect to Daemon', click: () => reconnect() }
                : { label: 'Start Daemon', click: () => host.startDaemon() },
            // Only when the shell can actually do it (a packaged build with a CLI payload):
            // a menu item that always answers "there is nothing to install" is worse than none.
            ...(host.installCLI === undefined
                ? []
                : ([{ label: 'Install CLI', click: () => host.installCLI?.() }] as const)),
            { type: 'separator' },
            { label: 'Quit Kelpi', click: () => host.quit() }
        ]);
    }

    /**
     * §M25 — the dot colours the menu-bar icon is drawn with, resolved live.
     *
     * `AppReducer.swift:2538-2557` resolves a full `ChromeTheme` from the appearance preference
     * and the user's colour overrides and hands `statusWaiting` / `statusRunning` to
     * `StatusBarController.update(...)`; the port hard-coded one column, so the tray dot ignored
     * both. The scheme is read off `nativeTheme` rather than the window, because the Swift reads
     * it off `NSApp.effectiveAppearance` for the same stated reason: the menu bar sits in the
     * OS appearance, not the app's.
     */
    function trayPalette(): TrayStatusPalette {
        return resolveTrayStatusPalette({
            appearance: chromeAppearance,
            systemDark: nativeTheme.shouldUseDarkColors === true,
            overrides: chromeColors
        });
    }

    /**
     * §AGNT-087: the icon for one indicator, marked as a template image when it carries no
     * status dot — an idle glyph then TINTS with the menu bar (and inverts under a highlighted
     * status item) instead of sitting there as a fixed mid-grey. A dotted state cannot be a
     * template (AppKit keeps only alpha), so `trayIconIsTemplate` decides both here and in the
     * drawing, from one rule. The dot's COLOUR is `trayPalette()`'s (§M25); the two decisions
     * stay separate, so an unresolvable colour never turns a dotted state into a template.
     *
     * The image is 16×16 POINTS with a real @2x representation — one PNG per scale factor on
     * one empty image, which is how Electron spells NSImage's size-in-points + retina
     * backings. A single 2x PNG through `createFromDataURL` would land as a 32-POINT image
     * and leave the menu bar to squash it.
     */
    function trayImage(indicator_: IconIndicator): Electron.NativeImage {
        const palette = trayPalette();
        const image = nativeImage.createEmpty();
        for (const scale of [1, 2]) {
            image.addRepresentation({ scaleFactor: scale, dataURL: trayIconDataUrl(indicator_, scale, palette) });
        }
        image.setTemplateImage(trayIconIsTemplate(indicator_));
        return image;
    }

    function updateTray(): void {
        const next = trayIndicator(counts, ready);
        // §M25: a recoloured dot on an UNCHANGED indicator is still a repaint. Without this the
        // Settings ▸ Appearance write, and an OS light/dark flip, would only reach the menu bar
        // the next time an agent started or stopped.
        const palette = trayPaletteSignature(trayPalette());
        if (tray === null) {
            tray = new Tray(trayImage(next));
            // NO `tray.on('click', …)` here, and none anywhere else (UI-FIDELITY U2 / N16).
            // `setContextMenu` alone is the whole gesture: macOS opens the menu on a left-click,
            // and Electron ALSO delivers the `click` event next to it — so a handler that raised
            // the window made one click do two things, and the window came forward under a menu
            // the user had only meant to read. The shipped app's status item does exactly one:
            // its button's action is `togglePopover`, which shows or closes the popover and
            // nothing else — no `activate`, no window raise (`StatusBarController.swift:32-39,
            // 117-126`). Raising the window stays a DELIBERATE choice inside the menu: the
            // "Show Kelpi" row below, or any pane row (which reveals through `revealFromTray`).
            indicator = next;
            lastPaletteSignature = palette;
            // `handlers=` is MEASURED off the tray's own listener registry, not asserted: the
            // absence above is the whole fix, and a comment saying so is not observable from
            // outside the process — where a tray is not screenshottable either (§AGNT-090's
            // limitation). `smoke.mjs` and the audit read this number, so a handler that creeps
            // back in — for any event, under any name — shows up here as `handlers=1`.
            const handlers = tray.eventNames().length;
            log(`tray ready (${next}${trayIconIsTemplate(next) ? ', template' : ''}, handlers=${String(handlers)})`);
        } else if (next !== indicator || palette !== lastPaletteSignature) {
            tray.setImage(trayImage(next));
            if (palette !== lastPaletteSignature) log(`tray palette: ${palette}`);
            indicator = next;
            lastPaletteSignature = palette;
        }
        tray.setToolTip(trayTooltip(counts, ready));
        const rows = trayMenuRows(counts, ready);
        tray.setContextMenu(trayMenu());
        // A tray menu is not observable from outside the process (no DOM, no screenshot), so the
        // shape it was built with is logged: `scripts/packaged-smoke.mjs` and the audit assert
        // this line, which is what makes §AGNT-090's per-pane rows a claim rather than a hope.
        const paneRows = rows.filter((row) => row.kind === 'pane').length;
        const signature = `${String(rows.length - paneRows)}w/${String(paneRows)}p`;
        if (signature !== lastMenuSignature) {
            lastMenuSignature = signature;
            log(`tray menu: ${String(rows.length - paneRows)} workspace row(s), ${String(paneRows)} pane row(s)`);
        }
    }

    /** Recompute counts, then push them into every native surface. */
    function publish(): void {
        const previous = counts;
        counts = model.counts();
        const badge = ready ? dockBadgeLabel(counts) : '';
        setBadge(badge);
        if (counts.running !== previous.running || counts.waiting !== previous.waiting) {
            log(`agents running=${String(counts.running)} waiting=${String(counts.waiting)} badge=${badge === '' ? '-' : badge}`);
        }

        const nextWaiting = new Set(counts.waitingPaneIDs);
        // Until the attach snapshot has been folded in, every "waiting" pane is pre-existing
        // state, not a transition (`primed` is set by the snapshot handler).
        const newlyWaiting = primed ? newlyWaitingPanes(waiting, nextWaiting) : [];
        // §AGNT-077: a pane that stopped waiting withdraws its toast. Visiting the pane is what
        // clears the status, so this is the native half of "focus dismisses the notification" —
        // the in-app toast is already dropped client-side. Unconditional on `primed`: a
        // notification can only exist if we posted it, and one whose pane is no longer waiting
        // is stale whether or not the transition happened before we attached.
        for (const paneID of noLongerWaitingPanes(waiting, nextWaiting)) {
            liveNotifications.get(`kelpi-${paneID}`)?.close();
        }
        waiting = nextWaiting;

        // §7.1 `shouldBounce`: only when the app is not the frontmost thing the user is
        // looking at. The daemon has already applied the background-work suppression.
        if (newlyWaiting.length > 0 && !host.isWindowFocused()) {
            const now = Date.now();
            if (now - lastBounceAt > BOUNCE_COOLDOWN_MS) {
                lastBounceAt = now;
                bounce();
            }
        }
        updateTray();
    }

    function notify(message: JsonRecord): void {
        if (!Notification.isSupported()) return;
        const paneID = readString(message, 'paneID');
        const workspaceID = readString(message, 'workspaceID');
        const title = readString(message, 'title') ?? 'Kelpi';
        const body = readString(message, 'body') ?? '';
        const key = readString(message, 'dedupeKey') ?? (paneID === undefined ? title : `kelpi-${paneID}`);

        // Replace-on-repost: close the pane's previous toast before showing the new one.
        liveNotifications.get(key)?.close();

        /** §AGNT-075: the body tap and the "Open" action are the same behaviour. */
        const open = (): void => {
            host.showWindow();
            if (paneID !== undefined && workspaceID !== undefined) host.revealPane?.(workspaceID, paneID);
        };

        // §AGNT-073: every agent notification carries the `kelpi-agent` category's action set,
        // built in one place so the two buttons are always the same two, in the same order.
        const spec = agentNotificationSpec({ title, body });
        const notification = new Notification({
            title: spec.title,
            body: spec.body,
            silent: spec.silent,
            // Electron's `NotificationAction[]` is mutable; the spec's is not, by design.
            actions: spec.actions.map((action) => ({ type: action.type, text: action.text }))
        });
        notification.on('click', open);
        notification.on('action', (_event, index) => {
            // Index → name, never a bare `index === 0`: the mapping lives with the actions.
            const action = notificationActionID(index);
            if (action === 'open') {
                open();
                return;
            }
            // "Dismiss" does nothing beyond dismissing (§AGNT-075). macOS closes the
            // notification itself when an action is chosen; this makes it true either way and
            // lets the `close` handler drop it from the live map.
            if (action === 'dismiss') notification.close();
        });
        notification.on('close', () => {
            if (liveNotifications.get(key) === notification) liveNotifications.delete(key);
        });
        liveNotifications.set(key, notification);
        notification.show();
        // The buttons live in the OS notification centre, where no screenshot reaches: this line
        // is how the smoke and the audit prove a real `Notification` carried the category's
        // actions.
        log(notificationLogLine(key, spec));
    }

    // ── the socket ──────────────────────────────────────────────────────────────────

    function wsUrl(): string {
        return `${location.url.replace(/^http/, 'ws')}/ws`;
    }

    function open(): void {
        if (stopped || fatal || socket !== null) return;
        const url = wsUrl();
        let next: WebSocket;
        try {
            next = (options.socketFactory ?? defaultSocketFactory)(url, {
                // The daemon accepts `?token=` or a bearer header; the header keeps the token
                // out of URLs and logs (`ws/http.ts` `extractRequestToken`).
                authorization: `Bearer ${location.token}`
            });
        } catch (error) {
            logError('status socket could not be created', error);
            scheduleReconnect();
            return;
        }
        socket = next;

        next.on('open', () => {
            if (socket !== next) return;
            // The token rides in the hello as well as the bearer header — see `./hello.ts` for
            // why both halves matter now that the upgrade no longer refuses a bad token.
            next.send(
                JSON.stringify(shellHello({ token: location.token, name: 'kelpi-shell', version: app.getVersion() }))
            );
        });

        next.on('message', (data: unknown, isBinary: boolean) => {
            // Binary frames are PTY traffic: this connection never attaches a pane, so
            // anything binary is not ours to read.
            if (isBinary || socket !== next) return;
            handleText(String(data));
        });

        next.on('error', (error: Error) => {
            if (socket !== next) return;
            warn(`status socket error: ${error.message}`);
        });

        next.on('close', (code: number) => {
            if (socket !== next) return;
            socket = null;
            const wasReady = ready;
            ready = false;
            // Anything waiting on the daemon gets a definite "no" rather than its own timeout:
            // a quit held open by a flush must not wait 750 ms for a socket that has gone.
            for (const resolve of [...pendingFlushes.values()]) resolve(false);
            pendingFlushes.clear();
            // `daemonSettings` deliberately survives: the last value the daemon gave is a better
            // basis for a ⌘Q than falling back to a legacy file the user may never have touched.
            model.reset();
            waiting = new Set();
            primed = false;
            publish();
            if (wasReady) log(`status ws disconnected (${String(code)})`);
            scheduleReconnect();
        });
    }

    function handleText(raw: string): void {
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return;
        }
        if (!isRecord(parsed)) return;
        switch (parsed['type']) {
            case 'welcome': {
                ready = true;
                attempt = 0;
                // §AGNT-117: settings ride the handshake, so the quit gate has the real
                // `confirm-quit-when-active` before the user can press ⌘Q.
                readDaemonSettings(parsed['settings']);
                // §M25: …and the chrome palette, so the tray's dot is the user's colour from the
                // first paint rather than after their first agent event.
                readChromePalette(parsed['settings']);
                host.daemonSettingsReady?.(daemonSettings);
                const daemon = isRecord(parsed['daemon']) ? parsed['daemon'] : {};
                log(
                    `status ws connected ${wsUrl()} daemon=${String(daemon['version'] ?? '?')} pid=${String(daemon['pid'] ?? '?')}`
                );
                // §AGNT-056: state the window's CURRENT activation the moment there is a socket
                // to state it on. Focus/blur only report transitions, and a client that
                // attaches to a window it cannot see (page reload while the app is in the
                // background, a window opened unfocused) would otherwise assume it is active
                // and clear a badge nobody has looked at. Scoped to this window, so a shell
                // with no window at all reports into an empty room.
                sendActivation(host.isWindowFocused());
                publish();
                break;
            }
            case 'snapshot': {
                const state = parsed['state'];
                if (!isRecord(state)) break;
                // The model reads this defensively field by field, so the shape is checked
                // where it is used rather than trusted here.
                model.applySnapshot(state as unknown as JsonObject);
                publish();
                // From here on, a pane entering "waiting" really is a transition.
                primed = true;
                log(`snapshot workspaces=${String(counts.workspaces.length)} running=${String(counts.running)} waiting=${String(counts.waiting)}`);
                break;
            }
            case 'delta': {
                const events = parsed['events'];
                if (!Array.isArray(events)) break;
                model.applyDeltas(events as readonly WsDeltaEvent[]);
                publish();
                break;
            }
            case 'notification':
                notify(parsed);
                break;
            case 'clipboard-write': {
                /*
                 * §TERM-046. The daemon has already parsed the OSC 52, refused it if it was a
                 * READ, and dropped it if `clipboard-write` is off — so anything arriving here
                 * is a write the user's own setting allowed. All that is left is the part only
                 * a native process can do.
                 *
                 * Unlike `shell-action` there is no window filter, and that is deliberate: a
                 * clipboard is per MACHINE, not per window, so two shell windows on one host
                 * writing the same string is a no-op rather than a conflict.
                 */
                const write = parseClipboardWrite(parsed);
                if (write === null) break;
                host.writeClipboard?.(write.text);
                log(clipboardWriteLogLine(write));
                break;
            }
            case 'reveal-path': {
                // TERM-110's shell half. Nothing is validated here beyond "there is a path":
                // the daemon read it off a pane's own record, and Electron's own APIs are what
                // refuse a path that does not exist.
                const path = readString(parsed, 'path');
                if (path === undefined) break;
                host.revealPath?.(path, parsed['select'] === true);
                break;
            }
            case 'settings-changed':
                // SET-081: the global hotkey lives in the config file the daemon owns, so a
                // Settings write reaches the shell here rather than through a file watcher of
                // its own. `./hotkey.ts` re-reads the file rather than trusting the payload.
                //
                // §AGNT-117 is the exception, and deliberately so: `confirm-quit-when-active` is
                // not a hotkey the shell has its own parser for — it is one boolean whose only
                // authority is the daemon, and reading it here is what lets a Settings toggle
                // move the ⌘Q dialog without a restart.
                readDaemonSettings(parsed['settings']);
                // §M25: Settings ▸ Appearance recoloured a status dot (or switched the chrome's
                // light/dark), and the menu bar has to follow it live — the Swift re-resolves the
                // theme on every `updateExternalIndicators`, which a settings write triggers.
                readChromePalette(parsed['settings']);
                updateTray();
                host.settingsChanged?.();
                break;
            case 'flush-saves-result': {
                const id = readString(parsed, 'id');
                if (id === undefined) break;
                const resolve = pendingFlushes.get(id);
                if (resolve === undefined) break;
                pendingFlushes.delete(id);
                resolve(parsed['ok'] !== false);
                break;
            }
            case 'shell-action': {
                // The mirror of `reveal-path`: the daemon has no window, no dialogs and no
                // installer, so it broadcasts and whichever shell is attached acts. The
                // decoding and the window filter are `./shell-actions.ts` (pure, and therefore
                // tested); only the side effects are here.
                const request = parseShellAction(parsed);
                if (request === null || !shellActionAppliesHere(request.windowID, options.windowID)) break;
                log(`shell-action: ${request.action}`);
                if (request.action === 'open-file-dialog') host.promptOpenFile?.(request.paneID);
                else if (request.action === 'install-cli') host.installCLINow?.();
                else host.checkForUpdates?.();
                break;
            }
            case 'attention-request':
                if (!host.isWindowFocused()) bounce();
                break;
            case 'workspace-selection': {
                /*
                 * §WS-151: the sidebar's multi-selection, relayed so File ▸ Deselect All
                 * Workspaces can be greyed exactly as `.disabled(selectedWorkspaceIDs.isEmpty)`
                 * greys it in the shipped app.
                 *
                 * The window filter is `shell-action`'s, and it matters for the same reason: two
                 * shell windows have two menus and two independent selections, and an unscoped
                 * report (a browser with no `?shellWindow=`) is everyone's.
                 */
                const report = parseWorkspaceSelection(parsed);
                if (report === null || !shellActionAppliesHere(report.windowID, options.windowID)) break;
                host.workspaceSelectionChanged?.(report.selected);
                break;
            }
            case 'rejected': {
                const code = readString(parsed, 'code') ?? 'server-error';
                const message = readString(parsed, 'message') ?? '';
                // Only a transient server error is worth another dial.
                fatal = code !== 'server-error';
                logError(`status ws rejected (${code}) ${message}`);
                break;
            }
            default:
                break;
        }
    }

    function scheduleReconnect(): void {
        if (stopped || fatal || reconnectTimer !== null) return;
        const base = Math.min(RECONNECT_MAX_MS, RECONNECT_INITIAL_MS * Math.pow(RECONNECT_FACTOR, attempt));
        attempt += 1;
        const random = options.random ?? Math.random;
        const spread = base * RECONNECT_JITTER;
        const delay = Math.max(0, Math.round(base - spread + random() * spread * 2));
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            open();
        }, delay);
        reconnectTimer.unref?.();
    }

    function dropSocket(): void {
        const current = socket;
        socket = null;
        ready = false;
        if (current === null) return;
        current.removeAllListeners();
        try {
            current.close();
        } catch {
            // Already gone.
        }
    }

    function reconnect(): void {
        if (stopped) return;
        fatal = false;
        attempt = 0;
        if (reconnectTimer !== null) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        dropSocket();
        model.reset();
        waiting = new Set();
        primed = false;
        publish();
        open();
    }

    return {
        start(): void {
            if (!stopped) return;
            stopped = false;
            fatal = false;
            /*
             * §M25: while the appearance preference is `system`, the tray's palette is the OS's
             * to change. The Swift gets this for free — `updateExternalIndicators` re-resolves
             * `NSApp.effectiveAppearance` every time it runs, and AppKit re-runs the view on an
             * appearance change — so the port subscribes explicitly. Registered once per start,
             * released in `stop`, and defensive about the host: a `nativeTheme` without an
             * emitter (a stubbed Electron in a harness) simply means no live flip.
             */
            if (systemDarkListener === null && typeof nativeTheme?.on === 'function') {
                systemDarkListener = (): void => {
                    updateTray();
                };
                nativeTheme.on('updated', systemDarkListener);
            }
            publish();
            open();
        },
        stop(): void {
            stopped = true;
            if (reconnectTimer !== null) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            if (systemDarkListener !== null) {
                nativeTheme.off?.('updated', systemDarkListener);
                systemDarkListener = null;
            }
            dropSocket();
            for (const notification of liveNotifications.values()) notification.close();
            liveNotifications.clear();
            tray?.destroy();
            tray = null;
            indicator = null;
            lastPaletteSignature = '';
        },
        revealPane(workspaceID: string, paneID: string): boolean {
            const current = socket;
            if (!ready || current === null || current.readyState !== WebSocket.OPEN) return false;
            try {
                current.send(
                    JSON.stringify({
                        type: 'reveal-request',
                        workspaceID,
                        paneID,
                        // Scoped to this window: the daemon fans the message out to every
                        // client, and only the UI loaded with this id acts on it.
                        ...(options.windowID === undefined ? {} : { windowID: options.windowID })
                    })
                );
            } catch (error) {
                warn(`reveal request failed: ${error instanceof Error ? error.message : String(error)}`);
                return false;
            }
            return true;
        },
        reportActivation(active: boolean): boolean {
            return sendActivation(active);
        },
        reportHotkeyStatus(status: HotkeyStatusReport): boolean {
            // NOT scoped to this window: a hotkey is registered for the whole app, so the
            // warning belongs in every Settings window attached to this daemon — including a
            // browser one, which has no registrar of its own and would otherwise report the
            // hotkey as working.
            return sendJson({ type: 'hotkey-status', ...status }, 'hotkey status');
        },
        sendMenuRequest(command: string): boolean {
            const current = socket;
            if (!ready || current === null || current.readyState !== WebSocket.OPEN) return false;
            try {
                current.send(
                    JSON.stringify({
                        type: 'menu-request',
                        command,
                        // Scoped to this window for the same reason a reveal is: a second
                        // machine attached to the same daemon must not open Help because
                        // somebody used the menu bar here.
                        ...(options.windowID === undefined ? {} : { windowID: options.windowID })
                    })
                );
            } catch (error) {
                warn(`menu request failed: ${error instanceof Error ? error.message : String(error)}`);
                return false;
            }
            return true;
        },
        setLocation(next: DaemonLocation): void {
            location = next;
            reconnect();
        },
        reconnect,
        get counts(): AgentCounts {
            return counts;
        },
        get connected(): boolean {
            return ready;
        },
        get daemonSettings(): ShellDaemonSettings {
            return daemonSettings;
        },
        setGeneralSetting(key: string, value: string): boolean {
            requestSeq += 1;
            // The ordinary client command envelope — `ws/sync.ts` matches the settings verbs
            // before the wire decoder, so this is the same path Settings ▸ Workspaces uses. The
            // `command-reply` is ignored: the authoritative echo is `settings-changed`.
            return sendJson(
                {
                    type: 'command',
                    id: `shell-set-${String(requestSeq)}`,
                    payload: { command: 'set-general-setting', key, value }
                },
                'settings write'
            );
        },
        async flushPendingSaves(timeoutMs = 750): Promise<boolean> {
            requestSeq += 1;
            const id = `shell-flush-${String(requestSeq)}`;
            if (!sendJson({ type: 'flush-saves-request', id }, 'flush request')) return false;
            return new Promise<boolean>((resolve) => {
                const settle = (ok: boolean): void => {
                    clearTimeout(timer);
                    pendingFlushes.delete(id);
                    resolve(ok);
                };
                const timer = setTimeout(() => {
                    settle(false);
                }, timeoutMs);
                timer.unref?.();
                pendingFlushes.set(id, settle);
            });
        },
        acknowledgeActivation(): void {
            /*
             * §M24 — clear, then re-state. `ContentView.swift:347-349` is
             * `NSApp.dockTile.badgeLabel = nil` immediately followed by
             * `store.send(.updateExternalIndicators)`, whose effect
             * (`AppReducer.swift:2559-2563`) re-derives the badge from the CURRENT waiting
             * count. The clear is a flush, not a decision: a badge standing for agents still
             * waiting in OTHER workspaces comes straight back, and only a badge whose cause the
             * activation actually resolved stays gone.
             *
             * The port stopped at the clear, so the dock went quiet until the next daemon delta
             * happened along — which, for agents nobody is looking at, can be never.
             *
             * `publish()` rather than a bare re-`setBadge`: the same `updateExternalIndicators`
             * repaints the tray too, and re-running the whole publish is safe by construction —
             * the waiting SET is unchanged, so `newlyWaitingPanes` is empty and nothing bounces
             * or re-notifies.
             */
            setBadge('');
            publish();
        },
        refresh(): void {
            publish();
        }
    };
}

function defaultSocketFactory(url: string, headers: Record<string, string>): WebSocket {
    return new WebSocket(url, { headers });
}
