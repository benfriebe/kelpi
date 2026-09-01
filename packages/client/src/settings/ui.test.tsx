/**
 * The shared Settings primitives — the two things every tab inherits.
 *
 * `H14`: a `Toggle` in a `.formStyle(.grouped)` form is a macOS SWITCH, and the port drew a
 * user-agent checkbox. `H11`: AppKit gives every bordered button and list row a hover response
 * for free and a `<button>` in a browser gets none, so `grep -c hover settings/*.tsx` returned
 * 0 for all 24 files. Both are asserted here rather than per tab, because both are supposed to
 * be ONE recipe — a per-tab test would pass on twenty copies that had drifted apart.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsButton, SettingsEmptyState, SettingsIconButton, SettingsToggle, useHover } from './ui';

afterEach(cleanup);

describe('the Settings switch (H14)', () => {
    function renderToggle(checked: boolean, disabled = false) {
        const onChange = vi.fn();
        render(
            <SettingsToggle
                checked={checked}
                disabled={disabled}
                label="Focus follows mouse"
                testID="probe-toggle"
                onChange={onChange}
            />
        );
        const input = screen.getByTestId('probe-toggle') as HTMLInputElement;
        const thumb = screen.getByTestId('probe-toggle-thumb');
        return { input, thumb, onChange };
    }

    // The heart of the finding: the user agent must not be the thing drawing this control.
    it('is an appearance-reset track, not a user-agent checkbox', () => {
        const { input } = renderToggle(false);
        expect(input.style.appearance || input.style.getPropertyValue('-webkit-appearance')).toBe('none');
        // S24: the REGULAR control size, 38 × 22. This assertion used to pin 26 × 15 — the
        // `.controlSize(.small)` track the component's comment claimed — but `grep -rn
        // controlSize SettingsView.swift` returns nothing, so every one of these rows is a plain
        // `Toggle` in a grouped `Form` and AppKit draws it at regular size. 15 px was also the
        // shortest hit target in Settings after the colour wells.
        expect(input.style.width).toBe('38px');
        expect(input.style.height).toBe('22px');
        expect(input.style.borderRadius === '' ? input.className : input.style.borderRadius).toContain(
            'rounded-full'
        );
    });

    it('keeps the switch semantics and the accessible name', () => {
        const { input } = renderToggle(true);
        expect(input.getAttribute('role')).toBe('switch');
        expect(screen.getByRole('switch', { name: 'Focus follows mouse' })).toBe(input);
        expect(input.checked).toBe(true);
    });

    it('fills with the accent when on, and a neutral track when off', () => {
        const on = renderToggle(true);
        expect(on.input.style.background).toContain('--kelpi-accent');
        cleanup();
        const off = renderToggle(false);
        expect(off.input.style.background).not.toContain('--kelpi-accent');
        expect(off.input.style.background).toContain('128, 128, 128');
    });

    // The thumb slides rather than appearing — the animation the real control has.
    it('slides the thumb across the track, with a transition on both', () => {
        const off = renderToggle(false);
        expect(off.thumb.style.left).toBe('2px');
        expect(off.thumb.style.transition).toContain('left');
        expect(off.input.style.transition).toContain('background-color');
        cleanup();
        const on = renderToggle(true);
        // S24: 38 (track) − 18 (thumb) − 2 (inset) = 18. Was 13 against the old 26 × 15 track.
        expect(on.thumb.style.left).toBe('18px');
    });

    it('still toggles on click, and reports the new value', () => {
        const { input, onChange } = renderToggle(false);
        fireEvent.click(input);
        expect(onChange).toHaveBeenCalledWith(true);
    });

    it('dims the whole control when disabled, thumb included', () => {
        const { input } = renderToggle(true, true);
        expect(input.disabled).toBe(true);
        const wrapper = input.parentElement;
        expect(wrapper?.style.opacity).toBe('0.4');
    });
});

describe('the Settings hover recipe (H11)', () => {
    it('fills a button and lifts its border under the pointer', () => {
        render(
            <SettingsButton testID="probe-button" onClick={vi.fn()}>
                Reset
            </SettingsButton>
        );
        const button = screen.getByTestId('probe-button');
        expect(button.dataset['hovered']).toBe('false');
        expect(button.style.background).toBe('transparent');
        expect(button.style.borderColor).toContain('--kelpi-border');

        fireEvent.mouseEnter(button);
        expect(button.dataset['hovered']).toBe('true');
        expect(button.style.background).toContain('--kelpi-selection-fill');
        expect(button.style.borderColor).toContain('--kelpi-selection-stroke');

        fireEvent.mouseLeave(button);
        expect(button.dataset['hovered']).toBe('false');
        expect(button.style.background).toBe('transparent');
    });

    // A dimmed control that lit up would be telling the user it can be clicked.
    it('leaves a disabled button dark', () => {
        render(
            <SettingsButton testID="probe-button" disabled onClick={vi.fn()}>
                Reset
            </SettingsButton>
        );
        const button = screen.getByTestId('probe-button');
        fireEvent.mouseEnter(button);
        expect(button.dataset['hovered']).toBe('false');
        expect(button.style.background).toBe('transparent');
    });

    /**
     * M43's ~10 px `×` is now a square that lights — the same fill, one size down.
     *
     * SPACING-REVIEW S50 (owner-directed) took that square from 16 to 20 px and gave it a
     * `-m-0.5` bleed, so the LAID-OUT size is still M43's 16 px and no consumer's column moved.
     * The bleed is asserted alongside the size: `h-5 w-5` without it is a different control.
     */
    it('gives the glyph buttons a 20 px square target that occupies 16 px, and the same fill (S50)', () => {
        render(
            <SettingsIconButton testID="probe-icon" ariaLabel="Remove ⌘D" onClick={vi.fn()}>
                ×
            </SettingsIconButton>
        );
        const button = screen.getByTestId('probe-icon');
        expect(button.className).toContain('h-5');
        expect(button.className).toContain('w-5');
        expect(button.className).toContain('-m-0.5');
        fireEvent.mouseEnter(button);
        expect(button.style.background).toContain('--kelpi-selection-fill');
    });

    it('is one hook, so a control cannot report hover it does not paint', () => {
        function Probe(): React.ReactElement {
            const { hovered, hoverProps } = useHover();
            return (
                <div data-testid="probe" {...hoverProps}>
                    {hovered ? 'over' : 'away'}
                </div>
            );
        }
        render(<Probe />);
        const probe = screen.getByTestId('probe');
        expect(probe.textContent).toBe('away');
        fireEvent.mouseEnter(probe);
        expect(probe.dataset['hovered']).toBe('true');
        expect(probe.textContent).toBe('over');
    });
});

