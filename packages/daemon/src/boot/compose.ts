import { pluginAssetsRoute } from '../plugins/http.js';
import { PluginService } from '../plugins/service.js';
import { createPluginGitService } from '../plugins/git-service.js';
import { pluginObject } from '@kelpi/protocol';
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
 *     (`daemon-v<N>.sock`, what `kelpid status` / clients discover), and the HTTP+WS server on a
 *     port remembered in the run dir;
 *   - the boot ordering from app-state-core.md §12.3 / agent-lifecycle.md §6.1: load →
 *     capture resume tuples → clear ids/statuses → spawn PTYs → settle ~2 s → type resume →
 *     THEN persist. Saves are gated until that last step, exactly so a crash mid-restore
 *     leaves the session ids in the DB for the next launch;
 *   - shutdown: flush the debounced save, then kill PTYs (bounded), then close listeners.
 */

import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { newUUID } from '@kelpi/core/codec';
import { SYSTEM_STATS_INTERVAL_MS, WS_TRANSPORT_CHANGED_MESSAGE } from '@kelpi/protocol';
import { captureResumeTuple, type ResumeTuple } from '@kelpi/core/agent';

import { createContentService, createContentRenderService, type ContentService } from '../content/index.js';
import {
    contentAppearanceOf,
    createSettingsService,
    watchConfigFile,
    type ConfigWatcher,
    type SettingsService
} from '../settings/index.js';
import {
    ControlSocketBusyError,
    createControlServer,
    resolveControlEndpoints,
    type ControlServer,
    type ControlTcpStatus
} from '../control/index.js';
import {
    assertPersistenceUsable,
    createPersistence,
    PersistenceUnavailableError,
    resolveDatabasePath,
    type SqlitePersistence
} from '../db/index.js';
import {
    createGitService,
    sweepGraftTempIndexes,
    type GitService
} from '../git/index.js';
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
// §TERM-050: the OSC desktop-notification sink, the sibling of the agent-event path.
import { createOscNotificationSink } from '../handlers/app/osc-notifications.js';
// §TERM-046: the OSC 52 clipboard sink — the gate, the log lines and the client broadcast.
import { createClipboardWriteSink } from '../handlers/app/clipboard.js';
import { paneHandlers, spawnEnvVars, spawnPaneIfShell, type PaneHandlerContext, type PaneSpawnDefaults } from '../handlers/pane/index.js';
import {
    clearRunFiles,
    createAssetCredentialGate,
    createDeviceValidator,
    ensureRunDir,
    ensureToken,
    resolveDevicesPath,
    resolveRunPaths,
    writePidRecord,
    type RunPaths
} from '../lifecycle/index.js';
import {
    DEFAULT_SPAWN_DEFER_TIMEOUT_MS,
    GEOMETRY_FILE_NAME,
    createPaneGeometryStore,
    createPaneSpawnGate,
    createPtyManager,
    createTerminalInput,
    FALLBACK_SHELL,
    withSpawnGate,
    type KelpiPtyManager
} from '../pty/index.js';
import { nodePtySpawner } from '../pty/spawner.js';
import { createEditorResolver, type EditorResolver } from '../content/external-editor.js';
import type { WireMessage } from '@kelpi/protocol';
import type { ControlDispatchItem, ControlDispatcher, PersistenceHealth, ReplyHandle, TerminalInput } from '../seams.js';
import {
    applyLoadReset,
    createStore,
    emptyDaemonState,
    fromSnapshot,
    nextRandomColor,
    toSnapshot,
    visiblePane,
    workspaceContainingVisiblePane,
    type DaemonState,
    type KelpiStore
} from '../store/index.js';
import {
    createPaneBranchWatch,
    createRepoAutoDetect,
    type PaneBranchWatchService
} from '../git/index.js';
import { createSystemStatsSampler } from '../stats/index.js';
import {
    createTerminalStateService,
    type Osc52Request,
    type OscNotification,
    type TerminalStateServiceImpl
} from '../term/index.js';
import {
    createAgentChannel,
    createGraftOrphanRegistry,
    createRemoteChannel,
    createPaneAssetsRoute,
    createPaneLifecycleChannel,
    createDesktopChannel,
    createWsServer,
    resolveClientDistDir,
    WEB_BATCH_MESSAGE,
    WEB_FAVOURITES_MESSAGE,
    WEB_NAV_STATE_MESSAGE,
    WEB_VIEW_FOCUS_MESSAGE,
    type GraftChannel,
    type RepoChannel,
    type WsServer
} from '../ws/index.js';
import {
    createWebPaneService,
    serializeBatchSession,
    serializeFavourite,
    type WebPaneService
} from '../webpane/index.js';
import { configuredTcpPort, loadDaemonConfig, createProfileReader, type DaemonConfig } from './config.js';
import { createDispatcher } from './dispatch.js';
import { runLabelPresetMigration } from './labels.js';
import { readPortFile, readRoutePortFile, writePortFile, writeRoutePortFile } from './port.js';
import { spawnRestoredPanes, typeResumeCommands, type RestoreDeps, type ResumeDeps, type ResumeOutcome } from './resume.js';
import type { LostReason, TerminalHostClient } from '../host/client.js';
import { endHost, ensureTerminalHost, readHostPidRecord, resolveHostPaths, verifiedHostPid } from '../host/launch.js';
import { HOST_PROTOCOL_VERSION } from '../host/protocol.js';
import type { RestoredAgentState } from '../store/types.js';
import { prepareHostRuntime } from '../host/runtime.js';
import { HostSpawnerSlot, hostHandleOf } from '../host/slot.js';
import { decodeHandoffBlob, encodeHandoffBlob } from '../host/blob.js';
import type { TerminalInfo } from '../host/protocol.js';
import { resolveDaemonVersion, type DaemonVersion } from './version.js';

export const HTTP_PORT_ENV = 'KELPID_HTTP_PORT';
export const HTTP_HOST_ENV = 'KELPID_HTTP_HOST';
/**
 * Directory holding the bundled `kelpi` CLI, prepended to every pane's PATH. Set by the shell
 * at daemon-spawn time (mirroring `KELPID_CLIENT_DIR`): the daemon has no idea it lives inside
 * an app bundle, so the side that knows tells it. Without it a pane's `kelpi` is whatever the
 * user's rc files resolve — which on a machine also running the Swift app is the WRONG one.
 */
export const HELPERS_DIR_ENV = 'KELPID_HELPERS_DIR';

/**
 * Opt in to running WITHOUT persistence (`1` / `true` / `yes`).
 *
 * Default behaviour is a hard refusal to start when the database cannot be opened, because the
 * alternative is what shipped: a daemon that ran all day against an unopenable
 * `KELPID_DB_PATH=/tmp/kelpid-dev.db`, reported itself healthy, and lost every workspace. Anyone who
 * genuinely wants a throw-away daemon (a read-only container, a scratch instance) says so here
 * and gets a loud warning on every boot instead.
 */
export const ALLOW_EPHEMERAL_STATE_ENV = 'KELPID_ALLOW_EPHEMERAL_STATE';

/** Broadcast to every attached client when the daemon stops being able to save (P0). */
export const PERSISTENCE_DEGRADED_EVENT = 'persistence-degraded';

/** Name of the workspace created on a fresh install (app-state-core.md §12.2). */
export const DEFAULT_WORKSPACE_NAME = 'Default';

/**
 * How long after `start()` a restored pane may still be held for a client's first geometry
 * report (`pty/spawn-gate.ts`).
 *
 * Boot is the one moment where the spawn gate cannot ask "is a client attached?" and get a
 * useful answer: panes are restored BEFORE the WS server is listening (§12.2 — a CLI that
 * connects the instant the socket appears must never see a half-restored daemon), so at that
 * point the answer is always no. A window launched alongside the daemon attaches within about
 * a second; this window is that expectation, and every deferral inside it is still bounded by
 * the gate's own timeout, so a daemon nothing ever attaches to pays the timeout once and then
 * behaves exactly as it always did.
 */
export const DEFAULT_BOOT_DEFER_WINDOW_MS = 2500;

/** A handoff waits at most this long for a restore still in progress (`docs/terminal-host.md` §6). */
export const HANDOFF_RESTORE_WAIT_MS = 10_000;

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
    /** Run directory override (otherwise `KELPID_RUN_DIR` / the platform default). */
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
    /**
     * How long a pane whose grid nobody has ever reported waits for a client to measure it
     * before being spawned at the fallback grid (`pty/spawn-gate.ts`). Defaults to
     * `DEFAULT_SPAWN_DEFER_TIMEOUT_MS`; `0` makes every deferral expire on the next tick,
     * which is the closest thing to switching the gate off.
     */
    readonly spawnDeferTimeoutMs?: number | undefined;
    /**
     * How long after `start()` a boot-restored pane may still be deferred, in the expectation
     * that a window is on its way (nothing is attached yet at restore time — the WS server is
     * not even listening). Defaults to `DEFAULT_BOOT_DEFER_WINDOW_MS`; `0` restricts deferral
     * to panes created while a client is genuinely attached.
     */
    readonly bootDeferWindowMs?: number | undefined;
    /** Injected clock for the settle (tests). */
    readonly sleep?: ((ms: number) => Promise<void>) | undefined;
    /** Epoch ms clock for handlers (tests). */
    readonly now?: (() => number) | undefined;
    /** Id source for handlers + the fresh-install workspace (tests). */
    readonly uuid?: (() => string) | undefined;
    /**
     * Unit-interval source for `nextRandomColor` (tests). Shared by the handlers and the
     * fresh-install workspace so both palette picks come from the one injected stream (#56).
     */
    readonly random?: (() => number) | undefined;
    /**
     * `$VISUAL` / `$EDITOR` resolution (CONT-081…088). Absent, the daemon builds the real one,
     * which asks the user's LOGIN shell: `zsh -l -i -c`, sourcing `.zprofile` and `.zshrc`.
     *
     * A test that drives `markdown-external-editor` passes its own resolver here (#115). Boot
     * itself never touches the resolver, so an ordinary test daemon forks nothing either way;
     * this is the seam that keeps it that way once a test does exercise the verb. It is an
     * injected service rather than an env var for the same reason `now` / `uuid` / `random` are:
     * a vitest worker runs many daemons in one process, and a per-daemon argument cannot leak
     * into the one beside it.
     */
    readonly editor?: EditorResolver | undefined;
    /** Install SIGTERM/SIGINT handlers. `kelpid start` sets it; tests do not. */
    readonly installSignalHandlers?: boolean | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
    readonly onLog?: ((message: string) => void) | undefined;
    /**
     * Run every PTY in a separate terminal host process, so shells outlive this daemon
     * (`docs/terminal-host.md`). `kelpid start` sets it; omitted, PTYs run in-process as before
     * and die with the daemon.
     */
    readonly terminalHost?: TerminalHostLaunch | undefined;
    /** Called after a SIGUSR2 handoff, just before the process exits (`kelpid restart` starts its successor here). */
    readonly onHandedOff?: ((outcome: 'handed-off' | 'stopped') => void) | undefined;
}

