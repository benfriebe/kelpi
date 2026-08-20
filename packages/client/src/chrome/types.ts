/**
 * Shared prop shapes for the chrome (sidebar, top bar, footer, palette).
 *
 * Everything here is a **structural subset of the daemon's own types**, taken with `Pick` so a
 * value straight out of the store mirror satisfies it and a test can hand-build the three
 * fields a row actually reads. Nothing in `chrome/` touches the store or a socket: assembly
 * passes state in through props and binds the callbacks to `CommandClient`, which keeps every
 * surface renderable from a fixture and reusable by the Electron shell.
 *
 * Callback naming mirrors the wire verbs (`onMoveWorkspace` ↔ `workspace-move`) so wiring is
 * mechanical. Two callbacks have NO wire verb yet — `onToggleGroupCollapse` and
 * `onRenameWorkspace` — and are documented as such; the sidebar degrades gracefully (collapse
 * falls back to client-local state) until the daemon grows them.
 */

import type { Pane, WorkspaceColor, WorkspaceGroup, WorkspaceState } from '@nex/daemon/store';

/** The pane fields the chrome reads. */
export type ChromePane = Pick<
    Pane,
    | 'id'
    | 'type'
    | 'label'
    | 'title'
    | 'workingDirectory'
    | 'gitBranch'
    | 'status'
    | 'agentSessionID'
    | 'agentKind'
    | 'agentStartedAt'
    | 'backgroundTaskCount'
>;

/** The workspace fields the sidebar/top bar read. */
export type ChromeWorkspace = Pick<WorkspaceState, 'id' | 'name' | 'color' | 'icon' | 'labels'> & {
    readonly panes: readonly ChromePane[];
};

export type ChromeGroup = Pick<WorkspaceGroup, 'id' | 'name' | 'color' | 'icon' | 'isCollapsed'>;

/**
 * One top-level sidebar slot. Structurally identical to `state/selectors.ts`'s `SidebarEntry`,
 * so `selectSidebarEntries(store)` is passed straight in.
 */
export type ChromeSidebarEntry =
    | { readonly kind: 'workspace'; readonly workspace: ChromeWorkspace }
    | {
          readonly kind: 'group';
          readonly group: ChromeGroup;
          readonly workspaces: readonly ChromeWorkspace[];
      };

/** A label preset as the chip renderer needs it (`theme.ts`'s `LabelPresetLike`). */
export interface ChromeLabelPreset {
    readonly name: string;
    readonly color:
        | { readonly kind: 'named'; readonly color: WorkspaceColor }
        | { readonly kind: 'custom'; readonly hex: string };
    readonly textColor?:
        | { readonly kind: 'named'; readonly color: WorkspaceColor }
        | { readonly kind: 'custom'; readonly hex: string }
        | null;
}

/**
 * The daemon's `default` profile baseline (`WorkspaceProfilesClient.defaultProfileName`).
 * Lives here rather than in one surface because BOTH profile pickers lead with it: the
 * inspector's (§WS-138) and the New Workspace form's (§SET-214).
 */
export const DEFAULT_PROFILE_NAME = 'default';

/** The ten palette colors, in menu order (§5.6). */
export const WORKSPACE_COLORS: readonly WorkspaceColor[] = [
    'red',
    'orange',
    'yellow',
    'green',
    'blue',
    'purple',
    'pink',
    'gray',
    'black',
    'white'
];

/** `workspace-move`: `groupID: null` means top level. Index is POST-REMOVE (§5.5). */
export interface WorkspaceMoveRequest {
    readonly workspaceID: string;
    readonly groupID: string | null;
    readonly index: number;
}

/**
 * A multi-row drag: the whole selection lands in ONE commit (§5.5 "consolidated atomically via
 * a bulk move"). It is a separate callback rather than N `onMoveWorkspace`s because those would
 * re-index against each other and scramble the order the user dropped.
 */
export interface WorkspacesMoveRequest {
    readonly workspaceIDs: readonly string[];
    readonly groupID: string | null;
    readonly index: number;
}

/**
 * A repo-registry entry as the chrome renders it. `worktreeBase` is the daemon's RESOLVED base
 * path for this repo (`repo-registry`'s `worktree_base`): `~` and `<repo>` expand against the
 * daemon host's home directory, which the client mirror deliberately does not carry.
 */
export interface ChromeRepo {
    readonly id: string;
    readonly name: string;
    readonly path: string;
    readonly worktreeBase: string;
}

/**
 * The New Workspace form's optional "Create git worktree" section (§WS-078 / §GIT-105). The
 * whole request rides `workspace-create --worktree` — the same wire path the CLI uses — so the
 * sanitization, the branch default and `--update-main` all stay daemon-side.
 */
/**
 * The New Workspace form's non-name fields (§WS-075). They ride together because they are one
 * gesture: the create verb carries the colour, group and profile, and the repo paths become one
 * `add-repo-association` each once the workspace id comes back.
 */
