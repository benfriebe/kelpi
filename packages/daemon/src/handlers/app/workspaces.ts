/**
 * `workspace-*` command handlers (socket-handlers.md §6).
 *
 * `workspace-list` / `workspace-create` / `workspace-delete` / `workspace-label` are
 * request/response; `workspace-move` / `workspace-profile` are fire-and-forget (guards still
 * run, failures are silently dropped — §1 legacy path).
 * `workspace-mute` is request/response too, so a toggle can report the state it produced, and
 * so is `workspace-rename`, so a rename that did not resolve is an error rather than silence,
 * and so is `workspace-icon`, for the same reason.
 *
 * Ordering rules that are contract:
 *   - list order = sidebar order INCLUDING collapsed group members, deduped, with any
 *     unreachable workspace appended so the CLI can never lose one (§6.1);
 *   - create replies BEFORE the effect on the two synchronous branches and AFTER the git work
 *     on the worktree branch and on a create that associates a repository (§1
 *     reply-before-effect, §6.2a, §6.2d); the worktree branch streams its steps to a WS
 *     requester first (`reply.progress`, #294) and can be cancelled until git is done;
 *   - delete's guards run in order (resolve → last-workspace → agent panes) and the `path`
 *     field is the first SHELL pane's cwd (port note 17);
 *   - a delete that asks for worktree cleanup (`worktree_paths` / `prune_worktrees`, graft-git.md
 *     §8.7) replies AFTER the git work instead: the reply is where each worktree's outcome is.
 */

import path from 'node:path';

import { describeAgentSummary } from '@kelpi/core/agent';
import {
    formatIconString,
    iconRefusal,
    parseIconString,
    workspaceSidebarID,
    type IconRef
} from '@kelpi/core/codec';
import {
    groupsMatchingName,
    isUUIDToken,
    normalizeLabel,
    resolveGroupStrict,
    resolveWorkspaceStrict,
    workspacesMatchingName,
    type WorkspaceScope
} from '@kelpi/core/resolve';
import {
    buildWorkspaceListEntry,
    type JsonObject,
    type WorkspaceColor,
    type WorkspaceCreateMessage,
    type WorkspaceDeleteMessage,
    type WorkspaceListEntry
} from '@kelpi/protocol';

