import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clientKeyBindings } from '../chrome';
import { CAPTURED_FEEDBACK_MS, KeybindingsTab } from './KeybindingsTab';
import type { SettingsActions } from './types';

function actions(): SettingsActions & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        setKeybinding: (action, trigger) => calls.push(`set:${action}:${trigger ?? 'null'}`),
        resetKeybindings: (action) => calls.push(`reset:${action ?? 'all'}`),
        setGeneralSetting: vi.fn(),
        setGhosttySetting: vi.fn(),
        setProfiles: vi.fn(),
        addLabelPreset: vi.fn(),
        updateLabelPreset: vi.fn(),
        removeLabelPreset: vi.fn()
    };
}

function setup(lines: readonly string[] = [], globalHotkey?: string | null) {
    const bound = actions();
    render(
        <KeybindingsTab
            bindings={clientKeyBindings(lines)}
            actions={bound}
            configPath="~/.config/kelpi/config"
            {...(globalHotkey === undefined ? {} : { globalHotkey })}
        />
    );
    return bound;
}

/** Run out SET-090's captured-combo beat so the row disarms. */
function settleCapture(): void {
    act(() => {
        vi.advanceTimersByTime(CAPTURED_FEEDBACK_MS + 10);
    });
}

afterEach(cleanup);

describe('the keybindings table', () => {
    it('renders the six visible sections and no web-pane row', () => {
        setup();
        expect(screen.getByRole('table', { name: 'Pane Management keybindings' })).toBeDefined();
        expect(screen.getByRole('table', { name: 'Search keybindings' })).toBeDefined();
        expect(screen.queryByTestId('keybinding-row-web_back')).toBeNull();
    });

    it('shows every trigger of a multiply-bound action, and a dash for an unbound one', () => {
        setup();
        const row = screen.getByTestId('keybinding-row-focus_next_pane');
        expect(row.textContent).toContain('⌥⌘→');
        expect(row.textContent).toContain('⌘]');
        expect(screen.getByTestId('keybinding-empty-open_diff').textContent).toBe('-');
    });

    it('enables Reset only for a row that differs from its default', () => {
        const bound = setup(['ctrl+alt+t=split_right']);
        const changed = screen.getByTestId('keybinding-reset-split_right') as HTMLButtonElement;
        const untouched = screen.getByTestId('keybinding-reset-split_down') as HTMLButtonElement;
        expect(changed.disabled).toBe(false);
        expect(untouched.disabled).toBe(true);
        fireEvent.click(changed);
        expect(bound.calls).toEqual(['reset:split_right']);
    });

    it('enables Reset All only once something is customised', () => {
        const clean = setup();
        expect((screen.getByTestId('reset-all-keybindings') as HTMLButtonElement).disabled).toBe(true);
        expect(clean.calls).toEqual([]);
        cleanup();

        const dirty = setup(['ctrl+alt+t=split_right']);
        fireEvent.click(screen.getByTestId('reset-all-keybindings'));
        expect(dirty.calls).toEqual(['reset:all']);
    });
});

