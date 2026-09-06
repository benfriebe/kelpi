/**
 * The web-pane host's own WebSocket to the daemon.
 *
 * A **third** connection, alongside the renderer's and the main process's status socket
 * (`../status.ts`), for the same reason the status one exists: the host must work before the
 * window has loaded, while it is reloading, and while it is closed — an agent driving
 * `kelpi web capture` does not care whether anyone is looking at the UI. Keeping it separate from
 * the status socket also keeps the two roles independent: losing the host role never disturbs
 * the tray, and a status resync never re-registers the host.
 *
 * The handshake claims the role in one round trip by listing `web-pane-host` in the `hello`
 * capabilities (`daemon/src/webpane/HOST_PROTOCOL.md` §1); the explicit `host-register` message
 * is only used to re-claim after a `host-revoked`. On (re)registration the daemon replays one
 * `pane-open` per existing web pane, which is what rebuilds the view set after a reconnect —
 * so this module deliberately does *not* try to remember anything across connections.
 *
 * Reconnect is exponential-with-jitter and gives up only on a fatal handshake rejection, exactly
 * as `../status.ts` reasons about it.
 */

import { WebSocket } from 'ws';

import { type JsonObject } from '@kelpi/protocol';

import type { DaemonLocation } from '../daemon.js';
import { shellHello } from '../hello.js';
import { log, logError, warn } from '../log.js';

/**
 * Host → daemon: "ask every client to say where its web panes are" (issue #75).
 *
 * Spelled here rather than imported, the way `./geometry.ts` spells `pane-geometry` and the web
 * client spells `web-geometry-resync` in its own `connection/socket.ts`: this connection speaks
 * the daemon's WS vocabulary directly, and a shared constant would make the shell depend on the
 * daemon's internals for a five-word string. The daemon's spelling is
 * `daemon/src/ws/sync.ts` ▸ `WEB_GEOMETRY_RESYNC_REQUEST_MESSAGE`, and
 * `daemon/src/webpane/HOST_PROTOCOL.md` §3.5.2 is the contract.
 */
const WEB_GEOMETRY_RESYNC_REQUEST_MESSAGE = 'web-geometry-resync-request';

const RECONNECT_INITIAL_MS = 500;
const RECONNECT_MAX_MS = 15_000;
const RECONNECT_FACTOR = 2;
const RECONNECT_JITTER = 0.2;

export type HostRevokeReason = 'superseded' | 'unregistered' | 'shutdown' | 'disconnected';

export interface WebHostClientOptions {
    readonly location: DaemonLocation;
    /** Diagnostics only; shows up in the daemon's logs. */
    readonly name: string;
    readonly version: string;
    /**
     * The shell window this host renders into. Declared in the handshake so the daemon can tag
     * geometry reports coming from the UI loaded in that same window (`?shellWindow=`), which is
     * what tells embedded views apart from a browser's placeholder cards
     * (`daemon/src/webpane/HOST_PROTOCOL.md` §3.5).
     */
    readonly windowID?: string | undefined;
    /** Answer one `host-rpc`. Must never reject — a failure envelope is a legitimate answer. */
    readonly call: (verb: string, args: JsonObject) => Promise<JsonObject>;
    /** Apply one `host-notify` (daemon-owned state mirrored onto real views). */
    readonly notify: (verb: string, args: JsonObject) => void;
    /**
     * The daemon's `keybind` line values, from `welcome.settings` and every `settings-changed`.
     *
     * Issue #33: the chord relay's claimed set is derived from the binding map, and this is the
     * connection that can see it. The renderer's copy is no use - the whole point of the relay is
     * the keystrokes the renderer never gets.
     *
     * The status socket also carries these lines now (`../status.ts` ▸ `ShellDaemonSettings`,
     * added by #47 for the menu accelerators), so this is a second reader in the same process
     * rather than the only one. Deliberately still its own read: the two sockets have independent
     * lifetimes - this one must work before the window has loaded, while it is reloading and
     * while it is closed (see the module header), and a status resync must not be able to disturb
     * the host - so coupling the relay's set to the status connection's would trade a duplicated
     * three-line parse for a dependency the composition root exists to avoid.
     *
     * Fires on every (re)connect, not only on a write: a host that reconnects to a daemon whose
     * config changed while it was away must not keep forwarding the old set.
     */
    readonly onKeybindLines?: ((lines: readonly string[]) => void) | undefined;
    readonly onRegistered?: ((hostID: string, superseded: boolean) => void) | undefined;
    /**
     * The role is gone: another shell took over, the daemon is stopping, or the socket dropped.
     * `disconnected` is the only one that is expected to come back on its own.
     */
    readonly onRevoked?: ((reason: HostRevokeReason) => void) | undefined;
    readonly socketFactory?: ((url: string, headers: Record<string, string>) => WebSocket) | undefined;
    readonly random?: (() => number) | undefined;
}

