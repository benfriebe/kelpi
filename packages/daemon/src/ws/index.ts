/**
 * WP2.7 — the client-facing HTTP + WebSocket server.
 *
 * `createWsServer` is what boot wires: it serves the web client, answers `/healthz`,
 * authenticates `/ws` upgrades against the run-dir token, and gives every connection both
 * channels — JSON state sync (`./sync.ts`) and binary PTY streams (`./streams.ts`).
 * Its `broadcast` member is the `HandlerContext.broadcast` seam.
 */

export {
    CLIENT_DIR_ENV,
    WS_PATH,
    authorizeUpgrade,
    contentTypeFor,
    createHttpApp,
    createPaneAssetsRoute,
    extractRequestToken,
    parsePaneAssetPath,
    requestPathname,
    resolveClientDistDir,
    resolveStaticPath,
    runDirToken,
    tokensMatch,
    writeUpgradeRejection,
    type DaemonVersionInfo,
    type HttpAppOptions,
    type PaneAssetRequest,
    type RunDirTokenOptions,
    type UpgradeAuthOptions,
    type UpgradeDecision
} from './http.js';

export {
    SERVER_ONLY_APP_FIELDS,
    SERVER_ONLY_WORKSPACE_FIELDS,
    serializeDomainEvent,
    serializeDomainEvents,
    serializeGroup,
    serializeLabelPreset,
    serializePane,
    serializeRepo,
    serializeState,
    serializeWorkspace,
    serializeWorkspaceEnvelope
} from './serialize.js';

export {
    DEFAULT_CLIENT_QUEUE_BYTES,
    PTY_RESYNC_MESSAGE_TYPE,
    createPaneStreamHub,
    type PaneGeometry,
    type PaneStreamHub,
    type PaneStreamHubOptions,
    type PaneStreamSession,
    type PaneStreamStats,
    type PaneStreamTransport
} from './streams.js';

export {
    BAD_TOKEN_MESSAGE,
    CONTENT_COMMANDS,
    CONTENT_UPDATED_MESSAGE,
    DEFAULT_HELLO_TIMEOUT_MS,
    WEB_COMMANDS,
    WEB_CONSOLE_LINE_MESSAGE,
    WEB_HOST_CAPABILITY,
    WS_CLOSE_CODES,
    createSyncHub,
    isContentCommand,
    isWebCommand,
    type ContentChannel,
    type ContentCommand,
    type NexDomainStore,
    type SessionOptions,
    type SyncHub,
    type SyncHubOptions,
    type SyncPaneBridge,
    type SyncPresence,
    type SyncSession,
    type SyncTransport,
    type WebCommand,
    type WebPaneChannel
} from './sync.js';

export {
    DEFAULT_HTTP_HOST,
    createWsServer,
    type WsServer,
    type WsServerAddress,
    type WsServerOptions
} from './server.js';
