/**
 * Graft → wire/WS payloads (graft-git.md §7.2–§7.4, wire-protocol.md §6.7).
 *
 * Field names, optionality and `ok` semantics are contract: `stash_ref` and `last_sync` appear
 * only when known, `error` only on an error status, and `last_sync` is ISO 8601 at SECOND
 * precision (the same formatting `workspace-list` uses).
 */

import { formatWireTimestampFromDate, normalizeUUIDLoose } from '@kelpi/core/codec';

import type { GraftOrphan, GraftSession } from './types.js';

/** The `graft-status` / `graft-changed` per-session object. */
export function graftSessionEntry(session: GraftSession): Record<string, unknown> {
    return {
        association_id: normalizeUUIDLoose(session.id),
        worktree_path: session.worktreePath,
        parent_repo_root: session.parentRepoRoot,
        branch: session.branch,
        status: session.status.kind,
        ...(session.status.kind === 'error' ? { error: session.status.message } : {}),
        ...(session.stashRef !== null ? { stash_ref: session.stashRef } : {}),
        ...(session.lastSyncAt !== null
            ? { last_sync: formatWireTimestampFromDate(new Date(session.lastSyncAt)) }
            : {})
    };
}

/** The `graft-start` `started[]` entry. */
export function graftStartedEntry(session: GraftSession): Record<string, unknown> {
    return {
        association_id: normalizeUUIDLoose(session.id),
        worktree_path: session.worktreePath,
        branch: session.branch,
        parent_repo_root: session.parentRepoRoot
    };
}

/** The WS lifecycle broadcast clients render status dots from. */
export const GRAFT_CHANGED_EVENT = 'graft-changed';

export function graftChangedEvent(sessions: readonly GraftSession[]): Record<string, unknown> {
    return { type: GRAFT_CHANGED_EVENT, sessions: sessions.map(graftSessionEntry) };
}

/**
 * Breadcrumbs found at boot — a session a crash left behind (§4.10). There is no wire verb for
 * recovering one yet (the Swift app drives it from the inspector banner), so the daemon
 * detects + announces them and M8's UI decides what to offer.
 */
export const GRAFT_ORPHANS_EVENT = 'graft-orphans';

export function graftOrphanEntry(orphan: GraftOrphan): Record<string, unknown> {
    return {
        association_id: normalizeUUIDLoose(orphan.id),
        parent_repo_root: orphan.parentRepoRoot,
        worktree_path: orphan.worktreePath,
        branch: orphan.branch,
        ...(orphan.stashRef !== null ? { stash_ref: orphan.stashRef } : {})
    };
}

export function graftOrphansEvent(orphans: readonly GraftOrphan[]): Record<string, unknown> {
    return { type: GRAFT_ORPHANS_EVENT, orphans: orphans.map(graftOrphanEntry) };
}
