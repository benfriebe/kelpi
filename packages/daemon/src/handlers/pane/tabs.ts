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

import { idsEqual, isUUIDToken, resolvePaneInWorkspace, resolveWorkspaceStrict, workspacesMatchingName } from '@kelpi/core/resolve';
import type { JsonObject, WireMessage } from '@kelpi/protocol';

import type { CommandHandler, ReplyHandle } from '../../seams.js';
import {
    activeTabIDOf,
    resolveStateOf,
    tabIndex,
    tabLayout,
    tabOfPane,
    tabPaneIDs,
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

/** `workspace` named, else the caller's workspace, else the active one. */
function resolveWorkspace(state: DaemonState, named: string | undefined, paneID: string | undefined): Resolved<WorkspaceState> {
    if (named !== undefined) {
        const resolved = resolveWorkspaceStrict(resolveStateOf(state), named);
        const workspace = resolved === null ? null : workspaceByID(state, resolved.id);
        if (workspace !== null) return found(workspace);
        if (workspacesMatchingName(resolveStateOf(state), named).length > 1) {
            return missing(`workspace name '${named}' is ambiguous: use its id`);
        }
        return missing(`workspace not found: ${named}`);
    }
    if (paneID !== undefined) {
        const workspace = workspaceContainingVisiblePane(state, paneID);
        if (workspace !== null) return found(workspace);
    }
    const active = state.lastActiveWorkspaceID === null ? null : workspaceByID(state, state.lastActiveWorkspaceID);
    const fallback = active ?? state.workspaces[0] ?? null;
    return fallback === null ? missing('there are no workspaces') : found(fallback);
}

/**
 * A tab of `workspace` by 1-based number, then id, then the title the bar shows (exactly, then
 * ignoring case). Two tabs with the same title are ambiguous, never a guess.
 */
export function resolveWorkspaceTab(workspace: WorkspaceState, token: string): Resolved<WorkspaceTab> {
    const tabs = workspaceTabs(workspace);
    if (/^[0-9]+$/.test(token)) {
        const number = Number(token);
        const tab = number >= 1 ? tabs[number - 1] : undefined;
        if (tab !== undefined) return found(tab);
        return missing(`no tab ${token} in workspace '${workspace.name}' (it has ${plural(tabs.length, 'tab')})`);
    }
    if (isUUIDToken(token)) {
        const byID = tabs.find((tab) => idsEqual(tab.id, token));
        if (byID !== undefined) return found(byID);
    }
    const titled = tabs.map((tab, index) => ({ tab, number: index + 1, title: workspaceTabTitle(workspace, tab) }));
    const folded = token.toLowerCase();
    for (const matches of [
        titled.filter((entry) => entry.title === token),
        titled.filter((entry) => entry.title.toLowerCase() === folded)
    ]) {
        if (matches.length === 1) return found((matches[0] as (typeof titled)[number]).tab);
        if (matches.length > 1) {
            const numbers = matches.map((entry) => String(entry.number)).join(', ');
            return missing(`tab name '${token}' is ambiguous in workspace '${workspace.name}': tabs ${numbers} (use a number or id)`);
        }
    }
    return missing(`no tab matching '${token}' in workspace '${workspace.name}'`);
}

/** `tab` named, else the caller's own tab when the caller is in this workspace. */
function resolveTab(workspace: WorkspaceState, named: string | undefined, paneID: string | undefined): Resolved<WorkspaceTab> {
    if (named !== undefined) return resolveWorkspaceTab(workspace, named);
    const own = paneID === undefined ? null : tabOfPane(workspace, paneID);
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
    const workspace = resolveWorkspace(state, msg.workspace, msg.pane_id);
    if (!workspace.ok) {
        sendError(reply, workspace.error);
        return;
    }
    const tab = resolveTab(workspace.value, msg.tab, msg.pane_id);
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
    const workspace = resolveWorkspace(state, msg.workspace, msg.pane_id);
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
    const workspace = resolveWorkspace(ctx.store.getState(), msg.workspace, msg.pane_id);
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
        const result = await runChannel(ctx, 'workspace-tab-new', {
            workspace_id: workspace.value.id,
            ...(msg.kind !== undefined ? { kind: msg.kind } : {}),
            ...(index !== undefined ? { index } : {}),
            focus: msg.focus === true
        });
        const error = failed(result);
        if (error !== null) {
            sendError(reply, error);
            return;
        }
        const tabID = String(result['tab_id']);
        if (msg.name !== undefined) ctx.store.dispatch({ type: 'rename-tab', workspaceID: workspace.value.id, tabID, name: msg.name });
        sendOK(reply, {
            ...placed(ctx, workspace.value.id, tabID),
            pane_id: result['pane_id'] ?? null,
            kind: result['kind'] ?? null,
            ...(msg.name !== undefined ? { name: msg.name } : {})
        });
    });
};

/** select / close / close-others / split-panes / merge-previous: the channel's payload is just the ids. */
function plainTabVerb(command: 'workspace-tab-select' | 'workspace-tab-close' | 'workspace-tab-close-others' | 'workspace-tab-split-panes' | 'workspace-tab-merge-previous'): CommandHandler<PaneHandlerContext> {
    return (msg, ctx, reply) => {
        if (msg.command !== command) return;
        withTab(msg, ctx, reply, async (workspace, tab) => {
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
        sendOK(reply, { ...placed(ctx, workspace.id, tab.id), name });
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
        const target = resolveWorkspace(ctx.store.getState(), msg.to_workspace, undefined);
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
    const tab = resolveWorkspaceTab(workspace, msg.tab);
    if (!tab.ok) {
        sendError(reply, tab.error);
        return;
    }
    let anchorID: string | undefined;
    if (msg.anchor !== undefined) {
        const resolved = resolvePaneInWorkspace(resolveStateOf(ctx.store.getState()), workspace.id, msg.anchor);
        if (resolved === null || !tabPaneIDs(workspace, tab.value).includes(resolved)) {
            sendError(reply, `no pane matching '${msg.anchor}' in that tab`);
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
