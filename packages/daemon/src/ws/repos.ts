/**
 * The workspace-inspector's repo verbs — the read + mutate surface behind the trailing
 * inspector panel (workspaces-sidebar.md §WS-139…WS-142, §WS-146…WS-148; graft-git.md
 * §GIT-098/099/103).
 *
 * They are **WS-only** for the same reason `WS_ONLY_COMMANDS` is: these are direct-manipulation
 * gestures the `nex` CLI has no verb for, and inventing one would be a compatibility surface
 * owed to the Swift CLI forever. They are matched before `decodeWireObject` in `sync.ts`.
 *
 * Unlike `WS_ONLY_COMMANDS` they are **asynchronous** — every one of them shells out to git —
 * so they resolve a promise and `sync.ts` answers through `command-reply` when it settles, the
 * same shape the M5 content verbs use.
 *
 *   repo-registry            -                                  → the registry + each repo's
 *                                                                 RESOLVED worktree base path
 *                                                                 (the client cannot expand
 *                                                                 `~`/`<repo>`: the daemon's
 *                                                                 home is stripped from the
 *                                                                 mirror on purpose)
 *   workspace-repo-status    `workspace_id`, `refresh?`         → one row per association:
 *                                                                 branch, dirtiness, diff stats
 *   add-repo-association     `workspace_id`, `path`             → registers the repo if new,
 *                                                                 then appends the association
 *   remove-repo-association  `workspace_id`, `association_id`,  → drops it; optionally runs a
 *                            `delete_worktree?`                   NON-forcing `git worktree
 *                                                                 remove` first
 *   workspace-add-worktree   `workspace_id`, `repo_id`|`repo_path`, `name`, `branch?`,
 *                            `update_main?`                     → `git worktree add` + registry
 *                                                                 + association, on the CURRENT
 *                                                                 workspace (the new-workspace
 *                                                                 half is `workspace-create
 *                                                                 --worktree`)
 *
 * …plus the registry's OWN editing surface, which Settings ▸ Repositories drives (§GIT-065…
 * §GIT-072, §SET-052…§SET-057). These four edit the global registry rather than a workspace's
 * associations:
 *
 *   repo-add                 `path`, `name?`                    → registers it, or PROMOTES an
 *                                                                 auto-discovered row to manual
 *   repo-remove              `repo_id`                          → drops it; the reducer cascades
 *                                                                 associations, the reconciler
 *                                                                 stops watchers + grafts
 *   repo-rename              `repo_id`, `name`                  → display name only
 *   repo-scan                `path`, `max_depth?`               → depth-3 walk, registering the
 *                                                                 finds that are new
 *
 * Every mutation is an existing `DomainAction`, so the delta stream, persistence and the CLI's
 * view of the world stay identical to a change made any other way.
 */

import path from 'node:path';

import type { JsonObject } from '@nex/protocol';

import {
    sanitizedGitName,
    scanForRepos,
    standardizePath,
    worktreeErrorMessage,
    worktreePathFor,
    resolvedWorktreeBasePath,
    type GitService,
    type RepoGitStatus
} from '../git/index.js';
import { canonicalizeUserPath } from '../graft/index.js';
import { canonicalizeForClient } from './paths.js';
import { workspaceByID } from '../store/derived.js';
import type { DaemonState, DomainAction, DomainEvent, Repo, RepoAssociation } from '../store/types.js';
import type { DomainStore } from '../seams.js';

export type RepoCommandStore = DomainStore<DaemonState, DomainAction, DomainEvent>;

export const REPO_COMMANDS = [
    'repo-registry',
    'workspace-repo-status',
    'add-repo-association',
    'remove-repo-association',
    'workspace-add-worktree',
    // Settings ▸ Repositories (graft-git.md §GIT-065…§GIT-072, settings §SET-052…§SET-057):
    // the registry's own add / remove / rename / scan, which the inspector verbs above
    // deliberately do not cover — they associate a repo with a workspace, this family edits
    // the global registry those associations point into.
    'repo-add',
    'repo-remove',
    'repo-rename',
    'repo-scan'
] as const;
export type RepoCommand = (typeof REPO_COMMANDS)[number];

export function isRepoCommand(command: string): command is RepoCommand {
    return (REPO_COMMANDS as readonly string[]).includes(command);
}

/** The slice of `GitService` these verbs need — the rest is not this module's business. */
export type RepoCommandGit = Pick<
    GitService,
    'resolveRepoRoot' | 'getCurrentBranch' | 'getStatus' | 'worktreeAdd' | 'removeWorktree' | 'getRemoteURL'
