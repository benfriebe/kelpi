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
 * The three presented interaction surfaces. They are definitions with no `BundledFeatureBinding`,
 * deliberately: `InteractionHost` mounts them (§2.3), not `WorkbenchSlot`, so
 * `host.features.get(...)` is never consulted for any of these ids. Being definitions is what puts
 * them in `DEFAULT_SLOTS`, which is what makes the bundled presenter impossible to select away
 * (`registry.ts` - `resolveSlot` falls back to `slotDefault`, and the empty-selection escape hatch
 * is closed for a populated slot).
 *
 * The prompts entry is "Prompts" and no longer "Prompts and notifications": the stack is its own
 * placement now, and a recovery entry naming a surface it does not draw would send a user who wants
 * their notifications back to the wrong select.
 */
export const INTERACTION_PALETTE_FEATURE = { id: 'kelpi.palette', title: 'Command palette', placements: ['interaction.palette'] } as const satisfies BundledFeatureDefinition;
export const INTERACTION_PROMPTS_FEATURE = { id: 'kelpi.prompts', title: 'Prompts', placements: ['interaction.prompts'] } as const satisfies BundledFeatureDefinition;
export const INTERACTION_NOTIFICATIONS_FEATURE = { id: 'kelpi.interaction.notifications', title: 'Notifications', placements: ['interaction.notifications'] } as const satisfies BundledFeatureDefinition;

/**
 * The fourth presented surface: the Settings dialog's rail and panel.
 *
 * A definition with no binding, for the same reason as the three above: `SettingsOverlay` mounts it
 * through `settings/presenter-slot.tsx`, never `WorkbenchSlot`, so `host.features.get('kelpi.settings.window')`
 * is never consulted. Being a definition is what puts it in `DEFAULT_SLOTS`, which is what makes the
 * bundled panel impossible to select away - and Settings is where a presenter is switched off, so
 * that floor matters more here than anywhere else.
 *
 * Not to be confused with `kelpi.settings` below, which is the plugin-contributed SETTINGS SLOT
 * inside the Plugins tab. That one is unchanged.
 */
export const SETTINGS_WINDOW_FEATURE = { id: 'kelpi.settings.window', title: 'Settings', placements: ['settings.window'] } as const satisfies BundledFeatureDefinition;

/**
 * The fifth presented surface: every pane's header band.
 *
 * A definition with no binding, for the same reason as the four above: `grid/PaneGrid.tsx` mounts
 * it through `pane-chrome/presenter-slot.tsx`, never `WorkbenchSlot`, so
 * `host.features.get('kelpi.pane.chrome')` is never consulted. Being a definition is what puts it in
 * `DEFAULT_SLOTS`, which is what makes the bundled header impossible to select away - and a pane
 * with no header is a pane with no close button, so that floor is worth more here than the empty
 * select the escape hatch would otherwise allow.
 *
 * The title is "Pane header" rather than "Pane chrome": it is what the thing is called on screen,
 * and `optionTitle` appends "(bundled)" to it in the select, which is the route back.
 */
export const PANE_CHROME_FEATURE = { id: 'kelpi.pane.chrome', title: 'Pane header', placements: ['pane.chrome'] } as const satisfies BundledFeatureDefinition;

/**
 * The sixth presented surface: the find bar over the pane the daemon is searching.
 *
 * A definition with no binding, for the same reason as the five above: `grid/PaneGrid.tsx` mounts it
 * through `pane-search/presenter-slot.tsx`, never `WorkbenchSlot`, so
 * `host.features.get('kelpi.pane.search')` is never consulted. Being a definition is what puts it in
 * `DEFAULT_SLOTS`, which is what makes the native bar impossible to select away - and this one owns
 * a text input and the caret, so an empty select would mean a ⌘F that opens a search with no field
 * to type into.
 *
 * The title is "Pane search" because that is the placement said in words, and `optionTitle` appends
 * "(bundled)" to it in the select, which is the route back.
 */
export const PANE_SEARCH_FEATURE = { id: 'kelpi.pane.search', title: 'Pane search', placements: ['pane.search'] } as const satisfies BundledFeatureDefinition;

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
    INTERACTION_NOTIFICATIONS_FEATURE,
    SETTINGS_WINDOW_FEATURE,
    PANE_CHROME_FEATURE,
    PANE_SEARCH_FEATURE,
    { id: 'kelpi.workspace', title: 'Pane grid', placements: ['workspace'] },
    { id: 'kelpi.settings', title: 'Plugin settings', placements: ['settings'] }
];
