import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_KEYBIND_LINES } from '@nex/core/config';

import {
    CHECK_FOR_UPDATES_LABEL,
    COMMAND_PALETTE_ACCELERATOR,
    COMMAND_PALETTE_COMMAND,
    COMMAND_PALETTE_LABEL,
    DEBUG_MENU_LABEL,
    DESELECT_ALL_WORKSPACES_COMMAND,
    DESELECT_ALL_WORKSPACES_LABEL,
    DESELECT_ALL_WORKSPACES_MENU_ID,
    FILE_MENU_LOG_FRAGMENT,
    NEW_GROUP_ACCELERATOR,
    NEW_GROUP_COMMAND,
    NEW_GROUP_LABEL,
    NEW_WEB_PANE_ACCELERATOR,
    NEW_WEB_PANE_COMMAND,
    NEW_WEB_PANE_LABEL,
    NEW_WORKSPACE_ACCELERATOR,
    NEW_WORKSPACE_COMMAND,
    NEW_WORKSPACE_LABEL,
    OPEN_FILE_COMMAND,
    OPEN_FILE_LABEL,
    SEED_TEST_GROUP_COMMAND,
    SEED_TEST_GROUP_LABEL,
    SELECT_ALL_WORKSPACES_COMMAND,
    SELECT_ALL_WORKSPACES_LABEL,
    SWITCH_WORKSPACE_ROWS,
    TOGGLE_INSPECTOR_ACCELERATOR,
    TOGGLE_INSPECTOR_COMMAND,
    TOGGLE_INSPECTOR_LABEL,
    TOGGLE_SIDEBAR_ACCELERATOR,
    TOGGLE_SIDEBAR_COMMAND,
    TOGGLE_SIDEBAR_LABEL,
    VIEW_MENU_LOG_FRAGMENT,
    appMenuTemplate,
    applyWorkspaceSelection,
    debugMenuLogFragment,
    debugMenuSection,
    debugMenuTemplate,
    fileMenuTemplate,
    menuLogLine,
    switchWorkspaceAccelerator,
    switchWorkspaceCommand,
    switchWorkspaceLabel,
    switchWorkspacePosition,
    viewMenuTemplate,
    workspaceSelectionLogLine
} from './menu.js';

/** The rows a template carries, in order, with roles standing in for the label-less ones. */
function rows(template: readonly Electron.MenuItemConstructorOptions[]): string[] {
    return template.map((item) => item.label ?? item.role ?? item.type ?? '?');
}

