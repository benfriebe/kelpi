/**
 * Request shapes for every wire command (wire-protocol.md §6).
 *
 * Field names are the snake_case keys as they appear on the wire. Fields the decoder
 * defaults (per §6's "defaults" columns) are non-optional here and always carry the
 * documented default; fields with handler-chosen defaults stay optional/absent.
 *
 * `session_id` / `agent` ride along on any command for the dual-fire (§3.1); they live on
 * the decode result's `hook` record rather than on the individual message shapes, so a
 * daemon can only act on them through the dual-fire path (except `session-start` /
 * `session-end`, where the id IS the payload).
 */

import type { AgentKind, DropZone, MoveDirection, SplitDirection, WorkspaceColor } from './vocab.js';

/** The shared pane-target triple (§5.7). */
export interface PaneTargetScope {
    pane_id?: string | undefined;
    target?: string | undefined;
    workspace?: string | undefined;
}

// ── 6.1 Agent lifecycle events (fire-and-forget; `pane_id` mandatory) ────────────────

export interface AgentStartMessage {
    command: 'start';
    pane_id: string;
    agent: AgentKind;
}

export interface AgentStopMessage {
    command: 'stop';
    pane_id: string;
    background_tasks: number;
}

export interface AgentErrorMessage {
    command: 'error';
    pane_id: string;
    message: string;
}

export interface AgentNotificationMessage {
    command: 'notification';
    pane_id: string;
    title: string;
    body: string;
    background_tasks: number;
}

export interface SessionStartMessage {
    command: 'session-start';
    pane_id: string;
    session_id: string;
    agent: AgentKind;
    /**
     * The effective profile name (`KELPI_PROFILE`) of the environment the session runs in,
     * reported by the hook so a later resume can rebuild the same environment. Optional —
     * absent from older CLIs.
     */
    profile?: string | undefined;
}

export interface SessionEndMessage {
    command: 'session-end';
    pane_id: string;
    session_id: string;
}

// ── 6.2 Pane commands ───────────────────────────────────────────────────────────────

export interface PaneSplitMessage extends PaneTargetScope {
    command: 'pane-split';
    direction?: SplitDirection | undefined;
    path?: string | undefined;
    name?: string | undefined;
}

export interface PaneCreateMessage extends PaneTargetScope {
    command: 'pane-create';
    path?: string | undefined;
    name?: string | undefined;
}

export interface PaneCloseMessage extends PaneTargetScope {
    command: 'pane-close';
}

export interface PaneNameMessage extends PaneTargetScope {
    command: 'pane-name';
    name: string;
}

export interface PaneSendMessage extends PaneTargetScope {
    command: 'pane-send';
    target: string;
    text: string;
    bare: boolean;
}

export interface PaneSendKeyMessage extends PaneTargetScope {
    command: 'pane-send-key';
    target: string;
    /** Raw wire value: validated (lowercased) by the handler, which errors rather than drops. */
    key: string;
}

export interface PaneResizeMessage extends PaneTargetScope {
    command: 'pane-resize';
    /** Exactly one of `ratio` / `delta` is present (both or neither drops the message). */
    ratio?: number | undefined;
    delta?: number | undefined;
}

export interface PaneMoveMessage {
    command: 'pane-move';
    pane_id: string;
    direction: MoveDirection;
}

export interface PaneMoveAdjacentMessage extends PaneTargetScope {
    command: 'pane-move-adjacent';
    target: string;
    anchor: string;
    zone: DropZone;
}

export interface PaneMoveToWorkspaceMessage {
    command: 'pane-move-to-workspace';
    pane_id: string;
    /** Destination workspace name-or-id. */
    name: string;
    /** Raw wire field: the create flag rides here as the literal string `"true"`. */
    text?: string | undefined;
    /** Decoded quirk (§6.2): `text === "true"`, a string comparison, not a boolean. */
    create: boolean;
}

