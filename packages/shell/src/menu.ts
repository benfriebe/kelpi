/**
 * The application menu's product rows (§WS-001, §WS-151, §WS-152, §APP-018, §APP-025, §APP-026).
 *
 * `main.ts` cannot be imported under vitest — `import { app } from 'electron'` does not resolve
 * outside an Electron process — so the parts of the menu that carry BEHAVIOUR live here, where a
 * test can build the template and click a row. The Electron import is type-only, and erased.
 *
 * What behaviour there is: the shipped app's View group is `CommandGroup(after: .sidebar)` with
 * "Toggle Sidebar" (⌘⇧S) and "Toggle Inspector" (⌘I), and its File group REPLACES the stock
 * "New Window" with New Workspace (⌘N), New Group (⌘⇧G), Preview Markdown… (⌘O), New Web Pane
 * (⌘⇧O), Command Palette (⌘P), then Switch to Workspace 1–9 (⌘1…⌘9) and Select All / Deselect
 * All Workspaces, all of them sending straight into the reducer
 * (`Nex/Commands/NexCommands.swift:8-58,61-68`). This shell has no preload and no reducer, so
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
/** §WS-151 / §SET-144 — the client answers with `act.newGroupWithRename()` (⌘⇧G's own gesture). */
export const NEW_GROUP_COMMAND = 'new-group';
/** §WS-151 / §SET-145 — the client answers with `act.newWebPaneFocused()` (⌘⇧O's own gesture). */
export const NEW_WEB_PANE_COMMAND = 'new-web-pane';
/** §WS-151 — the client answers by toggling the command palette (⌘P's own gesture). */
export const COMMAND_PALETTE_COMMAND = 'command-palette';
/** §WS-151 — the client answers by selecting every workspace in the sidebar. */
export const SELECT_ALL_WORKSPACES_COMMAND = 'select-all-workspaces';
/** §WS-151 — the client answers by clearing the sidebar's workspace multi-selection. */
export const DESELECT_ALL_WORKSPACES_COMMAND = 'deselect-all-workspaces';

/**
 * §WS-151's "Switch to Workspace N" rows: `switch-workspace-1` … `switch-workspace-9`.
 *
 * One command per row rather than one command with an argument, because `menu-request` carries a
 * bare `command` string (`ws/sync.ts`) and inventing a second field for nine rows would change a
 * wire message every other row already fits inside.
 */
export const SWITCH_WORKSPACE_COMMAND_PREFIX = 'switch-workspace-';

/** 1-based, matching the row's own label and the ⌘N accelerator on it. */
export function switchWorkspaceCommand(position: number): string {
    return `${SWITCH_WORKSPACE_COMMAND_PREFIX}${String(position)}`;
}

/**
 * The 1-based position a `switch-workspace-N` command names, or null.
 *
 * Exported so the CLIENT can parse the same string it is sent without re-deriving the format
 * (`client/src/App.tsx`); the two sides then cannot drift.
 */
export function switchWorkspacePosition(command: string): number | null {
    if (!command.startsWith(SWITCH_WORKSPACE_COMMAND_PREFIX)) return null;
    const rest = command.slice(SWITCH_WORKSPACE_COMMAND_PREFIX.length);
    if (!/^[1-9]$/.test(rest)) return null;
    return Number(rest);
}

/** How many "Switch to Workspace N" rows the File menu carries (⌘1…⌘9). */
export const SWITCH_WORKSPACE_ROWS = 9;

// ── accelerators, each one its action's own default trigger ─────────────────────────

