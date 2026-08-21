/**
 * The application menu's product rows (§WS-001, §WS-151, §WS-152, §APP-018, §APP-025, §APP-026).
 *
 * `main.ts` cannot be imported under vitest — `import { app } from 'electron'` does not resolve
 * outside an Electron process — so the parts of the menu that carry BEHAVIOUR live here, where a
 * test can build the template and click a row. The Electron import is type-only, and erased.
 *
 * What behaviour there is: the shipped app's View group is `CommandGroup(after: .sidebar)` with
 * "Toggle Sidebar" (⌘⇧S) and "Toggle Inspector" (⌘I), and its File group REPLACES the stock
 * "New Window" with "New Workspace" (⌘N), all of them sending straight into the reducer
 * (`Nex/Commands/NexCommands.swift:8-13,61-68`). This shell has no preload and no reducer, so
 * every one of those rows goes the long way round — `menu-request` → the daemon → `menu-command`
 * → the client's own `act.*` (`client/src/App.tsx`), which is the SAME entry point the keybinding
 * and the on-screen button use. One state, three gestures.
 *
 * The labels are static ("Toggle Sidebar", "Toggle Inspector" — exactly the Swift's) rather than
 * stateful "Hide …"/"Show …": both panels' visibility is client-local state that never travels to
 * the main process, so a stateful label could only ever be a guess that goes wrong the first time
 * a second window or a browser tab toggles its own.
 *
 * **⌘N is deliberately carried in TWO places** and lands in one: the accelerator on this row (what
 * a real key press hits first, because a native menu accelerator outranks the page) and
 * `new_workspace`'s binding inside the client (what a synthetic key event and a browser tab hit).
 * Both reach `act.newWorkspace`, which opens the New Workspace SHEET — the shipped app's
 * `showNewWorkspaceSheet()`, not an immediate create, and never a second Electron window.
 */

import type { MenuItemConstructorOptions } from 'electron';

// ── the `menu-command`s the client answers ──────────────────────────────────────────

/** §WS-001 — the client answers by toggling the sidebar. */
export const TOGGLE_SIDEBAR_COMMAND = 'toggle-sidebar';
/** §APP-025 / §WS-152 — the client answers by toggling the workspace inspector. */
export const TOGGLE_INSPECTOR_COMMAND = 'toggle-inspector';
/** §APP-018 — the client answers by opening the New Workspace sheet (never by creating one). */
export const NEW_WORKSPACE_COMMAND = 'new-workspace';
/** §CONT-120 / §APP-020 — the client answers by raising the markdown picker. */
export const OPEN_FILE_COMMAND = 'open-file';
/** §APP-028 / §SET-194 — the client answers by seeding the "Test Group" fixture (dev builds). */
export const SEED_TEST_GROUP_COMMAND = 'seed-test-group';

// ── accelerators, each one its action's own default trigger ─────────────────────────

/** ⌘⇧S — `toggle_sidebar`'s default trigger (`core/src/config/bindings.ts`). */
export const TOGGLE_SIDEBAR_ACCELERATOR = 'CommandOrControl+Shift+S';
/** ⌘I — `toggle_inspector`'s default trigger (`core/src/config/bindings.ts:56`). */
export const TOGGLE_INSPECTOR_ACCELERATOR = 'CommandOrControl+I';
/** ⌘N — `new_workspace`'s default trigger (`KeyBinding.swift:514`). */
export const NEW_WORKSPACE_ACCELERATOR = 'CommandOrControl+N';
/** ⌘O — `open_file`'s default trigger. */
export const OPEN_FILE_ACCELERATOR = 'CommandOrControl+O';

// ── row titles, matching `NexCommands.swift`'s ──────────────────────────────────────

export const TOGGLE_SIDEBAR_LABEL = 'Toggle Sidebar';
export const TOGGLE_INSPECTOR_LABEL = 'Toggle Inspector';
export const NEW_WORKSPACE_LABEL = 'New Workspace';
export const OPEN_FILE_LABEL = 'Preview Markdown…';
export const CHECK_FOR_UPDATES_LABEL = 'Check for Updates…';
export const DEBUG_MENU_LABEL = 'Debug';
export const SEED_TEST_GROUP_LABEL = 'Seed Test Group';

export interface MenuRelayDeps {
    /**
     * `status.sendMenuRequest`. Returns `false` when no window is attached yet — the same
     * contract File ▸ Preview Markdown… reads, and the reason this is not a bare `void`.
     */
    readonly sendMenuRequest: (command: string) => boolean;
    /** Called when the request could not be delivered (nothing is listening). */
    readonly onUndelivered?: ((command: string) => void) | undefined;
}

export type ViewMenuDeps = MenuRelayDeps;

