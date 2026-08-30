/**
 * `createWsServer` — the daemon's HTTP + WebSocket listener (WP2.7).
 *
 * One `node:http` server per bind address (loopback always, plus whatever tailnet address
 * the caller passes), all sharing one hono request listener and one `ws` server in
 * `noServer` mode: the upgrade classifies the request against the run dir's token
 * (`lifecycle/rundir.ts`) and hands the verdict to the connection's handshake, which is what
 * accepts or refuses it (`ws/http.ts` explains why the check moved).
 *
 * Per connection the server wires the two channels together:
 *   - text frames → `SyncSession` (handshake, snapshot/deltas, commands, reports),
 *   - binary frames → `PaneStreamSession` (replay + live PTY output, input, ack, resize).
 *
 * Shutdown closes both in the right order (clients get a goodbye frame, streams unsubscribe
 * from the PTY manager, listeners close) and never leaves a half-open socket behind.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';

import { getRequestListener } from '@hono/node-server';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import type { ControlDispatcher, PtyManager, TerminalStateService } from '../seams.js';
import {
    WS_PATH,
    authorizeUpgrade,
    createHttpApp,
    tokensMatch,
    writeUpgradeRejection,
    type DaemonVersionInfo,
    type HttpAppOptions
} from './http.js';
import type { DesktopChannel } from './desktop.js';
import type { PaneLifecycleChannel } from './panes.js';
import type { RepoChannel } from './repos.js';
import type { GraftChannel } from './graft.js';
import { createTerminalSearchChannel, type TerminalSearchBackend } from './search.js';
import { createPaneStreamHub, type PaneStreamHub } from './streams.js';
import type { WsTransportStatus } from '@kelpi/protocol';

import {
    createSyncHub,
    type AgentChannel,
    type ContentChannel,
    type KelpiDomainStore,
    type SettingsChannel,
    type SyncHub,
    type SyncPresence,
    type WebPaneChannel
} from './sync.js';

export const DEFAULT_HTTP_HOST = '127.0.0.1';

export interface WsServerAddress {
    readonly host: string;
    readonly port: number;
}

export interface WsServerOptions {
    readonly store: KelpiDomainStore;
    /** Client `command` messages go here — the same dispatcher the control socket uses. */
    readonly dispatcher: ControlDispatcher;
    readonly pty: PtyManager;
    readonly term: TerminalStateService;
    readonly version: DaemonVersionInfo;
    /** `0` (the default) binds an ephemeral port; extra hosts reuse whatever it got. */
    readonly port?: number | undefined;
    /** Primary bind; loopback by default. */
    readonly host?: string | undefined;
    /** Additional binds (tailnet interface). Best effort: a failure is reported, not fatal. */
    readonly extraHosts?: readonly string[] | undefined;
    /**
     * Run-dir token. A connection that cannot present it is refused at the HANDSHAKE (the
     * upgrade only classifies); without a token configured, upgrades are refused outright
     * unless `allowAnonymous` is set.
     */
    readonly token?: string | undefined;
    readonly allowAnonymous?: boolean | undefined;
    /** How long a connection may hold a socket without saying hello (`ws/sync.ts` default). */
    readonly helloTimeoutMs?: number | undefined;
    /** Built web client; absent → the "client not built" page. */
    readonly distDir?: string | undefined;
    /** M5 content panes: the `content-*` WS verbs (absent = they answer "not available"). */
    readonly content?: ContentChannel | undefined;
    /**
     * M6 web panes: where the Electron shell registers as the web-pane host. Pass the same
     * service instance the `web-*` command handlers got, or the CLI and the host cannot meet.
     */
    readonly webPanes?: WebPaneChannel | undefined;
    /** The pane header's restart button (`restart-pane-agent`); absent = "not available". */
    readonly agents?: AgentChannel | undefined;
    /** M9 workspace inspector: the repo registry + association verbs (`ws/repos.ts`). */
    readonly repos?: RepoChannel | undefined;
    /** The inspector's graft toggle + orphan banner verbs (`ws/graft.ts`). */
    readonly graftUi?: GraftChannel | undefined;
    /**
     * Reopen-closed-pane / create-scratchpad / reveal-path (`ws/panes.ts`). Those three need a
     * `PaneHandlerContext` (a PTY to spawn, a `TerminalInput` to type the resume command into),
     * which only boot has — so unlike terminal search this one cannot be built here.
     */
    readonly panes?: PaneLifecycleChannel | undefined;
    /**
     * The desktop gestures (`ws/desktop.ts`): the ⌘O picker relay, ⌘-clicking a path in a
     * terminal, hosting `$EDITOR` in a markdown pane, and `restart-control-server`. Like
     * `panes`, it needs a `PaneHandlerContext` (and the control listeners), so boot builds it.
     */
    readonly desktop?: DesktopChannel | undefined;
    /**
     * M8 settings sync: the `welcome.settings` payload and the `settings-*` mutation verbs.
     * Absent = welcome carries no settings and the verbs answer "not available".
     */
    readonly settings?: SettingsChannel | undefined;
    /**
     * §SET-021: `welcome.transport` — what the daemon's control listeners actually did. A
     * getter (a re-bind can happen under an attached client); absent = nothing to report.
     */
    readonly transport?: (() => WsTransportStatus) | undefined;
    /** Extra HTTP routes registered before the static catch-all (the pane-asset route). */
    readonly routes?: HttpAppOptions['routes'] | undefined;
    readonly daemonInfo?: { readonly pid?: number | undefined } | undefined;
    /** Flow control overrides (tests). */
    readonly windowBytes?: number | undefined;
    readonly maxQueuedBytes?: number | undefined;
    /** Client-reported pane grids, forwarded to boot's geometry cache (`pty/geometry.ts`). */
    readonly onGeometry?: ((paneID: string, cols: number, rows: number) => void) | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
}