import type { ReplyHandle } from '../../seams.js';
import {
    workspaceAgentSummary,
    groupByID,
    groupIDForWorkspace,
    nextRandomColor,
    resolveStateOf,
    workspaceByID,
    type DaemonState,
    type Repo,
    type RepoAssociation,
    type WorkspaceGroup,
    type WorkspaceState
} from '../../store/index.js';
import {
    createStepTracker,
    describeWorktreeSkip,
    planWorktreeCleanup,
    removeWorktrees,
    sanitizedGitName,
    serializeWorktreeProgress,
    standardizePath,
    worktreeErrorMessage,
    worktreeKey,
    worktreePathFor,
    worktreeStepsFor,
    type WorktreeCleanupResult,
    type WorktreeCleanupRow
} from '../../git/index.js';
import { forCommand, listedWorkspaceIDs, refreshSyncGroup, uuidOut, wireTimestamp } from './common.js';
import { fail, ok, type AppContext, type AppDeps, type AppHandler } from './context.js';
import { associationFor, groupRepo, registeredRepo, resolveRepo, type RepoResolution } from './repos.js';

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
    // §6.1: the repo associations, so a script (or a scenario) can see which checkout a
    // workspace works in without the GUI's inspector. Elided by the builder when empty.
    const repos = workspace.repoAssociations.map((association) => {
        const repo = state.repos.find((candidate) => candidate.id === association.repoID);
        return {
            repo_id: uuidOut(association.repoID),
            ...(repo !== undefined ? { repo_name: repo.name, repo_path: repo.path } : {}),
            worktree_path: association.worktreePath,
            ...(association.branchName !== null ? { branch: association.branchName } : {})
        };
    });
    return buildWorkspaceListEntry({
        id: uuidOut(workspace.id),
        name: workspace.name,
        color: workspace.color,
        pane_count: workspace.panes.length,
        is_active: state.lastActiveWorkspaceID === workspace.id,
        created_at: wireTimestamp(workspace.createdAt),
        last_accessed_at: wireTimestamp(workspace.lastAccessedAt),
        labels: [...workspace.labels],
        muted: workspace.muted,
        icon: workspace.icon === null ? null : formatIconString(workspace.icon),
        ...(lastActivity !== undefined ? { last_activity_at: wireTimestamp(lastActivity) } : {}),
        ...(session !== undefined && session !== null ? { agent_session_id: session } : {}),
        ...(group !== undefined ? { group } : {}),
        repos
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
    /** Set on the create itself, so the first pane never raises an attention signal. */
    readonly muted: boolean;
    /** Set on the create itself, so the workspace has its icon from its first frame. */
    readonly icon: IconRef | null;
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
        ...(input.muted ? { muted: true } : {}),
        ...(input.icon !== null ? { icon: input.icon } : {}),
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
 * workspace `lastActiveWorkspaceID` moves what `kelpi workspace list` calls ACTIVE and nothing
 * else: a `kelpi workspace create` from a terminal used to leave the daemon and every open
 * window disagreeing for the rest of the session, and an agent's follow-up `kelpi pane create`
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
    return `unknown group: ${name} — --worktree only supports existing groups; create it first (\`kelpi group create\`) or omit --group`;
}

function handleWorktreeCreate(
    msg: WorkspaceCreateMessage,
    worktreeName: string,
    icon: IconRef | null,
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
    let groupDefault: WorkspaceGroup | null = null;
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
        if (msg.group_defaults) groupDefault = groupByID(state, group.id);
    }

    // 2. Source repo: an explicit `repo` wins, then the group's default repository
    // (app-state-core.md §5.5), then `path` (which the CLI fills with its cwd when it leaves
    // the choice to the group).
    const defaultRepo = groupDefault === null ? null : groupRepo(state, groupDefault);
    const repoPathRaw = msg.repo ?? defaultRepo?.path ?? msg.path;
    if (repoPathRaw === undefined || repoPathRaw.trim() === '') {
        fail(reply, '--worktree requires a source repo (pass --repo <path>)');
        return;
    }
    const repoPath = standardizePath(repoPathRaw, state.homeDirectory);
    // §5.5: a group whose switch is on makes update main the default; only an explicit
    // `update_main` (`--update-main` / `--no-update-main`, or the sheet's checkbox) overrides it.
    const updateMain = msg.update_main ?? (groupDefault?.createWorktree === true);

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

    /*
     * #294 (graft-git.md §8.5.1): the steps are streamed to the connection that asked, when it
     * can take them (a WS client; `reply.progress` is absent on the control socket, so the CLI
     * gets exactly the one reply it always got). The last snapshot is flushed BEFORE the reply,
     * so the step list a client ends on always agrees with the reply that follows it.
     */
    const progress = reply?.progress?.bind(reply);
    const creation = deps.worktrees.begin();
    const steps =
        progress === undefined || !creation.detailed
            ? null
            : createStepTracker({
                  steps: worktreeStepsFor(updateMain),
                  emit: (snapshot) => progress(serializeWorktreeProgress(snapshot))
              });
    if (progress !== undefined && !creation.detailed) {
        // No steps and no cancel on this path (a plugin provider owns `kelpi.git`, graft-git.md
        // §8.3): one frame says so, so the sheet shows a plain "Creating…" instead of a
        // checklist that never moves, and a cancel of this request answers `cancelled: false`.
        reply?.uncancellable?.();
        progress(serializeWorktreeProgress({ steps: [], detailed: false }));
    }
    const signal = creation.detailed ? reply?.signal : undefined;

    void creation
        .run(
            {
                repoPath,
                worktreePath: seed.path,
                branchName: seed.branchName,
                updateMain
            },
            { ...(signal !== undefined ? { signal } : {}), steps }
        )
        .then(() => {
            /*
             * §8.5.2: once the worktree exists the create COMPLETES, even if a cancel arrives
             * now. Everything below is synchronous store work that cannot be half-done, and
             * rolling a finished worktree back would destroy a checkout the user may already be
             * looking at in the reply's reveal; completing is the simpler of the two safe
             * answers. (`performWorktreeAdd` checks the signal after git returns, so a cancel
             * that raced git's exit is still honoured there.)
             */
            steps?.running('create-workspace');
            if (existingRepo !== undefined) {
                /*
                 * §GIT-103, the half the insert-skip used to swallow.
                 *
                 * The Swift sets `state.repoRegistry[id: repoID]?.isAutoDiscovered = false`
                 * UNCONDITIONALLY on `worktreeCreated` (`AppReducer+RepoGit.swift:156-157`) —
                 * it does not care whether the repo was already in the registry. The port only
                 * marked the repo manual on the INSERT, so a repo auto-detect had already
                 * registered (`isAutoDiscovered: true`) stayed auto-discovered after the user
                 * deliberately built a worktree from it, and §GIT-081's GC would then collect
                 * the registry row the moment its auto association lapsed — taking the user's
                 * own worktree's parent out of the registry with it.
                 */
                if (existingRepo.isAutoDiscovered) {
                    ctx.store.dispatch({
                        type: 'set-repo-auto-discovered',
                        id: repoID,
                        isAutoDiscovered: false
                    });
                }
            } else {
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
                muted: msg.muted === true,
                icon,
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
            steps?.done('create-workspace', created?.name ?? workspaceName);
            steps?.flush();
            ok(reply, {
                workspace_id: uuidOut(workspaceID),
                workspace_name: created?.name ?? workspaceName,
                worktree_path: seed.path,
                branch: seed.branchName,
                // §5.5: echoed, since a group's switch can have chosen it on the caller's behalf.
                update_main: updateMain,
                repo_path: repoPath,
                // Echoed so `--muted` is confirmed: a daemon that predates it drops the field.
                muted: created?.muted ?? false,
                ...iconEcho(created?.icon ?? null),
                ...(groupName !== undefined ? { group: groupName } : {})
            });
        })
        .catch((error: unknown) => {
            // The flow has already marked a failed (or cancelled) git step. Anything else is pinned
            // on the running step (`create-workspace` when the store work threw) or, when none ran
            // (the busy guard), the first one, so the final frame always names the step.
            const message = worktreeErrorMessage(error);
            steps?.failUnfinished(message);
            steps?.flush();
            fail(reply, message);
        });
}

/**
 * §6.2 (d) / app-state-core.md §5.5: a plain (non-worktree) create that starts with a repository
 * associated: the request's `repo` (a path), or the group's default repository (a registry row).
 *
 * A path is resolved first (git work, so the reply comes AFTER the effect here, as on the
 * worktree branch) and nothing is mutated until it has resolved: a path that is not a repository
 * fails the whole create, and never leaves a workspace or a new group behind. The group's repo is
 * taken AS IS, by id, and never re-resolved: the registry may hold a monorepo subfolder or a
 * linked worktree as a row of its own, and resolving its path would pick a different repo. The
 * first pane opens in the checkout unless `path` says otherwise, the same rule the New Workspace
 * sheet applies to a single chosen repository (issue #38).
 */
function handleCreateWithRepo(
    msg: WorkspaceCreateMessage,
    source: { readonly path: string } | { readonly repo: Repo },
    icon: IconRef | null,
    ctx: AppContext,
    reply: ReplyHandle | null,
    deps: AppDeps
): void {
    const workspaceName = msg.name ?? DEFAULT_WORKSPACE_NAME;
    const trimmedGroup = msg.group?.trim() ?? '';
    const workspaceID = deps.uuid();
    const resolving: Promise<RepoResolution> =
        'repo' in source ? Promise.resolve(registeredRepo(ctx, source.repo)) : resolveRepo(ctx, deps, source.path);
    void resolving
        .then(async (resolution) => {
            if (!resolution.ok) {
                fail(reply, resolution.error);
                return;
            }
            const association = await associationFor(deps, resolution);
            // Re-resolved after the git work: the group the request named can have been
            // created, renamed or deleted while it ran.
            let groupID: string | undefined;
            if (trimmedGroup !== '') {
                const scope = resolveStateOf(ctx.store.getState());
                const existing = resolveGroupStrict(scope, trimmedGroup);
                if (existing === null && groupsMatchingName(scope, trimmedGroup).length > 0) {
                    deps.persist();
                    fail(reply, ambiguousGroupError(trimmedGroup));
                    return;
                }
                groupID = existing?.id;
                if (groupID === undefined) {
                    groupID = deps.uuid();
                    ctx.store.dispatch({ type: 'create-group', id: groupID, name: trimmedGroup, now: deps.now() });
                }
            }
            dispatchCreate(ctx, deps, {
                name: workspaceName,
                workingDirectory: msg.path ?? association.worktreePath,
                color: msg.color,
                profile: msg.profile,
                muted: msg.muted === true,
                icon,
                groupID,
                workspaceID,
                repoAssociations: [association]
            });
            const created = workspaceByID(ctx.store.getState(), workspaceID);
            ok(reply, {
                workspace_id: uuidOut(workspaceID),
                workspace_name: created?.name ?? workspaceName,
                muted: created?.muted ?? msg.muted === true,
                ...iconEcho(created?.icon ?? icon),
                repo_path: resolution.repo.path,
                ...(trimmedGroup !== '' ? { group: trimmedGroup } : {})
            });
        })
        .catch((error: unknown) => {
            fail(reply, error instanceof Error ? error.message : String(error));
        });
}

function handleWorkspaceCreate(
    msg: WorkspaceCreateMessage,
    ctx: AppContext,
    reply: ReplyHandle | null,
    deps: AppDeps
): void {
    // Refused before any branch runs, so a bad icon never leaves a workspace, a group or a
    // worktree behind.
    const requested = requestedIcon(msg.icon);
    if ('error' in requested) {
        fail(reply, requested.error);
        return;
    }
    const icon = requested.icon;

    const worktreeName = msg.worktree;
    if (worktreeName !== undefined && worktreeName !== '') {
        handleWorktreeCreate(msg, worktreeName, icon, ctx, reply, deps);
        return;
    }

    const state = ctx.store.getState();
    const workspaceName = msg.name ?? DEFAULT_WORKSPACE_NAME;
    const trimmedGroup = msg.group?.trim() ?? '';

    // (d) A repository to associate: the request's own `repo`, else the group's default
    // (app-state-core.md §5.5). Resolving it is git work, so this is the one synchronous-shaped
    // create that replies AFTER the effect, like the worktree branch.
    const scope = resolveStateOf(state);
    const existing = trimmedGroup === '' ? null : resolveGroupStrict(scope, trimmedGroup);
    const existingGroup = existing === null ? null : groupByID(state, existing.id);
    const defaultRepo =
        msg.group_defaults && existingGroup !== null ? groupRepo(state, existingGroup) : null;
    const source = msg.repo !== undefined ? { path: msg.repo } : defaultRepo !== null ? { repo: defaultRepo } : null;
    if (source !== null) {
        if (trimmedGroup !== '' && existing === null && groupsMatchingName(scope, trimmedGroup).length > 0) {
            fail(reply, ambiguousGroupError(trimmedGroup));
            return;
        }
        handleCreateWithRepo(msg, source, icon, ctx, reply, deps);
        return;
    }

    const workspaceID = deps.uuid();

    // (b) Top-level branch: reply first, then create.
    if (trimmedGroup === '') {
        ok(reply, {
            workspace_id: uuidOut(workspaceID),
            workspace_name: workspaceName,
            muted: msg.muted === true,
            ...iconEcho(icon)
        });
        dispatchCreate(ctx, deps, {
            name: workspaceName,
            workingDirectory: msg.path,
            color: msg.color,
            profile: msg.profile,
            muted: msg.muted === true,
            icon,
            groupID: undefined,
            workspaceID,
            repoAssociations: undefined
        });
        return;
    }

    // (c) Group branch: ambiguity is rejected BEFORE any mutation.
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
        muted: msg.muted === true,
        ...iconEcho(icon),
        group: trimmedGroup
    });
    dispatchCreate(ctx, deps, {
        name: workspaceName,
        workingDirectory: msg.path,
        color: msg.color,
        profile: msg.profile,
        muted: msg.muted === true,
        icon,
        groupID,
        workspaceID,
        repoAssociations: undefined
    });
}

