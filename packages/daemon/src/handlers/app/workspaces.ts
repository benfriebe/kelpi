/**
 * `workspace-*` command handlers (socket-handlers.md §6).
 *
 * `workspace-list` / `workspace-create` / `workspace-delete` / `workspace-label` are
 * request/response; `workspace-move` / `workspace-profile` are fire-and-forget (guards still
 * run, failures are silently dropped — §1 legacy path).
 *
 * Ordering rules that are contract:
 *   - list order = sidebar order INCLUDING collapsed group members, deduped, with any
 *     unreachable workspace appended so the CLI can never lose one (§6.1);
 *   - create replies BEFORE the effect on the two synchronous branches and AFTER the git work
 *     on the worktree branch (§1 reply-before-effect, §6.2a);
 *   - delete's guards run in order (resolve → last-workspace → running agents) and the `path`
 *     field is the first SHELL pane's cwd (port note 17 — `--prune-worktree` depends on it).
 */

import path from 'node:path';

import { workspaceSidebarID } from '@nex/core/codec';
import {
    groupsMatchingName,
    isUUIDToken,
    normalizeLabel,
    resolveGroupStrict,
    resolveWorkspaceStrict,
    workspacesMatchingName
} from '@nex/core/resolve';
import {
    buildWorkspaceListEntry,
    type WorkspaceColor,
    type WorkspaceCreateMessage,
    type WorkspaceListEntry
} from '@nex/protocol';

import type { ReplyHandle } from '../../seams.js';
import {
    activeAgentCount,
    groupIDForWorkspace,
    nextRandomColor,
    resolveStateOf,
    workspaceByID,
    type DaemonState,
    type RepoAssociation,
    type WorkspaceState
} from '../../store/index.js';
import {
    sanitizedGitName,
    standardizePath,
    worktreeErrorMessage,
    worktreePathFor
} from '../../git/index.js';
import { forCommand, listedWorkspaceIDs, refreshSyncGroup, uuidOut, wireTimestamp } from './common.js';
import { fail, ok, type AppContext, type AppDeps, type AppHandler } from './context.js';

const DEFAULT_WORKSPACE_NAME = 'Workspace';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function groupRef(state: DaemonState, workspaceID: string): { id: string; name: string } | undefined {
    const groupID = groupIDForWorkspace(state, workspaceID);
    if (groupID === null) return undefined;
    const group = state.groups.find((candidate) => candidate.id === groupID);
    if (group === undefined) return undefined;
    return { id: uuidOut(group.id), name: group.name };
}

function workspaceEntry(state: DaemonState, workspace: WorkspaceState): WorkspaceListEntry {
    let lastActivity: number | undefined;
    for (const pane of workspace.panes) {
        if (lastActivity === undefined || pane.lastActivityAt > lastActivity) {
            lastActivity = pane.lastActivityAt;
        }
    }
    const session = workspace.panes.find((pane) => pane.agentSessionID !== null)?.agentSessionID;
    const group = groupRef(state, workspace.id);
    return buildWorkspaceListEntry({
        id: uuidOut(workspace.id),
        name: workspace.name,
        color: workspace.color,
        pane_count: workspace.panes.length,
        is_active: state.lastActiveWorkspaceID === workspace.id,
        created_at: wireTimestamp(workspace.createdAt),
        last_accessed_at: wireTimestamp(workspace.lastAccessedAt),
        labels: [...workspace.labels],
        ...(lastActivity !== undefined ? { last_activity_at: wireTimestamp(lastActivity) } : {}),
        ...(session !== undefined && session !== null ? { agent_session_id: session } : {}),
        ...(group !== undefined ? { group } : {})
    });
}

/** The `path` field of a delete reply: first shell pane's cwd, else the first pane's. */
function workspacePath(workspace: WorkspaceState): string | undefined {
    const shell = workspace.panes.find((pane) => pane.type === 'shell');
    const pane = shell ?? workspace.panes[0];
    return pane?.workingDirectory;
}