export interface PaneListMessage {
    command: 'pane-list';
    pane_id?: string | undefined;
    workspace?: string | undefined;
    /** Raw wire value; an unknown scope is a handler error (`unknown scope: <scope>`). */
    scope?: string | undefined;
}

export interface PaneCaptureMessage extends PaneTargetScope {
    command: 'pane-capture';
    lines?: number | undefined;
    scrollback: boolean;
}

export interface PaneSyncMessage {
    command: 'pane-sync';
    pane_id?: string | undefined;
    workspace?: string | undefined;
    /** Raw wire value (`on|off|toggle|status`); validated by the handler. */
    action: string;
}

export interface PaneSyncExcludeMessage extends PaneTargetScope {
    command: 'pane-sync-exclude';
    target: string;
    excluded: boolean;
}

// ── 6.3 Workspace commands ──────────────────────────────────────────────────────────

export interface WorkspaceListMessage {
    command: 'workspace-list';
    group?: string | undefined;
}

export interface WorkspaceCreateMessage {
    command: 'workspace-create';
    name?: string | undefined;
    path?: string | undefined;
    color?: WorkspaceColor | undefined;
    group?: string | undefined;
    profile?: string | undefined;
    worktree?: string | undefined;
    branch?: string | undefined;
    update_main: boolean;
    repo?: string | undefined;
}

export interface WorkspaceMoveMessage {
    command: 'workspace-move';
    name: string;
    /** Absent = move to top level. */
    group?: string | undefined;
    index?: number | undefined;
}

export interface WorkspaceDeleteMessage {
    command: 'workspace-delete';
    name: string;
    force: boolean;
    /**
     * §WS-156 / §APP-067 — may this delete leave ZERO workspaces behind?
     *
     * **Not a wire field.** It has no entry in wire-protocol.md §7's dictionary and `decode.ts`
     * never reads it, so nothing arriving over the control socket can set it: `kelpi workspace
     * delete` is byte-identical and still refuses the last workspace. It exists on this message
     * because the GUI's own `delete-workspace` verb — WS-only, like `rename-workspace`, and
     * therefore outside the CLI's vocabulary forever — CONSTRUCTS this message directly
     * (`daemon/src/ws/sync.ts`) rather than decoding one.
     *
     * The shipped app is deliberately asymmetric here: the CLI and the sidebar's Delete both
     * refuse at one workspace (`.disabled(store.workspaces.count <= 1)`), while ⌘W closing the
     * last pane of the last workspace may reach zero — and the window lands on the "No workspace
     * selected" empty state, which exists precisely because it can. The port put that guard in
     * the one handler both routes share, which made the GUI stricter than the Swift and the empty
     * state unreachable by any gesture. This is that asymmetry, restored.
     */
    allow_last?: boolean | undefined;
}

export interface WorkspaceProfileMessage {
    command: 'workspace-profile';
    name: string;
    /** Absent (or empty on the wire) = clear the assignment. */
    profile?: string | undefined;
}

export interface WorkspaceLabelMessage {
    command: 'workspace-label';
    name: string;
    /** Raw wire value (`set|add|remove|clear`); an unknown op is a handler error. */
    label_op: string;
    label_values: readonly string[];
}

// ── 6.4 Group commands ──────────────────────────────────────────────────────────────

export interface GroupListMessage {
    command: 'group-list';
}

export interface GroupCreateMessage {
    command: 'group-create';
    name: string;
    color?: WorkspaceColor | undefined;
}

export interface GroupRenameMessage {
    command: 'group-rename';
    name: string;
    new_name: string;
}

export interface GroupDeleteMessage {
    command: 'group-delete';
    name: string;
    cascade: boolean;
}

export interface GroupReorderMessage {
    command: 'group-reorder';
    name: string;
    order: readonly string[];
}

export interface GroupSortMessage {
    command: 'group-sort';
    name: string;
    /** Raw wire value (`name|last-activity|last-accessed|last-modified`). */
    by: string;
    descending: boolean;
}