>;

/**
 * The association watcher's read side (`graft/associations.ts`). Absent = every status reads
 * `unknown`, which is exactly what the badge shows before the first read lands anyway.
 */
export interface RepoStatusReader {
    statusFor(associationID: string): RepoGitStatus;
    refresh(associationID: string): Promise<void>;
}

export interface RepoChannel {
    readonly store: RepoCommandStore;
    readonly git: RepoCommandGit;
    /** Settings `worktreeBasePath` template (`~/nex/worktrees/<repo>`). */
    readonly worktreeBasePath: string;
    readonly uuid: () => string;
    /** Epoch **milliseconds** (the store stores repo `lastAccessedAt` in seconds). */
    readonly now: () => number;
    readonly status?: RepoStatusReader | undefined;
    /** Debounced full-state save; a registry/association change must survive a restart. */
    readonly persist?: (() => void) | undefined;
}

function failure(error: string): JsonObject {
    return { ok: false, error };
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** `RepoGitStatus` → the wire object the inspector's dot + diff stats read. */
export function serializeGitStatus(status: RepoGitStatus): JsonObject {
    if (status.kind === 'dirty') {
        return {
            kind: 'dirty',
            changed_files: status.changedFiles,
            additions: status.additions,
            deletions: status.deletions
        };
    }
    return { kind: status.kind, changed_files: 0, additions: 0, deletions: 0 };
}

function serializeRepo(repo: Repo, home: string, template: string): JsonObject {
    return {
        id: repo.id,
        name: repo.name,
        path: repo.path,
        remote_url: repo.remoteURL,
        is_auto_discovered: repo.isAutoDiscovered,
        // The client cannot expand this itself: `homeDirectory` is stripped from the mirror
        // (a remote client's `~` is not the daemon host's), and `<repo>` is a daemon template.
        worktree_base: resolvedWorktreeBasePath(template, repo.path, home)
    };
}

export function serializeAssociation(
    association: RepoAssociation,
    repo: Repo | undefined,
    home: string,
    status: RepoGitStatus
): JsonObject {
    const repoPath = repo === undefined ? null : standardizePath(repo.path, home);
    const associationPath = standardizePath(association.worktreePath, home);
    return {
        id: association.id,
        repo_id: association.repoID,
        repo_name: repo?.name ?? path.basename(association.worktreePath),
        repo_path: repo?.path ?? null,
        worktree_path: association.worktreePath,
        /**
         * §APP-071 / §GIT-092 (ledger **N5**): the same root with symlinks resolved.
         *
         * The status footer matches a PANE's cwd against this rather than against
         * `worktree_path`, because the two are produced by different subsystems — git answers
         * with the physical path (`rev-parse --show-toplevel` → `/private/var/…`) while a pane
         * carries the logical one it was spawned with (`/var/…`) — and under a symlinked
         * ancestor (`/tmp`, `/var`, a symlinked `$HOME`) the raw strings never meet. `''` =
         * unresolvable; the client falls back to `worktree_path`.
         */
        worktree_path_real: canonicalizeForClient(association.worktreePath),
        branch: association.branchName,
        is_auto_detected: association.isAutoDetected,
        // The inspector groups by repo and renders the MAIN checkout first, worktrees indented
        // under it (WS-139): "main" is the association whose path IS the registered repo.
        is_worktree: repoPath === null ? true : associationPath !== repoPath,
        status: serializeGitStatus(status)
    };
}

/**
 * The identity a registry lookup compares on: standardized AND symlink-resolved.
 *
 * `git rev-parse` always answers with the real path (`/private/var/…` on macOS), while a path
 * the user typed, dropped or scanned is usually the symlinked one (`/var/…`). Comparing the
 * raw strings registers the same repository twice — one row from Add/Scan and another from the
 * association flow — and then a Remove only cascades one of them. The Swift app has the same
 * latent split; this is the port fixing it rather than reproducing it.
 */
function repoKey(value: string, home: string): string {
    return canonicalizeUserPath(value, home);
}

function findRepoByPath(state: DaemonState, value: string): Repo | undefined {
    const home = state.homeDirectory;
    const key = repoKey(value, home);
    return state.repos.find((repo) => repoKey(repo.path, home) === key);
}

function statusOf(channel: RepoChannel, associationID: string): RepoGitStatus {
    return channel.status?.statusFor(associationID) ?? { kind: 'unknown' };
}

async function handleRegistry(channel: RepoChannel): Promise<JsonObject> {
    const state = channel.store.getState();
    return {
        ok: true,
        repos: state.repos.map((repo) => serializeRepo(repo, state.homeDirectory, channel.worktreeBasePath))
    };
}

async function handleStatus(channel: RepoChannel, payload: Record<string, unknown>): Promise<JsonObject> {
    const workspaceID = text(payload['workspace_id']);
    if (workspaceID === undefined) return failure('workspace-repo-status requires workspace_id');
    const state = channel.store.getState();
    const workspace = workspaceByID(state, workspaceID);
    if (workspace === null) return failure(`no workspace matches '${workspaceID}'`);

    // `refresh` re-reads branch + dirtiness for this workspace's associations before replying —
    // what the inspector asks for when it opens or when a HEAD moved. Without it the reply is
    // the watcher's last known values, which is the cheap path the 30 s poll already keeps warm.
    if (payload['refresh'] === true && channel.status !== undefined) {
        const reader = channel.status;
        await Promise.all(
            workspace.repoAssociations.map(async (association) => {
                try {
                    await reader.refresh(association.id);
                } catch {
                    // A git failure leaves the last known status; the dot goes gray at worst.
                }
            })
        );
    }

    // Re-read: `refresh` dispatches a branch change, and the reply must show the NEW branch.
    const after = workspaceByID(channel.store.getState(), workspaceID) ?? workspace;
    const repos = new Map(channel.store.getState().repos.map((repo) => [repo.id, repo]));
    return {
        ok: true,
        workspace_id: workspaceID,
        associations: after.repoAssociations.map((association) =>
            serializeAssociation(
                association,
                repos.get(association.repoID),
                state.homeDirectory,
                statusOf(channel, association.id)
            )
        )
    };
}

/**
 * Register `repoPath` if the registry does not have it yet, and answer with its id. The remote
 * URL is read best-effort (a repo without an `origin` is normal), and a repo reached through
 * this gesture is a DELIBERATE one, so it is never marked auto-discovered.
 */
async function ensureRepo(channel: RepoChannel, repoPath: string): Promise<string> {
    const state = channel.store.getState();
    const home = state.homeDirectory;
    const standardized = standardizePath(repoPath, home);
    const existing = findRepoByPath(state, standardized);
    if (existing !== undefined) return existing.id;
    let remoteURL: string | null = null;
    try {
        remoteURL = await channel.git.getRemoteURL(standardized);
    } catch {
        remoteURL = null;
    }
    const id = channel.uuid();
    channel.store.dispatch({
        type: 'add-repo',
        repo: {
            id,
            path: standardized,
            name: path.basename(standardized),
            remoteURL,
            lastAccessedAt: channel.now() / 1000,
            isAutoDiscovered: false
        }
    });
    return id;
}

async function handleAddAssociation(
    channel: RepoChannel,
    payload: Record<string, unknown>
): Promise<JsonObject> {
    const workspaceID = text(payload['workspace_id']);
    if (workspaceID === undefined) return failure('add-repo-association requires workspace_id');
    const rawPath = text(payload['path']);
    if (rawPath === undefined) return failure('add-repo-association requires path');
    const state = channel.store.getState();
    if (workspaceByID(state, workspaceID) === null) return failure(`no workspace matches '${workspaceID}'`);

    const candidate = standardizePath(rawPath, state.homeDirectory);
    let root: { worktreeRoot: string; parentRepoRoot: string } | null;
    try {
        root = await channel.git.resolveRepoRoot(candidate);
    } catch {
        root = null;
    }
    if (root === null) return failure(`${candidate} is not inside a git repository`);

    // A path inside a linked worktree associates the WORKTREE and registers its PARENT repo —
    // the same shape `workspace-create --worktree` produces, so the inspector groups them the
    // same way (WS-139) and graft can still find the parent root.
    const repoID = await ensureRepo(channel, root.parentRepoRoot);
    const workspace = workspaceByID(channel.store.getState(), workspaceID);
    if (workspace === null) return failure(`no workspace matches '${workspaceID}'`);
    const duplicate = workspace.repoAssociations.find(
        (association) =>
            standardizePath(association.worktreePath, state.homeDirectory) === root.worktreeRoot
    );
    if (duplicate !== undefined) {
        return failure(`${root.worktreeRoot} is already associated with this workspace`);
    }

    let branch: string | null = null;
    try {
        branch = await channel.git.getCurrentBranch(root.worktreeRoot);
    } catch {
        branch = null;
    }
    const association: RepoAssociation = {
        id: channel.uuid(),
        repoID,
        worktreePath: root.worktreeRoot,
        branchName: branch,
        isAutoDetected: false
    };
    channel.store.dispatch({ type: 'add-repo-association', workspaceID, association });
    channel.persist?.();
    const repo = channel.store.getState().repos.find((entry) => entry.id === repoID);
    return {
        ok: true,
        workspace_id: workspaceID,
        association: serializeAssociation(association, repo, state.homeDirectory, statusOf(channel, association.id))
    };
}

async function handleRemoveAssociation(
    channel: RepoChannel,
    payload: Record<string, unknown>
): Promise<JsonObject> {
    const workspaceID = text(payload['workspace_id']);
    if (workspaceID === undefined) return failure('remove-repo-association requires workspace_id');
    const associationID = text(payload['association_id']);
    if (associationID === undefined) return failure('remove-repo-association requires association_id');
    const state = channel.store.getState();
    const workspace = workspaceByID(state, workspaceID);
    if (workspace === null) return failure(`no workspace matches '${workspaceID}'`);
    const association = workspace.repoAssociations.find((entry) => entry.id === associationID);
    if (association === undefined) return failure(`no repo association matches '${associationID}'`);

    // "Remove & Delete Worktree" (WS-142). NON-forcing, like `workspace delete --prune-worktree`:
    // git refuses a dirty or locked worktree, and that refusal is reported rather than forced.
    let worktreeError: string | undefined;
    if (payload['delete_worktree'] === true) {
        const repo = state.repos.find((entry) => entry.id === association.repoID);
        if (repo === undefined) {
            worktreeError = 'the parent repository is no longer registered';
        } else if (
            standardizePath(repo.path, state.homeDirectory) ===
            standardizePath(association.worktreePath, state.homeDirectory)
        ) {
            worktreeError = 'that association is the main checkout, not a worktree';
        } else {
            try {
                await channel.git.removeWorktree(repo.path, association.worktreePath);
            } catch (error) {
                worktreeError = worktreeErrorMessage(error);
            }
        }
        // A worktree git would not delete stays associated: dropping the row would strand the
        // directory with nothing in the window pointing at it.
        if (worktreeError !== undefined) {
            return { ...failure(worktreeError), workspace_id: workspaceID, association_id: associationID };
        }
    }

    channel.store.dispatch({ type: 'remove-repo-association', workspaceID, associationID });
    channel.persist?.();
    return {
        ok: true,
        workspace_id: workspaceID,
        association_id: associationID,
        worktree_path: association.worktreePath,
        worktree_deleted: payload['delete_worktree'] === true
    };
}

async function handleAddWorktree(channel: RepoChannel, payload: Record<string, unknown>): Promise<JsonObject> {
    const workspaceID = text(payload['workspace_id']);
    if (workspaceID === undefined) return failure('workspace-add-worktree requires workspace_id');
    const state = channel.store.getState();
    const workspace = workspaceByID(state, workspaceID);
    if (workspace === null) return failure(`no workspace matches '${workspaceID}'`);

    const repoID = text(payload['repo_id']);
    const repoPathRaw = text(payload['repo_path']);
    const registered = repoID === undefined ? undefined : state.repos.find((repo) => repo.id === repoID);
    if (repoID !== undefined && registered === undefined) return failure(`no repo matches '${repoID}'`);
    const repoPath =
        registered !== undefined
            ? standardizePath(registered.path, state.homeDirectory)
            : repoPathRaw === undefined
              ? undefined
              : standardizePath(repoPathRaw, state.homeDirectory);
    if (repoPath === undefined) return failure('workspace-add-worktree requires repo_id or repo_path');

    const requestedName = text(payload['name']) ?? '';
    const folderName = sanitizedGitName(requestedName);
    if (folderName === null) return failure(`"${requestedName}" isn't a usable worktree name`);
    const requestedBranch = text(payload['branch']) ?? requestedName;
    const safeBranch = sanitizedGitName(requestedBranch);
    if (safeBranch === null) return failure(`"${requestedBranch}" isn't a usable branch name`);

    const worktreePath = worktreePathFor({
        template: channel.worktreeBasePath,
        repoPath,
        home: state.homeDirectory,
        folderName
    });

    try {
        await channel.git.worktreeAdd({
            repoPath,
            worktreePath,
            branchName: safeBranch,
            updateMain: payload['update_main'] === true
        });
    } catch (error) {
        return failure(worktreeErrorMessage(error));
    }

    // §4.1 step 7 / GIT-103: the create promotes the repo out of auto-discovered status by
    // registering it deliberately, then appends the association carrying the new branch.
    const resolvedRepoID = await ensureRepo(channel, repoPath);
    const association: RepoAssociation = {
        id: channel.uuid(),
        repoID: resolvedRepoID,
        worktreePath,
        branchName: safeBranch,
        isAutoDetected: false
    };
    if (workspaceByID(channel.store.getState(), workspaceID) === null) {
        return failure(`no workspace matches '${workspaceID}'`);
    }
    channel.store.dispatch({ type: 'add-repo-association', workspaceID, association });
    channel.persist?.();
    const repo = channel.store.getState().repos.find((entry) => entry.id === resolvedRepoID);
    return {
        ok: true,
        workspace_id: workspaceID,
        repo_id: resolvedRepoID,
        worktree_path: worktreePath,
        branch: safeBranch,
        association: serializeAssociation(association, repo, state.homeDirectory, statusOf(channel, association.id))
    };
}

// ── Settings ▸ Repositories: the registry itself ────────────────────────────────────

/**
 * §GIT-068 / §SET-054's `addRepo(path:name:)`.
 *
 * Three outcomes, all of them the Swift reducer's (`AppReducer+RepoGit.swift:48-70`):
 *   - already registered and AUTO-discovered → **promoted** to manual so the auto-unlink GC
 *     can never collect it, and persisted;
 *   - already registered and manual → a no-op that still answers `ok` with the existing row
 *     (adding what you already have is not an error);
 *   - new → registered with `name ?? basename(path)` and its `origin` URL (§GIT-069).
 *
 * Deliberately permissive about whether the path IS a checkout, exactly like the shipped
 * `NSOpenPanel` flow: the panel can pick any directory, and the row is honest about being
 * remote-less. The association verbs above are the ones that must resolve a repo root.
 */
async function handleRepoAdd(channel: RepoChannel, payload: Record<string, unknown>): Promise<JsonObject> {
    const rawPath = text(payload['path']);
    if (rawPath === undefined) return failure('repo-add requires path');
    const state = channel.store.getState();
    const home = state.homeDirectory;
    const standardized = standardizePath(rawPath, home);
    const existing = findRepoByPath(state, standardized);
    if (existing !== undefined) {
        const promoted = existing.isAutoDiscovered;
        if (promoted) {
            channel.store.dispatch({
                type: 'set-repo-auto-discovered',
                id: existing.id,
                isAutoDiscovered: false
            });
            channel.persist?.();
        }
        const after = channel.store.getState();
        const row = after.repos.find((repo) => repo.id === existing.id) ?? existing;
        return {
            ok: true,
            repo_id: existing.id,
            promoted,
            already_registered: true,
            repo: serializeRepo(row, home, channel.worktreeBasePath)
        };
    }

    let remoteURL: string | null = null;
    try {
        remoteURL = await channel.git.getRemoteURL(standardized);
    } catch {
        remoteURL = null;
    }
    const id = channel.uuid();
    const repo: Repo = {
        id,
        path: standardized,
        name: text(payload['name']) ?? path.basename(standardized),
        remoteURL,
        lastAccessedAt: channel.now() / 1000,
        isAutoDiscovered: false
    };
    channel.store.dispatch({ type: 'add-repo', repo });
    channel.persist?.();
    return {
        ok: true,
        repo_id: id,
        promoted: false,
        already_registered: false,
        repo: serializeRepo(repo, home, channel.worktreeBasePath)
    };
}

/**
 * §GIT-052 / §GIT-071's "Remove". The reducer drops the repo AND every association pointing at
 * it from every workspace; the store's association reconciler then stops each vanished row's
 * HEAD watcher and force-stops its graft session, which is the cascade §GIT-052 describes.
 */
async function handleRepoRemove(channel: RepoChannel, payload: Record<string, unknown>): Promise<JsonObject> {
    const repoID = text(payload['repo_id']);
    if (repoID === undefined) return failure('repo-remove requires repo_id');
    const state = channel.store.getState();
    const repo = state.repos.find((entry) => entry.id === repoID);
    if (repo === undefined) return failure(`no repo matches '${repoID}'`);
    const removedAssociations = state.workspaces.flatMap((workspace) =>
        workspace.repoAssociations.filter((association) => association.repoID === repoID).map((a) => a.id)
    );
    channel.store.dispatch({ type: 'remove-repo', id: repoID });
    channel.persist?.();
    return {
        ok: true,
        repo_id: repoID,
        name: repo.name,
        path: repo.path,
        removed_associations: removedAssociations
    };
}

/** §GIT-072: rename the registry's display name (the path is identity and never moves). */
async function handleRepoRename(channel: RepoChannel, payload: Record<string, unknown>): Promise<JsonObject> {
    const repoID = text(payload['repo_id']);
    if (repoID === undefined) return failure('repo-rename requires repo_id');
    const name = text(payload['name']);
    if (name === undefined) return failure('repo-rename requires name');
    const state = channel.store.getState();
    if (!state.repos.some((entry) => entry.id === repoID)) return failure(`no repo matches '${repoID}'`);
    channel.store.dispatch({ type: 'rename-repo', id: repoID, name });
    channel.persist?.();
    const after = channel.store.getState();
    const repo = after.repos.find((entry) => entry.id === repoID);
    return {
        ok: true,
        repo_id: repoID,
        ...(repo === undefined
            ? {}
            : { repo: serializeRepo(repo, after.homeDirectory, channel.worktreeBasePath) })
    };
}

/**
 * §SET-053 / §GIT-066 / §GIT-067's "Scan Directory": walk `path` to depth 3, then register
 * every find whose path is not in the registry yet. Already-registered finds are reported as
 * `skipped` rather than silently dropped, so the UI can say "nothing new here" honestly.
 *
 * The remote URL of each new row is read the same best-effort way `repo-add` reads it; a scan
 * of twenty repos is twenty cheap `git remote get-url` spawns, run in parallel.
 */
async function handleRepoScan(channel: RepoChannel, payload: Record<string, unknown>): Promise<JsonObject> {
    const rawPath = text(payload['path']);
    if (rawPath === undefined) return failure('repo-scan requires path');
    const state = channel.store.getState();
    const home = state.homeDirectory;
    const root = standardizePath(rawPath, home);
    const depth = payload['max_depth'];
    let found: readonly { path: string; name: string }[];
    try {
        found = scanForRepos(root, {
            ...(typeof depth === 'number' && Number.isFinite(depth) ? { maxDepth: depth } : {})
        });
    } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
    }

    const known = new Set(channel.store.getState().repos.map((repo) => repoKey(repo.path, home)));
    const added: JsonObject[] = [];
    const skipped: string[] = [];
    for (const candidate of found) {
        const candidatePath = standardizePath(candidate.path, home);
        if (known.has(repoKey(candidatePath, home))) {
            skipped.push(candidatePath);
            continue;
        }
        known.add(repoKey(candidatePath, home));
        let remoteURL: string | null = null;
        try {
            remoteURL = await channel.git.getRemoteURL(candidatePath);
        } catch {
            remoteURL = null;
        }
        const repo: Repo = {
            id: channel.uuid(),
            path: candidatePath,
            name: candidate.name,
            remoteURL,
            lastAccessedAt: channel.now() / 1000,
            isAutoDiscovered: false
        };
        channel.store.dispatch({ type: 'add-repo', repo });
        added.push(serializeRepo(repo, home, channel.worktreeBasePath));
    }
    if (added.length > 0) channel.persist?.();
    return {
        ok: true,
        root,
        scanned: found.length,
        added,
        skipped
    };
}

/** Route one repo verb. Rejections never escape: a thrown git error becomes `{ok:false}`. */
export async function handleRepoCommand(
    channel: RepoChannel,
    command: RepoCommand,
    payload: Record<string, unknown>
): Promise<JsonObject> {
    switch (command) {
        case 'repo-registry':
            return await handleRegistry(channel);
        case 'workspace-repo-status':
            return await handleStatus(channel, payload);
        case 'add-repo-association':
            return await handleAddAssociation(channel, payload);
        case 'remove-repo-association':
            return await handleRemoveAssociation(channel, payload);
        case 'workspace-add-worktree':
            return await handleAddWorktree(channel, payload);
        case 'repo-add':
            return await handleRepoAdd(channel, payload);
        case 'repo-remove':
            return await handleRepoRemove(channel, payload);
        case 'repo-rename':
            return await handleRepoRename(channel, payload);
        case 'repo-scan':
            return await handleRepoScan(channel, payload);
    }
}
