/**
 * §APP-014's second half — a global-hotkey registration failure is a CLIENT-VISIBLE error.
 *
 * The registration itself is the shell's (Electron `globalShortcut`), and its outcome travels
 * shell → daemon → every window as a `hotkey-status` broadcast (§SET-200/§SET-201). This file
 * covers the two halves the item is actually about:
 *
 *   1. the rule that turns a broadcast into an error state — including the two shapes that
 *      must produce NO error (nothing reported yet, and a report that succeeded), because that
 *      is what makes clearing the hotkey or re-recording a working chord take the message away;
 *   2. what the row renders: the OS's own sentence, in a destructive tone, announced.
 *
 * The store's own carry-over rules (a settings broadcast must not drop a standing report, an
 * identical re-report must not re-render) live in `state/settings.test.ts`.
 */

import { DEFAULT_KEYBINDINGS } from '@kelpi/core/config';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FAILURE_COLOR, GlobalHotkeySection, WARNING_COLOR, globalHotkeyErrorFrom } from './GlobalHotkeySection';
import type { SettingsActions } from './types';

/** jsdom normalises an inline `color` to `rgb(r, g, b)`, so the expectations do too. */
function rgb(hex: string): string {
    const value = hex.replace('#', '');
    const channel = (at: number): number => Number.parseInt(value.slice(at, at + 2), 16);
    return `rgb(${String(channel(0))}, ${String(channel(2))}, ${String(channel(4))})`;
}

function actions(): SettingsActions {
    return {
        setKeybinding: vi.fn(),
        resetKeybindings: vi.fn(),
        setGeneralSetting: vi.fn(),
        setGhosttySetting: vi.fn(),
        setProfiles: vi.fn(),
        addLabelPreset: vi.fn(),
        updateLabelPreset: vi.fn(),
        removeLabelPreset: vi.fn()
    };
}

afterEach(() => {
    cleanup();
});

describe('globalHotkeyErrorFrom', () => {
    it('is no error until a shell has reported', () => {
        expect(globalHotkeyErrorFrom(null)).toBeNull();
        expect(globalHotkeyErrorFrom(undefined)).toBeNull();
    });

    it('carries the OS’s reason for a failure', () => {
        expect(
            globalHotkeyErrorFrom({ ok: false, error: 'This shortcut is already claimed by another app.' })
        ).toBe('This shortcut is already claimed by another app.');
    });

    /** A failure with no reason still has to say something a user can act on. */
    it('still says something when the OS gives no reason', () => {
        expect(globalHotkeyErrorFrom({ ok: false, error: null })).toBe(
            'The global hotkey could not be registered.'
        );
        expect(globalHotkeyErrorFrom({ ok: false, error: '   ' })).toBe(
            'The global hotkey could not be registered.'
        );
    });

    /**
     * The clearing rule, and the reason the state is derived rather than stored: a successful
     * report is what BOTH the ✕ (which writes `global-hotkey = none`, and the shell reports
     * `ok` for "none configured") and a re-recorded working chord produce.
     */
    it('is cleared by any successful report', () => {
        expect(globalHotkeyErrorFrom({ ok: true, error: null })).toBeNull();
        // Even a stale reason attached to a success does not resurrect the message.
        expect(globalHotkeyErrorFrom({ ok: true, error: 'previously refused' })).toBeNull();
    });
});

describe('Settings ▸ Keybindings ▸ Global — the failure row', () => {
    const renderSection = (registrationError: string | null): void => {
        render(
            <GlobalHotkeySection
                hotkey="ctrl+alt+space"
                hideOnRepress
                bindings={DEFAULT_KEYBINDINGS}
                actions={actions()}
                registrationError={registrationError}
            />
        );
    };

    it('renders the reason in a destructive tone, announced', () => {
        renderSection('This shortcut is already claimed by another app.');
        const row = screen.getByTestId('global-hotkey-failure');
        expect(row.textContent).toContain('already claimed by another app');
        expect(row.getAttribute('role')).toBe('alert');
        expect(row.dataset['tone']).toBe('destructive');
        expect(row.style.color).toBe(rgb(FAILURE_COLOR));
        // …and NOT the amber the shadow advisory uses: the two mean opposite things.
        expect(FAILURE_COLOR).not.toBe(WARNING_COLOR);
    });

    it('shows nothing when there is no failure to show', () => {
        renderSection(null);
        expect(screen.queryByTestId('global-hotkey-failure')).toBeNull();
    });

    /**
     * The failure and the shadow advisory can be true at the same time, and they are different
     * statements — one says the chord does not work, the other says it works and shadows an
     * in-app binding. Both render, distinctly.
     */
    it('sits beside the in-app shadow advisory rather than replacing it', () => {
        render(
            <GlobalHotkeySection
                // ⌘P is `command_palette` in the shipped defaults, so this collides in-app.
                hotkey="super+p"
                hideOnRepress
                bindings={DEFAULT_KEYBINDINGS}
                actions={actions()}
                registrationError="This shortcut is already claimed by another app."
            />
        );
        expect(screen.getByTestId('global-hotkey-failure').style.color).toBe(rgb(FAILURE_COLOR));
        expect(screen.getByTestId('global-hotkey-conflict').style.color).toBe(rgb(WARNING_COLOR));
    });
});
