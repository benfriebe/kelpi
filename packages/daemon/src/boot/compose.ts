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
import { dirname, join } from 'node:path';

import { newUUID } from '@nex/core/codec';
import type { ResumeTuple } from '@nex/core/agent';

import { createContentService, type ContentService } from '../content/index.js';
import {
    contentAppearanceOf,
    createSettingsService,
    type SettingsService
} from '../settings/index.js';
import {
    createControlServer,
    resolveControlEndpoints,
    type ControlServer
} from '../control/index.js';
import {
    assertPersistenceUsable,
    createPersistence,
    PersistenceUnavailableError,
    resolveDatabasePath,
    type SqlitePersistence
} from '../db/index.js';
import { createGitService, sweepGraftTempIndexes, type GitService } from '../git/index.js';
import {
    createGraftService,
    createRepoAssociationWatch,
    graftChangedEvent,
    graftOrphansEvent,
    type GraftOrphan,
    type GraftService,
    type RepoAssociationWatchService
} from '../graft/index.js';
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
import {
    GEOMETRY_FILE_NAME,
    createPaneGeometryStore,
    createPtyManager,
    createTerminalInput,
    type NexPtyManager
} from '../pty/index.js';
import type { ControlDispatcher, PersistenceHealth, TerminalInput } from '../seams.js';
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
    createAgentChannel,
    createPaneAssetsRoute,
    createWsServer,
    resolveClientDistDir,
    type WsServer
} from '../ws/index.js';
import { createWebPaneService, type WebPaneService } from '../webpane/index.js';
import { configuredTcpPort, loadDaemonConfig, createProfileReader, type DaemonConfig } from './config.js';
import { createDispatcher } from './dispatch.js';
import { readPortFile, writePortFile } from './port.js';
import { spawnRestoredPanes, typeResumeCommands, type ResumeOutcome } from './resume.js';
import { resolveDaemonVersion, type DaemonVersion } from './version.js';

export const HTTP_PORT_ENV = 'NEXD_HTTP_PORT';
export const HTTP_HOST_ENV = 'NEXD_HTTP_HOST';

/**
 * Opt in to running WITHOUT persistence (`1` / `true` / `yes`).
 *
 * Default behaviour is a hard refusal to start when the database cannot be opened, because the
 * alternative is what shipped: a daemon that ran all day against an unopenable
 * `NEXD_DB_PATH=/tmp/nexd-dev.db`, reported itself healthy, and lost every workspace. Anyone who
 * genuinely wants a throw-away daemon (a read-only container, a scratch instance) says so here
 * and gets a loud warning on every boot instead.
 */
export const ALLOW_EPHEMERAL_STATE_ENV = 'NEXD_ALLOW_EPHEMERAL_STATE';

/** Broadcast to every attached client when the daemon stops being able to save (P0). */
export const PERSISTENCE_DEGRADED_EVENT = 'persistence-degraded';

/** Name of the workspace created on a fresh install (app-state-core.md §12.2). */
export const DEFAULT_WORKSPACE_NAME = 'Default';

