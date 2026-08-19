/**
 * The Settings action catalog (config-keybindings.md §4, §13.1).
 *
 * The 51 bindable actions, their display names, and the categories the Keybindings table
 * renders as sections — in the fixed order §13.1 names: `Pane Management, Navigation,
 * Workspaces, View, Files, Search`. The eleven `web_*` actions are catalogued too but marked
 * hidden: §4 says they are NOT rendered in the Settings table (their delivery mechanism is the
 * hard-coded priority layer), while still being legal to bind by hand in the config file.
 *
 * The vocabulary itself is NOT restated here — `NEX_ACTIONS` from `@nex/core/config` is the
 * list, and `catalog.test.ts` asserts this table covers it exactly once. So an action added to
 * core cannot quietly go missing from Settings, and a display name cannot outlive its action.
 */

import { NEX_ACTIONS, type NexAction } from '@nex/core/config';

export const SETTINGS_CATEGORIES = [
    'Pane Management',
    'Navigation',
    'Workspaces',
    'View',
    'Files',
    'Search',
    'Web Pane'
] as const;
export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

/** §4's six visible sections, in the order §13.1 fixes. `Web Pane` is deliberately absent. */
export const VISIBLE_CATEGORIES: readonly SettingsCategory[] = [
    'Pane Management',
    'Navigation',
    'Workspaces',
    'View',
    'Files',
    'Search'
];

export interface ActionEntry {
    readonly action: NexAction;
    readonly category: SettingsCategory;
    /** §4's display name column, verbatim. */
    readonly label: string;
}

function switchEntries(): ActionEntry[] {
    const entries: ActionEntry[] = [];
    for (let index = 1; index <= 9; index += 1) {
        entries.push({
            action: `switch_to_workspace_${index}` as NexAction,
            category: 'Workspaces',
            label: `Switch to Workspace ${String(index)}`
        });
    }
    return entries;
}

/** Every action, in §4's table order (which is also `NEX_ACTIONS` order). */
export const ACTION_CATALOG: readonly ActionEntry[] = [
    { action: 'split_right', category: 'Pane Management', label: 'Split Right' },
    { action: 'split_down', category: 'Pane Management', label: 'Split Down' },
    { action: 'close_pane', category: 'Pane Management', label: 'Close Pane' },
    { action: 'reopen_closed_pane', category: 'Pane Management', label: 'Reopen Closed Pane' },
    { action: 'toggle_zoom', category: 'Pane Management', label: 'Toggle Zoom' },
    { action: 'cycle_layout', category: 'Pane Management', label: 'Cycle Layout' },
    { action: 'move_pane_left', category: 'Pane Management', label: 'Move Pane Left' },
    { action: 'move_pane_right', category: 'Pane Management', label: 'Move Pane Right' },
    { action: 'move_pane_up', category: 'Pane Management', label: 'Move Pane Up' },
    { action: 'move_pane_down', category: 'Pane Management', label: 'Move Pane Down' },
    { action: 'create_scratchpad', category: 'Pane Management', label: 'New Scratchpad' },
    { action: 'toggle_sync_input', category: 'Pane Management', label: 'Toggle Synchronise Input' },
    { action: 'open_web_pane', category: 'Pane Management', label: 'Open Web Pane' },

    { action: 'focus_next_pane', category: 'Navigation', label: 'Focus Next Pane' },
    { action: 'focus_previous_pane', category: 'Navigation', label: 'Focus Previous Pane' },
    { action: 'command_palette', category: 'Navigation', label: 'Command Palette' },

    { action: 'new_workspace', category: 'Workspaces', label: 'New Workspace' },
    { action: 'next_workspace', category: 'Workspaces', label: 'Next Workspace' },
    { action: 'previous_workspace', category: 'Workspaces', label: 'Previous Workspace' },
    { action: 'rename_workspace', category: 'Workspaces', label: 'Rename Workspace' },
    { action: 'new_group', category: 'Workspaces', label: 'New Group' },
    ...switchEntries(),

    { action: 'toggle_sidebar', category: 'View', label: 'Toggle Sidebar' },
    { action: 'toggle_inspector', category: 'View', label: 'Toggle Inspector' },

    { action: 'open_file', category: 'Files', label: 'Preview Markdown' },
    { action: 'toggle_markdown_edit', category: 'Files', label: 'Toggle Markdown Edit' },
    { action: 'increase_markdown_font_size', category: 'Files', label: 'Increase Markdown Font Size' },
    { action: 'decrease_markdown_font_size', category: 'Files', label: 'Decrease Markdown Font Size' },
    { action: 'reset_markdown_font_size', category: 'Files', label: 'Reset Markdown Font Size' },
    { action: 'open_diff', category: 'Files', label: 'Open Diff' },

    { action: 'toggle_search', category: 'Search', label: 'Toggle Search' },
    { action: 'close_search', category: 'Search', label: 'Close Search' },

    { action: 'web_focus_url_bar', category: 'Web Pane', label: 'Web: Focus URL Bar' },
    { action: 'web_back', category: 'Web Pane', label: 'Web: Back' },
    { action: 'web_forward', category: 'Web Pane', label: 'Web: Forward' },
    { action: 'web_reload', category: 'Web Pane', label: 'Web: Reload' },
    { action: 'web_tab_new', category: 'Web Pane', label: 'Web: New Tab' },
    { action: 'web_tab_close', category: 'Web Pane', label: 'Web: Close Tab' },
    { action: 'web_tab_prev', category: 'Web Pane', label: 'Web: Previous Tab' },
    { action: 'web_tab_next', category: 'Web Pane', label: 'Web: Next Tab' },
    { action: 'web_zoom_in', category: 'Web Pane', label: 'Web: Zoom In' },
    { action: 'web_zoom_out', category: 'Web Pane', label: 'Web: Zoom Out' },
    { action: 'web_zoom_reset', category: 'Web Pane', label: 'Web: Reset Zoom' }
];

