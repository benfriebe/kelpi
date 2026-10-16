/**
 * Reply payloads (wire-protocol.md §6, cli.md §9–§16).
 *
 * Success replies always carry `ok: true`; failures carry `ok: false` plus a
 * human-readable `error`, and may carry typed extras (`active_agents`, `found`, …) that
 * scripts branch on. Field names ARE the contract; ordering and whitespace are not.
 * UUID-valued fields are emitted uppercase; timestamps are ISO 8601 UTC.
 */

import type { AgentKind, GraftStatus, PaneStatus, PaneType, WorkspaceColor } from '../wire/vocab.js';

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
    /**
     * Split-path string of the enclosing split (pane-layout.md §7.3, wire-protocol.md §6.2):
     * `"d"` is the root split, each appended `L`/`R` steps into a split's first/second
     * child (`"dL"`, `"dLR"`). The daemon copies `ResizeResult.splitPath` onto the wire
     * unchanged, so this is the same path `set-split-ratio` and `layout-select` accept;
     * it is NOT an index array (issue #49: this field once lied as `number[]`).
     */
    readonly split_path: string;
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
    readonly muted: boolean;
    /** The sidebar icon in the flat DB spelling (`"emoji:🔥"`); absent for the letter avatar. */
    readonly icon?: string;
    /** Max across the workspace's panes; absent when it has no panes. */
    readonly last_activity_at?: string;
    /** The first pane carrying one. */
    readonly agent_session_id?: string;
    /** Both present or both absent (absent for top-level workspaces). */
    readonly group_id?: string;
    readonly group_name?: string;
    /**
     * app-state-core.md §2.9: the workspace this one is nested under. Both present or both
     * absent (absent when not nested). A nested workspace reports its parent's group.
     */
    readonly parent_id?: string;
    readonly parent_name?: string;
    /** The workspace's repo associations, in stored order; absent when it has none. */
    readonly repos?: readonly WorkspaceListRepo[];
    /**
     * workspace-feature.md §11: the GitHub PRs found for those associations' branches, open
     * first; absent when there are none (or PR status is off, or gh is unavailable).
     */
    readonly pull_requests?: readonly WorkspaceListPullRequest[];
}

/** One PR on a `workspace-list` entry (workspace-feature.md §11). */
export interface WorkspaceListPullRequest {
    readonly number: number;
    readonly title: string;
    readonly url: string;
    readonly state: 'open' | 'draft' | 'merged' | 'closed';
    /** The association's repo, as in `repos[].repo_id`. */
    readonly repo_id: string;
    readonly branch: string;
}

/** One repo association on a `workspace-list` entry (app-state-core.md §5.5). */
export interface WorkspaceListRepo {
    readonly repo_id: string;
    /** The registry's display name; absent when the repo is no longer registered. */
    readonly repo_name?: string;
    readonly repo_path?: string;
    /** The checkout this workspace works in: the repo itself, or one of its worktrees. */
    readonly worktree_path: string;
    /** Absent when unknown (a detached HEAD, or before the first read). */
    readonly branch?: string;
}

export interface WorkspaceListReply extends ReplySuccess {
    readonly workspaces: readonly WorkspaceListEntry[];
    /**
     * app-state-core.md §2.9: the parent a `parent`-filtered list resolved, both present exactly
     * when the request carried `parent`. A daemon that predates nesting omits them (and ignores
     * the filter), which is how a caller tells its unfiltered reply from a filtered one.
     */
    readonly parent_id?: string;
    readonly parent_name?: string;
}

export interface WorkspaceCreateReply extends ReplySuccess {
    readonly workspace_id: string;
    readonly workspace_name: string;
    /** The state the workspace was created in; lets `--muted` confirm it was applied. */
    readonly muted: boolean;
    /** The icon it was created with; absent when none was asked for. Confirms `--icon`. */
    readonly icon?: string;
    /** Echoed group name when the workspace was placed in a group. */
    readonly group?: string;
    /** Worktree flow only. */
    readonly worktree_path?: string;
    readonly branch?: string;
    /** Worktree flow only: whether it branched off the freshly fetched `origin/<default>`. */
    readonly update_main?: boolean;
    /** The repository the workspace was associated with (the worktree's parent, if any). */
    readonly repo_path?: string;
    /**
     * §2.9: the parent it was nested under; absent when not nested. Lets `--parent`/`--nested`
     * tell a daemon that predates nesting (which drops the field and creates it unnested).
     */
    readonly parent_id?: string;
    readonly parent_name?: string;
    /**
     * §2.9: set when the parent was deleted (or nested itself) while a worktree create's git work
     * ran. The worktree already existed, so the workspace was created at the top level instead;
     * `parent_lost_reason` says what happened. Absent otherwise.
     */
    readonly parent_lost?: boolean;
    readonly parent_lost_reason?: string;
}

