/**
 * The phone's New workspace: where it goes, which repository it starts in, and the worktree it
 * makes, as plain data the sheet (`PhoneNewWorkspaceSheet.tsx`) edits and one create sends.
 *
 * **An owner-directed divergence from the shipped Swift app**, like every phone rule in this
 * program (there is no Swift phone UI; `chrome/form-factor.ts` says so once for all of it).
 *
 * The desktop's sheet (`chrome/NewWorkspaceSheet.tsx`) is the model for every rule here: a group
 * or a parent to put the workspace in (app-state-core.md §2.9: a nested workspace follows its
 * parent, so it has no group of its own), the group's default repository and worktree switch as
 * the prefill (§5.5, `groupSheetDefaults`), and the worktree and branch names following the
 * workspace name until typed over. What the phone leaves out is what a thumb does not need on the
 * way to a shell: the colour (the daemon assigns one), the profile, mute, and more than one
 * repository. A workspace can take more repositories from the Mac's inspector afterwards.
 *
 * The create goes to the host the sheet was opened on, over that host's own connection: a phone
 * looking at a remote host's workspace makes the new one THERE, beside it, with that host's groups,
 * workspaces and registry.
 */

import type { WorkspaceState } from '@kelpi/daemon/store';

import { groupSheetDefaults, type GroupSheetDefaults } from '../chrome/NewWorkspaceSheet';
import type { ChromeGroup, ChromeRepo, WorktreeCreateProgress } from '../chrome/types';
import { parseWorktreeProgress } from '../chrome/worktree';
import { isOkReply, replyError, replyText, type CommandClient, type CommandReply } from '../connection';
import type { SidebarEntry } from '../state';

/** Where the new workspace goes: top level, a group, or nested under a workspace (§2.9). */
export type PhonePlacement =
    | { readonly kind: 'top' }
    | { readonly kind: 'group'; readonly groupID: string }
    | { readonly kind: 'parent'; readonly workspaceID: string };

export const TOP_PLACEMENT: PhonePlacement = { kind: 'top' };

/** One `<select>` value per placement, so the picker is a single native control. */
export function placementValue(placement: PhonePlacement): string {
    if (placement.kind === 'group') return `group:${placement.groupID}`;
    if (placement.kind === 'parent') return `parent:${placement.workspaceID}`;
    return 'top';
}

export function parsePlacementValue(value: string): PhonePlacement {
    if (value.startsWith('group:')) return { kind: 'group', groupID: value.slice('group:'.length) };
    if (value.startsWith('parent:')) return { kind: 'parent', workspaceID: value.slice('parent:'.length) };
    return TOP_PLACEMENT;
}

export interface PhoneParentOption {
    readonly id: string;
    readonly name: string;
    /** The group the parent sits in, which a child created under it takes its defaults from. */
    readonly groupID: string | null;
    readonly groupName: string | null;
}

export interface PhonePlacementOptions {
    readonly groups: readonly ChromeGroup[];
    /** In sidebar order. Only a workspace that is not itself nested can take children (§2.9). */
    readonly parents: readonly PhoneParentOption[];
}

/**
 * Every group and every workspace that can be a parent, read off the host's sidebar entries. A
 * nested workspace lives only in its parent's `nested` map, never in an entry's own list, so
 * walking the lists is exactly "every workspace without a parent".
 */
export function placementOptions(entries: readonly SidebarEntry[]): PhonePlacementOptions {
    const groups: ChromeGroup[] = [];
    const parents: PhoneParentOption[] = [];
    const parent = (workspace: WorkspaceState, groupID: string | null, groupName: string | null): PhoneParentOption => ({
        id: workspace.id,
        name: workspace.name,
        groupID,
        groupName
    });
    for (const entry of entries) {
        if (entry.kind === 'workspace') {
            parents.push(parent(entry.workspace, null, null));
            continue;
        }
        groups.push(entry.group);
        for (const workspace of entry.workspaces) parents.push(parent(workspace, entry.group.id, entry.group.name));
    }
    return { groups, parents };
}

/**
 * The group whose defaults a placement takes (§5.5): the group itself, a parent's group for a
 * nested create, none at top level. A placement naming something gone reads as top level.
 */
