/**
 * Appearance + Workspaces.
 *
 * Appearance is now the tab that writes the most, and to TWO files: the chrome palette and the
 * status-bar gauges go to `~/.config/nex/config` via `set-general-setting`, while the terminal
 * theme, background, opacity and font go to `~/.config/ghostty/config` via
 * `set-ghostty-setting`. Every assertion below is about which file a control reaches and what
 * exact value it writes — the two things a picker can get subtly, silently wrong.
 */

import { DEFAULT_WS_SETTINGS, type WsSettingsSnapshot } from '@nex/protocol';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppearanceTab } from './AppearanceTab';
import { WorkspacesTab } from './WorkspacesTab';
import { DEFAULT_SETTINGS_PATHS, type SettingsActions } from './types';

type GhosttyWrite = (key: string, value: string | null) => void;

function actions(): SettingsActions & {
    readonly general: { key: string; value: string }[];
    readonly setGhosttySetting: ReturnType<typeof vi.fn<GhosttyWrite>>;
} {
    const general: { key: string; value: string }[] = [];
    return {
        general,
        setKeybinding: vi.fn(),
        resetKeybindings: vi.fn(),
        setGeneralSetting: (key, value) => general.push({ key, value }),
        setGhosttySetting: vi.fn<GhosttyWrite>(),
        setProfiles: vi.fn(),
        addLabelPreset: vi.fn(),
        updateLabelPreset: vi.fn(),
        removeLabelPreset: vi.fn()
    };
}

function snapshot(patch: Partial<WsSettingsSnapshot> = {}): WsSettingsSnapshot {
    return { ...DEFAULT_WS_SETTINGS, ...patch };
}

// The writing controls debounce (SET-041's single cancel-in-flight effect), so the clock has
// to be driveable or every colour/slider assertion would be a race.
beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
    vi.useRealTimers();
    cleanup();
});