/**
 * The `icon` a `workspace-create` / `workspace-icon` request carries, as the icon to store. Absent
 * is the letter avatar. A string is the flat DB spelling and must parse and pass `iconRefusal`,
 * the check the GUI's `set-workspace-icon` makes; unlike that verb, a string that does not parse
 * is refused rather than read as "clear", since a script that typed one meant to set something.
 */
function requestedIcon(raw: string | undefined): { readonly icon: IconRef | null } | { readonly error: string } {
    if (raw === undefined) return { icon: null };
    const icon = parseIconString(raw);
    if (icon === null) return { error: `'${raw}' is not an icon: give emoji:<emoji> or system:<symbol>` };
    const refusal = iconRefusal(icon);
    return refusal === null ? { icon } : { error: refusal };
}

/** A create reply's `icon`: echoed only when one was set, so `--icon` can be confirmed. */
function iconEcho(icon: IconRef | null): { readonly icon?: string } {
    return icon === null ? {} : { icon: formatIconString(icon) };
}

/**
 * Why `resolveWorkspaceStrict` returned null, for the request/response verbs that tell the two
 * apart (wire-protocol.md §5.8): a name that matches 2+ workspaces is "ambiguous" and points at
 * the id, anything else is "not found". A UUID token is never ambiguous: an id that matched
 * nothing fell through to a name match, and several workspaces named after one UUID is not a
 * case worth a message of its own.
 */