/** One relay row: try the client, and say so rather than swallowing a click nobody took. */
function relayRow(
    deps: MenuRelayDeps,
    label: string,
    accelerator: string,
    command: string
): MenuItemConstructorOptions {
    return {
        label,
        accelerator,
        click: () => {
            if (deps.sendMenuRequest(command)) return;
            deps.onUndelivered?.(command);
        }
    };
}

/**
 * The View submenu: the two *product* toggles first, in the shipped app's own order, then the
 * web-contents roles the shell has always carried.
 */
export function viewMenuTemplate(deps: ViewMenuDeps): MenuItemConstructorOptions[] {
    return [
        relayRow(deps, TOGGLE_SIDEBAR_LABEL, TOGGLE_SIDEBAR_ACCELERATOR, TOGGLE_SIDEBAR_COMMAND),
        relayRow(deps, TOGGLE_INSPECTOR_LABEL, TOGGLE_INSPECTOR_ACCELERATOR, TOGGLE_INSPECTOR_COMMAND),
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
    ];
}

export interface FileMenuDeps extends MenuRelayDeps {
    /**
     * The fallback for ⌘O when no window took the relay: raise the native panel here. There is
     * no fallback for New Workspace — a workspace created with no window to show it in is not a
     * repair, it is a surprise on the next launch.
     */
    readonly promptOpenFile: () => void;
    /** `process.platform`, injected so the non-darwin tail can be exercised in a test. */
    readonly platform: string;
}

/**
 * The File submenu.
 *
 * §APP-018 / §WS-151: the stock "New Window" row is **replaced**, not supplemented. A second
 * BrowserWindow is not a thing this app has (`showWindow()` only ever raises the one), and the
 * shipped app spends ⌘N on New Workspace, so a "New Window" row here would be both a lie and a
 * shortcut collision waiting to happen.
 */
export function fileMenuTemplate(deps: FileMenuDeps): MenuItemConstructorOptions[] {
    return [
        relayRow(deps, NEW_WORKSPACE_LABEL, NEW_WORKSPACE_ACCELERATOR, NEW_WORKSPACE_COMMAND),
        { type: 'separator' },
        // CONT-120 / APP-020. It goes to the CLIENT rather than opening the panel here, so the
        // picker behaves identically however it is raised (⌘O in the window, this item, the •••
        // menu) and so the caller pane travels with the request.
        {
            label: OPEN_FILE_LABEL,
            accelerator: OPEN_FILE_ACCELERATOR,
            click: () => {
                if (deps.sendMenuRequest(OPEN_FILE_COMMAND)) return;
                deps.promptOpenFile();
            }
        },
        { type: 'separator' },
        deps.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
    ];
}

export interface AppMenuDeps {
    /** `checkForUpdates()` — the dialog-raising side effect in `main.ts`. */
    readonly checkForUpdates: () => void;
    /**
     * §APP-026: Sparkle's `canCheckForUpdates`, ported.
     *
     * The shipped app greys the row whenever Sparkle says a check is impossible
     * (`CheckForUpdatesView.swift:4-13`). The honest equivalent here is the build's own
     * capability — packaged, on a Squirrel platform, and opted in (`updater.ts`'s three
     * preconditions) — because a dev run or an unsigned bundle can never check, and an enabled
     * row that only ever answers "no" is the thing the Swift's disabled state avoids.
     *
     * It is read ONCE, when the menu is built, and that is correct: every input to it is fixed
     * for the life of the process. The transient "the feed has not finished starting" case is
     * deliberately NOT here — it would go stale in a menu built before the updater starts — and
     * is what the click's own dialog reports. The ••• title-bar menu's row (§APP-052) stays
     * unconditional for the same reason: it is where a user finds out WHY.
     */
    readonly canCheckForUpdates: boolean;
}

/**
 * The macOS application ("Nex") submenu: Check for Updates… directly after About, exactly where
 * Sparkle's item sat.
 */
