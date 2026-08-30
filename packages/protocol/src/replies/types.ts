/**
 * Reply payloads (wire-protocol.md §6, cli.md §9–§16).
 *
 * Success replies always carry `ok: true`; failures carry `ok: false` plus a
 * human-readable `error`, and may carry typed extras (`active_agents`, `found`, …) that
 * scripts branch on. Field names ARE the contract; ordering and whitespace are not.
 * UUID-valued fields are emitted uppercase; timestamps are ISO 8601 UTC.
 */

import type { AgentKind, GraftStatus, PaneStatus, PaneType } from '../wire/vocab.js';

export interface ReplyFailure {
    readonly ok: false;
    readonly error: string;
}

export interface ReplySuccess {
    readonly ok: true;
}

// ── pane replies ────────────────────────────────────────────────────────────────────

/** Shared by `pane-split`, `pane-create`, `pane-close`, `pane-name`. */
export interface PaneMutationReply extends ReplySuccess {
    readonly pane_id: string;
    readonly workspace_id: string;
    readonly workspace_name: string;
    /** Present only when the pane has (or was given) a label. */
    readonly label?: string;
}

export interface PaneSendReply extends PaneMutationReply {
    readonly bare: boolean;
}

export interface PaneSendKeyReply extends PaneMutationReply {
    readonly key: string;
}

export interface PaneResizeReply extends PaneMutationReply {
    /** 0/1 child indices from the layout root to the enclosing split. */
    readonly split_path: readonly number[];
    /** The split's stored first-child ratio after the write. */
    readonly ratio: number;
    /** The clamped share of the addressed pane. */
    readonly target_share: number;
}

export interface PaneMoveAdjacentReply extends ReplySuccess {
    readonly pane_id: string;
    readonly anchor_id: string;
    readonly zone: string;
    readonly workspace_id: string;
    readonly workspace_name: string;
    readonly label?: string;
}

export interface PaneCaptureReply extends PaneMutationReply {
    readonly text: string;
}

export interface PaneListEntry {
    readonly id: string;
    readonly type: PaneType;
    readonly workspace_id: string;
    readonly workspace_name: string;
    readonly working_directory: string;
    readonly status: PaneStatus;
    readonly is_focused: boolean;
    readonly is_active_workspace: boolean;
    readonly created_at: string;
    readonly last_activity_at: string;
    readonly label?: string;
    readonly title?: string;
    readonly git_branch?: string;
    /** Full session id, never truncated (the CLI does the truncation for its table). */
    readonly agent_session_id?: string;
    /** Last-known agent kind, not "attached now". */
    readonly agent?: AgentKind;
    /** Present only when > 0. */
    readonly background_tasks?: number;
    readonly file_path?: string;
    /** `group_id` and `group_name` are both present or both absent (top-level workspace). */
    readonly group_id?: string;
    readonly group_name?: string;
}

export interface PaneListReply extends ReplySuccess {
    readonly panes: readonly PaneListEntry[];
}

export interface SyncExcludedEntry {
    readonly id: string;
    readonly label?: string;
}

/** Shared by `pane-sync` (all four actions) and `pane-sync-exclude`. */
export interface PaneSyncReply extends ReplySuccess {
    readonly workspace_id: string;
    readonly workspace_name: string;
    readonly active: boolean;
    /** Sorted lexicographically. */
    readonly synced_pane_ids: readonly string[];
    /** Sorted by id. */
    readonly excluded: readonly SyncExcludedEntry[];
}

// ── workspace replies ───────────────────────────────────────────────────────────────

export interface WorkspaceListEntry {
    readonly id: string;
    readonly name: string;
    readonly color: string;
    readonly pane_count: number;
    readonly is_active: boolean;
    readonly created_at: string;
    readonly last_accessed_at: string;
    /** Always present, possibly empty. */
    readonly labels: readonly string[];
    /** Max across the workspace's panes; absent when it has no panes. */
    readonly last_activity_at?: string;
    /** The first pane carrying one. */
    readonly agent_session_id?: string;
    /** Both present or both absent (absent for top-level workspaces). */
    readonly group_id?: string;
    readonly group_name?: string;
}

export interface WorkspaceListReply extends ReplySuccess {
    readonly workspaces: readonly WorkspaceListEntry[];
}

export interface WorkspaceCreateReply extends ReplySuccess {
    readonly workspace_id: string;
    readonly workspace_name: string;
    /** Echoed group name when the workspace was placed in a group. */
    readonly group?: string;
    /** Worktree flow only. */
    readonly worktree_path?: string;
    readonly branch?: string;
}

