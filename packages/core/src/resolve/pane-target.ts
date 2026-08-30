/**
 * Pane resolution: `resolvePaneTarget`, the anchor resolver, and the lifecycle lookup.
 * Spec: docs/current/socket-handlers.md §2.4–2.7, wire-protocol.md §5.7,
 * app-state-core.md §15.2.
 *
 * The error strings below are WIRE CONTRACT - the CLI surfaces them verbatim as
 * `{"ok":false,"error":"..."}`. Do not reword them.
 */

import { idsEqual, isUUIDToken } from './ids.js';
import { resolveWorkspaceStrict } from './workspace.js';
import type { PaneScope, ResolvablePane, ResolvableWorkspace } from './types.js';

export interface PaneTargetRequest {
    /** The caller's own pane (`NEX_PANE_ID`). Addressed pane only when `target` is absent. */
    readonly paneID?: string | null | undefined;
    /** `--target <name-or-uuid>`; wins over `paneID`. */
    readonly target?: string | null | undefined;
    /** `--workspace <name-or-id>`; scopes label lookup and constrains UUID targets. */
    readonly workspaceFilter?: string | null | undefined;
}

export type PaneTargetResolution =
    | { readonly ok: true; readonly paneID: string; readonly workspace: ResolvableWorkspace }
    | { readonly ok: false; readonly error: string };

/** Visible (non-parked) panes of a workspace, in state order. */
export function visiblePanesOfWorkspace(
    state: PaneScope,
    workspaceID: string
): readonly ResolvablePane[] {
    return state.panes.filter((pane) => pane.parked !== true && pane.workspaceID === workspaceID);
}

/** The workspace owning a VISIBLE pane; parked panes are not user-addressable. */
export function workspaceContainingVisiblePane(
    state: PaneScope,
    paneID: string
): ResolvableWorkspace | null {
    const pane = state.panes.find((candidate) => candidate.parked !== true && idsEqual(candidate.id, paneID));
    if (pane === undefined) return null;
    return state.workspaces.find((workspace) => workspace.id === pane.workspaceID) ?? null;
}

/**
 * `workspaceContainingPane(paneID)` (§2.7): searches BOTH lanes. Used by agent lifecycle
 * routing (events on parked shells must not be dropped), `pane-sync`'s implicit scope,
 * and the graft pane scope.
 */
export function workspaceContainingPane(
    state: PaneScope,
    paneID: string
): ResolvableWorkspace | null {
    const pane = state.panes.find((candidate) => idsEqual(candidate.id, paneID));
    if (pane === undefined) return null;
    return state.workspaces.find((workspace) => workspace.id === pane.workspaceID) ?? null;
}

/**
 * `resolvePaneInWorkspace(ws, ref)` (§2.5): the `pane-move-adjacent` anchor, which must
 * live in the moved pane's workspace. UUID must be a member; a label must be unique
 * within that workspace. Returns the pane id or null (the caller owns the error text).
 */
export function resolvePaneInWorkspace(
    state: PaneScope,
    workspaceID: string,
    ref: string
): string | null {
    const panes = visiblePanesOfWorkspace(state, workspaceID);
    if (isUUIDToken(ref)) {
        return panes.find((pane) => idsEqual(pane.id, ref))?.id ?? null;
    }
    const matches = panes.filter((pane) => pane.label === ref);
    return matches.length === 1 ? (matches[0]?.id ?? null) : null;
}

function failure(error: string): PaneTargetResolution {
    return { ok: false, error };
}

/**
 * The shared resolver behind `pane close|send|send-key|capture|name|resize`,
 * `pane-move-adjacent`, `pane sync exclude/include` and the `--target` branches of
 * `split`/`create`.
 *
 * Invariants: UUID targets are global (unless narrowed by `--workspace`); label targets
 * REQUIRE a scope (explicit filter or the caller pane's workspace) and are never guessed
 * globally; labels match case-sensitively and exactly; only visible panes resolve.
 */