/** ⌘⇧S — `toggle_sidebar`'s default trigger (`core/src/config/bindings.ts`). */
export const TOGGLE_SIDEBAR_ACCELERATOR = 'CommandOrControl+Shift+S';
/** ⌘I — `toggle_inspector`'s default trigger (`core/src/config/bindings.ts:56`). */
export const TOGGLE_INSPECTOR_ACCELERATOR = 'CommandOrControl+I';
/** ⌘N — `new_workspace`'s default trigger (`KeyBinding.swift:514`). */
export const NEW_WORKSPACE_ACCELERATOR = 'CommandOrControl+N';
/** ⌘O — `open_file`'s default trigger. */
export const OPEN_FILE_ACCELERATOR = 'CommandOrControl+O';
/** ⌘⇧G — `new_group`'s default trigger (`core/src/config/bindings.ts`; `KeyBinding.swift:557`). */
export const NEW_GROUP_ACCELERATOR = 'CommandOrControl+Shift+G';
/** ⌘⇧O — `open_web_pane`'s default trigger (`KeyBinding.swift:516`). */
export const NEW_WEB_PANE_ACCELERATOR = 'CommandOrControl+Shift+O';
/** ⌘P — `command_palette`'s default trigger (`KeyBinding.swift:551`). */
export const COMMAND_PALETTE_ACCELERATOR = 'CommandOrControl+P';

/** ⌘1…⌘9 — `switch_to_workspace_1..9`'s default triggers. */
export function switchWorkspaceAccelerator(position: number): string {
    return `CommandOrControl+${String(position)}`;
}

// ── row titles, matching `NexCommands.swift`'s ──────────────────────────────────────

export const TOGGLE_SIDEBAR_LABEL = 'Toggle Sidebar';
export const TOGGLE_INSPECTOR_LABEL = 'Toggle Inspector';
export const NEW_WORKSPACE_LABEL = 'New Workspace';
export const OPEN_FILE_LABEL = 'Preview Markdown…';
export const NEW_GROUP_LABEL = 'New Group';
export const NEW_WEB_PANE_LABEL = 'New Web Pane';
export const COMMAND_PALETTE_LABEL = 'Command Palette';
export const SELECT_ALL_WORKSPACES_LABEL = 'Select All Workspaces';
export const DESELECT_ALL_WORKSPACES_LABEL = 'Deselect All Workspaces';

/** `Switch to Workspace 1` … `Switch to Workspace 9`, exactly as `NexCommands.swift:38-45` builds them. */
export function switchWorkspaceLabel(position: number): string {
    return `Switch to Workspace ${String(position)}`;
}

/**
 * The id the Deselect All row carries, so its enabled state can be moved after the menu is built
 * (`main.ts` ▸ `applyWorkspaceSelection`). Every other row is stateless and needs none.
 */
export const DESELECT_ALL_WORKSPACES_MENU_ID = 'deselect-all-workspaces';
export const CHECK_FOR_UPDATES_LABEL = 'Check for Updates…';
export const DEBUG_MENU_LABEL = 'Debug';
export const SEED_TEST_GROUP_LABEL = 'Seed Test Group';

// ── File ▸ Close (N14) ──────────────────────────────────────────────────────────────

/**
 * The macOS Close row, and why it is no longer `{ role: 'close' }`.
 *
 * `role: 'close'` is a native accelerator whose answer to ⌘W is "close the window", and it
 * raced the page for every keystroke: with a terminal focused the renderer consumed the chord
 * first and only the PANE closed, but with focus inside a markdown/diff preview — a cross-origin
 * frame, a different renderer — the window went instead (N14). The shipped app cannot have that
 * race: `KeyBinding.swift:285-296` keeps `close_pane` out of `isMenuBarAction` precisely so its
 * `NSEvent` monitor always gets ⌘W first, whatever holds first responder.
 *
 * The row stays (a macOS File menu without Close, and a ⌘W with no visible home, is wrong for
 * the platform) but it no longer decides anything: the click ASKS the focused window's page to
 * run `close_pane` — the same path a keystroke takes through `client/src/chrome/keys.ts` — and
 * the window is closed only when the page says there is nothing to close, or does not answer.
 */
export const CLOSE_LABEL = 'Close';
/** ⌘W, still on the row: the point is to route it, not to hide it. */
export const CLOSE_ACCELERATOR = 'CommandOrControl+W';

