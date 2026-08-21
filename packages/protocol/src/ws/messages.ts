/**
 * Client-sync protocol (WebSocket) — the NEW surface, not a compatibility contract.
 *
 * Two channels share one socket: JSON text frames carry the handshake, state sync, command
 * RPC, and reports; binary frames carry PTY traffic (see `./pty.js`). Design rules:
 * versioned handshake, additive within a generation, no domain logic — the daemon is the
 * only source of truth and clients are views.
 */

import type { JsonObject, JsonValue } from '../json.js';
import type { AgentKind, PaneStatus } from '../wire/vocab.js';
import type { WsSettingsChangedMessage, WsSettingsSnapshot } from './settings.js';

/** Bumped only on a breaking change; the daemon serves `daemon-v<version>` run files. */
export const WS_PROTOCOL_VERSION = 1;

export const WS_CLIENT_KINDS = ['electron', 'browser', 'cli'] as const;
export type WsClientKind = (typeof WS_CLIENT_KINDS)[number];

export interface WsClientInfo {
    readonly kind: WsClientKind;
    readonly name?: string;
    readonly version?: string;
    /**
     * Optional capability tokens (M6). `web-pane-host` claims the web-pane host slot at
     * handshake time — the same effect as sending `host-register` right after `hello`.
     */
    readonly capabilities?: readonly string[];
    /**
     * Window identity (embedded web panes). The Electron shell mints one id per shell window:
     * its **host** connection declares it here, and the UI loaded in that window repeats it on
     * every `web-geometry-report` (it rides the window URL as `?shellWindow=<id>`). That
     * pairing is what lets the daemon tell the host "this rect came from your own window" —
     * geometry from a plain browser matches nothing, which is why a browser keeps seeing the
     * placeholder card instead of a native view.
     */
    readonly windowID?: string;
}

// ── client → server ─────────────────────────────────────────────────────────────────

/** First frame on every connection; nothing else is accepted before it. */
export interface WsHelloMessage {
    readonly type: 'hello';
    readonly protocolVersion: number;
    /** Contents of the daemon's 0600 `.token` file (or a tailnet-issued token). */
    readonly token: string;
    readonly client: WsClientInfo;
    /** Last delta seq the client applied; lets the daemon send deltas instead of a snapshot. */
    readonly resumeFromSeq?: number;
}

/** Attach a pane's PTY stream: the daemon replays state, then goes live. */
export interface WsAttachPaneMessage {
    readonly type: 'attach-pane';
    readonly paneID: string;
    readonly cols: number;
    readonly rows: number;
}

export interface WsDetachPaneMessage {
    readonly type: 'detach-pane';
    readonly paneID: string;
}

/** Client-measured geometry; the daemon resizes the PTY and its terminal state. */
export interface WsResizePaneMessage {
    readonly type: 'resize-pane';
    readonly paneID: string;
    readonly cols: number;
    readonly rows: number;
}

/**
 * Focus is daemon-canonical (last report from any client wins) so focused-pane-dependent
 * commands keep their CLI semantics.
 */
export interface WsFocusReportMessage {
    readonly type: 'focus-report';
    readonly workspaceID: string;
    readonly paneID: string | null;
}

/**
 * Which panes this client is actually rendering, and whether its document is visible.
 * Drives PTY stream fan-out and notification suppression (a client showing a focused pane
 * suppresses that pane's desktop notification).
 */
export interface WsVisibilityReportMessage {
    readonly type: 'visibility-report';
    readonly workspaceID: string;
    readonly visiblePaneIDs: readonly string[];
    readonly documentVisible: boolean;
}

/** A control-protocol request object (the same verbs), answered by `command-reply`. */
export interface WsCommandMessage {
    readonly type: 'command';
    readonly id: string;
    readonly payload: JsonObject;
}

export interface WsPingMessage {
    readonly type: 'ping';
    readonly id: string;
}

/** A rectangle in the reporting client's own coordinate space. */
export interface WsRect {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
}

