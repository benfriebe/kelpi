import type { BundledFeatureDefinition } from './feature';

export const WORKSPACES_FEATURE = {
    id: 'kelpi.workspaces', title: 'Workspaces', placements: ['sidebar.primary', 'sidebar.secondary']
} as const satisfies BundledFeatureDefinition;
export const INSPECTOR_FEATURE = {
    id: 'kelpi.inspector', title: 'Inspector', placements: ['sidebar.secondary', 'sidebar.primary']
} as const satisfies BundledFeatureDefinition;

/** Discovery does not import React views or start feature subscriptions. */
export const BUNDLED_FEATURE_DEFINITIONS: readonly BundledFeatureDefinition[] = [
    { id: 'kelpi.shell', title: 'Terminal', placements: ['pane'] },
    { id: 'kelpi.markdown', title: 'Markdown', placements: ['pane'] },
    { id: 'kelpi.scratchpad', title: 'Scratchpad', placements: ['pane'] },
    { id: 'kelpi.diff', title: 'Diff', placements: ['pane'] },
    { id: 'kelpi.web', title: 'Browser', placements: ['pane'] },
    WORKSPACES_FEATURE,
    INSPECTOR_FEATURE,
    { id: 'kelpi.topbar', title: 'Toolbar', placements: ['topbar'] },
    { id: 'kelpi.statusbar', title: 'Status', placements: ['statusbar'] },
    { id: 'kelpi.workspace', title: 'Pane grid', placements: ['workspace'] },
    { id: 'kelpi.settings', title: 'Plugin settings', placements: ['settings'] }
];