export function appMenuTemplate(deps: AppMenuDeps): MenuItemConstructorOptions[] {
    return [
        { role: 'about' },
        {
            label: CHECK_FOR_UPDATES_LABEL,
            enabled: deps.canCheckForUpdates,
            click: () => deps.checkForUpdates()
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
    ];
}

// ── the Debug menu (§APP-028 / §SET-194) ────────────────────────────────────────────

/**
 * The shipped app's development affordance: `#if DEBUG CommandMenu("Debug") { "Seed Test Group" }`
 * (`Nex/Commands/NexCommands.swift:71-77`), whose reducer drops a gray "Test Group" holding two
 * gray workspaces with live surfaces into the sidebar (`Nex/AppReducer.swift:2038-2080`) so a
 * sidebar or layout change can be looked at against something more than one Default row.
 *
 * **The guard is the whole item.** `#if DEBUG` is a compile-time condition and there is no such
 * thing here — the same JavaScript ships in both builds — so the equivalent is `app.isPackaged`:
 * false for `electron .` on a checkout, true inside a built `.app`. It is passed IN rather than
 * read here, both because this module imports no Electron (the reason these templates live here
 * at all) and because a test has to be able to ask the question both ways round. `menu.test.ts`
 * asserts the row exists in a dev build and is ABSENT in a packaged one, and
 * `scripts/packaged-smoke.mjs` re-asks the second question of a real packaged launch, where
 * `app.isPackaged` is not a parameter anyone can fake.
 *
 * The click relays like every other product row — `menu-request` → the daemon → `menu-command` —
 * and the CLIENT builds the fixture out of the ordinary create verbs
 * (`client/src/app/seed-test-group.ts`). No part of the seed lives in the main process, so a
 * packaged build does not merely hide a row: the only thing that can ask for the fixture is gone.
 */
export function debugMenuTemplate(deps: MenuRelayDeps): MenuItemConstructorOptions[] {
    // Deliberately one row, exactly as the Swift menu has — and deliberately no accelerator:
    // the Swift `Button` has none either, and a chord that seeds workspaces is not something to
    // hand a dev build by accident.
    return [
        {
            label: SEED_TEST_GROUP_LABEL,
            click: () => {
                if (deps.sendMenuRequest(SEED_TEST_GROUP_COMMAND)) return;
                deps.onUndelivered?.(SEED_TEST_GROUP_COMMAND);
            }
        }
    ];
}

export interface DebugMenuDeps extends MenuRelayDeps {
    /** `app.isPackaged`. True suppresses the menu entirely. */
    readonly isPackaged: boolean;
}

/**
 * The Debug menu as a *section* of the application menu: one entry in a dev build, nothing at all
 * in a packaged one. Spread into the template, so the packaged case adds no empty menu rather
 * than an inert one.
 */
export function debugMenuSection(deps: DebugMenuDeps): MenuItemConstructorOptions[] {
    if (deps.isPackaged) return [];
    return [{ label: DEBUG_MENU_LABEL, submenu: debugMenuTemplate(deps) }];
}

/**
 * What `menuLogLine` says about the Debug menu. The packaged wording is a POSITIVE statement of
 * absence: a smoke that only checked for a missing label would pass just as happily on a launch
 * that never built a menu at all.
 */
export function debugMenuLogFragment(isPackaged: boolean): string {
    return isPackaged
        ? `no ${DEBUG_MENU_LABEL} menu (packaged)`
        : `${DEBUG_MENU_LABEL} ▸ ${SEED_TEST_GROUP_LABEL} (dev build)`;
}

// ── the log line the smoke and the audit assert the menu by ─────────────────────────

/**
 * `View ▸ …`, as `main.ts` logs it.
 *
 * Prefix-stable on purpose: `docs/audit`'s `sidebar-remaining` asserts the exact substring
 * `View ▸ Toggle Sidebar (⌘⇧S)`, so the second row is APPENDED rather than folded into a
 * different shape.
 */
export const VIEW_MENU_LOG_FRAGMENT = `View ▸ ${TOGGLE_SIDEBAR_LABEL} (⌘⇧S) + ${TOGGLE_INSPECTOR_LABEL} (⌘I)`;

/** `File ▸ …`, as `main.ts` logs it. */
export const FILE_MENU_LOG_FRAGMENT = `File ▸ ${NEW_WORKSPACE_LABEL} (⌘N) · ${OPEN_FILE_LABEL} (⌘O)`;

/**
 * The one-line summary `buildMenu` logs, so `scripts/smoke.mjs` and the audit can assert the
 * installed menu without a UI — an application menu is not observable from outside the process.
 *
 * The updater row carries its own enabled/disabled state, because "is it greyed?" is exactly the
 * §APP-026 claim and there is nowhere else outside the process it can be read from.
 */
export function menuLogLine(options: {
    readonly canCheckForUpdates: boolean;
    /**
     * `app.isPackaged`, when the caller knows it. Present → the line states the Debug menu's
     * presence or absence (§APP-028); absent → it says nothing about it, because a line that
     * guessed would be worse than one that is silent.
     */
    readonly isPackaged?: boolean | undefined;
}): string {
    const updates = `${CHECK_FOR_UPDATES_LABEL} (${options.canCheckForUpdates ? 'enabled' : 'disabled'})`;
    const debug = options.isPackaged === undefined ? '' : ` · ${debugMenuLogFragment(options.isPackaged)}`;
    return `menu: Nex ▸ ${updates} · ${FILE_MENU_LOG_FRAGMENT} · ${VIEW_MENU_LOG_FRAGMENT} · Help ▸ Nex Help (⌘?)${debug}`;
}
