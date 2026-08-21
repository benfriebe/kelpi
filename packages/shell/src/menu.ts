/**
 * The application menu's View submenu (§WS-001).
 *
 * `main.ts` cannot be imported under vitest — `import { app } from 'electron'` does not resolve
 * outside an Electron process — so the parts of the menu that carry BEHAVIOUR live here, where a
 * test can build the template and click a row. The Electron import is type-only, and erased.
 *
 * What behaviour there is: the shipped app's View group is `CommandGroup(after: .sidebar)` with
 * "Toggle Sidebar" (⌘⇧S) and "Toggle Inspector" (⌘I), both sending straight into the reducer
 * (`Nex/Commands/NexCommands.swift:61-68`). This shell has no preload and no reducer, so the item
 * goes the long way round — `menu-request` → the daemon → `menu-command` → the client's own
 * `act.toggleSidebar` (`client/src/App.tsx`), which is the SAME entry point the ⌘⇧S binding and
 * the top-bar button use. One state, three gestures.
 *
 * The label is static ("Toggle Sidebar", exactly the Swift's) rather than a stateful
 * "Hide Sidebar"/"Show Sidebar": the sidebar's visibility is client-local state that never
 * travels to the main process, so a stateful label could only ever be a guess that goes wrong
 * the first time a second window or a browser tab toggles its own.
 */

import type { MenuItemConstructorOptions } from 'electron';

/** The `menu-command` the client answers by toggling the sidebar. */
export const TOGGLE_SIDEBAR_COMMAND = 'toggle-sidebar';

/** ⌘⇧S — `toggle_sidebar`'s default trigger (`core/src/config/bindings.ts`). */
export const TOGGLE_SIDEBAR_ACCELERATOR = 'CommandOrControl+Shift+S';

/** The row's title, matching `NexCommands.swift`'s. */
export const TOGGLE_SIDEBAR_LABEL = 'Toggle Sidebar';

export interface ViewMenuDeps {
    /**
     * `status.sendMenuRequest`. Returns `false` when no window is attached yet — the same
     * contract File ▸ Preview Markdown… reads, and the reason this is not a bare `void`.
     */
    readonly sendMenuRequest: (command: string) => boolean;
    /** Called when the request could not be delivered (nothing is listening). */
    readonly onUndelivered?: ((command: string) => void) | undefined;
}

/**
 * The View submenu: the sidebar toggle first (it is the only *product* item in this menu), then
 * the web-contents roles the shell has always carried.
 */
export function viewMenuTemplate(deps: ViewMenuDeps): MenuItemConstructorOptions[] {
    return [
        {
            label: TOGGLE_SIDEBAR_LABEL,
            accelerator: TOGGLE_SIDEBAR_ACCELERATOR,
            click: () => {
                if (deps.sendMenuRequest(TOGGLE_SIDEBAR_COMMAND)) return;
                deps.onUndelivered?.(TOGGLE_SIDEBAR_COMMAND);
            }
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
    ];
}

/** The one-line summary `buildMenu` logs, so `smoke.mjs` can assert the menu without a UI. */
export const VIEW_MENU_LOG_FRAGMENT = `View ▸ ${TOGGLE_SIDEBAR_LABEL} (⌘⇧S)`;
