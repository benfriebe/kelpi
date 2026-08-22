/**
 * §WS-151 — the `menu-command` names the shell's File menu relays, restated on this side.
 *
 * The two packages deliberately do not share a module for menu command names (nor do they for
 * `toggle-sidebar`, `new-workspace` or `seed-test-group`): the shell is an Electron main-process
 * package the client cannot import, and a third package existing only to hold six string
 * literals would be worse than stating them twice. So they are stated in both places and
 * **pinned in both test suites** — `shell/src/menu.test.ts` and `App.filemenu.test.tsx` each
 * assert the literal, so a rename on one side fails on the other rather than silently producing
 * a menu row that relays into nothing.
 *
 * Source of truth for the ROWS (labels, order, accelerators): `shell/src/menu.ts`.
 */

/** File ▸ New Group (⌘⇧G) — `act.newGroupWithRename()`. */
export const NEW_GROUP_COMMAND = 'new-group';
/** File ▸ New Web Pane (⌘⇧O) — `act.newWebPaneFocused()`. */
export const NEW_WEB_PANE_COMMAND = 'new-web-pane';
/** File ▸ Command Palette (⌘P) — `act.togglePalette()`. */
export const COMMAND_PALETTE_COMMAND = 'command-palette';
/** File ▸ Select All Workspaces — menu-only, no binding (the Swift has none either). */
export const SELECT_ALL_WORKSPACES_COMMAND = 'select-all-workspaces';
/** File ▸ Deselect All Workspaces — menu-only; the shell greys it while nothing is selected. */
export const DESELECT_ALL_WORKSPACES_COMMAND = 'deselect-all-workspaces';

/** File ▸ Switch to Workspace 1…9 (⌘1…⌘9), as `switch-workspace-1` … `switch-workspace-9`. */
export const SWITCH_WORKSPACE_COMMAND_PREFIX = 'switch-workspace-';

/**
 * The 1-based position a `switch-workspace-N` command names, or null when it is not one.
 *
 * Strict on purpose: only `1`–`9`, so `switch-workspace-10`, `switch-workspace-0` and
 * `switch-workspace-` all fall through to the chord replay at the end of the `menu-command`
 * chain rather than being resolved against an index the sidebar does not have.
 */
export function switchWorkspacePosition(command: string): number | null {
    if (!command.startsWith(SWITCH_WORKSPACE_COMMAND_PREFIX)) return null;
    const rest = command.slice(SWITCH_WORKSPACE_COMMAND_PREFIX.length);
    if (!/^[1-9]$/.test(rest)) return null;
    return Number(rest);
}

/**
 * §WS-151's other half: the report that lets the shell grey File ▸ Deselect All Workspaces.
 *
 * The message type is the protocol's `WS_WORKSPACE_SELECTION_MESSAGE`; this is the frame the
 * client builds for it. `windowID` scopes it to the shell window this page belongs to, exactly
 * as `shell-activation` is scoped in the other direction — two windows have two menus.
 */
export function workspaceSelectionReport(
    selected: number,
    shellWindowID: string | null
): { type: 'workspace-selection'; selected: number; windowID?: string } {
    return {
        type: 'workspace-selection',
        selected,
        ...(shellWindowID === null ? {} : { windowID: shellWindowID })
    };
}
