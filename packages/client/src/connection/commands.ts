/**
 * Command RPC over the sync socket (WP3.1).
 *
 * A client `command` message carries a minted id and a **control-protocol request object** —
 * the exact same `{"command": …}` payload the `kelpi` CLI writes to `/tmp/nex.sock`. The daemon
 * decodes it through `decodeWireObject` and dispatches it into the same handler table
 * (`daemon/src/ws/sync.ts` → `boot/dispatch.ts`), so the UI cannot drift from the CLI: if a
 * verb is not in `@kelpi/protocol`'s `WIRE_COMMANDS`, it does not exist here either.
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
 * where they are declared, at the bottom of the class. The M5 content-pane family
 * (`content-subscribe` … `markdown-save`) is WS-only for the same reason and additionally
 * **asynchronous** daemon-side — reading a file or running `git diff` cannot answer inside the
 * message handler — so those replies arrive when the daemon's promise settles, which changes
 * nothing here: every command already settles through `command-reply`.
 *
 * Still unwired for want of any daemon action name: reopen-closed-pane. (Pane status override
 * landed in M8 wave 6 as `clear-pane-status`/`restart-pane-agent` — see the bottom of the
 * class.) `raw()` is deliberately public so a new verb can be sent the moment the daemon grows
 * it, without a new client release.
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
} from '@kelpi/protocol';

import type { ConnectionStatus, KelpiConnection } from './socket';

export type CommandReply = JsonObject;

/**
 * The mode `markdown-set-mode` accepts. Restated (not imported from `content/`) so the
 * transport layer keeps its one-way dependency: features import the connection, never the
 * reverse.
 */
export type ContentPaneMode = 'view' | 'edit';

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

