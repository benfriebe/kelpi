/**
 * Settings ▸ General (SET-002's first tab).
 *
 * Every control here is a config key that the daemon actually READS back — that was the bar the
 * tab previously failed, and it is what these assertions check: the exact key name, the exact
 * value, and that the two rows which are genuinely not editable say so instead of offering a
 * control that would do nothing.
 */

import { DEFAULT_WS_SETTINGS, type WsSettingsSnapshot, type WsTransportStatus } from '@nex/protocol';
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

function renderTab(
    general: Partial<WsSettingsSnapshot['general']> = {},
    transport: WsTransportStatus | null = null
) {
    const bound = actions();
    render(
        <GeneralTab
            settings={snapshot(general)}
            actions={bound}
            paths={DEFAULT_SETTINGS_PATHS}
            transport={transport}
        />
    );
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
        fireEvent.change(screen.getByTestId('new-workspace-placement-select'), {
            target: { value: 'near-selection' }
        });
        fireEvent.change(screen.getByTestId('new-group-placement-select'), {
            target: { value: 'near-selection' }
        });
        expect(bound.writes).toEqual([
            { key: 'new-workspace-placement', value: 'near-selection' },
            { key: 'new-group-placement', value: 'near-selection' }
        ]);
    });

    it('reflects the daemon’s placement value rather than a local echo', () => {
        renderTab({ newWorkspacePlacement: 'near-selection' });
        expect((screen.getByTestId('new-workspace-placement-select') as HTMLSelectElement).value).toBe(
            'near-selection'
        );
    });

    /**
     * M52. `SettingsView.swift:167-187` builds both placement rows with a bare
     * `Picker(_:selection:)` — a POP-UP menu. The one `.pickerStyle(.segmented)` in the whole
     * Settings scene is Appearance ▸ Chrome (`:345`), so a segmented control here read as a
     * stronger control than the shipped app's.
     */
    it('renders both placement rows as pop-up menus, not segmented controls', () => {
        renderTab();
        for (const id of ['new-workspace-placement', 'new-group-placement']) {
            const row = screen.getByTestId(id);
            expect(row.querySelector('select')).not.toBeNull();
            expect(row.querySelector('[role="radiogroup"]')).toBeNull();
            expect([...row.querySelectorAll('option')].map((node) => node.textContent)).toEqual([
                'Next to selection',
                'End of list'
            ]);
        }
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

    // SET-020: the Apply button exists only while the typed text differs from the live port —
    // it is the affordance that makes "this is applied deliberately" legible.
    it('offers Apply only while the typed port differs from the live one', () => {
        const bound = renderTab({ tcpPort: 19400 });
        const input = screen.getByTestId('tcp-port-input') as HTMLInputElement;
        expect(screen.queryByTestId('tcp-port-apply')).toBeNull();
        fireEvent.change(input, { target: { value: '20500' } });
        const apply = screen.getByTestId('tcp-port-apply');
        fireEvent.mouseDown(apply);
        expect(bound.writes).toEqual([{ key: 'tcp-port', value: '20500' }]);
        expect(screen.queryByTestId('tcp-port-apply')).toBeNull();
    });

    it('says the TCP listener applies on the next daemon start rather than pretending it rebinds', () => {
        renderTab({ tcpPort: 19400 });
        expect(screen.getByTestId('general-network').textContent).toContain('next daemon start');
    });

    // SET-018: the quit confirmation moved into the daemon settings store (config key
    // `confirm-quit-when-active`) and its switch lives on the Workspaces tab beside the
    // workspace-delete one, so General points there rather than carrying a second copy.
    it('no longer carries a quit row of its own', () => {
        renderTab();
        expect(screen.queryByTestId('confirm-quit-row')).toBeNull();
        expect(screen.queryByTestId('general-quit')).toBeNull();
    });

    it('points at the Workspaces tab for the settings that live there', () => {
        renderTab();
        const text = screen.getByTestId('settings-tab-general').textContent ?? '';
        expect(text).toContain('Workspaces tab');
        expect(text).toContain('quit');
    });

    // SET-021: the config file says which port was ASKED for; only the daemon knows whether the
    // bind succeeded, so the row reports what `welcome.transport` said.
    describe('SET-021 — the TCP bind outcome', () => {
        it('reports the port that is actually listening', () => {
            renderTab(
                { tcpPort: 19400 },
                { tcp: { requested: 19400, host: '127.0.0.1', bound: 19400, error: null } }
            );
            expect(screen.getByTestId('tcp-listener-row').textContent).toContain(
                'Listening on 127.0.0.1:19400'
            );
            expect(screen.queryByTestId('tcp-bind-error')).toBeNull();
        });

        it('says the port is unavailable, with the daemon’s own error, when the bind failed', () => {
            renderTab(
                { tcpPort: 19400 },
                {
                    tcp: {
                        requested: 19400,
                        host: '127.0.0.1',
                        bound: null,
                        error: 'listen EADDRINUSE: address already in use 127.0.0.1:19400'
                    }
                }
            );
            const error = screen.getByTestId('tcp-bind-error');
            expect(error.textContent).toContain('Port 19400 is unavailable');
            expect(error.textContent).toContain('EADDRINUSE');
            expect(screen.getByTestId('tcp-listener-row').textContent).toContain('unavailable');
        });

        it('does not claim a bind either way when the daemon said nothing', () => {
            renderTab({ tcpPort: 19400 });
            expect(screen.getByTestId('tcp-listener-row').textContent).toContain('as of daemon start');
            expect(screen.queryByTestId('tcp-bind-error')).toBeNull();
        });

        // A daemon started with `NEXD_TCP_PORT` (a dev container, the audit sandbox) is really
        // listening even though this config file says nothing — "Disabled" would be false.
        it('reports a listener the daemon has even when the config file does not ask for one', () => {
            renderTab({ tcpPort: 0 }, { tcp: { requested: 52114, host: '127.0.0.1', bound: 52114, error: null } });
            expect(screen.getByTestId('tcp-listener-row').textContent).toContain(
                'Listening on 127.0.0.1:52114'
            );
        });

        it('warns about a failed env-configured bind too', () => {
            renderTab(
                { tcpPort: 0 },
                { tcp: { requested: 52114, host: '127.0.0.1', bound: null, error: 'listen EADDRINUSE' } }
            );
            expect(screen.getByTestId('tcp-bind-error').textContent).toContain('Port 52114 is unavailable');
        });

        it('separates "this daemon has no TCP listener" from a failed bind', () => {
            renderTab({ tcpPort: 19400 }, { tcp: null });
            expect(screen.getByTestId('tcp-listener-row').textContent).toContain(
                'started with no TCP listener'
            );
            expect(screen.queryByTestId('tcp-bind-error')).toBeNull();
        });
    });
});
