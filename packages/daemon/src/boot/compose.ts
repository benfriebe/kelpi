/**
 * Composition root: every seam in `../seams.ts` gets its concrete implementation here, and
 * nothing else in the daemon knows how the pieces are wired.
 *
 * What boot owns (and only boot):
 *   - the single `pty.onData → term.feed` subscription (`ws/streams.ts` deliberately does not
 *     feed the VT, or every pane would be fed twice);
 *   - `pty.onExit → pane-process-terminated`;
 *   - the `HandlerContext`: store, PTY, terminal state, terminal input (bound to LIVE VT
 *     modes), version info for `ping`, and `broadcast` = the WS sync hub;
 *   - merging the pane + app handler tables into one `ControlDispatcher`, shared by the
 *     control socket and the WS command channel so a CLI and a browser cannot drift;
 *   - the listeners: the CLI-compat control socket (`/tmp/nex.sock` + optional TCP, per
 *     PLAN.md's compatibility decision), the protocol-versioned run-dir control socket
 *     (`daemon-v<N>.sock`, what `nexd status` / clients discover), and the HTTP+WS server on a
 *     port remembered in the run dir;
 *   - the boot ordering from app-state-core.md §12.3 / agent-lifecycle.md §6.1: load →
 *     capture resume tuples → clear ids/statuses → spawn PTYs → settle ~2 s → type resume →
 *     THEN persist. Saves are gated until that last step, exactly so a crash mid-restore
 *     leaves the session ids in the DB for the next launch;
 *   - shutdown: flush the debounced save, then kill PTYs (bounded), then close listeners.
 */

import { homedir } from 'node:os';

import { newUUID } from '@nex/core/codec';
import type { ResumeTuple } from '@nex/core/agent';

import { createContentService, type ContentService } from '../content/index.js';
import {
    createControlServer,
    resolveControlEndpoints,
    type ControlServer
} from '../control/index.js';
import { createPersistence, resolveDatabasePath, type SqlitePersistence } from '../db/index.js';
import { createAppHandlers } from '../handlers/app/index.js';
import { paneHandlers, spawnEnvVars, spawnPaneIfShell, type PaneHandlerContext, type PaneSpawnDefaults } from '../handlers/pane/index.js';
import {
    clearRunFiles,
    ensureRunDir,
    ensureToken,
    resolveRunPaths,
    writePidRecord,
    type RunPaths
} from '../lifecycle/index.js';
import { createPtyManager, createTerminalInput, type NexPtyManager } from '../pty/index.js';
import type { ControlDispatcher, TerminalInput } from '../seams.js';
import {
    applyLoadReset,
    createStore,
    emptyDaemonState,
    fromSnapshot,
    toSnapshot,
    type DaemonState,
    type NexStore
} from '../store/index.js';
import { createTerminalStateService, type TerminalStateServiceImpl } from '../term/index.js';
import {
    createPaneAssetsRoute,
    createWsServer,
    resolveClientDistDir,
    type WsServer
} from '../ws/index.js';
import { configuredTcpPort, loadDaemonConfig, createProfileReader, type DaemonConfig } from './config.js';
import { createDispatcher } from './dispatch.js';
import { readPortFile, writePortFile } from './port.js';
import { spawnRestoredPanes, typeResumeCommands, type ResumeOutcome } from './resume.js';
import { resolveDaemonVersion, type DaemonVersion } from './version.js';

export const HTTP_PORT_ENV = 'NEXD_HTTP_PORT';
export const HTTP_HOST_ENV = 'NEXD_HTTP_HOST';

/** Name of the workspace created on a fresh install (app-state-core.md §12.2). */
export const DEFAULT_WORKSPACE_NAME = 'Default';

