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

/** Bumped only on a breaking change; the daemon serves `daemon-v<version>` run files. */
export const WS_PROTOCOL_VERSION = 1;

export const WS_CLIENT_KINDS = ['electron', 'browser', 'cli'] as const;
export type WsClientKind = (typeof WS_CLIENT_KINDS)[number];

export interface WsClientInfo {
    readonly kind: WsClientKind;
    readonly name?: string;
    readonly version?: string;
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

export type WsClientMessage =
    | WsHelloMessage
    | WsAttachPaneMessage
    | WsDetachPaneMessage
    | WsResizePaneMessage
    | WsFocusReportMessage
    | WsVisibilityReportMessage
    | WsCommandMessage
    | WsPingMessage;

// ── server → client ─────────────────────────────────────────────────────────────────

export interface WsWelcomeMessage {
    readonly type: 'welcome';
    readonly protocolVersion: number;
    readonly clientID: string;
    readonly daemon: {
        readonly version: string;
        readonly build: string;
        readonly pid: number;
    };
}

export const WS_REJECTION_CODES = ['protocol-mismatch', 'unauthorized', 'server-error'] as const;
export type WsRejectionCode = (typeof WS_REJECTION_CODES)[number];

/** Sent instead of `welcome`; the socket closes right after. */
export interface WsRejectedMessage {
    readonly type: 'rejected';
    readonly code: WsRejectionCode;
    readonly message: string;
    readonly protocolVersion: number;
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

/** The daemon cannot serve deltas from the client's seq; it must take a fresh snapshot. */
export interface WsResyncRequiredMessage {
    readonly type: 'resync-required';
    readonly reason: 'seq-gap' | 'snapshot-expired';
}

export interface WsPongMessage {
    readonly type: 'pong';
    readonly id: string;
}

export type WsServerMessage =
    | WsWelcomeMessage
    | WsRejectedMessage
    | WsSnapshotMessage
    | WsDeltaMessage
    | WsCommandReplyMessage
    | WsNotificationMessage
    | WsPaneExitMessage
    | WsResyncRequiredMessage
    | WsPongMessage;

export type WsMessage = WsClientMessage | WsServerMessage;