function unresolvedWorkspaceError(scope: WorkspaceScope, nameOrID: string): string {
    if (!isUUIDToken(nameOrID) && workspacesMatchingName(scope, nameOrID).length > 1) {
        return `workspace name is ambiguous: ${nameOrID} (use the id)`;
    }
    return `workspace not found: ${nameOrID}`;
}

// ---------------------------------------------------------------------------
// workspace-delete (§6.4)
// ---------------------------------------------------------------------------

/**
 * How long a delete waits for its panes' processes to exit before any worktree is removed. A
 * kill is SIGHUP then SIGKILL after 300 ms, so this is the ceiling for a process that ignores
 * both, not the usual wait; a shell still writing into the tree when git looks is what would
 * make it refuse a worktree the user just saw as clean.
 */
export const PANE_EXIT_WAIT_MS = 2_000;

/**
 * How long a deleted workspace's rows stay claimable by a later delete of the same gesture
 * (`batch_ids`). A bulk or group delete sends the worktree cleanup on its LAST delete, after the
 * earlier ones have replied, so this only has to outlast one gesture.
 */
export const DELETED_WORKSPACE_MEMORY_MS = 120_000;

/** What a delete remembers about the workspace it removed, for a later delete of its batch. */
interface DeletedWorkspace {
    readonly id: string;
    readonly rows: readonly RepoAssociation[];
    /** The reply's `path`: where its first shell was, for a worktree it has no row for. */
    readonly path: string | undefined;
    readonly exited: Promise<void>;
    readonly at: number;
}

