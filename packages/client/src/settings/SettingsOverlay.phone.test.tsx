/**
 * The Settings sheet on a phone (MOBILE-PLAN.md §4 B5), and the pin that says a desktop did not
 * move.
 *
 * **Every phone rule in this program is an owner-directed divergence from the shipped Swift app**;
 * `chrome/form-factor.ts` carries the standing note and `SettingsOverlay.tsx` states this one.
 *
 * The form factor is driven through the component's injectable `formFactorWindow` because jsdom
 * has no `matchMedia` at all, so a real window there resolves `desktop` forever - which is exactly
 * what makes the desktop half of every file below honest, and what the last `describe` block pins
 * as literal markup.
 */

import { DEFAULT_WS_SETTINGS } from '@kelpi/protocol';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { modalPresenceCount, overlayPresenceCount } from '../chrome/modal-presence';
import { createFakePhoneWindow } from '../phone/testing';
import { SettingsOverlay, type SettingsOverlayProps } from './SettingsOverlay';
import { SETTINGS_TABS } from './catalog';
import type { SettingsActions } from './types';

const NOOP_ACTIONS: SettingsActions = {
    setKeybinding: vi.fn(),
    resetKeybindings: vi.fn(),
    setGeneralSetting: vi.fn(),
    setGhosttySetting: vi.fn(),
    setProfiles: vi.fn(),
    addLabelPreset: vi.fn(),
    updateLabelPreset: vi.fn(),
    removeLabelPreset: vi.fn()
};

function baseProps(): Omit<SettingsOverlayProps, 'onClose'> {
    return {
        open: true,
        settings: DEFAULT_WS_SETTINGS,
        domain: { labelPresets: [], workspaces: [] },
        actions: NOOP_ACTIONS
    };
}

/** A sheet on a phone, with the window the form-factor hook reads handed in. */
function renderPhone(overrides: Partial<SettingsOverlayProps> = {}) {
    const onClose = vi.fn();
    const win = createFakePhoneWindow();
    const view = render(
        <SettingsOverlay {...baseProps()} formFactorWindow={win} onClose={onClose} {...overrides} />
    );
    return { onClose, view, win };
}

afterEach(cleanup);