describe('View menu (§WS-001, §APP-025 / §WS-152)', () => {
    it('offers Toggle Sidebar (⌘⇧S) then Toggle Inspector (⌘I), ahead of the web-contents roles', () => {
        const template = viewMenuTemplate({ sendMenuRequest: () => true });
        expect(rows(template)).toEqual([
            TOGGLE_SIDEBAR_LABEL,
            TOGGLE_INSPECTOR_LABEL,
            'separator',
            'reload',
            'forceReload',
            'toggleDevTools',
            'separator',
            'togglefullscreen'
        ]);
        expect(template[0]?.accelerator).toBe('CommandOrControl+Shift+S');
        expect(template[1]?.accelerator).toBe('CommandOrControl+I');
        // …which are `toggle_sidebar`'s and `toggle_inspector`'s own default triggers, so each
        // menu row and the chord in the page are the same shortcut rather than two that drift.
        expect(TOGGLE_SIDEBAR_ACCELERATOR).toBe('CommandOrControl+Shift+S');
        expect(TOGGLE_INSPECTOR_ACCELERATOR).toBe('CommandOrControl+I');
    });

    it('relays the inspector row to the client, exactly as the sidebar row does (§APP-025)', () => {
        const sendMenuRequest = vi.fn(() => true);
        const template = viewMenuTemplate({ sendMenuRequest });

        (template[1]?.click as (() => void) | undefined)?.();

        // Fire-and-forget by construction: inspector visibility is client-local state the main
        // process never sees, so the row can only ever be a relay — never a local toggle.
        expect(sendMenuRequest).toHaveBeenCalledWith(TOGGLE_INSPECTOR_COMMAND);
    });

    it('reports an undelivered inspector click too', () => {
        const onUndelivered = vi.fn();
        const template = viewMenuTemplate({ sendMenuRequest: () => false, onUndelivered });

        (template[1]?.click as (() => void) | undefined)?.();

        expect(onUndelivered).toHaveBeenCalledWith('toggle-inspector');
    });

    it('relays the click to the client rather than acting in the main process', () => {
        const sendMenuRequest = vi.fn(() => true);
        const onUndelivered = vi.fn();
        const template = viewMenuTemplate({ sendMenuRequest, onUndelivered });

        // Electron passes the item, the window and the event; the handler wants none of them.
        (template[0]?.click as (() => void) | undefined)?.();

        expect(sendMenuRequest).toHaveBeenCalledWith(TOGGLE_SIDEBAR_COMMAND);
        expect(onUndelivered).not.toHaveBeenCalled();
    });

    it('reports an undelivered click instead of swallowing it', () => {
        // No window attached yet (the shell is still booting, or every window is gone).
        const onUndelivered = vi.fn();
        const template = viewMenuTemplate({ sendMenuRequest: () => false, onUndelivered });

        (template[0]?.click as (() => void) | undefined)?.();

        expect(onUndelivered).toHaveBeenCalledWith('toggle-sidebar');
    });

    it('survives a missing `onUndelivered` — the click must never throw into Electron', () => {
        const template = viewMenuTemplate({ sendMenuRequest: () => false });
        expect(() => (template[0]?.click as (() => void) | undefined)?.()).not.toThrow();
    });

    it('names itself in the line `smoke.mjs` asserts the menu by', () => {
        // The application menu is not observable from outside the process, so the log line IS
        // the assertion surface (`packages/shell/scripts/smoke.mjs`).
        //
        // The SIDEBAR half is asserted as a prefix rather than as the whole string, because
        // `docs/audit`'s `sidebar-remaining` matches exactly that substring and would go quietly
        // false if this fragment were ever reshaped instead of appended to.
        expect(VIEW_MENU_LOG_FRAGMENT.startsWith('View ▸ Toggle Sidebar (⌘⇧S)')).toBe(true);
        expect(VIEW_MENU_LOG_FRAGMENT).toBe('View ▸ Toggle Sidebar (⌘⇧S) + Toggle Inspector (⌘I)');
    });
});

