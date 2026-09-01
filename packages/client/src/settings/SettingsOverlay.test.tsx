import { DEFAULT_WS_SETTINGS } from '@kelpi/protocol';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsOverlay } from './SettingsOverlay';
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

function setup(overrides: Partial<Parameters<typeof SettingsOverlay>[0]> = {}) {
    const onClose = vi.fn();
    const view = render(
        <SettingsOverlay
            open
            settings={DEFAULT_WS_SETTINGS}
            domain={{ labelPresets: [], workspaces: [] }}
            actions={NOOP_ACTIONS}
            onClose={onClose}
            {...overrides}
        />
    );
    return { onClose, view };
}

afterEach(cleanup);

describe('the Settings window', () => {
    it('renders nothing while closed', () => {
        render(
            <SettingsOverlay
                open={false}
                settings={DEFAULT_WS_SETTINGS}
                domain={{ labelPresets: [], workspaces: [] }}
                actions={NOOP_ACTIONS}
                onClose={vi.fn()}
            />
        );
        expect(screen.queryByTestId('settings-window')).toBeNull();
    });

    // H13: `SettingsView.swift:13` — `selectedTab: SettingsTab = .general`.
    it('is a modal dialog opening on the General tab', () => {
        setup();
        const dialog = screen.getByRole('dialog', { name: 'Settings' });
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(screen.getByTestId('settings-tab-general')).toBeDefined();
        expect(screen.getByTestId('settings-tab-button-general').getAttribute('aria-selected')).toBe('true');
        expect(screen.queryByTestId('settings-tab-keybindings')).toBeNull();
    });

    // H13: the rail's order is `SettingsTab`'s, read off the rendered buttons rather than the
    // table they come from — a rail that renders in some other order would still pass a check
    // against the table.
    it('renders the rail in the shipped app’s order', () => {
        setup();
        const labels = Array.from(
            screen.getByTestId('settings-tabs').querySelectorAll<HTMLElement>('[role="tab"]')
        ).map((node) => (node.textContent ?? '').trim());
        expect(labels.slice(0, 7)).toEqual([
            'General',
            'Appearance',
            'Repositories',
            'Labels',
            'Profiles',
            'Keybindings',
            'Web'
        ]);
    });

    it('honours a deep link to a specific tab', () => {
        setup({ initialTab: 'labels' });
        expect(screen.getByTestId('settings-tab-labels')).toBeDefined();
    });

    it('switches tabs on click', () => {
        setup();
        fireEvent.click(screen.getByTestId('settings-tab-button-profiles'));
        expect(screen.getByTestId('settings-tab-profiles')).toBeDefined();
        expect(screen.queryByTestId('settings-tab-general')).toBeNull();
    });

    it('moves between tabs with the arrow keys, wrapping, and jumps with Home/End', () => {
        setup();
        const rail = screen.getByTestId('settings-tabs');
        // General is first, so ArrowDown from it lands on Appearance — the Swift order.
        fireEvent.keyDown(rail, { key: 'ArrowDown' });
        expect(screen.getByTestId('settings-tab-appearance')).toBeDefined();
        fireEvent.keyDown(rail, { key: 'ArrowUp' });
        expect(screen.getByTestId('settings-tab-general')).toBeDefined();
        // …and ArrowUp from the FIRST tab wraps to the last, which is the port-only Remote.
        fireEvent.keyDown(rail, { key: 'ArrowUp' });
        expect(screen.getByTestId('settings-tab-remote')).toBeDefined();
        fireEvent.keyDown(rail, { key: 'Home' });
        expect(screen.getByTestId('settings-tab-general')).toBeDefined();
        fireEvent.keyDown(rail, { key: 'End' });
        expect(screen.getByTestId('settings-tab-remote')).toBeDefined();
    });

    it('keeps a roving tabindex so Tab lands on the selected tab only', () => {
        setup();
        const selected = screen.getByTestId('settings-tab-button-general');
        const other = screen.getByTestId('settings-tab-button-labels');
        expect(selected.getAttribute('tabindex')).toBe('0');
        expect(other.getAttribute('tabindex')).toBe('-1');
        expect(document.activeElement).toBe(selected);
    });

    /*
     * H11. The rail was inert: `grep -c hover packages/client/src/settings/*.tsx` returned 0 for
     * all 24 files, so nothing on any tab answered the pointer. The state is asserted through
     * `data-hovered` (the attribute `chrome/ContextMenu.tsx` puts on a highlighted menu row)
     * plus the painted fill, so this cannot pass on the attribute alone.
     */
    it('lights an unselected rail tab under the pointer, and leaves the selected one alone', () => {
        setup();
        const unselected = screen.getByTestId('settings-tab-button-labels');
        expect(unselected.dataset['hovered']).toBe('false');
        expect(unselected.style.background).toBe('transparent');

        fireEvent.mouseEnter(unselected);
        expect(unselected.dataset['hovered']).toBe('true');
        expect(unselected.style.background).toContain('--kelpi-selection-fill');

        fireEvent.mouseLeave(unselected);
        expect(unselected.dataset['hovered']).toBe('false');
        expect(unselected.style.background).toBe('transparent');

        // The selected tab keeps its own fill: the rail never shows two lit rows at once.
        const selected = screen.getByTestId('settings-tab-button-general');
        const before = selected.style.background;
        fireEvent.mouseEnter(selected);
        expect(selected.dataset['hovered']).toBe('false');
        expect(selected.style.background).toBe(before);
    });

    it('lights the buttons too — the recipe is one, not per-tab', () => {
        setup();
        const close = screen.getByTestId('settings-close');
        expect(close.style.background).toBe('transparent');
        fireEvent.mouseEnter(close);
        expect(close.dataset['hovered']).toBe('true');
        expect(close.style.background).toContain('--kelpi-selection-fill');
        expect(close.style.borderColor).toContain('--kelpi-selection-stroke');
    });

    // SET-004: the dialog has a toolbar strip of its own (the Swift window's toolbar), and it
    // names the tab you are on so the window says what it is showing.
    it('carries a toolbar strip that names the current tab', () => {
        setup();
        const toolbar = screen.getByTestId('settings-toolbar');
        expect(toolbar.textContent).toContain('Settings');
        expect(toolbar.textContent).toContain('General');
        fireEvent.click(screen.getByTestId('settings-tab-button-labels'));
        expect(screen.getByTestId('settings-toolbar').textContent).toContain('Labels');
    });

    it('closes on Escape, on the Close button, and on a backdrop click', () => {
        const first = setup();
        fireEvent.keyDown(screen.getByTestId('settings-window'), { key: 'Escape' });
        expect(first.onClose).toHaveBeenCalledTimes(1);
        cleanup();

        const second = setup();
        fireEvent.click(screen.getByTestId('settings-close'));
        expect(second.onClose).toHaveBeenCalledTimes(1);
        cleanup();

        const third = setup();
        fireEvent.mouseDown(screen.getByTestId('settings-backdrop'));
        expect(third.onClose).toHaveBeenCalledTimes(1);
    });

    it('does not close when the click lands INSIDE the dialog', () => {
        const { onClose } = setup();
        fireEvent.mouseDown(screen.getByTestId('settings-window'));
        expect(onClose).not.toHaveBeenCalled();
    });

    // The recorder consumes Escape on the window in the capture phase, so it never reaches the
    // dialog: Escape means "the innermost open thing", not "close everything".
    it('leaves the window open when Escape cancels a recording', () => {
        const { onClose } = setup();
        // The window opens on General now (H13), so the recorder needs reaching first.
        fireEvent.click(screen.getByTestId('settings-tab-button-keybindings'));
        fireEvent.click(screen.getByTestId('keybinding-record-open_diff'));
        fireEvent.keyDown(window, { code: 'Escape', key: 'Escape' });
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByTestId('keybinding-record-open_diff').textContent).toBe('Record');
    });

    it('traps Tab inside the dialog', () => {
        setup();
        const dialog = screen.getByTestId('settings-window');
        const focusable = dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])');
        const last = focusable[focusable.length - 1];
        last?.focus();
        fireEvent.keyDown(dialog, { key: 'Tab' });
        expect(document.activeElement).toBe(focusable[0]);

        fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
        expect(document.activeElement).toBe(last);
    });

    it('re-applies the requested tab every time it re-opens', () => {
        const onClose = vi.fn();
        const view = render(
            <SettingsOverlay
                open
                initialTab="keybindings"
                settings={DEFAULT_WS_SETTINGS}
                domain={{ labelPresets: [], workspaces: [] }}
                actions={NOOP_ACTIONS}
                onClose={onClose}
            />
        );
        fireEvent.click(screen.getByTestId('settings-tab-button-profiles'));
        const props = {
            settings: DEFAULT_WS_SETTINGS,
            domain: { labelPresets: [], workspaces: [] },
            actions: NOOP_ACTIONS,
            onClose
        } as const;
        view.rerender(<SettingsOverlay open={false} initialTab="keybindings" {...props} />);
        view.rerender(<SettingsOverlay open initialTab="labels" {...props} />);
        expect(screen.getByTestId('settings-tab-labels')).toBeDefined();
    });
});
