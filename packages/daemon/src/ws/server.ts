/**
 * `createWsServer` — the daemon's HTTP + WebSocket listener (WP2.7).
 *
 * One `node:http` server per bind address (loopback always, plus whatever tailnet address
 * the caller passes), all sharing one hono request listener and one `ws` server in
 * `noServer` mode: the upgrade is authenticated against the run dir's token
 * (`lifecycle/rundir.ts`) before a socket is ever handed to `ws`.
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
    type DaemonVersionInfo
} from './http.js';
import { createPaneStreamHub, type PaneStreamHub } from './streams.js';
import { createSyncHub, type NexDomainStore, type SyncHub, type SyncPresence } from './sync.js';

export const DEFAULT_HTTP_HOST = '127.0.0.1';

export interface WsServerAddress {
    readonly host: string;
    readonly port: number;
}

export interface WsServerOptions {
    readonly store: NexDomainStore;
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
    /** Run-dir token. Without it, upgrades are refused unless `allowAnonymous` is set. */
    readonly token?: string | undefined;
    readonly allowAnonymous?: boolean | undefined;
    /** Built web client; absent → the "client not built" page. */
    readonly distDir?: string | undefined;
    readonly daemonInfo?: { readonly pid?: number | undefined } | undefined;
    /** Flow control overrides (tests). */
    readonly windowBytes?: number | undefined;
    readonly maxQueuedBytes?: number | undefined;
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
        onError: options.onError
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
        // The upgrade already checked the token; hello re-checks it so a socket that
        // upgraded anonymously (dev) cannot present a bogus one and look authenticated.
        ...(options.token !== undefined && options.token.length > 0
            ? { validateToken: (token: string) => tokensMatch(options.token as string, token) }
            : {}),
        onError: options.onError
    });

    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    const servers: Server[] = [];
    const addresses: WsServerAddress[] = [];
    const sockets = new Set<WebSocket>();
    let boundPort: number | undefined;
    let started = false;
    let stopped = false;

    const handleConnection = (socket: WebSocket): void => {
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
        const syncSession = sync.createSession(transport, paneSession);

        socket.on('message', (data: RawData, isBinary: boolean) => {
            try {
                if (isBinary) paneSession.handleFrame(rawToBytes(data));
                else syncSession.handleMessage(rawToText(data));
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

    wss.on('connection', handleConnection);

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
            writeUpgradeRejection(socket, decision);
            return;
        }
        wss.handleUpgrade(request, socket, head, (client) => {
            wss.emit('connection', client, request);
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