/** Reads a finite number field off a reply (`active_agents`, `total`, …). */
export function replyNumber(reply: CommandReply, key: string): number | undefined {
    const value = reply[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Where a terminal-search reply says the selected match is.
 *
 * `linesFromBottom` rather than an absolute buffer line, deliberately: the daemon's headless
 * emulator keeps 10 000 lines, ghostty-web bounds its scrollback in BYTES, and a fresh client
 * replays a possibly-capped snapshot — so the two buffers agree on where the BOTTOM is and on
 * nothing else. `null` when nothing is selected yet (the `-/N` state).
 */
export interface TerminalSearchMatch {
    readonly linesFromBottom: number;
    readonly col: number;
    readonly length: number;
}

export function replySearchMatch(reply: CommandReply): TerminalSearchMatch | null {
    const raw = reply['match'];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const linesFromBottom = record['lines_from_bottom'];
    const col = record['col'];
    const length = record['length'];
    if (typeof linesFromBottom !== 'number' || typeof col !== 'number' || typeof length !== 'number') {
        return null;
    }
    return { linesFromBottom, col, length };
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
        private readonly connection: KelpiConnection,
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
     * Take size control (terminal-surface.md §5.1): PTY geometry follows this client's
     * window from here on. Fire-and-forget — the daemon answers with a `size-control`
     * broadcast, which is what flips the top-bar affordance off.
     */
    takeSizeControl(): void {
        this.connection.send({ type: 'take-size-control' });
    }

    // ── Settings ▸ Remote (`daemon ws/remote.ts`; OWNER-ONLY, WS-only) ──────────────

    /** Registry + tailnet dashboard: paired devices, tailscale identity, serve state. */
    remoteStatus(options?: SendOptions): Promise<CommandReply> {
        return this.raw({ command: 'remote-status' }, options ?? {});
    }

    /**
     * Mint a device and build its pairing URL — the reply's `url` carries the plaintext
     * token exactly ONCE (the registry stores only the hash). `tailnet` runs the same
     * `tailscale serve` recipe `kelpid pair --tailnet` does, and MAY configure serve;
     * a tailnet failure rolls the mint back and the reply says so.
     */
    remotePair(name: string, tailnet: boolean, options?: SendOptions): Promise<CommandReply> {
        // `tailscale serve --bg` on a cold tailnet can take a while; a status read cannot.
        return this.raw({ command: 'remote-pair', name, tailnet }, options ?? { timeoutMs: 60_000 });
    }

    /** Revoke by device id (or unambiguous live name). Open sessions are cut by the daemon. */
    remoteRevoke(target: string, options?: SendOptions): Promise<CommandReply> {
        return this.raw({ command: 'remote-revoke', target }, options ?? {});
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
        options: {
            visiblePaneIDs?: readonly string[];
            documentVisible?: boolean;
            /** Send even when the payload matches the last one — an idempotent re-assert. */
            force?: boolean;
        } = {}
    ): void {
        const visible = options.visiblePaneIDs ?? this.lastVisibility?.visiblePaneIDs ?? [];
        const documentVisible = options.documentVisible ?? this.lastVisibility?.documentVisible ?? true;
        this.reportVisibility(
            workspaceID,
            visible,
            documentVisible,
            options.force === undefined ? {} : { force: options.force }
        );
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

    /**
     * `allowLast` is §WS-156's asymmetry, and exactly one caller sets it: ⌘W on the last pane of
     * the last workspace, which the shipped app lets reach ZERO workspaces (and which is how a
     * user arrives at the "No workspace selected" state). The sidebar's Delete leaves it unset,
     * so it keeps the shipped app's own "not the last one" rule — and so does the CLI.
     *
     * It also chooses the VERB, because the flag is not a wire field. `workspace-delete` is the
     * CLI's verb and cannot carry it; `delete-workspace` is the GUI's, WS-only like
     * `rename-workspace`, and the daemon constructs the delete from it rather than decoding one
     * (`daemon/src/ws/sync.ts` ▸ `guiDeleteWorkspace`). Everything downstream — the
     * running-agents guard, the PTY teardown, the reply — is the one handler.
     */
    deleteWorkspace(
        input: { workspace: string; force?: boolean; allowLast?: boolean },
        options?: SendOptions
    ): Promise<CommandReply> {
        if (input.allowLast === true) {
            return this.raw(
                wirePayload('delete-workspace', {
                    workspace_id: input.workspace,
                    force: input.force ?? false,
                    allow_last: true
                }),
                options ?? {}
            );
        }
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

    /**
     * A divider drag addressed by SPLIT PATH (§LAY-061) — the layout model's own spelling, and
     * the one Swift's GUI uses (`updateSplitRatio(splitPath:ratio:)`). `setSplitRatio` above
     * can only name a PANE, so it cannot move a divider whose two children are both splits
     * (the root divider of a 2×2 `tiled` layout); this can move any of them.
     */
    setSplitRatioAtPath(
        input: { workspaceID: string; splitPath: string; ratio: number },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('set-split-ratio', {
                workspace_id: input.workspaceID,
                split_path: input.splitPath,
                ratio: input.ratio
            }),
            options ?? {}
        );
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

    /**
     * "Change Icon" (shell-ui.md §5.6). `icon` is the flat DB spelling — `"emoji:🔥"` or
     * `"system:<sf-symbol>"` — and `null` resets to the letter avatar. The client never has to
     * understand an SF Symbol name to send one back, which is what keeps a legacy DB value
     * round-tripping through a client that cannot draw it (PLAN.md).
     */
    setWorkspaceIcon(input: { workspaceID: string; icon: string | null }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(
            wirePayload('set-workspace-icon', { workspace_id: input.workspaceID, icon: input.icon }),
            options ?? {}
        );
    }

    setGroupIcon(input: { groupID: string; icon: string | null }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(
            wirePayload('set-group-icon', { group_id: input.groupID, icon: input.icon }),
            options ?? {}
        );
    }

    /**
     * §WS-065's "Color ▸". A group's colour is OPTIONAL, so `null` is the submenu's "None" and
     * clears it — which is why this is not `setBulkColor` with a single id.
     */
    setGroupColor(
        input: { groupID: string; color: WorkspaceColor | null },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('set-group-color', { group_id: input.groupID, color: input.color }),
            options ?? {}
        );
    }

    /**
     * A multi-row sidebar drag: ONE atomic move for the whole selection (§5.5). Sending N
     * `workspace-move`s instead would re-index between each one, so the rows land scrambled.
     */
    moveWorkspaces(
        input: { workspaceIDs: readonly string[]; groupID?: string | null; index?: number },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('move-workspaces', {
                workspace_ids: [...input.workspaceIDs],
                group_id: input.groupID ?? undefined,
                index: input.index
            }),
            options ?? {}
        );
    }

    /** The 600 ms focus-dwell acknowledgment (agent-lifecycle.md §5.8). */
    clearPaneStatus(input: { paneID: string }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(wirePayload('clear-pane-status', { pane_id: input.paneID }), options ?? {});
    }

    /** Pane header restart button: the daemon types the pane's resume command into its PTY. */
    restartPaneAgent(input: { paneID: string }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(wirePayload('restart-pane-agent', { pane_id: input.paneID }), options ?? {});
    }

    /**
     * The pane context menu's Status submenu (agent-lifecycle.md §5.10 / TERM-107). The daemon's
     * state machine owns the whole rule — shell panes only, the elapsed clock arms on a FRESH
     * transition into running, the background count is zeroed — so this only names the target
     * status, and a non-shell pane comes back unchanged rather than as an error.
     */
    setPaneStatus(
        input: { paneID: string; status: 'idle' | 'running' | 'waitingForInput' },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('set-pane-status', { pane_id: input.paneID, status: input.status }),
            options ?? {}
        );
    }

    // ── pane UX verbs (⇧⌘T, ⇧⌘N, Open in Finder) ──────────────────────────────────

    /**
     * ⇧⌘T. The daemon pops its own undo stack (`recentlyClosedPanes`), splits the focused pane,
     * restores the snapshot, spawns a PTY when the pane was a terminal and — 2 seconds later —
     * types the snapshotted agent's resume command. None of that is client state, which is why
     * the client names only the workspace; the reply carries the restored pane's id.
     */
    reopenClosedPane(input: { workspaceID: string }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(
            wirePayload('reopen-closed-pane', { workspace_id: input.workspaceID }),
            options ?? {}
        );
    }

    /** ⇧⌘N — a "Scratchpad" pane split off the focused one, already in edit mode. */
    createScratchpad(input: { workspaceID: string }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(
            wirePayload('create-scratchpad', { workspace_id: input.workspaceID }),
            options ?? {}
        );
    }

    /**
     * "Open in Finder". The daemon has no file manager, so it broadcasts and whichever Electron
     * shell is attached runs `shell.showItemInFolder` / `shell.openPath`. `select: true` reveals
     * a FILE inside its folder (a markdown/diff pane's path); false opens a directory.
     */
    revealPath(input: { path: string; select?: boolean }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(
            wirePayload('reveal-path', { path: input.path, select: input.select === true }),
            options ?? {}
        );
    }

    // ── desktop gestures (`daemon/src/ws/desktop.ts`) ─────────────────────────────

    /**
     * Ask the attached Electron shell to do something only it can (`shell-action`).
     *
     * The shell has no preload, so this is the only route from the page to the main process:
     * the daemon fans the request out and whichever shell is attached acts. `open-file-dialog`
     * answers with a NATIVE open panel and then sends the chosen path back as an ordinary
     * `open` verb — a browser client has no shell to ask, which is why the caller checks
     * `shellWindowID` first and prompts for a path instead.
     */
    shellAction(
        input: { action: 'open-file-dialog' | 'install-cli' | 'check-for-updates'; windowID?: string | null; paneID?: string | null },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('shell-action', {
                action: input.action,
                window_id: input.windowID ?? undefined,
                pane_id: input.paneID ?? undefined
            }),
            options ?? {}
        );
    }

    /**
     * APP-054 — "Restart Socket Server". Closes and re-binds the daemon's control listeners,
     * clearing a wedged `/tmp/nex.sock` and any client FDs hanging off it. Every PTY survives:
     * this touches the CLI transport only, never the sessions.
     */
    restartControlServer(options?: SendOptions): Promise<CommandReply> {
        return this.raw(wirePayload('restart-control-server', {}), options ?? {});
    }

    /**
     * CONT-122 / TERM-052 — what a ⌘-click on a terminal cell resolves to.
     *
     * The client sends the CELL (computed from the pane's own grid geometry), not a word:
     * neither renderer exposes a word-under-cursor API, and the daemon holds the authoritative
     * buffer. The reply's `opened` says what happened — `markdown` (a pane was created),
     * `external` (a URL for the OS opener), `missing` (a `.md` path that is not there), or
     * `none`.
     */
    openTerminalTarget(
        input: { paneID: string; row: number; col: number },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('open-terminal-target', { pane_id: input.paneID, row: input.row, col: input.col }),
            options ?? {}
        );
    }

    /**
     * CONT-081…091 — host `$VISUAL`/`$EDITOR` on a markdown pane's file, or end that session.
     *
     * `open` gives the pane a PTY running the editor (the pane stays a markdown pane; it is
     * `externalEditorCommand` that makes the client draw a terminal); `close` kills it and the
     * pane goes back to preview. An editor that exits by itself does the same without a
     * command, through the daemon's process-exit path.
     */
    markdownExternalEditor(
        input: { paneID: string; action?: 'open' | 'close' },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('markdown-external-editor', {
                pane_id: input.paneID,
                action: input.action ?? 'open'
            }),
            options ?? {}
        );
    }

    /**
     * TERM-043 — a pasted image, written to a temp file on the DAEMON's machine and typed into
     * the pane as a shell-escaped path.
     *
     * The bytes travel base64 because the file has to exist where the agent reading it runs; a
     * browser-side write would land on the wrong filesystem (and in a browser there is no
     * filesystem to write to at all).
     */
    pasteImage(
        input: { paneID: string; data: string; mime?: string },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('paste-image', {
                pane_id: input.paneID,
                data: input.data,
                mime: input.mime ?? 'image/png'
            }),
            options ?? {}
        );
    }

    // ── terminal search (⌘F over a shell pane) ────────────────────────────────────
    //
    // One verb with an `action` field (`daemon/src/ws/search.ts`). The needle, the total and the
    // selected index are DAEMON state — they ride the delta stream on the workspace, so every
    // attached window shows the same counter — and the reply adds the one thing that is not
    // state: where the selected match sits, expressed as `lines_from_bottom` so a renderer whose
    // scrollback depth differs from the daemon's can still resolve it.

    /** Open the bar on the focused pane, or close it wherever it currently lives. */
    toggleTerminalSearch(input: { workspaceID: string }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(
            wirePayload('terminal-search', { action: 'toggle', workspace_id: input.workspaceID }),
            options ?? {}
        );
    }

    /** A new needle: the daemon recounts and drops any selection (the counter reads `-/N`). */
    setTerminalSearchNeedle(
        input: { workspaceID: string; needle: string; caseSensitive?: boolean },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('terminal-search', {
                action: 'set',
                workspace_id: input.workspaceID,
                needle: input.needle,
                case_sensitive: input.caseSensitive === true
            }),
            options ?? {}
        );
    }

    /** Return / ⇧Return. Both directions wrap; the reply names the match to scroll to. */
    stepTerminalSearch(
        input: { workspaceID: string; direction: 'next' | 'prev'; caseSensitive?: boolean },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('terminal-search', {
                action: input.direction,
                workspace_id: input.workspaceID,
                case_sensitive: input.caseSensitive === true
            }),
            options ?? {}
        );
    }

    /** Escape / the ✕: clears the needle and every count for the workspace. */
    closeTerminalSearch(input: { workspaceID: string }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(
            wirePayload('terminal-search', { action: 'close', workspace_id: input.workspaceID }),
            options ?? {}
        );
    }

    // ── bulk workspace verbs (the multi-select context menu) ───────────────────────
    //
    // shell-ui.md §5.6's bulk menu variant: ONE dispatch for the whole selection, never N
    // single-workspace commands, so N rows change in a single delta and a half-applied bulk
    // action is impossible. `setBulkColor` with one id is also how a single row's "Color ▸"
    // applies — the store has no single-workspace colour action.

    setBulkColor(
        input: { workspaceIDs: readonly string[]; color: WorkspaceColor },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('set-bulk-color', { workspace_ids: [...input.workspaceIDs], color: input.color }),
            options ?? {}
        );
    }

    /**
     * "Group N Workspaces…" (§WS-058). The CLI's `group-create` is fire-and-forget and cannot
     * carry members, so this WS-only verb dispatches the same `create-group` action WITH its
     * `initialWorkspaceIDs` — one atomic change, not a create followed by a move.
     */
    createGroupForWorkspaces(
        input: { name: string; workspaceIDs: readonly string[]; color?: WorkspaceColor },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('create-group-for-workspaces', {
                name: input.name,
                workspace_ids: [...input.workspaceIDs],
                color: input.color
            }),
            options ?? {}
        );
    }

    /** `apply` is the state every selected workspace ends at, not a per-row toggle. */
    setBulkLabel(
        input: { workspaceIDs: readonly string[]; label: string; apply: boolean },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('set-bulk-label', {
                workspace_ids: [...input.workspaceIDs],
                label: input.label,
                apply: input.apply
            }),
            options ?? {}
        );
    }

    // ── workspace inspector: repos, associations, worktrees ────────────────────────
    //
    // WS-only and **asynchronous** daemon-side (`daemon/src/ws/repos.ts` — every one shells out
    // to git), which changes nothing here: the reply arrives through `command-reply` when the
    // promise settles, exactly like the content verbs.

    /** The registry plus each repo's RESOLVED worktree base path (the client cannot expand it). */
    listRepos(options?: SendOptions): Promise<CommandReply> {
        return this.raw(wirePayload('repo-registry'), options ?? {});
    }

    /**
     * One row per repo association: branch, dirtiness and diff stats. `refresh` re-reads git
     * before replying (what the inspector asks for on open and after a HEAD moves); without it
     * the reply is the daemon watcher's last known values, which its 30 s poll keeps warm.
     */
    workspaceRepoStatus(
        input: { workspaceID: string; refresh?: boolean },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('workspace-repo-status', {
                workspace_id: input.workspaceID,
                refresh: input.refresh ?? false
            }),
            options ?? {}
        );
    }

    /** Associate a path: the daemon resolves its repo root and registers the repo if new. */
    addRepoAssociation(
        input: { workspaceID: string; path: string },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('add-repo-association', { workspace_id: input.workspaceID, path: input.path }),
            options ?? {}
        );
    }

    /**
     * Drop an association. `deleteWorktree` additionally runs a NON-forcing `git worktree
     * remove`; git's refusal on a dirty or locked worktree comes back as `{ok:false}` and the
     * association is left in place (a directory nothing points at is worse than a stale row).
     */
    removeRepoAssociation(
        input: { workspaceID: string; associationID: string; deleteWorktree?: boolean },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('remove-repo-association', {
                workspace_id: input.workspaceID,
                association_id: input.associationID,
                delete_worktree: input.deleteWorktree ?? false
            }),
            options ?? {}
        );
    }

    /**
     * `git worktree add` for the CURRENT workspace, then registry + association (GIT-098/099).
     * The new-workspace half of the same flow is `createWorkspace({worktree})`; both take the
     * long timeout because `--update-main` fetches.
     */
    addWorktree(
        input: {
            workspaceID: string;
            repoID?: string;
            repoPath?: string;
            name: string;
            branch?: string;
            updateMain?: boolean;
        },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('workspace-add-worktree', {
                workspace_id: input.workspaceID,
                repo_id: input.repoID,
                repo_path: input.repoPath,
                name: input.name,
                branch: input.branch,
                update_main: input.updateMain ?? false
            }),
            { timeoutMs: options?.timeoutMs ?? WORKTREE_COMMAND_TIMEOUT_MS }
        );
    }

    // ── the repo registry itself (Settings ▸ Repositories) ─────────────────────────
    //
    // graft-git.md §GIT-065…§GIT-072 / §SET-052…§SET-057. These edit the GLOBAL registry the
    // association verbs above point into: a repo can be registered without being associated
    // with any workspace, which is what makes the New Worktree flow's picker non-empty.

    /**
     * Register a repository path. A path already registered as AUTO-DISCOVERED is promoted to
     * manual (§GIT-068) rather than duplicated, so the auto-detect GC can never collect a repo
     * the user asked for by hand; an already-manual one answers `ok` unchanged.
     */
    addRepo(input: { path: string; name?: string | undefined }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(wirePayload('repo-add', { path: input.path, name: input.name }), options ?? {});
    }

    /**
     * Drop a repository. The daemon cascades: every association pointing at it leaves every
     * workspace, and each vanished association's HEAD watcher and graft session are stopped
     * (§GIT-052).
     */
    removeRepo(input: { repoID: string }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(wirePayload('repo-remove', { repo_id: input.repoID }), options ?? {});
    }

    /** Rename the registry's display name; the path is identity and never moves (§GIT-072). */
    renameRepo(input: { repoID: string; name: string }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(wirePayload('repo-rename', { repo_id: input.repoID, name: input.name }), options ?? {});
    }

    /**
     * Walk `path` (depth 3) and register every checkout not registered yet (§GIT-066/§GIT-067).
     * Takes the long timeout: the walk is filesystem-bound and then runs one `git remote
     * get-url` per new find.
     */
    scanRepos(
        input: { path: string; maxDepth?: number | undefined },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(wirePayload('repo-scan', { path: input.path, max_depth: input.maxDepth }), {
            timeoutMs: options?.timeoutMs ?? WORKTREE_COMMAND_TIMEOUT_MS
        });
    }

    // ── graft (the inspector's toggle, swap prompt and orphan banner) ───────────────
    //
    // graft-git.md §GIT-035…§GIT-051. Association-scoped, unlike the CLI's scope-addressed
    // `graft start` / `graft stop`: the inspector acts on one row, and needs the failure typed
    // (`error_kind`, plus `parent_repo_root` on an `alreadyActive`) to raise the swap prompt.

    /**
     * Live sessions AND interrupted-graft breadcrumbs — the client's initial sync. `refresh`
     * re-scans the registry's repos for breadcrumbs (excluding roots a live session claims), so
     * a repo registered after the daemon booted still surfaces its interrupted graft.
     */
    graftList(input?: { refresh?: boolean | undefined }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(
            wirePayload('graft-session-list', { refresh: input?.refresh ?? false }),
            options ?? {}
        );
    }

    /** Start mirroring one association's worktree into its parent checkout. */
    graftStart(input: { associationID: string }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(wirePayload('graft-session-start', { association_id: input.associationID }), {
            timeoutMs: options?.timeoutMs ?? WORKTREE_COMMAND_TIMEOUT_MS
        });
    }

    /**
     * Stop + restore. Idempotent daemon-side, which is what makes the retry-an-errored-session
     * path safe: it unwinds whatever the engine still holds even when this client only ever saw
     * a start-failure placeholder (§GIT-037).
     */
    graftStop(input: { associationID: string }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(wirePayload('graft-session-stop', { association_id: input.associationID }), {
            timeoutMs: options?.timeoutMs ?? WORKTREE_COMMAND_TIMEOUT_MS
        });
    }

    /**
     * Replay the stop sequence from a crashed session's breadcrumb. A failure (typically a
     * stash-pop conflict) LEAVES the breadcrumb, so the banner has to come back (§GIT-045).
     */
    graftRecoverOrphan(input: { associationID: string }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(wirePayload('graft-orphan-recover', { association_id: input.associationID }), {
            timeoutMs: options?.timeoutMs ?? WORKTREE_COMMAND_TIMEOUT_MS
        });
    }

    /** Delete the breadcrumb only; the parent's working tree and the stash are left alone. */
    graftDismissOrphan(input: { associationID: string }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(
            wirePayload('graft-orphan-dismiss', { association_id: input.associationID }),
            options ?? {}
        );
    }

    // ── label presets (Settings ▸ Labels) ──────────────────────────────────────────
    //
    // app-state-core.md §6.4, over the same WS-only channel. `color` is §6.2's one-string
    // encoding: a `WorkspaceColor` raw value (`"blue"`) or a `#rrggbb` hex; absent = gray, the
    // default the CLI's `workspace label` back-fill already uses. The list itself is daemon
    // STATE (`labelPresets` on the mirror, advanced by a `label-presets-changed` delta), so
    // these verbs only push a change — nothing here caches a list.

    /**
     * Append a preset. The daemon refuses a duplicate name rather than no-op'ing silently.
     *
     * `textColor` is §6.2's other colour slot (SET-062): a colour token for an explicit text
     * colour, `null` for AUTO (black/white by the background's luminance), absent to leave it
     * auto. Per SET-059 the daemon applies it only when the add actually created a preset, so a
     * duplicate name can never recolour the preset that already holds it.
     */
    addLabelPreset(
        input: { name: string; color?: string | undefined; textColor?: string | null | undefined },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('add-label-preset', {
                name: input.name,
                color: input.color,
                ...(input.textColor === undefined ? {} : { text_color: input.textColor })
            }),
            options ?? {}
        );
    }

    /**
     * Recolor and/or rename. `id` is the preset's CURRENT name (its identity); `name` absent
     * keeps it, which is what a palette swatch click sends.
     */
    updateLabelPreset(
        input: {
            id: string;
            name?: string | undefined;
            color?: string | undefined;
            /** A colour token, or `null` for AUTO. Absent leaves the stored one alone. */
            textColor?: string | null | undefined;
        },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('update-label-preset', {
                id: input.id,
                name: input.name,
                color: input.color,
                ...(input.textColor === undefined ? {} : { text_color: input.textColor })
            }),
            options ?? {}
        );
    }

    /**
     * Delete a preset. §6.4: this never touches any workspace's `labels` — the label string
     * survives and its chip just renders neutral, so deleting is not a destructive edit of the
     * workspaces wearing it.
     */
    removeLabelPreset(input: { id: string }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(wirePayload('remove-label-preset', { id: input.id }), options ?? {});
    }

    /**
     * SET-065's reorder, by NAME and target index. The Swift list reordered by drag; the ↑/↓
     * buttons that replace it send the same instruction, and the daemon computes the source
     * position from its own list so a one-delta-stale index cannot scramble the order.
     */
    moveLabelPreset(input: { id: string; index: number }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(wirePayload('move-label-preset', { id: input.id, index: input.index }), options ?? {});
    }

    // ── settings verbs (M8) ────────────────────────────────────────────────────────
    //
    // The daemon owns `~/.config/nex/config`: each verb applies a `@kelpi/core/config` writer to
    // the file's current contents, re-reads it, and answers `{ok, settings}` with the re-read
    // snapshot — so the reply is the truth, not an optimistic echo. A `settings-changed`
    // broadcast follows for every OTHER attached client; this client can apply the reply
    // directly (the store dedupes the two).

    /**
     * Bind `action` to `trigger` (a config-file trigger string like `"super+d"`), stealing it
     * from whatever action held it. `trigger: null` removes every trigger the action has.
     */
    setKeybinding(
        input: { action: string; trigger: string | null },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('set-keybinding', { action: input.action, trigger: input.trigger }),
            options ?? {}
        );
    }

    /** One action back to its shipped triggers, or the whole map when `action` is null. */
    resetKeybindings(
        input: { action?: string | null | undefined } = {},
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('reset-keybindings', { action: input.action ?? null }),
            options ?? {}
        );
    }

    /**
     * One `key = value` general setting. The daemon refuses anything outside
     * config-keybindings.md §1.3's writable list — `theme` included, which the app never
     * writes back to this file.
     */
    setGeneralSetting(
        input: { key: string; value: string | number | boolean },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('set-general-setting', { key: input.key, value: String(input.value) }),
            options ?? {}
        );
    }

    /**
     * One `key = value` in the **ghostty** config (`WS_WRITABLE_GHOSTTY_KEYS`: `background`,
     * `background-opacity`, `font-family`, `font-size`, `theme`).
     *
     * A separate verb from `setGeneralSetting` because it writes a DIFFERENT FILE — one ghostty
     * owns and from which Kelpi only borrows five keys. `value: null` REMOVES the key, which is
     * how "no explicit background, inherit whatever the theme sets" is expressed; the daemon
     * preserves every unrelated line byte-for-byte and re-reads the file before replying, so a
     * user's hand-maintained ghostty config survives a colour picker intact.
     */
    setGhosttySetting(
        input: { key: string; value: string | number | null },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('set-ghostty-setting', {
                key: input.key,
                value: input.value === null ? null : String(input.value)
            }),
            options ?? {}
        );
    }

    /**
     * Settings ▸ Profiles (config-keybindings.md §1.6, §9.5): a **whole-set replace**. The
     * daemon drops every `profile` line, keeps all other lines byte-for-byte, and re-emits the
     * set — so the caller must send the complete list, never a patch. Profiles with a blank
     * name and vars with a blank key are dropped by the writer.
     */
    setProfiles(
        input: { profiles: readonly { name: string; env: Readonly<Record<string, string>> }[] },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('set-profiles', {
                profiles: input.profiles.map((profile) => ({ name: profile.name, env: { ...profile.env } }))
            }),
            options ?? {}
        );
    }

    /** `set-remote-daemons` — the WHOLE §1.7 registry, `setProfiles`-style full replacement. */
    setRemoteDaemons(
        input: { daemons: readonly { name: string; url: string }[] },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('set-remote-daemons', {
                daemons: input.daemons.map((daemon) => ({ name: daemon.name, url: daemon.url }))
            }),
            options ?? {}
        );
    }

    // ── content-pane verbs (M5) ────────────────────────────────────────────────────
    //
    // The daemon's `ContentService` behind `daemon/src/ws/sync.ts` `CONTENT_COMMANDS`. A
    // subscription is **per connection**: the daemon fans `content-updated` out to the sessions
    // that asked for that pane and to nobody else, and drops every subscription when the socket
    // closes — so a reconnect must re-subscribe (`content/client.ts` does).

    /** Start mirroring a content pane. The reply carries the current state. */
    subscribeContent(input: { paneID: string }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(wirePayload('content-subscribe', { pane_id: input.paneID }), options ?? {});
    }

    /** Stop this connection's event stream for the pane (the pane itself is untouched). */
    unsubscribeContent(input: { paneID: string }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(wirePayload('content-unsubscribe', { pane_id: input.paneID }), options ?? {});
    }

    /** Markdown view ⇄ edit (§4.1). Also flips the pane's `isEditing` in daemon state. */
    setMarkdownMode(
        input: { paneID: string; mode: ContentPaneMode },
        options?: SendOptions
    ): Promise<CommandReply> {
        return this.raw(
            wirePayload('markdown-set-mode', { pane_id: input.paneID, mode: input.mode }),
            options ?? {}
        );
    }

    /** Push the editor buffer to the daemon, which owns the debounced write to disk (§4.2). */
    setContentText(input: { paneID: string; text: string }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(
            wirePayload('content-set-text', { pane_id: input.paneID, text: input.text }),
            options ?? {}
        );
    }

    /** Diff: re-run `git diff`. Markdown: re-read the file. Scratchpad: no-op (§5.2). */
    refreshContent(input: { paneID: string }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(wirePayload('diff-refresh', { pane_id: input.paneID }), options ?? {});
    }

    /** Flush the daemon's pending debounced save now (quit flush, mode switch). */
    saveContent(input: { paneID: string }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(wirePayload('markdown-save', { pane_id: input.paneID }), options ?? {});
    }

    /**
     * §3.16 preview font size. The size is absolute; the daemon's reducer clamps it to 8…32 and
     * ignores it for a pane that is editing, so an out-of-range value is a no-op, not an error.
     */
    setContentFontSize(input: { paneID: string; size: number }, options?: SendOptions): Promise<CommandReply> {
        return this.raw(
            wirePayload('content-set-font-size', { pane_id: input.paneID, size: input.size }),
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

export function createCommandClient(connection: KelpiConnection, options: CommandClientOptions = {}): CommandClient {
    return new CommandClient(connection, options);
}