/**
 * Where a web pane's PAGE AREA sits inside the reporting client's viewport (embedded web
 * panes).
 *
 * The client draws a web pane's chrome (URL bar, tab strip, nav buttons) and leaves the page
 * area empty; the pixels come from a native `WebContentsView` the Electron shell owns. The
 * client is the only party that knows where that hole is, so it reports the rect — in **CSS
 * pixels, relative to the viewport** — and the daemon forwards it to the web-pane host as a
 * `pane-geometry` notification (`daemon/src/webpane/HOST_PROTOCOL.md` §3.1).
 *
 * Two rules keep it honest:
 *   - it is a **report**, not a command: no reply, and a daemon with no host drops it;
 *   - `shellWindowID` is the client's claim to be the page inside a shell window (from
 *     `?shellWindow=`). The host only acts on geometry whose id matches its own window, so a
 *     browser tab reporting rects cannot move a desktop user's views around.
 */
export interface WsWebGeometryReportMessage {
    readonly type: 'web-geometry-report';
    readonly paneID: string;
    /** The pane's active tab, so a tab switch re-targets the embedded view. */
    readonly tabID?: string;
    readonly rect: WsRect;
    /** False when the pane is not on screen (zoomed away, workspace switched, unmounted). */
    readonly visible: boolean;
    /** `window.devicePixelRatio`: display scale × page zoom, which the host divides out. */
    readonly devicePixelRatio: number;
    readonly shellWindowID?: string;
}

/**
 * "Take the user to this pane" — the shell's notification click, arriving over its own
 * connection because only a CLIENT can perform the §8.5 focus ordering (activate the
 * workspace, focus the pane last).
 *
 * `windowID` scopes it to the UI running in that shell window; without one every attached
 * client reveals (the CLI/automation case).
 */
export interface WsRevealRequestMessage {
    readonly type: 'reveal-request';
    readonly workspaceID: string;
    readonly paneID: string;
    readonly windowID?: string;
}

// ── host channel (M6 web panes) ─────────────────────────────────────────────────────

/**
 * The daemon is headless: browser views live in the Electron shell, so every web-pane verb
 * that needs a real page is forwarded to a **host** — the one WS client that claimed the
 * `web-pane` role. Exactly one host is active at a time; a second registration takes over and
 * the previous host is told with `host-revoked` (`reason: 'superseded'`).
 *
 * Full contract, including the RPC verb table the host must implement:
 * `packages/daemon/src/webpane/HOST_PROTOCOL.md`.
 */
export const WS_HOST_ROLES = ['web-pane'] as const;
export type WsHostRole = (typeof WS_HOST_ROLES)[number];

/** Claim the role. Sent after `hello`; re-sending re-claims (last registration wins). */
export interface WsHostRegisterMessage {
    readonly type: 'host-register';
    readonly role: WsHostRole;
    /** Diagnostics only (shows up in daemon logs). */
    readonly name?: string;
    /**
     * The host's own window identity, for matching `web-geometry-report`s (see
     * `WsClientInfo.windowID`). A `hello` that claims the role by capability declares it
     * there instead.
     */
    readonly windowID?: string;
}

/** Give the role up without dropping the connection. */
export interface WsHostUnregisterMessage {
    readonly type: 'host-unregister';
    readonly role?: WsHostRole;
}

/** The answer to one `host-rpc`. `reply` is the `{ok:…}` envelope the CLI will see. */
export interface WsHostRpcReplyMessage {
    readonly type: 'host-rpc-reply';
    readonly id: string;
    readonly reply: JsonObject;
}

/**
 * Unsolicited host → daemon traffic: console lines (ring-buffered + streamed), URL/title
 * mirroring, element-picker payloads, and tab teardown the host performed on its own.
 */
export const WS_HOST_EVENTS = ['console', 'page-state', 'inspect', 'tab-closed'] as const;
export type WsHostEventKind = (typeof WS_HOST_EVENTS)[number];

