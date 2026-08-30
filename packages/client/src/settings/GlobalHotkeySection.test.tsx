/**
 * Settings ▸ Keybindings ▸ Global (SET-081…SET-084, SET-093).
 *
 * SET-093 is the rule that makes this a separate recorder rather than a reuse of the row one:
 * recording the global hotkey must ignore a collision with the CURRENT global hotkey while
 * still refusing any in-app collision. Getting that backwards either makes re-recording your
 * own hotkey impossible, or lets a user silently shadow ⌘D from outside the app.
 */

import { DEFAULT_KEYBINDINGS } from '@kelpi/core/config';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GlobalHotkeySection, inAppConflict } from './GlobalHotkeySection';
import type { SettingsActions } from './types';

function actions(): SettingsActions & { readonly writes: { key: string; value: string }[] } {
    const writes: { key: string; value: string }[] = [];
    return {
        writes,
        setKeybinding: vi.fn(),
        resetKeybindings: vi.fn(),
        setGeneralSetting: (key, value) => writes.push({ key, value }),
        setGhosttySetting: vi.fn(),
        setProfiles: vi.fn(),
        addLabelPreset: vi.fn(),
        updateLabelPreset: vi.fn(),
        removeLabelPreset: vi.fn()
    };
}

function press(init: Partial<KeyboardEventInit> & { code: string }): void {
    fireEvent.keyDown(window, { bubbles: true, ...init });
}

afterEach(cleanup);