// ── 6.5 Layout commands ─────────────────────────────────────────────────────────────

export interface LayoutCycleMessage {
    command: 'layout-cycle';
    pane_id: string;
}

export interface LayoutSelectMessage {
    command: 'layout-select';
    pane_id: string;
    /** Raw layout name; validated silently by the handler. */
    name: string;
}

// ── 6.6 File / diff commands ────────────────────────────────────────────────────────

export interface OpenMessage {
    command: 'open';
    path: string;
    pane_id?: string | undefined;
    reuse: boolean;
}

export interface DiffMessage {
    command: 'diff';
    repo_path: string;
    target_path?: string | undefined;
    pane_id?: string | undefined;
}

// ── 6.7 Graft commands ──────────────────────────────────────────────────────────────

export interface GraftStartMessage {
    command: 'graft-start';
    workspace?: string | undefined;
    repo?: string | undefined;
    pane_id?: string | undefined;
}

export interface GraftStopMessage {
    command: 'graft-stop';
    workspace?: string | undefined;
    repo?: string | undefined;
    pane_id?: string | undefined;
}

export interface GraftStatusMessage {
    command: 'graft-status';
}

// ── 6.8 ping ────────────────────────────────────────────────────────────────────────

export interface PingMessage {
    command: 'ping';
}

// ── 6.9 Web pane commands ───────────────────────────────────────────────────────────

export interface WebOpenMessage {
    command: 'web-open';
    url: string;
    private: boolean;
    /** Informational only: scopes which workspace the new pane lands in. */
    pane_id?: string | undefined;
    /**
     * WEB-011: the pane the new one splits off, and which way it splits.
     *
     * The CLI never sends either — `kelpi web open` splits the *focused* pane, exactly as Swift's
     * `handleWebOpen` does. They exist for the two GUI gestures Swift performs in-process and
     * this port has to express on the wire: the pane header's globe button (click = split right,
     * ⇧-click = split down) and the pane context menu's "New Web Pane". Both names are already
     * in the wire field dictionary (§7), so nothing new rides the protocol.
     */
    target?: string | undefined;
    direction?: SplitDirection | undefined;
}

export interface WebNavigateMessage extends PaneTargetScope {
    command: 'web-navigate';
    url: string;
}

export interface WebUrlMessage extends PaneTargetScope {
    command: 'web-url';
}

export interface WebBackMessage extends PaneTargetScope {
    command: 'web-back';
}

export interface WebForwardMessage extends PaneTargetScope {
    command: 'web-forward';
}

export interface WebReloadMessage extends PaneTargetScope {
    command: 'web-reload';
    hard: boolean;
}

export interface WebCaptureMessage extends PaneTargetScope {
    command: 'web-capture';
    /** Raw wire value, defaulted to `meta`; an unknown mode is a handler error. */
    mode: string;
}

export interface WebTabsMessage extends PaneTargetScope {
    command: 'web-tabs';
}

export interface WebTabNewMessage extends PaneTargetScope {
    command: 'web-tab-new';
    /** Empty string = blank tab. */
    url: string;
    make_active: boolean;
}

export interface WebTabCloseMessage extends PaneTargetScope {
    command: 'web-tab-close';
    tab: string;
}

export interface WebTabSelectMessage extends PaneTargetScope {
    command: 'web-tab-select';
    tab: string;
}

export interface WebConsoleMessage extends PaneTargetScope {
    command: 'web-console';
    since: number;
    level?: string | undefined;
    clear: boolean;
    follow: boolean;
}

export interface WebInspectMessage extends PaneTargetScope {
    command: 'web-inspect';
    send_to?: string | undefined;
    submit: boolean;
    disarm: boolean;
}

export interface WebInspectResultMessage extends PaneTargetScope {
    command: 'web-inspect-result';
    clear: boolean;
}

