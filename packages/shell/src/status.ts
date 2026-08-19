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

import { Menu, Notification, Tray, app, nativeImage } from 'electron';
import { WebSocket } from 'ws';

import { type JsonObject, type WsDeltaEvent } from '@nex/protocol';

import {
    AgentModel,
    EMPTY_COUNTS,
    dockBadgeLabel,
    newlyWaitingPanes,
    trayIndicator,
    traySummaryLines,
    trayTooltip,
    type AgentCounts
} from './agents.js';
import type { DaemonLocation } from './daemon.js';
import { shellHello } from './hello.js';
import { trayIconDataUrl, type IconIndicator } from './icon.js';
import { log, logError, warn } from './log.js';

const RECONNECT_INITIAL_MS = 500;
const RECONNECT_MAX_MS = 15_000;
const RECONNECT_FACTOR = 2;
const RECONNECT_JITTER = 0.2;
/** At most one dock bounce per burst of waiting transitions. */
const BOUNCE_COOLDOWN_MS = 3_000;

export interface StatusHost {
    /** Tray "Show Nex" / tray click / a clicked notification. */
    showWindow(): void;
    /** Bounce suppression: §7.1's `isAppActive`. */
    isWindowFocused(): boolean;
    /** Tray "Start Daemon" — spawn/adopt and re-point this connection. */
    startDaemon(): void;
    /** Tray "Quit Nex" (goes through the quit gate). */
    quit(): void;
    /** A notification's default action: activate, switch workspace, focus the pane. */
    revealPane?(workspaceID: string, paneID: string): void;
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
    /** Re-point at a (re)discovered daemon and redial. */
    setLocation(location: DaemonLocation): void;
    /** Force a redial now (tray "Reconnect"). */
    reconnect(): void;
    readonly counts: AgentCounts;
    readonly connected: boolean;
    /** §8.4: the badge clears the moment the user activates the app. */
    acknowledgeActivation(): void;
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
    /** `nex-<paneID>` replace-on-repost identity (agent-lifecycle.md §7.5). */
    const liveNotifications = new Map<string, Notification>();

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

    function trayMenu(): Menu {
        const connected = ready;
        const summary = traySummaryLines(counts, connected).map((line) => ({ label: line, enabled: false }));
        return Menu.buildFromTemplate([
            ...summary,
            { type: 'separator' },
            { label: 'Show Nex', click: () => host.showWindow() },
            connected
                ? // Deliberately NOT a "restart": stopping the daemon would kill every
                  // session, which is the one thing the shell must never do
                  // (ARCHITECTURE.md). Reconnecting is the honest repair action.
                  { label: 'Reconnect to Daemon', click: () => reconnect() }
                : { label: 'Start Daemon', click: () => host.startDaemon() },
            { type: 'separator' },
            { label: 'Quit Nex', click: () => host.quit() }
        ]);
    }

    function updateTray(): void {
        const next = trayIndicator(counts, ready);
        if (tray === null) {
            tray = new Tray(nativeImage.createFromDataURL(trayIconDataUrl(next)));
            tray.on('click', () => host.showWindow());
            indicator = next;
            log(`tray ready (${next})`);
        } else if (next !== indicator) {
            tray.setImage(nativeImage.createFromDataURL(trayIconDataUrl(next)));
            indicator = next;
        }
        tray.setToolTip(trayTooltip(counts, ready));
        tray.setContextMenu(trayMenu());
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
        const title = readString(message, 'title') ?? 'Nex';
        const body = readString(message, 'body') ?? '';
        const key = readString(message, 'dedupeKey') ?? (paneID === undefined ? title : `nex-${paneID}`);

        // Replace-on-repost: close the pane's previous toast before showing the new one.
        liveNotifications.get(key)?.close();

        const notification = new Notification({ title, body, silent: false });
        notification.on('click', () => {
            host.showWindow();
            if (paneID !== undefined && workspaceID !== undefined) host.revealPane?.(workspaceID, paneID);
        });
        notification.on('close', () => {
            if (liveNotifications.get(key) === notification) liveNotifications.delete(key);
        });
        liveNotifications.set(key, notification);
        notification.show();
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
                JSON.stringify(shellHello({ token: location.token, name: 'nex-shell', version: app.getVersion() }))
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
                const daemon = isRecord(parsed['daemon']) ? parsed['daemon'] : {};
                log(
                    `status ws connected ${wsUrl()} daemon=${String(daemon['version'] ?? '?')} pid=${String(daemon['pid'] ?? '?')}`
                );
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
            case 'attention-request':
                if (!host.isWindowFocused()) bounce();
                break;
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
            publish();
            open();
        },
        stop(): void {
            stopped = true;
            if (reconnectTimer !== null) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            dropSocket();
            for (const notification of liveNotifications.values()) notification.close();
            liveNotifications.clear();
            tray?.destroy();
            tray = null;
            indicator = null;
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
        acknowledgeActivation(): void {
            setBadge('');
        },
        refresh(): void {
            publish();
        }
    };
}

function defaultSocketFactory(url: string, headers: Record<string, string>): WebSocket {
    return new WebSocket(url, { headers });
}