export interface WsHostEventMessage {
    readonly type: 'host-event';
    readonly event: WsHostEventKind;
    readonly paneID: string;
    readonly tabID?: string;
    readonly payload: JsonObject;
}

export type WsClientMessage =
    | WsHelloMessage
    | WsAttachPaneMessage
    | WsDetachPaneMessage
    | WsResizePaneMessage
    | WsFocusReportMessage
    | WsVisibilityReportMessage
    | WsCommandMessage
    | WsPingMessage
    | WsWebGeometryReportMessage
    | WsRevealRequestMessage
    | WsHostRegisterMessage
    | WsHostUnregisterMessage
    | WsHostRpcReplyMessage
    | WsHostEventMessage;

// ── server → client ─────────────────────────────────────────────────────────────────

/**
 * What the daemon's optional TCP control listener actually did (§SET-021 / §AGNT-005).
 *
 * The config file says which port was ASKED for; only the daemon knows whether the bind
 * succeeded. Settings ▸ General ▸ Network reads its port field out of the settings snapshot and
 * its *state* out of this, so the row can say "listening on 19400" or "port 19400 unavailable:
 * EADDRINUSE" instead of a hopeful "takes effect on the next daemon start".
 *
 * Rides on `welcome` for the same reason settings do: it is not domain state, no `DomainEvent`
 * describes it, and a delta replay must never touch it. It changes only when the daemon
 * restarts, and every reconnect re-sends it.
 */
export interface WsTcpTransportStatus {
    /** The port `tcp-port` asked for. */
    readonly requested: number;
    readonly host: string;
    /** The port actually listening; null when the bind failed. */
    readonly bound: number | null;
    /** The bind failure, ready to show a user; null when it bound. */
    readonly error: string | null;
}

export interface WsTransportStatus {
    /** null = no TCP listener was configured — NOT the same as one that failed to bind. */
    readonly tcp: WsTcpTransportStatus | null;
}

/**
 * `transport-changed`: the daemon re-bound (or dropped) a listener while clients were attached
 * (§AGNT-005's live re-bind).
 *
 * Its own message rather than a field on `settings-changed`, because the two say different
 * things: `settings-changed` carries what the config FILE says, this carries what the listener
 * actually DID. A client that predates it ignores an unknown message type, which is exactly the
 * additive behaviour the protocol assumes everywhere else.
 */
export const WS_TRANSPORT_CHANGED_MESSAGE = 'transport-changed';

export interface WsTransportChangedMessage {
    readonly type: typeof WS_TRANSPORT_CHANGED_MESSAGE;
    readonly transport: WsTransportStatus;
}

export interface WsWelcomeMessage {
    readonly type: 'welcome';
    readonly protocolVersion: number;
    readonly clientID: string;
    readonly daemon: {
        readonly version: string;
        readonly build: string;
        readonly pid: number;
        /**
         * §APP-069: the daemon HOST's home directory, for display only — the client abbreviates
         * the daemon-side paths it renders (`~/code/nex`). Additive; absent = do not abbreviate.
         */
        readonly home?: string;
    };
    /**
     * The daemon's config-file settings (M8). Rides here rather than in `snapshot` because
     * settings are not domain state — see `./settings.ts` for the reasoning. Absent on a
     * daemon that predates settings sync; later changes arrive as `settings-changed`.
     */
    readonly settings?: WsSettingsSnapshot;
    /**
     * §SET-021: what happened to the control listeners this daemon was configured with.
     * Additive — absent on a daemon that predates it, which a client must read as "unknown",
     * never as "everything bound".
     */
    readonly transport?: WsTransportStatus;
}

export const WS_REJECTION_CODES = ['protocol-mismatch', 'unauthorized', 'server-error'] as const;
export type WsRejectionCode = (typeof WS_REJECTION_CODES)[number];