export interface WebPrivateMessage extends PaneTargetScope {
    command: 'web-private';
    private: boolean;
}

export interface WebCookiesListMessage extends PaneTargetScope {
    command: 'web-cookies-list';
}

export interface WebCookiesClearMessage extends PaneTargetScope {
    command: 'web-cookies-clear';
    domain?: string | undefined;
    all: boolean;
}

export interface WebCookiesDeleteMessage extends PaneTargetScope {
    command: 'web-cookies-delete';
    name: string;
    domain?: string | undefined;
}

export interface WebClickMessage extends PaneTargetScope {
    command: 'web-click';
    selector: string;
    double: boolean;
    right: boolean;
    /** `at_x`/`at_y` only apply when BOTH are present; otherwise the element center is used. */
    at_x?: number | undefined;
    at_y?: number | undefined;
}

export interface WebTypeMessage extends PaneTargetScope {
    command: 'web-type';
    selector: string;
    /** Required present; an empty string is allowed. */
    text: string;
    submit: boolean;
    replace: boolean;
}

export interface WebQueryTextMessage extends PaneTargetScope {
    command: 'web-q-text';
    selector: string;
    max_bytes?: number | undefined;
}

export interface WebQueryAttrMessage extends PaneTargetScope {
    command: 'web-q-attr';
    selector: string;
    attribute: string;
}

export interface WebQueryCountMessage extends PaneTargetScope {
    command: 'web-q-count';
    selector: string;
}

export interface WebQueryExistsMessage extends PaneTargetScope {
    command: 'web-q-exists';
    selector: string;
}

export interface WebQueryDomMessage extends PaneTargetScope {
    command: 'web-q-dom';
    selector: string;
    max_bytes?: number | undefined;
}

export interface WebWaitMessage extends PaneTargetScope {
    /** Exactly one of `selector` / `url_match` is present. */
    command: 'web-wait';
    selector?: string | undefined;
    url_match?: string | undefined;
    for?: string | undefined;
    /** 0 (or absent) means "the JS-side default", currently 10000 ms. */
    timeout_ms: number;
}

export interface WebSelectMessage extends PaneTargetScope {
    command: 'web-select';
    selector: string;
    /** Required present; an empty string is allowed. */
    value_or_label: string;
}

export interface WebScrollMessage extends PaneTargetScope {
    command: 'web-scroll';
    selector: string;
    /** Raw wire value defaulted to `center` (`start|center|end`). */
    block: string;
    /** Raw wire value defaulted to `instant` (`instant|smooth`). */
    behavior: string;
}

export interface WebHoverMessage extends PaneTargetScope {
    command: 'web-hover';
    selector: string;
}

export interface WebKeyMessage extends PaneTargetScope {
    command: 'web-key';
    key: string;
    /** Absent = `document.activeElement`. */
    selector?: string | undefined;
}

export interface WebExecMessage extends PaneTargetScope {
    command: 'web-exec';
    script: string;
}

// ── Union ───────────────────────────────────────────────────────────────────────────

