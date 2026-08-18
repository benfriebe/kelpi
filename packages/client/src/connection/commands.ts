/**
 * Command RPC over the sync socket (WP3.1).
 *
 * A client `command` message carries a minted id and a **control-protocol request object** —
 * the exact same `{"command": …}` payload the `nex` CLI writes to `/tmp/nex.sock`. The daemon
 * decodes it through `decodeWireObject` and dispatches it into the same handler table
 * (`daemon/src/ws/sync.ts` → `boot/dispatch.ts`), so the UI cannot drift from the CLI: if a
 * verb is not in `@nex/protocol`'s `WIRE_COMMANDS`, it does not exist here either.
 *
 * Every command settles. Allowlisted verbs answer with the handler's reply; fire-and-forget
 * verbs (`pane-move`, `layout-*`, `workspace-profile`, the agent events) get a synthesized
 * `{ok:true}` from the daemon, and a malformed request comes back as `{ok:false,error}`
 * instead of the control socket's silent drop. A dropped connection rejects everything still
 * in flight rather than leaving the UI spinning.
 *
 * Field names are the wire's snake_case ones; the helpers below are the only place the UI
 * should have to know that.
 *
 * Three verbs the UI needs are **WS-only** (`toggleZoom`, `setGroupCollapsed`,
 * `renameWorkspace`): they are direct-manipulation gestures the CLI has no way to send, so
 * WP3.6 added them to the daemon's WS command dispatch rather than to `WIRE_COMMANDS` — a new
 * CLI verb would be a compatibility surface owed to the Swift CLI forever. They are documented
 * where they are declared, at the bottom of the class.
 *
 * Still unwired for want of any daemon action name: pane status override and
 * reopen-closed-pane. `raw()` is deliberately public so either can be sent the moment the
 * daemon grows the verb, without a new client release.
 */

import type {
    DropZone,
    GroupSortKey,
    JsonObject,
    JsonValue,
    LabelOp,
    MoveDirection,
    NamedKey,
    PredefinedLayout,
    SplitDirection,
    SyncAction,
    WorkspaceColor
} from '@nex/protocol';

import type { ConnectionStatus, NexConnection } from './socket';

export type CommandReply = JsonObject;

export class CommandError extends Error {
    constructor(
        message: string,
        readonly reply?: CommandReply | undefined
    ) {
        super(message);
        this.name = 'CommandError';
    }
}

export class CommandTimeoutError extends CommandError {
    constructor(command: string, timeoutMs: number) {
        super(`command '${command}' timed out after ${timeoutMs}ms`);
        this.name = 'CommandTimeoutError';
    }
}

export class CommandDisconnectedError extends CommandError {
    constructor(command: string) {
        super(`connection lost before '${command}' was answered`);
        this.name = 'CommandDisconnectedError';
    }
}

export function isOkReply(reply: CommandReply): boolean {
    return reply['ok'] === true;
}

export function replyError(reply: CommandReply): string {
    const error = reply['error'];
    return typeof error === 'string' && error.length > 0 ? error : 'command failed';
}

/** `{ok:true,…}` through, `{ok:false,error}` thrown — for call sites that prefer try/catch. */
export function unwrapReply(reply: CommandReply): CommandReply {
    if (isOkReply(reply)) return reply;
    throw new CommandError(replyError(reply), reply);
}

/** Reads a string field off a reply (`pane_id`, `workspace_id`, …). */
export function replyText(reply: CommandReply, key: string): string | undefined {
    const value = reply[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// ── payload construction ────────────────────────────────────────────────────────────

type WireFields = Record<string, JsonValue | undefined>;

/** Absent fields are OMITTED, never sent as null: `null` decodes as absent anyway (§2.2). */
export function wirePayload(command: string, fields: WireFields = {}): JsonObject {
    const payload: Record<string, JsonValue> = { command };
    for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) payload[key] = value;
    }
    return payload as JsonObject;
}

// ── options ─────────────────────────────────────────────────────────────────────────

export interface CommandClientOptions {
    /** Default per-command deadline. */
    readonly timeoutMs?: number | undefined;
    readonly newID?: (() => string) | undefined;
}