/** Spawn the PTY of a workspace's first pane after a create. */
function spawnFirstPane(ctx: AppContext, deps: AppDeps, workspaceID: string): void {
    const workspace = workspaceByID(ctx.store.getState(), workspaceID);
    const pane = workspace?.panes[0];
    if (workspace === null || pane === undefined) return;
    deps.spawnPane(
        {
            paneID: pane.id,
            workspaceID: workspace.id,
            cwd: pane.workingDirectory,
            profileName: workspace.profileName
        },
        ctx
    );
}

// ---------------------------------------------------------------------------
// workspace-list (§6.1)
// ---------------------------------------------------------------------------

function handleWorkspaceList(
    filter: string | undefined,
    ctx: AppContext,
    reply: ReplyHandle | null
): void {
    if (reply === null) return;
    const state = ctx.store.getState();

    let allowed: Set<string> | null = null;
    if (filter !== undefined && filter !== '') {
        const group = resolveGroupStrict(resolveStateOf(state), filter);
        if (group === null) {
            // Unknown/ambiguous is an ERROR, not an empty list, so scripts can tell
            // "no such group" from "empty group".
            fail(reply, `no group matches '${filter}'`);
            return;
        }
        const resolved = state.groups.find((candidate) => candidate.id === group.id);
        allowed = new Set(resolved?.childOrder ?? []);
    }

    const workspaces: WorkspaceListEntry[] = [];
    for (const workspaceID of listedWorkspaceIDs(state)) {
        if (allowed !== null && !allowed.has(workspaceID)) continue;
        const workspace = workspaceByID(state, workspaceID);
        if (workspace === null) continue;
        workspaces.push(workspaceEntry(state, workspace));
    }
    ok(reply, { workspaces });
}

// ---------------------------------------------------------------------------
// workspace-create (§6.2)
// ---------------------------------------------------------------------------

interface WorktreeSeed {
    readonly path: string;
    readonly branchName: string;
}

interface CreateInput {
    readonly name: string;
    readonly workingDirectory: string | undefined;
    readonly color: WorkspaceColor | undefined;
    readonly profile: string | undefined;
    readonly groupID: string | undefined;
    readonly workspaceID: string;
    readonly repoAssociations: readonly RepoAssociation[] | undefined;
}

function dispatchCreate(ctx: AppContext, deps: AppDeps, input: CreateInput): void {
    const state = ctx.store.getState();
    const paneID = deps.uuid();
    ctx.store.dispatch({
        type: 'create-workspace',
        id: input.workspaceID,
        paneID,
        name: input.name,
        now: deps.now(),
        color: input.color ?? nextRandomColor(state, deps.random),
        placement: deps.placement,
        ...(input.workingDirectory !== undefined ? { workingDirectory: input.workingDirectory } : {}),
        ...(input.groupID !== undefined ? { groupID: input.groupID } : {}),
        ...(input.profile !== undefined ? { profileName: input.profile } : {}),
        ...(input.repoAssociations !== undefined ? { repoAssociations: input.repoAssociations } : {})
    });
    deps.scrollTarget(workspaceSidebarID(input.workspaceID));
    spawnFirstPane(ctx, deps, input.workspaceID);
    refreshSyncGroup(ctx, input.workspaceID);
    deps.persist();
    revealCreatedWorkspace(ctx, input.workspaceID, paneID);
}

/**
 * "Creating a workspace switches to it" — the Swift app's behaviour, made to work for a
 * client that did not issue the command (run-B L3).
 *
 * The port's active workspace is **per client** (PLAN.md), so the reducer marking the new
 * workspace `lastActiveWorkspaceID` moves what `nex workspace list` calls ACTIVE and nothing
 * else: a `nex workspace create` from a terminal used to leave the daemon and every open
 * window disagreeing for the rest of the session, and an agent's follow-up `nex pane create`
 * then landed in a workspace the user could not see. A create is a deliberate act with an
 * obvious destination, so it is broadcast as a REVEAL — the same `reveal-pane` fan-out a
 * clicked notification uses (`ws/sync.ts`), which clients already implement as "activate the
 * workspace, then focus the pane". The client that issued the create reveals itself from the
 * reply as well; arriving twice is idempotent.
 */
function revealCreatedWorkspace(ctx: AppContext, workspaceID: string, paneID: string): void {
    const workspace = workspaceByID(ctx.store.getState(), workspaceID);
    if (workspace === null) return;
    const target = workspace.panes.some((pane) => pane.id === paneID) ? paneID : workspace.panes[0]?.id;
    if (target === undefined) return;
    ctx.broadcast({ type: 'reveal-pane', workspaceID, paneID: target });
}