export function resolvePaneTarget(
    state: PaneScope,
    request: PaneTargetRequest
): PaneTargetResolution {
    const paneID = request.paneID ?? null;
    const target = request.target ?? null;
    const workspaceFilter = request.workspaceFilter ?? null;

    // 1. Resolve the explicit workspace scope up front (strict resolver).
    let scopedWorkspace: ResolvableWorkspace | null = null;
    if (workspaceFilter !== null) {
        scopedWorkspace = resolveWorkspaceStrict(state, workspaceFilter);
        if (scopedWorkspace === null) {
            return failure(`workspace not found: ${workspaceFilter}`);
        }
    }

    // 2. Resolve the pane. `target` takes precedence over `paneID`.
    let resolvedID: string;
    if (target !== null) {
        if (isUUIDToken(target)) {
            if (scopedWorkspace !== null) {
                const pane = visiblePanesOfWorkspace(state, scopedWorkspace.id).find((candidate) =>
                    idsEqual(candidate.id, target)
                );
                if (pane === undefined) {
                    return failure(
                        `no pane with UUID '${target}' in workspace '${scopedWorkspace.name}'`
                    );
                }
                resolvedID = pane.id;
            } else {
                const pane = state.panes.find(
                    (candidate) => candidate.parked !== true && idsEqual(candidate.id, target)
                );
                if (pane === undefined) {
                    return failure(`no pane with UUID '${target}'`);
                }
                resolvedID = pane.id;
            }
        } else {
            let candidates: readonly ResolvablePane[];
            let originName: string | null = null;
            if (scopedWorkspace !== null) {
                candidates = visiblePanesOfWorkspace(state, scopedWorkspace.id).filter(
                    (pane) => pane.label === target
                );
            } else if (paneID !== null) {
                const origin = workspaceContainingVisiblePane(state, paneID);
                if (origin === null) {
                    // Stale NEX_PANE_ID: the caller pane is gone, so there is no scope.
                    return failure(
                        `origin pane '${paneID}' no longer exists; pass --workspace <name-or-id> to address a pane in another workspace`
                    );
                }
                originName = origin.name;
                candidates = visiblePanesOfWorkspace(state, origin.id).filter(
                    (pane) => pane.label === target
                );
            } else {
                return failure(
                    `label '${target}' requires --workspace <name-or-id> when called from outside a Kelpi pane`
                );
            }

            if (candidates.length === 0) {
                let scopeSuffix = '';
                if (scopedWorkspace !== null) {
                    scopeSuffix = ` in workspace '${scopedWorkspace.name}'`;
                } else if (originName !== null) {
                    scopeSuffix = ` in workspace '${originName}' (use --workspace <name-or-id> to address another workspace)`;
                }
                return failure(`no pane with label '${target}'${scopeSuffix}`);
            }
            if (candidates.length > 1) {
                return failure(
                    `label '${target}' is ambiguous (${candidates.length} matches); pass --workspace <name-or-id> to disambiguate`
                );
            }
            const only = candidates[0];
            if (only === undefined) return failure(`no pane with label '${target}'`);
            resolvedID = only.id;
        }
    } else if (paneID !== null) {
        const pane = state.panes.find(
            (candidate) => candidate.parked !== true && idsEqual(candidate.id, paneID)
        );
        if (pane === undefined) {
            return failure(`no pane with UUID '${paneID}'`);
        }
        resolvedID = pane.id;
    } else {
        // Defensive: the wire decoder rejects a message with neither.
        return failure('missing pane_id and target');
    }

    // 3. Locate the containing workspace and enforce the scope.
    const workspace = workspaceContainingVisiblePane(state, resolvedID);
    if (workspace === null) {
        return failure(`pane not found: ${resolvedID}`);
    }
    if (scopedWorkspace !== null && workspace.id !== scopedWorkspace.id) {
        return failure(`pane '${resolvedID}' is not in workspace '${scopedWorkspace.name}'`);
    }
    return { ok: true, paneID: resolvedID, workspace };
}