/**
 * The machine-readable half of a rejection, one level finer than `code`.
 *
 * It exists because the WS upgrade itself can no longer say why it refused: a browser sees
 * every failed upgrade as `onerror` + close 1006 and retries forever, so token checking moved
 * into the handshake (`daemon/src/ws/sync.ts`). A client that gets `bad-token` knows to stop
 * retrying AND to forget whatever token it remembered, which `code: 'unauthorized'` alone
 * cannot tell it apart from, say, a tailnet policy refusal.
 *
 * Additive by design: an unknown reason must be treated as "no reason given".
 */
export const WS_REJECTION_REASONS = [
    /** No token, or one that does not match the daemon's run-dir token. */
    'bad-token',
    /** The client speaks a different client-protocol generation. */
    'protocol-mismatch',
    /** Something other than `hello` arrived first. */
    'expected-hello',
    /** The connection sat open without completing a handshake. */
    'hello-timeout'
] as const;
export type WsRejectionReason = (typeof WS_REJECTION_REASONS)[number];

/** Sent instead of `welcome`; the socket closes right after. */
export interface WsRejectedMessage {
    readonly type: 'rejected';
    readonly code: WsRejectionCode;
    readonly message: string;
    readonly protocolVersion: number;
    /** Finer-grained cause; absent on older daemons. */
    readonly reason?: WsRejectionReason;
}

/** Full state, sent on attach and after any resync. `seq` anchors the delta stream. */
export interface WsSnapshotMessage {
    readonly type: 'snapshot';
    readonly seq: number;
    readonly state: JsonObject;
}

/**
 * The delta vocabulary is the daemon store's own `DomainEvent` union — the daemon serializes
 * its events verbatim (`daemon/src/ws/serialize.ts`) and clients replay them with the daemon's
 * `applyDomainEvents`, so anything declared here that the store does not emit is a lie. The
 * shapes below are therefore transcribed from `daemon/src/store/types.ts` `DomainEvent`, with
 * the domain records (workspace envelope, pane, group, layout tree, …) left as JSON: the
 * protocol package is deliberately dependency-free and must not import the daemon.
 *
 * Two fields differ from the in-daemon shape because `serialize.ts` rewrites them:
 * `workspace-upserted.workspace` carries `recentlyClosedCount` instead of the undo stack, and
 * the snapshot's app-level `homeDirectory` is dropped entirely.
 */
export const WS_DELTA_KINDS = [
    'workspace-upserted',
    'workspace-removed',
    'pane-upserted',
    'pane-removed',
    'layout-changed',
    'focus-changed',
    'sync-changed',
    'agent-status-changed',
    'group-upserted',
    'group-removed',
    'order-changed',
    'active-workspace-changed',
    'label-presets-changed',
    'repos-changed'
] as const;
export type WsDeltaKind = (typeof WS_DELTA_KINDS)[number];

/** `pane-upserted` names which lane of the workspace the pane lives in. */
export const WS_PANE_LANES = ['visible', 'parked'] as const;
export type WsPaneLane = (typeof WS_PANE_LANES)[number];

