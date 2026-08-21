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
import { SYSTEM_STATS_INTERVAL_MS, WS_TRANSPORT_CHANGED_MESSAGE } from '@nex/protocol';
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
import { createEditorResolver } from '../content/external-editor.js';
import type { ControlDispatcher, PersistenceHealth, TerminalInput } from '../seams.js';
import {
    applyLoadReset,
    createStore,
    emptyDaemonState,
    fromSnapshot,
    toSnapshot,
    visiblePane,
    workspaceContainingVisiblePane,
    type DaemonState,
    type NexStore
} from '../store/index.js';
import {
    createPaneBranchWatch,
    createRepoAutoDetect,
    type PaneBranchWatchService
} from '../git/index.js';
import { createSystemStatsSampler } from '../stats/index.js';
import {
    createTerminalStateService,
    type OscNotification,
    type TerminalStateServiceImpl
} from '../term/index.js';
import {
    createAgentChannel,
    createGraftOrphanRegistry,
    createPaneAssetsRoute,
    createPaneLifecycleChannel,
    createDesktopChannel,
    createWsServer,
    resolveClientDistDir,
    WEB_BATCH_MESSAGE,
    WEB_FAVOURITES_MESSAGE,
    WEB_NAV_STATE_MESSAGE,
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
    /** Assigned once the store, the settings and auto-detect exist (just below `term`). */
    let onPaneDirectory: (paneID: string, directory: string) => void = () => {};
    /**
     * OSC 7 is the port's pwd producer (terminal-panes.md §TERM-048): the shell reports where
     * it is, the pane's `workingDirectory` follows, and repo auto-detect gets its trigger
     * (graft-git.md §GIT-075). `autoDetect` is created further down — this closure defers to
     * it, so the ordering between the two is not load-bearing.
     */
    /** Assigned beside `onPaneDirectory`, and deferred for the same reason. */
    let onPaneTitle: (paneID: string, title: string) => void = () => {};
    /**
     * §TERM-050's delivery, deferred for the same reason as the two above: it needs `store` and
     * `ws`, both of which are built below.
     */
    let onPaneOscNotification: (paneID: string, notification: OscNotification) => void = () => {};
    const term = createTerminalStateService({
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
    /**
     * The footer's system-stat gauges (APP-078…085). The Swift app samples in the VIEW; a
     * browser tab cannot read host counters and two clients must not double-sample one
     * machine, so the daemon samples once and broadcasts (`@nex/protocol` `ws/stats.ts`).
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
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(onError !== undefined ? { onError } : {})
    });

    let runControl: ControlServer | undefined;
    let compatControl: ControlServer | undefined;

    /**
     * §SET-021 / §AGNT-005: whichever control server owns the optional TCP listener, and what
     * happened to it. Only one of the two ever has TCP configured (`start()` re-creates
     * `runControl` with the port when the compat path IS the run-dir path), so first-non-null
     * wins and `null` means "no TCP listener was asked for".
     */
    const controlTcpStatus = (): ControlTcpStatus | null =>
        compatControl?.tcpStatus ?? runControl?.tcpStatus ?? null;

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
        // An env override (`NEXD_TCP_PORT`, or an explicit `tcpPort` option) OUTRANKS the config
        // file at boot — `resolveControlEndpoints` says so — and it has to keep outranking it
        // afterwards. Without this guard the first unrelated Settings write would read
        // `tcp-port = 0` out of the file and tear down a listener the operator asked for on the
        // command line, taking every `NEX_SOCKET=tcp:…` client with it.
        if (endpoints.source.tcpPort === 'env') return;
        const owner = compatControl?.tcpStatus !== null && compatControl !== undefined
            ? compatControl
            : (runControl ?? compatControl);
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
        } catch (error) {
            report(error, 'tcp rebind');
        }
        ws?.broadcast({ type: WS_TRANSPORT_CHANGED_MESSAGE, transport: { tcp: controlTcpStatus() } });
    };

    /**
     * `$VISUAL` / `$EDITOR` resolution for the external-editor pane mode (CONT-081…088).
     *
     * Warmed at the end of `start()` (CONT-087) so the first "Open in $EDITOR" is instant, and
     * cached for the daemon's lifetime — the login-shell probe costs 1–2 seconds of rc-file
     * loading and must never sit on a request path.
     */
    const editorResolver = createEditorResolver({
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
    const restartControlServers = async (): Promise<{ socketPath: string; tcpPort?: number | undefined }> => {
        if (runControl === undefined) throw new Error('the control server is not running');
        const previousCompat = compatControl;
        await runControl.stop();
        await previousCompat?.stop();
        await runControl.start();
        await previousCompat?.start();
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
        // §SET-021: `ping` reports this too — a `tcp-port` that never bound is otherwise a log
        // line nobody reads, and every `NEX_SOCKET=tcp:…` client just times out.
        controlTransport: () => ({ tcp: controlTcpStatus() }),
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
     * on the next pwd report without re-wiring anything.
     */
    const autoDetect = createRepoAutoDetect({
        store,
        git,
        enabled: () => settings.snapshot.general.autoDetectRepos,
        uuid: options.uuid ?? newUUID,
        persist,
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(onError !== undefined ? { onError } : {})
    });

    /**
     * One OSC 7 report: the pane's working directory moves (which is what `pane list`'s CWD
     * column, the footer and `--prune-worktree` read), and auto-detect gets its trigger. The
     * store is the single writer, so a client sees the change as the same delta a spawn does.
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
        autoDetect.paneDirectoryChanged({ workspaceID: workspace.id, paneID, directory });
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
            if (statsGateTimer !== null) clearInterval(statsGateTimer);
            statsGateTimer = null;
            offStats();
            stats.dispose();
            settings.dispose();
            content.dispose();
            // Releases the host slot (the shell sees `host-revoked`) and ends every console
            // follow stream; nothing here can block the shutdown.
            webPanes.close();
            repoWatch.dispose();
            branchWatch.dispose();
            // §5 quit flush: unwind every graft session (2 s cap) so a clean quit never leaves
            // a `nex-graft-active` breadcrumb behind — anything slower falls back to the
            // orphan-recovery banner on the next launch.
            try {
                await graft.shutdown();
            } catch (error) {
                report(error, 'graft shutdown');
            }
            offGraft();
            offOrphans();
            // Pending auto-link/auto-unlink timers must not fire into a store nobody will save.
            autoDetect.stop();
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
                // §SET-021: `welcome.transport` — Settings ▸ Network shows what the listener
                // actually did, not what the config file hoped for. A getter, because
                // `restart-control-server` can re-bind under an attached client.
                transport: () => ({ tcp: controlTcpStatus() }),
                // The pane header's restart button: typing a resume command needs the same
                // TerminalInput (live VT modes, no sync mirroring) the CLI's `pane send` uses.
                agents: createAgentChannel({ store, pty, input }),
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
        // §GIT-091: resolve a branch for every restored pane, then keep resolving as panes move.
        branchWatch.start();
        // CONT-087: resolve the user's `$EDITOR` in the background now, so the first
        // "Open in $EDITOR" does not pay for a login-shell init. Failures are cached with a
        // TTL and simply mean the built-in editor keeps the pane.
        editorResolver.warmUp();
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
            return compatControl ?? runControl;
        },
        get running() {
            return running;
        }
    };
}
