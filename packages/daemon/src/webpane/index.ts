/**
 * M6 — web panes, daemon half.
 *
 * Spec: docs/current/web-pane.md (wire contract) + `./HOST_PROTOCOL.md` (the daemon↔shell RPC
 * the Electron host implements).
 *
 * Shape of the subsystem:
 *   - `service.ts`  the runtime: host registry + console buffers + picker arms, one per daemon;
 *   - `handlers.ts` the `web-*` control-socket commands (they replace the M2 stubs);
 *   - `host.ts`     the RPC seam (one active host, bounded calls, honest no-host failure);
 *   - `geometry.ts` client page-area reports → the host's `pane-geometry` notify (embedded views);
 *   - `console.ts` / `ring.ts`  the per-pane ring buffer with seq/dropped semantics;
 *   - `inspect.ts`  payload sanitisation, the result queue and the paste format;
 *   - `resolve.ts`  pane/tab scope resolution with the spec's exact error strings.
 *
 * Wiring: `boot/compose.ts` creates the service and hands it to `createAppHandlers` (commands)
 * and `createWsServer` (host registration + host events, in `ws/sync.ts`).
 */

export {
    CONSOLE_BUFFER_CAPACITY,
    CONSOLE_LEVELS,
    createConsoleStore,
    isConsoleLevel,
    normalizeConsoleLevel,
    serializeConsoleLine,
    type ConsoleDrain,
    type ConsoleDrainOptions,
    type ConsoleLevel,
    type ConsoleLine,
    type ConsoleStore,
    type ConsoleSubscriber
} from './console.js';

export {
    GEOMETRY_NOTIFY_VERB,
    geometryNotifyArgs,
    parseGeometryRect,
    type GeometryRect,
    type GeometryReportInput
} from './geometry.js';

export {
    ARM_FAILED_ERROR,
    CAPTURE_MODES,
    COOKIE_SCOPE_ERROR,
    LAST_TAB_ERROR,
    NO_ACTIVE_WORKSPACE_ERROR,
    webHandlerEntries,
    type WebHandlerDeps
} from './handlers.js';

export {
    DEFAULT_HOST_TIMEOUT_MS,
    HOST_GONE_ERROR,
    NO_HOST_ERROR,
    createHostRegistry,
    timeoutError,
    type HostCallOptions,
    type HostRegistration,
    type HostRegistry,
    type HostRegistryOptions,
    type HostRevokeReason,
    type HostTransport
} from './host.js';

export {
    INSPECT_LIMITS,
    INSPECT_QUEUE_CAP,
    clampField,
    createInspectState,
    formatForPaste,
    sanitizeInspectPayload,
    serializeInspectResult,
    stripUnsafeControlCharacters,
    type InspectArm,
    type InspectResult,
    type InspectState
} from './inspect.js';

export { createRingBuffer, type RingBuffer, type RingEntry } from './ring.js';

export {
    NO_ACTIVE_TAB_ERROR,
    resolveTabRef,
    resolveWebPane,
    type ResolvedWebPane,
    type TabRefResolution,
    type WebPaneResolution,
    type WebScopeFields
} from './resolve.js';

export {
    createWebPaneService,
    type HostEventInput,
    type WebDomainStore,
    type WebPaneService,
    type WebPaneServiceOptions,
    type WebPastePort
} from './service.js';

export {
    ACTUATOR_WAIT_DEFAULT_MS,
    HOST_TIMEOUT_CAPTURE_MS,
    HOST_TIMEOUT_DEFAULT_MS,
    HOST_TIMEOUT_EXEC_MS,
    HOST_VERBS,
    waitTimeoutMs,
    type HostVerb
} from './verbs.js';
