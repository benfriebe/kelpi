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
    readonly onMoveGroup?: ((request: GroupMoveRequest) => void) | undefined;
    readonly onRenameGroup?: ((groupID: string, name: string) => void) | undefined;
    readonly onDeleteGroup?: ((groupID: string, cascade: boolean) => void) | undefined;
    readonly onCreateWorkspace?: ((name: string, groupID: string | null) => void) | undefined;
    readonly onCreateGroup?: ((name: string) => void) | undefined;
}