export interface SendOptions {
    readonly timeoutMs?: number | undefined;
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
/** A worktree create shells out to `git fetch`; a slow network is not a failure. */
export const WORKTREE_COMMAND_TIMEOUT_MS = 120_000;

/** The shared pane-addressing triple (`PaneTargetScope`, wire §5.7). */
export interface PaneScope {
    /** The calling pane (`NEX_PANE_ID` equivalent); must be a canonical UUID. */
    readonly paneID?: string | undefined;
    /** A pane label or UUID. UUIDs resolve globally; labels need a workspace scope. */
    readonly target?: string | undefined;
    /** Workspace name-or-id, scoping a label lookup. */
    readonly workspace?: string | undefined;
}

function scopeFields(scope: PaneScope): WireFields {
    return { pane_id: scope.paneID, target: scope.target, workspace: scope.workspace };
}

let fallbackCounter = 0;

function defaultNewID(): string {
    const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
    fallbackCounter += 1;
    return `cmd-${Date.now().toString(36)}-${fallbackCounter}`;
}

interface PendingCommand {
    readonly command: string;
    readonly resolve: (reply: CommandReply) => void;
    readonly reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> | null;
}

interface ReportedFocus {
    readonly workspaceID: string;
    readonly paneID: string | null;
}

interface ReportedVisibility {
    readonly workspaceID: string;
    readonly visiblePaneIDs: readonly string[];
    readonly documentVisible: boolean;
}

// ── client ──────────────────────────────────────────────────────────────────────────

export class CommandClient {
    private readonly pending = new Map<string, PendingCommand>();
    private readonly unsubscribers: (() => void)[] = [];
    private readonly newID: () => string;
    private readonly timeoutMs: number;
    private lastFocus: ReportedFocus | null = null;
    private lastVisibility: ReportedVisibility | null = null;
    private disposed = false;

    constructor(
        private readonly connection: NexConnection,
        options: CommandClientOptions = {}
    ) {
        this.newID = options.newID ?? defaultNewID;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

        this.unsubscribers.push(
            connection.on('command-reply', (message) => {
                const entry = this.pending.get(message.id);
                if (entry === undefined) return;
                this.settle(message.id);
                entry.resolve(message.reply);
            })
        );
        this.unsubscribers.push(
            connection.on('status', (status: ConnectionStatus) => {
                if (status === 'connected') {
                    // A reconnect resets the daemon's per-connection session, so this client's
                    // focus/visibility have to be re-asserted or the daemon's suppression math
                    // silently treats us as a background client.
                    this.replayReports();
                    return;
                }
                if (status === 'idle' || status === 'connecting') return;
                this.rejectAll();
            })
        );
    }

    get inFlight(): number {
        return this.pending.size;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const off of this.unsubscribers) off();
        this.unsubscribers.length = 0;
        this.rejectAll();
    }

    /** Any control-protocol request object; resolves with the reply, ok or not. */
    raw(payload: JsonObject, options: SendOptions = {}): Promise<CommandReply> {
        const command = typeof payload['command'] === 'string' ? (payload['command'] as string) : 'unknown';
        if (this.disposed) return Promise.reject(new CommandDisconnectedError(command));
        const id = this.newID();
        const timeoutMs = options.timeoutMs ?? this.timeoutMs;

        return new Promise<CommandReply>((resolve, reject) => {
            const entry: PendingCommand = { command, resolve, reject, timer: null };
            entry.timer = setTimeout(() => {
                this.settle(id);
                reject(new CommandTimeoutError(command, timeoutMs));
            }, timeoutMs);
            this.pending.set(id, entry);
            this.connection.send({ type: 'command', id, payload });
        });
    }

    /** `raw` + `unwrapReply`: rejects when the daemon answers `{ok:false}`. */
    async expect(payload: JsonObject, options: SendOptions = {}): Promise<CommandReply> {
        return unwrapReply(await this.raw(payload, options));
    }

    // ── UI-only reports (not commands: `ws/messages.ts` report frames) ──────────────

    /**
     * Focus is daemon-canonical (last report from any client wins) and doubles as this
     * connection's active-workspace signal (`ws/sync.ts` `focusReport`).
     */
    reportFocus(workspaceID: string, paneID: string | null, options: { force?: boolean } = {}): void {
        if (
            options.force !== true &&
            this.lastFocus !== null &&
            this.lastFocus.workspaceID === workspaceID &&
            this.lastFocus.paneID === paneID
        ) {
            return;
        }
        this.lastFocus = { workspaceID, paneID };
        this.connection.send({ type: 'focus-report', workspaceID, paneID });
    }

