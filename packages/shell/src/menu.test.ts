import { describe, expect, it, vi } from 'vitest';

import {
    CHECK_FOR_UPDATES_LABEL,
    DEBUG_MENU_LABEL,
    NEW_WORKSPACE_ACCELERATOR,
    NEW_WORKSPACE_COMMAND,
    NEW_WORKSPACE_LABEL,
    OPEN_FILE_COMMAND,
    OPEN_FILE_LABEL,
    SEED_TEST_GROUP_COMMAND,
    SEED_TEST_GROUP_LABEL,
    TOGGLE_INSPECTOR_ACCELERATOR,
    TOGGLE_INSPECTOR_COMMAND,
    TOGGLE_INSPECTOR_LABEL,
    TOGGLE_SIDEBAR_ACCELERATOR,
    TOGGLE_SIDEBAR_COMMAND,
    TOGGLE_SIDEBAR_LABEL,
    VIEW_MENU_LOG_FRAGMENT,
    appMenuTemplate,
    debugMenuLogFragment,
    debugMenuSection,
    debugMenuTemplate,
    fileMenuTemplate,
    menuLogLine,
    viewMenuTemplate
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

        expect(rows(template)).toEqual([
            NEW_WORKSPACE_LABEL,
            'separator',
            OPEN_FILE_LABEL,
            'separator',
            'close'
        ]);
        // The row a user would press to get a SECOND Electron window is simply not there, which
        // is the §APP-018 clause: ⌘N is New Workspace, not New Window.
        expect(rows(template)).not.toContain('New Window');
        expect(template[0]?.accelerator).toBe('CommandOrControl+N');
        expect(NEW_WORKSPACE_ACCELERATOR).toBe('CommandOrControl+N');
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