export interface WebHostClient {
    start(): void;
    stop(): void;
    /** Re-point at a (re)discovered daemon and redial. */
    setLocation(location: DaemonLocation): void;
    readonly registered: boolean;
    /** Push one `host-event` (console line, URL/title change, picked element, closed tab). */
    sendEvent(event: string, paneID: string, tabID: string | null, payload: JsonObject): void;
    /**
     * Ask the UI in this shell's window to run a command, over the daemon's existing
     * `menu-request` → `menu-command` relay (`daemon/src/ws/desktop.ts` explains why the daemon
     * is the only channel between the main process and the page: there is no preload).
     *
     * The host uses it for exactly one thing — replaying a browser chord an embedded page
     * swallowed (`./keys.ts`) — but the relay is generic, so nothing new is owed to the wire.
     */
    sendWindowCommand(command: string): void;
    /**
     * Ask the daemon to broadcast `web-geometry-resync` (issue #75, over #34's message).
     *
     * The daemon sends that of its own accord when a host registers, because that is the moment
     * only it can see. This is the other moment, and only the HOST can see it: the shell is
     * holding a placement it parked for a reason the client never saw (a window with no metrics
     * for an instant) and cannot honour from its own books. The clients are the only party that
     * knows where the holes are, so they are asked to say again.
     *
     * Fire-and-forget, like `sendWindowCommand`: there is no reply, and a request made while the
     * socket is down is simply dropped - a host that reconnects gets a broadcast anyway.
     */
    requestGeometryResync(): void;
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

/**
 * `settings.keybindLines` out of a `welcome` or a `settings-changed`, or null when the message
 * carries none.
 *
 * Null rather than `[]`: an empty list is a legitimate answer (a config file with no `keybind`
 * lines resolves to the shipped defaults), while a daemon too old to sync settings has said
 * nothing at all - and the caller must not read silence as "the user unbound everything".
 */
function readKeybindLines(message: JsonRecord): readonly string[] | null {
    const settings = message['settings'];
    if (!isRecord(settings)) return null;
    const lines = settings['keybindLines'];
    if (!Array.isArray(lines)) return null;
    return lines.filter((line): line is string => typeof line === 'string');
}

export function createWebHostClient(options: WebHostClientOptions): WebHostClient {
    let location = options.location;
    let socket: WebSocket | null = null;
    let registered = false;
    let stopped = true;
    let fatal = false;
    let attempt = 0;
    let reconnectTimer: NodeJS.Timeout | null = null;

    function wsUrl(): string {
        return `${location.url.replace(/^http/, 'ws')}/ws`;
    }

    function send(message: JsonObject): void {
        const current = socket;
        if (current === null || current.readyState !== WebSocket.OPEN) return;
        try {
            current.send(JSON.stringify(message));
        } catch (error) {
            warn(`web host send failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    function answer(id: string, verb: string, args: JsonObject): void {
        // Every RPC must be answered: a host that stays silent turns into the daemon's
        // "did not answer '<verb>' within <n>ms" for the agent on the other end.
        void options
            .call(verb, args)
            .then((reply) => {
                send({ type: 'host-rpc-reply', id, reply });
            })
            .catch((error: unknown) => {
                const message = error instanceof Error ? error.message : String(error);
                logError(`web host verb '${verb}' threw`, error);
                send({ type: 'host-rpc-reply', id, reply: { ok: false, error: message } });
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
                attempt = 0;
                log(`web host ws connected ${wsUrl()}`);
                const lines = readKeybindLines(parsed);
                if (lines !== null) options.onKeybindLines?.(lines);
                return;
            }
            // The config file changed under us (issue #33). Same payload shape as `welcome`'s,
            // broadcast to every attached session, so a rebound chord reaches the relay without
            // waiting for a reconnect.
            case 'settings-changed': {
                const lines = readKeybindLines(parsed);
                if (lines !== null) options.onKeybindLines?.(lines);
                return;
            }
            case 'host-registered': {
                registered = true;
                const hostID = readString(parsed, 'hostID') ?? '';
                const superseded = parsed['superseded'] === true;
                log(`web host registered ${hostID}${superseded ? ' (took over)' : ''}`);
                options.onRegistered?.(hostID, superseded);
                return;
            }
            case 'host-revoked': {
                registered = false;
                const reason = (readString(parsed, 'reason') ?? 'unregistered') as HostRevokeReason;
                warn(`web host role revoked (${reason})`);
                options.onRevoked?.(reason);
                return;
            }
            case 'host-rpc': {
                const id = readString(parsed, 'id');
                const verb = readString(parsed, 'verb');
                if (id === undefined || verb === undefined) return;
                const args = isRecord(parsed['args']) ? (parsed['args'] as JsonObject) : {};
                answer(id, verb, args);
                return;
            }
            case 'host-notify': {
                const verb = readString(parsed, 'verb');
                if (verb === undefined) return;
                const args = isRecord(parsed['args']) ? (parsed['args'] as JsonObject) : {};
                try {
                    options.notify(verb, args);
                } catch (error) {
                    logError(`web host notify '${verb}' threw`, error);
                }
                return;
            }
            case 'rejected': {
                const code = readString(parsed, 'code') ?? 'server-error';
                // Only a transient server error is worth another dial; a bad token or a protocol
                // mismatch would be a hot loop against a refusal.
                fatal = code !== 'server-error';
                logError(`web host ws rejected (${code}) ${readString(parsed, 'message') ?? ''}`);
                return;
            }
            default:
                return;
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

    function open(): void {
        if (stopped || fatal || socket !== null) return;
        const url = wsUrl();
        let next: WebSocket;
        try {
            next = (options.socketFactory ?? defaultSocketFactory)(url, {
                authorization: `Bearer ${location.token}`
            });
        } catch (error) {
            logError('web host socket could not be created', error);
            scheduleReconnect();
            return;
        }
        socket = next;

        next.on('open', () => {
            if (socket !== next) return;
            const hello = shellHello({
                token: location.token,
                name: options.name,
                version: options.version,
                // Claims the role at handshake time — no second round trip, and no
                // window where the daemon has a client but no host.
                capabilities: ['web-pane-host']
            });
            // Merged rather than threaded through `shellHello`: the window id is a web-host
            // concern (the status socket has no window), so it stays out of the shared frame.
            const client =
                options.windowID === undefined
                    ? hello['client']
                    : { ...(hello['client'] as JsonObject), windowID: options.windowID };
            next.send(JSON.stringify({ ...hello, client }));
        });

        next.on('message', (data: unknown, isBinary: boolean) => {
            // This connection never attaches a pane, so a binary frame is not ours to read.
            if (isBinary || socket !== next) return;
            handleText(String(data));
        });

        next.on('error', (error: Error) => {
            if (socket !== next) return;
            warn(`web host socket error: ${error.message}`);
        });

        next.on('close', (code: number) => {
            if (socket !== next) return;
            socket = null;
            const wasRegistered = registered;
            registered = false;
            if (wasRegistered) {
                log(`web host ws disconnected (${String(code)})`);
                options.onRevoked?.('disconnected');
            }
            scheduleReconnect();
        });
    }

    function dropSocket(): void {
        const current = socket;
        socket = null;
        registered = false;
        if (current === null) return;
        current.removeAllListeners();
        try {
            current.close();
        } catch {
            // Already gone.
        }
    }

    return {
        start(): void {
            if (!stopped) return;
            stopped = false;
            fatal = false;
            open();
        },

        stop(): void {
            stopped = true;
            if (reconnectTimer !== null) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            // Release the role explicitly so a daemon that outlives the app knows it has no host
            // (rather than learning it from the socket close a moment later).
            if (registered) send({ type: 'host-unregister', role: 'web-pane' });
            dropSocket();
        },

        setLocation(next: DaemonLocation): void {
            location = next;
            fatal = false;
            attempt = 0;
            if (reconnectTimer !== null) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            dropSocket();
            if (!stopped) open();
        },

        get registered(): boolean {
            return registered;
        },

        sendEvent(event, paneID, tabID, payload): void {
            send({
                type: 'host-event',
                event,
                paneID,
                ...(tabID === null ? {} : { tabID }),
                payload
            });
        },

        sendWindowCommand(command): void {
            send({
                type: 'menu-request',
                command,
                // Scoped to this window: a second machine attached to the same daemon must not
                // act on a chord pressed here.
                ...(options.windowID === undefined ? {} : { windowID: options.windowID })
            });
        },

        requestGeometryResync(): void {
            // Only a registered host may ask: the daemon checks that too, and asking before the
            // role is held would be a broadcast on behalf of nobody.
            if (!registered) return;
            send({ type: WEB_GEOMETRY_RESYNC_REQUEST_MESSAGE });
        }
    };
}

function defaultSocketFactory(url: string, headers: Record<string, string>): WebSocket {
    return new WebSocket(url, { headers });
}
