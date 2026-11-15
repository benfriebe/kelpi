/**
 * The window's workspace-tab verbs (workspace-feature.md §12): new, select, rename, reorder,
 * close, duplicate, move a pane into or out of a tab, split a tab into tabs, merge, and move a
 * tab to another workspace.
 *
 * WS-only like `reopen-closed-pane`, and on the same channel (`ws/panes.ts`) for the same
 * reason: they are not only store dispatches. A new tab mints ids its reply carries and may
 * need a PTY; a close ends the PTYs of every pane it took with it, as `pane-close` does; and
 * moving a tab to another workspace changes which workspace's sync group its shells are in.
 *
 * Replies are `{ok: true, …}` or `{ok: false, error}` with the error in words a person can act
 * on, like every other GUI verb. Two verbs can wait before they answer: a new "same kind" tab
 * and a duplicated tab open their shells where the source shells really are, which means asking
 * the OS first (`ctx.liveWorkingDirectory`, as a split does). Every other verb answers at once.
 */

import { newUUID } from '@kelpi/core/codec';
import { allPaneIDs as treePaneIDs, dropZoneForWireEdge, type Pane } from '@kelpi/core/layout';
import { DROP_ZONES, type DropZone as WireDropZone, type JsonObject } from '@kelpi/protocol';

import { refreshSyncGroup, spawnPaneIfShell, type PaneHandlerContext } from '../handlers/pane/index.js';
import {
    activeTabIDOf,
    duplicableTree,
    normalizeURLInput,
    tabByID,
    tabIndex,
    tabOfPane,
    tabPaneIDs,
    visiblePane,
    workspaceByID,
    workspaceContainingVisiblePane,
    workspaceTabs,
    type DomainAction,
    type WorkspaceState
} from '../store/index.js';

export const WORKSPACE_TAB_COMMANDS = [
    'workspace-tab-new',
    'workspace-tab-select',
    'workspace-tab-rename',
    'workspace-tab-move',
    'workspace-tab-close',
    'workspace-tab-close-others',
    'workspace-tab-split-panes',
    'workspace-tab-merge-previous',
    'workspace-tab-move-to-workspace',
    'workspace-tab-duplicate',
    'pane-move-to-new-tab',
    'pane-move-to-tab'
] as const;
export type WorkspaceTabCommand = (typeof WORKSPACE_TAB_COMMANDS)[number];

/** The verbs whose reply can wait on the OS (where a shell really is). */
export type WaitingWorkspaceTabCommand = 'workspace-tab-new' | 'workspace-tab-duplicate';
/** Every other verb: its reply is there when `run` returns. */
export type ImmediateWorkspaceTabCommand = Exclude<WorkspaceTabCommand, WaitingWorkspaceTabCommand>;

/**
 * How long a new or copied tab waits on the OS for where one shell is (`liveWorkingDirectory`)
 * before it uses the directory the shell last reported. The lookup is bounded in production, but
 * resolving the answer touches the filesystem, and a stalled mount must not hold the tab up.
 */
export const LIVE_DIRECTORY_DEADLINE_MS = 1_500;

/** `promise`'s value, or `fallback` if it fails or has not settled within `ms`. */
function withDeadline<T>(promise: Promise<T>, fallback: T, ms: number): Promise<T> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(fallback), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            () => {
                clearTimeout(timer);
                resolve(fallback);
            }
        );
    });
}

export function isWorkspaceTabCommand(command: string): command is WorkspaceTabCommand {
    return (WORKSPACE_TAB_COMMANDS as readonly string[]).includes(command);
}

/** What a new tab opens: Settings ▸ Workspaces "A new tab opens", or the + menu's choice. */
export const NEW_TAB_KINDS = ['terminal', 'same', 'agent', 'web', 'scratchpad'] as const;
export type NewTabKind = (typeof NEW_TAB_KINDS)[number];

