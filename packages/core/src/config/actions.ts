/**
 * The bindable action list.
 * Spec: docs/config-keybindings.md §4 (63 actions + the `unbind` pseudo-action).
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
    // The root arrangement (docs/plugins.md "Hiding bands and Zen Mode"). Zen Mode hides the
    // toolbar, status bar, bottom panel and both sidebars and restores exactly what was shown;
    // the other three toggle one band each and ship unbound.
    'toggle_zen_mode',
    'toggle_toolbar',
    'toggle_status_bar',
    'toggle_bottom_panel',
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
    // Clipboard (#81). Both fall through when the focused pane is not a terminal, so a
    // markdown pane, a chrome text field and a web page keep the Edit menu's own Copy/Paste.
    'copy',
    'paste',
    // Terminal line editing (#82). Ghostty's macOS "natural text editing" defaults, as named
    // actions because Kelpi's binding grammar has no `text:` payload; see the Terminal category
    // in docs/config-keybindings.md §4.
    'kill_line_backward',
    'move_to_line_start',
    'move_to_line_end',
    // Terminal text size (#175). DAEMON-WIDE, not per pane and not per viewer: each steps the
    // ghostty `font-size` Settings ▸ Appearance already writes, through the same settings verb,
    // so every session on that daemon follows and a remote kelpi-to-kelpi session can drive it.
    // They are NOT in `MENU_BAR_ACTIONS` on purpose: that set is the one that still fires while
    // a chrome text field has the caret, and a ⌘- typed into the sidebar filter must stay a `-`.
    'increase_terminal_font_size',
    'decrease_terminal_font_size',
    'reset_terminal_font_size',
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
 * The 20 actions owned by the menu-bar dispatch layer (§4 "Menu-bar action set"); the
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
    'command_palette',
    'toggle_zen_mode',
    'toggle_toolbar',
    'toggle_status_bar',
    'toggle_bottom_panel'
]);

/**
 * The window-arrangement actions, which act on the window rather than on a pane.
 *
 * The dispatcher refuses every other binding while no local workspace is displayed
 * (`client/src/chrome/keys.ts` step 3), because a split or a close needs one. These four do not,
 * and must not: a browser tab has no native menu to fall back on, so a Zen Mode entered over an
 * empty daemon or a remote workspace would otherwise have no chord out of it.
 */
export const WINDOW_ARRANGEMENT_ACTIONS: ReadonlySet<KelpiAction> = new Set<KelpiAction>([
    'toggle_zen_mode',
    'toggle_toolbar',
    'toggle_status_bar',
    'toggle_bottom_panel'
]);
