/**
 * The inspector's graft verbs — the WS surface behind the toggle, the swap prompt and the
 * "Graft was interrupted" banner (graft-git.md §GIT-035…§GIT-051, workspaces-sidebar.md
 * §WS-143…§WS-145).
 *
 * **Why these are WS-only and association-scoped.** The CLI's `graft-start` / `graft-stop`
 * address a SCOPE (a workspace, a repo filter, the calling pane) because that is what a
 * command line can name. The inspector addresses one row: it knows the association id, it
 * needs the failure typed (an `alreadyActive` rejection has to carry the contested parent root
 * so the swap prompt can name the repo), and it must be able to recover a breadcrumb — which
 * has no CLI verb at all. Inventing CLI verbs for those would be a compatibility surface owed
 * to the Swift CLI forever, so this family stays client-side, matched before `decodeWireObject`
 * in `sync.ts` like the other WS-only families.
 *
 *   graft-session-list    `refresh?`            → `{ok, sessions[], orphans[]}` — the initial
 *                                                 sync, and §GIT-039's owner lookup: when a
 *                                                 start is refused and the client's mirror has
 *                                                 no owner for that root, the SERVICE is asked.
 *                                                 `refresh` re-scans the registry's repos for
 *                                                 breadcrumbs (see below)
 *   graft-session-start   `association_id`      → `{ok, session}` | `{ok:false, error,
 *                                                 error_kind, parent_repo_root?}`
 *   graft-session-stop    `association_id`      → `{ok, association_id}` | `{ok:false, …}`
 *   graft-orphan-recover  `association_id`      → replays the stop sequence from the
 *                                                 breadcrumb; a failure LEAVES the breadcrumb
 *                                                 and the orphan (§GIT-045)
 *   graft-orphan-dismiss  `association_id`      → deletes the breadcrumb only
 *
 * Every reply reads from the SERVICE, never from a client mirror: a session the UI lost track
 * of must still be visible, still stoppable and still able to explain a rejection (issue #231).
 *
 * **`refresh` is a deliberate superset of the Swift app.** There, orphan detection runs once, at
 * `onAppLaunched` — which is often enough when the process IS the UI. This daemon runs for days
 * across many client sessions, and a repo registered after boot (the inspector's Add Repository,
 * auto-detect) would carry an unnoticed breadcrumb until the next restart. So a client may ask
 * for a re-scan of the registry's roots, and does when it (re)connects and when the inspector
 * opens. A root a LIVE session already claims is excluded — a healthy graft has a breadcrumb on
 * disk by design, and reporting it as interrupted would be a lie.
 */

import type { JsonObject } from '@kelpi/protocol';

import {
    errorText,
    graftErrorKind,
    graftOrphanEntry,
    graftSessionEntry,
    isGraftError,
    type GraftOrphan,
    type GraftService
} from '../graft/index.js';
import type { DaemonState, DomainAction, DomainEvent, RepoAssociation } from '../store/types.js';
import type { DomainStore } from '../seams.js';

export type GraftCommandStore = DomainStore<DaemonState, DomainAction, DomainEvent>;

export const GRAFT_UI_COMMANDS = [
    'graft-session-list',
    'graft-session-start',
    'graft-session-stop',
    'graft-orphan-recover',
    'graft-orphan-dismiss'
] as const;
export type GraftUiCommand = (typeof GRAFT_UI_COMMANDS)[number];

export function isGraftUiCommand(command: string): command is GraftUiCommand {
    return (GRAFT_UI_COMMANDS as readonly string[]).includes(command);
}

/**
 * The daemon's live orphan set: detected at boot, mutated by recover/dismiss, re-broadcast on
 * every change so a second window's banner disappears when the first window restores.
 *
 * `recover` keeps the orphan on failure — the breadcrumb and the stash are both still on disk,
 * and dropping the row would leave the user no affordance to retry (§GIT-045).
 */
export interface GraftOrphanRegistry {
    list(): readonly GraftOrphan[];
    /** Boot detection result. Replaces the set and notifies. */
    replace(orphans: readonly GraftOrphan[]): void;
    get(associationID: string): GraftOrphan | undefined;
    /** Resolves to the error string on failure (the orphan stays), or null on success. */
    recover(associationID: string): Promise<string | null>;
    dismiss(associationID: string): boolean;
    /** Fires after any change; the composer wires it to the `graft-orphans` broadcast. */
    onChange(listener: (orphans: readonly GraftOrphan[]) => void): () => void;
}

export function createGraftOrphanRegistry(graft: GraftService): GraftOrphanRegistry {
    let orphans: readonly GraftOrphan[] = [];
    const listeners = new Set<(value: readonly GraftOrphan[]) => void>();
    const notify = (): void => {
        for (const listener of [...listeners]) listener(orphans);
    };
    return {
        list: () => orphans,
        replace(next) {
            orphans = [...next];
            notify();
        },
        get: (associationID) => orphans.find((orphan) => orphan.id === associationID),
        async recover(associationID) {
            const orphan = orphans.find((entry) => entry.id === associationID);
            if (orphan === undefined) return `no interrupted graft matches '${associationID}'`;
            try {
                await graft.recoverOrphan(orphan);
            } catch (error) {
                // §GIT-045: the breadcrumb survived, so the banner must too.
                return errorText(error);
            }
            orphans = orphans.filter((entry) => entry.id !== associationID);
            notify();
            return null;
        },
        dismiss(associationID) {
            const orphan = orphans.find((entry) => entry.id === associationID);
            if (orphan === undefined) return false;
            graft.dismissOrphan(orphan);
            orphans = orphans.filter((entry) => entry.id !== associationID);
            notify();
            return true;
        },
        onChange(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }
    };
}