/**
 * The batch memory (graft-git.md §8.7). Only a workspace that was ACTUALLY deleted is in it: one
 * a plugin hook vetoed, or a guard refused, never reaches the handler's delete, so a later
 * `batch_ids` naming it finds nothing, and the workspace (still there) counts as a sharer.
 */
export interface DeletedWorkspaceMemory {
    remember(entry: Omit<DeletedWorkspace, 'at'>): void;
    /** The named, still-remembered workspaces, removed from memory: a batch is claimed once. */
    take(ids: readonly string[]): DeletedWorkspace[];
}

export function createDeletedWorkspaceMemory(now: () => number): DeletedWorkspaceMemory {
    const entries = new Map<string, DeletedWorkspace>();
    const prune = (): void => {
        const oldest = now() - DELETED_WORKSPACE_MEMORY_MS;
        for (const [id, entry] of entries) if (entry.at < oldest) entries.delete(id);
    };
    return {
        remember(entry) {
            prune();
            entries.set(uuidOut(entry.id), { ...entry, at: now() });
        },
        take(ids) {
            prune();
            const found: DeletedWorkspace[] = [];
            for (const id of ids) {
                const entry = entries.get(uuidOut(id));
                if (entry === undefined) continue;
                entries.delete(uuidOut(id));
                found.push(entry);
            }
            return found;
        }
    };
}

/** What a delete asked to do with worktrees; null = nothing. */
interface WorktreeCleanupRequest {
    /** Named worktrees (the dialog's ticks), or the ones Kelpi made (`prune_worktrees`). */
    readonly selection:
        | { readonly kind: 'paths'; readonly paths: readonly string[]; readonly force: readonly string[] }
        | { readonly kind: 'kelpi' };
    readonly deleteBranches: boolean;
    /** Workspaces deleted earlier in the same gesture whose worktrees this delete takes too. */
    readonly batch: readonly string[];
}

function worktreeCleanupOf(msg: WorkspaceDeleteMessage): WorktreeCleanupRequest | null {
    const deleteBranches = msg.delete_branches === true;
    const batch = [...new Set(msg.batch_ids ?? [])];
    if (msg.prune_worktrees === true) return { selection: { kind: 'kelpi' }, deleteBranches, batch };
    const paths = [...new Set(msg.worktree_paths ?? [])].filter((entry) => entry.trim() !== '');
    const force = [...new Set(msg.force_worktree_paths ?? [])].filter((entry) => paths.includes(entry));
    return paths.length === 0 ? null : { selection: { kind: 'paths', paths, force }, deleteBranches, batch };
}

/** Resolves once every listed pane that has a live PTY has exited, or after `ms`. */
function paneExits(ctx: AppContext, paneIDs: readonly string[], ms: number): Promise<void> {
    const waiting = new Set(paneIDs.filter((paneID) => ctx.pty.has(paneID)));
    if (waiting.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
        let done = false;
        const finish = (): void => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            off();
            resolve();
        };
        const timer = setTimeout(finish, ms);
        timer.unref?.();
        const off = ctx.pty.onExit((paneID) => {
            waiting.delete(paneID);
            if (waiting.size === 0) finish();
        });
    });
}

function serializeCleanupResult(result: WorktreeCleanupResult): JsonObject {
    return {
        ...(result.associationID !== undefined ? { association_id: uuidOut(result.associationID) } : {}),
        worktree_path: result.worktreePath,
        ...(result.branch !== undefined ? { branch: result.branch } : {}),
        removed: result.removed,
        ...(result.discardedChanges !== undefined ? { discarded_changes: result.discardedChanges } : {}),
        ...(result.blocked !== undefined ? { blocked: result.blocked } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.branchDeleted !== undefined ? { branch_deleted: result.branchDeleted } : {}),
        ...(result.branchError !== undefined ? { branch_error: result.branchError } : {})
    };
}