export type WireMessage =
    | AgentStartMessage
    | AgentStopMessage
    | AgentErrorMessage
    | AgentNotificationMessage
    | SessionStartMessage
    | SessionEndMessage
    | PaneSplitMessage
    | PaneCreateMessage
    | PaneCloseMessage
    | PaneNameMessage
    | PaneSendMessage
    | PaneSendKeyMessage
    | PaneResizeMessage
    | PaneMoveMessage
    | PaneMoveAdjacentMessage
    | PaneMoveToWorkspaceMessage
    | PaneListMessage
    | PaneCaptureMessage
    | PaneSyncMessage
    | PaneSyncExcludeMessage
    | WorkspaceListMessage
    | WorkspaceCreateMessage
    | WorkspaceMoveMessage
    | WorkspaceDeleteMessage
    | WorkspaceProfileMessage
    | WorkspaceLabelMessage
    | GroupListMessage
    | GroupCreateMessage
    | GroupRenameMessage
    | GroupDeleteMessage
    | GroupReorderMessage
    | GroupSortMessage
    | LayoutCycleMessage
    | LayoutSelectMessage
    | OpenMessage
    | DiffMessage
    | GraftStartMessage
    | GraftStopMessage
    | GraftStatusMessage
    | PingMessage
    | WebOpenMessage
    | WebNavigateMessage
    | WebUrlMessage
    | WebBackMessage
    | WebForwardMessage
    | WebReloadMessage
    | WebCaptureMessage
    | WebTabsMessage
    | WebTabNewMessage
    | WebTabCloseMessage
    | WebTabSelectMessage
    | WebConsoleMessage
    | WebInspectMessage
    | WebInspectResultMessage
    | WebPrivateMessage
    | WebCookiesListMessage
    | WebCookiesClearMessage
    | WebCookiesDeleteMessage
    | WebClickMessage
    | WebTypeMessage
    | WebQueryTextMessage
    | WebQueryAttrMessage
    | WebQueryCountMessage
    | WebQueryExistsMessage
    | WebQueryDomMessage
    | WebWaitMessage
    | WebSelectMessage
    | WebScrollMessage
    | WebHoverMessage
    | WebKeyMessage
    | WebExecMessage;

export type WireCommandName = WireMessage['command'];

/**
 * Stage 1 of the parse pipeline (§3): commands matched by name BEFORE the mandatory
 * `pane_id` guard, which is why they work from a plain shell with no `KELPI_PANE_ID`.
 */
export const EXPLICIT_CHAIN_COMMANDS: ReadonlySet<WireCommandName> = new Set([
    'workspace-create',
    'workspace-list',
    'workspace-move',
    'workspace-delete',
    'workspace-profile',
    'workspace-label',
    'group-list',
    'group-create',
    'group-rename',
    'group-delete',
    'group-reorder',
    'group-sort',
    'open',
    'diff',
    'pane-close',
    'pane-list',
    'pane-capture',
    'graft-start',
    'graft-stop',
    'graft-status',
    'ping',
    'pane-sync',
    'pane-sync-exclude',
    'pane-send-key',
    'pane-send',
    'pane-split',
    'pane-create',
    'pane-name',
    'pane-resize',
    'pane-move-adjacent',
    'web-open',
    'web-navigate',
    'web-url',
    'web-back',
    'web-forward',
    'web-reload',
    'web-capture',
    'web-tabs',
    'web-tab-new',
    'web-tab-close',
    'web-tab-select',
    'web-console',
    'web-inspect',
    'web-inspect-result',
    'web-private',
    'web-cookies-list',
    'web-cookies-clear',
    'web-cookies-delete',
    'web-click',
    'web-type',
    'web-q-text',
    'web-q-attr',
    'web-q-count',
    'web-q-exists',
    'web-q-dom',
    'web-wait',
    'web-select',
    'web-scroll',
    'web-hover',
    'web-key',
    'web-exec'
]);

/**
 * Stage 3 of the parse pipeline (§3): reached only after the mandatory-`pane_id` guard,
 * so a missing or syntactically invalid `pane_id` drops these messages.
 */
export const PANE_ID_REQUIRED_COMMANDS: ReadonlySet<WireCommandName> = new Set([
    'start',
    'stop',
    'error',
    'notification',
    'session-start',
    'session-end',
    'pane-move',
    'pane-move-to-workspace',
    'layout-cycle',
    'layout-select'
]);

export const WIRE_COMMANDS: readonly WireCommandName[] = [
    ...EXPLICIT_CHAIN_COMMANDS,
    ...PANE_ID_REQUIRED_COMMANDS
];

export function isWireCommand(command: string): command is WireCommandName {
    return (
        EXPLICIT_CHAIN_COMMANDS.has(command as WireCommandName) ||
        PANE_ID_REQUIRED_COMMANDS.has(command as WireCommandName)
    );
}