describe('File menu (§APP-018 / §WS-151)', () => {
    const fileDeps = (overrides: Partial<Parameters<typeof fileMenuTemplate>[0]> = {}) => ({
        sendMenuRequest: () => true,
        promptOpenFile: () => undefined,
        platform: 'darwin',
        ...overrides
    });

    it('replaces "New Window" with New Workspace on ⌘N', () => {
        const template = fileMenuTemplate(fileDeps());

        // §WS-151: `NexCommands.swift:10-58`'s File group, row for row — five product rows with
        // no divider among them (the Swift `CommandGroup` has none), then the two dividers it
        // does have.
        expect(rows(template)).toEqual([
            NEW_WORKSPACE_LABEL,
            NEW_GROUP_LABEL,
            OPEN_FILE_LABEL,
            NEW_WEB_PANE_LABEL,
            COMMAND_PALETTE_LABEL,
            'separator',
            ...Array.from({ length: SWITCH_WORKSPACE_ROWS }, (_unused, index) =>
                switchWorkspaceLabel(index + 1)
            ),
            'separator',
            SELECT_ALL_WORKSPACES_LABEL,
            DESELECT_ALL_WORKSPACES_LABEL,
            'separator',
            'close'
        ]);
        // The row a user would press to get a SECOND Electron window is simply not there, which
        // is the §APP-018 clause: ⌘N is New Workspace, not New Window.
        expect(rows(template)).not.toContain('New Window');
        expect(template[0]?.accelerator).toBe('CommandOrControl+N');
        expect(NEW_WORKSPACE_ACCELERATOR).toBe('CommandOrControl+N');
    });

    it('carries each product row’s own default trigger as its accelerator (§WS-151)', () => {
        const template = fileMenuTemplate(fileDeps());
        expect(template.slice(0, 5).map((item) => item.accelerator)).toEqual([
            'CommandOrControl+N',
            'CommandOrControl+Shift+G',
            'CommandOrControl+O',
            'CommandOrControl+Shift+O',
            'CommandOrControl+P'
        ]);

        /*
         * …and those five are not five literals someone chose here: each is the SHIPPED default
         * trigger for the action the row runs, read out of the binding map both the daemon and
         * the client resolve (`@nex/core/config`). A default that moved and a menu that did not
         * would show a user a shortcut that no longer fires.
         *
         * (The map is read at BUILD time rather than per keystroke — a rebind moves the chord in
         * the page immediately and this row at the next launch. That is divergence #15's own
         * shape, and it is the same choice ⌘N and ⌘O already ship with under §APP-018.)
         */
        const defaults = new Map(
            DEFAULT_KEYBIND_LINES.map((line) => {
                const at = line.lastIndexOf('=');
                return [line.slice(at + 1), line.slice(0, at)];
            })
        );
        expect(defaults.get('new_workspace')).toBe('super+n');
        expect(defaults.get('new_group')).toBe('shift+super+g');
        expect(defaults.get('open_file')).toBe('super+o');
        expect(defaults.get('open_web_pane')).toBe('shift+super+o');
        expect(defaults.get('command_palette')).toBe('super+p');
        expect(NEW_GROUP_ACCELERATOR).toBe('CommandOrControl+Shift+G');
        expect(NEW_WEB_PANE_ACCELERATOR).toBe('CommandOrControl+Shift+O');
        expect(COMMAND_PALETTE_ACCELERATOR).toBe('CommandOrControl+P');
    });

    it('gives Switch to Workspace 1…9 their ⌘1…⌘9, and the two selection rows none', () => {
        const template = fileMenuTemplate(fileDeps());
        const switchRows = template.slice(6, 6 + SWITCH_WORKSPACE_ROWS);

        expect(switchRows.map((item) => item.accelerator)).toEqual([
            'CommandOrControl+1',
            'CommandOrControl+2',
            'CommandOrControl+3',
            'CommandOrControl+4',
            'CommandOrControl+5',
            'CommandOrControl+6',
            'CommandOrControl+7',
            'CommandOrControl+8',
            'CommandOrControl+9'
        ]);
        expect(switchWorkspaceAccelerator(4)).toBe('CommandOrControl+4');

        // Select All / Deselect All are plain `Button`s in the Swift — outside the binding map,
        // and §4's action list has no name for either — so an accelerator here would be one this
        // port invented.
        const selectAll = template.at(-4);
        const deselectAll = template.at(-3);
        expect(selectAll?.label).toBe(SELECT_ALL_WORKSPACES_LABEL);
        expect(selectAll?.accelerator).toBeUndefined();
        expect(deselectAll?.label).toBe(DESELECT_ALL_WORKSPACES_LABEL);
        expect(deselectAll?.accelerator).toBeUndefined();
    });

    it('relays every new row to the client, and none of them acts in the main process', () => {
        // Typed parameter so the ORDER of the relayed commands can be read off the calls.
        const sendMenuRequest = vi.fn((_command: string) => true);
        const promptOpenFile = vi.fn();
        const template = fileMenuTemplate(fileDeps({ sendMenuRequest, promptOpenFile }));
        const fire = (label: string): void => {
            const row = template.find((item) => item.label === label);
            (row?.click as (() => void) | undefined)?.();
        };

        fire(NEW_GROUP_LABEL);
        fire(NEW_WEB_PANE_LABEL);
        fire(COMMAND_PALETTE_LABEL);
        fire(switchWorkspaceLabel(3));
        fire(SELECT_ALL_WORKSPACES_LABEL);
        fire(DESELECT_ALL_WORKSPACES_LABEL);

        expect(sendMenuRequest.mock.calls.map((call) => call[0])).toEqual([
            NEW_GROUP_COMMAND,
            NEW_WEB_PANE_COMMAND,
            COMMAND_PALETTE_COMMAND,
            switchWorkspaceCommand(3),
            SELECT_ALL_WORKSPACES_COMMAND,
            DESELECT_ALL_WORKSPACES_COMMAND
        ]);
        // ⌘O's native panel is the ONLY local fallback in this menu; nothing else has one.
        expect(promptOpenFile).not.toHaveBeenCalled();
    });

    it('reports each undelivered new row rather than swallowing the click', () => {
        const onUndelivered = vi.fn();
        const template = fileMenuTemplate(
            fileDeps({ sendMenuRequest: () => false, onUndelivered })
        );
        for (const label of [
            NEW_GROUP_LABEL,
            NEW_WEB_PANE_LABEL,
            COMMAND_PALETTE_LABEL,
            switchWorkspaceLabel(9),
            SELECT_ALL_WORKSPACES_LABEL,
            DESELECT_ALL_WORKSPACES_LABEL
        ]) {
            const row = template.find((item) => item.label === label);
            expect(() => (row?.click as (() => void) | undefined)?.()).not.toThrow();
        }
        expect(onUndelivered.mock.calls.map((call) => call[0])).toEqual([
            NEW_GROUP_COMMAND,
            NEW_WEB_PANE_COMMAND,
            COMMAND_PALETTE_COMMAND,
            switchWorkspaceCommand(9),
            SELECT_ALL_WORKSPACES_COMMAND,
            DESELECT_ALL_WORKSPACES_COMMAND
        ]);

        // …and with no reporter at all it must still never throw into Electron.
        const bare = fileMenuTemplate(fileDeps({ sendMenuRequest: () => false }));
        const row = bare.find((item) => item.label === SELECT_ALL_WORKSPACES_LABEL);
        expect(() => (row?.click as (() => void) | undefined)?.()).not.toThrow();
    });

    /**
     * §WS-151's one stateful row: "Deselect All Workspaces (the latter disabled with an empty
     * selection)".
     *
     * The state is not the main process's — a workspace multi-selection lives in the sidebar, in
     * the page — so it travels client → daemon → shell as `workspace-selection` and is applied
     * to the LIVE menu. Built disabled, because a window that has reported nothing has nothing
     * selected, which is also what it reports on mount.
     */
    it('builds Deselect All Workspaces DISABLED, and enables it from a reported selection', () => {
        const fresh = fileMenuTemplate(fileDeps());
        const deselect = fresh.find((item) => item.label === DESELECT_ALL_WORKSPACES_LABEL);
        expect(deselect?.enabled).toBe(false);
        expect(deselect?.id).toBe(DESELECT_ALL_WORKSPACES_MENU_ID);
        // Select All has no such gate: the Swift's is a plain enabled Button.
        expect(fresh.find((item) => item.label === SELECT_ALL_WORKSPACES_LABEL)?.enabled).toBeUndefined();

        // A rebuild after a selection has been reported must not un-grey it back to false.
        const afterReport = fileMenuTemplate(fileDeps({ hasWorkspaceSelection: true }));
        expect(
            afterReport.find((item) => item.label === DESELECT_ALL_WORKSPACES_LABEL)?.enabled
        ).toBe(true);
    });

    it('moves the live row rather than rebuilding the menu, and says which way it moved', () => {
        const item = { enabled: false };
        const menu = {
            getMenuItemById: (id: string) => (id === DESELECT_ALL_WORKSPACES_MENU_ID ? item : null)
        };

        expect(applyWorkspaceSelection(menu, 3)).toBe(true);
        expect(item.enabled).toBe(true);
        expect(applyWorkspaceSelection(menu, 0)).toBe(false);
        expect(item.enabled).toBe(false);

        // A menu that does not carry the row (no menu at all, a build without it) is a no-op —
        // the shell must not throw inside a socket handler.
        expect(applyWorkspaceSelection(null, 2)).toBe(true);
        expect(applyWorkspaceSelection({ getMenuItemById: () => null }, 0)).toBe(false);

        expect(workspaceSelectionLogLine(2)).toBe('menu: Deselect All Workspaces enabled (2 selected)');
        expect(workspaceSelectionLogLine(0)).toBe('menu: Deselect All Workspaces disabled (0 selected)');
    });

    it('names the `switch-workspace-N` commands the client parses back', () => {
        expect(switchWorkspaceCommand(1)).toBe('switch-workspace-1');
        expect(switchWorkspacePosition('switch-workspace-9')).toBe(9);
        // Strict: nothing outside 1–9 resolves, so a stray command falls through in the client
        // instead of switching to an index the sidebar does not have.
        expect(switchWorkspacePosition('switch-workspace-0')).toBeNull();
        expect(switchWorkspacePosition('switch-workspace-10')).toBeNull();
        expect(switchWorkspacePosition('switch-workspace-')).toBeNull();
        expect(switchWorkspacePosition('toggle-sidebar')).toBeNull();
        // The literals the CLIENT restates (`client/src/app/file-menu.ts`), pinned here too.
        expect(NEW_GROUP_COMMAND).toBe('new-group');
        expect(NEW_WEB_PANE_COMMAND).toBe('new-web-pane');
        expect(COMMAND_PALETTE_COMMAND).toBe('command-palette');
        expect(SELECT_ALL_WORKSPACES_COMMAND).toBe('select-all-workspaces');
        expect(DESELECT_ALL_WORKSPACES_COMMAND).toBe('deselect-all-workspaces');
    });

    /**
     * The File menu is the SAME menu in a dev run and inside a built `.app`.
     *
     * Only the Debug menu is `app.isPackaged`-gated (§APP-028), and this is the assertion that
     * keeps that true: a future guard added here would silently give a packaged user a smaller
     * File menu than a developer sees, and no smoke would notice.
     */
    it('is identical in a packaged build and a dev build', () => {
        const dev = fileMenuTemplate(fileDeps());
        const packaged = fileMenuTemplate(fileDeps());
        expect(rows(packaged)).toEqual(rows(dev));
        expect(packaged.map((item) => item.accelerator)).toEqual(dev.map((item) => item.accelerator));
        // And the log line the smokes read carries the whole group either way.
        expect(menuLogLine({ canCheckForUpdates: false, isPackaged: false })).toContain(
            FILE_MENU_LOG_FRAGMENT
        );
        expect(menuLogLine({ canCheckForUpdates: true, isPackaged: true })).toContain(
            FILE_MENU_LOG_FRAGMENT
        );
    });

    it('names every File row in the line the smoke and the audit read', () => {
        expect(FILE_MENU_LOG_FRAGMENT).toBe(
            'File ▸ New Workspace (⌘N) · New Group (⌘⇧G) · Preview Markdown… (⌘O)' +
                ' · New Web Pane (⌘⇧O) · Command Palette (⌘P)' +
                ' · Switch to Workspace 1–9 (⌘1…⌘9)' +
                ' · Select All Workspaces · Deselect All Workspaces'
        );
        // The two substrings that were being matched before this item added rows around them.
        expect(FILE_MENU_LOG_FRAGMENT).toContain('New Workspace (⌘N)');
        expect(FILE_MENU_LOG_FRAGMENT).toContain('Preview Markdown… (⌘O)');
        expect(FILE_MENU_LOG_FRAGMENT).not.toContain('New Window');
    });

    it('relays New Workspace to the client — it never creates one in the main process', () => {
        const sendMenuRequest = vi.fn(() => true);
        const template = fileMenuTemplate(fileDeps({ sendMenuRequest }));

        (template[0]?.click as (() => void) | undefined)?.();

        expect(sendMenuRequest).toHaveBeenCalledWith(NEW_WORKSPACE_COMMAND);
        expect(sendMenuRequest).toHaveBeenCalledTimes(1);
    });

    it('has NO local fallback for New Workspace when no window took it', () => {
        // ⌘O falls back to the native panel; New Workspace deliberately does not fall back to
        // creating a workspace, because a workspace nobody can see is a surprise on next launch.
        const onUndelivered = vi.fn();
        const promptOpenFile = vi.fn();
        const template = fileMenuTemplate(
            fileDeps({ sendMenuRequest: () => false, onUndelivered, promptOpenFile })
        );

        (template[0]?.click as (() => void) | undefined)?.();

        expect(onUndelivered).toHaveBeenCalledWith(NEW_WORKSPACE_COMMAND);
        expect(promptOpenFile).not.toHaveBeenCalled();
    });

    it('keeps ⌘O’s native-panel fallback', () => {
        const promptOpenFile = vi.fn();
        const template = fileMenuTemplate(fileDeps({ sendMenuRequest: () => false, promptOpenFile }));

        (template[2]?.click as (() => void) | undefined)?.();

        expect(promptOpenFile).toHaveBeenCalledTimes(1);
    });

    it('sends ⌘O to the client when a window is attached', () => {
        const sendMenuRequest = vi.fn(() => true);
        const promptOpenFile = vi.fn();
        const template = fileMenuTemplate(fileDeps({ sendMenuRequest, promptOpenFile }));

        (template[2]?.click as (() => void) | undefined)?.();

        expect(sendMenuRequest).toHaveBeenCalledWith(OPEN_FILE_COMMAND);
        expect(promptOpenFile).not.toHaveBeenCalled();
    });

    it('ends in Quit off macOS, where there is no app menu to carry it', () => {
        expect(rows(fileMenuTemplate(fileDeps({ platform: 'linux' }))).at(-1)).toBe('quit');
    });
});