export interface WsServer {
    start(): Promise<readonly WsServerAddress[]>;
    stop(): Promise<void>;
    /** The port every listener bound (undefined before `start`). */
    readonly port: number | undefined;
    readonly addresses: readonly WsServerAddress[];
    readonly urls: readonly string[];
    readonly clients: number;
    /** The `HandlerContext.broadcast` seam. */
    broadcast(event: Record<string, unknown>): void;
    presence(): SyncPresence;
    isPaneAttended(workspaceID: string, paneID: string): boolean;
    readonly sync: SyncHub;
    readonly streams: PaneStreamHub;
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

function rawToBytes(data: RawData): Uint8Array {
    if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
    return new Uint8Array(data as ArrayBuffer);
}

function rawToText(data: RawData): string {
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
    return Buffer.from(data as ArrayBuffer).toString('utf8');
}

function listenAsync(server: Server, host: string, port: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        const onError = (error: Error): void => {
            server.removeListener('listening', onListening);
            reject(error);
        };
        const onListening = (): void => {
            server.removeListener('error', onError);
            const address = server.address();
            resolve(typeof address === 'object' && address !== null ? address.port : port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
    });
}

function closeAsync(server: Server): Promise<void> {
    return new Promise<void>((resolve) => {
        if (!server.listening) {
            resolve();
            return;
        }
        server.close(() => resolve());
    });
}

export function createWsServer(options: WsServerOptions): WsServer {
    const host = options.host ?? DEFAULT_HTTP_HOST;
    const requestedPort = options.port ?? 0;
    const app = createHttpApp({
        version: options.version,
        distDir: options.distDir,
        onError: options.onError,
        routes: options.routes
    });
    const requestListener = getRequestListener(app.fetch);

    const report = (error: unknown, context: string): void => {
        options.onError?.(toError(error), context);
    };

    const streams = createPaneStreamHub({
        pty: options.pty,
        term: options.term,
        windowBytes: options.windowBytes,
        maxQueuedBytes: options.maxQueuedBytes,
        onGeometry: options.onGeometry,
        onError: options.onError
    });

    const sync = createSyncHub({
        store: options.store,
        dispatcher: options.dispatcher,
        daemon: {
            version: options.version.version,
            build: options.version.build,
            pid: options.daemonInfo?.pid
        },
        protocolVersion: options.version.protocol,
        content: options.content,
        webPanes: options.webPanes,
        settings: options.settings,
        transport: options.transport,
        agents: options.agents,
        repos: options.repos,
        graftUi: options.graftUi,
        panes: options.panes,
        desktop: options.desktop,
        // Terminal search reads the SAME `@xterm/headless` buffer the PTY streams and
        // `pane capture` already share, so it is composed here rather than passed in: there is
        // nothing boot knows about it that this file does not.
        search: createTerminalSearchChannel({
            store: options.store,
            term: options.term as Partial<TerminalSearchBackend>
        }),
        // THE token gate: an upgrade with a missing or wrong token still becomes a socket, and
        // this is what turns it away — with a reason the client can show a human.
        ...(options.token !== undefined && options.token.length > 0
            ? { validateToken: (token: string) => tokensMatch(options.token as string, token) }
            : {}),
        ...(options.helloTimeoutMs !== undefined ? { helloTimeoutMs: options.helloTimeoutMs } : {}),
        onError: options.onError
    });

    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    const servers: Server[] = [];
    const addresses: WsServerAddress[] = [];
    const sockets = new Set<WebSocket>();
    let boundPort: number | undefined;
    let started = false;
    let stopped = false;

    const handleConnection = (socket: WebSocket, authenticated: boolean): void => {
        sockets.add(socket);
        const transport = {
            sendJson(message: Record<string, unknown>): void {
                if (socket.readyState !== socket.OPEN) return;
                socket.send(JSON.stringify(message));
            },
            sendFrame(frame: Uint8Array): void {
                if (socket.readyState !== socket.OPEN) return;
                socket.send(frame, { binary: true });
            },
            close(code?: number, reason?: string): void {
                try {
                    socket.close(code, reason);
                } catch {
                    socket.terminate();
                }
            }
        };

        const paneSession = streams.createSession(transport);
        const syncSession = sync.createSession(transport, paneSession, { authenticated });

        socket.on('message', (data: RawData, isBinary: boolean) => {
            try {
                if (isBinary) {
                    // Same rule as the JSON channel: nothing before `welcome`. It matters more
                    // here — an upgrade can now be anonymous, and a PTY `input` frame writes
                    // straight into a shell. Silently dropped rather than rejected: a client
                    // that races its own handshake is confused, not hostile, and the JSON
                    // channel is where a refusal can be explained.
                    if (!syncSession.ready) return;
                    paneSession.handleFrame(rawToBytes(data));
                } else syncSession.handleMessage(rawToText(data));
            } catch (error) {
                report(error, 'ws-message');
            }
        });

        socket.on('error', (error) => report(error, 'ws-socket'));

        socket.on('close', () => {
            sockets.delete(socket);
            syncSession.close();
            paneSession.close();
        });
    };

    wss.on('connection', (socket: WebSocket, _request: IncomingMessage, authenticated?: boolean) => {
        handleConnection(socket, authenticated === true);
    });

    const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
        if (stopped) {
            socket.destroy();
            return;
        }
        const decision = authorizeUpgrade(request, {
            token: options.token,
            allowAnonymous: options.allowAnonymous,
            path: WS_PATH
        });
        if (!decision.ok) {
            // Only "there is nothing here" (404) and "this daemon has no secret to check
            // against" (401) still refuse; a bad token is now the handshake's business, so it
            // can be explained rather than looking like a network drop (`ws/http.ts`).
            writeUpgradeRejection(socket, decision);
            return;
        }
        wss.handleUpgrade(request, socket, head, (client) => {
            wss.emit('connection', client, request, decision.authenticated);
        });
    };