/**
 * What the shell evaluates in the focused window.
 *
 * The global is installed by `client/src/app/shell-close.ts` (`SHELL_CLOSE_GLOBAL`) and pinned in
 * both suites, exactly as the `menu-command` names are: the two packages cannot import each
 * other, so the literal is stated twice and asserted twice.
 *
 * `=== true` on the way out, so a page that answers with something else (an older client, a
 * mangled global) reads as "not handled" and the window still closes — a wedged or unexpected
 * renderer must never make a window unclosable.
 */
export const CLOSE_PANE_EXPRESSION =
    "(function () { try { return window.__kelpiShellClosePane() === true; } catch (error) { return false; } })()";

/** How long the row waits for the page before falling back to closing the window. */
export const CLOSE_ROUTE_TIMEOUT_MS = 500;

/** What a Close click did: closed a pane in the page, closed the window, or had no window. */
export type CloseRouteOutcome = 'pane' | 'window' | 'none';

export interface CloseRouteDeps {
    /**
     * `webContents.executeJavaScript(CLOSE_PANE_EXPRESSION, true)` for the focused window, or
     * null when there is no window to ask (nothing to close, and nothing to close it on).
     */
    readonly askRenderer: (() => Promise<unknown>) | null;
    /** `window.close()` — the fallback, taken when the page declines or does not answer. */
    readonly closeWindow: () => void;
    readonly timeoutMs?: number | undefined;
}

/**
 * Renderer-first close routing.
 *
 * Every failure mode ends in `closeWindow()` on purpose: a rejected evaluation (the page is
 * mid-navigation, or crashed), a non-`true` answer (nothing focused to close) and a silent one
 * (a wedged renderer) all mean the same thing to a user pressing ⌘W — this window should go.
 */
export async function routeCloseRequest(deps: CloseRouteDeps): Promise<CloseRouteOutcome> {
    const ask = deps.askRenderer;
    if (ask === null) return 'none';

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), deps.timeoutMs ?? CLOSE_ROUTE_TIMEOUT_MS);
        timer.unref?.();
    });

    let handled = false;
    try {
        handled = await Promise.race([
            (async () => (await ask()) === true)().catch(() => false),
            timeout
        ]);
    } finally {
        if (timer !== null) clearTimeout(timer);
    }

    if (handled) return 'pane';
    deps.closeWindow();
    return 'window';
}

/** The line `main.ts` logs, and the only trace of this decision visible from outside the process. */
export function closeRouteLogLine(outcome: CloseRouteOutcome): string {
    if (outcome === 'pane') return 'menu: Close routed to the window’s pane (close_pane)';
    if (outcome === 'window') return 'menu: Close fell back to closing the window';
    return 'menu: Close had no window to act on';
}

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
 * ⌥⌘R for Force Reload, in place of the role's own ⇧⌘R.
 *
 * Found by N14's sweep: `{ role: 'forceReload' }` brings ⇧⌘R with it, and ⇧⌘R is
 * `rename_workspace` in the binding map (`core/src/config/bindings.ts`; `KeyBinding.swift`'s
 * default). That is the same shape as the ⌘W defect — a chord the app claims, left to a native
 * menu default that does something else and something destructive (a full client reload throws
 * away every piece of view state the window is holding). The Swift app has no Reload row at all,
 * so there is no parity cost to moving it; the dev affordance stays, on a chord nothing claims.
 */
export const FORCE_RELOAD_ACCELERATOR = 'CommandOrControl+Alt+R';

/**
 * The View submenu: the two *product* toggles first, in the shipped app's own order, then the
 * web-contents roles the shell has always carried.
 */