export interface GraftChannel {
    readonly store: GraftCommandStore;
    readonly graft: GraftService;
    readonly orphans: GraftOrphanRegistry;
}

function failure(error: string): JsonObject {
    return { ok: false, error };
}

/**
 * The wire entries (`graft/wire.ts`) are declared as `Record<string, unknown>`; every value in
 * them is JSON by construction, which TypeScript will not widen on its own. Same single
 * acknowledged cast `ws/serialize.ts` makes for the domain records.
 */
function asJson(value: Record<string, unknown>): JsonObject {
    return value as JsonObject;
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function associationByID(state: DaemonState, associationID: string): RepoAssociation | undefined {
    for (const workspace of state.workspaces) {
        const found = workspace.repoAssociations.find((association) => association.id === associationID);
        if (found !== undefined) return found;
    }
    return undefined;
}

/**
 * Re-scan every registered repo for a breadcrumb, minus the roots a live session claims. See
 * the header: this is what keeps the banner honest on a long-lived daemon.
 */
function refreshOrphans(channel: GraftChannel): void {
    const roots = [...new Set(channel.store.getState().repos.map((repo) => repo.path))];
    const claimed = new Set(channel.graft.claimedRoots());
    const detected = channel.graft
        .detectOrphans(roots)
        .filter((orphan) => !claimed.has(orphan.parentRepoRoot));
    channel.orphans.replace(detected);
}

function snapshot(channel: GraftChannel): JsonObject {
    return {
        ok: true,
        sessions: channel.graft.activeSessions().map((session) => asJson(graftSessionEntry(session))),
        orphans: channel.orphans.list().map((orphan) => asJson(graftOrphanEntry(orphan)))
    };
}

async function handleStart(channel: GraftChannel, payload: Record<string, unknown>): Promise<JsonObject> {
    const associationID = text(payload['association_id']);
    if (associationID === undefined) return failure('graft-session-start requires association_id');
    const association = associationByID(channel.store.getState(), associationID);
    if (association === undefined) return failure(`no repo association matches '${associationID}'`);
    try {
        const session = await channel.graft.start({
            id: association.id,
            worktreePath: association.worktreePath,
            branchName: association.branchName
        });
        return { ok: true, association_id: associationID, session: asJson(graftSessionEntry(session)) };
    } catch (error) {
        // The typed detail the swap prompt needs: which parent root the loser contested. It is
        // additive to `error`/`error_kind` so a client that ignores it still shows the message.
        const parentRepoRoot = isGraftError(error) ? error.parentRepoRoot : undefined;
        return {
            ok: false,
            association_id: associationID,
            error: errorText(error),
            error_kind: graftErrorKind(error),
            ...(parentRepoRoot === undefined ? {} : { parent_repo_root: parentRepoRoot })
        };
    }
}

/**
 * Stop is idempotent by design (`GraftService.stop`), which is what makes the client's
 * retry-an-errored-session path safe: it unwinds whatever the service still holds — a live
 * watcher, a parent-root claim, a breadcrumb — even when the client's mirror only ever saw a
 * start-failure placeholder (§GIT-037 / issue #231).
 */
async function handleStop(channel: GraftChannel, payload: Record<string, unknown>): Promise<JsonObject> {
    const associationID = text(payload['association_id']);
    if (associationID === undefined) return failure('graft-session-stop requires association_id');
    try {
        await channel.graft.stop(associationID);
        return { ok: true, association_id: associationID };
    } catch (error) {
        return {
            ok: false,
            association_id: associationID,
            error: errorText(error),
            error_kind: graftErrorKind(error)
        };
    }
}

export async function handleGraftUiCommand(
    channel: GraftChannel,
    command: GraftUiCommand,
    payload: Record<string, unknown>
): Promise<JsonObject> {
    switch (command) {
        case 'graft-session-list':
            if (payload['refresh'] === true) refreshOrphans(channel);
            return snapshot(channel);
        case 'graft-session-start':
            return await handleStart(channel, payload);
        case 'graft-session-stop':
            return await handleStop(channel, payload);
        case 'graft-orphan-recover': {
            const associationID = text(payload['association_id']);
            if (associationID === undefined) return failure('graft-orphan-recover requires association_id');
            const error = await channel.orphans.recover(associationID);
            if (error !== null) return { ok: false, association_id: associationID, error };
            return { ok: true, association_id: associationID };
        }
        case 'graft-orphan-dismiss': {
            const associationID = text(payload['association_id']);
            if (associationID === undefined) return failure('graft-orphan-dismiss requires association_id');
            const dismissed = channel.orphans.dismiss(associationID);
            if (!dismissed) return failure(`no interrupted graft matches '${associationID}'`);
            return { ok: true, association_id: associationID };
        }
    }
}