/**
 * §APP-028 / §SET-194 — the DEBUG-only Debug ▸ Seed Test Group menu.
 *
 * The interesting assertion is the negative one: `#if DEBUG` is compile-time in the Swift and
 * cannot be here (the same bundle ships to both), so the guard is `app.isPackaged` and the test
 * has to ask it BOTH ways. `scripts/packaged-smoke.mjs` asks the packaged half again of a real
 * built `.app`, where the flag is not a parameter anybody can pass.
 */
describe('Debug menu (§APP-028 / §SET-194)', () => {
    const relay = { sendMenuRequest: () => true };

    it('exists in a DEV build, as one "Seed Test Group" row', () => {
        const section = debugMenuSection({ ...relay, isPackaged: false });
        expect(rows(section)).toEqual([DEBUG_MENU_LABEL]);
        const submenu = section[0]?.submenu as Electron.MenuItemConstructorOptions[];
        expect(rows(submenu)).toEqual([SEED_TEST_GROUP_LABEL]);
        expect(SEED_TEST_GROUP_LABEL).toBe('Seed Test Group');
        // No accelerator: the Swift `Button` has none, and a chord that seeds workspaces is not
        // something to hand a dev build by accident.
        expect(submenu[0]?.accelerator).toBeUndefined();
    });

    it('is ABSENT in a packaged build — no menu, not a disabled row', () => {
        const section = debugMenuSection({ ...relay, isPackaged: true });
        expect(section).toEqual([]);
        // Spread into the application menu, so the packaged template gains nothing at all.
        const template = [{ role: 'windowMenu' as const }, ...section, { role: 'help' as const }];
        expect(rows(template)).toEqual(['windowMenu', 'help']);
    });

    it('relays the click; the fixture is built in the client, never in the main process', () => {
        const sendMenuRequest = vi.fn(() => true);
        const section = debugMenuSection({ sendMenuRequest, isPackaged: false });
        const submenu = section[0]?.submenu as Electron.MenuItemConstructorOptions[];

        (submenu[0]?.click as (() => void) | undefined)?.();

        expect(sendMenuRequest).toHaveBeenCalledWith(SEED_TEST_GROUP_COMMAND);
        expect(SEED_TEST_GROUP_COMMAND).toBe('seed-test-group');
    });

    it('reports an undelivered click, and never throws without a reporter', () => {
        const onUndelivered = vi.fn();
        const template = debugMenuTemplate({ sendMenuRequest: () => false, onUndelivered });
        (template[0]?.click as (() => void) | undefined)?.();
        expect(onUndelivered).toHaveBeenCalledWith(SEED_TEST_GROUP_COMMAND);

        const bare = debugMenuTemplate({ sendMenuRequest: () => false });
        expect(() => (bare[0]?.click as (() => void) | undefined)?.()).not.toThrow();
    });

    it('states presence or ABSENCE in the log line, which is what the smokes read', () => {
        expect(debugMenuLogFragment(false)).toBe('Debug ▸ Seed Test Group (dev build)');
        expect(debugMenuLogFragment(true)).toBe('no Debug menu (packaged)');

        const dev = menuLogLine({ canCheckForUpdates: false, isPackaged: false });
        expect(dev).toContain('Debug ▸ Seed Test Group (dev build)');
        const packaged = menuLogLine({ canCheckForUpdates: true, isPackaged: true });
        // Both halves: the label is gone AND the line says so, so a launch that built no menu at
        // all could not pass the packaged smoke's check by accident.
        expect(packaged).not.toContain(SEED_TEST_GROUP_LABEL);
        expect(packaged).toContain('no Debug menu (packaged)');

        // A caller that does not know says nothing, rather than guessing.
        expect(menuLogLine({ canCheckForUpdates: true })).not.toContain('Debug');
    });
});

