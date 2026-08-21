import { describe, expect, it, vi } from 'vitest';

import {
    TOGGLE_SIDEBAR_ACCELERATOR,
    TOGGLE_SIDEBAR_COMMAND,
    TOGGLE_SIDEBAR_LABEL,
    VIEW_MENU_LOG_FRAGMENT,
    viewMenuTemplate
} from './menu.js';

/** The rows a template carries, in order, with roles standing in for the label-less ones. */
function rows(template: readonly Electron.MenuItemConstructorOptions[]): string[] {
    return template.map((item) => item.label ?? item.role ?? item.type ?? '?');
}

describe('View menu (§WS-001)', () => {
    it('offers Toggle Sidebar on ⌘⇧S, ahead of the web-contents roles', () => {
        const template = viewMenuTemplate({ sendMenuRequest: () => true });
        expect(rows(template)).toEqual([
            TOGGLE_SIDEBAR_LABEL,
            'separator',
            'reload',
            'forceReload',
            'toggleDevTools',
            'separator',
            'togglefullscreen'
        ]);
        expect(template[0]?.accelerator).toBe('CommandOrControl+Shift+S');
        // …which is `toggle_sidebar`'s own default trigger, so the menu row and the chord in
        // the page are the same shortcut rather than two that drift apart.
        expect(TOGGLE_SIDEBAR_ACCELERATOR).toBe('CommandOrControl+Shift+S');
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
        expect(VIEW_MENU_LOG_FRAGMENT).toBe('View ▸ Toggle Sidebar (⌘⇧S)');
    });
});
