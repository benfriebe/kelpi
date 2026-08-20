import { DEFAULT_WS_SETTINGS } from '@nex/protocol';
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

    it('is a modal dialog opening on the keybindings tab', () => {
        setup();
        const dialog = screen.getByRole('dialog', { name: 'Settings' });
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(screen.getByTestId('settings-tab-keybindings')).toBeDefined();
        expect(screen.getByTestId('settings-tab-button-keybindings').getAttribute('aria-selected')).toBe('true');
    });

    it('honours a deep link to a specific tab', () => {
        setup({ initialTab: 'labels' });
        expect(screen.getByTestId('settings-tab-labels')).toBeDefined();
    });

    it('switches tabs on click', () => {
        setup();
        fireEvent.click(screen.getByTestId('settings-tab-button-profiles'));
        expect(screen.getByTestId('settings-tab-profiles')).toBeDefined();
        expect(screen.queryByTestId('settings-tab-keybindings')).toBeNull();
    });

    it('moves between tabs with the arrow keys, wrapping, and jumps with Home/End', () => {
        setup();
        const rail = screen.getByTestId('settings-tabs');
        fireEvent.keyDown(rail, { key: 'ArrowDown' });
        expect(screen.getByTestId('settings-tab-appearance')).toBeDefined();
        fireEvent.keyDown(rail, { key: 'ArrowUp' });
        expect(screen.getByTestId('settings-tab-keybindings')).toBeDefined();
        // Keybindings is no longer first: General and Repositories precede it, so ArrowUp from
        // it lands on Repositories rather than wrapping.
        fireEvent.keyDown(rail, { key: 'ArrowUp' });
        expect(screen.getByTestId('settings-tab-repositories')).toBeDefined();
        fireEvent.keyDown(rail, { key: 'Home' });
        expect(screen.getByTestId('settings-tab-general')).toBeDefined();
        // End is the LAST tab, which is Web since favourites gained a daemon home.
        fireEvent.keyDown(rail, { key: 'End' });
        expect(screen.getByTestId('settings-tab-web')).toBeDefined();
    });

    it('keeps a roving tabindex so Tab lands on the selected tab only', () => {
        setup();
        const selected = screen.getByTestId('settings-tab-button-keybindings');
        const other = screen.getByTestId('settings-tab-button-labels');
        expect(selected.getAttribute('tabindex')).toBe('0');
        expect(other.getAttribute('tabindex')).toBe('-1');
        expect(document.activeElement).toBe(selected);
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