function failure(error: string): JsonObject {
    return { ok: false, error };
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function integer(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export interface WorkspaceTabChannelOptions {
    readonly ctx: PaneHandlerContext;
    /** Settings ▸ Workspaces "A new tab opens", for a `workspace-tab-new` naming no kind. */
    readonly newTabOpens?: (() => 'terminal' | 'same' | 'agent') | undefined;
    /** Start the configured agent in a new tab's freshly spawned terminal. Absent = no agent tabs. */
    readonly startAgent?: ((paneID: string, workspaceID: string) => void) | undefined;
}

export interface WorkspaceTabChannel {
    run(command: ImmediateWorkspaceTabCommand, payload: Record<string, unknown>): JsonObject;
    run(command: WorkspaceTabCommand, payload: Record<string, unknown>): JsonObject | Promise<JsonObject>;
}

export function createWorkspaceTabChannel(options: WorkspaceTabChannelOptions): WorkspaceTabChannel {
    const { ctx } = options;
    const now = (): number => (ctx.clock ?? Date.now)();
    const mintPane = (): string => (ctx.mintPaneID ?? newUUID)();
    const mintTab = (): string => (ctx.mintTabID ?? newUUID)();
    const state = () => ctx.store.getState();

    const workspaceFor = (payload: Record<string, unknown>): WorkspaceState | null => {
        const id = text(payload['workspace_id']);
        return id === undefined ? null : workspaceByID(state(), id);
    };

    /** Every pane id the workspace holds, both lanes: what a close compares before and after. */
    const allPaneIDs = (workspace: WorkspaceState | null): Set<string> =>
        new Set(workspace === null ? [] : [...workspace.panes, ...workspace.parkedPanes].map((pane) => pane.id));

    /**
     * Dispatch a close and end the PTY (and terminal state) of every pane it removed, as
     * `pane-close` does for one. Document panes save first, and a save that fails refuses the
     * whole close (the error, else null), exactly as it refuses a pane's.
     */
    const closeAndReap = (workspaceID: string, closing: readonly string[], action: DomainAction): string | null => {
        try {
            ctx.prepareDocumentClose?.(closing);
        } catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
        const before = allPaneIDs(workspaceByID(state(), workspaceID));
        ctx.store.dispatch(action);
        const after = allPaneIDs(workspaceByID(state(), workspaceID));
        for (const paneID of before) {
            if (after.has(paneID)) continue;
            ctx.pty.kill(paneID);
            ctx.term.dispose(paneID);
        }
        refreshSyncGroup(ctx, workspaceID);
        return null;
    };

    /**
     * The pane a new tab is opened from: `source_pane_id` when it names a visible pane of this
     * workspace (the control socket sends its caller, which may sit in a background tab), else
     * the focused pane of the tab on screen (the window, which sends none).
     */
    const sourcePane = (workspace: WorkspaceState, payload: Record<string, unknown>): Pane | null => {
        const named = text(payload['source_pane_id']);
        const source = named === undefined ? null : visiblePane(workspace, named);
        if (source !== null) return source;
        return workspace.focusedPaneID === null ? null : visiblePane(workspace, workspace.focusedPaneID);
    };

    /**
     * Where a new tab goes: Settings ▸ Workspaces "New tabs go", unless the caller says. "Next to
     * the current tab" is next to the source pane's tab when one was named, else the tab on screen.
     */
    const newTabIndex = (workspace: WorkspaceState, payload: Record<string, unknown>): number => {
        const asked = integer(payload['index']);
        if (asked !== undefined) return asked;
        if ((ctx.newTabPosition?.() ?? 'after-current') === 'end') return workspaceTabs(workspace).length;
        const named = text(payload['source_pane_id']);
        const from = named === undefined ? null : tabOfPane(workspace, named);
        return tabIndex(workspace, from?.id ?? activeTabIDOf(workspace)) + 1;
    };

    /** "A terminal in the workspace folder": its repository's worktree, else where the tab on screen is. */
    const workspaceFolder = (workspace: WorkspaceState): string | null => {
        const repo = workspace.repoAssociations[0]?.worktreePath;
        if (repo !== undefined && repo !== '') return repo;
        const focused = workspace.focusedPaneID === null ? null : visiblePane(workspace, workspace.focusedPaneID);
        return focused?.workingDirectory ?? null;
    };

    /**
     * Where each of these shells really is, for the ones the OS could say (`liveWorkingDirectory`,
     * the seam a split asks). Null when there is nothing to ask, so the caller can answer at once.
     */
    const liveDirectories = (
        workspace: WorkspaceState,
        paneIDs: readonly string[]
    ): Promise<Record<string, string>> | null => {
        const lookup = ctx.liveWorkingDirectory;
        const shells = paneIDs.filter((paneID) => visiblePane(workspace, paneID)?.type === 'shell');
        if (lookup === undefined || shells.length === 0) return null;
        // Each shell on its own deadline, so one stuck lookup costs only its own answer.
        const asked = shells.map((paneID) =>
            withDeadline(
                Promise.resolve().then(() => lookup(paneID)),
                null,
                LIVE_DIRECTORY_DEADLINE_MS
            )
        );
        return Promise.all(asked).then((found) => {
            const directories: Record<string, string> = {};
            shells.forEach((paneID, index) => {
                const directory = found[index];
                if (typeof directory === 'string' && directory !== '') directories[paneID] = directory;
            });
            return directories;
        });
    };

    const newTab = (payload: Record<string, unknown>): JsonObject | Promise<JsonObject> => {
        const workspace = workspaceFor(payload);
        if (workspace === null) return failure('workspace-tab-new requires a known workspace_id');
        // A url and no kind is a web tab at that address, whatever "A new tab opens" says.
        const requested = text(payload['kind']) ?? (text(payload['url']) !== undefined ? 'web' : undefined) ?? options.newTabOpens?.() ?? 'terminal';
        if (!(NEW_TAB_KINDS as readonly string[]).includes(requested)) {
            return failure(`unknown tab kind '${requested}': use ${NEW_TAB_KINDS.join(', ')}`);
        }
        if (requested === 'agent' && options.startAgent === undefined) return failure('this daemon cannot start agents');
        // A web tab may open at an address (`kelpi tab new --url`); every other kind has none to open.
        const url = payload['url'];
        if (url !== undefined && url !== null) {
            if (typeof url !== 'string' || url.trim() === '') return failure('workspace-tab-new: url must be a non-empty string');
            if (requested !== 'web') return failure(`workspace-tab-new: a url is for a web tab, not a ${requested} tab`);
        }
        const focusedPane = sourcePane(workspace, payload);
        // "The same kind as the focused pane", for a shell: a terminal where that shell is now,
        // which only the OS knows (OSC 7 may never have said), so ask before opening it.
        const asking = requested === 'same' && focusedPane?.type === 'shell' ? liveDirectories(workspace, [focusedPane.id]) : null;
        if (asking === null || focusedPane === null) return openNewTab(payload, requested as NewTabKind, {}, null);
        const shown = activeTabIDOf(workspace);
        return asking.then((found) => openNewTab(payload, requested as NewTabKind, found, shown));
    };

    /**
     * Whether a tab opened after a wait may take the screen: only if it was asked to and the
     * user is still looking at the tab they were on when it was asked for (`shownBefore`; null =
     * nothing was waited on). A tab they switched to meanwhile is theirs, so the new one opens
     * behind it instead.
     */
    const mayShow = (payload: Record<string, unknown>, workspace: WorkspaceState, shownBefore: string | null): boolean =>
        payload['focus'] !== false && (shownBefore === null || activeTabIDOf(workspace) === shownBefore);

    /**
     * `newTab` once any wait is over: re-read, since the workspace can change or go meanwhile. A
     * directory found for a shell that is no longer the focused one is not used.
     */
    const openNewTab = (
        payload: Record<string, unknown>,
        requested: NewTabKind,
        liveDirectories: Readonly<Record<string, string>>,
        shownBefore: string | null
    ): JsonObject => {
        const workspace = workspaceFor(payload);
        if (workspace === null) return failure('workspace-tab-new requires a known workspace_id');
        let kind = requested;
        const focusedPane = sourcePane(workspace, payload);
        if (kind === 'same') {
            // The kinds a tab can be opened as; anything else (a diff, a document, a plugin
            // view) has no blank form, so it opens a terminal.
            kind = focusedPane?.type === 'web' ? 'web' : focusedPane?.type === 'scratchpad' ? 'scratchpad' : 'terminal';
        }
        const tabID = mintTab();
        const paneID = mintPane();
        const at = now();
        let create: DomainAction;
        // As `web-open` reads it: `about:blank` is the blank page, whose URL bar takes the caret.
        const asked = typeof payload['url'] === 'string' ? payload['url'].trim() : '';
        const url = asked === 'about:blank' ? '' : asked;
        if (kind === 'web') {
            create = { type: 'open-web-pane', workspaceID: workspace.id, paneID, tabID: mintTab(), url, now: at, focus: true };
        } else if (kind === 'scratchpad') {
            create = { type: 'create-scratchpad', workspaceID: workspace.id, paneID, now: at };
        } else {
            const directory =
                requested === 'same' && focusedPane?.type === 'shell'
                    ? (liveDirectories[focusedPane.id] ?? focusedPane.workingDirectory)
                    : workspaceFolder(workspace);
            create = { type: 'create-pane', workspaceID: workspace.id, paneID, now: at, workingDirectory: directory, focus: true };
        }
        const focus = mayShow(payload, workspace, shownBefore);
        ctx.store.dispatch({
            type: 'create-tab',
            workspaceID: workspace.id,
            tabID,
            index: newTabIndex(workspace, payload),
            focus,
            create
        });
        const after = workspaceByID(state(), workspace.id);
        if (after === null || tabByID(after, tabID) === null) return failure('the new tab could not be opened');
        spawnPaneIfShell(ctx, workspace.id, paneID);
        if (kind === 'agent') options.startAgent?.(paneID, workspace.id);
        refreshSyncGroup(ctx, workspace.id);
        return { ok: true, workspace_id: workspace.id, tab_id: tabID, pane_id: paneID, kind, ...(kind === 'web' ? { url: normalizeURLInput(url) } : {}) };
    };

    const tabArgs = (
        payload: Record<string, unknown>,
        verb: string
    ): { readonly workspace: WorkspaceState; readonly tabID: string } | JsonObject => {
        const workspace = workspaceFor(payload);
        if (workspace === null) return failure(`${verb} requires a known workspace_id`);
        const tabID = text(payload['tab_id']);
        if (tabID === undefined || tabByID(workspace, tabID) === null) return failure(`${verb}: no such tab in '${workspace.name}'`);
        return { workspace, tabID };
    };

    const isFailure = (value: unknown): value is JsonObject =>
        typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;

    /**
     * Duplicate Tab (workspace-feature.md §12.5): ask where the tab's shells really are, then
     * copy the tab as it is by then, minting an id for every pane in it, in one dispatch.
     */
    const duplicate = (payload: Record<string, unknown>): JsonObject | Promise<JsonObject> => {
        const args = tabArgs(payload, 'workspace-tab-duplicate');
        if (isFailure(args)) return args;
        const asking = liveDirectories(args.workspace, copySources(args.workspace, args.tabID));
        if (asking === null) return copyTab(payload, {}, null);
        const shown = activeTabIDOf(args.workspace);
        return asking.then((directories) => copyTab(payload, directories, shown));
    };

    const copyTab = (
        payload: Record<string, unknown>,
        workingDirectories: Readonly<Record<string, string>>,
        shownBefore: string | null
    ): JsonObject => {
        const before = tabArgs(payload, 'workspace-tab-duplicate');
        if (isFailure(before)) return before;
        // Save what is being typed into the tab's documents first (a scratchpad holds its last
        // keystrokes in a buffer for half a second), so the copy has it. This saves and closes
        // nothing; a save that fails leaves the copy with what was saved before it.
        try {
            ctx.prepareDocumentClose?.(copySources(before.workspace, before.tabID));
        } catch {
            // The copy takes what is saved.
        }
        const args = tabArgs(payload, 'workspace-tab-duplicate');
        if (isFailure(args)) return args;
        const workspace = args.workspace;
        const sources = copySources(workspace, args.tabID);
        const paneIDs: Record<string, string> = {};
        const webTabIDs: Record<string, string> = {};
        for (const sourceID of sources) {
            paneIDs[sourceID] = mintPane();
            if (visiblePane(workspace, sourceID)?.type === 'web') webTabIDs[sourceID] = mintTab();
        }
        const newTabID = mintTab();
        ctx.store.dispatch({
            type: 'duplicate-tab',
            workspaceID: workspace.id,
            tabID: args.tabID,
            newTabID,
            paneIDs,
            webTabIDs,
            workingDirectories,
            now: now(),
            focus: mayShow(payload, workspace, shownBefore)
        });
        const after = workspaceByID(state(), workspace.id);
        if (after === null || tabByID(after, newTabID) === null) return failure('the tab could not be duplicated');
        const copies = sources.map((sourceID) => paneIDs[sourceID] as string);
        for (const paneID of copies) spawnPaneIfShell(ctx, workspace.id, paneID);
        refreshSyncGroup(ctx, workspace.id);
        return { ok: true, workspace_id: workspace.id, tab_id: newTabID, pane_ids: copies };
    };

    const run = (command: WorkspaceTabCommand, payload: Record<string, unknown>): JsonObject | Promise<JsonObject> => {
        switch (command) {
            case 'workspace-tab-new':
                return newTab(payload);
            case 'workspace-tab-duplicate':
                return duplicate(payload);
            case 'workspace-tab-select': {
                const args = tabArgs(payload, command);
                if (isFailure(args)) return args;
                ctx.store.dispatch({ type: 'select-tab', workspaceID: args.workspace.id, tabID: args.tabID });
                refreshSyncGroup(ctx, args.workspace.id);
                return { ok: true, workspace_id: args.workspace.id, tab_id: args.tabID };
            }
            case 'workspace-tab-rename': {
                const args = tabArgs(payload, command);
                if (isFailure(args)) return args;
                const raw = payload['name'];
                if (raw !== null && typeof raw !== 'string') return failure('workspace-tab-rename requires a name (or null to clear it)');
                ctx.store.dispatch({ type: 'rename-tab', workspaceID: args.workspace.id, tabID: args.tabID, name: raw });
                return { ok: true, workspace_id: args.workspace.id, tab_id: args.tabID };
            }
            case 'workspace-tab-move': {
                const args = tabArgs(payload, command);
                if (isFailure(args)) return args;
                const index = integer(payload['index']);
                if (index === undefined) return failure('workspace-tab-move requires an index');
                ctx.store.dispatch({ type: 'move-tab', workspaceID: args.workspace.id, tabID: args.tabID, toIndex: index });
                return { ok: true, workspace_id: args.workspace.id, tab_id: args.tabID };
            }
            case 'workspace-tab-close': {
                const args = tabArgs(payload, command);
                if (isFailure(args)) return args;
                if (workspaceTabs(args.workspace).length <= 1) return failure('a workspace keeps at least one tab');
                const closing = workspaceTabPanes(args.workspace, args.tabID);
                const refused = closeAndReap(args.workspace.id, closing, { type: 'close-tab', workspaceID: args.workspace.id, tabID: args.tabID });
                if (refused !== null) return failure(refused);
                return { ok: true, workspace_id: args.workspace.id, tab_id: args.tabID, closed: closing.length };
            }
            case 'workspace-tab-close-others': {
                const args = tabArgs(payload, command);
                if (isFailure(args)) return args;
                const closing = workspaceTabs(args.workspace)
                    .filter((tab) => tab.id !== args.tabID)
                    .flatMap((tab) => workspaceTabPanes(args.workspace, tab.id));
                const refused = closeAndReap(args.workspace.id, closing, { type: 'close-other-tabs', workspaceID: args.workspace.id, tabID: args.tabID });
                if (refused !== null) return failure(refused);
                return { ok: true, workspace_id: args.workspace.id, tab_id: args.tabID, closed: closing.length };
            }
            case 'workspace-tab-split-panes': {
                const args = tabArgs(payload, command);
                if (isFailure(args)) return args;
                const count = workspaceTabPanes(args.workspace, args.tabID).length;
                if (count <= 1) return failure('the tab has only one pane');
                const newTabIDs = Array.from({ length: count - 1 }, () => mintTab());
                ctx.store.dispatch({ type: 'split-tab-panes', workspaceID: args.workspace.id, tabID: args.tabID, newTabIDs });
                refreshSyncGroup(ctx, args.workspace.id);
                return { ok: true, workspace_id: args.workspace.id, tab_id: args.tabID, tab_ids: newTabIDs };
            }
            case 'workspace-tab-merge-previous': {
                const args = tabArgs(payload, command);
                if (isFailure(args)) return args;
                const at = tabIndex(args.workspace, args.tabID);
                if (at <= 0) return failure('the first tab has no tab before it to merge into');
                const into = workspaceTabs(args.workspace)[at - 1]?.id ?? args.tabID;
                ctx.store.dispatch({ type: 'merge-tab-into-previous', workspaceID: args.workspace.id, tabID: args.tabID });
                refreshSyncGroup(ctx, args.workspace.id);
                // The merged tab is gone: the reply names the tab it went into, as the control
                // socket's does, and the one that went as `merged_tab_id`.
                return { ok: true, workspace_id: args.workspace.id, tab_id: into, merged_tab_id: args.tabID };
            }
            case 'workspace-tab-move-to-workspace': {
                const args = tabArgs(payload, command);
                if (isFailure(args)) return args;
                const toID = text(payload['to_workspace_id']);
                const target = toID === undefined ? null : workspaceByID(state(), toID);
                if (target === null) return failure('workspace-tab-move-to-workspace requires a known to_workspace_id');
                if (target.id === args.workspace.id) return failure('the tab is already in that workspace');
                ctx.store.dispatch({
                    type: 'move-tab-to-workspace',
                    workspaceID: args.workspace.id,
                    tabID: args.tabID,
                    toWorkspaceID: target.id,
                    replacementTabID: mintTab(),
                    focus: payload['focus'] !== false
                });
                const moved = workspaceByID(state(), target.id);
                if (moved === null || tabByID(moved, args.tabID) === null) return failure('the tab could not be moved');
                refreshSyncGroup(ctx, args.workspace.id);
                refreshSyncGroup(ctx, target.id);
                // The window follows the tab, as it follows a pane moved to a workspace: the reducer
                // made the target active, and `reveal-pane` is how a window is told to go there.
                if (payload['focus'] !== false && moved.focusedPaneID !== null) {
                    ctx.broadcast({ type: 'reveal-pane', workspaceID: target.id, paneID: moved.focusedPaneID });
                }
                return { ok: true, workspace_id: target.id, tab_id: args.tabID };
            }
            case 'pane-move-to-new-tab': {
                const paneID = text(payload['pane_id']);
                const workspace = paneID === undefined ? null : workspaceContainingVisiblePane(state(), paneID);
                if (paneID === undefined || workspace === null || tabOfPane(workspace, paneID) === null) {
                    return failure('pane-move-to-new-tab requires a pane in a tab');
                }
                const tabID = mintTab();
                const index = integer(payload['index']);
                ctx.store.dispatch({
                    type: 'move-pane-to-new-tab',
                    workspaceID: workspace.id,
                    paneID,
                    tabID,
                    ...(index === undefined ? {} : { index }),
                    focus: payload['focus'] !== false
                });
                refreshSyncGroup(ctx, workspace.id);
                const after = workspaceByID(state(), workspace.id);
                const landed = after === null ? null : tabOfPane(after, paneID);
                return { ok: true, workspace_id: workspace.id, pane_id: paneID, tab_id: landed?.id ?? tabID };
            }
            case 'pane-move-to-tab': {
                const paneID = text(payload['pane_id']);
                const workspace = paneID === undefined ? null : workspaceContainingVisiblePane(state(), paneID);
                const tabID = text(payload['tab_id']);
                if (paneID === undefined || workspace === null || tabID === undefined || tabByID(workspace, tabID) === null) {
                    return failure('pane-move-to-tab requires a pane and a tab of the same workspace');
                }
                // The wire's edge names (`kelpi pane move --target`), as `pane-move-adjacent` takes them.
                const zoneValue = text(payload['zone']);
                if (zoneValue !== undefined && !(DROP_ZONES as readonly string[]).includes(zoneValue)) {
                    return failure(`unknown zone '${zoneValue}': use ${DROP_ZONES.join(', ')}`);
                }
                const targetPaneID = text(payload['target_pane_id']);
                ctx.store.dispatch({
                    type: 'move-pane-to-tab',
                    workspaceID: workspace.id,
                    paneID,
                    tabID,
                    ...(targetPaneID === undefined ? {} : { targetPaneID }),
                    ...(zoneValue === undefined ? {} : { zone: dropZoneForWireEdge(zoneValue as WireDropZone) }),
                    focus: payload['focus'] !== false
                });
                refreshSyncGroup(ctx, workspace.id);
                return { ok: true, workspace_id: workspace.id, pane_id: paneID, tab_id: tabID };
            }
        }
    };

    // One implementation behind both signatures: only the two waiting verbs ever return a promise.
    return { run: run as WorkspaceTabChannel['run'] };
}

/** A tab's panes, in layout order (none for an unknown tab). */
function workspaceTabPanes(workspace: WorkspaceState, tabID: string): string[] {
    const tab = tabByID(workspace, tabID);
    return tab === null ? [] : tabPaneIDs(workspace, tab);
}

/** The panes a copy of the tab takes, in layout order (`duplicableTree`; none for an unknown tab). */
function copySources(workspace: WorkspaceState, tabID: string): string[] {
    const tab = tabByID(workspace, tabID);
    return tab === null ? [] : treePaneIDs(duplicableTree(workspace, tab));
}
