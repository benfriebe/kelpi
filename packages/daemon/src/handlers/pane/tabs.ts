/**
 * The workspace-tab verbs on the control socket (workspace-feature.md §12, socket-handlers.md
 * §4.17): `kelpi tab …`, `kelpi pane move-to-tab|move-to-new-tab` and the plugin SDK's reads.
 *
 * The window sends the same verbs over its WS channel with exact ids (`ws/workspace-tabs.ts`).
 * These handlers are that channel behind the control socket's conventions, and nothing more:
 *   - what they touch is NAMED: `workspace` is a name-or-id (absent = the caller's workspace,
 *     else the active one) and `tab` a 1-based number, an id, or the title the tab bar shows
 *     (absent = the caller's own tab, for the verbs that take one);
 *   - absent `focus` means BACKGROUND (#295), as on every other control verb, where the WS
 *     channel reads absent as a gesture.
 * Every reply names the workspace and the tab's number as it stands after the change, so a
 * script can address the tab next without listing first.
 */

import { describeAgentSummary } from '@kelpi/core/agent';
import { dropZoneForWireEdge } from '@kelpi/core/layout';
import { idsEqual, isUUIDToken, resolvePaneInWorkspace, resolveWorkspaceLenient, resolveWorkspaceStrict, workspacesMatchingName } from '@kelpi/core/resolve';
import type { JsonObject, WireMessage } from '@kelpi/protocol';

import type { CommandHandler, ReplyHandle } from '../../seams.js';
import {
    activeTabIDOf,
    resolveStateOf,
    tabIndex,
    tabLayout,
    tabOfPane,
    tabPaneIDs,
    tabsAgentSummary,
    workspaceByID,
    workspaceContainingVisiblePane,
    workspaceTabStatus,
    workspaceTabTitle,
    workspaceTabs,
    type DaemonState,
    type WorkspaceState,
    type WorkspaceTab
} from '../../store/index.js';
import { createWorkspaceTabChannel, type WorkspaceTabCommand } from '../../ws/workspace-tabs.js';
import type { PaneHandlerContext } from './context.js';
import { resolveTarget, sendError, sendOK } from './support.js';

type Resolved<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

function found<T>(value: T): Resolved<T> {
    return { ok: true, value };
}

function missing<T>(error: string): Resolved<T> {
    return { ok: false, error };
}