// ── §N41 (issue #4) ─────────────────────────────────────────────────────────────

/**
 * The empty state has exactly TWO alignments, and which one a tab gets is a property of the
 * space it hands the block, not of the block. Asserted here, on the shared component, for
 * ui.test.tsx's standing reason: a per-tab test would pass on four copies that had drifted.
 */
describe('the Settings empty state (M45, §N41)', () => {
    function renderEmpty(align?: 'center' | 'start') {
        render(
            <SettingsEmptyState
                testID="probe-empty"
                glyph={<svg width="28" height="28" />}
                title="Nothing yet"
                detail="A sentence about what would be here."
                {...(align === undefined ? {} : { align })}
            />
        );
        return screen.getByTestId('probe-empty');
    }

    // M45: the three tabs that give it a whole fill keep the Swift's centred `VStack`.
    it('centres itself by default, in the fill, with the 24 px inset and the 180 px floor', () => {
        const empty = renderEmpty();
        expect(empty.className).toContain('text-center');
        expect(empty.className).toContain('items-center');
        expect(empty.className).toContain('px-6');
        expect(empty.className).toContain('min-h-[180px]');
    });

    // §N41: and the one that stands in a list's band reads from that list's left margin.
    it('reads from the left margin when asked, with no inset of its own to break it', () => {
        const empty = renderEmpty('start');
        expect(empty.className).toContain('text-left');
        expect(empty.className).toContain('items-start');
        expect(empty.className).not.toContain('text-center');
        expect(empty.className).not.toContain('items-center');
        // A left margin the block then indents 24 px off is not a left margin.
        expect(empty.className).not.toContain('px-6');
    });
});
