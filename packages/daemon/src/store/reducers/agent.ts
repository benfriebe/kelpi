/**
 * Agent lifecycle, live pane metadata and synchronise-input reducers.
 *
 * Spec: docs/current/workspace-feature.md §7.10 (agent status), §7.11 (title/cwd/branch),
 * §7.15 (sync input); docs/current/agent-lifecycle.md §5 (the state machine itself, which
 * lives in @kelpi/core/agent — this module only routes and applies it).
 */

import { reduceAgentEvent, type AgentEvent, type AgentEventResult } from '@kelpi/core/agent';
import type { Pane } from '@kelpi/core/layout';
import type { DaemonState, DomainAction, WorkspaceState } from '../types.js';
import { findPane, mutatePane, seconds, updateWorkspace } from './helpers.js';

/** The workspace holding the pane in EITHER lane (agent events reach parked panes). */
function workspaceIDForPane(
    state: DaemonState,
    paneID: string,
    hint: string | undefined
): string | undefined {
    if (hint !== undefined) {
        const hinted = state.workspaces.find((workspace) => workspace.id === hint);
        if (hinted !== undefined && findPane(hinted, paneID) !== null) return hint;
    }
    return state.workspaces.find(
        (workspace) =>
            workspace.panes.some((pane) => pane.id === paneID) ||
            workspace.parkedPanes.some((pane) => pane.id === paneID)
    )?.id;
}

/**
 * Run the agent machine WITHOUT mutating: handlers need `effects` (notification, background-work
 * suppression, persist-immediately) and would otherwise have to re-derive the pane lookup.
 * Returns null when no workspace holds the pane.
 */
export function previewAgentEvent(
    state: DaemonState,
    paneID: string,
    event: AgentEvent,
    now: number
): AgentEventResult | null {
    const workspaceID = workspaceIDForPane(state, paneID, undefined);
    if (workspaceID === undefined) return null;
    const workspace = state.workspaces.find((candidate) => candidate.id === workspaceID);
    const pane = workspace === undefined ? null : findPane(workspace, paneID);
    if (pane === null) return null;
    return reduceAgentEvent(pane, event, { now, paneKind: pane.type });
}

function applyAgentEvent(
    workspace: WorkspaceState,
    paneID: string,
    event: AgentEvent,
    now: number
): WorkspaceState {
    return mutatePane(workspace, paneID, (pane) => {
        const result = reduceAgentEvent(pane, event, { now, paneKind: pane.type });
        if (!result.effects.changed) return pane;
        const next: Pane = { ...pane, ...result.state };
        return next;
    });
}

export function reduceAgentAction(state: DaemonState, action: DomainAction): DaemonState {
    switch (action.type) {
        case 'pane-agent-event': {
            const workspaceID = workspaceIDForPane(state, action.paneID, action.workspaceID);
            if (workspaceID === undefined) return state;
            return updateWorkspace(state, workspaceID, (workspace) =>
                applyAgentEvent(workspace, action.paneID, action.event, action.now)
            );
        }
        case 'pane-title-changed': {
            const workspaceID = workspaceIDForPane(state, action.paneID, undefined);
            if (workspaceID === undefined) return state;
            return updateWorkspace(state, workspaceID, (workspace) =>
                mutatePane(workspace, action.paneID, (pane) => ({
                    ...pane,
                    title: action.title,
                    lastActivityAt: seconds(action.now)
                }))
            );
        }
        case 'pane-directory-changed': {
            const workspaceID = workspaceIDForPane(state, action.paneID, undefined);
            if (workspaceID === undefined) return state;
            return updateWorkspace(state, workspaceID, (workspace) =>
                mutatePane(workspace, action.paneID, (pane) => ({
                    ...pane,
                    workingDirectory: action.directory,
                    lastActivityAt: seconds(action.now)
                }))
            );
        }
        case 'pane-branch-changed': {
            const workspaceID = workspaceIDForPane(state, action.paneID, undefined);
            if (workspaceID === undefined) return state;
            return updateWorkspace(state, workspaceID, (workspace) =>
                mutatePane(workspace, action.paneID, (pane) => ({
                    ...pane,
                    gitBranch: action.branch
                }))
            );
        }

        // ── sync input (§7.15) ────────────────────────────────────────────
        case 'toggle-sync-input':
            return updateWorkspace(state, action.workspaceID, (workspace) => ({
                ...workspace,
                isSyncInputActive: !workspace.isSyncInputActive,
                // Cleared on EVERY transition: an exclude staged while sync was off must not
                // survive into the next on-cycle.
                syncInputExcluded: []
            }));
        case 'set-sync-input-active':
            return updateWorkspace(state, action.workspaceID, (workspace) =>
                // Idempotent: a repeated `sync on` does NOT clear exclusions.
                workspace.isSyncInputActive === action.active
                    ? workspace
                    : { ...workspace, isSyncInputActive: action.active, syncInputExcluded: [] }
            );
        case 'set-sync-input-excluded':
            return updateWorkspace(state, action.workspaceID, (workspace) => {
                // Visible panes only; unknown ids no-op.
                if (workspace.panes.every((pane) => pane.id !== action.paneID)) return workspace;
                const has = workspace.syncInputExcluded.includes(action.paneID);
                if (has === action.excluded) return workspace;
                const syncInputExcluded = action.excluded
                    ? [...workspace.syncInputExcluded, action.paneID]
                    : workspace.syncInputExcluded.filter((id) => id !== action.paneID);
                return { ...workspace, syncInputExcluded };
            });
        default:
            return state;
    }
}