    const makeServer = (): Server => {
        const server = createServer(requestListener);
        server.on('upgrade', handleUpgrade);
        server.on('clientError', (error) => report(error, 'http-client'));
        return server;
    };

    return {
        async start() {
            if (started) return addresses;
            started = true;

            const primary = makeServer();
            servers.push(primary);
            boundPort = await listenAsync(primary, host, requestedPort);
            addresses.push({ host, port: boundPort });

            for (const extra of options.extraHosts ?? []) {
                if (extra === host) continue;
                const server = makeServer();
                try {
                    const port = await listenAsync(server, extra, boundPort);
                    servers.push(server);
                    addresses.push({ host: extra, port });
                } catch (error) {
                    // A tailnet address can disappear between config and bind; the daemon
                    // must still come up on loopback.
                    report(error, `bind ${extra}`);
                }
            }

            return addresses;
        },
        async stop() {
            if (stopped) return;
            stopped = true;
            sync.close();
            streams.close();
            for (const socket of [...sockets]) {
                try {
                    socket.close(1001, 'daemon shutting down');
                } catch {
                    socket.terminate();
                }
            }
            sockets.clear();
            wss.close();
            await Promise.all(servers.map(closeAsync));
            servers.length = 0;
        },
        get port() {
            return boundPort;
        },
        get addresses() {
            return [...addresses];
        },
        get urls() {
            return addresses.map(({ host: bind, port }) =>
                bind.includes(':') ? `http://[${bind}]:${port}` : `http://${bind}:${port}`
            );
        },
        get clients() {
            return sockets.size;
        },
        broadcast(event) {
            sync.broadcast(event);
        },
        presence() {
            return sync.presence();
        },
        isPaneAttended(workspaceID, paneID) {
            return sync.isPaneAttended(workspaceID, paneID);
        },
        sync,
        streams
    };
}