function ambiguousGroupError(name: string): string {
    return `group name is ambiguous: ${name} (use the id or rename an existing group)`;
}

function unknownWorktreeGroupError(name: string): string {
    return `unknown group: ${name} — --worktree only supports existing groups; create it first (\`nex group create\`) or omit --group`;
}

function handleWorktreeCreate(
    msg: WorkspaceCreateMessage,
    worktreeName: string,
    ctx: AppContext,
    reply: ReplyHandle | null,
    deps: AppDeps
): void {
    const state = ctx.store.getState();
    const workspaceName = msg.name ?? DEFAULT_WORKSPACE_NAME;
    const trimmedGroup = msg.group?.trim() ?? '';

    // 1. Group pre-resolution — never creates a group here (a failed add would orphan it).
    let groupID: string | undefined;
    let groupName: string | undefined;
    if (trimmedGroup !== '') {
        const group = resolveGroupStrict(resolveStateOf(state), trimmedGroup);
        if (group === null) {
            const matches = groupsMatchingName(resolveStateOf(state), trimmedGroup);
            fail(
                reply,
                matches.length > 0
                    ? ambiguousGroupError(trimmedGroup)
                    : unknownWorktreeGroupError(trimmedGroup)
            );
            return;
        }
        groupID = group.id;
        groupName = group.name;
    }

    // 2. Source repo.
    const repoPathRaw = msg.repo ?? msg.path;
    if (repoPathRaw === undefined || repoPathRaw.trim() === '') {
        fail(reply, '--worktree requires a source repo (pass --repo <path>)');
        return;
    }
    const repoPath = standardizePath(repoPathRaw, state.homeDirectory);

    // 3. Name sanitization.
    const folderName = sanitizedGitName(worktreeName);
    if (folderName === null) {
        fail(reply, `"${worktreeName}" isn't a usable worktree name`);
        return;
    }
    const requestedBranch = msg.branch !== undefined && msg.branch !== '' ? msg.branch : worktreeName;
    const safeBranch = sanitizedGitName(requestedBranch);
    if (safeBranch === null) {
        fail(reply, `"${requestedBranch}" isn't a usable branch name`);
        return;
    }

    // 4. Repo registry lookup by standardized path.
    const existingRepo = state.repos.find(
        (repo) => standardizePath(repo.path, state.homeDirectory) === repoPath
    );
    const repoID = existingRepo?.id ?? deps.uuid();

    // 5. Worktree path from the base-path template.
    const worktreePath = worktreePathFor({
        template: deps.worktreeBasePath,
        repoPath,
        home: state.homeDirectory,
        folderName
    });

    // 6. Pre-minted workspace id, then the async git work.
    const workspaceID = deps.uuid();
    const seed: WorktreeSeed = { path: worktreePath, branchName: safeBranch };

    void deps.git
        .worktreeAdd({
            repoPath,
            worktreePath: seed.path,
            branchName: seed.branchName,
            updateMain: msg.update_main
        })
        .then(() => {
            if (existingRepo === undefined) {
                ctx.store.dispatch({
                    type: 'add-repo',
                    repo: {
                        id: repoID,
                        path: repoPath,
                        name: path.basename(repoPath),
                        remoteURL: null,
                        lastAccessedAt: deps.now() / 1000,
                        // A worktree flow promotes the repo to "kept" (§4.1 step 7).
                        isAutoDiscovered: false
                    }
                });
            }
            dispatchCreate(ctx, deps, {
                name: workspaceName,
                workingDirectory: seed.path,
                color: msg.color,
                profile: msg.profile,
                groupID,
                workspaceID,
                repoAssociations: [
                    {
                        id: deps.uuid(),
                        repoID,
                        worktreePath: seed.path,
                        branchName: seed.branchName,
                        isAutoDetected: false
                    }
                ]
            });
            const created = workspaceByID(ctx.store.getState(), workspaceID);
            ok(reply, {
                workspace_id: uuidOut(workspaceID),
                workspace_name: created?.name ?? workspaceName,
                worktree_path: seed.path,
                branch: seed.branchName,
                ...(groupName !== undefined ? { group: groupName } : {})
            });
        })
        .catch((error: unknown) => {
            fail(reply, worktreeErrorMessage(error));
        });
}