describe('GlobalHotkeySection', () => {
    // SET-081: an em-dash when unset, a chip with an ✕ when set.
    it('shows an em-dash with no hotkey and a clearable chip with one', () => {
        const bound = actions();
        const view = render(
            <GlobalHotkeySection hotkey={null} hideOnRepress bindings={DEFAULT_KEYBINDINGS} actions={bound} />
        );
        expect(screen.getByTestId('global-hotkey-empty').textContent).toBe('—');
        expect(screen.queryByTestId('global-hotkey-clear')).toBeNull();

        view.rerender(
            <GlobalHotkeySection
                hotkey="ctrl+alt+space"
                hideOnRepress
                bindings={DEFAULT_KEYBINDINGS}
                actions={bound}
            />
        );
        expect(screen.getByTestId('global-hotkey-chip').textContent).toContain('⌃');
        expect(screen.getByTestId('global-hotkey-chip').textContent).toContain('⌥');
        fireEvent.click(screen.getByTestId('global-hotkey-clear'));
        // `none` rather than an empty value: the parser takes both, and the explicit word
        // survives a human reading the config file.
        expect(bound.writes).toEqual([{ key: 'global-hotkey', value: 'none' }]);
    });

    it('mentions that no Accessibility permission is needed', () => {
        render(
            <GlobalHotkeySection hotkey={null} hideOnRepress bindings={DEFAULT_KEYBINDINGS} actions={actions()} />
        );
        expect(screen.getByTestId('global-hotkey-row').textContent).toContain('No Accessibility permission');
    });

    it('records a chord and writes it as a config-file trigger', () => {
        const bound = actions();
        render(
            <GlobalHotkeySection hotkey={null} hideOnRepress bindings={DEFAULT_KEYBINDINGS} actions={bound} />
        );
        fireEvent.click(screen.getByTestId('global-hotkey-record'));
        expect(screen.getByTestId('global-hotkey-record').textContent).toContain('Press a key');
        press({ code: 'Space', ctrlKey: true, altKey: true });
        expect(bound.writes).toEqual([{ key: 'global-hotkey', value: 'ctrl+alt+space' }]);
        expect(screen.getByTestId('global-hotkey-record').textContent).toBe('Record');
    });

    it('refuses a combo with no modifier and stays armed', () => {
        const bound = actions();
        render(
            <GlobalHotkeySection hotkey={null} hideOnRepress bindings={DEFAULT_KEYBINDINGS} actions={bound} />
        );
        fireEvent.click(screen.getByTestId('global-hotkey-record'));
        press({ code: 'KeyG' });
        expect(bound.writes).toEqual([]);
        expect(screen.getByTestId('global-hotkey-message').textContent).toContain('modifier');
        expect(screen.getByTestId('global-hotkey-record').textContent).toContain('Press a key');
    });

    // SET-093, first half: an IN-APP collision is still refused.
    it('refuses a chord that belongs to an in-app action', () => {
        const bound = actions();
        render(
            <GlobalHotkeySection hotkey={null} hideOnRepress bindings={DEFAULT_KEYBINDINGS} actions={bound} />
        );
        fireEvent.click(screen.getByTestId('global-hotkey-record'));
        // ⌘D is the shipped Split Right binding.
        press({ code: 'KeyD', metaKey: true });
        expect(bound.writes).toEqual([]);
        expect(screen.getByTestId('global-hotkey-message').textContent).toContain('Already bound to');
    });

    // SET-093, second half: the CURRENT global hotkey is not a collision with itself.
    it('accepts re-recording the hotkey it already has', () => {
        const bound = actions();
        render(
            <GlobalHotkeySection
                hotkey="ctrl+alt+space"
                hideOnRepress
                bindings={DEFAULT_KEYBINDINGS}
                actions={bound}
            />
        );
        fireEvent.click(screen.getByTestId('global-hotkey-record'));
        press({ code: 'Space', ctrlKey: true, altKey: true });
        expect(bound.writes).toEqual([{ key: 'global-hotkey', value: 'ctrl+alt+space' }]);
        expect(screen.queryByTestId('global-hotkey-message')).toBeNull();
    });

    /**
     * The ✕ unmounts itself along with the chip. Left alone, focus falls to `<body>` — outside
     * the modal — and the Settings dialog listens for Escape on its OWN container, so Escape
     * silently stops closing the window. The audit caught this as `settings-close` failing one
     * step after the hotkey step; the fix is to hand focus to the Record button.
     */
    it('moves focus to Record when the ✕ removes itself', () => {
        render(
            <GlobalHotkeySection
                hotkey="ctrl+alt+space"
                hideOnRepress
                bindings={DEFAULT_KEYBINDINGS}
                actions={actions()}
            />
        );
        fireEvent.click(screen.getByTestId('global-hotkey-clear'));
        expect(document.activeElement).toBe(screen.getByTestId('global-hotkey-record'));
    });

    it('cancels on Escape without writing anything', () => {
        const bound = actions();
        render(
            <GlobalHotkeySection hotkey={null} hideOnRepress bindings={DEFAULT_KEYBINDINGS} actions={bound} />
        );
        fireEvent.click(screen.getByTestId('global-hotkey-record'));
        press({ code: 'Escape' });
        expect(bound.writes).toEqual([]);
        expect(screen.getByTestId('global-hotkey-record').textContent).toBe('Record');
    });

    // SET-082: the repress toggle is meaningless with no hotkey, so it is disabled.
    it('disables the “press again to hide” toggle until a hotkey is set', () => {
        const bound = actions();
        const view = render(
            <GlobalHotkeySection hotkey={null} hideOnRepress bindings={DEFAULT_KEYBINDINGS} actions={bound} />
        );
        expect((screen.getByTestId('global-hotkey-repress-toggle') as HTMLInputElement).disabled).toBe(true);

        view.rerender(
            <GlobalHotkeySection
                hotkey="ctrl+alt+space"
                hideOnRepress
                bindings={DEFAULT_KEYBINDINGS}
                actions={bound}
            />
        );
        const toggle = screen.getByTestId('global-hotkey-repress-toggle') as HTMLInputElement;
        expect(toggle.disabled).toBe(false);
        fireEvent.click(toggle);
        expect(bound.writes).toEqual([{ key: 'global-hotkey-hide-on-repress', value: 'false' }]);
    });

    // SET-083: the shell's registration failure reaches the user, not just the log.
    it('surfaces a registration failure inline', () => {
        render(
            <GlobalHotkeySection
                hotkey="ctrl+alt+space"
                hideOnRepress
                bindings={DEFAULT_KEYBINDINGS}
                actions={actions()}
                registrationError="This shortcut is already claimed by another app."
            />
        );
        expect(screen.getByTestId('global-hotkey-failure').textContent).toContain('already claimed');
    });

    // SET-084: an advisory, not a refusal — the combination is legal and sometimes wanted.
    it('advises when the hotkey also matches an in-app binding', () => {
        const view = render(
            <GlobalHotkeySection
                hotkey="ctrl+alt+space"
                hideOnRepress
                bindings={DEFAULT_KEYBINDINGS}
                actions={actions()}
            />
        );
        expect(screen.queryByTestId('global-hotkey-conflict')).toBeNull();

        view.rerender(
            <GlobalHotkeySection
                hotkey="super+d"
                hideOnRepress
                bindings={DEFAULT_KEYBINDINGS}
                actions={actions()}
            />
        );
        const advisory = screen.getByTestId('global-hotkey-conflict');
        expect(advisory.textContent).toContain('Split Right');
        expect(advisory.textContent).toContain('frontmost');
    });
});

describe('inAppConflict', () => {
    it('names the action a hotkey shadows, and is null otherwise', () => {
        expect(inAppConflict('super+d', DEFAULT_KEYBINDINGS)).toBe('Split Right');
        expect(inAppConflict('ctrl+alt+space', DEFAULT_KEYBINDINGS)).toBeNull();
        expect(inAppConflict(null, DEFAULT_KEYBINDINGS)).toBeNull();
        expect(inAppConflict('not a trigger', DEFAULT_KEYBINDINGS)).toBeNull();
    });
});
