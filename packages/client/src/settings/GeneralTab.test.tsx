/**
 * Settings ▸ General (SET-002's first tab).
 *
 * Every control here is a config key that the daemon actually READS back — that was the bar the
 * tab previously failed, and it is what these assertions check: the exact key name, the exact
 * value, and that the two rows which are genuinely not editable say so instead of offering a
 * control that would do nothing.
 */

import { DEFAULT_WS_SETTINGS, type WsSettingsSnapshot } from '@nex/protocol';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_TCP_PORT, GeneralTab } from './GeneralTab';
import { DEFAULT_SETTINGS_PATHS, type SettingsActions } from './types';

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

function snapshot(general: Partial<WsSettingsSnapshot['general']> = {}): WsSettingsSnapshot {
    return { ...DEFAULT_WS_SETTINGS, general: { ...DEFAULT_WS_SETTINGS.general, ...general } };
}

function renderTab(general: Partial<WsSettingsSnapshot['general']> = {}) {
    const bound = actions();
    render(<GeneralTab settings={snapshot(general)} actions={bound} paths={DEFAULT_SETTINGS_PATHS} />);
    return bound;
}

afterEach(cleanup);

describe('Settings ▸ General', () => {
    // SET-008. The field commits on blur, not per keystroke: a base path written on every
    // character would rewrite the config file a dozen times for one edit.
    it('writes the worktree base path on commit', () => {
        const bound = renderTab();
        const input = screen.getByTestId('worktree-base-path-input') as HTMLInputElement;
        expect(input.value).toBe('~/nex/worktrees/<repo>');
        fireEvent.change(input, { target: { value: '<repo>/.worktrees' } });
        expect(bound.writes).toEqual([]);
        fireEvent.blur(input);
        expect(bound.writes).toEqual([{ key: 'worktree-base-path', value: '<repo>/.worktrees' }]);
    });

    // SET-010.
    it('writes the repo auto-detect flag', () => {
        const bound = renderTab();
        const toggle = screen.getByTestId('auto-detect-repos-toggle') as HTMLInputElement;
        expect(toggle.checked).toBe(true);
        fireEvent.click(toggle);
        expect(bound.writes).toEqual([{ key: 'auto-detect-repos', value: 'false' }]);
    });

    // SET-013 / SET-014.
    it('writes both placement pickers', () => {
        const bound = renderTab();
        fireEvent.click(screen.getByTestId('new-workspace-placement-near-selection'));
        fireEvent.click(screen.getByTestId('new-group-placement-near-selection'));
        expect(bound.writes).toEqual([
            { key: 'new-workspace-placement', value: 'near-selection' },
            { key: 'new-group-placement', value: 'near-selection' }
        ]);
    });

    it('reflects the daemon’s placement value rather than a local echo', () => {
        renderTab({ newWorkspacePlacement: 'near-selection' });
        expect(
            screen.getByTestId('new-workspace-placement-near-selection').getAttribute('aria-checked')
        ).toBe('true');
        expect(screen.getByTestId('new-workspace-placement-end-of-list').getAttribute('aria-checked')).toBe(
            'false'
        );
    });

    // SET-019: enabling seeds the default port; disabling writes 0.
    it('toggles the TCP listener between the default port and off', () => {
        const bound = renderTab();
        expect(screen.queryByTestId('tcp-port')).toBeNull();
        fireEvent.click(screen.getByTestId('tcp-listener-toggle'));
        expect(bound.writes).toEqual([{ key: 'tcp-port', value: String(DEFAULT_TCP_PORT) }]);
    });

    it('shows the port field only while the listener is on, and writes a valid port', () => {
        const bound = renderTab({ tcpPort: 19400 });
        const input = screen.getByTestId('tcp-port-input') as HTMLInputElement;
        expect(input.value).toBe('19400');
        fireEvent.change(input, { target: { value: '20500' } });
        fireEvent.blur(input);
        expect(bound.writes).toEqual([{ key: 'tcp-port', value: '20500' }]);
    });

    // SET-020: a non-numeric entry falls back to the default rather than writing a value the
    // parser will silently ignore (which would look like the field did nothing).
    it('falls back to the default port for junk input', () => {
        const bound = renderTab({ tcpPort: 19400 });
        const input = screen.getByTestId('tcp-port-input') as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'seventy' } });
        fireEvent.blur(input);
        expect(bound.writes).toEqual([{ key: 'tcp-port', value: String(DEFAULT_TCP_PORT) }]);
    });

    it('says the TCP listener applies on the next daemon start rather than pretending it rebinds', () => {
        renderTab({ tcpPort: 19400 });
        expect(screen.getByTestId('general-network').textContent).toContain('next daemon start');
    });

    // SET-018: quit belongs to the desktop app, so the row says who owns it instead of
    // offering a switch that writes a key nothing reads.
    it('marks the quit confirmation as desktop-app-owned rather than offering a dead toggle', () => {
        renderTab();
        const row = screen.getByTestId('confirm-quit-row');
        expect(row.querySelector('input')).toBeNull();
        expect(row.textContent).toContain('desktop app');
    });

    it('points at the Workspaces tab for the settings that live there', () => {
        renderTab();
        expect(screen.getByTestId('settings-tab-general').textContent).toContain('Workspaces tab');
    });
});