    /**
     * Which panes this client actually renders + whether its document is visible. Drives
     * notification suppression and the daemon's "app is active" answer.
     */
    reportVisibility(
        workspaceID: string,
        visiblePaneIDs: readonly string[],
        documentVisible: boolean,
        options: { force?: boolean } = {}
    ): void {
        const next: ReportedVisibility = { workspaceID, visiblePaneIDs: [...visiblePaneIDs], documentVisible };
        if (options.force !== true && this.lastVisibility !== null && sameVisibility(this.lastVisibility, next)) {
            return;
        }
        this.lastVisibility = next;
        this.connection.send({
            type: 'visibility-report',
            workspaceID,
            visiblePaneIDs: next.visiblePaneIDs,
            documentVisible
        });
    }

    /**
     * The active workspace is per-client; the daemon learns it from a report and only nudges
     * its persisted `lastActiveWorkspaceID`. There is no dedicated message — a visibility
     * report is the mechanism (`ws/sync.ts` `setActiveWorkspace`), and a hidden document
     * deliberately cannot claim the active workspace back from a visible client.
     */
    setActiveWorkspaceReport(
        workspaceID: string,
        options: { visiblePaneIDs?: readonly string[]; documentVisible?: boolean } = {}
    ): void {
        const visible = options.visiblePaneIDs ?? this.lastVisibility?.visiblePaneIDs ?? [];
        const documentVisible = options.documentVisible ?? this.lastVisibility?.documentVisible ?? true;
        this.reportVisibility(workspaceID, visible, documentVisible);
    }

    // ── pane verbs ─────────────────────────────────────────────────────────────────

