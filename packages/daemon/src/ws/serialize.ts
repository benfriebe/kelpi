/**
 * State/event serialization for the client-sync channel (WP2.7).
 *
 * Clients are views (ARCHITECTURE.md "Client"): they mirror `DaemonState` and apply the
 * store's `DomainEvent`s to it (`applyDomainEvent` in `../store/events.ts` is the exact
 * mirror function). So the wire shapes here are the domain shapes, minus the fields that
 * only mean something inside the daemon:
 *
 *   - `DaemonState.homeDirectory` — the daemon HOST's home; a browser on another machine
 *     would render it as if it were its own.
 *   - `WorkspaceState.recentlyClosedPanes` — the reopen-closed-pane undo stack. It carries
 *     whole pane snapshots (scratchpad text, file paths) for a feature the daemon executes
 *     server-side; clients only need to know whether the stack is non-empty, which rides
 *     as `recentlyClosedCount`.
 *
 * Everything else is forwarded verbatim, including transient fields (focus, zoom, sync,
 * agent status) — that is what the client renders.
 */

import type { JsonObject, JsonValue } from '@nex/protocol';

import { canonicalizeForClient } from './paths.js';
import type {
    DaemonState,
    DomainEvent,
    LabelPreset,
    Pane,
    Repo,
    WorkspaceEnvelope,
    WorkspaceGroup,
    WorkspaceState
} from '../store/types.js';

/** Fields dropped from the app-level state before it leaves the daemon. */
export const SERVER_ONLY_APP_FIELDS = ['homeDirectory'] as const;
/** Fields dropped from every workspace (envelope included) before it leaves the daemon. */
export const SERVER_ONLY_WORKSPACE_FIELDS = ['recentlyClosedPanes'] as const;

/**
 * Domain records are plain JSON by construction (primitives, nulls, arrays and plain
 * objects — see `store/types.ts`), but they are declared as `interface`s, which TypeScript
 * refuses to widen to an index-signature type. This is the one cast that acknowledges that.
 */
function asJson<T>(value: T): JsonObject {
    return value as unknown as JsonObject;
}

/**
 * §APP-071 / §GIT-092 (ledger N5) — the pane's cwd with symlinks resolved, added beside the
 * literal one rather than replacing it.
 *
 * `workingDirectory` stays exactly what the shell reported, because that is what the footer,
 * `pane list`'s CWD column and `--prune-worktree` display and act on. `workingDirectoryReal`
 * is the form a git-produced path (`rev-parse --show-toplevel`, always physical) can be
 * compared against — the comparison the status footer's `doc N +A -B` makes. A browser cannot
 * call `realpath`, so the daemon does it once, here, for every pane that reaches a client.
 * `''` = no canonical form was obtainable; consumers fall back to the literal path.
 */
export function serializePane(pane: Pane): JsonObject {
    // Panes carry no server-only fields: every column is something a client renders.
    return asJson({ ...pane, workingDirectoryReal: canonicalizeForClient(pane.workingDirectory) });
}

export function serializeGroup(group: WorkspaceGroup): JsonObject {
    return asJson({ ...group, childOrder: [...group.childOrder] });
}

export function serializeRepo(repo: Repo): JsonObject {
    return asJson({ ...repo });
}

export function serializeLabelPreset(preset: LabelPreset): JsonObject {
    return asJson({ ...preset });
}

/** The `workspace-upserted` payload, with the undo stack replaced by its size. */
export function serializeWorkspaceEnvelope(envelope: WorkspaceEnvelope): JsonObject {
    const { recentlyClosedPanes, ...rest } = envelope;
    return asJson({
        ...rest,
        labels: [...rest.labels],
        repoAssociations: rest.repoAssociations.map((association) => ({ ...association })),
        recentlyClosedCount: recentlyClosedPanes.length
    });
}

export function serializeWorkspace(workspace: WorkspaceState): JsonObject {
    const { recentlyClosedPanes, panes, parkedPanes, ...rest } = workspace;
    return asJson({
        ...rest,
        panes: panes.map(serializePane),
        parkedPanes: parkedPanes.map(serializePane),
        labels: [...rest.labels],
        focusHistory: [...rest.focusHistory],
        syncInputExcluded: [...rest.syncInputExcluded],
        repoAssociations: rest.repoAssociations.map((association) => ({ ...association })),
        recentlyClosedCount: recentlyClosedPanes.length
    });
}

/** The `snapshot` payload: a full `DaemonState` minus the server-only fields. */
export function serializeState(state: DaemonState): JsonObject {
    return {
        workspaces: state.workspaces.map(serializeWorkspace),
        groups: state.groups.map(serializeGroup),
        topLevelOrder: state.topLevelOrder.map((entry) => asJson({ ...entry })),
        lastActiveWorkspaceID: state.lastActiveWorkspaceID,
        repos: state.repos.map(serializeRepo),
        labelPresets: state.labelPresets.map(serializeLabelPreset)
    };
}

/**
 * One delta event. Kinds that name a workspace/pane keep their identity fields so the
 * client can apply them to its mirror without a lookup table.
 */
export function serializeDomainEvent(event: DomainEvent): JsonObject {
    switch (event.kind) {
        case 'workspace-upserted':
            return {
                kind: event.kind,
                id: event.id,
                workspace: serializeWorkspaceEnvelope(event.workspace)
            };
        case 'pane-upserted':
            return {
                kind: event.kind,
                workspaceID: event.workspaceID,
                paneID: event.paneID,
                lane: event.lane,
                index: event.index,
                pane: serializePane(event.pane)
            };
        case 'group-upserted':
            return {
                kind: event.kind,
                id: event.id,
                index: event.index,
                group: serializeGroup(event.group)
            };
        case 'layout-changed':
            return {
                kind: event.kind,
                workspaceID: event.workspaceID,
                layout: event.layout as JsonValue,
                zoomedPaneID: event.zoomedPaneID,
                savedLayout: event.savedLayout as JsonValue,
                currentLayoutIndex: event.currentLayoutIndex
            };
        case 'label-presets-changed':
            return { kind: event.kind, presets: event.presets.map(serializeLabelPreset) };
        case 'repos-changed':
            return { kind: event.kind, repos: event.repos.map(serializeRepo) };
        default:
            // The remaining kinds are flat records of primitives / string arrays.
            return asJson({ ...event });
    }
}

export function serializeDomainEvents(events: readonly DomainEvent[]): JsonObject[] {
    return events.map(serializeDomainEvent);
}
