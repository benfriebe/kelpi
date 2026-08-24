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
 * The tabs this port ships.
 *
 * §13's window has seven: General, Appearance, Repositories, Labels, Profiles, Keybindings,
 * Web. **General** is now here — its worktree base path and the two placement pickers became
 * real config keys (`@nex/core/config` `general.ts`), so the tab writes rather than merely
 * displays, which was the bar it previously failed.
 *
 * **Repositories** is now here too: the registry gained its own WS verbs (`repo-add` /
 * `repo-remove` / `repo-rename` / `repo-scan`, `daemon/src/ws/repos.ts`), so the tab adds,
 * scans, renames and removes rather than merely listing — and it is where §GIT-074's
 * auto-detect toggle lives, as it does in the shipped app.
 *
 * **Web** is now here too: favourites gained a daemon home (`webpane/favourites.ts`, persisted
 * as `favourites.json`) and the `web-favourite-*` verbs to rename, remove and reorder them, so
 * the URL-bar star's "Manage favourites…" has somewhere to land (SET-097…SET-100).
 *
 * **Workspaces** is this port's own: it holds the two settings §13 spreads across General
 * ▸ Workspaces and General ▸ Panes that already had a daemon key before General existed, and
 * the General tab points at it rather than duplicating the controls — two switches for one
 * value is how they drift apart.
 *
 * **The order is the shipped app's, not a rearrangement of it** (H13). `SettingsTab`
 * (`SettingsView.swift:8`) declares `general, appearance, repos, labels, profiles,
 * keybindings, web` and `SettingsView.swift:18-59` renders the `TabView` in exactly that
 * sequence; the port had previously hoisted Repositories and Keybindings above Appearance,
 * which is a different rail from the one a user of the shipped app has learned. The seven
 * below are now that sequence verbatim, and the port-only **Workspaces** tab is APPENDED
 * rather than inserted — an addition at the bottom of the rail cannot displace any of the
 * seven, where slotting it beside General (the tab that points at it) would have.
 */
export const SETTINGS_TABS = [
    { id: 'general', label: 'General' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'repositories', label: 'Repositories' },
    { id: 'labels', label: 'Labels' },
    { id: 'profiles', label: 'Profiles' },
    { id: 'keybindings', label: 'Keybindings' },
    { id: 'web', label: 'Web' },
    // Port-only, and last for that reason. See the note above.
    { id: 'workspaces', label: 'Workspaces' }
] as const;

export type SettingsTabID = (typeof SETTINGS_TABS)[number]['id'];

/**
 * The tab Settings opens on when nothing deep-links a specific one.
 *
 * `SettingsView.swift:13` — `@State private var selectedTab: SettingsTab = .general`. The port
 * opened on Keybindings from ⌘,, the ••• menu, the palette and the overlay's own default, so
 * the first thing a user saw was a 51-row table of chords rather than the app's General pane.
 * Typed as `SettingsTabID` so the default cannot name a tab the rail does not have.
 */
export const DEFAULT_SETTINGS_TAB: SettingsTabID = 'general';

export function isSettingsTabID(value: string): value is SettingsTabID {
    return SETTINGS_TABS.some((tab) => tab.id === value);
}