export function viewMenuTemplate(deps: ViewMenuDeps): MenuItemConstructorOptions[] {
    return [
        relayRow(deps, TOGGLE_SIDEBAR_LABEL, TOGGLE_SIDEBAR_ACCELERATOR, TOGGLE_SIDEBAR_COMMAND),
        relayRow(deps, TOGGLE_INSPECTOR_LABEL, TOGGLE_INSPECTOR_ACCELERATOR, TOGGLE_INSPECTOR_COMMAND),
        { type: 'separator' },
        // ⌘R: not in the binding map, so nothing is shadowed. (A web pane's priority layer does
        // claim ⌘R while a web pane is focused — that is the page consuming it first, which is
        // the ordering this whole file relies on, not a menu default overriding a binding.)
        { role: 'reload' },
        { role: 'forceReload', accelerator: FORCE_RELOAD_ACCELERATOR },
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
    /**
     * §WS-151's "(the latter disabled with an empty selection)". Absent/false at build time —
     * a window that has not reported a selection has none — and moved afterwards through
     * `applyWorkspaceSelection` rather than by rebuilding the menu, because rebuilding one
     * would drop an open menu and re-register every accelerator for one greyed row.
     */
    readonly hasWorkspaceSelection?: boolean | undefined;
    /**
     * N14 — what File ▸ Close (⌘W) runs. `main.ts` hands it a `routeCloseRequest` call, which
     * asks the focused window's page to close a PANE first and closes the window only when it
     * cannot.
     *
     * Required rather than optional: an absent handler could only fall back to the bare
     * `role: 'close'` this replaced, and that is the defect.
     */
    readonly closeFocusedPane: () => void;
}

/**
 * Move the Deselect All row's enabled state on a LIVE menu (§WS-151).
 *
 * Split out of `main.ts` for the reason every other behaviour in this module is: it can then be
 * exercised without an Electron process. The menu is passed in (rather than read from
 * `Menu.getApplicationMenu()`) so a test can hand it a plain object, and a menu that does not
 * carry the row — a non-darwin build, or one built before this row existed — is a no-op rather
 * than a throw.
 *
 * Returns what it applied, so the caller can log a state that is otherwise invisible from
 * outside the process (the smoke and the audit read exactly that line).
 */
export function applyWorkspaceSelection(
    menu: { getMenuItemById(id: string): { enabled: boolean } | null } | null | undefined,
    selectedCount: number
): boolean {
    const enabled = selectedCount > 0;
    const item = menu?.getMenuItemById(DESELECT_ALL_WORKSPACES_MENU_ID);
    if (item !== null && item !== undefined) item.enabled = enabled;
    return enabled;
}

/** The line `main.ts` logs when a selection report moves the row (asserted by the audit). */
export function workspaceSelectionLogLine(selectedCount: number): string {
    return `menu: ${DESELECT_ALL_WORKSPACES_LABEL} ${selectedCount > 0 ? 'enabled' : 'disabled'} (${String(selectedCount)} selected)`;
}

/**
 * The File submenu.
 *
 * §APP-018 / §WS-151: the stock "New Window" row is **replaced**, not supplemented. A second
 * BrowserWindow is not a thing this app has (`showWindow()` only ever raises the one), and the
 * shipped app spends ⌘N on New Workspace, so a "New Window" row here would be both a lie and a
 * shortcut collision waiting to happen.
 *
 * The shape is `NexCommands.swift:10-58`'s, row for row: five product rows contiguous (the Swift
 * `CommandGroup` has no divider among them), a divider, the nine "Switch to Workspace N" rows,
 * a divider, then Select All / Deselect All Workspaces. Every one is a RELAY — the main process
 * owns none of this state — so each row, its keybinding and its on-screen gesture are three
 * routes into one `act.*` in the client.
 *
 * **Deselect All Workspaces is the one row with a state**, and the state does not live here: a
 * workspace multi-selection is the sidebar's, in the page. It is built disabled (a fresh window
 * has no selection) and moved by `applyWorkspaceSelection` when the client reports one —
 * client → daemon → shell, mirroring §AGNT-056's `shell-activation` in the other direction.
 */
export function fileMenuTemplate(deps: FileMenuDeps): MenuItemConstructorOptions[] {
    return [
        relayRow(deps, NEW_WORKSPACE_LABEL, NEW_WORKSPACE_ACCELERATOR, NEW_WORKSPACE_COMMAND),
        relayRow(deps, NEW_GROUP_LABEL, NEW_GROUP_ACCELERATOR, NEW_GROUP_COMMAND),
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
        relayRow(deps, NEW_WEB_PANE_LABEL, NEW_WEB_PANE_ACCELERATOR, NEW_WEB_PANE_COMMAND),
        relayRow(deps, COMMAND_PALETTE_LABEL, COMMAND_PALETTE_ACCELERATOR, COMMAND_PALETTE_COMMAND),
        { type: 'separator' },
        // ⌘1…⌘9. The client resolves the POSITION against the sidebar's visible order, exactly
        // as `switch_to_workspace_N` does, so the row and the chord cannot pick different rows.
        ...Array.from({ length: SWITCH_WORKSPACE_ROWS }, (_unused, index) => {
            const position = index + 1;
            return relayRow(
                deps,
                switchWorkspaceLabel(position),
                switchWorkspaceAccelerator(position),
                switchWorkspaceCommand(position)
            );
        }),
        { type: 'separator' },
        // No accelerators: the Swift builds these two as plain `Button`s, outside the binding
        // map (`NexCommands.swift:49-57`), and §4's action list has no name for either.
        {
            label: SELECT_ALL_WORKSPACES_LABEL,
            click: () => {
                if (deps.sendMenuRequest(SELECT_ALL_WORKSPACES_COMMAND)) return;
                deps.onUndelivered?.(SELECT_ALL_WORKSPACES_COMMAND);
            }
        },
        {
            id: DESELECT_ALL_WORKSPACES_MENU_ID,
            label: DESELECT_ALL_WORKSPACES_LABEL,
            // `.disabled(store.selectedWorkspaceIDs.isEmpty)`, and a window that has told us
            // nothing yet has nothing selected — so the safe initial state is also the true one.
            enabled: deps.hasWorkspaceSelection === true,
            click: () => {
                if (deps.sendMenuRequest(DESELECT_ALL_WORKSPACES_COMMAND)) return;
                deps.onUndelivered?.(DESELECT_ALL_WORKSPACES_COMMAND);
            }
        },
        { type: 'separator' },
        /*
         * N14: the macOS Close row, routed rather than native. See `CLOSE_LABEL` above for the
         * race it removes; the row keeps its label and its ⌘W so the menu still reads like a
         * macOS File menu, and only the ACTION changed.
         *
         * The non-darwin tail is untouched: on Windows/Linux this last row is Quit, and ⌘W/⌃W is
         * not a window-close accelerator the OS expects to find here.
         */
        deps.platform === 'darwin'
            ? {
                  label: CLOSE_LABEL,
                  accelerator: CLOSE_ACCELERATOR,
                  click: () => {
                      deps.closeFocusedPane();
                  }
              }
            : { role: 'quit' }
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
 * The macOS application ("Kelpi") submenu: Check for Updates… directly after About, exactly where
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

/**
 * `File ▸ …`, as `main.ts` logs it.
 *
 * Prefix-stable for the same reason the View fragment is: `scripts/smoke.mjs` and the audit's
 * `mac-chrome` both match `New Workspace (⌘N)` and `Preview Markdown… (⌘O)` as substrings, so
 * §WS-151's four extra product rows are INSERTED in the Swift's order rather than the line being
 * reshaped. The nine ⌘1…⌘9 rows are summarised as a range — nine near-identical entries would
 * bury everything else in a line whose whole job is to be read by eye.
 */
export const FILE_MENU_LOG_FRAGMENT =
    `File ▸ ${NEW_WORKSPACE_LABEL} (⌘N) · ${NEW_GROUP_LABEL} (⌘⇧G) · ${OPEN_FILE_LABEL} (⌘O)` +
    ` · ${NEW_WEB_PANE_LABEL} (⌘⇧O) · ${COMMAND_PALETTE_LABEL} (⌘P)` +
    ` · ${switchWorkspaceLabel(1)}–${String(SWITCH_WORKSPACE_ROWS)} (⌘1…⌘${String(SWITCH_WORKSPACE_ROWS)})` +
    ` · ${SELECT_ALL_WORKSPACES_LABEL} · ${DESELECT_ALL_WORKSPACES_LABEL}`;

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
    return `menu: Kelpi ▸ ${updates} · ${FILE_MENU_LOG_FRAGMENT} · ${VIEW_MENU_LOG_FRAGMENT} · Help ▸ Kelpi Help (⌘?)${debug}`;
}