function handleWorkspaceCreate(
    msg: WorkspaceCreateMessage,
    ctx: AppContext,
    reply: ReplyHandle | null,
    deps: AppDeps
): void {
    const worktreeName = msg.worktree;
    if (worktreeName !== undefined && worktreeName !== '') {
        handleWorktreeCreate(msg, worktreeName, ctx, reply, deps);
        return;
    }

    const state = ctx.store.getState();
    const workspaceName = msg.name ?? DEFAULT_WORKSPACE_NAME;
    const trimmedGroup = msg.group?.trim() ?? '';
    const workspaceID = deps.uuid();

    // (b) Top-level branch: reply first, then create.
    if (trimmedGroup === '') {
        ok(reply, { workspace_id: uuidOut(workspaceID), workspace_name: workspaceName });
        dispatchCreate(ctx, deps, {
            name: workspaceName,
            workingDirectory: msg.path,
            color: msg.color,
            profile: msg.profile,
            groupID: undefined,
            workspaceID,
            repoAssociations: undefined
        });
        return;
    }

    // (c) Group branch: ambiguity is rejected BEFORE any mutation.
    const scope = resolveStateOf(state);
    const existing = resolveGroupStrict(scope, trimmedGroup);
    if (existing === null && groupsMatchingName(scope, trimmedGroup).length > 0) {
        fail(reply, ambiguousGroupError(trimmedGroup));
        return;
    }

    let groupID = existing?.id;
    if (groupID === undefined) {
        groupID = deps.uuid();
        ctx.store.dispatch({
            type: 'create-group',
            id: groupID,
            name: trimmedGroup,
            now: deps.now()
        });
    }

    ok(reply, {
        workspace_id: uuidOut(workspaceID),
        workspace_name: workspaceName,
        group: trimmedGroup
    });
    dispatchCreate(ctx, deps, {
        name: workspaceName,
        workingDirectory: msg.path,
        color: msg.color,
        profile: msg.profile,
        groupID,
        workspaceID,
        repoAssociations: undefined
    });
}

// ---------------------------------------------------------------------------
// workspace-delete (§6.4)
// ---------------------------------------------------------------------------

function handleWorkspaceDelete(
    nameOrID: string,
    force: boolean,
    ctx: AppContext,
    reply: ReplyHandle | null,
    deps: AppDeps
): void {
    const state = ctx.store.getState();
    const scope = resolveStateOf(state);
    const resolved = resolveWorkspaceStrict(scope, nameOrID);
    if (resolved === null) {
        if (!isUUIDToken(nameOrID) && workspacesMatchingName(scope, nameOrID).length > 1) {
            fail(reply, `workspace name is ambiguous: ${nameOrID} (use the id)`);
        } else {
            fail(reply, `workspace not found: ${nameOrID}`);
        }
        return;
    }
    const workspace = workspaceByID(state, resolved.id);
    if (workspace === null) {
        fail(reply, `workspace not found: ${nameOrID}`);
        return;
    }

    // Deliberately stricter than ⌘W's close-last-pane path (which may reach zero).
    if (state.workspaces.length <= 1) {
        fail(reply, 'refusing to delete the last workspace');
        return;
    }

    const active = activeAgentCount(workspace);
    if (!force && active > 0) {
        fail(
            reply,
            `workspace ${workspace.name} has ${String(active)} running ${active === 1 ? 'agent' : 'agents'}; pass --force to delete anyway`,
            { active_agents: active }
        );
        return;
    }

    const path = workspacePath(workspace);
    ok(reply, {
        workspace_id: uuidOut(workspace.id),
        workspace_name: workspace.name,
        ...(path !== undefined ? { path } : {})
    });

    for (const pane of [...workspace.panes, ...workspace.parkedPanes]) {
        deps.killPane(pane.id, ctx);
    }
    ctx.store.dispatch({ type: 'delete-workspace', id: workspace.id });
    refreshSyncGroup(ctx, workspace.id);
    deps.persist();
}

