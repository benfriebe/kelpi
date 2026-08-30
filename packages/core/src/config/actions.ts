/**
 * The bindable action list.
 * Spec: docs/current/config-keybindings.md §4 (51 actions + the `unbind` pseudo-action).
 * Raw values are the config-file vocabulary and must not change.
 */

export const KELPI_ACTIONS = [
    // Pane Management
    'split_right',
    'split_down',
    'close_pane',
    'reopen_closed_pane',
    'toggle_zoom',
    'cycle_layout',
    'move_pane_left',
    'move_pane_right',
    'move_pane_up',
    'move_pane_down',
    'create_scratchpad',
    'toggle_sync_input',
    'open_web_pane',
    // Navigation
    'focus_next_pane',
    'focus_previous_pane',
    'command_palette',
    // Workspaces
    'new_workspace',
    'next_workspace',
    'previous_workspace',
    'rename_workspace',
    'new_group',
    'switch_to_workspace_1',
    'switch_to_workspace_2',
    'switch_to_workspace_3',
    'switch_to_workspace_4',
    'switch_to_workspace_5',
    'switch_to_workspace_6',
    'switch_to_workspace_7',
    'switch_to_workspace_8',
    'switch_to_workspace_9',
    // View
    'toggle_sidebar',
    'toggle_inspector',
    // Files
    'open_file',
    'toggle_markdown_edit',
    'increase_markdown_font_size',
    'decrease_markdown_font_size',
    'reset_markdown_font_size',
    'open_diff',
    // Search
    'toggle_search',
    'close_search',
    // Web pane (hidden from Settings; all ship unbound)
    'web_focus_url_bar',
    'web_back',
    'web_forward',
    'web_reload',
    'web_tab_new',
    'web_tab_close',
    'web_tab_prev',
    'web_tab_next',
    'web_zoom_in',
    'web_zoom_out',
    'web_zoom_reset'
] as const;

export type KelpiAction = (typeof KELPI_ACTIONS)[number];

/** Config-file-only pseudo-action: removes a trigger from the map. */
export const UNBIND_ACTION = 'unbind';
export type UnbindAction = typeof UNBIND_ACTION;

const ACTION_SET: ReadonlySet<string> = new Set<string>(KELPI_ACTIONS);

export function isKelpiAction(value: string): value is KelpiAction {
    return ACTION_SET.has(value);
}

/**
 * The 16 actions owned by the menu-bar dispatch layer (§4 "Menu-bar action set"); the
 * pane-shortcut monitor never consumes events for these.
 */
export const MENU_BAR_ACTIONS: ReadonlySet<KelpiAction> = new Set<KelpiAction>([
    'new_workspace',
    'open_file',
    'open_web_pane',
    'new_group',
    'switch_to_workspace_1',
    'switch_to_workspace_2',
    'switch_to_workspace_3',
    'switch_to_workspace_4',
    'switch_to_workspace_5',
    'switch_to_workspace_6',
    'switch_to_workspace_7',
    'switch_to_workspace_8',
    'switch_to_workspace_9',
    'toggle_sidebar',
    'toggle_inspector',
    'command_palette'
]);
