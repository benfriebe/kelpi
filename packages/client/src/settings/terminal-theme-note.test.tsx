/**
 * §APP-014 — Settings ▸ Appearance says what `theme = <name>` resolved to.
 *
 * The item's rule is that an unresolvable name "falls back to today's behaviour with a visible
 * note, not silently". That makes this tab the surface of record for a lookup nobody can see:
 * the terminal looks the same whether a theme was found and applied or never found at all, and
 * without the note the only difference a user could observe is "nothing happened".
 *
 * Rendered through the whole `AppearanceTab`, not the note in isolation, because the claim is
 * about what the tab shows next to the picker.
 */

import { DEFAULT_WS_SETTINGS, type WsSettingsSnapshot } from '@kelpi/protocol';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppearanceTab } from './AppearanceTab';
import { DEFAULT_SETTINGS_PATHS, type SettingsActions } from './types';

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

function renderTab(appearance: Partial<WsSettingsSnapshot['appearance']>): void {
    const settings: WsSettingsSnapshot = {
        ...DEFAULT_WS_SETTINGS,
        appearance: { ...DEFAULT_WS_SETTINGS.appearance, ...appearance }
    };
    render(
        <AppearanceTab
            paths={DEFAULT_SETTINGS_PATHS}
            settings={settings}
            actions={actions()}
            bucket="dark"
        />
    );
}

afterEach(() => {
    cleanup();
});

describe('Settings ▸ Appearance ▸ Terminal ▸ Theme (§APP-014)', () => {
    it('shows where a resolved theme came from, with its own colours', () => {
        renderTab({
            theme: 'Nord',
            backgroundColor: '#2e3440',
            terminalTheme: {
                name: 'Nord',
                path: '/Users/x/.config/ghostty/themes/Nord',
                palette: { background: '#2e3440', foreground: '#d8dee9', red: '#bf616a' },
                error: null
            }
        });
        expect(screen.getByTestId('terminal-theme-path').textContent).toBe(
            '/Users/x/.config/ghostty/themes/Nord'
        );
        // One swatch per colour the file actually defined, in the strip's own order.
        const swatches = screen.getAllByTestId('terminal-theme-swatch');
        expect(swatches).toHaveLength(3);
        expect(swatches[0]?.style.background).toBe('rgb(46, 52, 64)');
        expect(screen.queryByTestId('terminal-theme-error')).toBeNull();
    });

    it('says WHY a name did not resolve, rather than leaving the picker silent', () => {
        renderTab({
            theme: 'Made Up',
            terminalTheme: {
                name: 'Made Up',
                path: null,
                palette: {},
                error: 'No ghostty theme file named “Made Up” was found (looked in /a/themes), so the terminal palette is unchanged.'
            }
        });
        const note = screen.getByTestId('terminal-theme-error');
        expect(note.textContent).toContain('Made Up');
        expect(note.textContent).toContain('the terminal palette is unchanged');
        // The picker still shows the name the file says — the fallback is the PALETTE's, not
        // an edit to the user's config (§1.3: the app never writes `theme` back).
        expect((screen.getByTestId('terminal-theme-select') as HTMLSelectElement).value).toBe('');
        expect(screen.queryByTestId('terminal-theme-resolved')).toBeNull();
    });

    it('reports a file that exists but is not a theme, with its path', () => {
        renderTab({
            theme: 'Broken',
            terminalTheme: {
                name: 'Broken',
                path: '/a/themes/Broken',
                palette: {},
                error: 'Theme “Broken” was found at /a/themes/Broken but defines no colours Kelpi understands, so the terminal palette is unchanged.'
            }
        });
        expect(screen.getByTestId('terminal-theme-error').textContent).toContain('/a/themes/Broken');
    });

    it('says nothing at all when no theme is configured', () => {
        renderTab({});
        expect(screen.queryByTestId('terminal-theme-error')).toBeNull();
        expect(screen.queryByTestId('terminal-theme-resolved')).toBeNull();
    });
});