const BY_ACTION: ReadonlyMap<NexAction, ActionEntry> = new Map(
    ACTION_CATALOG.map((entry) => [entry.action, entry])
);

/** The catalog entry for an action; every `NexAction` has one (asserted in the tests). */
export function actionEntry(action: NexAction): ActionEntry | undefined {
    return BY_ACTION.get(action);
}

/** §4's display name, falling back to the raw value so an unknown action still renders. */
export function actionLabel(action: NexAction): string {
    return BY_ACTION.get(action)?.label ?? action;
}

/** The actions of one category, in catalog order. */
export function actionsInCategory(category: SettingsCategory): readonly NexAction[] {
    return ACTION_CATALOG.filter((entry) => entry.category === category).map((entry) => entry.action);
}

/** Sanity anchor for the tests: the vocabulary this table is written against. */
export const CATALOGUED_ACTIONS: readonly NexAction[] = NEX_ACTIONS;

// ── the tabs ────────────────────────────────────────────────────────────────────────

/**
 * The tabs this port ships (§13's 7-tab window, minus the three whose subject matter has no
 * daemon-side home yet):
 *
 *   General / Repositories / Web are NOT here. General's worktree + repo + placement settings
 *   live in the Swift app's UserDefaults with no config-file or daemon key (the two suppression
 *   toggles that shell-ui.md's port note DID name are on the Workspaces tab below); the repo
 *   registry and web favourites are daemon state with no editing verbs yet. Adding a tab that
 *   cannot write anything would be worse than not having it.
 */
export const SETTINGS_TABS = [
    { id: 'keybindings', label: 'Keybindings' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'labels', label: 'Labels' },
    { id: 'profiles', label: 'Profiles' },
    { id: 'workspaces', label: 'Workspaces' }
] as const;

export type SettingsTabID = (typeof SETTINGS_TABS)[number]['id'];

export function isSettingsTabID(value: string): value is SettingsTabID {
    return SETTINGS_TABS.some((tab) => tab.id === value);
}
