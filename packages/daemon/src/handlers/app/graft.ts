/**
 * `graft-start` / `graft-stop` / `graft-status` (socket-handlers.md §9, graft-git.md §7).
 *
 * All three are request/response and all three answer from the **service**, never from any
 * client mirror: a session the UI lost track of must still show up in `graft status`, still be
 * stoppable, and still explain an `alreadyActive` rejection (issue #231).
 *
 * Two PLAN-sanctioned additive fixes over the Swift replies (port notes 7 + 8), both purely
 * additive so the shipped CLI is unaffected:
 *   - a machine-readable `error_kind` accompanies every `ok:false` (and `partial_error_kind`
 *     a partial start), so future clients can branch without parsing prose;
 *   - a partial `graft-stop` failure also carries a summary `error` string. The current CLI
 *     runs its generic envelope check first and would otherwise print "unknown error" and
 *     never render the `failed` list; `failed` stays for clients that do render it.
 */

import { normalizeUUIDLoose } from '@nex/core/codec';
import { resolveWorkspaceLenient } from '@nex/core/resolve';
import type { GraftStartMessage, GraftStopMessage } from '@nex/protocol';

import {
    canonicalizeUserPath,
    errorText,
    graftErrorKind,
    graftSessionEntry,
    graftStartedEntry,
    lastPathComponent,
    type GraftSession
} from '../../graft/index.js';
import type { ReplyHandle } from '../../seams.js';
import {
    resolveStateOf,
    workspaceContainingPane,
    type DaemonState,
    type RepoAssociation,
    type WorkspaceState
} from '../../store/index.js';
import { forCommand } from './common.js';
import { fail, ok, type AppContext, type AppDeps, type AppHandler } from './context.js';

export const GRAFT_SCOPE_REQUIRED_ERROR = 'graft requires --workspace, --repo, or NEX_PANE_ID';
/** `error_kind` for a failure that never reached the engine (bad/absent scope). */
export const GRAFT_SCOPE_ERROR_KIND = 'scope';
export const GRAFT_NO_MATCH_ERROR = 'no repo associations matched the requested scope';
export const GRAFT_NO_PANE_WORKSPACE_ERROR = 'no workspace contains the requesting pane';
export const GRAFT_START_FALLBACK_ERROR = 'graft start failed';

export type GraftScope =
    | { readonly ok: true; readonly associations: readonly RepoAssociation[] }
    | { readonly ok: false; readonly error: string };

/**
 * §9.1. Precedence is `workspace` → `pane_id` → `repo`-searches-everywhere; the `repo` filter
 * then narrows whatever scope was chosen (so workspace + repo compose).
 */
export function resolveGraftAssociations(
    state: DaemonState,
    workspaceFilter: string | undefined,
    repoFilter: string | undefined,
    paneID: string | undefined
): GraftScope {
    let scope: readonly WorkspaceState[];
    if (workspaceFilter !== undefined) {
        // The LENIENT resolver (case-insensitive, first match, slug-aware) — the same one
        // `pane-move-to-workspace` uses.
        const resolved = resolveWorkspaceLenient(resolveStateOf(state), workspaceFilter);
        if (resolved === null) return { ok: false, error: `workspace not found: ${workspaceFilter}` };
        const workspace = state.workspaces.find((candidate) => candidate.id === resolved.id);
        if (workspace === undefined) {
            return { ok: false, error: `workspace not found: ${workspaceFilter}` };
        }
        scope = [workspace];
    } else if (paneID !== undefined) {
        // Parked panes included: an `open --here` shell is still "the requesting pane".
        const workspace = workspaceContainingPane(state, paneID);
        if (workspace === null) return { ok: false, error: GRAFT_NO_PANE_WORKSPACE_ERROR };
        scope = [workspace];
    } else if (repoFilter !== undefined) {
        scope = state.workspaces;
    } else {
        return { ok: false, error: GRAFT_SCOPE_REQUIRED_ERROR };
    }

    const results: RepoAssociation[] = [];
    for (const workspace of scope) {
        for (const association of workspace.repoAssociations) {
            if (repoFilter !== undefined) {
                const repoName = state.repos.find(
                    (repo) => repo.id === association.repoID
                )?.name;
                const matches =
                    association.worktreePath === repoFilter ||
                    lastPathComponent(association.worktreePath) === repoFilter ||
                    repoName === repoFilter;
                if (!matches) continue;
            }
            results.push(association);
        }
    }
    if (results.length === 0) return { ok: false, error: GRAFT_NO_MATCH_ERROR };
    return { ok: true, associations: results };
}

function idKey(value: string): string {
    return normalizeUUIDLoose(value);
}

// ---------------------------------------------------------------------------
// graft-start (§9.2)
// ---------------------------------------------------------------------------