describe('the Settings sheet on a phone', () => {
    it('fills the screen as a sheet: no window geometry, no scrim, safe areas on its own box', () => {
        renderPhone();
        const backdrop = screen.getByTestId('settings-backdrop');
        const sheet = screen.getByTestId('settings-window');

        // The scrim is gone: the sheet covers the viewport, so there is nothing behind to dim.
        // Read off the style ATTRIBUTE for the blur, because jsdom's CSS parser has no
        // `backdrop-filter` property at all and `style.backdropFilter` is `undefined` there
        // whatever is set - an assertion on the property would pass with the blur still on.
        expect(backdrop.style.background).toContain('--kelpi-surface');
        expect(backdrop.getAttribute('style') ?? '').not.toContain('backdrop-filter');
        expect(backdrop.className).not.toContain('items-center');
        // Positioned against the VIEWPORT, so "fills the screen" does not depend on where B1
        // ends up mounting it (the palette next door is already mounted one level in, §M53).
        expect(backdrop.className).toContain('fixed inset-0');

        expect(sheet.dataset['phoneSheet']).toBe('true');
        expect(sheet.className).toContain('h-full');
        expect(sheet.className).toContain('w-full');
        // The desktop dialog's window geometry is a WINDOW's, and this is not one.
        expect(sheet.className).not.toContain('w-[clamp(560px,92%,880px)]');
        expect(sheet.className).not.toContain('rounded-[10px]');
        expect(sheet.style.boxShadow).toBe('');
        expect(sheet.style.border).toBe('');

        // A3 paints the phone chrome's safe areas on the top bar and the footer; an overlay covers
        // them, so it respects them itself.
        expect(sheet.style.paddingTop).toBe('calc(env(safe-area-inset-top))');
        expect(sheet.style.paddingBottom).toBe('calc(env(safe-area-inset-bottom))');
        expect(sheet.style.paddingLeft).toBe('calc(env(safe-area-inset-left))');
        expect(sheet.style.paddingRight).toBe('calc(env(safe-area-inset-right))');

        // …and it is still the same modal dialog, with the same label.
        expect(sheet.getAttribute('role')).toBe('dialog');
        expect(sheet.getAttribute('aria-modal')).toBe('true');
        expect(sheet.getAttribute('aria-label')).toBe('Settings');
    });

    it('opens on the LIST of tabs, from the same catalog, in the same order, with the same labels', () => {
        renderPhone();
        // No tab content is showing: the landing screen is the list.
        expect(screen.queryByTestId('settings-panel')).toBeNull();
        expect(screen.queryByTestId('settings-tab-general')).toBeNull();
        // …and no rail either.
        expect(screen.queryByTestId('settings-tabs')).toBeNull();

        const list = screen.getByTestId('settings-phone-list');
        const rows = Array.from(list.querySelectorAll<HTMLElement>('button'));
        expect(rows.map((row) => (row.textContent ?? '').trim())).toEqual(
            SETTINGS_TABS.map((entry) => entry.label)
        );
        expect(rows.map((row) => row.dataset['testid'])).toEqual(
            SETTINGS_TABS.map((entry) => `settings-tab-button-${entry.id}`)
        );
        // Each row carries the catalog's glyph, so the two navigations cannot drift.
        expect(rows.map((row) => row.dataset['icon'])).toEqual(SETTINGS_TABS.map((entry) => entry.icon));
        for (const row of rows) expect(row.querySelector('svg')).not.toBeNull();
    });

    it('gives every row a 44 px touch target', () => {
        renderPhone();
        const rows = Array.from(
            screen.getByTestId('settings-phone-list').querySelectorAll<HTMLElement>('button')
        );
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) expect(row.style.minHeight).toBe('44px');
        expect(screen.getByTestId('settings-close').style.minHeight).toBe('44px');
    });

    it('pushes a tab, shows its content behind a back button, and comes back to the list', () => {
        renderPhone();
        fireEvent.click(screen.getByTestId('settings-tab-button-labels'));

        // The tab's own content, rendered by the same component the desktop renders.
        expect(screen.getByTestId('settings-tab-labels')).toBeDefined();
        expect(screen.getByTestId('settings-panel')).toBeDefined();
        expect(screen.queryByTestId('settings-phone-list')).toBeNull();

        // The header carries the back button and the tab's name…
        const toolbar = screen.getByTestId('settings-toolbar');
        expect(toolbar.textContent).toContain('Labels');
        const back = screen.getByTestId('settings-phone-back');
        expect(back.getAttribute('aria-label')).toBe('Back to Settings');
        // …and focus follows the push, which is what keeps Escape reaching the dialog.
        expect(document.activeElement).toBe(back);

        fireEvent.click(back);
        expect(screen.getByTestId('settings-phone-list')).toBeDefined();
        expect(screen.queryByTestId('settings-tab-labels')).toBeNull();
        expect(screen.queryByTestId('settings-phone-back')).toBeNull();
        // Back lands the caret on the row you came from.
        expect(document.activeElement).toBe(screen.getByTestId('settings-tab-button-labels'));
    });

    it('deep-opens straight onto a tab, with the back button', () => {
        renderPhone({ initialTab: 'keybindings' });
        expect(screen.getByTestId('settings-tab-keybindings')).toBeDefined();
        expect(screen.queryByTestId('settings-phone-list')).toBeNull();
        expect(screen.getByTestId('settings-phone-back')).toBeDefined();
        expect(screen.getByTestId('settings-toolbar').textContent).toContain('Keybindings');

        // …and back from a deep link still lands on the list, not on nothing.
        fireEvent.click(screen.getByTestId('settings-phone-back'));
        expect(screen.getByTestId('settings-phone-list')).toBeDefined();
    });

    /*
     * `App.tsx:2667`'s `openSettings(tab = DEFAULT_SETTINGS_TAB)` defaults its argument, so ⌘, the
     * ••• menu, the sidebar and the palette all arrive as `initialTab === 'general'`. That is the
     * "no deep link" case at this boundary and the phone reads it as the landing screen.
     */
    it('treats an explicit General as the landing case, because assembly cannot distinguish it', () => {
        renderPhone({ initialTab: 'general' });
        expect(screen.getByTestId('settings-phone-list')).toBeDefined();
        expect(screen.queryByTestId('settings-tab-general')).toBeNull();
    });

    it('re-derives the screen every time it re-opens', () => {
        const onClose = vi.fn();
        const win = createFakePhoneWindow();
        const props = { ...baseProps(), formFactorWindow: win, onClose };
        const view = render(<SettingsOverlay {...props} initialTab="labels" />);
        // Walk back to the list, close, and re-open on a deep link: the sheet must land on the
        // link's tab, not on wherever the user happened to be last time.
        fireEvent.click(screen.getByTestId('settings-phone-back'));
        expect(screen.getByTestId('settings-phone-list')).toBeDefined();
        view.rerender(<SettingsOverlay {...props} open={false} initialTab="labels" />);
        view.rerender(<SettingsOverlay {...props} initialTab="web" />);
        expect(screen.getByTestId('settings-tab-web')).toBeDefined();
        expect(screen.getByTestId('settings-toolbar').textContent).toContain('Web');
    });

    it('keeps Close reachable on both screens, and closes from either', () => {
        const first = renderPhone();
        fireEvent.click(screen.getByTestId('settings-close'));
        expect(first.onClose).toHaveBeenCalledTimes(1);
        cleanup();

        const second = renderPhone();
        fireEvent.click(screen.getByTestId('settings-tab-button-profiles'));
        expect(screen.getByTestId('settings-close')).toBeDefined();
        fireEvent.click(screen.getByTestId('settings-close'));
        expect(second.onClose).toHaveBeenCalledTimes(1);
    });

    // "Escape behaves as it does today": it closes the sheet, from either screen. The focus rule
    // above is what makes that possible - React only delivers the keydown to the dialog's handler
    // when the target is inside it.
    it('closes on Escape from the list and from a pushed tab', () => {
        const first = renderPhone();
        fireEvent.keyDown(screen.getByTestId('settings-window'), { key: 'Escape' });
        expect(first.onClose).toHaveBeenCalledTimes(1);
        cleanup();

        const second = renderPhone();
        fireEvent.click(screen.getByTestId('settings-tab-button-profiles'));
        fireEvent.keyDown(document.activeElement ?? screen.getByTestId('settings-window'), { key: 'Escape' });
        expect(second.onClose).toHaveBeenCalledTimes(1);
    });

    /*
     * Modal presence, measured rather than assumed: `SettingsOverlay` does not call
     * `useModalPresence` on EITHER form factor. `App.tsx:3576-3577` names `settingsTab !== null`
     * in `modalOpen` directly (the registry is for the surfaces the assembly cannot see), so the
     * contract this file has to keep is that the phone branch registers exactly what the desktop
     * branch does - which is nothing - and therefore that a web pane parks for the same reason and
     * at the same moment on both.
     */
    it('registers modal presence exactly as the desktop branch does', () => {
        const modalsBefore = modalPresenceCount();
        const overlaysBefore = overlayPresenceCount();

        renderPhone();
        const phoneModals = modalPresenceCount() - modalsBefore;
        const phoneOverlays = overlayPresenceCount() - overlaysBefore;
        cleanup();

        render(<SettingsOverlay {...baseProps()} onClose={vi.fn()} />);
        expect(screen.getByTestId('settings-tabs')).toBeDefined();
        expect(modalPresenceCount() - modalsBefore).toBe(phoneModals);
        expect(overlayPresenceCount() - overlaysBefore).toBe(phoneOverlays);
        cleanup();

        // …and both are back to where the file found them.
        expect(modalPresenceCount()).toBe(modalsBefore);
        expect(overlayPresenceCount()).toBe(overlaysBefore);
    });

    // The narrow-desktop-window case the form-factor rule exists to protect: a 390 px viewport
    // with a FINE pointer is a person dragging a window edge on a Mac, not a phone.
    it('is the desktop dialog at a phone size with a fine pointer', () => {
        render(
            <SettingsOverlay
                {...baseProps()}
                formFactorWindow={createFakePhoneWindow({ coarse: false })}
                onClose={vi.fn()}
            />
        );
        expect(screen.getByTestId('settings-tabs')).toBeDefined();
        expect(screen.queryByTestId('settings-phone-list')).toBeNull();
    });
});

/*
 * ── and NOT on desktop ──────────────────────────────────────────────────────────────
 *
 * The guardrail MOBILE-PLAN.md §3.1 states: "a desktop window, an Electron shell and a tablet in
 * landscape must render byte-identical DOM to today". Pinned as the rendered markup rather than as
 * a list of properties, because a property list only catches the properties somebody thought to
 * list. The snapshot was generated from the component as it stood BEFORE B5 (the branch point,
 * `origin/feat/phone-e1-e2-form-factor-harness`) and committed; it passing after the change is the
 * measurement.
 */
describe('the Settings window on a desktop', () => {
    it('renders byte-identical markup to the one that shipped before B5', () => {
        render(<SettingsOverlay {...baseProps()} onClose={vi.fn()} />);
        expect(screen.getByTestId('settings-backdrop').outerHTML).toMatchSnapshot();
    });

    it('renders byte-identical markup on a deep-linked tab too', () => {
        render(<SettingsOverlay {...baseProps()} initialTab="workspaces" onClose={vi.fn()} />);
        expect(screen.getByTestId('settings-backdrop').outerHTML).toMatchSnapshot();
    });
});
