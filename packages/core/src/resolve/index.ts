/** Public surface of the resolver module (WP1.4). */

export {
    idsEqual,
    isUUIDToken,
    makeSlug,
    normalizeLabel,
    normalizeUUIDToken,
    MAX_LABEL_LENGTH
} from './ids.js';
export type {
    GroupScope,
    PaneScope,
    ResolvableGroup,
    ResolvablePane,
    ResolvableWorkspace,
    ResolveState,
    WorkspaceScope
} from './types.js';
export {
    groupsMatchingName,
    resolveGroupMember,
    resolveGroupStrict,
    resolveWorkspaceLenient,
    resolveWorkspaceStrict,
    workspacesMatchingName
} from './workspace.js';
export {
    resolvePaneInWorkspace,
    resolvePaneTarget,
    visiblePanesOfWorkspace,
    workspaceContainingPane,
    workspaceContainingVisiblePane
} from './pane-target.js';
export type { PaneTargetRequest, PaneTargetResolution } from './pane-target.js';
