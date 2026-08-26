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

/**
 * §SET-200 / §SET-201: what the OS said when the shell registered the global hotkey.
 *
 * The Swift reducer keeps the reason string in state and Settings ▸ Keybindings renders it as an
 * inline warning. Here the registrar is a different PROCESS (Electron `globalShortcut`), so the
 * outcome has to travel — shell → daemon → every client — before Settings can show it. The
 * shell reports after every attempt: the one at launch (`source: 'launch'`, §8.4's config-load
 * path, where the failing value is deliberately KEPT so the user can see and edit it) and every
 * re-registration a config write triggers (`source: 'settings'`).
 *
 * `ok: true` clears a standing warning, so re-recording a chord that works removes the message
 * without anything having to remember it was there.
 *
 * Both a client → daemon report and, re-broadcast unchanged, a daemon → client push: the shell
 * is a WS client like any other, and the daemon is the only thing every window shares.
 */
export interface WsHotkeyStatusMessage {
    readonly type: 'hotkey-status';
    /** The accelerator actually registered; null when the hotkey is unset or was rejected. */
    readonly accelerator: string | null;
    /** The config-file spelling that was asked for (`"ctrl+alt+space"`); null when unset. */
    readonly configString: string | null;
    readonly ok: boolean;
    /** The OS's reason on a failure ("This shortcut is already claimed by another app."). */
    readonly error: string | null;
    readonly source: 'launch' | 'settings';
}

export const WS_HOTKEY_STATUS_MESSAGE = 'hotkey-status';

/**
 * §AGNT-056: the app became active (or stopped being active), reported by the shell.
 *
 * The Swift reads `NSApplication.didBecomeActiveNotification` in the view that owns the pane
 * grid and re-schedules the 600 ms focus-dwell clear from there — the acknowledgment happens
 * when the user comes BACK, which is the whole reason for the delay. Here the grid is in a
 * different process from the thing that knows about activation, so the fact has to travel:
 * shell → daemon → the client running in that window.
 *
 * `windowID` scopes it exactly as `reveal-request` is scoped, for a sharper reason: two shell
 * windows on one daemon are independently active, so an unscoped report would suspend a second
 * window's timers because the first one lost focus. A report with no `windowID` applies
 * everywhere (the single-window and automation case).
 *
 * Deliberately NOT remembered by the daemon: activation is a transient about a window that may
 * already be gone, and a replayed one would tell a fresh client something false about itself. A
 * client that has heard nothing assumes it is active — the same assumption a browser tab makes
 * before its first `visibilitychange`.
 *
 * Both a client → daemon report and, relayed unchanged, a daemon → client push (the shell is a
 * WS client like any other, exactly as `hotkey-status` is).
 */
export const WS_SHELL_ACTIVATION_MESSAGE = 'shell-activation';

export interface WsShellActivationMessage {
    readonly type: typeof WS_SHELL_ACTIVATION_MESSAGE;
    /** True on activate/focus, false on deactivate/blur. */
    readonly active: boolean;
    /** The shell window this is about; absent = every client. */
    readonly windowID?: string;
}

/**
 * §WS-151: how many workspaces this window's sidebar has multi-selected, reported by the client.
 *
 * `shell-activation` in the other direction, and for the mirror-image reason. The shipped app's
 * File ▸ "Deselect All Workspaces" is `.disabled(store.selectedWorkspaceIDs.isEmpty)` — one
 * reducer, one menu, no distance between them (`NexCommands.swift:49-57`). Here the menu is in
 * the main process and the selection is client-local state in the page, so the fact has to
 * travel: client → daemon → the shell that owns that window's menu.
 *
 * `windowID` scopes it exactly as `shell-activation` does: two shell windows have two menus and
 * two independent selections. An unscoped report is every shell's (the single-window case).
 *
 * Deliberately NOT remembered by the daemon, for the same reason activation is not: it describes
 * a moment, and a client that has said nothing has nothing selected — which is also the state a
 * freshly built menu is in, so silence and the truth agree.
 *
 * A count rather than a boolean: it costs the same on the wire, and a boolean would have to be
 * widened the first time a row wants to say "Delete N Workspaces…".
 */
export const WS_WORKSPACE_SELECTION_MESSAGE = 'workspace-selection';

