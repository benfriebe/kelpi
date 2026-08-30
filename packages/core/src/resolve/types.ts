/**
 * The minimal readonly projection of daemon state the resolvers need.
 * Spec: docs/current/socket-handlers.md §2, docs/current/app-state-core.md §15.
 *
 * Panes are a flat list keyed by `workspaceID`; per-workspace pane order is the order
 * of that filtered list (it only affects which pane wins a 1-candidate label lookup).
 */

export interface ResolvableWorkspace {
    readonly id: string;
    readonly name: string;
    /** `makeSlug(name, id)` - the lenient resolver's third lookup key. */
    readonly slug: string;
}

export interface ResolvablePane {
    readonly id: string;
    /** `--target` label; null when the pane was never named. */
    readonly label: string | null;
    readonly workspaceID: string;
    /**
     * Parked panes (`kelpi open --here` sources) keep live PTYs but are NOT
     * user-addressable: every user-command resolver skips them, only
     * `workspaceContainingPane` (lifecycle routing) sees them.
     */
    readonly parked?: boolean;
}

export interface ResolvableGroup {
    readonly id: string;
    readonly name: string;
}

export interface ResolveState {
    readonly workspaces: readonly ResolvableWorkspace[];
    readonly panes: readonly ResolvablePane[];
    readonly groups: readonly ResolvableGroup[];
}

export type WorkspaceScope = Pick<ResolveState, 'workspaces'>;
export type GroupScope = Pick<ResolveState, 'groups'>;
export type PaneScope = Pick<ResolveState, 'workspaces' | 'panes'>;