export type WsDeltaEvent =
    | { readonly kind: 'workspace-upserted'; readonly id: string; readonly workspace: JsonObject }
    | { readonly kind: 'workspace-removed'; readonly id: string }
    | {
          readonly kind: 'pane-upserted';
          readonly workspaceID: string;
          readonly paneID: string;
          readonly lane: WsPaneLane;
          readonly index: number;
          readonly pane: JsonObject;
      }
    | { readonly kind: 'pane-removed'; readonly workspaceID: string; readonly paneID: string }
    | {
          readonly kind: 'layout-changed';
          readonly workspaceID: string;
          readonly layout: JsonValue;
          readonly zoomedPaneID: string | null;
          readonly savedLayout: JsonValue;
          readonly currentLayoutIndex: number | null;
      }
    | {
          readonly kind: 'focus-changed';
          readonly workspaceID: string;
          readonly focusedPaneID: string | null;
          readonly focusHistory: readonly string[];
      }
    | {
          readonly kind: 'sync-changed';
          readonly workspaceID: string;
          readonly isSyncInputActive: boolean;
          readonly syncInputExcluded: readonly string[];
          /** The derived broadcast group after the change. */
          readonly syncedPaneIDs: readonly string[];
      }
    | {
          readonly kind: 'agent-status-changed';
          readonly workspaceID: string;
          readonly paneID: string;
          readonly status: PaneStatus;
          readonly agentSessionID: string | null;
          readonly agentKind: AgentKind | null;
          /** Epoch MILLISECONDS. */
          readonly agentStartedAt: number | null;
          readonly backgroundTaskCount: number;
      }
    | { readonly kind: 'group-upserted'; readonly id: string; readonly index: number; readonly group: JsonObject }
    | { readonly kind: 'group-removed'; readonly id: string }
    | {
          readonly kind: 'order-changed';
          readonly workspaceOrder: readonly string[];
          readonly groupOrder: readonly string[];
          /** `SidebarID`s: `{kind:'workspace'|'group', id}`. */
          readonly topLevelOrder: readonly JsonObject[];
      }
    | { readonly kind: 'active-workspace-changed'; readonly workspaceID: string | null }
    | { readonly kind: 'label-presets-changed'; readonly presets: readonly JsonObject[] }
    | { readonly kind: 'repos-changed'; readonly repos: readonly JsonObject[] };

/** Ordered; a gap in `seq` means the client must resync. */
export interface WsDeltaMessage {
    readonly type: 'delta';
    readonly seq: number;
    readonly events: readonly WsDeltaEvent[];
}

export interface WsCommandReplyMessage {
    readonly type: 'command-reply';
    readonly id: string;
    /** The same `{ok:true,…}` / `{ok:false,error}` object the control socket would return. */
    readonly reply: JsonObject;
}

export const WS_NOTIFICATION_KINDS = ['agent-waiting', 'agent-error', 'agent-notification', 'osc'] as const;
export type WsNotificationKind = (typeof WS_NOTIFICATION_KINDS)[number];

/**
 * The daemon decides notifications and broadcasts them; clients render them (Electron
 * natively, browsers via Web Notifications). `dedupeKey` preserves the `nex-<paneID>`
 * identity so a re-post replaces the previous one.
 */
export interface WsNotificationMessage {
    readonly type: 'notification';
    readonly kind: WsNotificationKind;
    readonly paneID: string;
    readonly workspaceID: string;
    readonly title: string;
    readonly body: string;
    readonly dedupeKey: string;
}

export interface WsPaneExitMessage {
    readonly type: 'pane-exit';
    readonly paneID: string;
    readonly exitCode: number | null;
    readonly signal?: string;
}

// ── VT modes (terminal-panes.md §TERM-037…§TERM-039) ────────────────────────────────

/** DEC mouse tracking, in xterm's vocabulary: 9 / 1000 / 1002 / 1003 respectively. */
export const WS_MOUSE_TRACKING_MODES = ['none', 'x10', 'vt200', 'drag', 'any'] as const;
export type WsMouseTrackingMode = (typeof WS_MOUSE_TRACKING_MODES)[number];

/** Mouse coordinate encoding: default / 1005 / 1006 / 1015 / 1016. */
export const WS_MOUSE_FORMATS = ['x10', 'utf8', 'sgr', 'urxvt', 'sgr-pixels'] as const;
export type WsMouseFormat = (typeof WS_MOUSE_FORMATS)[number];

/**
 * A pane's live VT modes, as the daemon's server-side emulator sees them.
 *
 * `applicationCursorKeys` and `bracketedPaste` are the daemon's own input-encoding inputs and
 * ride here because they are the same object. The two a CLIENT acts on are the mouse pair:
 * neither renderer this port ships implements DEC mouse reporting (`ghostty-web@0.4.0` parses
 * 9/1000/1002/1003/1006 and then ignores them), so the client encodes the reports itself and
 * needs the modes as state rather than as engine behaviour.
 */