/**
 * The worktree half of a delete (graft-git.md §8.7), after the workspace is already gone: wait
 * for its panes (and its batch's) to exit, plan the rows against the state as it is NOW, so
 * every workspace of the batch is already gone and none of them counts as sharing, remove what
 * the plan allows, and reply. Never fails the reply: the workspace is deleted either way.
 */
async function removeDeletedWorkspaceWorktrees(
    owners: readonly Omit<DeletedWorkspace, 'at'>[],
    request: WorktreeCleanupRequest,
    head: JsonObject,
    ctx: AppContext,
    reply: ReplyHandle | null,
    deps: AppDeps
): Promise<void> {
    const entries: JsonObject[] = [];
    try {
        await Promise.all(owners.map((owner) => owner.exited));
        const state = ctx.store.getState();
        const cleanupDeps = { git: deps.git, bundled: deps.bundledWorktrees(), worktreeBasePath: deps.worktreeBasePath };
        const rows: WorktreeCleanupRow[] = owners.flatMap((owner) =>
            owner.rows.map((association) => ({ workspaceID: owner.id, association }))
        );
        if (request.selection.kind === 'kelpi') {
            // The worktree each shell was in: a workspace may have no row for it (auto-detect
            // off, or not linked yet), which is the one `--prune-worktree` used to prune.
            for (const owner of owners) {
                if (owner.path === undefined) continue;
                let info: Awaited<ReturnType<AppDeps['git']['resolveRepoRoot']>> = null;
                try {
                    info = await deps.git.resolveRepoRoot(owner.path);
                } catch {
                    info = null;
                }
                if (info !== null) rows.push({ workspaceID: owner.id, association: { id: null, worktreePath: info.worktreeRoot } });
            }
        }
        const home = state.homeDirectory;
        const wanted =
            request.selection.kind === 'paths'
                ? new Map(request.selection.paths.map((entry) => [worktreeKey(entry, home), entry]))
                : null;
        const chosen = wanted === null ? rows : rows.filter((row) => wanted.has(worktreeKey(row.association.worktreePath, home)));
        const plan = await planWorktreeCleanup(
            { state, rows: chosen, excluding: new Set(owners.map((owner) => owner.id)) },
            cleanupDeps
        );
        // `prune_worktrees` takes only what Kelpi made; a worktree a pane merely visited stays,
        // unmentioned, exactly as the window's `remove` setting leaves it.
        const candidates = wanted === null ? plan.candidates.filter((candidate) => candidate.managed) : plan.candidates;
        // Only a named worktree the user agreed to lose changes in is ever forced; prune never is.
        const force =
            request.selection.kind === 'paths'
                ? new Set(request.selection.force.map((entry) => worktreeKey(entry, home)))
                : undefined;
        const results = await removeWorktrees(candidates, { deleteBranches: request.deleteBranches, force }, cleanupDeps);
        entries.push(...results.map(serializeCleanupResult));
        if (wanted !== null) {
            for (const skipped of plan.skipped) {
                const associationID = skipped.associations.find((entry) => entry.associationID !== null)?.associationID;
                entries.push({
                    ...(associationID !== undefined && associationID !== null ? { association_id: uuidOut(associationID) } : {}),
                    worktree_path: skipped.worktreePath,
                    removed: false,
                    error: describeWorktreeSkip(skipped.reason)
                });
            }
            const planned = new Set(chosen.map((row) => worktreeKey(row.association.worktreePath, home)));
            for (const [key, requested] of wanted) {
                if (!planned.has(key)) {
                    entries.push({ worktree_path: requested, removed: false, error: 'not a worktree of the deleted workspaces' });
                }
            }
        }
    } catch (error) {
        // Planning never throws on a git failure (each becomes a result), so this is a bug
        // path; the delete still stands, and the reply says what did not happen.
        ok(reply, { ...head, worktrees: entries, worktrees_error: error instanceof Error ? error.message : String(error) });
        return;
    }
    ok(reply, { ...head, worktrees: entries });
}