export interface WorkspaceDeleteReply extends ReplySuccess {
    readonly workspace_id: string;
    readonly workspace_name: string;
    /** A shell pane's cwd (else the first pane's); absent for an empty workspace. */
    readonly path?: string;
}

/** The running-agents refusal carries the count so scripts can branch without parsing text. */
export interface WorkspaceDeleteFailure extends ReplyFailure {
    readonly active_agents?: number;
}

export interface WorkspaceLabelReply extends ReplySuccess {
    readonly workspace_id: string;
    readonly workspace_name: string;
    /** The post-mutation label set. */
    readonly labels: readonly string[];
}

// ── group replies ───────────────────────────────────────────────────────────────────

export interface GroupListMember {
    readonly id: string;
    readonly name: string;
}

export interface GroupListEntry {
    readonly id: string;
    readonly name: string;
    /** Present only when the group has a color. */
    readonly color?: string;
    readonly workspaces: readonly GroupListMember[];
}

export interface GroupListReply extends ReplySuccess {
    readonly groups: readonly GroupListEntry[];
}

/** Shared by `group-reorder` and `group-sort`. */
export interface GroupOrderReply extends ReplySuccess {
    readonly group_id: string;
    readonly group_name: string;
    /** Current members only, full uppercase UUIDs, in the final child order. */
    readonly order: readonly string[];
}

// ── graft replies ───────────────────────────────────────────────────────────────────

export interface GraftStartedEntry {
    readonly association_id: string;
    readonly worktree_path: string;
    readonly branch: string;
    readonly parent_repo_root: string;
}

export interface GraftStartReply extends ReplySuccess {
    readonly started: readonly GraftStartedEntry[];
    /** Present on partial success (the last error). */
    readonly partial_error?: string;
}

export interface GraftStopFailure {
    readonly association_id: string;
    readonly error: string;
}

export interface GraftStopReply {
    /** False iff any stop failed; `stopped` is present either way. */
    readonly ok: boolean;
    readonly stopped: readonly string[];
    readonly failed?: readonly GraftStopFailure[];
}

export interface GraftSessionEntry {
    readonly association_id: string;
    readonly worktree_path: string;
    readonly parent_repo_root: string;
    readonly branch: string;
    readonly status: GraftStatus;
    /** Present when status is `error`. */
    readonly error?: string;
    readonly stash_ref?: string;
    readonly last_sync?: string;
}

export interface GraftStatusReply extends ReplySuccess {
    readonly sessions: readonly GraftSessionEntry[];
}

// ── ping ────────────────────────────────────────────────────────────────────────────

export interface PingReply extends ReplySuccess {
    /** `"unknown"` when unavailable. */
    readonly version: string;
    readonly build: string;
    /** The server process id — `kelpi doctor` uses it to tell who owns the socket. */
    readonly pid: number;
}

// ── web pane replies (the fields the CLI parses; cli.md §15) ────────────────────────

export interface WebPaneReplyBase extends ReplySuccess {
    readonly pane_id: string;
    readonly workspace_id: string;
    readonly tab_id?: string;
}

export interface WebOpenReply extends WebPaneReplyBase {
    readonly tab_id: string;
    /** The normalized URL. */
    readonly url: string;
    readonly private: boolean;
}

export interface WebNavigateReply extends WebPaneReplyBase {
    readonly url: string;
}

export interface WebUrlReply extends WebPaneReplyBase {
    readonly url: string;
    readonly title: string;
}

export interface WebCaptureReply extends WebPaneReplyBase {
    readonly mode: string;
    readonly url?: string;
    readonly title?: string;
    readonly byte_count?: number;
    readonly text?: string;
    readonly html?: string;
    /** `screenshot` mode: a written file path, else the inline base64 PNG. */
    readonly path?: string;
    readonly png_base64?: string;
}

export interface WebTabEntry {
    readonly id: string;
    readonly index: number;
    readonly active: boolean;
    readonly title: string;
    readonly url: string;
}

export interface WebTabsReply extends WebPaneReplyBase {
    readonly tabs: readonly WebTabEntry[];
}

export interface WebTabNewReply extends WebPaneReplyBase {
    readonly tab_id: string;
    readonly url: string;
    readonly active: boolean;
}

export interface WebTabMutationReply extends WebPaneReplyBase {
    readonly tab_id: string;
}

export interface WebConsoleEntry {
    readonly seq: number;
    readonly level: string;
    readonly message: string;
}