function isTruthyEnv(raw: string | undefined): boolean {
    if (raw === undefined) return false;
    const value = raw.trim().toLowerCase();
    return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

/** The client-visible warning. Untyped like `graft-changed`: additive, ignored by old clients. */
export function persistenceDegradedEvent(health: PersistenceHealth): Record<string, unknown> {
    return {
        type: PERSISTENCE_DEGRADED_EVENT,
        path: health.path,
        phase: health.phase,
        error: health.error,
        errno: health.errno,
        failedSaves: health.failedSaves,
        lastSaveAt: health.lastSaveAt
    };
}

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
    /** Is state actually reaching the disk? Printed by `nexd start --foreground`. */
    readonly persistence: PersistenceHealth;
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
    /** Live "is state reaching the disk?" — what `ping` reports and `stop()` checks. */
    persistenceHealth(): PersistenceHealth;
    /** M5: markdown/diff/scratchpad content, watchers and edit buffers. */
    readonly content: ContentService;
    /** M8: the config-file settings authority (nex + ghostty), watched and write-through. */
    readonly settings: SettingsService;
    /** M6: the web-pane runtime (host RPC seam, console buffers, picker arms). */
    readonly webPanes: WebPaneService;
    /** M7: the graft engine (sessions, sync, breadcrumbs). */
    readonly graft: GraftService;
    /** M7: HEAD watchers + the git-status poll behind the sidebar badges. */
    readonly repoWatch: RepoAssociationWatchService;
    /** M7: breadcrumbs a crashed daemon left behind, detected once at start. */
    readonly graftOrphans: readonly GraftOrphan[];
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
    // Declared before persistence: an open failure fires `onDegraded` synchronously from
    // `createPersistence`, and a `let` in the temporal dead zone would throw there instead.
    let ws: WsServer | undefined;
    // Every persistence failure is surfaced twice: `onError` for the log, `onDegraded` for the
    // things that must not be missed — a loud line, a client-visible event, and the flag `ping`
    // and `nexd status` report. Silence here is the P0 this whole path exists to prevent.
    const persistence = createPersistence({
        path: dbPath,
        onError: (error, phase) => report(error, `persistence ${phase}`),
        onDegraded: (health) => {
            log(
                `WARNING: nexd cannot save state — ${health.path}: ${health.error ?? 'unknown error'} (phase ${health.phase ?? 'open'}, ${String(health.failedSaves)} failed save(s)). Workspaces, panes and agent sessions created from here on will NOT survive a restart.`
            );
            // `ws` may not exist yet (an open failure happens before the server is built); the
            // start-time gate below covers that window by refusing to start at all.
            ws?.broadcast(persistenceDegradedEvent(health));
        }
    });
    const loaded = initialState(persistence, home);
    /** Set when boot must refuse to start (P0: never run memory-only by accident). */
    let persistenceFatal: PersistenceUnavailableError | undefined;
    if (!persistence.isAvailable && persistence.path !== ':memory:') {
        if (isTruthyEnv(env[ALLOW_EPHEMERAL_STATE_ENV])) {
            log(
                `WARNING: ${ALLOW_EPHEMERAL_STATE_ENV} is set — starting WITHOUT persistence. Nothing in this session will be saved.`
            );
        } else {
            try {
                assertPersistenceUsable(persistence);
            } catch (error) {
                // Thrown from `start()`, not from here: a constructor that throws would leave a
                // half-built daemon nobody can `stop()`.
                persistenceFatal = error as PersistenceUnavailableError;
            }
        }
    }
    const store = createStore(loaded.state);
    const pty = createPtyManager({
        onError: (paneID, error) => report(error, `pty ${paneID}`)
    });
    // What each pane was last rendered at, so a shell is BORN at that size instead of at
    // 80×24 and then resized once a client attaches — the headless emulator never reflows,
    // so a prompt printed at the wrong width stays wrong in every later snapshot
    // (`pty/geometry.ts`). It lives beside the database, which is the daemon's state
    // directory; a `:memory:` daemon keeps it in memory too.
    const geometry = createPaneGeometryStore({
        path: dbPath === ':memory:' ? null : join(dirname(dbPath), GEOMETRY_FILE_NAME),
        onError: (error, context) => report(error, context)
    });
    const term = createTerminalStateService();
    const input = createTerminalInput({ pty, modes: (paneID) => term.modes(paneID) });
    // M5: content panes. It owns its own git service (diff panes) and file watchers, and its
    // edit buffers are flushed by `stop()` below before the persist gate closes.
    // M8: the settings authority. Created BEFORE the content service so markdown/diff panes
    // render against the user's real ghostty background from the very first load rather than
    // painting the fallback and re-rendering a tick later.
    const settings = createSettingsService({
        env,
        home,
        ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
        ...(onError !== undefined ? { onError } : {})
    });
    const content = createContentService({
        store,
        appearance: contentAppearanceOf(settings.snapshot),
        ...(onError !== undefined ? { onError } : {}),
        ...(options.now !== undefined ? { now: options.now } : {})
    });
    // A ghostty theme change re-renders every live content pane (content-panes.md §3.8) and
    // reaches every attached client as one broadcast.
    const offSettings = settings.subscribe((snapshot) => {
        try {
            content.setAppearance(contentAppearanceOf(snapshot));
        } catch (error) {
            report(error, 'content appearance');
        }
        ws?.broadcast({ type: 'settings-changed', settings: snapshot });
    });
    // M7: one git service shared by the handlers, the graft engine and the HEAD watchers, so
    // every git spawn resolves the same executable and honours the same timeouts.
    const git: GitService = createGitService();
    const graft = createGraftService({
        git,
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(options.uuid !== undefined ? { uuid: options.uuid } : {}),
        ...(onError !== undefined ? { onError } : {})
    });
    // M6: web panes. The daemon owns tabs/console/picker state; the Electron shell registers
    // as the HOST over the WS channel and executes anything that needs a real browser. One
    // instance is shared by the `web-*` handlers and the sync hub — two would mean the CLI
    // talking to a registry no shell ever joined.
    const webPanes = createWebPaneService({
        store,
        paste: (paneID, text, pasteOptions) => {
            // `nex web inspect --send-to`: a picked element lands in a shell pane's PTY, bare
            // unless the arm asked for `--submit` (web-pane.md §11.3).
            input.sendText(paneID, text, { bare: !pasteOptions.submit });
        },
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(onError !== undefined ? { onError } : {})
    });

    let runControl: ControlServer | undefined;
    let compatControl: ControlServer | undefined;
    let info: DaemonInfo | undefined;
    let graftOrphans: readonly GraftOrphan[] = [];
    let running = false;
    let stopping = false;
    let stopped: Promise<void> | undefined;

    // Saves are gated until the resume commands have gone out (§12.3 step 9): a crash before
    // the resume must leave the session ids in the DB for the next launch.
    let persistReady = false;

    const snapshotNow = (): void => {
        persistence.scheduleSave(toSnapshot(store.getState()));
    };
    /**
     * A client that attached AFTER the failed open missed the one-shot announcement (there was
     * no WS server yet). Re-announce whenever the attached-client count changes while degraded,
     * so opening the UI on a broken daemon shows the warning rather than a serene, unsaveable
     * workspace.
     */
    let announcedToClients = -1;
    const announceDegraded = (): void => {
        const health = persistence.health();
        if (!health.degraded) return;
        const clients = ws?.clients ?? 0;
        if (clients === 0 || clients === announcedToClients) return;
        announcedToClients = clients;
        ws?.broadcast(persistenceDegradedEvent(health));
    };
    const persist = (): void => {
        if (stopping || !persistReady) return;
        announceDegraded();
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

    // Every spawn path (boot restore, `pane-split`, `pane create`) asks the geometry cache
    // first and only falls back to the fixed grid for a pane nothing has ever rendered.
    const spawnDefaults: PaneSpawnDefaults = {
        ...(options.spawn ?? {}),
        sizeFor: (paneID: string) => geometry.sizeFor(paneID)
    };
    const ctx: PaneHandlerContext = {
        store,
        pty,
        term,
        input,
        version,
        broadcast: (event) => {
            ws?.broadcast(event);
        },
        // `ping` reports this: a daemon that cannot save must never answer a health check as if
        // it could.
        persistenceHealth: () => persistence.health(),
        profiles: readProfiles,
        spawn: spawnDefaults,
        ...(options.now !== undefined ? { clock: options.now } : {}),
        ...(options.uuid !== undefined ? { mintPaneID: options.uuid, mintWorkspaceID: options.uuid } : {})
    };

    // Session lifecycle → clients (they render the per-association status dot from this).
    const offGraft = graft.updates(() => {
        ws?.broadcast(graftChangedEvent(graft.activeSessions()));
    });

    // Every association-removal path (workspace delete, group cascade, repo removal,
    // auto-unlink) funnels through the store, so the reconciler is where §8.8's unconditional
    // graft force-stop + HEAD-watcher stop live.
    const repoWatch = createRepoAssociationWatch({
        store,
        git,
        graft,
        persist,
        ...(onError !== undefined ? { onError } : {})
    });

    const appHandlers = createAppHandlers({
        git,
        graft,
        webPanes,
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
            offSettings();
            settings.dispose();
            content.dispose();
            // Releases the host slot (the shell sees `host-revoked`) and ends every console
            // follow stream; nothing here can block the shutdown.
            webPanes.close();
            repoWatch.dispose();
            // §5 quit flush: unwind every graft session (2 s cap) so a clean quit never leaves
            // a `nex-graft-active` breadcrumb behind — anything slower falls back to the
            // orphan-recovery banner on the next launch.
            try {
                await graft.shutdown();
            } catch (error) {
                report(error, 'graft shutdown');
            }
            offGraft();
            // SIGTERM contract: write the debounced snapshot before anything else changes.
            // A shutdown DURING the restore window deliberately writes nothing — the DB must
            // keep the session ids the resume never got to use (§6.1 step 5).
            //
            // The result matters: `nexd stop` used to print a clean stop over a database that
            // had never been written. A failed final flush is the LAST chance to say so.
            const flushed = persistence.flush();
            // Only meaningful for a daemon that actually served: a `start()` that REFUSED
            // (`ENEXDPERSIST`) tears down through here too, and "everything is lost" would be a
            // lie about a session that never existed.
            const served = info !== undefined;
            if (!flushed && served) {
                const health = persistence.health();
                log(
                    `ERROR: nexd shut down WITHOUT saving state — ${health.path}: ${health.error ?? 'the database was never opened'}. Everything created in this session is lost.`
                );
            }
            await pty.killAll();
            // The last-known pane grids are what the NEXT boot spawns at, so they have to
            // survive this one (`pty/geometry.ts`); the write is debounced and may be pending.
            geometry.close();
            await Promise.all([
                runControl?.stop() ?? Promise.resolve(),
                compatControl?.stop() ?? Promise.resolve(),
                ws?.stop() ?? Promise.resolve()
            ]);
            persistence.close();
            // The token and the port file stay: both are stable across restarts by design.
            clearRunFiles(paths);
            log(served && persistence.health().degraded ? 'nexd stopped (state NOT saved)' : 'nexd stopped');
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
                    // A shutdown that could not write state is a failed shutdown, and the exit
                    // code is the only thing a supervisor (or a `nexd start --foreground` in a
                    // terminal) ever reads.
                    () => process.exit(persistence.health().degraded ? 1 : 0),
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
                webPanes,
                settings,
                // The pane header's restart button: typing a resume command needs the same
                // TerminalInput (live VT modes, no sync mirroring) the CLI's `pane send` uses.
                agents: createAgentChannel({ store, pty, input }),
                // `/pane-assets/<paneID>/<relpath>` — sibling files of an open markdown file, so
                // relative `<img src>` resolves (content-panes.md port note 4).
                routes: createPaneAssetsRoute((paneID, relativePath) =>
                    content.assetPath(paneID, relativePath)
                ),
                // Remember what each pane is actually rendered at, so the next spawn of it
                // (a restart, the next daemon boot) starts there (`pty/geometry.ts`).
                onGeometry: (paneID, cols, rows) => {
                    geometry.record(paneID, cols, rows);
                },
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

        // Before ANY side effect — no run dir, no sockets, no PTYs. A daemon that cannot write
        // its database does not come up; it says which file, which errno, and how to fix it.
        if (persistenceFatal !== undefined) throw persistenceFatal;

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

        // HEAD watchers for every persisted association + the 30 s dirtiness poll (§9.2/§9.3).
        repoWatch.start();
        // A crashed sync leaks a throw-away index into the temp dir (port note 18); only
        // day-old files are swept, so a concurrent daemon's in-flight sync is never robbed.
        try {
            sweepGraftTempIndexes();
        } catch (error) {
            report(error, 'graft temp sweep');
        }
        // §4.10 / §10: a breadcrumb inside a registered repo's `.git` means a previous daemon
        // died mid-graft. Detection runs here over the deduped registry roots (exactly the
        // Swift app's `onAppLaunched`); recovery itself is user-driven and lands with M8's UI.
        try {
            graftOrphans = graft.detectOrphans([
                ...new Set(store.getState().repos.map((repo) => repo.path))
            ]);
            if (graftOrphans.length > 0) {
                log(`graft: ${String(graftOrphans.length)} interrupted session(s) need recovery`);
                ws?.broadcast(graftOrphansEvent(graftOrphans));
            }
        } catch (error) {
            report(error, 'graft orphan detection');
        }

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
            persistence: persistence.health(),
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
        persistenceHealth: () => persistence.health(),
        content,
        settings,
        webPanes,
        graft,
        repoWatch,
        get graftOrphans() {
            return graftOrphans;
        },
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
