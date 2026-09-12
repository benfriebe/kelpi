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
export const TERMINAL_FEATURE = { id: 'kelpi.shell', title: 'Terminal', placements: ['pane', 'terminal'] } as const satisfies BundledFeatureDefinition;
export const BROWSER_FEATURE = { id: 'kelpi.web', title: 'Browser', placements: ['pane', 'browser'] } as const satisfies BundledFeatureDefinition;

/**
 * The two presented surfaces. They are definitions with no `BundledFeatureBinding`, deliberately:
 * `InteractionHost` mounts them (§2.3), not `WorkbenchSlot`, so `host.features.get(...)` is never
 * consulted for either id. Being definitions is what puts them in `DEFAULT_SLOTS`, which is what
 * makes the bundled presenter impossible to select away (`registry.ts` - `resolveSlot` falls back
 * to `slotDefault`, and the empty-selection escape hatch is closed for a populated slot).
 */
export const INTERACTION_PALETTE_FEATURE = { id: 'kelpi.palette', title: 'Command palette', placements: ['interaction.palette'] } as const satisfies BundledFeatureDefinition;
export const INTERACTION_PROMPTS_FEATURE = { id: 'kelpi.prompts', title: 'Prompts and notifications', placements: ['interaction.prompts'] } as const satisfies BundledFeatureDefinition;

/**
 * The third presented surface: the Settings dialog's rail and panel.
 *
 * A definition with no binding, for the same reason as the two above: `SettingsOverlay` mounts it
 * through `settings/presenter-slot.tsx`, never `WorkbenchSlot`, so `host.features.get('kelpi.settings.window')`
 * is never consulted. Being a definition is what puts it in `DEFAULT_SLOTS`, which is what makes the
 * bundled panel impossible to select away - and Settings is where a presenter is switched off, so
 * that floor matters more here than anywhere else.
 *
 * Not to be confused with `kelpi.settings` below, which is the plugin-contributed SETTINGS SLOT
 * inside the Plugins tab. That one is unchanged.
 */
export const SETTINGS_WINDOW_FEATURE = { id: 'kelpi.settings.window', title: 'Settings', placements: ['settings.window'] } as const satisfies BundledFeatureDefinition;

/** Discovery does not import React views or start feature subscriptions. */
export const BUNDLED_FEATURE_DEFINITIONS: readonly BundledFeatureDefinition[] = [
    TERMINAL_FEATURE,
    MARKDOWN_FEATURE,
    SCRATCHPAD_FEATURE,
    DIFF_FEATURE,
    BROWSER_FEATURE,
    WORKSPACES_FEATURE,
    INSPECTOR_FEATURE,
    TOOLBAR_FEATURE,
    STATUSBAR_FEATURE,
    INTERACTION_PALETTE_FEATURE,
    INTERACTION_PROMPTS_FEATURE,
    SETTINGS_WINDOW_FEATURE,
    { id: 'kelpi.workspace', title: 'Pane grid', placements: ['workspace'] },
    { id: 'kelpi.settings', title: 'Plugin settings', placements: ['settings'] }
];