export interface DaemonOptions {
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly home?: string | undefined;
    /** Run directory override (otherwise `NEXD_RUN_DIR` / the platform default). */
    readonly runDir?: string | undefined;
    /** CLI-compat control socket. Same precedence as the config file: env still wins. */
    readonly controlSocketPath?: string | undefined;
    /** Control TCP listener; defaults to the config file's `tcp-port`. */
    readonly tcpPort?: number | undefined;
    readonly dbPath?: string | undefined;
    readonly configPath?: string | undefined;
    readonly httpHost?: string | undefined;
    /** `0` = ephemeral. Default: the port file's value, else ephemeral. */
    readonly httpPort?: number | undefined;
    readonly clientDistDir?: string | undefined;
    readonly version?: DaemonVersion | undefined;
    /** Grid + helpers dir + login shell every PTY spawn inherits. */
    readonly spawn?: PaneSpawnDefaults | undefined;
    /** Resume settle delay; defaults to the spec's 2 s. */
    readonly settleMs?: number | undefined;
    /** Injected clock for the settle (tests). */
    readonly sleep?: ((ms: number) => Promise<void>) | undefined;
    /** Epoch ms clock for handlers (tests). */
    readonly now?: (() => number) | undefined;
    /** Id source for handlers + the fresh-install workspace (tests). */
    readonly uuid?: (() => string) | undefined;
    /** Install SIGTERM/SIGINT handlers. `nexd start` sets it; tests do not. */
    readonly installSignalHandlers?: boolean | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
    readonly onLog?: ((message: string) => void) | undefined;
}

export interface DaemonInfo {
    readonly pid: number;
    readonly version: DaemonVersion;
    /** The CLI-compat control socket (`nex` talks to this one). */
    readonly socketPath: string;
    /** The protocol-versioned run-dir socket clients discover. */
    readonly runSocketPath: string;
    readonly tcpPort: number | undefined;
    readonly httpHost: string;
    readonly httpPort: number;
    readonly url: string;
    readonly token: string;
    readonly dbPath: string;
    readonly configPath: string;
    readonly runDir: string;
    /** How the persisted state came back (`ok` / `empty` / `unreadable`). */
    readonly loadStatus: 'ok' | 'empty' | 'unreadable';
    readonly workspaces: number;
    readonly resumeTuples: number;
}

export interface Daemon {
    start(): Promise<DaemonInfo>;
    stop(): Promise<void>;
    /** Resolves when the resume pipeline finished (and saves were un-gated). */
    readonly restored: Promise<ResumeOutcome>;
    readonly info: DaemonInfo | undefined;
    readonly store: NexStore;
    readonly pty: NexPtyManager;
    readonly term: TerminalStateServiceImpl;
    readonly input: TerminalInput;
    readonly persistence: SqlitePersistence;
    /** M5: markdown/diff/scratchpad content, watchers and edit buffers. */
    readonly content: ContentService;
    readonly dispatcher: ControlDispatcher;
    readonly ctx: PaneHandlerContext;
    readonly paths: RunPaths;
    readonly config: DaemonConfig;
    readonly ws: WsServer | undefined;
    readonly control: ControlServer | undefined;
    readonly running: boolean;
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

function parsePortEnv(raw: string | undefined): number | undefined {
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) return undefined;
    const port = Number.parseInt(trimmed, 10);
    return port >= 0 && port <= 65535 ? port : undefined;
}

/** Load + `fromSnapshot`, with the fresh-install / unreadable branches folded in (§6.2). */
function initialState(
    persistence: SqlitePersistence,
    home: string
): { state: DaemonState; tuples: readonly ResumeTuple[]; status: 'ok' | 'empty' | 'unreadable' } {
    const outcome = persistence.loadOutcome();
    const restored =
        outcome.snapshot === null
            ? emptyDaemonState(home)
            : fromSnapshot(outcome.snapshot, { homeDirectory: home });
    // Capture-then-clear BEFORE anything spawns (agent-lifecycle.md §6.1 steps 1–2).
    const reset = applyLoadReset(restored);
    return { state: reset.state, tuples: reset.resumeTuples, status: outcome.status };
}