describe('Settings ▸ Appearance', () => {
    function renderAppearance(patch: Partial<WsSettingsSnapshot> = {}) {
        const bound = actions();
        render(
            <AppearanceTab paths={DEFAULT_SETTINGS_PATHS} settings={snapshot(patch)} actions={bound} bucket="dark" />
        );
        return bound;
    }

    // SET-023: seven presets, each with a swatch mock — the gallery is the thing that makes a
    // one-click palette legible before it is applied.
    it('renders the seven preset themes as a swatch grid', () => {
        renderAppearance();
        for (const name of [
            'dracula',
            'nord',
            'gruvbox-dark',
            'tokyo-night',
            'catppuccin-mocha',
            'solarized-light',
            'gruvbox-light'
        ]) {
            expect(screen.getByTestId(`theme-preset-${name}`)).toBeTruthy();
        }
    });

    // SET-024 + SET-030: a preset switches the appearance mode to the palette's native one AND
    // overwrites every styling field — and reports which one it applied.
    it('applies a preset: appearance mode first, then the whole styling set', () => {
        const bound = renderAppearance();
        fireEvent.click(screen.getByTestId('theme-preset-solarized-light'));
        const keys = bound.general.map((entry) => entry.key);
        expect(keys[0]).toBe('chrome-appearance');
        expect(bound.general[0]?.value).toBe('light');
        expect(keys).toContain('chrome-colors');
        expect(keys).toContain('sidebar-color-intensity');
        expect(keys).toContain('sparkline-color');
        // SET-030's exclusions: neither the chrome mode nor the terminal background is a
        // ghostty write, so the ghostty file is never touched by applying a theme.
        expect(bound.setGhosttySetting).not.toHaveBeenCalled();
        expect(screen.getByTestId('theme-status').textContent).toContain('Applied “Solarized Light” (Light).');
    });

    // SET-033: overrides are keyed `<bucket>:<key>` for the bucket the window is resolved at.
    it('writes a colour override into the resolved bucket', () => {
        const bound = renderAppearance();
        fireEvent.change(screen.getByTestId('chrome-color-accent-input'), { target: { value: '#ff8800' } });
        // The write is debounced; the control moves immediately, the verb follows.
        vi.advanceTimersByTime(400);
        const write = bound.general.find((entry) => entry.key === 'chrome-colors');
        expect(write).toBeTruthy();
        expect(JSON.parse(write?.value ?? '{}')).toEqual({ 'dark:accent': 'FF8800' });
    });

    // SET-039/040: choosing a theme writes the ghostty key AND drops any explicit background,
    // because a `background` line would silently outrank the theme.
    it('writes the terminal theme to the ghostty file and clears the explicit background', () => {
        const bound = renderAppearance();
        fireEvent.change(screen.getByTestId('terminal-theme-select'), { target: { value: 'Nord' } });
        expect(bound.setGhosttySetting).toHaveBeenCalledWith('theme', 'Nord');
        expect(bound.setGhosttySetting).toHaveBeenCalledWith('background', null);
    });

    // SET-040: the background picker exists only while no theme is selected.
    it('hides the background picker while a theme is selected', () => {
        renderAppearance({
            appearance: { ...DEFAULT_WS_SETTINGS.appearance, theme: 'Nord' }
        });
        expect(screen.queryByTestId('terminal-background')).toBeNull();
        expect(screen.getByTestId('terminal-background-locked')).toBeTruthy();
    });

    // SET-041: opacity is a slider over ghostty's `background-opacity`, not a read-out.
    it('writes the background opacity to the ghostty file', () => {
        const bound = renderAppearance();
        fireEvent.change(screen.getByTestId('terminal-opacity-slider'), { target: { value: '0.85' } });
        vi.advanceTimersByTime(400);
        expect(bound.setGhosttySetting).toHaveBeenCalledWith('background-opacity', '0.85');
    });

    // SET-042/043: the master toggle gates the per-metric list.
    it('gates the six metric toggles behind the master stats toggle', () => {
        const bound = renderAppearance({
            chrome: { ...DEFAULT_WS_SETTINGS.chrome, showSystemStats: false }
        });
        expect(screen.queryByTestId('stats-kinds')).toBeNull();
        fireEvent.click(screen.getByTestId('stats-master-toggle'));
        expect(bound.general).toEqual([{ key: 'show-system-stats', value: 'true' }]);
    });

    it('writes the enabled metric set sorted and comma-joined', () => {
        const bound = renderAppearance();
        fireEvent.click(screen.getByTestId('stats-kind-toggle-network'));
        expect(bound.general).toEqual([{ key: 'system-stats', value: 'cpu,load,memory,network' }]);
    });

    // SET-044: "Reset graph colour" writes an EMPTY hex, which means "adaptive chrome default".
    it('resets the sparkline colour to the adaptive default', () => {
        const bound = renderAppearance({
            chrome: { ...DEFAULT_WS_SETTINGS.chrome, sparklineColor: '#ff0000' }
        });
        fireEvent.click(screen.getByTestId('sparkline-color-reset'));
        expect(bound.general).toEqual([{ key: 'sparkline-color', value: '' }]);
    });

    // SET-034: Reset clears BOTH buckets, and is inert when there is nothing to clear.
    it('clears every colour override, and is disabled when there are none', () => {
        const bound = actions();
        const view = render(
            <AppearanceTab
                paths={DEFAULT_SETTINGS_PATHS}
                settings={snapshot()}
                actions={bound}
                bucket="dark"
            />
        );
        expect((screen.getByTestId('chrome-colors-reset') as HTMLButtonElement).disabled).toBe(true);
        view.rerender(
            <AppearanceTab
                paths={DEFAULT_SETTINGS_PATHS}
                settings={snapshot({
                    chrome: { ...DEFAULT_WS_SETTINGS.chrome, colors: { 'dark:accent': 'FF8800' } }
                })}
                actions={bound}
                bucket="dark"
            />
        );
        fireEvent.click(screen.getByTestId('chrome-colors-reset'));
        expect(bound.general).toEqual([{ key: 'chrome-colors', value: '{}' }]);
    });

    it('names both files it writes, so a hand-edit knows where to go', () => {
        renderAppearance();
        const note = screen.getByTestId('settings-footer-note').textContent ?? '';
        expect(note).toContain('~/.config/ghostty/config');
        expect(note).toContain('~/.config/nex/config');
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

    // SET-012: the last of §13's six behaviour keys to become a real setting.
    it('writes the drop-expands-group flag as a general setting', () => {
        const bound = actions();
        const view = render(
            <WorkspacesTab settings={snapshot()} actions={bound} paths={DEFAULT_SETTINGS_PATHS} />
        );
        const toggle = screen.getByTestId('expand-group-on-drop-toggle') as HTMLInputElement;
        expect(toggle.checked).toBe(true);
        fireEvent.click(toggle);
        expect(bound.general).toEqual([{ key: 'expand-group-on-workspace-drop', value: 'false' }]);
        // Same no-local-echo rule as its neighbours: the control only moves on the snapshot.
        view.rerender(
            <WorkspacesTab
                settings={snapshot({
                    general: { ...DEFAULT_WS_SETTINGS.general, expandGroupOnWorkspaceDrop: false }
                })}
                actions={bound}
                paths={DEFAULT_SETTINGS_PATHS}
            />
        );
        expect((screen.getByTestId('expand-group-on-drop-toggle') as HTMLInputElement).checked).toBe(false);
    });

    /**
     * §TERM-046. The one control on this tab whose DEFAULT is the behaviour: it ships OFF, which
     * is stricter than the shipped Swift app, so "unchecked out of the box" is the assertion —
     * and the row states the half no toggle governs, because a switch labelled "clipboard" reads
     * as both directions to anyone who has met OSC 52 before.
     */
    it('ships the OSC 52 clipboard gate OFF and writes it as a general setting', () => {
        const bound = actions();
        const view = render(
            <WorkspacesTab settings={snapshot()} actions={bound} paths={DEFAULT_SETTINGS_PATHS} />
        );
        const toggle = screen.getByTestId('clipboard-write-toggle') as HTMLInputElement;
        expect(toggle.checked).toBe(false);
        fireEvent.click(toggle);
        expect(bound.general).toEqual([{ key: 'clipboard-write', value: 'true' }]);
        // No local echo: the switch only moves when the daemon's snapshot says so.
        expect((screen.getByTestId('clipboard-write-toggle') as HTMLInputElement).checked).toBe(false);
        view.rerender(
            <WorkspacesTab
                settings={snapshot({ general: { ...DEFAULT_WS_SETTINGS.general, clipboardWrite: true } })}
                actions={bound}
                paths={DEFAULT_SETTINGS_PATHS}
            />
        );
        expect((screen.getByTestId('clipboard-write-toggle') as HTMLInputElement).checked).toBe(true);
        expect(screen.getByTestId('clipboard-write-row').textContent ?? '').toContain('never READ');
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