export interface WebConsoleReply extends WebPaneReplyBase {
    readonly lines: readonly WebConsoleEntry[];
    /** Lines lost to the ring buffer before this batch. */
    readonly dropped?: number;
    readonly next_since?: number;
}

/** One pushed line of the `web-console --follow` stream (§2.4). */
export interface WebConsoleStreamLine {
    readonly seq: number;
    readonly level: string;
    readonly message: string;
    readonly dropped?: number;
}

export interface WebInspectReply extends WebPaneReplyBase {
    readonly armed: boolean;
    /** Target pane id, or an empty string when the picker only stores the result. */
    readonly send_to: string;
    readonly submit: boolean;
}

export interface WebInspectResultEntry {
    readonly selector: string;
    readonly url: string;
    readonly tag: string;
}

export interface WebInspectResultReply extends WebPaneReplyBase {
    readonly results: readonly WebInspectResultEntry[];
}

export interface WebPrivateReply extends WebPaneReplyBase {
    readonly private: boolean;
    readonly changed: boolean;
}

export interface WebCookieEntry {
    readonly domain: string;
    readonly name: string;
    readonly value: string;
}

export interface WebCookiesListReply extends WebPaneReplyBase {
    readonly cookies: readonly WebCookieEntry[];
}

export interface WebCookiesClearReply extends WebPaneReplyBase {
    readonly deleted: number;
    readonly cleared_site_data?: boolean;
}

export interface WebCookiesDeleteReply extends WebPaneReplyBase {
    /** Zero means "no cookie matched" — the CLI exits 1 on that. */
    readonly deleted: number;
}

export interface WebClickReply extends WebPaneReplyBase {
    readonly text?: string;
}

export interface WebTypeReply extends WebPaneReplyBase {
    readonly value: string;
}

export interface WebSelectReply extends WebPaneReplyBase {
    readonly value?: string;
    readonly label?: string;
}

export interface WebScrollReply extends WebPaneReplyBase {
    readonly scrolled?: boolean;
}

export interface WebHoverReply extends WebPaneReplyBase {
    readonly hovered?: boolean;
}

export interface WebKeyReply extends WebPaneReplyBase {
    readonly key: string;
}

export interface WebWaitReply extends WebPaneReplyBase {
    readonly condition: string;
    readonly waited_ms: number;
}

export interface WebQueryTextReply extends WebPaneReplyBase {
    readonly text: string;
}

export interface WebQueryAttrReply extends WebPaneReplyBase {
    /** Distinguishes an absent attribute from an empty one; absent → the CLI exits 1. */
    readonly present: boolean;
    readonly value: string;
}

export interface WebQueryCountReply extends WebPaneReplyBase {
    readonly count: number;
}

export interface WebQueryExistsReply extends WebPaneReplyBase {
    /** `kelpi web exists` exits 0/1 from this field — the field name is load-bearing. */
    readonly found: boolean;
}

export interface WebQueryDomReply extends WebPaneReplyBase {
    readonly outer_html: string;
}

export interface WebExecReply extends WebPaneReplyBase {
    readonly result: unknown;
}

export type WireReply =
    | ReplyFailure
    | WorkspaceDeleteFailure
    | PaneMutationReply
    | PaneSendReply
    | PaneSendKeyReply
    | PaneResizeReply
    | PaneMoveAdjacentReply
    | PaneCaptureReply
    | PaneListReply
    | PaneSyncReply
    | WorkspaceListReply
    | WorkspaceCreateReply
    | WorkspaceDeleteReply
    | WorkspaceLabelReply
    | GroupListReply
    | GroupOrderReply
    | GraftStartReply
    | GraftStopReply
    | GraftStatusReply
    | PingReply
    | WebOpenReply
    | WebNavigateReply
    | WebUrlReply
    | WebCaptureReply
    | WebTabsReply
    | WebTabNewReply
    | WebTabMutationReply
    | WebConsoleReply
    | WebInspectReply
    | WebInspectResultReply
    | WebPrivateReply
    | WebCookiesListReply
    | WebCookiesClearReply
    | WebCookiesDeleteReply
    | WebClickReply
    | WebTypeReply
    | WebSelectReply
    | WebScrollReply
    | WebHoverReply
    | WebKeyReply
    | WebWaitReply
    | WebQueryTextReply
    | WebQueryAttrReply
    | WebQueryCountReply
    | WebQueryExistsReply
    | WebQueryDomReply
    | WebExecReply;