describe('the recorder', () => {
    it('captures the next keystroke, SHOWS it, then binds it and closes (SET-090)', () => {
        vi.useFakeTimers();
        try {
            const bound = setup();
            fireEvent.click(screen.getByTestId('keybinding-record-open_diff'));
            expect(screen.getByTestId('keybinding-record-open_diff').textContent).toBe('Press a key…');
            fireEvent.keyDown(window, { code: 'KeyJ', ctrlKey: true, altKey: true });
            expect(bound.calls).toEqual(['set:open_diff:ctrl+alt+j']);
            // The Swift sheet swapped its label to the captured chord before committing; the
            // row does the same, so the user sees WHAT was captured.
            expect(screen.getByTestId('keybinding-record-open_diff').textContent).toBe('⌃⌥J');
            // A second keystroke during the beat records nothing — the listener is gone.
            fireEvent.keyDown(window, { code: 'KeyK', ctrlKey: true, altKey: true });
            expect(bound.calls).toEqual(['set:open_diff:ctrl+alt+j']);
            settleCapture();
            expect(screen.getByTestId('keybinding-record-open_diff').textContent).toBe('Record');
        } finally {
            vi.useRealTimers();
        }
    });

    it('refuses a combo the global hotkey owns, with the Swift message (SET-091)', () => {
        const bound = setup([], 'ctrl+alt+space');
        fireEvent.click(screen.getByTestId('keybinding-record-open_diff'));
        fireEvent.keyDown(window, { code: 'Space', ctrlKey: true, altKey: true });
        expect(bound.calls).toEqual([]);
        expect(screen.getByTestId('recorder-message').textContent).toBe('Already bound to the global hotkey');
        // No row holds it, so there is nothing to click through to.
        expect(screen.queryByTestId('recorder-conflict-jump')).toBeNull();
        expect(screen.getByTestId('keybinding-record-open_diff').textContent).toBe('Press a key…');
    });

    it('clicks through from a conflict to the row that holds the combo (SET-091)', () => {
        setup();
        fireEvent.click(screen.getByTestId('keybinding-record-open_diff'));
        fireEvent.keyDown(window, { code: 'KeyD', metaKey: true });
        fireEvent.click(screen.getByTestId('recorder-conflict-jump'));
        // The holder's own recorder is now armed, and the one that was refused is not.
        expect(screen.getByTestId('keybinding-record-split_right').textContent).toBe('Press a key…');
        expect(screen.getByTestId('keybinding-record-open_diff').textContent).toBe('Record');
    });

    it('cancels from the Cancel button as well as Escape (SET-094)', () => {
        const bound = setup();
        fireEvent.click(screen.getByTestId('keybinding-record-open_diff'));
        fireEvent.click(screen.getByTestId('keybinding-cancel-open_diff'));
        expect(bound.calls).toEqual([]);
        expect(screen.getByTestId('keybinding-record-open_diff').textContent).toBe('Record');
        fireEvent.keyDown(window, { code: 'KeyJ', ctrlKey: true, altKey: true });
        expect(bound.calls).toEqual([]);
    });

    it('refuses a taken combo, stays open, and writes nothing', () => {
        const bound = setup();
        fireEvent.click(screen.getByTestId('keybinding-record-open_diff'));
        fireEvent.keyDown(window, { code: 'KeyD', metaKey: true });
        expect(bound.calls).toEqual([]);
        expect(screen.getByTestId('recorder-message').textContent).toBe('Already bound to “Split Right”');
        expect(screen.getByTestId('keybinding-record-open_diff').textContent).toBe('Press a key…');

        // A second, free attempt still commits — the sheet never had to be re-opened.
        fireEvent.keyDown(window, { code: 'KeyJ', ctrlKey: true, altKey: true });
        expect(bound.calls).toEqual(['set:open_diff:ctrl+alt+j']);
    });

    it('asks for a modifier before accepting a bare letter', () => {
        const bound = setup();
        fireEvent.click(screen.getByTestId('keybinding-record-open_diff'));
        fireEvent.keyDown(window, { code: 'KeyJ' });
        expect(bound.calls).toEqual([]);
        expect(screen.getByTestId('recorder-message').textContent).toContain('modifier');
    });

    it('cancels on Escape without writing', () => {
        const bound = setup();
        fireEvent.click(screen.getByTestId('keybinding-record-open_diff'));
        fireEvent.keyDown(window, { code: 'Escape' });
        expect(bound.calls).toEqual([]);
        expect(screen.getByTestId('keybinding-record-open_diff').textContent).toBe('Record');
        // The listener is gone: a later keystroke is not swallowed into a stale recording.
        fireEvent.keyDown(window, { code: 'KeyJ', ctrlKey: true, altKey: true });
        expect(bound.calls).toEqual([]);
    });

    it('commits nothing when the action’s own combo is re-recorded', () => {
        const bound = setup();
        fireEvent.click(screen.getByTestId('keybinding-record-split_right'));
        fireEvent.keyDown(window, { code: 'KeyD', metaKey: true });
        expect(bound.calls).toEqual([]);
    });
});

describe('removing one trigger', () => {
    it('unbinds the action and re-binds the triggers it keeps', () => {
        const bound = setup();
        fireEvent.click(screen.getByTestId('keybinding-remove-focus_next_pane-super+]'));
        expect(bound.calls).toEqual(['set:focus_next_pane:null', 'set:focus_next_pane:alt+super+right']);
    });

    it('leaves an action with a single trigger simply unbound', () => {
        const bound = setup();
        fireEvent.click(screen.getByTestId('keybinding-remove-split_right-super+d'));
        expect(bound.calls).toEqual(['set:split_right:null']);
    });
});
