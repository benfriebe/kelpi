import type { BundledFeatureDefinition } from './feature';

export const WORKSPACES_FEATURE = {
    id: 'kelpi.workspaces', title: 'Workspaces', placements: ['sidebar.primary', 'sidebar.secondary']
} as const satisfies BundledFeatureDefinition;
export const INSPECTOR_FEATURE = {
    id: 'kelpi.inspector', title: 'Inspector', placements: ['sidebar.secondary', 'sidebar.primary']
} as const satisfies BundledFeatureDefinition;

export const TOOLBAR_FEATURE = { id: 'kelpi.topbar', title: 'Toolbar', placements: ['topbar'] } as const satisfies BundledFeatureDefinition;
export const STATUSBAR_FEATURE = { id: 'kelpi.statusbar', title: 'Status', placements: ['statusbar'] } as const satisfies BundledFeatureDefinition;
export const MARKDOWN_FEATURE = { id: 'kelpi.markdown', title: 'Markdown', placements: ['pane', 'document.markdown'] } as const satisfies BundledFeatureDefinition;
export const SCRATCHPAD_FEATURE = { id: 'kelpi.scratchpad', title: 'Scratchpad', placements: ['pane', 'document.scratchpad'] } as const satisfies BundledFeatureDefinition;
export const DIFF_FEATURE = { id: 'kelpi.diff', title: 'Diff', placements: ['pane', 'document.diff'] } as const satisfies BundledFeatureDefinition;

/** Discovery does not import React views or start feature subscriptions. */
export const BUNDLED_FEATURE_DEFINITIONS: readonly BundledFeatureDefinition[] = [
    { id: 'kelpi.shell', title: 'Terminal', placements: ['pane'] },
    MARKDOWN_FEATURE,
    SCRATCHPAD_FEATURE,
    DIFF_FEATURE,
    { id: 'kelpi.web', title: 'Browser', placements: ['pane'] },
    WORKSPACES_FEATURE,
    INSPECTOR_FEATURE,
    TOOLBAR_FEATURE,
    STATUSBAR_FEATURE,
    { id: 'kelpi.workspace', title: 'Pane grid', placements: ['workspace'] },
    { id: 'kelpi.settings', title: 'Plugin settings', placements: ['settings'] }
];