export interface WorkspaceDeleteReply extends ReplySuccess {
    readonly workspace_id: string;
    readonly workspace_name: string;
    /** A shell pane's cwd (else the first pane's); absent for an empty workspace. */
    readonly path?: string;
    /** §2.9 `cascade`: the nested workspaces deleted with it; absent when none were. */
    readonly deleted_children?: readonly string[];
    /** Their names, index for index with `deleted_children`; present exactly when it is. */
    readonly deleted_child_names?: readonly string[];
}

/** app-state-core.md §2.9 `workspace-nest`. */
export interface WorkspaceNestReply extends ReplySuccess {
    readonly workspace_id: string;
    readonly workspace_name: string;
    readonly parent_id: string;
    readonly parent_name: string;
    /** The workspace's position among the parent's children after the move. */
    readonly index: number;
}

/** Delete refusals include visible/parked running, waiting and resumable idle panes. */
export interface WorkspaceDeleteFailure extends ReplyFailure {
    /** Total of running + waiting + inactive (legacy field name). */
    readonly active_agents?: number;
    readonly running?: number;
    readonly waiting?: number;
    readonly inactive?: number;
}

export interface WorkspaceLabelReply extends ReplySuccess {
    readonly workspace_id: string;
    readonly workspace_name: string;
    /** The post-mutation label set. */
    readonly labels: readonly string[];
}

export interface WorkspaceMuteReply extends ReplySuccess {
    readonly workspace_id: string;
    readonly workspace_name: string;
    /** The post-mutation state. */
    readonly muted: boolean;
}

export interface WorkspaceRenameReply extends ReplySuccess {
    readonly workspace_id: string;
    /** The name the workspace has now (the trimmed `new_name`). */
    readonly workspace_name: string;
    /** The name it had before; equal to `workspace_name` when the rename changed nothing. */
    readonly old_name: string;
}

export interface WorkspaceIconReply extends ReplySuccess {
    readonly workspace_id: string;
    readonly workspace_name: string;
    /** The icon the workspace has now, in the flat DB spelling; `null` = the letter avatar. */
    readonly icon: string | null;
    /** The icon it had before, so the CLI can say a same-icon request changed nothing. */
    readonly old_icon: string | null;
}

export interface WorkspaceColorReply extends ReplySuccess {
    readonly workspace_id: string;
    readonly workspace_name: string;
    /** The colour the workspace has now, one of the ten `WORKSPACE_COLORS`. */
    readonly color: WorkspaceColor;
    /** The colour it had before, so the CLI can say a same-colour request changed nothing. */
    readonly old_color: WorkspaceColor;
}

// ── group replies ───────────────────────────────────────────────────────────────────

export interface GroupListMember {
    readonly id: string;
    readonly name: string;
    /**
     * app-state-core.md §2.9: set on a member's nested workspace, which follows its parent's group
     * and is listed right after it. Both present or both absent.
     */
    readonly parent_id?: string;
    readonly parent_name?: string;
}

export interface GroupListEntry {
    readonly id: string;
    readonly name: string;
    /** Present only when the group has a color. */
    readonly color?: string;
    readonly workspaces: readonly GroupListMember[];
    /** Present only when the group has a default repository (app-state-core.md §5.5). */
    readonly repo?: GroupRepoRef;
    /** Present exactly when `repo` is. */
    readonly create_worktree?: boolean;
}

export interface GroupRepoRef {
    readonly id: string;
    readonly name: string;
    readonly path: string;
}

export interface GroupListReply extends ReplySuccess {
    readonly groups: readonly GroupListEntry[];
}

/** `group-set-repo`: the group's state after the change. `repo` is null when it has none. */
export interface GroupSetRepoReply extends ReplySuccess {
    readonly group_id: string;
    readonly group_name: string;
    readonly repo: GroupRepoRef | null;
    readonly create_worktree: boolean;
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
    /** `true` when a stop failed on the parent's index lock and has not finished yet (#342). */
    readonly stop_incomplete?: true;
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
    /**
     * `false` when the tab has no browser view behind it: its renderer died and the daemon has
     * not rebuilt it (web-pane.md §5.2, issue #76). **Absent means live**, so a healthy reply is
     * byte-identical to the one that shipped before the flag existed. `kelpi web reload` on such
     * a tab rebuilds the pane instead of failing `web pane has no live tab`.
     */
    readonly live?: boolean;
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

// ── agent replies ─────────────────────────────────────────────────────────────────────

/** `permission-request` (#388, wire-protocol.md §6.1.1). `message` only on `deny`. */
export interface PermissionRequestReply extends ReplySuccess {
    readonly behavior: 'allow' | 'deny' | 'abstain';
    readonly message?: string;
    /** The provider the daemon asked; absent when none could be. */
    readonly provider?: string;
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
    | WorkspaceMuteReply
    | WorkspaceRenameReply
    | WorkspaceIconReply
    | WorkspaceColorReply
    | GroupListReply
    | GroupOrderReply
    | GraftStartReply
    | GraftStopReply
    | GraftStatusReply
    | PingReply
    | PermissionRequestReply
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