    splitPane(
        input: PaneScope & { direction?: SplitDirection; path?: string; name?: string },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('pane-split', {
                ...scopeFields(input),
                direction: input.direction,
                path: input.path,
                name: input.name
            }),
            options ?? {}
        );
    }

    createPane(input: PaneScope & { path?: string; name?: string }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(
            wirePayload('pane-create', { ...scopeFields(input), path: input.path, name: input.name }),
            options ?? {}
        );
    }

    closePane(input: PaneScope, options?: SendOptions): Promise<CommandReply> {
        return this.raw(wirePayload('pane-close', scopeFields(input)), options ?? {});
    }

    renamePane(input: PaneScope & { name: string }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(wirePayload('pane-name', { ...scopeFields(input), name: input.name }), options ?? {});
    }

    /** `bare` suppresses the trailing Enter (compose with `sendKey`). */
    sendText(
        input: PaneScope & { target: string; text: string; bare?: boolean },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('pane-send', {
                ...scopeFields(input),
                target: input.target,
                text: input.text,
                bare: input.bare ?? false
            }),
            options ?? {}
        );
    }

    sendKey(input: PaneScope & { target: string; key: NamedKey | string }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(
            wirePayload('pane-send-key', { ...scopeFields(input), target: input.target, key: input.key }),
            options ?? {}
        );
    }

    capturePane(
        input: PaneScope & { lines?: number; scrollback?: boolean },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('pane-capture', {
                ...scopeFields(input),
                lines: input.lines,
                scrollback: input.scrollback ?? false
            }),
            options ?? {}
        );
    }

    /**
     * Resize a pane against its immediate split sibling. `ratio` is the pane's SHARE of the
     * enclosing split (the daemon converts share ↔ stored first-child ratio), `delta` nudges
     * the current share. Exactly one of them, or the daemon rejects the message.
     */
    resizePane(
        input: PaneScope & { ratio?: number; delta?: number },
        options?: SendOptions
    ): Promise<CommandReply> {
        if ((input.ratio === undefined) === (input.delta === undefined)) {
            return Promise.reject(new CommandError('pane resize requires exactly one of ratio / delta'));
        }
        return this.raw(
            wirePayload('pane-resize', { ...scopeFields(input), ratio: input.ratio, delta: input.delta }),
            options ?? {}
        );
    }

    /**
     * Divider drag: the gesture yields a new share for the pane on the divider's leading side,
     * which is exactly what `pane-resize --ratio` writes (same `resizePaneShare` pipeline the
     * GUI drag used). The split path itself is implied by the pane.
     */
    setSplitRatio(paneID: string, share: number, options?: SendOptions): Promise<CommandReply> {
        return this.resizePane({ target: paneID, ratio: share }, options);
    }

    movePane(input: { paneID: string; direction: MoveDirection }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(
            wirePayload('pane-move', { pane_id: input.paneID, direction: input.direction }),
            options ?? {}
        );
    }

    /** Drag-and-drop equivalent: re-parent `target` onto an edge of `anchor`. */
    movePaneAdjacent(
        input: PaneScope & { target: string; anchor: string; zone: DropZone },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('pane-move-adjacent', {
                ...scopeFields(input),
                target: input.target,
                anchor: input.anchor,
                zone: input.zone
            }),
            options ?? {}
        );
    }

    /** The create flag rides the wire as the literal string `"true"` (§6.2 quirk). */
    movePaneToWorkspace(
        input: { paneID: string; workspace: string; create?: boolean },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('pane-move-to-workspace', {
                pane_id: input.paneID,
                name: input.workspace,
                ...(input.create === true ? { text: 'true' } : {})
            }),
            options ?? {}
        );
    }

    listPanes(
        input: { paneID?: string; workspace?: string; scope?: 'all' | 'current' } = {},
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('pane-list', { pane_id: input.paneID, workspace: input.workspace, scope: input.scope }),
            options ?? {}
        );
    }

    setSyncInput(
        input: { action: SyncAction; paneID?: string; workspace?: string },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('pane-sync', {
                action: input.action,
                pane_id: input.paneID,
                workspace: input.workspace
            }),
            options ?? {}
        );
    }

    setSyncExcluded(
        input: PaneScope & { target: string; excluded: boolean },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('pane-sync-exclude', {
                ...scopeFields(input),
                target: input.target,
                excluded: input.excluded
            }),
            options ?? {}
        );
    }

    // ── workspace verbs ────────────────────────────────────────────────────────────

    listWorkspaces(input: { group?: string } = {}, options?: SendOptions): Promise<CommandReply> {
        return this.raw(wirePayload('workspace-list', { group: input.group }), options ?? {});
    }

    createWorkspace(
        input: {
            name?: string;
            path?: string;
            color?: WorkspaceColor;
            group?: string;
            profile?: string;
            worktree?: string;
            branch?: string;
            updateMain?: boolean;
            repo?: string;
        } = {},
        options?: SendOptions
    ): Promise<CommandReply> {
        const timeout =
            options?.timeoutMs ?? (input.worktree !== undefined ? WORKTREE_COMMAND_TIMEOUT_MS : undefined);
        return this.raw(
            wirePayload('workspace-create', {
                name: input.name,
                path: input.path,
                color: input.color,
                group: input.group,
                profile: input.profile,
                worktree: input.worktree,
                branch: input.branch,
                update_main: input.updateMain,
                repo: input.repo
            }),
            timeout !== undefined ? { timeoutMs: timeout } : {}
        );
    }

    /** Omit `group` to move the workspace to top level. */
    moveWorkspace(
        input: { workspace: string; group?: string; index?: number },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('workspace-move', { name: input.workspace, group: input.group, index: input.index }),
            options ?? {}
        );
    }

    deleteWorkspace(input: { workspace: string; force?: boolean }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(
            wirePayload('workspace-delete', { name: input.workspace, force: input.force ?? false }),
            options ?? {}
        );
    }

    /** Omit `profile` to clear the assignment (back to the built-in `default`). */
    setWorkspaceProfile(
        input: { workspace: string; profile?: string },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('workspace-profile', { name: input.workspace, profile: input.profile }),
            options ?? {}
        );
    }

    labelWorkspace(
        input: { workspace: string; op: LabelOp; values?: readonly string[] },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('workspace-label', {
                name: input.workspace,
                label_op: input.op,
                label_values: [...(input.values ?? [])]
            }),
            options ?? {}
        );
    }

    // ── group verbs ────────────────────────────────────────────────────────────────

    listGroups(options?: SendOptions): Promise<CommandReply> {
        return this.raw(wirePayload('group-list'), options ?? {});
    }

    createGroup(input: { name: string; color?: WorkspaceColor }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(wirePayload('group-create', { name: input.name, color: input.color }), options ?? {});
    }

    renameGroup(input: { group: string; newName: string }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(wirePayload('group-rename', { name: input.group, new_name: input.newName }), options ?? {});
    }

    /** Without `cascade` the group's workspaces are promoted to top level, not deleted. */
    deleteGroup(input: { group: string; cascade?: boolean }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(
            wirePayload('group-delete', { name: input.group, cascade: input.cascade ?? false }),
            options ?? {}
        );
    }

    reorderGroup(
        input: { group: string; order: readonly string[] },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(wirePayload('group-reorder', { name: input.group, order: [...input.order] }), options ?? {});
    }

    sortGroup(
        input: { group: string; by: GroupSortKey; descending?: boolean },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('group-sort', { name: input.group, by: input.by, descending: input.descending ?? false }),
            options ?? {}
        );
    }

    // ── layout / file verbs ────────────────────────────────────────────────────────

    /** Focus-dependent: the daemon uses the workspace holding `paneID` and its focused pane. */
    cycleLayout(input: { paneID: string }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(wirePayload('layout-cycle', { pane_id: input.paneID }), options ?? {});
    }

    selectLayout(
        input: { paneID: string; layout: PredefinedLayout },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(wirePayload('layout-select', { pane_id: input.paneID, name: input.layout }), options ?? {});
    }

    openFile(input: { path: string; paneID?: string; reuse?: boolean }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(
            wirePayload('open', { path: input.path, pane_id: input.paneID, reuse: input.reuse ?? false }),
            options ?? {}
        );
    }

    openDiff(
        input: { repoPath: string; targetPath?: string; paneID?: string },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('diff', {
                repo_path: input.repoPath,
                target_path: input.targetPath,
                pane_id: input.paneID
            }),
            options ?? {}
        );
    }

    ping(options?: SendOptions): Promise<CommandReply> {
        return this.raw(wirePayload('ping'), options ?? {});
    }

    // ── WS-only verbs ──────────────────────────────────────────────────────────────
    //
    // Direct-manipulation gestures the control protocol has no verb for (the CLI cannot send
    // them and never grew one). The daemon matches them on the WS channel BEFORE the wire
    // decode — `daemon/src/ws/sync.ts` `WS_ONLY_COMMANDS` — and dispatches the store action
    // that already exists, so they produce the same deltas a GUI change would.

    /** Zoom/un-zoom a pane (the daemon focuses it first when zooming). */
    toggleZoom(input: { paneID: string }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(wirePayload('toggle-zoom', { pane_id: input.paneID }), options ?? {});
    }

    /** Sidebar disclosure triangle; the collapsed flag is daemon state, not client-local. */
    setGroupCollapsed(
        input: { groupID: string; collapsed: boolean },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('set-group-collapsed', { group_id: input.groupID, collapsed: input.collapsed }),
            options ?? {}
        );
    }

    /** Inline sidebar rename. The daemon recomputes the workspace slug. */
    renameWorkspace(input: { workspaceID: string; name: string }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(
            wirePayload('rename-workspace', { workspace_id: input.workspaceID, name: input.name }),
            options ?? {}
        );
    }

    // ── internals ──────────────────────────────────────────────────────────────────

    private settle(id: string): void {
        const entry = this.pending.get(id);
        if (entry === undefined) return;
        if (entry.timer !== null) clearTimeout(entry.timer);
        this.pending.delete(id);
    }

    private rejectAll(): void {
        const entries = [...this.pending.entries()];
        this.pending.clear();
        for (const [, entry] of entries) {
            if (entry.timer !== null) clearTimeout(entry.timer);
            entry.reject(new CommandDisconnectedError(entry.command));
        }
    }

    private replayReports(): void {
        const focus = this.lastFocus;
        const visibility = this.lastVisibility;
        if (visibility !== null) {
            this.connection.send({
                type: 'visibility-report',
                workspaceID: visibility.workspaceID,
                visiblePaneIDs: visibility.visiblePaneIDs,
                documentVisible: visibility.documentVisible
            });
        }
        if (focus !== null) {
            this.connection.send({ type: 'focus-report', workspaceID: focus.workspaceID, paneID: focus.paneID });
        }
    }
}

function sameVisibility(a: ReportedVisibility, b: ReportedVisibility): boolean {
    if (a.workspaceID !== b.workspaceID || a.documentVisible !== b.documentVisible) return false;
    if (a.visiblePaneIDs.length !== b.visiblePaneIDs.length) return false;
    return a.visiblePaneIDs.every((id, index) => id === b.visiblePaneIDs[index]);
}

export function createCommandClient(connection: NexConnection, options: CommandClientOptions = {}): CommandClient {
    return new CommandClient(connection, options);
}
