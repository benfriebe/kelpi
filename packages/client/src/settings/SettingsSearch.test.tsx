import { DEFAULT_WS_SETTINGS } from '@kelpi/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFakePhoneWindow } from '../phone/testing';
import { SettingsOverlay } from './SettingsOverlay';
import { SETTINGS_TABS } from './catalog';
import { SETTINGS_INDEX } from './sections';
import { settingsSearchDestination } from './search-navigation';
import { createSettingsSurface } from './surface';
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

afterEach(() => { cleanup(); vi.useRealTimers(); });


function search(query: string, testID: string): void {
    const input = screen.getByTestId('settings-search');
    fireEvent.change(input, { target: { value: query } });
    const hit = screen.getAllByTestId(`settings-search-result-${testID}`)[0]!;
    hit.focus();
    fireEvent.click(hit);
}

describe('Settings search in the host', () => {
    it('keeps the production search input and focus through each character and clearing', () => {
        const surface = createSettingsSurface({ settings: () => DEFAULT_WS_SETTINGS, actions: () => NOOP_ACTIONS });
        try {
            setup({ surface });
            const input = screen.getByTestId('settings-search');
            input.focus();
            for (const value of ['g', 'gr', 'gro', 'grou', 'group', '']) {
                fireEvent.change(input, { target: { value } });
                expect(screen.getByTestId('settings-search') === input).toBe(true);
                expect(document.activeElement === input).toBe(true);
            }
        } finally {
            cleanup();
            surface.dispose();
        }
    });

    it('opens graph disclosures, focuses the real control, and retains modal Escape', () => {
        const { onClose } = setup();
        search('Graph colour', 'sparkline-color');
        const target = screen.getByTestId('sparkline-color');
        expect(target.closest('details')?.open).toBe(true);
        expect(target.contains(document.activeElement)).toBe(true);
        expect(target.dataset['settingsSearchHit']).toBe('true');
        fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('clears the temporary outline after its duration, even with a surface', () => {
        vi.useFakeTimers();
        const surface = createSettingsSurface({ settings: () => DEFAULT_WS_SETTINGS, actions: () => NOOP_ACTIONS });
        try {
            setup({ surface });
            search('Group band fill', 'sidebar-group-fill');
            const target = screen.getByTestId('sidebar-group-fill');
            expect(target.dataset['settingsSearchHit']).toBe('true');
            act(() => vi.advanceTimersByTime(1400));
            expect(target.dataset['settingsSearchHit']).toBeUndefined();
            expect(target.style.outline).toBe('');
            expect(target.style.outlineOffset).toBe('');
        } finally {
            cleanup();
            surface.dispose();
        }
    });

    it.each([
        ['Port', 'tcp-port', 'tcp-listener-row', 'Enable TCP listener'],
        ['Focus delay', 'focus-delay-row', 'focus-follows-mouse-row', 'Enable Focus follows mouse'],
        ['TCP listener failed to bind', 'tcp-bind-error', 'tcp-listener-row', 'No TCP bind failure'],
        ['Browse for folder', 'repo-browse', 'repo-path', 'Enter a repository path'],
        ['Labels not defined here', 'label-orphans', 'label-presets', 'no workspace labels'],
        ['Rename repository', 'repo-list', 'repo-path', 'Add a repository'],
        ['Trust plugins with navigation', 'remote-daemon-navigation-trust', 'remote-daemon-add-name', 'Add a remote daemon'],
        ['Rename favourite', 'settings-favourites', 'settings-favourites', 'Save a web favourite']
    ])('explains availability for %s and reveals its prerequisite', (query, hit, target, message) => {
        setup();
        fireEvent.change(screen.getByTestId('settings-search'), { target: { value: query } });
        expect(screen.getByTestId('settings-search-results').textContent).toContain(message);
        const result = screen.getAllByTestId(`settings-search-result-${hit}`).find(node => node.querySelector('span')?.textContent === query)!;
        fireEvent.click(result);
        expect(screen.getByTestId('settings-search-notice').textContent).toContain(message);
        expect(screen.getByTestId(target).dataset['settingsSearchHit']).toBe('true');
    });

    it('finds the real error when the daemon reports a failed TCP listener', () => {
        setup({ transport: { tcp: { requested: 19400, host: '127.0.0.1', bound: null, error: 'EADDRINUSE' } } });
        search('TCP listener failed to bind', 'tcp-bind-error');
        expect(screen.getByTestId('tcp-bind-error').dataset['settingsSearchHit']).toBe('true');
        expect(screen.getByTestId('tcp-bind-error').textContent).toContain('EADDRINUSE');
    });

    it('routes hidden graph controls to the master switch without changing its value', () => {
        const settings = { ...DEFAULT_WS_SETTINGS, chrome: { ...DEFAULT_WS_SETTINGS.chrome, showSystemStats: false } };
        const setGeneralSetting = vi.fn();
        setup({ settings, actions: { ...NOOP_ACTIONS, setGeneralSetting } });
        search('Disk I/O', 'stats-kind-diskIO');
        expect(screen.queryByTestId('stats-kind-diskIO')).toBeNull();
        expect(screen.getByTestId('stats-master-row').dataset['settingsSearchHit']).toBe('true');
        expect(screen.getByTestId('settings-search-notice').textContent).toContain('Enable Show system stats');
        expect(setGeneralSetting).not.toHaveBeenCalled();
    });

    it('reveals the theme-owned background explanation instead of a missing picker', () => {
        setup({ settings: { ...DEFAULT_WS_SETTINGS, appearance: { ...DEFAULT_WS_SETTINGS.appearance, theme: 'Dracula' } } });
        search('Background colour', 'terminal-background');
        expect(screen.getByTestId('terminal-background-locked').dataset['settingsSearchHit']).toBe('true');
        expect(screen.getByTestId('settings-search-notice').textContent).toContain('None (Custom)');
    });

    it('keeps keyboard focus in the dialog when the found Reset button is disabled', () => {
        const { onClose } = setup();
        search('Reset chrome colours', 'chrome-colors-reset');
        expect((screen.getByTestId('chrome-colors-reset') as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId('settings-window').contains(document.activeElement)).toBe(true);
        fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('routes pairing links to the pairing prerequisite and never fabricates a live link', () => {
        setup();
        search('Copy pairing link', 'remote-pair-copy');
        expect(screen.getByTestId('settings-search-notice').textContent).toContain('Pair a device');
        expect(screen.getByTestId('remote-pair-go').dataset['settingsSearchHit']).toBe('true');
    });

    it('cleans the old flash on navigation and does not show a stale search notice', () => {
        setup();
        search('Group band fill', 'sidebar-group-fill');
        const target = screen.getByTestId('sidebar-group-fill');
        fireEvent.click(screen.getByTestId('settings-tab-button-general'));
        expect(target.dataset['settingsSearchHit']).toBeUndefined();
        expect(screen.queryByTestId('settings-search-notice')).toBeNull();
    });

    it('keeps phone search on the list and transfers focus to an opened graph control', () => {
        setup({ formFactorWindow: createFakePhoneWindow() });
        search('Graph colour', 'sparkline-color');
        expect(screen.queryByTestId('settings-search')).toBeNull();
        expect(screen.getByTestId('sparkline-color').closest('details')?.open).toBe(true);
        expect(screen.getByTestId('settings-panel').contains(document.activeElement)).toBe(true);
        fireEvent.click(screen.getByTestId('settings-phone-back'));
        expect(screen.getByTestId('settings-search')).toBeDefined();
        expect(screen.queryByTestId('settings-search-notice')).toBeNull();
    });
});

// Unlike an assertion on index length, these expectations originate in rendered controls.
// They cover maps (chrome colours/stat kinds), nested native components, and every Reset button.
// Removing any indexed label or Reset destination now fails even if the index construction changes.
describe('rendered Settings index completeness', () => {
    it.each(SETTINGS_TABS.map(tab => tab.id))('indexes named controls and resets in %s', async initialTab => {
        const context = { domain: { labelPresets: [], workspaces: [] }, settings: {
            ...DEFAULT_WS_SETTINGS,
            general: { ...DEFAULT_WS_SETTINGS.general, tcpPort: 19400, focusFollowsMouse: true, globalHotkey: 'super+alt+k' }
        } };
        setup({ initialTab, ...context });
        await act(async () => { await Promise.resolve(); });
        const panel = screen.getByTestId('settings-panel');
        const entries = SETTINGS_INDEX.filter(entry => entry.sectionID === initialTab);
        const labels = new Set(entries.map(entry => entry.label));
        for (const entry of entries) {
            const destination = settingsSearchDestination(entry, context);
            expect(panel.querySelector(`[data-testid="${destination.testID}"]`),
                `Missing destination for ${entry.label}: ${destination.testID}`).not.toBeNull();
        }
        for (const control of panel.querySelectorAll('input[aria-label], select[aria-label], [role="switch"][aria-label]')) {
            const label = control.getAttribute('aria-label');
            expect(labels, `${initialTab}: ${label}`).toContain(label);
        }
        for (const button of panel.querySelectorAll('button[data-testid]')) {
            if (!/^Reset\b/i.test(button.textContent?.trim() ?? '')) continue;
            expect(SETTINGS_INDEX.some(entry => entry.testID === button.getAttribute('data-testid')),
                `Missing Reset destination: ${button.getAttribute('data-testid')}`).toBe(true);
        }
    });
});

it.each([
    'werk', 'Work "Laptop"', 'Work\\Laptop', '開発機 🦑 "机"\\dev'
])('finds, reveals and focuses navigation trust for host %s without changing settings', name => {
    const save = vi.fn();
    setup({ settings: { ...DEFAULT_WS_SETTINGS, remoteDaemons: [{ name, url: 'https://werk/?token=secret' }] },
        actions: { ...NOOP_ACTIONS, setRemoteDaemons: save } });
    search('Trust plugins with navigation', 'remote-daemon-navigation-trust');
    const input = screen.getByTestId(`remote-daemon-navigation-trust-${name}`);
    expect(document.activeElement).toBe(input);
    expect(input.dataset['settingsSearchHit']).toBe('true');
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(input);
    expect(save).toHaveBeenCalledExactlyOnceWith([{ name, url: 'https://werk/?token=secret', trustedForNavigation: true }]);
});