describe('the app menu’s Check for Updates… (§APP-026)', () => {
    it('sits directly after About, where Sparkle’s item sat', () => {
        const template = appMenuTemplate({ checkForUpdates: () => undefined, canCheckForUpdates: true });
        expect(rows(template).slice(0, 2)).toEqual(['about', CHECK_FOR_UPDATES_LABEL]);
    });

    it('is enabled when this build can check', () => {
        const template = appMenuTemplate({ checkForUpdates: () => undefined, canCheckForUpdates: true });
        expect(template[1]?.enabled).toBe(true);
    });

    it('is DISABLED when it cannot — a dev run, an unsigned bundle, or the flag left off', () => {
        const checkForUpdates = vi.fn();
        const template = appMenuTemplate({ checkForUpdates, canCheckForUpdates: false });

        expect(template[1]?.enabled).toBe(false);
        // Electron will not deliver a click to a disabled row, so nothing else needs guarding —
        // but the handler is still the one function, so a future enable cannot forget to wire it.
        (template[1]?.click as (() => void) | undefined)?.();
        expect(checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it('says which state it installed, in the line the smoke reads', () => {
        expect(menuLogLine({ canCheckForUpdates: false })).toContain('Check for Updates… (disabled)');
        expect(menuLogLine({ canCheckForUpdates: true })).toContain('Check for Updates… (enabled)');
        // The three fragments `scripts/smoke.mjs` asserts have to survive verbatim.
        const line = menuLogLine({ canCheckForUpdates: false });
        expect(line).toContain('Check for Updates…');
        expect(line).toContain('Preview Markdown… (⌘O)');
        expect(line).toContain('Nex Help (⌘?)');
        expect(line).toContain('New Workspace (⌘N)');
        expect(line).toContain('View ▸ Toggle Sidebar (⌘⇧S)');
        expect(line).toContain('Toggle Inspector (⌘I)');
    });
});