/** Where the terminal host comes from (`CreateDaemonOptions.terminalHost`). */
export interface TerminalHostLaunch {
    /** The directory holding `terminal-host.js` (beside `kelpid.js`). */
    readonly daemonDir: string;
    /** The Node that runs it; defaults to this process's. */
    readonly execPath?: string | undefined;
    /** Defaults to `<run dir>/terminal-host.log`. */
    readonly logFile?: string | undefined;
}

export interface DaemonInfo {
    readonly pid: number;
    readonly version: DaemonVersion;
    /** The CLI-compat control socket (`kelpi` talks to this one). */
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
    /** Is state actually reaching the disk? Printed by `kelpid start --foreground`. */
    readonly persistence: PersistenceHealth;
    readonly workspaces: number;
    readonly resumeTuples: number;
}

export interface Daemon {
    start(): Promise<DaemonInfo>;
    stop(): Promise<void>;
    /**
     * Hand every terminal to the terminal host and stop without killing them
     * (`docs/terminal-host.md` §6); a full stop when there is no host. SIGUSR2 calls it.
     */
    handoff(): Promise<'handed-off' | 'stopped'>;
    /** Resolves when the resume pipeline finished (and saves were un-gated). */
    readonly restored: Promise<ResumeOutcome>;
    readonly info: DaemonInfo | undefined;
    readonly store: KelpiStore;
    readonly pty: KelpiPtyManager;
    readonly term: TerminalStateServiceImpl;
    readonly input: TerminalInput;
    readonly persistence: SqlitePersistence;
    /** Live "is state reaching the disk?" — what `ping` reports and `stop()` checks. */
    persistenceHealth(): PersistenceHealth;
    /** M5: markdown/diff/scratchpad content, watchers and edit buffers. */
    readonly content: ContentService;
    /** M8: the config-file settings authority (kelpi + ghostty), watched and write-through. */
    readonly settings: SettingsService;
    /** M6: the web-pane runtime (host RPC seam, console buffers, picker arms). */
    readonly webPanes: WebPaneService;
    /** M7: the graft engine (sessions, sync, breadcrumbs). */
    readonly graft: GraftService;
    /** M7: HEAD watchers + the git-status poll behind the sidebar badges. */
    readonly repoWatch: RepoAssociationWatchService;
    /** §GIT-091: the pane-branch producer chained behind pwd changes and HEAD changes. */
    readonly branchWatch: PaneBranchWatchService;
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
/** §14: `favourites.json` sits beside the database, so it follows every sandbox override. */
function favouritesPath(databasePath: string): string {
    return join(dirname(databasePath), 'favourites.json');
}

function initialState(
    persistence: SqlitePersistence,
    home: string
): {
    state: DaemonState;
    tuples: readonly ResumeTuple[];
    status: 'ok' | 'empty' | 'unreadable';
    /** Each pane's live agent state before the reset, for panes whose shell survived (§7). */
    agentBefore: ReadonlyMap<string, RestoredAgentState>;
} {
    const outcome = persistence.loadOutcome();
    const restored =
        outcome.snapshot === null
            ? emptyDaemonState(home)
            : fromSnapshot(outcome.snapshot, { homeDirectory: home });
    const agentBefore = new Map<string, RestoredAgentState>();
    for (const workspace of restored.workspaces) {
        for (const pane of workspace.panes) {
            agentBefore.set(pane.id, {
                status: pane.status,
                agentSessionID: pane.agentSessionID,
                agentStartedAt: pane.agentStartedAt,
                backgroundTaskCount: pane.backgroundTaskCount
            });
        }
    }
    // Capture-then-clear BEFORE anything spawns (agent-lifecycle.md §6.1 steps 1–2).
    const reset = applyLoadReset(restored);
    return { state: reset.state, tuples: reset.resumeTuples, status: outcome.status, agentBefore };
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
    /** Watches `devices.json` so `kelpid devices revoke` cuts OPEN sessions, not just new ones. */
    let devicesWatcher: ConfigWatcher | undefined;
    // Every persistence failure is surfaced twice: `onError` for the log, `onDegraded` for the
    // things that must not be missed — a loud line, a client-visible event, and the flag `ping`
    // and `kelpid status` report. Silence here is the P0 this whole path exists to prevent.
    const persistence = createPersistence({
        path: dbPath,
        onError: (error, phase) => report(error, `persistence ${phase}`),
        onDegraded: (health) => {
            log(
                `WARNING: kelpid cannot save state — ${health.path}: ${health.error ?? 'unknown error'} (phase ${health.phase ?? 'open'}, ${String(health.failedSaves)} failed save(s)). Workspaces, panes and agent sessions created from here on will NOT survive a restart.`
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
    /**
     * With a terminal host, spawns go through this slot: to the host once it is connected in
     * `start()`, queued until then, and in-process if no host can be started (§5, §8).
     */
    const hostSlot = options.terminalHost !== undefined ? new HostSpawnerSlot(FALLBACK_SHELL) : undefined;
    const rawPty = createPtyManager({
        ...(hostSlot !== undefined ? { spawner: hostSlot.spawner } : {}),
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
    /**
     * …and for the panes the cache has never seen — a fresh install's first pane, a split's
     * child, a markdown pane's first ⌘E — the other half of the same argument: wait for the
     * client to say how big the pane is instead of guessing (`pty/spawn-gate.ts`).
     *
     * The policy is here because only boot knows whether anybody is looking: defer while a
     * client is attached, or while we are inside the boot window where one is expected, and
     * never otherwise. A CLI-only daemon — the compat suite, every headless flow — therefore
     * spawns exactly as it did before the gate existed.
     */
    let bootDeferUntil = 0;
    const spawnGate = createPaneSpawnGate({
        timeoutMs: options.spawnDeferTimeoutMs ?? DEFAULT_SPAWN_DEFER_TIMEOUT_MS,
        shouldDefer: () => (ws?.clients ?? 0) > 0 || (options.now ?? Date.now)() < bootDeferUntil,
        onError: (error, context) => report(error, context)
    });
    /**
     * Everything downstream — the handler context, the input encoder, the WS stream hub — gets
     * the GATED manager, so a keystroke, a `pane send` or a pane close resolves a pending spawn
     * without any caller knowing the gate is there (`withSpawnGate`).
     */
    const pty = withSpawnGate(rawPty, spawnGate);
    /** Assigned once the store and the settings exist (just below `term`). */
    let onPaneDirectory: (paneID: string, directory: string) => void = () => {};
    /**
     * OSC 7 is the port's pwd producer (terminal-panes.md §TERM-048): the shell reports where
     * it is, the pane's `workingDirectory` follows, and repo auto-detect picks the move up from
     * the store (graft-git.md §GIT-075). `store` is created further down; this closure defers
     * to it, so the ordering between the two is not load-bearing.
     */
    /** Assigned beside `onPaneDirectory`, and deferred for the same reason. */
    let onPaneTitle: (paneID: string, title: string) => void = () => {};
    /**
     * §TERM-050's delivery, deferred for the same reason as the two above: it needs `store` and
     * `ws`, both of which are built below.
     */
    let onPaneOscNotification: (paneID: string, notification: OscNotification) => void = () => {};
    /**
     * §TERM-046's delivery, deferred for the same reason as the three above: the gate reads
     * `settings`, the routing reads `store` and the broadcast needs `ws`.
     */
    let onPaneClipboardRequest: (paneID: string, request: Osc52Request) => void = () => {};
    const term = createTerminalStateService({
        onBackpressure: (paneID, paused) => {
            if (paused) pty.pauseOutput(paneID);
            else pty.resumeOutput(paneID);
        },
        onError: (paneID, error) => report(error, `terminal write ${paneID}`),
        onDirectoryChange: (paneID, directory) => {
            try {
                onPaneDirectory(paneID, directory);
            } catch (error) {
                report(error, 'pane directory report');
            }
        },
        // §TERM-147's OTHER writer: OSC 0 / OSC 2. The pwd half (OSC 7, above) landed first; a
        // pane whose TITLE moves without a directory change now advances `lastActivityAt` too,
        // which is what `workspace list --json`'s `last_activity_at` and `group sort
        // --by last-activity` read — and what the pane header shows (`title ?? workingDirectory`).
        onTitleChange: (paneID, title) => {
            try {
                onPaneTitle(paneID, title);
            } catch (error) {
                report(error, 'pane title report');
            }
        },
        // §TERM-050: OSC 9 / OSC 777 out of the PTY stream. The suppression matrix and the
        // broadcast live in `deliverOscNotification` below, beside the client-presence reads
        // the agent-event path already uses.
        onOscNotification: (paneID, notification) => {
            try {
                onPaneOscNotification(paneID, notification);
            } catch (error) {
                report(error, 'pane osc notification');
            }
        },
        // §TERM-046: OSC 52 out of the PTY stream. The gate (`clipboard-write`, default off),
        // the log lines and the broadcast are `handlers/app/clipboard.ts`; a READ request never
        // gets an answer, and there is deliberately no path from here back to the PTY.
        onClipboardRequest: (paneID, request) => {
            try {
                onPaneClipboardRequest(paneID, request);
            } catch (error) {
                report(error, 'pane clipboard request');
            }
        },
        // §TERM-037…§TERM-039: the CLIENT encodes DEC mouse reports (no renderer this port ships
        // implements them), so the modes have to reach it as state. Targeted at the clients
        // attached to that pane's stream rather than broadcast (`ws/streams.ts`).
        onModesChange: (paneID, modes) => {
            try {
                ws?.streams.modesChanged(paneID, modes);
            } catch (error) {
                report(error, 'pane modes report');
            }
        },
        // §TERM-030: the one place where parsing OUTPUT owes the PTY INPUT. A real terminal
        // answers `CSI ? u` with its kitty-keyboard flags, and that answer is how an
        // application learns the protocol exists at all. `writeDirect`, never `write`: a device
        // reply belongs to the pane that asked, and mirroring it into every synchronise-input
        // sibling would hand each of them an answer to a question they never asked.
        onKittyReply: (paneID, reply) => {
            try {
                pty.writeDirect(paneID, reply);
            } catch (error) {
                report(error, 'kitty keyboard query reply');
            }
        }
    });
    const input = createTerminalInput({ pty, modes: (paneID) => term.modes(paneID) });
    // M5: content panes. It shares the replaceable Git service and owns file watchers; its
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
    let pluginHost: PluginService | undefined;
    const pluginGit = createPluginGitService(createGitService(), () => pluginHost);
    const git: GitService = pluginGit.git;
    const content = createContentService({
        store,
        git,
        services: () => pluginHost,
        appearance: contentAppearanceOf(settings.snapshot),
        ...(onError !== undefined ? { onError } : {}),
        ...(options.now !== undefined ? { now: options.now } : {})
    });
    /**
     * The footer's system-stat gauges (APP-078…085). The Swift app samples in the VIEW; a
     * browser tab cannot read host counters and two clients must not double-sample one
     * machine, so the daemon samples once and broadcasts (`@kelpi/protocol` `ws/stats.ts`).
     *
     * The loop is gated on `show-system-stats` AND at least one attached client — AGNT-107's
     * "skipped entirely when the toggle is off", extended by the only honest translation of a
     * view-layer timer into a headless process: with no window, there was no timer either.
     */
    const stats = createSystemStatsSampler({
        home,
        ...(onError !== undefined ? { onError } : {})
    });
    const offStats = stats.subscribe((snapshot) => {
        ws?.broadcast({
            type: 'system-stats',
            stats: snapshot.stats,
            history: snapshot.history,
            intervalMs: snapshot.intervalMs
        });
    });
    let statsGateTimer: NodeJS.Timeout | null = null;
    const refreshStatsGate = (): void => {
        const wanted = settings.snapshot.chrome.showSystemStats && (ws?.clients ?? 0) > 0;
        // A no-op when nothing changed, so this is safe to call as often as we like.
        stats.setEnabled(wanted);
    };
    // A ghostty theme change re-renders every live content pane (content-panes.md §3.8) and
    // reaches every attached client as one broadcast.
    const offSettings = settings.subscribe((snapshot) => {
        try {
            content.setAppearance(contentAppearanceOf(snapshot));
        } catch (error) {
            report(error, 'content appearance');
        }
        ws?.broadcast({ type: 'settings-changed', settings: snapshot });
        // §AGNT-005: `tcp-port` is the one general setting whose effect is a LISTENER, so a
        // change to it is applied rather than filed away for the next daemon start. It runs
        // after the broadcast because the re-bind is async and its own result is broadcast
        // separately (`transport-changed`).
        void applyTcpPortSetting(snapshot.general.tcpPort);
        // Toggling `show-system-stats` in Settings starts / stops the sampler itself, not just
        // the gauges: a disabled toggle must cost nothing, not sample invisibly.
        refreshStatsGate();
    });
    // M7: one git service shared by the handlers, the graft engine and the HEAD watchers, so
    // every git spawn resolves the same executable and honours the same timeouts.
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
            // `kelpi web inspect --send-to`: a picked element lands in a shell pane's PTY, bare
            // unless the arm asked for `--submit` (web-pane.md §11.3).
            input.sendText(paneID, text, { bare: !pasteOptions.submit });
        },
        // §14: favourites live in `favourites.json` beside the database, so a sandboxed daemon
        // (tests, the packaged smoke) keeps them inside its own dir and an in-memory daemon
        // keeps them in memory. See `webpane/favourites.ts` for why not the app-state row.
        ...(dbPath === ':memory:' ? {} : { favourites: { path: favouritesPath(dbPath) } }),
        // Both surfaces are daemon state that no `DomainEvent` describes, so they reach clients
        // as their own broadcasts rather than through the delta stream.
        onBatchChanged: (paneID, session) => {
            ws?.broadcast({
                type: WEB_BATCH_MESSAGE,
                paneID,
                batch: serializeBatchSession(session)
            });
        },
        // WEB-032/WEB-033: one tab's loading + history state. Ephemeral (no store, no
        // persistence) — the chrome's progress strip and its dimmed nav buttons are the only
        // consumers, and a client that missed one learns the truth from the next load.
        onNavStateChanged: (navState) => {
            ws?.broadcast({
                type: WEB_NAV_STATE_MESSAGE,
                paneID: navState.paneID,
                tabID: navState.tabID,
                loading: navState.loading,
                can_go_back: navState.canGoBack,
                can_go_forward: navState.canGoForward
            });
        },
        onFavouritesChanged: (favourites) => {
            ws?.broadcast({
                type: WEB_FAVOURITES_MESSAGE,
                favourites: favourites.map(serializeFavourite)
            });
        },
        /**
         * §N29: the user clicked into a web pane's PAGE. A native view's click reaches Chromium
         * and nothing else, so this fan-out is the only way the client can hear about it — and
         * the client, not the daemon, then runs the focus path (the same one a terminal body
         * click runs, ending in the ordinary `report-focus` back here). Ephemeral like the two
         * above: nothing is stored, because it describes a gesture rather than a state.
         */
        onViewFocused: (focus) => {
            ws?.broadcast({
                type: WEB_VIEW_FOCUS_MESSAGE,
                paneID: focus.paneID,
                workspaceID: focus.workspaceID,
                ...(focus.windowID === null ? {} : { windowID: focus.windowID })
            });
        },
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(onError !== undefined ? { onError } : {})
    });

    let runControl: ControlServer | undefined;
    let compatControl: ControlServer | undefined;
    /** The port `pinPaneRoute` asked for on the internal listener, if it re-pinned one. */
    let pinnedRoutePort: number | undefined;
    /**
     * Why the CLI-compat socket is not serving (typically: another Kelpi — the Swift app — owns
     * `/tmp/nex.sock`), or null while it is. A degraded compat socket never takes the daemon
     * down: panes reach it via their injected `KELPI_SOCKET`, and this is what `ping` reports so
     * `kelpi doctor` can say where plain-terminal commands are going instead.
     */
    let compatDegraded: string | null = null;
    /** True when the compat path IS the run-dir path, so `runControl` owns the configured TCP. */
    const runOwnsCompatPath = endpoints.socketPath === paths.socket;

    /**
     * §SET-021 / §AGNT-005: what happened to the TCP listener the USER asked for. `runControl`
     * always carries a TCP listener now (the pane-route port, ephemeral unless it owns the
     * configured one), but an internal ephemeral bind is not the config's `tcp-port` — SET-021
     * reports only a configured request, so an unconfigured daemon still answers "none".
     */
    const controlTcpStatus = (): ControlTcpStatus | null => {
        if (compatControl !== undefined) return compatControl.tcpStatus;
        const status = runControl?.tcpStatus ?? null;
        // The pane route re-pinned to the previous daemon's port (`pinPaneRoute`) is still the
        // internal listener, not a configured `tcp-port`, even though it asked for a number.
        const internal = status !== null && (status.requested === 0 || status.requested === pinnedRoutePort);
        if (status !== null && internal && !(runOwnsCompatPath && endpoints.tcpPort !== undefined)) {
            return null;
        }
        return status;
    };

    /** The `KELPI_SOCKET` value pane environments carry, or null before/without a TCP bind. */
    const paneRouteValue = (): string | null => {
        const status = runControl?.tcpStatus ?? null;
        return status !== null && status.bound !== null
            ? `tcp:${status.host}:${String(status.bound)}`
            : null;
    };

    /** What `welcome.transport` / `transport-changed` carry (Settings ▸ Network). */
    const wsTransportStatus = (): { tcp: ControlTcpStatus | null; compat: { path: string; error: string } | null } => ({
        tcp: controlTcpStatus(),
        compat: compatDegraded !== null ? { path: endpoints.socketPath, error: compatDegraded } : null
    });

    /**
     * §AGNT-005's live re-bind: `tcp-port` changed in the config file, so move the listener.
     *
     * `stopTCP → startTCP` on the server that owns TCP, never a full restart — the Unix socket
     * keeps serving throughout, which is what makes this safe to do under a connected CLI. A
     * failed bind is not an error here either: it lands on `tcpStatus`, rides the broadcast, and
     * Settings ▸ Network says which port is unavailable.
     *
     * The broadcast is separate from `settings-changed` because the two say different things:
     * that one carries what the FILE says, this one carries what the LISTENER did.
     */
    const applyTcpPortSetting = async (port: number): Promise<void> => {
        // An env override (`KELPID_TCP_PORT`, or an explicit `tcpPort` option) OUTRANKS the config
        // file at boot — `resolveControlEndpoints` says so — and it has to keep outranking it
        // afterwards. Without this guard the first unrelated Settings write would read
        // `tcp-port = 0` out of the file and tear down a listener the operator asked for on the
        // command line, taking every `KELPI_SOCKET=tcp:…` client with it.
        if (endpoints.source.tcpPort === 'env') return;
        // The configured `tcp-port` always lives on the compat server when one exists — the
        // run-dir server's TCP listener is the pane route (injected `KELPI_SOCKET`), and a
        // config change must never tear THAT down under the live panes carrying its port.
        const owner = compatControl ?? runControl;
        if (owner === undefined) return;
        const wanted = port > 0 ? port : undefined;
        const current = owner.tcpStatus;
        // Nothing to do when the request is unchanged AND it succeeded; a previous FAILURE is
        // worth retrying, because "the port is free now" is the common reason to come back here.
        if ((current?.requested ?? undefined) === wanted && current?.error == null) return;
        try {
            const next = await owner.startTCP(wanted);
            log(
                next === null
                    ? 'control tcp listener disabled'
                    : next.bound !== null
                      ? `control tcp listener rebound on ${next.host}:${String(next.bound)}`
                      : `control tcp listener FAILED on port ${String(next.requested)}: ${String(next.error)}`
            );
            // No compat server means the configured TCP shares `runControl` with the pane
            // route; disabling it would strand every live pane's injected KELPI_SOCKET, so the
            // route falls back to a fresh ephemeral (new panes pick it up at spawn).
            if (owner === runControl && next === null) {
                const rebound = await owner.startTCP(0);
                if (rebound?.bound != null) {
                    log(`pane-route tcp listener rebound on ${rebound.host}:${String(rebound.bound)}; existing panes keep their old KELPI_SOCKET until respawned`);
                }
            }
        } catch (error) {
            report(error, 'tcp rebind');
        }
        ws?.broadcast({ type: WS_TRANSPORT_CHANGED_MESSAGE, transport: wsTransportStatus() });
    };

    /**
     * `$VISUAL` / `$EDITOR` resolution for the external-editor pane mode (CONT-081…088).
     *
     * Constructing it forks nothing. The login-shell probe is armed by the first request that
     * needs the answer, which is `markdown-external-editor {action:"open"}` in `ws/desktop.ts`
     * and nothing else, and the answer is then cached for the daemon's lifetime (CONT-086/087,
     * #115). `options.editor` is the seam a test uses to make even that impossible.
     */
    const editorResolver =
        options.editor ??
        createEditorResolver({
            onLog: (message) => log(message)
        });

    /**
     * APP-054 / AGNT-006 "Restart Socket Server": close and re-bind the control listeners.
     *
     * Both listeners are rebuilt with the same dispatcher (a `const` here, the singleton
     * `onMessage` there), so a command that arrives a millisecond after the rebind reaches the
     * same handlers. `stop()` unlinks the socket file this daemon bound, which is what clears a
     * wedged `/tmp/nex.sock` and every client FD hanging off it; `start()`'s stale-socket probe
     * then finds nothing and binds cleanly.
     */
    /**
     * The CLI-compat listener is best-effort: on a machine where another Kelpi (the Swift app)
     * owns `/tmp/nex.sock`, refusing to boot would take every pane, hook and client down with
     * it — the one outcome worse than a missing convenience socket. The daemon stays fully
     * alive on its run-dir socket + pane-route TCP; the failure is remembered for `ping`,
     * logged loudly, and retried on every "Restart Socket Server". A configured `tcp-port`
     * is salvaged with a standalone TCP bind so dev-container clients keep working too.
     */
    const startCompat = async (server: ControlServer): Promise<void> => {
        try {
            await server.start();
            compatDegraded = null;
        } catch (error) {
            compatDegraded = toError(error).message;
            report(toError(error), 'compat-control');
            log(
                error instanceof ControlSocketBusyError
                    ? `${toError(error).message}; CLI-compat socket disabled — panes reach this daemon via their injected NEX_SOCKET`
                    : `CLI-compat socket ${server.socketPath} failed to bind: ${toError(error).message}`
            );
            // `start()` threw before `bindTcp` ran, so a configured `tcp-port` never bound
            // (`tcpStatus.bound` is null, not the status itself — the request is remembered).
            if (endpoints.tcpPort !== undefined && server.tcpPort === undefined) {
                try {
                    await server.startTCP(endpoints.tcpPort);
                } catch (tcpError) {
                    report(toError(tcpError), 'compat-tcp');
                }
            }
        }
    };

    /**
     * Ask for the pane-route port the previous daemon used, then record whichever port this one
     * holds. Shells can outlive a daemon (the terminal host, `docs/terminal-host.md` §10) and
     * their `KELPI_SOCKET` names that port. Only the ephemeral route is re-pinned: a configured
     * `tcp-port` is already stable.
     */
    const pinPaneRoute = async (control: ControlServer): Promise<void> => {
        const ephemeral = !(runOwnsCompatPath && endpoints.tcpPort !== undefined);
        const saved = readRoutePortFile(paths);
        if (ephemeral && saved !== undefined && control.tcpPort !== saved) {
            pinnedRoutePort = saved;
            const pinned = await control.startTCP(saved);
            if (pinned !== null && pinned.bound === null) {
                pinnedRoutePort = undefined;
                await control.startTCP(0);
                log(
                    `pane-route tcp port ${String(saved)} is taken; now on ${String(control.tcpPort)} ` +
                        '(panes that outlived the last daemon keep the old KELPI_SOCKET until respawned)'
                );
            }
        }
        if (control.tcpPort !== undefined) writeRoutePortFile(paths, control.tcpPort);
    };

    const restartControlServers = async (): Promise<{ socketPath: string; tcpPort?: number | undefined }> => {
        if (runControl === undefined) throw new Error('the control server is not running');
        const previousCompat = compatControl;
        const previousRoutePort = runControl.tcpPort;
        await runControl.stop();
        await previousCompat?.stop();
        await runControl.start();
        // Keep the pane-route port stable across the rebind: every live pane's injected
        // NEX_SOCKET names the OLD port and those environments cannot be updated. Best-effort;
        // if something grabbed the port in the window, the fresh ephemeral stands (logged).
        if (previousRoutePort !== undefined && runControl.tcpPort !== previousRoutePort) {
            const repinned = await runControl.startTCP(previousRoutePort);
            if (repinned !== null && repinned.bound === null) {
                await runControl.startTCP(0);
                log(
                    `pane-route tcp port ${String(previousRoutePort)} was taken during the rebind; ` +
                        `now on ${String(runControl.tcpPort)} — existing panes keep their old KELPI_SOCKET until respawned`
                );
            }
        }
        if (runControl.tcpPort !== undefined) writeRoutePortFile(paths, runControl.tcpPort);
        if (previousCompat !== undefined) await startCompat(previousCompat);
        log(`control server rebound on ${runControl.socketPath}`);
        const port = previousCompat?.tcpPort ?? runControl.tcpPort;
        return {
            socketPath: runControl.socketPath,
            ...(port === undefined ? {} : { tcpPort: port })
        };
    };
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
        // CONT-091: a markdown pane whose external editor exited is still open — the reducer
        // flipped it back to preview rather than closing it — so its terminal state has to be
        // released here or the next `$EDITOR` session would replay the last one's screen.
        const workspace = workspaceContainingVisiblePane(store.getState(), paneID);
        const pane = workspace === null ? null : visiblePane(workspace, paneID);
        if (pane !== null && pane.type !== 'shell') term.dispose(paneID);
    });

    // Every spawn path (boot restore, `pane-split`, `pane create`, the external editor) asks
    // the geometry cache first and only falls back to the fixed grid for a pane nothing has
    // ever rendered — and for exactly those panes it offers the spawn to the gate instead, so
    // the fallback grid is a timeout's worth of patience away rather than the first thing the
    // shell sees.
    // The bundled-CLI dir: an explicit option wins (tests), then the shell's env handoff.
    const envHelpersDir = env[HELPERS_DIR_ENV]?.trim();
    const helpersDir =
        options.spawn?.helpersDir ??
        (envHelpersDir !== undefined && envHelpersDir.length > 0 ? envHelpersDir : undefined);
    const spawnDefaults: PaneSpawnDefaults = {
        ...(options.spawn ?? {}),
        ...(helpersDir !== undefined ? { helpersDir } : {}),
        // Read at env-build time (not captured): the route exists only once the run-dir
        // control server has bound its TCP listener, and it must survive a live re-bind.
        controlRoute: options.spawn?.controlRoute ?? paneRouteValue,
        sizeFor: (paneID: string) => geometry.sizeFor(paneID),
        deferSpawn: (paneID, spawn) => {
            // `get`, not `sizeFor`: the fallback-to-latest read is a good GUESS for a brand-new
            // pane and a bad reason to skip waiting for the truth. A split's child is the case
            // that makes the difference — `latest` is its parent's full width, i.e. about twice
            // what the child will actually be rendered at.
            if (geometry.get(paneID) !== null) return false;
            return spawnGate.defer(paneID, (size) => {
                spawn(size);
            });
        },
        flushSpawn: (paneID) => {
            spawnGate.flush(paneID);
        }
    };
    const ctx: PaneHandlerContext = {
        prepareDocumentClose: paneIDs => content.prepareClose(paneIDs),
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
        httpEndpoint: () => ws?.addresses[0],
        // §SET-021: `ping` reports this too — a `tcp-port` that never bound is otherwise a log
        // line nobody reads, and every `NEX_SOCKET=tcp:…` client just times out. `compat` and
        // `paneRoute` ride along so a doctor can see where events actually route.
        controlTransport: () => ({
            tcp: controlTcpStatus(),
            compat:
                compatDegraded !== null
                    ? { path: endpoints.socketPath, error: compatDegraded }
                    : null,
            paneRoute: paneRouteValue()
        }),
        profiles: readProfiles,
        // §SET-209: the undefined-profile warning `WorkspaceProfilesClient.resolveEnv` logs.
        // It lands in the daemon log, where every other spawn-path diagnostic goes.
        onLog: (message) => log(message),
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
    /**
     * §GIT-091's producer: `git rev-parse --abbrev-ref HEAD` behind every path that moves a
     * pane's working directory (OSC 7, split inheritance, markdown/diff open, boot restore).
     * Declared before `repoWatch` only so the HEAD-change hook below can name it.
     */
    const branchWatch = createPaneBranchWatch({
        store,
        git,
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(onError !== undefined ? { onError } : {})
    });

    const repoWatch = createRepoAssociationWatch({
        store,
        git,
        graft,
        persist,
        // A checkout in one pane moves the branch chip in every pane inside that worktree.
        onWorktreeChanged: (worktreePath) => {
            branchWatch.repoChanged(worktreePath);
        },
        ...(onError !== undefined ? { onError } : {})
    });

    /**
     * The workspace inspector's repo verbs (`ws/repos.ts`). It reads dirtiness through the SAME
     * watcher the sidebar badge uses — one cache, one poll — so opening the inspector cannot
     * disagree with what the rest of the window already shows.
     */
    const repoCommands: RepoChannel = {
        store,
        git,
        // A getter for the same reason the app handlers use one: the template is a live user
        // setting, and the inspector's worktree verbs must not run on a boot-time copy of it.
        get worktreeBasePath(): string {
            return settings.snapshot.general.worktreeBasePath;
        },
        uuid: options.uuid ?? newUUID,
        now: options.now ?? Date.now,
        status: repoWatch,
        persist
    };

    /**
     * Repo auto-detect (graft-git.md §GIT-074…§GIT-081). Gated on the config file's
     * `auto-detect-repos`, read through the settings service so a Settings toggle takes effect
     * on the next pwd report without re-wiring anything. It watches the store (started below,
     * beside `repoWatch`), so a pane created inside a checkout links and a closed pane unlinks
     * without an OSC 7 report (issue #48, graft-git.md §8.9 / app-state-core.md §7.7).
     */
    const autoDetect = createRepoAutoDetect({
        store,
        git,
        enabled: () => settings.snapshot.general.autoDetectRepos,
        uuid: options.uuid ?? newUUID,
        persist,
        // app-state-core.md §7.8 / terminal-surface.md §7.2 (issue #48): a pwd landing inside
        // an association's worktree re-reads that row now, the same read a HEAD change makes.
        refreshAssociation: (associationID) => {
            void repoWatch.refresh(associationID).catch((error: unknown) => {
                report(error, `git status refresh ${associationID}`);
            });
        },
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(onError !== undefined ? { onError } : {})
    });

    /**
     * One OSC 7 report: the pane's working directory moves (which is what `pane list`'s CWD
     * column, the footer and `--prune-worktree` read), and auto-detect sees the move through
     * its store subscription. The store is the single writer, so a client sees the change as
     * the same delta a spawn does.
     */
    onPaneDirectory = (paneID, directory) => {
        const state = store.getState();
        const workspace = state.workspaces.find(
            (candidate) =>
                candidate.panes.some((pane) => pane.id === paneID) ||
                candidate.parkedPanes.some((pane) => pane.id === paneID)
        );
        if (workspace === undefined) return;
        const pane =
            workspace.panes.find((entry) => entry.id === paneID) ??
            workspace.parkedPanes.find((entry) => entry.id === paneID);
        if (pane === undefined || pane.workingDirectory === directory) return;
        store.dispatch({
            type: 'pane-directory-changed',
            paneID,
            directory,
            now: (options.now ?? Date.now)()
        });
    };

    /**
     * One OSC 0 / OSC 2 report (§TERM-147): the pane's `title` moves and `lastActivityAt` with
     * it, so a shell with no OSC 7 integration — but with the title escape every stock
     * `PROMPT_COMMAND` / `precmd` writes — still advances activity.
     *
     * Same shape as the directory writer above, and the same two guards: a pane the store does
     * not know is ignored, and a repeat of the current title is dropped BEFORE the dispatch (an
     * app that re-asserts its title every redraw must not turn into a delta per frame).
     */
    onPaneTitle = (paneID, title) => {
        const state = store.getState();
        const workspace = state.workspaces.find(
            (candidate) =>
                candidate.panes.some((pane) => pane.id === paneID) ||
                candidate.parkedPanes.some((pane) => pane.id === paneID)
        );
        if (workspace === undefined) return;
        const pane =
            workspace.panes.find((entry) => entry.id === paneID) ??
            workspace.parkedPanes.find((entry) => entry.id === paneID);
        if (pane === undefined) return;
        // An empty title is a real report (`OSC 2 ; BEL` clears it), and the store stores null
        // for "no title" — so it normalizes here rather than in the reducer.
        const next = title.length === 0 ? null : title;
        if (pane.title === next) return;
        store.dispatch({
            type: 'pane-title-changed',
            paneID,
            title: next,
            now: (options.now ?? Date.now)()
        });
    };

    /**
     * §TERM-050's delivery, bound to real client presence. The rule itself lives in
     * `handlers/app/osc-notifications.ts`, beside the agent-event path it mirrors, so it can be
     * exercised without standing a daemon up.
     */
    onPaneOscNotification = createOscNotificationSink({
        getState: () => store.getState(),
        isPaneFocused: (paneID, workspaceID) => ws?.isPaneAttended(workspaceID, paneID) ?? false,
        isAppActive: () => ws?.presence().anyVisible ?? false,
        broadcast: (message) => {
            ws?.broadcast(message);
        }
    });

    /**
     * §TERM-046's delivery. The rule lives in `handlers/app/clipboard.ts`; what boot supplies is
     * the LIVE gate read — `settings.snapshot` is re-read per sequence, so flipping the toggle in
     * Settings (or hand-editing the config) governs the very next OSC 52 with no restart, the
     * same live-apply shape `auto-detect-repos` uses above.
     */
    onPaneClipboardRequest = createClipboardWriteSink({
        getState: () => store.getState(),
        enabled: () => settings.snapshot.general.clipboardWrite,
        broadcast: (message) => {
            ws?.broadcast(message);
        },
        log: (message) => log(message)
    });

    /**
     * The interrupted-graft set behind the inspector's banner (§GIT-051 / §WS-145). Boot fills
     * it; recover/dismiss mutate it; every change re-broadcasts, so a second window's banner
     * disappears when the first window restores.
     */
    const graftOrphanRegistry = createGraftOrphanRegistry(graft);
    const offOrphans = graftOrphanRegistry.onChange((orphans) => {
        ws?.broadcast(graftOrphansEvent(orphans));
    });
    const graftCommands: GraftChannel = { store, graft, orphans: graftOrphanRegistry };

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
        // SET-008 / SET-013: read through the settings service on every command, so changing
        // the worktree base path or the placement picker in Settings takes effect on the next
        // `workspace create` without rebuilding the handler table (`resolveAppDeps` turns
        // these into getters).
        worktreeBasePath: () => settings.snapshot.general.worktreeBasePath,
        placement: () => settings.snapshot.general.newWorkspacePlacement,
        // SET-012, read the same way and for the same reason: the sidebar's drop IS a
        // `workspace-move`, so the toggle has to be consulted per command rather than captured
        // at boot — flipping it in Settings changes the very next drop.
        expandGroupOnDrop: () => settings.snapshot.general.expandGroupOnWorkspaceDrop,
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(options.uuid !== undefined ? { uuid: options.uuid } : {}),
        ...(options.random !== undefined ? { random: options.random } : {})
    });

    const plugins = new PluginService({
        store, pty, term, content, webPanes,
        applicationSettings: () => pluginObject(settings.snapshot),
        cliEnvironment: () => ({
            KELPI_SOCKET: paneRouteValue() ?? '',
            KELPID_RUN_DIR: paths.dir,
            ...(helpersDir ? { PATH: `${helpersDir}:${env['PATH'] ?? process.env['PATH'] ?? ''}` } : {})
        }),
        ...(dbPath === ':memory:' ? {} : { directory: `${dbPath}.plugins` }),
        command: (payload, context, signal) => {
            if (!ws) return Promise.reject(new Error('daemon services are starting'));
            return ws.sync.executeCommand(payload, context, signal);
        },
        broadcast: event => ws?.broadcast(event),
        onError: error => report(error, 'plugins')
    });
    plugins.registerBuiltinService(pluginGit.service);
    plugins.registerBuiltinService(createContentRenderService());
    pluginHost = plugins;
    const offPluginServices = plugins.onServicesChanged(changed => {
        if (changed.includes('kelpi.content.render@1')) content.invalidateRenderer();
        if (changed.includes('kelpi.git@1')) {
            autoDetect.invalidate();
            content.invalidateGit();
            repoWatch.invalidate();
            branchWatch.invalidate();
        }
    });
    const dispatcher = createDispatcher<PaneHandlerContext>({
        ctx,
        operations: plugins,
        tables: [paneHandlers, appHandlers, new Map([['plugin', (msg, _ctx, reply) => {
            if (msg.command === 'plugin' && reply) plugins.run(msg.action, pluginObject(JSON.parse(msg.text)), reply);
        }]])],
        ...(onError !== undefined ? { onError } : {})
    });

    // ── boot steps 3–5 ──────────────────────────────────────────────────────

    /**
     * §12.2: a fresh install (or an unreadable DB) comes up with one "Default" workspace.
     *
     * The colour is resolved HERE, not left to the reducer: `create-workspace` carries its colour
     * on the action and the reducer's `?? 'blue'` is only a fallback, so omitting it made every
     * fresh install blue. §12.2 gives "Default" the full 4.1 create semantics, whose step 3 is
     * `nextRandomColor()` (docs/app-state-core.md §4.1; docs/persistence.md §6.2 Case A), the
     * same pick the socket/GUI path makes (`handlers/app/workspaces.ts`). Issue #56.
     */
    const ensureDefaultWorkspace = (): void => {
        const state = store.getState();
        if (state.workspaces.length > 0) return;
        const mint = options.uuid ?? newUUID;
        store.dispatch({
            type: 'create-workspace',
            id: mint(),
            paneID: mint(),
            name: DEFAULT_WORKSPACE_NAME,
            now: (options.now ?? Date.now)(),
            color: nextRandomColor(state, options.random ?? Math.random)
        });
    };

    let settleRestore: (outcome: ResumeOutcome) => void = () => {};
    const restored = new Promise<ResumeOutcome>((resolve) => {
        settleRestore = resolve;
    });

    /** What the boot restore (and a respawn after a lost terminal host) spawns panes with. */
    const restoreDeps = (): RestoreDeps => ({
        pty,
        term,
        profiles: config.profiles,
        spawn: spawnDefaults,
        // Same builder the pane-* handlers use; a pane about to resume a session that
        // recorded its launch profile spawns with that profile's env.
        envFor: (paneID, workspace, sessionProfileName) => spawnEnvVars(ctx, paneID, workspace, sessionProfileName),
        ...(onError !== undefined ? { onError } : {})
    });
    const resumeDeps = (): ResumeDeps => ({
        pty,
        term,
        input,
        profiles: config.profiles,
        ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
        ...(options.settleMs !== undefined ? { settleMs: options.settleMs } : {}),
        ...(onError !== undefined ? { onError } : {})
    });

    // ── the terminal host (docs/terminal-host.md) ────────────────────────────────

    /**
     * The run-dir control socket's gate (§6, §7). While a daemon with a host adopts its terminals
     * at boot, commands and hook events queue, so a hook from a surviving agent lands after its
     * pane's state is back instead of being overwritten by it. During a handoff the socket stays
     * bound (it is what keeps a would-be successor out until the state is flushed) but refuses
     * commands.
     */
    let controlGate: 'queue' | 'open' | 'refuse' = 'open';
    const queuedControl: (readonly ControlDispatchItem[])[] = [];
    const refuseControl = (reply: ReplyHandle | null): void => {
        if (reply === null || reply.closed) return;
        reply.send({ ok: false, error: 'kelpid is handing its terminals to its successor; retry in a moment' });
        reply.close();
    };
    const dispatchItems = (items: readonly ControlDispatchItem[]): void => {
        if (dispatcher.dispatchBatch !== undefined) dispatcher.dispatchBatch(items);
        else for (const item of items) dispatcher(item.message, item.reply);
    };
    const gatedDispatcher: ControlDispatcher = Object.assign(
        (message: WireMessage, reply: ReplyHandle | null): void => {
            if (controlGate === 'open') dispatcher(message, reply);
            else if (controlGate === 'queue') queuedControl.push([{ message, reply }]);
            else refuseControl(reply);
        },
        {
            dispatchBatch: (items: readonly ControlDispatchItem[]): void => {
                if (controlGate === 'open') dispatchItems(items);
                else if (controlGate === 'queue') queuedControl.push(items);
                else for (const item of items) refuseControl(item.reply);
            }
        }
    );
    const openControl = (): void => {
        if (controlGate !== 'queue') return;
        controlGate = 'open';
        for (const items of queuedControl.splice(0)) dispatchItems(items);
    };

    const hostPaths = resolveHostPaths(paths.dir);
    let hostClient: TerminalHostClient | undefined;

    /**
     * End hosts this daemon must not share its panes with: one of another host protocol (it
     * cannot be attached, and its shells would run beside the respawned ones, §11), or, for an
     * in-process daemon, any host at all. SIGTERM makes a host hang up its terminals first.
     */
    const endStrayHosts = async (): Promise<void> => {
        let names: string[];
        try {
            names = readdirSync(paths.dir);
        } catch {
            return;
        }
        for (const name of names) {
            const match = /^host-v(\d+)\.pid$/.exec(name);
            if (match === null) continue;
            const protocol = Number(match[1]);
            if (hostSlot !== undefined && protocol === HOST_PROTOCOL_VERSION) continue;
            // Only a host really listening on its socket: a stale record's pid may be anyone's.
            const pid = await verifiedHostPid(resolveHostPaths(paths.dir, protocol));
            if (pid === undefined) continue;
            log(`ending terminal host v${String(protocol)} (pid ${String(pid)}): this daemon cannot adopt its terminals`);
            await endHost(pid);
        }
    };

    /** Attach to the host, launching it if needed. Falls back to in-process PTYs on failure. */
    const connectHost = async (): Promise<TerminalHostClient | undefined> => {
        const launch = options.terminalHost;
        if (hostSlot === undefined || launch === undefined) return undefined;
        try {
            const runtime = prepareHostRuntime({
                daemonDir: launch.daemonDir,
                dataRoot: join(dbPath === ':memory:' ? paths.dir : dirname(dbPath), 'terminal-host'),
                inUse: readHostPidRecord(hostPaths)?.runtimeDir
            });
            const { client, launched } = await ensureTerminalHost({
                runDir: paths.dir,
                entry: runtime.entry,
                ...(launch.execPath !== undefined ? { execPath: launch.execPath } : {}),
                logFile: launch.logFile ?? join(paths.dir, 'terminal-host.log'),
                onSpawnProblem: (key, message) => report(new Error(message), `pty ${key}`)
            });
            hostClient = client;
            client.onLost((_tids, reason) => {
                void onHostLost(client, reason);
            });
            log(
                `terminal host ${launched ? 'launched' : 'adopted'}: pid ${String(client.welcome.pid)}, ` +
                    `${String(client.welcome.terminals.length)} terminal(s) waiting`
            );
            return client;
        } catch (error) {
            report(error, 'terminal host');
            log('WARNING: no terminal host; terminals run in-process and will not survive a daemon restart');
            hostSlot.useLocal(nodePtySpawner);
            return undefined;
        }
    };

    /** Bind a host whose terminals this daemon will not adopt (a relaunch after a loss). */
    const bindHost = (client: TerminalHostClient): void => {
        for (const terminal of client.welcome.terminals) client.forget(terminal.tid);
        hostSlot?.bind(client);
    };

    /** Panes whose shells the host kept across the restart: no spawn, no typed resume (§7). */
    const adopted = new Set<string>();

    /**
     * Reattach every restored shell pane to the terminal it left on the host (§7): newest live
     * terminal per pane wins; exited ones, duplicates and terminals with no pane are ended. Each
     * adopted pane gets its saved screen back, then the output produced since, exactly once.
     * Without a clean checkpoint (the last daemon crashed) it gets the host's retained tail and
     * a repaint nudge instead.
     */
    const adoptTerminals = async (client: TerminalHostClient): Promise<void> => {
        const shellPanes = new Set<string>();
        for (const workspace of store.getState().workspaces) {
            for (const pane of workspace.panes) if (pane.type === 'shell') shellPanes.add(pane.id);
        }
        const chosen = new Map<string, TerminalInfo>();
        const exitedKeys = new Set<string>();
        for (const terminal of client.welcome.terminals) {
            if (terminal.exited !== null || !shellPanes.has(terminal.key)) {
                if (terminal.exited !== null && shellPanes.has(terminal.key)) exitedKeys.add(terminal.key);
                client.forget(terminal.tid);
                continue;
            }
            const previous = chosen.get(terminal.key);
            if (previous !== undefined) client.forget(previous.tid);
            chosen.set(terminal.key, terminal);
        }
        // A shell that exited during the handoff (after `hold`) closes its pane, as it would
        // have if the daemon had seen it: respawning it would resurrect what the user ended.
        for (const paneID of exitedKeys) {
            if (!chosen.has(paneID)) store.dispatch({ type: 'pane-process-terminated', paneID });
        }
        // One at a time: a crash's replays are up to a few MiB each.
        for (const [paneID, terminal] of chosen) {
            if (pty.has(paneID)) {
                // Something already gave this pane a PTY; its old terminal has no place to go.
                client.forget(terminal.tid);
                continue;
            }
            try {
                term.attach(paneID, terminal.cols, terminal.rows);
                const { handle, attached, blob } = await client.attach(terminal.tid, paneID);
                if (!paneExists(paneID)) {
                    client.forget(terminal.tid);
                    term.dispose(paneID);
                    continue;
                }
                const saved = attached.gap ? null : decodeHandoffBlob(blob);
                if (saved !== null) {
                    term.restore(paneID, saved);
                    if (saved.title !== null) {
                        store.dispatch({ type: 'pane-title-changed', paneID, title: saved.title, now: (options.now ?? Date.now)() });
                    }
                }
                // Replayed bytes: never answer a query in them, and when there was no clean
                // checkpoint they may repeat what the last daemon already acted on.
                term.markReplay(paneID, attached.until - attached.from, saved === null);
                pty.adopt(paneID, handle);
                adopted.add(paneID);
                const before = loaded.agentBefore.get(paneID);
                if (before !== undefined) store.dispatch({ type: 'pane-agent-state-restored', paneID, agent: before });
                if (saved === null) nudgeRepaint(paneID, attached.cols, attached.rows);
            } catch (error) {
                report(error, `terminal host: adopt ${paneID}`);
                client.forget(terminal.tid);
            }
        }
        if (adopted.size > 0) log(`adopted ${String(adopted.size)} running terminal(s) from the terminal host`);
    };

    /**
     * Make a full-screen program repaint after a crash's best-effort replay: bounce the PTY's
     * window size by one column and back. Only the kernel winsize moves (the host resizes the
     * PTY); the daemon's emulator is left alone, since shrinking it would trim scrollback.
     */
    const nudgeRepaint = (paneID: string, cols: number, rows: number): void => {
        rawPty.resize(paneID, cols > 2 ? cols - 1 : cols + 1, rows);
        setTimeout(() => rawPty.resize(paneID, cols, rows), 150).unref();
    };

    /**
     * The host went away while this daemon runs (§8.2). Its shells went with it, so each
     * affected pane is respawned and resumed, exactly as a daemon restart does today, instead
     * of being closed by a flood of exits.
     */
    const onHostLost = async (lost: TerminalHostClient, reason: LostReason): Promise<void> => {
        if (lost !== hostClient) return;
        hostClient = undefined;
        if (stopping) return;
        hostSlot?.unbind();
        if (reason === 'superseded') {
            log('WARNING: another daemon took over this run dir\'s terminal host; new terminals run in-process');
            hostSlot?.useLocal(nodePtySpawner);
            return;
        }
        // Only the panes whose terminals lived on the lost connection. A spawn still queued in
        // the slot (a pane created a moment ago) binds to the next host by itself.
        const affected = rawPty.paneIDs().filter((paneID) => {
            const handle = hostHandleOf(rawPty.processHandle(paneID));
            return handle !== undefined && lost.handle(handle.tid) === handle;
        });
        for (const paneID of affected) {
            pty.forget(paneID);
            term.dispose(paneID);
            // A pane hosting a command (a markdown pane in `$EDITOR`) is not respawned: its
            // process is gone, so it takes the ordinary exit path back to its preview.
            if (paneType(paneID) !== 'shell') store.dispatch({ type: 'pane-process-terminated', paneID });
        }
        // A host that is alive but dropped us cannot be trusted with the respawned panes.
        const stale = await verifiedHostPid(hostPaths);
        if (stale !== undefined) await endHost(stale, 2000);
        log(
            `WARNING: the terminal host went away and took ${String(affected.length)} shell(s) with it; ` +
                'relaunching it and respawning those panes'
        );
        const next = await connectHost();
        if (next !== undefined) bindHost(next);
        if (stopping) return;
        const state = store.getState();
        const tuples: ResumeTuple[] = [];
        for (const workspace of state.workspaces) {
            for (const pane of workspace.panes) {
                if (!affected.includes(pane.id)) continue;
                const tuple = captureResumeTuple(pane.id, pane);
                if (tuple !== null) tuples.push(tuple);
            }
        }
        spawnRestoredPanes(state, restoreDeps(), tuples);
        void typeResumeCommands(tuples, resumeDeps()).catch((error: unknown) => report(error, 'resume after host loss'));
    };

    /** The resume tuples for panes that get a fresh shell (every pane not adopted, §7). */
    const resumableTuples = (): readonly ResumeTuple[] => loaded.tuples.filter((tuple) => !adopted.has(tuple.paneID));

    const runRestore = (spawned: readonly string[]): void => {
        void (async () => {
            let resumed: readonly string[] = [];
            let skipped: readonly string[] = [];
            let settled = false;
            try {
                // Never into an adopted pane: its agent is still running, and typing
                // `claude --resume` there would land in the live session.
                const outcome = await typeResumeCommands(resumableTuples(), resumeDeps());
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

    /** Editor buffers flush FIRST, while `persist()` is still live (content-panes.md §4.2). */
    const flushEditors = (): void => {
        // A markdown pane's pending write goes to disk, and a scratchpad's goes into the store,
        // where it must land before the persist gate closes, or the debounced snapshot below
        // would not contain it.
        try {
            content.flushSync();
        } catch (error) {
            report(error, 'content flush');
        }
    };

    /** Detach from the store and the PTYs, and dispose every service a stop does not wait on. */
    const disposeServices = (): void => {
        removeSignalHandlers();
        // Nobody may be left awaiting a restore that will now never finish (resolving an
        // already-settled promise is a no-op, so a completed restore keeps its outcome).
        settleRestore({ spawned: [], resumed: [], skipped: [], settled: false });
        unsubscribe();
        offData();
        offExit();
        offSettings();
        devicesWatcher?.close();
        devicesWatcher = undefined;
        if (statsGateTimer !== null) clearInterval(statsGateTimer);
        statsGateTimer = null;
        offStats();
        stats.dispose();
        offPluginServices();
        settings.dispose();
        content.dispose();
        // Releases the host slot (the shell sees `host-revoked`) and ends every console
        // follow stream; nothing here can block the shutdown.
        webPanes.close();
        repoWatch.dispose();
        branchWatch.dispose();
        // Stop background Git discovery before the provider-backed graft unwind.
        autoDetect.stop();
    };

    /**
     * §5 quit flush: unwind every graft session (2 s cap) so a clean quit never leaves a
     * `kelpi-graft-active` breadcrumb behind; anything slower falls back to the orphan-recovery
     * banner on the next launch. A handoff unwinds too (`docs/terminal-host.md` §6): leaving the
     * breadcrumb would greet every update with that banner.
     */
    const disposeGraftAndPlugins = async (): Promise<void> => {
        try {
            await graft.shutdown();
        } catch (error) {
            report(error, 'graft shutdown');
        }
        // A selected Git provider must remain alive for the session's restoration verbs.
        // Closing it first would switch a live graft to bundled Git during its unwind.
        await plugins.dispose();
        offGraft();
        offOrphans();
    };

    /**
     * SIGTERM contract: write the debounced snapshot before anything else changes. A shutdown
     * DURING the restore window deliberately writes nothing: the DB must keep the session ids
     * the resume never got to use (§6.1 step 5).
     */
    const flushState = (): void => {
        // The result matters: `kelpid stop` used to print a clean stop over a database that
        // had never been written. A failed final flush is the LAST chance to say so.
        const flushed = persistence.flush();
        // Only meaningful for a daemon that actually served: a `start()` that REFUSED
        // (`ENEXDPERSIST`) tears down through here too, and "everything is lost" would be a
        // lie about a session that never existed.
        const served = info !== undefined;
        if (!flushed && served) {
            const health = persistence.health();
            log(
                `ERROR: kelpid shut down WITHOUT saving state — ${health.path}: ${health.error ?? 'the database was never opened'}. Everything created in this session is lost.`
            );
        }
    };

    const stopListeners = async (): Promise<void> => {
        await Promise.all([
            runControl?.stop() ?? Promise.resolve(),
            compatControl?.stop() ?? Promise.resolve(),
            ws?.stop() ?? Promise.resolve()
        ]);
    };

    const closeState = (message: string): void => {
        // The last-known pane grids are what the next boot spawns at, so they have to survive
        // this one (`pty/geometry.ts`); the write is debounced and may be pending.
        geometry.close();
        persistence.close();
        // The token and the port file stay: both are stable across restarts by design. The pid
        // record goes only if it is still ours: a successor may already have written its own.
        clearRunFiles(paths, { ownerPid: process.pid });
        const served = info !== undefined;
        log(served && persistence.health().degraded ? `${message} (state NOT saved)` : message);
    };

    const stop = async (): Promise<void> => {
        if (stopped !== undefined) return stopped;
        flushEditors();
        stopping = true;
        running = false;
        stopped = (async () => {
            disposeServices();
            await disposeGraftAndPlugins();
            flushState();
            // A spawn still waiting for a client's geometry must not start a shell into a
            // daemon that is shutting down — `killAll` would have nothing to kill (the child
            // would be born a moment later) and the pane would outlive the process.
            spawnGate.close();
            await pty.killAll();
            // A full stop ends the host too; its terminals were just killed.
            const host = hostClient;
            hostClient = undefined;
            if (host !== undefined && !host.isClosed) {
                try {
                    await host.shutdown();
                } catch (error) {
                    report(error, 'terminal host shutdown');
                }
            }
            hostSlot?.failPending();
            await stopListeners();
            closeState('kelpid stopped');
        })();
        return stopped;
    };

    /**
     * Hand every terminal to the next daemon and stop without killing them
     * (`docs/terminal-host.md` §6). With no host to hand them to, this is a full stop.
     *
     * The order is what keeps a pane from coming back wrong:
     *  1. a daemon still restoring finishes first (bounded): panes it has not saved would be
     *     killed as orphans by the next daemon, and resumes it has not typed would be lost;
     *  2. the listeners close, so no command, hook event or client arrives mid-handoff;
     *  3. `hold`: until the host confirms, output is still fed and exits still close their
     *     panes (and are saved), so a shell that exits now is not resurrected by the successor;
     *  4. only then does the daemon stop listening to the PTYs, checkpoint each terminal at the
     *     offset its emulator has parsed (stepped back over an unfinished sequence), and detach.
     */
    const handoff = async (): Promise<'handed-off' | 'stopped'> => {
        const host = hostClient;
        if (stopped !== undefined) {
            await stopped;
            return 'stopped';
        }
        if (host === undefined || host.isClosed || !running) {
            await stop();
            return 'stopped';
        }
        flushEditors();
        stopped = (async () => {
            await Promise.race([restored, new Promise((resolve) => setTimeout(resolve, HANDOFF_RESTORE_WAIT_MS))]);
            // The run-dir socket stays bound until the state is flushed, so no successor can
            // start (and load a database this daemon has not finished writing) mid-handoff; it
            // refuses commands meanwhile. The pane route closes now: a hook fired from a
            // surviving shell is refused and retried by the CLI until the successor answers on
            // the same port.
            controlGate = 'refuse';
            await runControl?.stopTCP();
            await Promise.all([compatControl?.stop() ?? Promise.resolve(), ws?.stop() ?? Promise.resolve()]);
            try {
                await host.hold();
            } catch (error) {
                report(error, 'terminal handoff: hold');
            }
            // Edits made while the restore finished or the hold was pending still get saved.
            flushEditors();
            stopping = true;
            running = false;
            disposeServices();
            spawnGate.close();
            let checkpointed = 0;
            for (const paneID of rawPty.paneIDs()) {
                const handle = hostHandleOf(rawPty.processHandle(paneID));
                if (handle === undefined || handle.exited) continue;
                try {
                    const checkpoint = await term.checkpointAsync(paneID);
                    if (checkpoint === null) continue;
                    const blob = encodeHandoffBlob({ ...checkpoint, title: paneTitle(paneID) });
                    host.checkpoint(handle.tid, Math.max(0, handle.received - checkpoint.tailBack), blob);
                    checkpointed += 1;
                } catch (error) {
                    report(error, `terminal handoff: checkpoint ${paneID}`);
                }
            }
            try {
                await host.detach();
            } catch (error) {
                report(error, 'terminal handoff: detach');
            }
            hostClient = undefined;
            await disposeGraftAndPlugins();
            flushState();
            // Only now does the run dir become free for a successor.
            await runControl?.stop();
            closeState(`kelpid handed ${String(checkpointed)} terminal(s) to the terminal host and stopped`);
        })();
        await stopped;
        return 'handed-off';
    };

    const findPane = (paneID: string): { readonly type: string } | undefined => {
        for (const workspace of store.getState().workspaces) {
            const pane = workspace.panes.find((candidate) => candidate.id === paneID);
            if (pane !== undefined) return pane;
        }
        return undefined;
    };
    const paneExists = (paneID: string): boolean => findPane(paneID) !== undefined;
    const paneType = (paneID: string): string | undefined => findPane(paneID)?.type;

    /** The title a pane shows now; the store does not persist it, so the handoff carries it. */
    const paneTitle = (paneID: string): string | null => {
        for (const workspace of store.getState().workspaces) {
            const pane = workspace.panes.find((candidate) => candidate.id === paneID);
            if (pane !== undefined) return pane.title ?? null;
        }
        return null;
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
                    // code is the only thing a supervisor (or a `kelpid start --foreground` in a
                    // terminal) ever reads.
                    () => process.exit(persistence.health().degraded ? 1 : 0),
                    () => process.exit(1)
                );
            };
            signalHandlers.set(signal, handler);
            process.on(signal, handler);
        }
        // SIGUSR2: hand the terminals to the host and exit (`docs/terminal-host.md` §10). Whoever
        // sent it starts the successor, unless `onHandedOff` does.
        const onHandoff = (): void => {
            // A second SIGUSR2 (a restart asked for twice) must not cut the first handoff short.
            if (stopped !== undefined) return;
            void handoff().then(
                (outcome) => {
                    try {
                        options.onHandedOff?.(outcome);
                    } catch (error) {
                        report(error, 'after handoff');
                    }
                    process.exit(persistence.health().degraded ? 1 : 0);
                },
                () => process.exit(1)
            );
        };
        signalHandlers.set('SIGUSR2', onHandoff);
        process.on('SIGUSR2', onHandoff);
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
                // Paired remote devices (`kelpid pair`): their tokens pass the same hello
                // gate as the run-dir token. The validator re-reads `devices.json` on
                // change, so pair/revoke apply on the next hello with no daemon involvement.
                validateDeviceToken: createDeviceValidator(resolveDevicesPath(env)),
                daemonInfo: { pid: process.pid },
                plugins,
                content,
                webPanes,
                settings,
                // §SET-021: `welcome.transport` — Settings ▸ Network shows what the listener
                // actually did, not what the config file hoped for. A getter, because
                // `restart-control-server` can re-bind under an attached client.
                transport: wsTransportStatus,
                // The pane header's restart button: typing a resume command needs the same
                // TerminalInput (live VT modes, no sync mirroring) the CLI's `pane send` uses.
                agents: createAgentChannel({ store, pty, input }),
                // Settings ▸ Remote: the `kelpid pair`/`devices`/`url --tailnet` flow in-app
                // (`ws/remote.ts`). Owner-only at the sync layer; same registry + tailscale
                // modules as the CLI, so the two surfaces cannot drift. The port is the one the
                // listener BOUND (what the port file records), never `build`'s argument: that is
                // `0` on a first boot and on the bind-failure fallback, and a pairing built from
                // it configured `tailscale serve --bg 0`, a proxy to nothing (#130).
                remote: createRemoteChannel({ env, runDir: paths.dir,
                    port: () => ws?.port, host: () => ws?.addresses[0]?.host }),
                // ⇧⌘T reopen-closed-pane, ⇧⌘N scratchpad, and the context menu's Open in
                // Finder. All three need the pane handler context (a PTY to spawn into, a
                // `TerminalInput` for the reopened agent's resume command, the broadcast seam),
                // which is why they cannot be composed inside `createWsServer`.
                panes: createPaneLifecycleChannel({
                    ctx,
                    ...(onError !== undefined ? { onError } : {})
                }),
                // The workspace inspector's repo registry / association / worktree verbs.
                repos: repoCommands,
                // The ⌘O picker relay, ⌘-clicking a `.md` path in a terminal, hosting the
                // user's `$EDITOR` in a markdown pane, and the ••• menu's Restart Socket
                // Server. Needs the pane handler context AND the control listeners, so — like
                // `panes` — it can only be composed here.
                desktop: createDesktopChannel({
                    ctx,
                    editor: editorResolver,
                    restartControl: restartControlServers,
                    ...(onError !== undefined ? { onError } : {})
                }),
                // …and its graft toggle / swap prompt / orphan banner verbs.
                graftUi: graftCommands,
                // `/pane-assets/…` — sibling files of an open markdown file, so relative
                // `<img src>` resolves (content-panes.md port note 4). Gated by the derived
                // asset credential (owner or live paired device), because `--tailnet` makes
                // this HTTP surface tailnet-reachable and `devices revoke` must cover it.
                routes: app => {
                    pluginAssetsRoute(plugins)(app);
                    createPaneAssetsRoute(
                    (paneID, relativePath) => content.assetPath(paneID, relativePath),
                    { validateCredential: createAssetCredentialGate(resolveDevicesPath(env), token) }
                )(app);
                },
                // Remember what each pane is actually rendered at, so the next spawn of it
                // (a restart, the next daemon boot) starts there (`pty/geometry.ts`) — and, for
                // a pane whose first spawn is still being held, this IS the number it was
                // waiting for: the shell is born here, at the size the client just reported,
                // before the attach that carried it has even taken its snapshot.
                onGeometry: (paneID, cols, rows) => {
                    geometry.record(paneID, cols, rows);
                    spawnGate.report(paneID, cols, rows);
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
        // Nothing is attached yet (the WS server starts below), so the spawn gate's "is anyone
        // looking?" question has no useful answer here. This window is the expectation that a
        // window is on its way — see `DEFAULT_BOOT_DEFER_WINDOW_MS`.
        bootDeferUntil = (options.now ?? Date.now)() + (options.bootDeferWindowMs ?? DEFAULT_BOOT_DEFER_WINDOW_MS);

        // The run-dir control server binds BEFORE the restored panes spawn: their env is
        // built eagerly (`boot/resume.ts`), and the KELPI_SOCKET route it embeds is this
        // server's TCP port. That listener is always on — the configured `tcp-port` when this
        // path IS the compat path, an ephemeral loopback port otherwise — because `tcp:` is
        // the only KELPI_SOCKET form the kelpi CLI honors (anything else silently falls back to the
        // shared `/tmp/kelpi.sock`, which may belong to another Kelpi entirely). A busy RUN-DIR
        // socket stays fatal: that is the "a daemon of this protocol is already running" case
        // the discover-or-spawn flow depends on.
        // With a terminal host, commands queue until the terminals are adopted (`controlGate`).
        if (hostSlot !== undefined) controlGate = 'queue';
        runControl = createControlServer({
            socketPath: paths.socket,
            dispatcher: gatedDispatcher,
            tcpPort: runOwnsCompatPath && endpoints.tcpPort !== undefined ? endpoints.tcpPort : 0,
            ...(onError !== undefined ? { onError } : {})
        });
        await runControl.start();
        await pinPaneRoute(runControl);

        // Only now, owning the run dir, may this daemon attach to its terminal host: attaching
        // first would take the host from a live daemon. A spawn that races in before the bind
        // is queued by the slot, not lost (`host/slot.ts`).
        try {
            await endStrayHosts();
            const host = await connectHost();
            if (host !== undefined) {
                await adoptTerminals(host);
                // Unless it was lost (or superseded) meanwhile, which already moved the slot on.
                if (host === hostClient && !host.isClosed) hostSlot?.bind(host);
            }
        } finally {
            openControl();
        }

        const spawned = spawnRestoredPanes(store.getState(), restoreDeps(), resumableTuples());

        if (!runOwnsCompatPath) {
            compatControl = createControlServer({
                socketPath: endpoints.socketPath,
                dispatcher,
                ...(endpoints.tcpPort !== undefined ? { tcpPort: endpoints.tcpPort } : {}),
                ...(onError !== undefined ? { onError } : {})
            });
            // Best-effort by design: another Kelpi owning `/tmp/kelpi.sock` degrades this socket,
            // it does not take the daemon down (`startCompat`).
            await startCompat(compatControl);
        }

        try {
            ws = await startWs(token);
        } catch (error) {
            await runControl.stop();
            await compatControl?.stop();
            compatControl = undefined;
            runControl = undefined;
            throw error;
        }

        // Live cut on revoke. The hello validator already re-reads `devices.json`, but an OPEN
        // session never re-hellos — so every registry change re-checks every session's
        // credential and cuts the ones the validator no longer accepts. The config-file
        // watcher fits exactly: the registry is written write-then-rename (`devices.ts`),
        // which is the re-attach dance it was built for, and it tolerates the file not
        // existing yet (nobody paired).
        devicesWatcher = watchConfigFile({
            path: resolveDevicesPath(env),
            onChange: () => {
                const cut = ws?.sync.revalidateSessions() ?? 0;
                if (cut > 0) {
                    log(`devices: registry changed — cut ${String(cut)} revoked session${cut === 1 ? '' : 's'}`);
                }
            },
            onError: (error, context) => report(error, context)
        });

        const httpPort = ws.port ?? 0;
        writePortFile(paths, httpPort);
        writePidRecord(paths, {
            socket: paths.socket,
            http_port: httpPort,
            version: version.version,
            // SIGUSR2 is handled (a handoff, or a full stop without a host): safe to send.
            handoff: true
        });

        // HEAD watchers for every persisted association + the 30 s dirtiness poll (§9.2/§9.3).
        repoWatch.start();
        // §GIT-091: resolve a branch for every restored pane, then keep resolving as panes move.
        branchWatch.start();
        // Issue #48 (graft-git.md §8.9, app-state-core.md §7.7): auto-link every restored pane
        // sitting in a checkout, then link on creation / unlink on close as the pane set moves.
        autoDetect.start();
        // persistence.md §6.2 step 9 / app-state-core.md §6.5: the one-shot legacy-label →
        // preset back-fill, one launch only. Runs AFTER `ensureDefaultWorkspace` above, so the
        // fresh-install path reaches it too and sets the marker with nothing to migrate —
        // §13's requirement, without which a LATER launch would treat the user's own new
        // labels as legacy ones and resurrect presets they had deleted.
        try {
            const migration = runLabelPresetMigration(store);
            if (migration.backfilled.length > 0) {
                log(
                    `labels: back-filled ${String(migration.backfilled.length)} gray preset(s) (${migration.backfilled.join(', ')}) — recolor them in Settings ▸ Labels`
                );
            }
        } catch (error) {
            report(error, 'label preset migration');
        }
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
            // The registry is what the inspector's Restore/Dismiss act on; assigning it here
            // also re-broadcasts, which is harmless for the empty case below.
            graftOrphanRegistry.replace(graftOrphans);
            if (graftOrphans.length > 0) {
                log(`graft: ${String(graftOrphans.length)} interrupted session(s) need recovery`);
                ws?.broadcast(graftOrphansEvent(graftOrphans));
            }
        } catch (error) {
            report(error, 'graft orphan detection');
        }

        // The stats gate follows the attached-client count, and `WsServer` publishes no
        // presence event — so it is polled on the sample cadence itself. The poll is an
        // integer compare (`stats.setEnabled` is a no-op when unchanged), it is `unref`d so it
        // never holds the process open, and it is the *only* thing running while the gate is
        // closed: with no window attached, or `show-system-stats = false`, the daemon spawns
        // nothing and reads nothing.
        statsGateTimer = setInterval(refreshStatsGate, SYSTEM_STATS_INTERVAL_MS);
        statsGateTimer.unref?.();
        refreshStatsGate();

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
        log(
            `kelpid listening: control ${compatDegraded === null ? info.socketPath : `${paths.socket} (compat ${info.socketPath} degraded)`}, ` +
                `pane route ${paneRouteValue() ?? 'none'}, http ${info.url}`
        );
        plugins.start();
        return info;
    };

    return {
        start,
        stop,
        handoff,
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
        branchWatch,
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
            // A degraded compat server exists but is not serving; hand back the one that is.
            return compatControl?.running === true ? compatControl : runControl;
        },
        get running() {
            return running;
        }
    };
}