function plural(count: number, noun: string): string {
    return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/** What a tab verb names: the decoded scope (`TabScope`), by name or by the WS shape's exact ids. */
interface TabReference {
    readonly pane_id?: string | undefined;
    readonly workspace?: string | undefined;
    readonly workspace_id?: string | undefined;
    readonly tab?: string | undefined;
    readonly tab_id?: string | undefined;
}

/** The workspace holding a tab with this id; tab ids are UUIDs, unique across every workspace. */
function workspaceHoldingTab(state: DaemonState, tabID: string): WorkspaceState | null {
    return state.workspaces.find((workspace) => workspaceTabs(workspace).some((tab) => idsEqual(tab.id, tabID))) ?? null;
}

/**
 * The workspace a tab verb acts in: the one named (by name-or-id, or `workspace_id` by id only),
 * else the one holding the tab named by id (`tab_id`, or a `tab` that is a tab's UUID), else
 * the caller's, else the active one. A caller pane that is gone or parked is an error, as it is
 * for the pane verbs (`resolvePaneTarget`), never a quiet fall back to whatever is on screen.
 */
function resolveWorkspace(state: DaemonState, ref: TabReference): Resolved<WorkspaceState> {
    if (ref.workspace_id !== undefined) {
        const byID = state.workspaces.find((workspace) => idsEqual(workspace.id, ref.workspace_id as string)) ?? null;
        return byID === null ? missing(`no workspace with id ${ref.workspace_id}`) : found(byID);
    }
    if (ref.workspace !== undefined) {
        const resolved = resolveWorkspaceStrict(resolveStateOf(state), ref.workspace);
        const workspace = resolved === null ? null : workspaceByID(state, resolved.id);
        if (workspace !== null) return found(workspace);
        if (workspacesMatchingName(resolveStateOf(state), ref.workspace).length > 1) {
            return missing(`workspace name '${ref.workspace}' is ambiguous: use its id`);
        }
        return missing(`workspace not found: ${ref.workspace}`);
    }
    const tabID = ref.tab_id ?? (ref.tab !== undefined && isUUIDToken(ref.tab) ? ref.tab : undefined);
    if (tabID !== undefined) {
        const holder = workspaceHoldingTab(state, tabID);
        if (holder !== null) return found(holder);
        if (ref.tab_id !== undefined) return missing(`no tab with id ${ref.tab_id}`);
    }
    if (ref.pane_id !== undefined) {
        const workspace = workspaceContainingVisiblePane(state, ref.pane_id);
        if (workspace !== null) return found(workspace);
        return missing(`origin pane '${ref.pane_id}' no longer exists; pass --workspace <name-or-id> to address a tab in another workspace`);
    }
    const active = state.lastActiveWorkspaceID === null ? null : workspaceByID(state, state.lastActiveWorkspaceID);
    const fallback = active ?? state.workspaces[0] ?? null;
    return fallback === null ? missing('there are no workspaces') : found(fallback);
}

/**
 * A tab of `workspace` by 1-based number, then id, then a name the user gave it (exactly, then
 * ignoring case), then the title the bar derives from its pane (the same two ways). A number
 * past the last tab is tried as a title before it is an error, so a tab named "7" in a two-tab
 * workspace is still reachable; a number in range is always the position. Two tabs that match
 * at the same step are ambiguous, never a guess.
 */
export function resolveWorkspaceTab(workspace: WorkspaceState, token: string): Resolved<WorkspaceTab> {
    const tabs = workspaceTabs(workspace);
    const numbered = /^[0-9]+$/.test(token);
    if (numbered) {
        const number = Number(token);
        const tab = number >= 1 ? tabs[number - 1] : undefined;
        if (tab !== undefined) return found(tab);
    }
    if (isUUIDToken(token)) {
        const byID = tabs.find((tab) => idsEqual(tab.id, token));
        if (byID !== undefined) return found(byID);
    }
    // A name the user gave a tab outranks a title derived from its pane: a program setting its
    // terminal title (or a page its <title>) can never shadow a named tab, or make it ambiguous.
    const entries = tabs.map((tab, index) => ({ tab, number: index + 1, title: workspaceTabTitle(workspace, tab) }));
    const named = entries.filter((entry) => entry.tab.name !== null);
    const derived = entries.filter((entry) => entry.tab.name === null);
    const folded = token.toLowerCase();
    for (const matches of [
        named.filter((entry) => entry.title === token),
        named.filter((entry) => entry.title.toLowerCase() === folded),
        derived.filter((entry) => entry.title === token),
        derived.filter((entry) => entry.title.toLowerCase() === folded)
    ]) {
        if (matches.length === 1) return found((matches[0] as (typeof entries)[number]).tab);
        if (matches.length > 1) {
            const numbers = matches.map((entry) => String(entry.number)).join(', ');
            return missing(`tab name '${token}' is ambiguous in workspace '${workspace.name}': tabs ${numbers} (use a number or id)`);
        }
    }
    if (numbered) return missing(`no tab ${token} in workspace '${workspace.name}' (it has ${plural(tabs.length, 'tab')})`);
    return missing(`no tab matching '${token}' in workspace '${workspace.name}'`);
}

/** `tab_id` by id only, else `tab` by number, id or title, else the caller's own tab when it is in this workspace. */
function resolveTab(workspace: WorkspaceState, ref: TabReference): Resolved<WorkspaceTab> {
    if (ref.tab_id !== undefined) {
        const byID = workspaceTabs(workspace).find((tab) => idsEqual(tab.id, ref.tab_id as string));
        return byID === undefined ? missing(`no tab with id ${ref.tab_id} in workspace '${workspace.name}'`) : found(byID);
    }
    if (ref.tab !== undefined) return resolveWorkspaceTab(workspace, ref.tab);
    const own = ref.pane_id === undefined ? null : tabOfPane(workspace, ref.pane_id);
    return own === null ? missing(`name a tab in workspace '${workspace.name}': a number, an id or a title`) : found(own);
}

/** One `workspace-tab-list` entry. */
function tabEntry(workspace: WorkspaceState, tab: WorkspaceTab, index: number): JsonObject {
    const paneIDs = tabPaneIDs(workspace, tab);
    return {
        id: tab.id,
        number: index + 1,
        name: tab.name,
        title: workspaceTabTitle(workspace, tab),
        workspace_id: workspace.id,
        workspace_name: workspace.name,
        pane_ids: paneIDs,
        pane_count: paneIDs.length,
        is_active: tab.id === activeTabIDOf(workspace),
        status: workspaceTabStatus(workspace, tab),
        zoomed: tabLayout(workspace, tab).zoomedPaneID !== null
    };
}

/**
 * Where `move-to-workspace` sends a tab: by exact id (`to_workspace_id`), else by the lenient
 * resolver `pane move-to-workspace` uses (§2.3: id, then a name in any case, then a slug), so
 * `--to-workspace OPS` finds "ops" for a tab as it does for a pane.
 */
function resolveDestination(state: DaemonState, named: string | undefined, id: string | undefined): Resolved<WorkspaceState> {
    if (id !== undefined) {
        const byID = state.workspaces.find((workspace) => idsEqual(workspace.id, id)) ?? null;
        return byID === null ? missing(`no workspace with id ${id}`) : found(byID);
    }
    const resolved = named === undefined ? null : resolveWorkspaceLenient(resolveStateOf(state), named);
    const workspace = resolved === null ? null : workspaceByID(state, resolved.id);
    return workspace === null ? missing(`workspace not found: ${named ?? ''}`) : found(workspace);
}

/** The name the tab is stored with (trimmed, blank = none), for a reply that says what it was named. */
function storedName(ctx: PaneHandlerContext, workspaceID: string, tabID: string): string | null {
    const workspace = workspaceByID(ctx.store.getState(), workspaceID);
    return workspace === null ? null : (workspaceTabs(workspace).find((tab) => tab.id === tabID)?.name ?? null);
}

/** The workspace and the tab's number as they stand now, for every reply. */
function placed(ctx: PaneHandlerContext, workspaceID: string, tabID: string): JsonObject {
    const workspace = workspaceByID(ctx.store.getState(), workspaceID);
    if (workspace === null) return { workspace_id: workspaceID, tab_id: tabID };
    const index = tabIndex(workspace, tabID);
    return {
        workspace_id: workspace.id,
        workspace_name: workspace.name,
        tab_id: tabID,
        ...(index >= 0 ? { tab_number: index + 1 } : {})
    };
}

/**
 * Run one verb on the window's tab channel, built per command so it reads the settings of the
 * moment. A verb this daemon's channel does not know answers nothing, which is reported rather
 * than taken for success.
 */
async function runChannel(ctx: PaneHandlerContext, command: string, payload: Record<string, unknown>): Promise<JsonObject> {
    const channel = createWorkspaceTabChannel({
        ctx,
        ...(ctx.newTabOpens !== undefined ? { newTabOpens: ctx.newTabOpens } : {}),
        ...(ctx.startAgent !== undefined ? { startAgent: ctx.startAgent } : {})
    });
    const result = (await Promise.resolve(channel.run(command as WorkspaceTabCommand, payload))) as JsonObject | undefined;
    return result ?? { ok: false, error: `this Kelpi does not support ${command}` };
}

function failed(result: JsonObject): string | null {
    if (result['ok'] === true) return null;
    return typeof result['error'] === 'string' ? result['error'] : 'the tab command failed';
}

/** Report a thrown error as a reply rather than leaving the caller waiting. */
function guarded(reply: ReplyHandle | null, work: () => Promise<void>): void {
    void work().catch((error: unknown) => {
        sendError(reply, error instanceof Error ? error.message : String(error));
    });
}

type TabMessage = Extract<WireMessage, { readonly command: `workspace-tab-${string}` }>;

/**
 * The shape shared by every verb that acts on one named tab: resolve, then `act` with the
 * workspace and the tab. An error at either step is the reply.
 */
function withTab(
    msg: TabMessage,
    ctx: PaneHandlerContext,
    reply: ReplyHandle | null,
    act: (workspace: WorkspaceState, tab: WorkspaceTab) => Promise<void>
): void {
    const state = ctx.store.getState();
    const workspace = resolveWorkspace(state, msg);
    if (!workspace.ok) {
        sendError(reply, workspace.error);
        return;
    }
    const tab = resolveTab(workspace.value, msg);
    if (!tab.ok) {
        sendError(reply, tab.error);
        return;
    }
    guarded(reply, () => act(workspace.value, tab.value));
}

export const handleWorkspaceTabList: CommandHandler<PaneHandlerContext> = (msg, ctx, reply) => {
    if (msg.command !== 'workspace-tab-list') return;
    if (reply === null) return;
    const state = ctx.store.getState();
    if (msg.all) {
        const tabs = state.workspaces.flatMap((workspace) => workspaceTabs(workspace).map((tab, index) => tabEntry(workspace, tab, index)));
        sendOK(reply, { tabs });
        return;
    }
    const workspace = resolveWorkspace(state, msg);
    if (!workspace.ok) {
        sendError(reply, workspace.error);
        return;
    }
    sendOK(reply, {
        workspace_id: workspace.value.id,
        workspace_name: workspace.value.name,
        tabs: workspaceTabs(workspace.value).map((tab, index) => tabEntry(workspace.value, tab, index))
    });
};

export const handleWorkspaceTabNew: CommandHandler<PaneHandlerContext> = (msg, ctx, reply) => {
    if (msg.command !== 'workspace-tab-new') return;
    const workspace = resolveWorkspace(ctx.store.getState(), msg);
    if (!workspace.ok) {
        sendError(reply, workspace.error);
        return;
    }
    const count = workspaceTabs(workspace.value).length;
    if (msg.index !== undefined && msg.index < 0) {
        sendError(reply, 'a tab position starts at 1');
        return;
    }
    const index = msg.at_end ? count : msg.index === undefined ? undefined : Math.min(msg.index, count);
    guarded(reply, async () => {
        // The caller's pane, when it is in this workspace: the new tab goes after the CALLER's
        // tab (not the one on screen) and "same" copies the caller, not the pane the user has.
        const caller = msg.pane_id === undefined ? undefined : workspace.value.panes.find((pane) => idsEqual(pane.id, msg.pane_id as string))?.id;
        const result = await runChannel(ctx, 'workspace-tab-new', {
            workspace_id: workspace.value.id,
            ...(caller !== undefined ? { source_pane_id: caller } : {}),
            ...(msg.kind !== undefined ? { kind: msg.kind } : {}),
            ...(index !== undefined ? { index } : {}),
            ...(msg.url !== undefined ? { url: msg.url } : {}),
            focus: msg.focus === true
        });
        const error = failed(result);
        if (error !== null) {
            sendError(reply, error);
            return;
        }
        const tabID = String(result['tab_id']);
        if (msg.name !== undefined) ctx.store.dispatch({ type: 'rename-tab', workspaceID: workspace.value.id, tabID, name: msg.name });
        const name = storedName(ctx, workspace.value.id, tabID);
        sendOK(reply, {
            ...placed(ctx, workspace.value.id, tabID),
            pane_id: result['pane_id'] ?? null,
            kind: result['kind'] ?? null,
            ...(typeof result['url'] === 'string' ? { url: result['url'] } : {}),
            ...(name !== null ? { name } : {})
        });
    });
};

/** select / close / close-others / split-panes / merge-previous: the channel's payload is just the ids. */
function plainTabVerb(command: 'workspace-tab-select' | 'workspace-tab-close' | 'workspace-tab-close-others' | 'workspace-tab-split-panes' | 'workspace-tab-merge-previous'): CommandHandler<PaneHandlerContext> {
    return (msg, ctx, reply) => {
        if (msg.command !== command) return;
        withTab(msg, ctx, reply, async (workspace, tab) => {
            if ((msg.command === 'workspace-tab-close' || msg.command === 'workspace-tab-close-others') && !msg.force) {
                // workspace-feature.md §12.5: closing tabs ends their agents, so the control
                // socket refuses it unless told, as `workspace-delete` does for a workspace. The
                // caller's own pane is not counted (an agent closing its own tab means it).
                const closing = msg.command === 'workspace-tab-close' ? [tab.id] : workspaceTabs(workspace).map((other) => other.id).filter((id) => id !== tab.id);
                const agents = tabsAgentSummary(workspace, closing, msg.pane_id);
                if (agents.total > 0) {
                    const what = msg.command === 'workspace-tab-close' ? `tab ${String(tabIndex(workspace, tab.id) + 1)}` : `the other tabs of workspace ${workspace.name}`;
                    sendError(reply, `${what} ${msg.command === 'workspace-tab-close' ? 'has' : 'have'} ${describeAgentSummary(agents)}; pass --force to close anyway`, {
                        active_agents: agents.total,
                        running: agents.running,
                        waiting: agents.waiting,
                        inactive: agents.inactive
                    });
                    return;
                }
            }
            // Merging a tab into the one before it leaves no tab of its own to report, so the
            // reply names the tab it went into, as it stands after.
            const previous = command === 'workspace-tab-merge-previous' ? workspaceTabs(workspace)[tabIndex(workspace, tab.id) - 1] : undefined;
            const result = await runChannel(ctx, command, { workspace_id: workspace.id, tab_id: tab.id });
            const error = failed(result);
            if (error !== null) {
                sendError(reply, error);
                return;
            }
            if (command === 'workspace-tab-merge-previous') {
                sendOK(reply, { ...placed(ctx, workspace.id, previous?.id ?? tab.id), merged_tab_id: tab.id });
                return;
            }
            if (command === 'workspace-tab-close' || command === 'workspace-tab-close-others') {
                const kept = command === 'workspace-tab-close-others' ? placed(ctx, workspace.id, tab.id) : { workspace_id: workspace.id, workspace_name: workspace.name, tab_id: tab.id };
                sendOK(reply, { ...kept, closed: result['closed'] ?? 0 });
                return;
            }
            if (command === 'workspace-tab-split-panes') {
                const after = workspaceByID(ctx.store.getState(), workspace.id);
                const ids = Array.isArray(result['tab_ids']) ? (result['tab_ids'] as string[]) : [];
                sendOK(reply, {
                    ...placed(ctx, workspace.id, tab.id),
                    tab_ids: ids,
                    tab_numbers: after === null ? [] : ids.map((id) => tabIndex(after, id) + 1)
                });
                return;
            }
            sendOK(reply, placed(ctx, workspace.id, tab.id));
        });
    };
}

export const handleWorkspaceTabSelect = plainTabVerb('workspace-tab-select');
export const handleWorkspaceTabClose = plainTabVerb('workspace-tab-close');
export const handleWorkspaceTabCloseOthers = plainTabVerb('workspace-tab-close-others');
export const handleWorkspaceTabSplitPanes = plainTabVerb('workspace-tab-split-panes');
export const handleWorkspaceTabMergePrevious = plainTabVerb('workspace-tab-merge-previous');

export const handleWorkspaceTabRename: CommandHandler<PaneHandlerContext> = (msg, ctx, reply) => {
    if (msg.command !== 'workspace-tab-rename') return;
    withTab(msg, ctx, reply, async (workspace, tab) => {
        const name = msg.clear ? null : (msg.name ?? null);
        const result = await runChannel(ctx, 'workspace-tab-rename', { workspace_id: workspace.id, tab_id: tab.id, name });
        const error = failed(result);
        if (error !== null) {
            sendError(reply, error);
            return;
        }
        // What was stored, not what was typed: the reducer trims, and a blank name clears.
        sendOK(reply, { ...placed(ctx, workspace.id, tab.id), name: storedName(ctx, workspace.id, tab.id) });
    });
};

export const handleWorkspaceTabMove: CommandHandler<PaneHandlerContext> = (msg, ctx, reply) => {
    if (msg.command !== 'workspace-tab-move') return;
    withTab(msg, ctx, reply, async (workspace, tab) => {
        const count = workspaceTabs(workspace).length;
        const index = msg.at_end ? count - 1 : (msg.index ?? 0);
        if (index < 0 || index >= count) {
            sendError(reply, `no position ${String(index + 1)} in workspace '${workspace.name}' (it has ${plural(count, 'tab')})`);
            return;
        }
        const result = await runChannel(ctx, 'workspace-tab-move', { workspace_id: workspace.id, tab_id: tab.id, index });
        const error = failed(result);
        if (error !== null) {
            sendError(reply, error);
            return;
        }
        sendOK(reply, placed(ctx, workspace.id, tab.id));
    });
};

export const handleWorkspaceTabDuplicate: CommandHandler<PaneHandlerContext> = (msg, ctx, reply) => {
    if (msg.command !== 'workspace-tab-duplicate') return;
    withTab(msg, ctx, reply, async (workspace, tab) => {
        const result = await runChannel(ctx, 'workspace-tab-duplicate', { workspace_id: workspace.id, tab_id: tab.id, focus: msg.focus === true });
        const error = failed(result);
        if (error !== null) {
            sendError(reply, error);
            return;
        }
        sendOK(reply, { ...placed(ctx, workspace.id, String(result['tab_id'])), source_tab_id: tab.id });
    });
};

export const handleWorkspaceTabMoveToWorkspace: CommandHandler<PaneHandlerContext> = (msg, ctx, reply) => {
    if (msg.command !== 'workspace-tab-move-to-workspace') return;
    withTab(msg, ctx, reply, async (workspace, tab) => {
        const target = resolveDestination(ctx.store.getState(), msg.to_workspace, msg.to_workspace_id);
        if (!target.ok) {
            sendError(reply, target.error);
            return;
        }
        const result = await runChannel(ctx, 'workspace-tab-move-to-workspace', {
            workspace_id: workspace.id,
            tab_id: tab.id,
            to_workspace_id: target.value.id,
            focus: msg.focus === true
        });
        const error = failed(result);
        if (error !== null) {
            sendError(reply, error);
            return;
        }
        sendOK(reply, { ...placed(ctx, target.value.id, tab.id), from_workspace_id: workspace.id });
    });
};

export const handlePaneMoveToNewTab: CommandHandler<PaneHandlerContext> = (msg, ctx, reply) => {
    if (msg.command !== 'pane-move-to-new-tab') return;
    const resolution = resolveTarget(ctx, { pane_id: msg.pane_id, target: msg.target, workspace: msg.workspace });
    if (!resolution.ok) {
        sendError(reply, resolution.error);
        return;
    }
    const { paneID, workspace } = resolution;
    const own = tabOfPane(workspace, paneID);
    if (own !== null && tabPaneIDs(workspace, own).length <= 1) {
        sendError(reply, 'the pane is alone in its tab already');
        return;
    }
    if (msg.index !== undefined && msg.index < 0) {
        sendError(reply, 'a tab position starts at 1');
        return;
    }
    const count = workspaceTabs(workspace).length;
    const index = msg.at_end ? count : msg.index === undefined ? undefined : Math.min(msg.index, count);
    guarded(reply, async () => {
        const result = await runChannel(ctx, 'pane-move-to-new-tab', {
            pane_id: paneID,
            ...(index !== undefined ? { index } : {}),
            focus: msg.focus === true
        });
        const error = failed(result);
        if (error !== null) {
            sendError(reply, error);
            return;
        }
        sendOK(reply, { ...placed(ctx, workspace.id, String(result['tab_id'])), pane_id: paneID });
    });
};

export const handlePaneMoveToTab: CommandHandler<PaneHandlerContext> = (msg, ctx, reply) => {
    if (msg.command !== 'pane-move-to-tab') return;
    const resolution = resolveTarget(ctx, { pane_id: msg.pane_id, target: msg.target, workspace: msg.workspace });
    if (!resolution.ok) {
        sendError(reply, resolution.error);
        return;
    }
    const { paneID, workspace } = resolution;
    const tab = resolveTab(workspace, { tab: msg.tab, tab_id: msg.tab_id });
    if (!tab.ok) {
        sendError(reply, tab.error);
        return;
    }
    let anchorID: string | undefined;
    const anchor = msg.anchor_id ?? msg.anchor;
    if (anchor !== undefined) {
        const resolved = resolvePaneInWorkspace(resolveStateOf(ctx.store.getState()), workspace.id, anchor);
        if (resolved === null || !tabPaneIDs(workspace, tab.value).includes(resolved)) {
            sendError(reply, `no pane matching '${anchor}' in that tab`);
            return;
        }
        if (resolved === paneID) {
            sendError(reply, 'cannot move a pane beside itself');
            return;
        }
        anchorID = resolved;
    } else if (tabOfPane(workspace, paneID)?.id === tab.value.id) {
        sendError(reply, 'the pane is in that tab already');
        return;
    }
    if (anchorID !== undefined && tabOfPane(workspace, paneID)?.id === tab.value.id) {
        // Beside a pane of its own tab: the move `kelpi pane move --target X --below Y` makes,
        // which the tab channel's cross-tab move would read as "already there" and skip.
        const zone = msg.zone ?? 'right-of';
        ctx.store.dispatch({
            type: 'move-pane-adjacent',
            workspaceID: workspace.id,
            paneID,
            targetPaneID: anchorID,
            zone: dropZoneForWireEdge(zone),
            focus: msg.focus === true
        });
        sendOK(reply, { ...placed(ctx, workspace.id, tab.value.id), pane_id: paneID, anchor_id: anchorID, zone });
        return;
    }
    guarded(reply, async () => {
        const result = await runChannel(ctx, 'pane-move-to-tab', {
            pane_id: paneID,
            tab_id: tab.value.id,
            ...(anchorID !== undefined ? { target_pane_id: anchorID, zone: msg.zone ?? 'right-of' } : {}),
            focus: msg.focus === true
        });
        const error = failed(result);
        if (error !== null) {
            sendError(reply, error);
            return;
        }
        sendOK(reply, { ...placed(ctx, workspace.id, tab.value.id), pane_id: paneID, ...(anchorID !== undefined ? { anchor_id: anchorID } : {}) });
    });
};