export interface WsVtModes {
    readonly applicationCursorKeys: boolean;
    readonly bracketedPaste: boolean;
    readonly mouseTracking: WsMouseTrackingMode;
    readonly mouseFormat: WsMouseFormat;
}

export const WS_PANE_MODES_MESSAGE = 'pane-modes';

/**
 * `pane-modes`: this pane's VT modes are now these.
 *
 * Sent once per attach (immediately after the `replay` frame, so a client's very first mouse
 * report cannot be encoded against modes it has not been told about) and then on every
 * transition. Additive: a client that predates it ignores an unknown message type and simply
 * never reports the mouse — which is exactly the behaviour it had.
 */
export interface WsPaneModesMessage {
    readonly type: typeof WS_PANE_MODES_MESSAGE;
    readonly paneID: string;
    readonly modes: WsVtModes;
}

/** The daemon cannot serve deltas from the client's seq; it must take a fresh snapshot. */
export interface WsResyncRequiredMessage {
    readonly type: 'resync-required';
    readonly reason: 'seq-gap' | 'snapshot-expired';
}

export interface WsPongMessage {
    readonly type: 'pong';
    readonly id: string;
}

// ── host channel, server → host ─────────────────────────────────────────────────────

export interface WsHostRegisteredMessage {
    readonly type: 'host-registered';
    readonly role: WsHostRole;
    readonly hostID: string;
    /** True when this registration displaced a previously connected host. */
    readonly superseded: boolean;
}

export const WS_HOST_REVOKE_REASONS = ['superseded', 'unregistered', 'shutdown'] as const;
export type WsHostRevokeReason = (typeof WS_HOST_REVOKE_REASONS)[number];

/** The role is no longer this connection's; it must stop answering `host-rpc`. */
export interface WsHostRevokedMessage {
    readonly type: 'host-revoked';
    readonly role: WsHostRole;
    readonly hostID: string;
    readonly reason: WsHostRevokeReason;
}

/** One request to the host. Answered with `host-rpc-reply` carrying the same `id`. */
export interface WsHostRpcMessage {
    readonly type: 'host-rpc';
    readonly id: string;
    readonly verb: string;
    readonly args: JsonObject;
    /** After this the daemon answers the CLI itself; a late reply is discarded. */
    readonly timeoutMs: number;
}

/**
 * Fire-and-forget host traffic: daemon-owned state (a tab opened, the private flag flipped)
 * mirrored to the host. No reply is expected and none is read.
 */
export interface WsHostNotifyMessage {
    readonly type: 'host-notify';
    readonly verb: string;
    readonly args: JsonObject;
}

/** One console line pushed to a client subscribed with `web-console-subscribe`. */
export interface WsWebConsoleLineMessage {
    readonly type: 'web-console-line';
    readonly paneID: string;
    readonly line: JsonObject;
}

/**
 * The daemon's fan-out of a `reveal-request`: go to this pane.
 *
 * A client that acts on it must follow agent-lifecycle.md §8.5 — activate the workspace
 * first, focus the pane last — because the window restoring its previous focus otherwise
 * reverts the selection. `windowID`, when present, means "only the UI in that shell window".
 */
export interface WsRevealPaneMessage {
    readonly type: 'reveal-pane';
    readonly workspaceID: string;
    readonly paneID: string;
    readonly windowID?: string;
}

export type WsServerMessage =
    | WsWelcomeMessage
    | WsRejectedMessage
    | WsSnapshotMessage
    | WsDeltaMessage
    | WsCommandReplyMessage
    | WsNotificationMessage
    | WsPaneExitMessage
    | WsPaneModesMessage
    | WsResyncRequiredMessage
    | WsPongMessage
    | WsSettingsChangedMessage
    | WsHostRegisteredMessage
    | WsHostRevokedMessage
    | WsHostRpcMessage
    | WsHostNotifyMessage
    | WsWebConsoleLineMessage
    | WsRevealPaneMessage;

export type WsMessage = WsClientMessage | WsServerMessage;