export function placementGroupID(placement: PhonePlacement, options: PhonePlacementOptions): string | null {
    if (placement.kind === 'group') return options.groups.some((group) => group.id === placement.groupID) ? placement.groupID : null;
    if (placement.kind === 'parent') return options.parents.find((candidate) => candidate.id === placement.workspaceID)?.groupID ?? null;
    return null;
}

/** §5.5's prefill for a placement: the repository, and whether a worktree off latest main is ticked. */
export function placementDefaults(
    placement: PhonePlacement,
    options: PhonePlacementOptions,
    repos: readonly ChromeRepo[]
): GroupSheetDefaults {
    return groupSheetDefaults(placementGroupID(placement, options), options.groups, repos);
}

/** Everything the sheet submits. */
export interface PhoneNewWorkspaceDraft {
    readonly name: string;
    readonly placement: PhonePlacement;
    /** The one repository the workspace starts in, or null for none. */
    readonly repo: ChromeRepo | null;
    /** Set only with a repo: make a worktree of it, on this branch, for the workspace. */
    readonly worktree: { readonly name: string; readonly branch: string; readonly updateMain: boolean } | null;
}

export type PhoneCreateCommands = Pick<CommandClient, 'createWorkspace' | 'addRepoAssociation'>;

export type PhoneCreateResult = { readonly ok: true; readonly workspaceID: string } | { readonly ok: false; readonly error: string };

/**
 * The `workspace-create` input for a draft. `groupDefaults: false` because the sheet has already
 * shown the group's repository and worktree switch, so what it sends is the person's final choice,
 * "no repository" included (the desktop sheet sends the same).
 *
 * `focus` is the host's to decide: the origin is the daemon this page belongs to, so a create there
 * switches to it as every create from a window does. A REMOTE host's active workspace is what that
 * Mac's own window shows, and a phone looking in should not move it; the phone switches its own
 * view instead.
 */
export function phoneCreateInput(draft: PhoneNewWorkspaceDraft, focus: boolean): Parameters<CommandClient['createWorkspace']>[0] {
    const name = draft.name.trim();
    const placement = draft.placement;
    return {
        ...(name.length > 0 ? { name } : {}),
        ...(placement.kind === 'group' ? { group: placement.groupID } : {}),
        ...(placement.kind === 'parent' ? { parent: placement.workspaceID } : {}),
        ...(draft.repo === null
            ? {}
            : draft.worktree === null
              ? // Issue #38: one repository is where the first shell belongs.
                { path: draft.repo.path }
              : {
                    repo: draft.repo.path,
                    worktree: draft.worktree.name,
                    branch: draft.worktree.branch,
                    updateMain: draft.worktree.updateMain
                }),
        groupDefaults: false,
        focus
    };
}

/**
 * Send the create, then (for a plain repository, which the create verb does not carry) associate
 * the repository with the new workspace, the same `add-repo-association` the desktop sheet sends.
 * A worktree create associates its own worktree daemon-side.
 */
export async function createPhoneWorkspace(
    commands: PhoneCreateCommands,
    draft: PhoneNewWorkspaceDraft,
    options: { readonly focus: boolean; readonly onProgress?: ((progress: WorktreeCreateProgress) => void) | undefined }
): Promise<PhoneCreateResult> {
    const input = phoneCreateInput(draft, options.focus);
    const onProgress = options.onProgress;
    let reply: CommandReply;
    try {
        reply = await (draft.worktree === null || onProgress === undefined
            ? commands.createWorkspace(input)
            : commands.createWorkspace(input, {
                  onProgress: (raw) => {
                      const progress = parseWorktreeProgress(raw);
                      if (progress !== null) onProgress(progress);
                  }
              }));
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!isOkReply(reply)) return { ok: false, error: replyError(reply) };
    const workspaceID = replyText(reply, 'workspace_id');
    if (workspaceID === undefined) return { ok: false, error: 'the host did not say which workspace it created' };
    if (draft.repo !== null && draft.worktree === null) {
        // The workspace exists either way, so a failed association does not fail the create:
        // its shell already opened in the repository, and the inspector can add it again.
        await commands.addRepoAssociation({ workspaceID, path: draft.repo.path }).catch(() => undefined);
    }
    return { ok: true, workspaceID };
}
