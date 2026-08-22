/**
 * The root reducer: pure `(state, action) => state`, routed to one family reducer per action.
 *
 * The `satisfies Record<DomainActionType, ActionFamily>` on the routing table is the exhaustive
 * check: adding an action to the union without routing it is a compile error.
 */

import type { DaemonState, DomainAction, DomainActionType } from '../types.js';
import { reduceAgentAction } from './agent.js';
import { reduceGroupAction } from './groups.js';
import { reduceLayoutAction } from './layout.js';
import { reducePaneAction } from './panes.js';
import { reduceWebAction } from './web.js';
import { reduceWorkspaceAction } from './workspaces.js';

type ActionFamily = 'root' | 'workspace' | 'group' | 'pane' | 'layout' | 'agent' | 'web';

const ROUTES = {
    'replace-state': 'root',

    'create-workspace': 'workspace',
    'delete-workspace': 'workspace',
    'delete-workspaces': 'workspace',
    'rename-workspace': 'workspace',
    'set-workspace-color': 'workspace',
    'set-workspace-icon': 'workspace',
    'set-workspace-profile': 'workspace',
    'workspace-labels': 'workspace',
    'set-active-workspace': 'workspace',
    'move-workspace': 'workspace',
    'move-workspace-to-group': 'workspace',
    'move-workspaces-to-group': 'workspace',
    'set-bulk-color': 'workspace',
    'set-bulk-label': 'workspace',
    'add-label-preset': 'workspace',
    'update-label-preset': 'workspace',
    'set-label-preset-text-color': 'workspace',
    'remove-label-preset': 'workspace',
    'move-label-preset': 'workspace',
    'set-label-presets': 'workspace',
    'set-label-presets-migrated': 'workspace',
    'add-repo': 'workspace',
    'remove-repo': 'workspace',
    'rename-repo': 'workspace',
    'set-repo-remote-url': 'workspace',
    'set-repo-auto-discovered': 'workspace',
    'add-repo-association': 'workspace',
    'remove-repo-association': 'workspace',
    'set-repo-association-branch': 'workspace',

    'create-group': 'group',
    'rename-group': 'group',
    'set-group-color': 'group',
    'set-group-icon': 'group',
    'toggle-group-collapse': 'group',
    'set-group-collapsed': 'group',
    'delete-group': 'group',
    'move-group': 'group',
    'reorder-group': 'group',
    'sort-group': 'group',

    'create-pane': 'pane',
    'split-pane': 'pane',
    'split-pane-at-path': 'pane',
    'close-pane': 'pane',
    'set-pane-label': 'pane',
    'park-pane': 'pane',
    'unpark-pane': 'pane',
    'move-pane-adjacent': 'pane',
    'move-pane-direction': 'pane',
    'move-pane-to-workspace': 'pane',
    'resize-pane': 'pane',
    'update-split-ratio': 'pane',
    'reopen-closed-pane': 'pane',
    'pane-process-terminated': 'pane',
    'open-markdown-pane': 'pane',
    'open-diff-pane': 'pane',
    'create-scratchpad': 'pane',
    'open-web-pane': 'pane',
    'web-tab-open': 'web',
    'web-tab-close': 'web',
    'web-tab-select': 'web',
    'web-tab-reorder': 'web',
    'web-navigate': 'web',
    'web-set-private': 'web',
    'web-tab-state': 'web',
    'scratchpad-content-changed': 'pane',
    'set-markdown-editing': 'pane',
    'set-markdown-font-size': 'pane',

    'cycle-layout': 'layout',
    'select-layout': 'layout',
    'toggle-zoom': 'layout',
    'focus-pane': 'layout',
    'focus-next-pane': 'layout',
    'focus-previous-pane': 'layout',
    'toggle-search': 'layout',
    'close-search': 'layout',
    'set-search-needle': 'layout',
    'set-search-counts': 'layout',

    'pane-agent-event': 'agent',
    'pane-title-changed': 'agent',
    'pane-directory-changed': 'agent',
    'pane-branch-changed': 'agent',
    'toggle-sync-input': 'agent',
    'set-sync-input-active': 'agent',
    'set-sync-input-excluded': 'agent'
} as const satisfies Record<DomainActionType, ActionFamily>;

export function reduce(state: DaemonState, action: DomainAction): DaemonState {
    switch (ROUTES[action.type] as ActionFamily) {
        case 'root':
            return action.type === 'replace-state' ? action.state : state;
        case 'workspace':
            return reduceWorkspaceAction(state, action);
        case 'group':
            return reduceGroupAction(state, action);
        case 'pane':
            return reducePaneAction(state, action);
        case 'layout':
            return reduceLayoutAction(state, action);
        case 'agent':
            return reduceAgentAction(state, action);
        case 'web':
            return reduceWebAction(state, action);
    }
}

export { previewAgentEvent } from './agent.js';
export { closePaneInWorkspace } from './panes.js';
export { normalizeURLInput } from './url.js';
export { resolvedActiveTab, tabDisplayLabel } from './web.js';