export function createDaemon(options: DaemonOptions = {}): Daemon {
    const env = options.env ?? process.env;
    const home = options.home ?? env['HOME'] ?? homedir();
    const version = options.version ?? resolveDaemonVersion(env);
    const onError = options.onError;
    const log = options.onLog ?? ((): void => {});
    const report = (error: unknown, context: string): void => {
        onError?.(toError(error), context);
    };

    const paths = resolveRunPaths({
        ...(options.runDir !== undefined ? { dir: options.runDir } : {}),
        env,
        home,
        protocol: version.protocol
    });
    const config = loadDaemonConfig({
        env,
        home,
        ...(options.configPath !== undefined ? { path: options.configPath } : {})
    });
    const tcpDefault = options.tcpPort ?? configuredTcpPort(config);
    const endpoints = resolveControlEndpoints(env, {
        ...(options.controlSocketPath !== undefined ? { socketPath: options.controlSocketPath } : {}),
        ...(tcpDefault !== undefined ? { tcpPort: tcpDefault } : {})
    });
    const dbPath = options.dbPath ?? resolveDatabasePath({ env, home });
    const httpHost = options.httpHost ?? env[HTTP_HOST_ENV]?.trim() ?? '127.0.0.1';
    const distDir = options.clientDistDir ?? resolveClientDistDir(env);
    const readProfiles = createProfileReader({
        env,
        home,
        ...(options.configPath !== undefined ? { path: options.configPath } : {})
    });

    // ── the layers ──────────────────────────────────────────────────────────
    const persistence = createPersistence({
        path: dbPath,
        onError: (error, phase) => report(error, `persistence ${phase}`)
    });
    const loaded = initialState(persistence, home);
    const store = createStore(loaded.state);
    const pty = createPtyManager({
        onError: (paneID, error) => report(error, `pty ${paneID}`)
    });
    const term = createTerminalStateService();
    const input = createTerminalInput({ pty, modes: (paneID) => term.modes(paneID) });
    // M5: content panes. It owns its own git service (diff panes) and file watchers, and its
    // edit buffers are flushed by `stop()` below before the persist gate closes.
    const content = createContentService({
        store,
        ...(onError !== undefined ? { onError } : {}),
        ...(options.now !== undefined ? { now: options.now } : {})
    });

    let ws: WsServer | undefined;
    let runControl: ControlServer | undefined;
    let compatControl: ControlServer | undefined;
    let info: DaemonInfo | undefined;
    let running = false;
    let stopping = false;
    let stopped: Promise<void> | undefined;

    // Saves are gated until the resume commands have gone out (§12.3 step 9): a crash before
    // the resume must leave the session ids in the DB for the next launch.
    let persistReady = false;

    const snapshotNow = (): void => {
        persistence.scheduleSave(toSnapshot(store.getState()));
    };
    const persist = (): void => {
        if (stopping || !persistReady) return;
        snapshotNow();
    };
    /** `session-end` only (issue #178): the cleared id must survive an immediate crash. */
    const persistNow = (): void => {
        if (stopping || !persistReady) return;
        persistence.saveNow(toSnapshot(store.getState()));
    };

    const unsubscribe = store.subscribe(() => {
        persist();
    });

    const offData = pty.onData((paneID, data) => {
        term.feed(paneID, data);
    });
    const offExit = pty.onExit((paneID) => {
        // A shutdown kills every child; those exits must not close the panes we are about
        // to persist.
        if (stopping) return;
        store.dispatch({ type: 'pane-process-terminated', paneID });
    });

    const spawnDefaults: PaneSpawnDefaults = options.spawn ?? {};
    const ctx: PaneHandlerContext = {
        store,
        pty,
        term,
        input,
        version,
        broadcast: (event) => {
            ws?.broadcast(event);
        },
        profiles: readProfiles,
        spawn: spawnDefaults,
        ...(options.now !== undefined ? { clock: options.now } : {}),
        ...(options.uuid !== undefined ? { mintPaneID: options.uuid, mintWorkspaceID: options.uuid } : {})
    };

    const appHandlers = createAppHandlers({
        persist,
        persistNow,
        spawnPane: (request) => {
            spawnPaneIfShell(ctx, request.workspaceID, request.paneID);
        },
        killPane: (paneID) => {
            pty.kill(paneID);
            term.dispose(paneID);
        },
        // Multi-client suppression: "attended" means some VISIBLE client has that pane
        // focused. Nothing attached ⇒ false ⇒ headless still notifies (§7 port note 2).
        isAppActive: () => ws?.presence().anyVisible ?? false,
        isPaneFocused: (paneID, workspaceID) => ws?.isPaneAttended(workspaceID, paneID) ?? false,
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(options.uuid !== undefined ? { uuid: options.uuid } : {})
    });

    const dispatcher = createDispatcher<PaneHandlerContext>({
        ctx,
        tables: [paneHandlers, appHandlers],
        ...(onError !== undefined ? { onError } : {})
    });

    // ── boot steps 3–5 ──────────────────────────────────────────────────────

    /** §12.2: a fresh install (or an unreadable DB) comes up with one "Default" workspace. */
    const ensureDefaultWorkspace = (): void => {
        if (store.getState().workspaces.length > 0) return;
        const mint = options.uuid ?? newUUID;
        store.dispatch({
            type: 'create-workspace',
            id: mint(),
            paneID: mint(),
            name: DEFAULT_WORKSPACE_NAME,
            now: (options.now ?? Date.now)()
        });
    };

    let settleRestore: (outcome: ResumeOutcome) => void = () => {};
    const restored = new Promise<ResumeOutcome>((resolve) => {
        settleRestore = resolve;
    });

    const runRestore = (spawned: readonly string[]): void => {
        void (async () => {
            let resumed: readonly string[] = [];
            let skipped: readonly string[] = [];
            let settled = false;
            try {
                const outcome = await typeResumeCommands(loaded.tuples, {
                    pty,
                    term,
                    input,
                    profiles: config.profiles,
                    ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
                    ...(options.settleMs !== undefined ? { settleMs: options.settleMs } : {}),
                    ...(onError !== undefined ? { onError } : {})
                });
                resumed = outcome.resumed;
                skipped = outcome.skipped;
                settled = outcome.settled;
            } catch (error) {
                report(error, 'resume');
            }
            // Step 9: only now may the cleared session ids reach the DB. The save is
            // unconditional — the clearing itself is a change nobody else will schedule.
            persistReady = true;
            if (!stopping) snapshotNow();
            settleRestore({ spawned: [...spawned], resumed, skipped, settled });
        })();
    };

    // ── lifecycle ───────────────────────────────────────────────────────────

    const signalHandlers = new Map<NodeJS.Signals, () => void>();
    const removeSignalHandlers = (): void => {
        for (const [signal, handler] of signalHandlers) process.off(signal, handler);
        signalHandlers.clear();
    };

    const stop = async (): Promise<void> => {
        if (stopped !== undefined) return stopped;
        // Editor buffers flush FIRST, while `persist()` is still live: a markdown pane's pending
        // write goes to disk, and a scratchpad's goes into the store — where it must land before
        // the persist gate closes, or the debounced snapshot below would not contain it.
        // (content-panes.md §4.2 quit flush + §7's "port may want to close that gap".)
        try {
            content.flushSync();
        } catch (error) {
            report(error, 'content flush');
        }
        stopping = true;
        running = false;
        stopped = (async () => {
            removeSignalHandlers();
            // Nobody may be left awaiting a restore that will now never finish (resolving an
            // already-settled promise is a no-op, so a completed restore keeps its outcome).
            settleRestore({ spawned: [], resumed: [], skipped: [], settled: false });
            unsubscribe();
            offData();
            offExit();
            content.dispose();
            // SIGTERM contract: write the debounced snapshot before anything else changes.
            // A shutdown DURING the restore window deliberately writes nothing — the DB must
            // keep the session ids the resume never got to use (§6.1 step 5).
            persistence.flush();
            await pty.killAll();
            await Promise.all([
                runControl?.stop() ?? Promise.resolve(),
                compatControl?.stop() ?? Promise.resolve(),
                ws?.stop() ?? Promise.resolve()
            ]);
            persistence.close();
            // The token and the port file stay: both are stable across restarts by design.
            clearRunFiles(paths);
            log('nexd stopped');
        })();
        return stopped;
    };

    const installSignals = (): void => {
        if (options.installSignalHandlers !== true) return;
        for (const signal of ['SIGTERM', 'SIGINT'] as const) {
            const handler = (): void => {
                if (stopped !== undefined) {
                    // Second signal: the operator is impatient and the bounded kill is slow.
                    process.exit(1);
                }
                void stop().then(
                    () => process.exit(0),
                    () => process.exit(1)
                );
            };
            signalHandlers.set(signal, handler);
            process.on(signal, handler);
        }
    };

    const startWs = async (token: string): Promise<WsServer> => {
        const preferred = options.httpPort ?? parsePortEnv(env[HTTP_PORT_ENV]) ?? readPortFile(paths) ?? 0;
        const build = (port: number): WsServer =>
            createWsServer({
                store,
                dispatcher,
                pty,
                term,
                version,
                port,
                host: httpHost,
                token,
                daemonInfo: { pid: process.pid },
                content,
                // `/pane-assets/<paneID>/<relpath>` — sibling files of an open markdown file, so
                // relative `<img src>` resolves (content-panes.md port note 4).
                routes: createPaneAssetsRoute((paneID, relativePath) =>
                    content.assetPath(paneID, relativePath)
                ),
                ...(distDir !== undefined ? { distDir } : {}),
                ...(onError !== undefined ? { onError } : {})
            });
        const server = build(preferred);
        try {
            await server.start();
            return server;
        } catch (error) {
            if (preferred === 0) throw error;
            // A remembered port can be taken by anything; loopback availability is not ours
            // to reserve, so fall back to an ephemeral one rather than refusing to boot.
            report(error, `http bind ${String(preferred)}`);
            await server.stop();
            const fallback = build(0);
            await fallback.start();
            return fallback;
        }
    };

    const start = async (): Promise<DaemonInfo> => {
        if (info !== undefined) return info;

        ensureRunDir(paths);
        const token = ensureToken(paths);

        // §12.2 + step 3 BEFORE any listener: a CLI that connects the instant the socket
        // appears must never see an empty daemon that is still restoring its workspaces.
        ensureDefaultWorkspace();
        const spawned = spawnRestoredPanes(store.getState(), {
            pty,
            term,
            profiles: config.profiles,
            spawn: spawnDefaults,
            envFor: (paneID, workspace) => spawnEnvVars(ctx, paneID, workspace),
            ...(onError !== undefined ? { onError } : {})
        });

        runControl = createControlServer({
            socketPath: paths.socket,
            dispatcher,
            ...(onError !== undefined ? { onError } : {})
        });
        await runControl.start();

        if (endpoints.socketPath !== paths.socket) {
            compatControl = createControlServer({
                socketPath: endpoints.socketPath,
                dispatcher,
                ...(endpoints.tcpPort !== undefined ? { tcpPort: endpoints.tcpPort } : {}),
                ...(onError !== undefined ? { onError } : {})
            });
        } else if (endpoints.tcpPort !== undefined) {
            // The compat path IS the run-dir path (an explicit override); the TCP listener
            // still belongs to it, so re-create it with TCP rather than binding twice.
            await runControl.stop();
            runControl = createControlServer({
                socketPath: paths.socket,
                dispatcher,
                tcpPort: endpoints.tcpPort,
                ...(onError !== undefined ? { onError } : {})
            });
            await runControl.start();
        }

        try {
            await compatControl?.start();
            ws = await startWs(token);
        } catch (error) {
            await runControl.stop();
            await compatControl?.stop();
            compatControl = undefined;
            runControl = undefined;
            throw error;
        }

        const httpPort = ws.port ?? 0;
        writePortFile(paths, httpPort);
        writePidRecord(paths, {
            socket: paths.socket,
            http_port: httpPort,
            version: version.version
        });

        // Steps 4–5 run in the background: the 2 s settle must not delay the listeners.
        runRestore(spawned);

        running = true;
        installSignals();

        info = {
            pid: process.pid,
            version,
            socketPath: endpoints.socketPath,
            runSocketPath: paths.socket,
            tcpPort: compatControl?.tcpPort ?? runControl.tcpPort,
            httpHost,
            httpPort,
            url: `http://${httpHost.includes(':') ? `[${httpHost}]` : httpHost}:${String(httpPort)}`,
            token,
            dbPath: persistence.path,
            configPath: config.path,
            runDir: paths.dir,
            loadStatus: loaded.status,
            workspaces: store.getState().workspaces.length,
            resumeTuples: loaded.tuples.length
        };
        log(`nexd listening: control ${info.socketPath}, http ${info.url}`);
        return info;
    };

    return {
        start,
        stop,
        restored,
        get info() {
            return info;
        },
        store,
        pty,
        term,
        input,
        persistence,
        content,
        dispatcher,
        ctx,
        paths,
        config,
        get ws() {
            return ws;
        },
        get control() {
            return compatControl ?? runControl;
        },
        get running() {
            return running;
        }
    };
}
