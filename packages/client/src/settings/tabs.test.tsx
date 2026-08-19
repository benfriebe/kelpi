/**
 * Appearance + Workspaces: the two tabs that are mostly read-outs, and the one place a general
 * setting is written.
 */

import { DEFAULT_WS_SETTINGS, type WsSettingsSnapshot } from '@nex/protocol';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppearanceTab } from './AppearanceTab';
import { WorkspacesTab } from './WorkspacesTab';
import { DEFAULT_SETTINGS_PATHS, type SettingsActions } from './types';

function actions(): SettingsActions & { readonly general: { key: string; value: string }[] } {
    const general: { key: string; value: string }[] = [];
    return {
        general,
        setKeybinding: vi.fn(),
        resetKeybindings: vi.fn(),
        setGeneralSetting: (key, value) => general.push({ key, value }),
        setProfiles: vi.fn(),
        addLabelPreset: vi.fn(),
        updateLabelPreset: vi.fn(),
        removeLabelPreset: vi.fn()
    };
}

function snapshot(patch: Partial<WsSettingsSnapshot> = {}): WsSettingsSnapshot {
    return { ...DEFAULT_WS_SETTINGS, ...patch };
}

afterEach(cleanup);

describe('Settings ▸ Appearance', () => {
    it('shows the resolved ghostty surface, including the daemon’s light/dark verdict', () => {
        render(
            <AppearanceTab
                paths={DEFAULT_SETTINGS_PATHS}
                settings={snapshot({
                    appearance: {
                        backgroundColor: '#ffffff',
                        backgroundOpacity: 0.8,
                        fontFamily: 'Menlo',
                        fontSize: 15,
                        isDark: false,
                        theme: 'Catppuccin Latte'
                    }
                })}
            />
        );
        expect(screen.getByTestId('appearance-background').textContent).toContain('#ffffff');
        expect(screen.getByTestId('appearance-swatch').dataset['color']).toBe('#FFFFFF');
        expect(screen.getByTestId('appearance-opacity').textContent).toContain('80%');
        expect(screen.getByTestId('appearance-font').textContent).toContain('Menlo');
        expect(screen.getByTestId('appearance-font').textContent).toContain('15px');
        expect(screen.getByTestId('appearance-bucket').textContent).toContain('light');
        expect(screen.getByTestId('appearance-ghostty-theme').textContent).toContain('Catppuccin Latte');
    });

    it('says “default” where ghostty sets no font, rather than inventing one', () => {
        render(<AppearanceTab paths={DEFAULT_SETTINGS_PATHS} settings={snapshot()} />);
        expect(screen.getByTestId('appearance-font').textContent).toContain('default');
    });

    // §1.3: the app never writes `theme` back, and the daemon refuses the key — so this tab
    // shows the value with the file that owns it instead of offering a picker that must fail.
    it('shows the terminal theme read-only, pointing at the file that owns it', () => {
        render(
            <AppearanceTab
                paths={DEFAULT_SETTINGS_PATHS}
                settings={snapshot({ general: { ...DEFAULT_WS_SETTINGS.general, theme: 'Nord' } })}
            />
        );
        expect(screen.getByTestId('appearance-nex-theme').textContent).toContain('Nord');
        expect(screen.getByTestId('appearance-nex-theme').textContent).toContain('Read-only');
        expect(screen.getByTestId('settings-footer-note').textContent).toContain('~/.config/ghostty/config');
    });
});

describe('Settings ▸ Workspaces', () => {
    it('writes the delete-confirmation flag as a general setting', () => {
        const bound = actions();
        render(<WorkspacesTab settings={snapshot()} actions={bound} paths={DEFAULT_SETTINGS_PATHS} />);
        const toggle = screen.getByTestId('confirm-delete-toggle') as HTMLInputElement;
        expect(toggle.checked).toBe(true);
        fireEvent.click(toggle);
        expect(bound.general).toEqual([{ key: 'confirm-workspace-delete', value: 'false' }]);
    });

    it('reflects the daemon’s value rather than a local echo', () => {
        const bound = actions();
        const view = render(
            <WorkspacesTab
                settings={snapshot({
                    general: { ...DEFAULT_WS_SETTINGS.general, confirmWorkspaceDeleteWhenActive: false }
                })}
                actions={bound}
                paths={DEFAULT_SETTINGS_PATHS}
            />
        );
        expect((screen.getByTestId('confirm-delete-toggle') as HTMLInputElement).checked).toBe(false);
        // Clicking asks for the change; the control only moves when the snapshot comes back.
        fireEvent.click(screen.getByTestId('confirm-delete-toggle'));
        expect((screen.getByTestId('confirm-delete-toggle') as HTMLInputElement).checked).toBe(false);
        view.rerender(
            <WorkspacesTab
                settings={snapshot({
                    general: { ...DEFAULT_WS_SETTINGS.general, confirmWorkspaceDeleteWhenActive: true }
                })}
                actions={bound}
                paths={DEFAULT_SETTINGS_PATHS}
            />
        );
        expect((screen.getByTestId('confirm-delete-toggle') as HTMLInputElement).checked).toBe(true);
    });

    it('hides the focus delay until focus-follows-mouse is on, then writes the slider value', () => {
        const bound = actions();
        const view = render(
            <WorkspacesTab settings={snapshot()} actions={bound} paths={DEFAULT_SETTINGS_PATHS} />
        );
        expect(screen.queryByTestId('focus-delay-slider')).toBeNull();
        fireEvent.click(screen.getByTestId('focus-follows-mouse-toggle'));
        expect(bound.general).toEqual([{ key: 'focus-follows-mouse', value: 'true' }]);

        view.rerender(
            <WorkspacesTab
                settings={snapshot({
                    general: { ...DEFAULT_WS_SETTINGS.general, focusFollowsMouse: true, focusFollowsMouseDelay: 150 }
                })}
                actions={bound}
                paths={DEFAULT_SETTINGS_PATHS}
            />
        );
        const slider = screen.getByTestId('focus-delay-slider') as HTMLInputElement;
        expect(slider.value).toBe('150');
        expect(slider.step).toBe('25');
        expect(slider.max).toBe('500');
        fireEvent.change(slider, { target: { value: '250' } });
        expect(bound.general.at(-1)).toEqual({ key: 'focus-follows-mouse-delay', value: '250' });
    });
});
