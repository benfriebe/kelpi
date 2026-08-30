/**
 * Small shared readers for the app handlers: wire timestamp formatting, the reply orderings
 * (sidebar order with dedupe + never-hide append) and command narrowing.
 *
 * Spec: docs/current/socket-handlers.md §6.1, §7.1, port notes 8 and 9.
 */

import {
    epochSecondsFromUnixSeconds,
    formatWireTimestamp,
    looksLikeUnixMillis,
    normalizeUUIDLoose
} from '@kelpi/core/codec';
import type { WireMessage } from '@kelpi/protocol';

import type { ReplyHandle } from '../../seams.js';
import { groupByID, syncedPaneIDs, workspaceByID, type DaemonState } from '../../store/index.js';
import type { AppContext, AppHandler } from './context.js';

/** UUID-valued reply fields are emitted uppercase (Foundation `uuidString` casing). */
export function uuidOut(id: string): string {
    return normalizeUUIDLoose(id);
}

/**
 * ISO 8601 UTC at SECONDS precision. Tolerant on the way in: a millisecond-magnitude value
 * (a corrupt column) is rescaled rather than throwing inside a reply.
 */
export function wireTimestamp(epochSeconds: number): string {
    if (!Number.isFinite(epochSeconds)) return formatWireTimestamp(epochSecondsFromUnixSeconds(0));
    const safe = looksLikeUnixMillis(epochSeconds) ? epochSeconds / 1000 : epochSeconds;
    const clamped = Math.max(-8_640_000_000_000, Math.min(8_640_000_000_000, safe));
    return formatWireTimestamp(epochSecondsFromUnixSeconds(clamped));
}

/**
 * `workspace-list` order (§6.1): walk the top level; a workspace entry contributes itself, a
 * group entry contributes its members in child order **regardless of collapse**; dedupe
 * throughout; then append any workspace unreachable through the order, in state order, so a
 * recoverable ordering inconsistency can never hide a workspace from the CLI.
 */
export function listedWorkspaceIDs(state: DaemonState): string[] {
    const known = new Set(state.workspaces.map((workspace) => workspace.id));
    const seen = new Set<string>();
    const order: string[] = [];
    const push = (id: string): void => {
        if (!known.has(id) || seen.has(id)) return;
        seen.add(id);
        order.push(id);
    };
    for (const entry of state.topLevelOrder) {
        if (entry.kind === 'workspace') {
            push(entry.id);
            continue;
        }
        const group = groupByID(state, entry.id);
        if (group === null) continue;
        for (const childID of group.childOrder) push(childID);
    }
    for (const workspace of state.workspaces) push(workspace.id);
    return order;
}

/** `group-list` order (§7.1): top-level order deduped, then groups missing from it. */
export function listedGroupIDs(state: DaemonState): string[] {
    const known = new Set(state.groups.map((group) => group.id));
    const seen = new Set<string>();
    const order: string[] = [];
    const push = (id: string): void => {
        if (!known.has(id) || seen.has(id)) return;
        seen.add(id);
        order.push(id);
    };
    for (const entry of state.topLevelOrder) {
        if (entry.kind === 'group') push(entry.id);
    }
    for (const group of state.groups) push(group.id);
    return order;
}

/**
 * §5 `refreshSyncGroup`: push the freshly derived broadcast group into the keystroke-mirroring
 * layer after ANY change to a workspace's pane set or sync fields. A vanished workspace
 * resolves to the empty set, which deletes its group.
 */
export function refreshSyncGroup(ctx: AppContext, workspaceID: string): void {
    const workspace = workspaceByID(ctx.store.getState(), workspaceID);
    ctx.pty.setSyncGroup(
        workspaceID,
        new Set(workspace === null ? [] : syncedPaneIDs(workspace))
    );
}

/** Narrow a `HandlerTable` entry to its own wire message shape. */
export function forCommand<K extends WireMessage['command']>(
    command: K,
    handler: (
        message: Extract<WireMessage, { command: K }>,
        ctx: AppContext,
        reply: ReplyHandle | null
    ) => void
): readonly [string, AppHandler] {
    const wrapped: AppHandler = (message, ctx, reply) => {
        if (message.command !== command) return;
        handler(message as Extract<WireMessage, { command: K }>, ctx, reply);
    };
    return [command, wrapped];
}