function handleGraftStart(
    msg: GraftStartMessage,
    ctx: AppContext,
    reply: ReplyHandle | null,
    deps: AppDeps
): void {
    const scope = resolveGraftAssociations(
        ctx.store.getState(),
        msg.workspace,
        msg.repo,
        msg.pane_id
    );
    if (!scope.ok) {
        fail(reply, scope.error, { error_kind: GRAFT_SCOPE_ERROR_KIND });
        return;
    }
    void (async () => {
        const started: Record<string, unknown>[] = [];
        let lastError: unknown = null;
        for (const association of scope.associations) {
            try {
                const session = await deps.graft.start({
                    id: association.id,
                    worktreePath: association.worktreePath,
                    branchName: association.branchName
                });
                started.push(graftStartedEntry(session));
            } catch (error) {
                lastError = error;
            }
        }
        if (started.length === 0) {
            fail(reply, lastError === null ? GRAFT_START_FALLBACK_ERROR : errorText(lastError), {
                error_kind: graftErrorKind(lastError)
            });
            return;
        }
        ok(reply, {
            started,
            ...(lastError !== null
                ? {
                      partial_error: errorText(lastError),
                      partial_error_kind: graftErrorKind(lastError)
                  }
                : {})
        });
    })();
}

// ---------------------------------------------------------------------------
// graft-stop (§9.3)
// ---------------------------------------------------------------------------

/** §7.3 step 3: match a live session by path when its association is already gone. */
function orphanMatches(
    session: GraftSession,
    filters: ReadonlySet<string>
): boolean {
    const candidates = [
        session.worktreePath,
        lastPathComponent(session.worktreePath),
        session.parentRepoRoot,
        lastPathComponent(session.parentRepoRoot)
    ];
    return candidates.some((candidate) => filters.has(candidate));
}

function handleGraftStop(
    msg: GraftStopMessage,
    ctx: AppContext,
    reply: ReplyHandle | null,
    deps: AppDeps
): void {
    const state = ctx.store.getState();
    const repoFilter = msg.repo;
    const scope = resolveGraftAssociations(state, msg.workspace, repoFilter, msg.pane_id);
    let associationIDs: readonly string[] = [];
    if (scope.ok) {
        associationIDs = scope.associations.map((association) => association.id);
    } else if (repoFilter === undefined || msg.workspace !== undefined) {
        // Only a repo-only scope tolerates a resolution failure: the owning association may
        // have been deleted with its workspace and only the service still knows the session.
        fail(reply, scope.error, { error_kind: GRAFT_SCOPE_ERROR_KIND });
        return;
    }

    const active = deps.graft.activeSessions();
    const wanted = new Set(associationIDs.map(idKey));
    const targets: string[] = [];
    const taken = new Set<string>();
    for (const session of active) {
        const key = idKey(session.id);
        if (!wanted.has(key) || taken.has(key)) continue;
        taken.add(key);
        targets.push(session.id);
    }
    if (repoFilter !== undefined) {
        const filters = new Set<string>([
            repoFilter,
            canonicalizeUserPath(repoFilter, state.homeDirectory)
        ]);
        for (const session of active) {
            const key = idKey(session.id);
            if (taken.has(key)) continue;
            if (!orphanMatches(session, filters)) continue;
            taken.add(key);
            targets.push(session.id);
        }
    }

    if (targets.length === 0) {
        ok(reply, { stopped: [] });
        return;
    }

    void (async () => {
        const stopped: string[] = [];
        const failed: Record<string, unknown>[] = [];
        for (const associationID of targets) {
            try {
                await deps.graft.stop(associationID);
                stopped.push(normalizeUUIDLoose(associationID));
            } catch (error) {
                failed.push({
                    association_id: normalizeUUIDLoose(associationID),
                    error: errorText(error),
                    error_kind: graftErrorKind(error)
                });
            }
        }
        if (failed.length === 0) {
            ok(reply, { stopped });
            return;
        }
        // `ok` is false iff a stop FAILED (a partial stop still reports what it stopped).
        const first = failed[0] as { error: string; error_kind: string };
        const summary =
            failed.length === 1
                ? first.error
                : `${String(failed.length)} graft sessions failed to stop: ${failed
                      .map((entry) => String(entry['error']))
                      .join('; ')}`;
        reply?.send({
            ok: false,
            stopped,
            failed,
            error: summary,
            error_kind: first.error_kind
        });
        reply?.close();
    })();
}

// ---------------------------------------------------------------------------
// graft-status (§9.4)
// ---------------------------------------------------------------------------

function handleGraftStatus(reply: ReplyHandle | null, deps: AppDeps): void {
    ok(reply, { sessions: deps.graft.activeSessions().map(graftSessionEntry) });
}

export function graftHandlerEntries(
    deps: AppDeps
): readonly (readonly [string, AppHandler])[] {
    return [
        forCommand('graft-start', (msg, ctx, reply) => {
            handleGraftStart(msg, ctx, reply, deps);
        }),
        forCommand('graft-stop', (msg, ctx, reply) => {
            handleGraftStop(msg, ctx, reply, deps);
        }),
        forCommand('graft-status', (_msg, _ctx, reply) => {
            handleGraftStatus(reply, deps);
        })
    ];
}