export interface WsWorkspaceSelectionMessage {
    readonly type: typeof WS_WORKSPACE_SELECTION_MESSAGE;
    /** How many workspaces are multi-selected right now; 0 = none. */
    readonly selected: number;
    /** The shell window this is about; absent = every shell. */
    readonly windowID?: string;
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
    | WsHostEventMessage
    | WsHotkeyStatusMessage
    | WsShellActivationMessage
    | WsWorkspaceSelectionMessage;

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
    /**
     * The CLI-compat socket's bind failure (typically another Nex — the Swift app — owning
     * `/tmp/nex.sock`), or null/absent while it serves. Additive: an older client ignores it.
     * A degraded compat socket is not a degraded daemon (panes route via their injected
     * `NEX_SOCKET`), but Settings ▸ Network must be able to say where plain-terminal `nex`
     * commands are going.
     */
    readonly compat?: { readonly path: string; readonly error: string } | null;
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

export const WS_CLIPBOARD_WRITE_MESSAGE = 'clipboard-write';

/**
 * §TERM-046: a program in a pane asked to put text on the clipboard (OSC 52), the daemon's
 * `clipboard-write` setting allowed it, and this is the text.
 *
 * A broadcast, on the same seam `notification` uses, because the clipboard is not the daemon's to
 * own: the PTY runs on the daemon's machine and the clipboard belongs to whichever machine a
 * client is displayed on (terminal-surface.md §12's port note — "the clipboard belongs to the
 * *client machine*"). Every attached client writes the text to its own machine's clipboard; two
 * windows on one machine writing the same string is a no-op.
 *
 * `bytes` is the DECODED length as the daemon measured it, carried so a client can log the write
 * attributably — pane id and size — without logging the content. `text` is the one sensitive
 * field here and nothing on either side ever logs it.
 *
 * Additive: a client that predates it ignores an unknown type and never writes a clipboard,
 * which is exactly the behaviour it had.
 */
export interface WsClipboardWriteMessage {
    readonly type: typeof WS_CLIPBOARD_WRITE_MESSAGE;
    readonly paneID: string;
    readonly workspaceID: string;
    readonly text: string;
    readonly bytes: number;
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
 *
 * `kittyKeyboardFlags` is the third member of that family and lands for the same reason: the
 * engine registers one `keydown` listener and zero `keyup` listeners, so the kitty keyboard
 * protocol — whose whole subject is press/repeat/release — is encoded in the port's own layer
 * against flags the daemon negotiated off the VT stream (`daemon/src/term/kitty-keyboard.ts`).
 */
export interface WsVtModes {
    readonly applicationCursorKeys: boolean;
    readonly bracketedPaste: boolean;
    readonly mouseTracking: WsMouseTrackingMode;
    readonly mouseFormat: WsMouseFormat;
    /** Kitty keyboard protocol flags for the active screen. `0` = off (legacy encoding). */
    readonly kittyKeyboardFlags: number;
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

/**
 * §N29: the user clicked into a web pane's PAGE, fanned out to that window's client.
 *
 * A web pane's page is a native `WebContentsView` composited over the client's renderer, so a
 * pointer press inside it reaches Chromium and nobody else — the client never learns the pane was
 * touched, and the focus ring stays wherever it was. The shell's web-pane host reports the
 * gesture as a `host-event` (`view-focus`), and this is the daemon's fan-out of it; the client
 * then runs the SAME focused-pane path a terminal body click runs (`focusPane` → `report-focus`),
 * which is why the daemon does not move focus itself.
 *
 * `windowID` scopes it exactly as `shell-activation` does: a second window's ring must not move
 * because this one was clicked. Absent = the reporting host declared no window.
 */
export interface WsWebViewFocusMessage {
    readonly type: 'web-view-focus';
    readonly paneID: string;
    readonly workspaceID: string;
    readonly windowID?: string;
}

export type WsServerMessage =
    | WsWelcomeMessage
    | WsRejectedMessage
    | WsSnapshotMessage
    | WsDeltaMessage
    | WsCommandReplyMessage
    | WsNotificationMessage
    | WsClipboardWriteMessage
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
    | WsWebViewFocusMessage
    | WsRevealPaneMessage
    | WsHotkeyStatusMessage
    | WsShellActivationMessage
    | WsWorkspaceSelectionMessage;

export type WsMessage = WsClientMessage | WsServerMessage;
