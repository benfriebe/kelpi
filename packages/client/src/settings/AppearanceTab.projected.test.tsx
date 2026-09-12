/**
 * What changed for Appearance when its plain rows moved onto the shared model, stated as tests.
 *
 * The markup did not move (`settings-parity`, `settings-density`, `settings-low-fidelity` and
 * `tabs` all still pass unmodified), but the WRITE PATH did: every plain row now goes through the
 * surface's one funnel, which has a single-flight queue and SET-099's "committing the value the file
 * already holds is not a write" rule. Both are improvements over writing on every gesture, and both
 * are behaviour a reader would otherwise have to infer from three modules at once, so they are
 * pinned here.
 *
 * The hand-built rows are unaffected and keep their own tests: the preset gallery, the share codes,
 * the chrome colour map, the theme picker, the group-band fill, the adaptive sparkline colour and
 * the per-metric stat set all still write directly (`tabs.test.tsx`).
 */

import { DEFAULT_WS_SETTINGS, type WsSettingsSnapshot } from '@kelpi/protocol';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppearanceTab } from './AppearanceTab';
import { SETTINGS_LIMITS } from './contract';
import { DEFAULT_SETTINGS_PATHS, type SettingsActions } from './types';

function renderTab(overrides: Partial<WsSettingsSnapshot> = {}) {
    const ghostty: { key: string; value: string | null }[] = [];
    const general: { key: string; value: string }[] = [];
    const actions: SettingsActions = {
        setKeybinding: vi.fn(),
        resetKeybindings: vi.fn(),
        setGeneralSetting: (key, value) => general.push({ key, value }),
        setGhosttySetting: (key, value) => ghostty.push({ key, value }),
        setProfiles: vi.fn(),
        addLabelPreset: vi.fn(),
        updateLabelPreset: vi.fn(),
        removeLabelPreset: vi.fn()
    };
    render(
        <AppearanceTab
            settings={{ ...DEFAULT_WS_SETTINGS, ...overrides }}
            paths={DEFAULT_SETTINGS_PATHS}
            actions={actions}
            bucket="dark"
        />
    );
    return { ghostty, general };
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('an Appearance row on the shared model', () => {
    /**
     * The single-flight queue, through a drag.
     *
     * `SliderField` debounces by 250 ms, so a drag is already coalesced into a handful of commits;
     * the queue coalesces what is left. One write goes out, the newest value waits behind it, and
     * nothing else is sent until the daemon's broadcast settles the first or the settle budget
     * expires - which is what stops a drag becoming a queue of config-file rewrites the daemon has
     * to apply in order.
     */
    it('sends one write per drag and holds the newest value behind it', () => {
        const { ghostty } = renderTab();
        const slider = screen.getByTestId('terminal-opacity-slider');
        fireEvent.change(slider, { target: { value: '0.85' } });
        vi.advanceTimersByTime(400);
        expect(ghostty).toEqual([{ key: 'background-opacity', value: '0.85' }]);

        // Still in flight: the broadcast that acknowledges the first write has not arrived.
        fireEvent.change(slider, { target: { value: '0.7' } });
        vi.advanceTimersByTime(400);
        fireEvent.change(slider, { target: { value: '0.6' } });
        vi.advanceTimersByTime(400);
        expect(ghostty).toEqual([{ key: 'background-opacity', value: '0.85' }]);

        // The queue stops waiting after the settle budget and sends the NEWEST ask, once - not the
        // two it swallowed.
        vi.advanceTimersByTime(SETTINGS_LIMITS.writeSettleMs);
        expect(ghostty).toEqual([
            { key: 'background-opacity', value: '0.85' },
            { key: 'background-opacity', value: '0.60' }
        ]);
    });

    /**
     * SET-099, generalised: committing the value the file already holds is not a write.
     *
     * The hand-written rows wrote on every gesture, so re-picking the selected option rewrote the
     * line. The surface refuses that for every projected row (the TCP port is the one row that opts
     * out, because its Apply has always written unconditionally).
     */
    it('writes nothing when the stored value is re-selected', () => {
        const { general } = renderTab();
        // `chrome-appearance` is 'system' in the shipped defaults.
        fireEvent.click(screen.getByRole('radio', { name: 'System' }));
        expect(general).toEqual([]);
        fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
        expect(general).toEqual([{ key: 'chrome-appearance', value: 'dark' }]);

        // The same for a toggle: the master stats switch is on by default.
        const master = screen.getByTestId('stats-master-toggle') as HTMLInputElement;
        expect(master.checked).toBe(true);
        fireEvent.click(master);
        expect(general.at(-1)).toEqual({ key: 'show-system-stats', value: 'false' });
        const before = general.length;
        // Committing false again while the file still says true is a real ask, so it queues behind
        // the in-flight write rather than being dropped: what is refused is a value that MATCHES.
        fireEvent.click(screen.getByTestId('stats-master-toggle'));
        expect(general).toHaveLength(before);
    });
});