// ---------------------------------------------------------------------------
// workspace-move / workspace-profile (fire-and-forget, §6.3 / §6.5)
// ---------------------------------------------------------------------------

function handleWorkspaceMove(
    nameOrID: string,
    groupToken: string | undefined,
    index: number | undefined,
    ctx: AppContext,
    deps: AppDeps
): void {
    const state = ctx.store.getState();
    const scope = resolveStateOf(state);
    const workspace = resolveWorkspaceStrict(scope, nameOrID);
    if (workspace === null) return;

    let groupID: string | null = null;
    if (groupToken !== undefined && groupToken !== '') {
        // Group CREATION is deliberately unsupported here (that's `workspace-create --group`).
        const group = resolveGroupStrict(scope, groupToken);
        if (group === null) return;
        groupID = group.id;
    }
    ctx.store.dispatch({
        type: 'move-workspace-to-group',
        id: workspace.id,
        groupID,
        ...(index !== undefined ? { index } : {})
    });
    deps.persist();
}

function handleWorkspaceProfile(
    nameOrID: string,
    profile: string | undefined,
    ctx: AppContext,
    deps: AppDeps
): void {
    const scope = resolveStateOf(ctx.store.getState());
    const workspace = resolveWorkspaceStrict(scope, nameOrID);
    if (workspace === null) return;
    ctx.store.dispatch({
        type: 'set-workspace-profile',
        id: workspace.id,
        profileName: profile ?? null
    });
    deps.persist();
}

// ---------------------------------------------------------------------------
// workspace-label (§6.6)
// ---------------------------------------------------------------------------

const LABEL_GUARDS: Readonly<Record<string, string>> = {
    set: 'no label value to set (use --clear to remove all labels)',
    add: 'no label value to add',
    remove: 'no label value to remove'
};

function handleWorkspaceLabel(
    nameOrID: string,
    op: string,
    values: readonly string[],
    ctx: AppContext,
    reply: ReplyHandle | null,
    deps: AppDeps
): void {
    const scope = resolveStateOf(ctx.store.getState());
    const workspace = resolveWorkspaceStrict(scope, nameOrID);
    if (workspace === null) {
        fail(reply, `no workspace matches '${nameOrID}'`);
        return;
    }
    if (op !== 'set' && op !== 'add' && op !== 'remove' && op !== 'clear') {
        fail(reply, `unknown label operation '${op}'`);
        return;
    }
    const normalized = values.map(normalizeLabel).filter((value) => value !== '');
    if (op !== 'clear' && normalized.length === 0) {
        // A `set` whose values all normalize away must NOT silently wipe the label set.
        fail(reply, LABEL_GUARDS[op] ?? `no label value to ${op}`);
        return;
    }

    ctx.store.dispatch({
        type: 'workspace-labels',
        id: workspace.id,
        op,
        values: normalized,
        // `set`/`add` back-fill a gray preset for every introduced label (§6.6 step 5).
        backfillPresets: true
    });
    deps.persist();

    const updated = workspaceByID(ctx.store.getState(), workspace.id);
    ok(reply, {
        workspace_id: uuidOut(workspace.id),
        workspace_name: updated?.name ?? workspace.name,
        labels: [...(updated?.labels ?? [])]
    });
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export function workspaceHandlerEntries(deps: AppDeps): readonly (readonly [string, AppHandler])[] {
    return [
        forCommand('workspace-list', (msg, ctx, reply) => {
            handleWorkspaceList(msg.group, ctx, reply);
        }),
        forCommand('workspace-create', (msg, ctx, reply) => {
            handleWorkspaceCreate(msg, ctx, reply, deps);
        }),
        forCommand('workspace-delete', (msg, ctx, reply) => {
            handleWorkspaceDelete(msg.name, msg.force, ctx, reply, deps);
        }),
        forCommand('workspace-move', (msg, ctx) => {
            handleWorkspaceMove(msg.name, msg.group, msg.index, ctx, deps);
        }),
        forCommand('workspace-profile', (msg, ctx) => {
            handleWorkspaceProfile(msg.name, msg.profile, ctx, deps);
        }),
        forCommand('workspace-label', (msg, ctx, reply) => {
            handleWorkspaceLabel(msg.name, msg.label_op, msg.label_values, ctx, reply, deps);
        })
    ];
}
