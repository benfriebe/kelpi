/**
 * Builders for the list-entry shapes whose *absence* rules are part of the contract:
 * `background_tasks` appears only when positive, and `group_id`/`group_name` are both
 * present or both absent (top-level workspaces have neither).
 */

import type { AgentKind, PaneStatus, PaneType } from '../wire/vocab.js';
import type { PaneListEntry, WorkspaceListEntry } from './types.js';

export interface GroupRef {
    readonly id: string;
    readonly name: string;
}

export interface PaneListEntryInput {
    readonly id: string;
    readonly type: PaneType;
    readonly workspace_id: string;
    readonly workspace_name: string;
    readonly working_directory: string;
    readonly status: PaneStatus;
    readonly is_focused: boolean;
    readonly is_active_workspace: boolean;
    readonly created_at: string;
    readonly last_activity_at: string;
    readonly label?: string | undefined;
    readonly title?: string | undefined;
    readonly git_branch?: string | undefined;
    readonly agent_session_id?: string | undefined;
    readonly agent?: AgentKind | undefined;
    readonly background_tasks?: number | undefined;
    readonly file_path?: string | undefined;
    readonly group?: GroupRef | undefined;
}

function optionalText(value: string | undefined): { readonly value: string } | undefined {
    return value !== undefined && value.length > 0 ? { value } : undefined;
}

export function buildPaneListEntry(input: PaneListEntryInput): PaneListEntry {
    const label = optionalText(input.label);
    const title = optionalText(input.title);
    const branch = optionalText(input.git_branch);
    const session = optionalText(input.agent_session_id);
    const filePath = optionalText(input.file_path);
    const background = input.background_tasks !== undefined && input.background_tasks > 0 ? input.background_tasks : undefined;

    return {
        id: input.id,
        type: input.type,
        workspace_id: input.workspace_id,
        workspace_name: input.workspace_name,
        working_directory: input.working_directory,
        status: input.status,
        is_focused: input.is_focused,
        is_active_workspace: input.is_active_workspace,
        created_at: input.created_at,
        last_activity_at: input.last_activity_at,
        ...(label ? { label: label.value } : {}),
        ...(title ? { title: title.value } : {}),
        ...(branch ? { git_branch: branch.value } : {}),
        ...(session ? { agent_session_id: session.value } : {}),
        ...(input.agent !== undefined ? { agent: input.agent } : {}),
        ...(background !== undefined ? { background_tasks: background } : {}),
        ...(filePath ? { file_path: filePath.value } : {}),
        ...(input.group !== undefined ? { group_id: input.group.id, group_name: input.group.name } : {})
    };
}

export interface WorkspaceListEntryInput {
    readonly id: string;
    readonly name: string;
    readonly color: string;
    readonly pane_count: number;
    readonly is_active: boolean;
    readonly created_at: string;
    readonly last_accessed_at: string;
    readonly labels: readonly string[];
    readonly last_activity_at?: string | undefined;
    readonly agent_session_id?: string | undefined;
    readonly group?: GroupRef | undefined;
}

export function buildWorkspaceListEntry(input: WorkspaceListEntryInput): WorkspaceListEntry {
    const lastActivity = optionalText(input.last_activity_at);
    const session = optionalText(input.agent_session_id);

    return {
        id: input.id,
        name: input.name,
        color: input.color,
        pane_count: input.pane_count,
        is_active: input.is_active,
        created_at: input.created_at,
        last_accessed_at: input.last_accessed_at,
        labels: input.labels,
        ...(lastActivity ? { last_activity_at: lastActivity.value } : {}),
        ...(session ? { agent_session_id: session.value } : {}),
        ...(input.group !== undefined ? { group_id: input.group.id, group_name: input.group.name } : {})
    };
}