function handleWorkspaceDelete(
    msg: WorkspaceDeleteMessage,
    ctx: AppContext,
    reply: ReplyHandle | null,
    deps: AppDeps,
    deleted: DeletedWorkspaceMemory
): void {
    const nameOrID = msg.name;
    const force = msg.force;
    const allowLast = msg.allow_last === true;
    const state = ctx.store.getState();
    const scope = resolveStateOf(state);
    const resolved = resolveWorkspaceStrict(scope, nameOrID);
    if (resolved === null) {
        fail(reply, unresolvedWorkspaceError(scope, nameOrID));
        return;
    }
    const workspace = workspaceByID(state, resolved.id);
    if (workspace === null) {
        fail(reply, `workspace not found: ${nameOrID}`);
        return;
    }

    /*
     * The last-workspace guard, and the one caller allowed past it (§WS-156 / §APP-067).
     *
     * The shipped app is asymmetric on purpose: `kelpi workspace delete` and the sidebar's own
     * Delete item both refuse at one workspace (`.disabled(store.workspaces.count <= 1)`), while
     * ⌘W closing the last pane of the last workspace DOES reach zero — which is the only way to
     * arrive at `ContentView.swift:237-249`'s "No workspace selected" state, and the reason that
     * state has a Create button in it.
     *
     * This guard used to be unconditional, which made the port stricter than the Swift on the
     * one path the Swift is lenient on, and made the empty state unreachable by any gesture. The
     * flag is set by exactly that path in the client (`act.closeFocused`) and by nothing else:
     * the CLI does not send it, so `kelpi workspace delete` still refuses here.
     */
    if (state.workspaces.length <= 1 && !allowLast) {
        fail(reply, 'refusing to delete the last workspace');
        return;
    }

    const agents = workspaceAgentSummary(workspace);
    if (!force && agents.total > 0) {
        fail(
            reply,
            `workspace ${workspace.name} has ${describeAgentSummary(agents)}; pass --force to delete anyway`,
            { active_agents: agents.total, running: agents.running, waiting: agents.waiting, inactive: agents.inactive }
        );
        return;
    }

    const panes = [...workspace.panes, ...workspace.parkedPanes];
    try { ctx.prepareDocumentClose?.(panes.map(pane => pane.id)); }
    catch (error) { fail(reply, error instanceof Error ? error.message : String(error)); return; }
    const path = workspacePath(workspace);
    const head: JsonObject = {
        workspace_id: uuidOut(workspace.id),
        workspace_name: workspace.name,
        ...(path !== undefined ? { path } : {})
    };
    const cleanup = worktreeCleanupOf(msg);
    if (cleanup === null) ok(reply, head);

    // Listening before the kill, so an exit that lands at once is not missed. Every delete
    // remembers what a later delete of its batch needs (graft-git.md §8.7), cleanup or not.
    const exited = paneExits(ctx, panes.map((pane) => pane.id), PANE_EXIT_WAIT_MS);
    for (const pane of panes) {
        deps.killPane(pane.id, ctx);
    }
    ctx.store.dispatch({ type: 'delete-workspace', id: workspace.id });
    refreshSyncGroup(ctx, workspace.id);
    deps.persist();
    const self = { id: workspace.id, rows: workspace.repoAssociations, path, exited };
    if (cleanup === null) {
        deleted.remember(self);
        return;
    }
    const batch = deleted.take(cleanup.batch.filter((id) => uuidOut(id) !== uuidOut(workspace.id)));
    void removeDeletedWorkspaceWorktrees([self, ...batch], cleanup, head, ctx, reply, deps);
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
        ...(index !== undefined ? { index } : {}),
        /*
         * SET-012. The sidebar's drag-and-drop IS this verb, so the setting is applied at the
         * verb rather than at the gesture: `expand-group-on-workspace-drop = false` leaves a
         * collapsed target group shut around the row it just swallowed.
         *
         * Stated divergence: in the Swift app the flag is read in the sidebar's drop handler,
         * so it governs the GUI only. The wire field that would have kept that split
         * (`expand_on_drop`) does not exist in wire-protocol.md §7 and inventing one would put
         * this port's decoder out of conformance with the spec, so `kelpi workspace move --group`
         * into a collapsed group honours the same setting. Default (on) is unchanged behaviour
         * for both callers.
         */
        expandOnDrop: deps.expandGroupOnDrop
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
// workspace-mute (§6.7)
// ---------------------------------------------------------------------------

function handleWorkspaceMute(
    nameOrID: string,
    muted: boolean | undefined,
    ctx: AppContext,
    reply: ReplyHandle | null,
    deps: AppDeps
): void {
    const state = ctx.store.getState();
    const resolved = resolveWorkspaceStrict(resolveStateOf(state), nameOrID);
    const workspace = resolved === null ? null : workspaceByID(state, resolved.id);
    if (workspace === null) {
        fail(reply, `no workspace matches '${nameOrID}'`);
        return;
    }
    // Absent = toggle, resolved here so the reply reports the state it produced.
    const next = muted ?? !workspace.muted;
    ctx.store.dispatch({ type: 'set-workspace-muted', id: workspace.id, muted: next });
    deps.persist();
    ok(reply, { workspace_id: uuidOut(workspace.id), workspace_name: workspace.name, muted: next });
}

// ---------------------------------------------------------------------------
// workspace-rename (§6.8)
// ---------------------------------------------------------------------------

/**
 * The sidebar's inline rename (⇧⌘R), for the CLI. The rules are the GUI's, so a name typed in
 * either place ends up the same: trimmed, refused when nothing is left, no length or character
 * limit, and duplicates allowed (a later name lookup reports the ambiguity, which is what the
 * error below is for). Renaming to the current name is a successful no-op, the CLI's answer to
 * the inline editor's "unchanged → cancel". The reducer recomputes the slug.
 */
function handleWorkspaceRename(
    nameOrID: string,
    newName: string,
    ctx: AppContext,
    reply: ReplyHandle | null,
    deps: AppDeps
): void {
    const state = ctx.store.getState();
    const scope = resolveStateOf(state);
    const resolved = resolveWorkspaceStrict(scope, nameOrID);
    const workspace = resolved === null ? null : workspaceByID(state, resolved.id);
    if (workspace === null) {
        fail(reply, unresolvedWorkspaceError(scope, nameOrID));
        return;
    }
    const trimmed = newName.trim();
    // The decoder only guarantees a non-empty string; whitespace alone would leave a blank row
    // that no name lookup could ever reach again.
    if (trimmed === '') {
        fail(reply, 'workspace name cannot be empty');
        return;
    }
    const oldName = workspace.name;
    if (trimmed !== oldName) {
        ctx.store.dispatch({ type: 'rename-workspace', id: workspace.id, name: trimmed });
        deps.persist();
    }
    ok(reply, { workspace_id: uuidOut(workspace.id), workspace_name: trimmed, old_name: oldName });
}

// ---------------------------------------------------------------------------
// workspace-icon (§6.9)
// ---------------------------------------------------------------------------

/**
 * The sidebar's "Change Icon" (and "Reset to Letter"), for the CLI. The icon is validated the
 * way the GUI's WS-only `set-workspace-icon` validates it (`iconRefusal`), so either spelling
 * stores the same things; an absent `icon` clears it. Setting the icon the workspace already has
 * is a successful no-op, like `workspace-rename`'s same name.
 */
function handleWorkspaceIcon(
    nameOrID: string,
    rawIcon: string | undefined,
    ctx: AppContext,
    reply: ReplyHandle | null,
    deps: AppDeps
): void {
    const state = ctx.store.getState();
    const scope = resolveStateOf(state);
    const resolved = resolveWorkspaceStrict(scope, nameOrID);
    const workspace = resolved === null ? null : workspaceByID(state, resolved.id);
    if (workspace === null) {
        fail(reply, unresolvedWorkspaceError(scope, nameOrID));
        return;
    }
    const requested = requestedIcon(rawIcon);
    if ('error' in requested) {
        fail(reply, requested.error);
        return;
    }
    const next = requested.icon === null ? null : formatIconString(requested.icon);
    const current = workspace.icon === null ? null : formatIconString(workspace.icon);
    if (next !== current) {
        ctx.store.dispatch({ type: 'set-workspace-icon', id: workspace.id, icon: requested.icon });
        deps.persist();
    }
    ok(reply, { workspace_id: uuidOut(workspace.id), workspace_name: workspace.name, icon: next, old_icon: current });
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export function workspaceHandlerEntries(deps: AppDeps): readonly (readonly [string, AppHandler])[] {
    const deleted = createDeletedWorkspaceMemory(deps.now);
    return [
        forCommand('workspace-list', (msg, ctx, reply) => {
            handleWorkspaceList(msg.group, ctx, reply);
        }),
        forCommand('workspace-create', (msg, ctx, reply) => {
            handleWorkspaceCreate(msg, ctx, reply, deps);
        }),
        forCommand('workspace-delete', (msg, ctx, reply) => {
            handleWorkspaceDelete(msg, ctx, reply, deps, deleted);
        }),
        forCommand('workspace-move', (msg, ctx) => {
            handleWorkspaceMove(msg.name, msg.group, msg.index, ctx, deps);
        }),
        forCommand('workspace-profile', (msg, ctx) => {
            handleWorkspaceProfile(msg.name, msg.profile, ctx, deps);
        }),
        forCommand('workspace-label', (msg, ctx, reply) => {
            handleWorkspaceLabel(msg.name, msg.label_op, msg.label_values, ctx, reply, deps);
        }),
        forCommand('workspace-mute', (msg, ctx, reply) => {
            handleWorkspaceMute(msg.name, msg.muted, ctx, reply, deps);
        }),
        forCommand('workspace-rename', (msg, ctx, reply) => {
            handleWorkspaceRename(msg.name, msg.new_name, ctx, reply, deps);
        }),
        forCommand('workspace-icon', (msg, ctx, reply) => {
            handleWorkspaceIcon(msg.name, msg.icon, ctx, reply, deps);
        })
    ];
}