export interface NewWorkspaceExtras {
    readonly color?: WorkspaceColor | undefined;
    /** `null` = the built-in `default` baseline (the daemon's own normalization). */
    readonly profile?: string | null | undefined;
    readonly repoPaths?: readonly string[] | undefined;
}

export interface WorkspaceWorktreeRequest {
    readonly repoID: string;
    readonly name: string;
    readonly branch: string;
    readonly updateMain: boolean;
}

/**
 * A form submission that can FAIL and stay open: the callback answers with the daemon's message
 * (`string`) or `null` when it worked. `void` keeps every older call site working — the form
 * then treats the submit as fire-and-forget and closes immediately.
 */
export type SubmitResult = Promise<string | null> | string | null | void | boolean;

/** Top-level group reorder. No wire verb today — assembly decides how to persist it. */
export interface GroupMoveRequest {
    readonly groupID: string;
    readonly index: number;
}

export interface SidebarCallbacks {
    readonly onActivateWorkspace?: ((workspaceID: string) => void) | undefined;
    /** NO WIRE VERB YET: the sidebar also keeps a client-local collapse so the UI responds. */
    readonly onToggleGroupCollapse?: ((groupID: string, collapsed: boolean) => void) | undefined;
    /** NO WIRE VERB YET (`workspace-rename` does not exist); the inline editor still commits. */
    readonly onRenameWorkspace?: ((workspaceID: string, name: string) => void) | undefined;
    readonly onDeleteWorkspace?: ((workspaceID: string) => void) | undefined;
    readonly onSetWorkspaceColor?: ((workspaceID: string, color: WorkspaceColor) => void) | undefined;
    /** `applied` is the state AFTER the toggle: true = add the label, false = remove it. */
    readonly onToggleWorkspaceLabel?:
        | ((workspaceID: string, label: string, applied: boolean) => void)
        | undefined;
    /** ONE atomic commit per drag (§15 "Live-apply drag model"). */
    readonly onMoveWorkspace?: ((request: WorkspaceMoveRequest) => void) | undefined;
    /**
     * A drag that grabbed a row inside a ≥2 selection. Absent = the sidebar falls back to
     * moving the grabbed row alone, which is strictly better than moving nothing.
     */
    readonly onMoveWorkspaces?: ((request: WorkspacesMoveRequest) => void) | undefined;
    readonly onMoveGroup?: ((request: GroupMoveRequest) => void) | undefined;
    /**
     * "Change Icon" (§5.6). `icon` is the flat DB spelling (`"emoji:🔥"` / `"system:star"`);
     * `null` is "Reset to Letter". The client passes an SF Symbol token straight back through,
     * so a legacy value survives even when this client draws it as the generic glyph.
     */
    readonly onSetWorkspaceIcon?: ((workspaceID: string, icon: string | null) => void) | undefined;
    readonly onSetGroupIcon?: ((groupID: string, icon: string | null) => void) | undefined;
    readonly onRenameGroup?: ((groupID: string, name: string) => void) | undefined;
    readonly onDeleteGroup?: ((groupID: string, cascade: boolean) => void) | undefined;
    /**
     * The New Workspace form. `worktree` is present when its "Create git worktree" section is
     * on (§WS-078); the callback may answer with a message so the form can keep itself open on
     * a failed `git worktree add` and re-enable Create (§WS-079).
     *
     * `extras` is the rest of what the shipped sheet collects (§WS-075/§SET-214): the chosen
     * swatch, the profile (`null` = the built-in `default`), and the repo PATHS to associate
     * once the workspace exists. Every field is optional, so an older two-argument call site
     * keeps working unchanged.
     */
    readonly onCreateWorkspace?:
        | ((
              name: string,
              groupID: string | null,
              worktree?: WorkspaceWorktreeRequest | undefined,
              extras?: NewWorkspaceExtras | undefined
          ) => SubmitResult)
        | undefined;
    /** `color` is the New Group form's swatch; `null`/absent is its "None" option (§WS-082). */
    readonly onCreateGroup?: ((name: string, color?: WorkspaceColor | null | undefined) => void) | undefined;

    // ── bulk operations (§5.6's multi-select menu variant, §WS-055…§WS-060) ─────────
    //
    // Each is ONE command for the whole selection: N single-workspace commands would land as N
    // deltas the sidebar animates one at a time, and a partial failure would leave the
    // selection half-changed.

    readonly onSetBulkColor?: ((workspaceIDs: readonly string[], color: WorkspaceColor) => void) | undefined;
    /** `apply` is the state EVERY selected workspace ends at (the tri-state menu's decision). */
    readonly onSetBulkLabel?:
        | ((workspaceIDs: readonly string[], label: string, apply: boolean) => void)
        | undefined;
    /** "Group N Workspaces…": create the group with the selection already inside it. */
    readonly onCreateGroupForWorkspaces?:
        | ((name: string, workspaceIDs: readonly string[], color?: WorkspaceColor | null | undefined) => void)
        | undefined;
    /** "Delete N Workspaces…", after ONE confirmation. Absent = falls back to N single deletes. */
    readonly onDeleteWorkspaces?: ((workspaceIDs: readonly string[]) => void) | undefined;
}
