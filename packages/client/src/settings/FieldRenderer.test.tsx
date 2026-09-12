/**
 * One descriptor, one control - and the write that control's value becomes.
 *
 * The renderer is where the fidelity contract meets the catalog: every row of General and
 * Workspaces is drawn through it now, so a descriptor that lost its row test id, its caption or
 * its frame would take a tab's audit selectors and a metric with it. These cases pin the three
 * things the tabs' own suites cannot see from the outside:
 *
 *   - each control kind renders the primitive `controls.tsx` / `ui.tsx` already ship, at the test
 *     ids the catalog names;
 *   - each one commits the value the user produced, with the field it came from;
 *   - a refusal (an error, a disabled field) is drawn and, in the disabled case, sends nothing.
 */

import { DEFAULT_WS_SETTINGS, type WsSettingsSnapshot } from '@kelpi/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FieldRenderer, SETTINGS_DESTRUCTIVE_TONE, type FieldRendererProps } from './FieldRenderer';
import type {
    SettingsColorFieldDescriptor,
    SettingsFieldDescriptor,
    SettingsSegmentedFieldDescriptor,
    SettingsSliderFieldDescriptor
} from './contract';
import { SETTINGS_WRITE_DEBOUNCE_MS } from './controls';
import { describeSettingsField, settingsFieldDefinition } from './sections';
import type { SettingsActions } from './types';

afterEach(cleanup);

/** jsdom normalises an inline colour to `rgb()`, so the literal is compared through the same lens. */
function rgb(hex: string): string {
    const channels = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
    return `rgb(${channels.map((channel) => String(channel)).join(', ')})`;
}

function actions(): SettingsActions & { readonly writes: { key: string; value: string | null }[] } {
    const writes: { key: string; value: string | null }[] = [];
    return {
        writes,
        setKeybinding: vi.fn(),
        resetKeybindings: vi.fn(),
        setGeneralSetting: (key, value) => writes.push({ key, value }),
        setGhosttySetting: (key, value) => writes.push({ key, value }),
        setProfiles: vi.fn(),
        addLabelPreset: vi.fn(),
        updateLabelPreset: vi.fn(),
        removeLabelPreset: vi.fn()
    };
}

/** A field as the catalog describes it, for the ids the two rewired tabs actually render. */
function catalogField(id: string, settings: WsSettingsSnapshot = DEFAULT_WS_SETTINGS): SettingsFieldDescriptor {
    const definition = settingsFieldDefinition(id);
    if (definition === undefined) throw new Error(`no such settings field: ${id}`);
    return describeSettingsField(definition, settings);
}

/** The two kinds phase 1's catalog has no field of yet; the renderer still owes them a control. */
const SEGMENTED: SettingsSegmentedFieldDescriptor = {
    kind: 'segmented',
    id: 'probe.segmented',
    sectionID: 'general',
    groupID: 'general-workspaces',
    label: 'Probe segments',
    detail: '',
    testID: 'probe-segmented',
    value: 'a',
    default: 'a',
    choices: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' }
    ]
};

const COLOR: SettingsColorFieldDescriptor = {
    kind: 'color',
    id: 'probe.color',
    sectionID: 'general',
    groupID: 'general-workspaces',
    label: 'Probe colour',
    detail: '',
    testID: 'probe-color',
    value: '#112233',
    default: '#000000'
};

const SLIDER: SettingsSliderFieldDescriptor = {
    kind: 'slider',
    id: 'probe.slider',
    sectionID: 'workspaces',
    groupID: 'panes-section',
    label: 'Probe delay',
    detail: 'A caption.',
    testID: 'probe-slider',
    rowTestID: 'probe-row',
    value: 900,
    default: 100,
    min: 0,
    max: 500,
    step: 25,
    valueLabel: '900 ms'
};

function draw(field: SettingsFieldDescriptor): { readonly onCommit: FieldRendererProps['onCommit'] } {
    const onCommit = vi.fn();
    render(<FieldRenderer field={field} onCommit={onCommit} />);
    return { onCommit };
}

describe('one descriptor, one control', () => {
    it('draws a switch inside its row, at both of the catalog’s test ids', () => {
        const { onCommit } = draw(catalogField('general.autoDetectRepos'));
        const row = screen.getByTestId('auto-detect-repos-row');
        const toggle = screen.getByTestId('auto-detect-repos-toggle') as HTMLInputElement;
        expect(row.contains(toggle)).toBe(true);
        expect(toggle.checked).toBe(true);
        expect(row.textContent).toContain('Auto-detect from pane directories');
        fireEvent.click(toggle);
        expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ id: 'general.autoDetectRepos' }), false);
    });

    // L83: the worktree base path is the one text row whose FRAME is a metric, and the renderer is
    // where that flag now lives.
    it('draws a text field, borderless where the metric asks for it, and commits on blur', () => {
        const { onCommit } = draw(catalogField('general.worktreeBasePath'));
        const input = screen.getByTestId('worktree-base-path-input') as HTMLInputElement;
        expect(input.value).toBe('~/kelpi/worktrees/<repo>');
        expect(input.className).toContain('border-0');
        expect(input.className).toContain('flex-1');
        fireEvent.change(input, { target: { value: '<repo>/.worktrees' } });
        expect(onCommit).not.toHaveBeenCalled();
        fireEvent.blur(input);
        expect(onCommit).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'general.worktreeBasePath' }),
            '<repo>/.worktrees'
        );
    });

    // SET-020: the port field is 80 pt, right-aligned, and offers Apply only while the typed text
    // differs from the live value.
    it('draws a number as a narrow field with an Apply affordance', () => {
        const settings: WsSettingsSnapshot = {
            ...DEFAULT_WS_SETTINGS,
            general: { ...DEFAULT_WS_SETTINGS.general, tcpPort: 19400 }
        };
        const { onCommit } = draw(catalogField('general.tcpPort', settings));
        const input = screen.getByTestId('tcp-port-input') as HTMLInputElement;
        expect(input.value).toBe('19400');
        expect(input.className).toContain('w-[80px]');
        expect(screen.queryByTestId('tcp-port-apply')).toBeNull();
        fireEvent.change(input, { target: { value: '20500' } });
        fireEvent.mouseDown(screen.getByTestId('tcp-port-apply'));
        expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ id: 'general.tcpPort' }), '20500');
    });

    // M52: a pop-up menu, not a segmented control.
    it('draws a select as a pop-up menu and commits the chosen option', () => {
        const { onCommit } = draw(catalogField('general.newWorkspacePlacement'));
        const row = screen.getByTestId('new-workspace-placement');
        expect(row.querySelector('[role="radiogroup"]')).toBeNull();
        const select = screen.getByTestId('new-workspace-placement-select') as HTMLSelectElement;
        expect([...select.options].map((option) => option.textContent)).toEqual([
            'Next to selection',
            'End of list'
        ]);
        fireEvent.change(select, { target: { value: 'near-selection' } });
        expect(onCommit).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'general.newWorkspacePlacement' }),
            'near-selection'
        );
    });

    it('draws a segmented field as a radiogroup and commits the segment', () => {
        const { onCommit } = draw(SEGMENTED);
        expect(screen.getByTestId('probe-segmented').querySelector('[role="radiogroup"]')).not.toBeNull();
        fireEvent.click(screen.getByTestId('probe-segmented-b'));
        expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ id: 'probe.segmented' }), 'b');
    });

    // SET-041: a colour well drags at 60 Hz, so `ColorField` funnels it through one debounce
    // rather than one socket round trip per pointer move. The renderer inherits that as-is.
    it('draws a colour well and commits the hex once the drag settles', () => {
        vi.useFakeTimers();
        try {
            const { onCommit } = draw(COLOR);
            const input = screen.getByTestId('probe-color-input') as HTMLInputElement;
            expect(input.getAttribute('type')).toBe('color');
            fireEvent.change(input, { target: { value: '#445566' } });
            expect(onCommit).not.toHaveBeenCalled();
            act(() => {
                vi.advanceTimersByTime(SETTINGS_WRITE_DEBOUNCE_MS);
            });
            expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ id: 'probe.color' }), '#445566');
        } finally {
            vi.useRealTimers();
        }
    });

    /**
     * L82. The readout is the catalog's `valueLabel` (formatted from the RAW value, so a
     * hand-edited 900 ms says 900 ms), while the track is clamped into the field's own range - the
     * rule `WorkspacesTab` used to apply inline with `Math.min`.
     */
    it('draws a slider with a clamped track and the catalog’s own readout', () => {
        const { onCommit } = draw(SLIDER);
        const slider = screen.getByTestId('probe-slider') as HTMLInputElement;
        expect(slider.getAttribute('type')).toBe('range');
        expect(slider.value).toBe('500');
        expect(slider.step).toBe('25');
        const readout = screen.getByTestId('probe-value');
        expect(readout.textContent).toBe('900 ms');
        expect(readout.className).toContain('tabular-nums');
        expect(readout.className).toContain('w-[55px]');
        expect(readout.className).not.toContain('font-mono');
        fireEvent.change(slider, { target: { value: '250' } });
        expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ id: 'probe.slider' }), '250');
    });

    // M46's caption is a row of its own; a caption the catalog left EMPTY is no row at all.
    it('renders no caption for a field whose detail is empty', () => {
        draw(catalogField('general.worktreeBasePath'));
        const row = screen.getByTestId('worktree-base-path');
        expect(row.children).toHaveLength(1);
    });
});

describe('what a refusal looks like', () => {
    it('draws the error under the control, in the destructive tone', () => {
        const field = { ...catalogField('general.tcpPort'), error: 'Enter a valid number.' };
        draw(field);
        const error = screen.getByTestId('tcp-port-error');
        expect(error.textContent).toBe('Enter a valid number.');
        expect(error.style.color).toBe(rgb(SETTINGS_DESTRUCTIVE_TONE));
    });

    it('disables a switch the host is refusing, and sends nothing', () => {
        const { onCommit } = draw({ ...catalogField('general.autoDetectRepos'), disabled: true });
        const toggle = screen.getByTestId('auto-detect-repos-toggle') as HTMLInputElement;
        expect(toggle.disabled).toBe(true);
        fireEvent.click(toggle);
        expect(onCommit).not.toHaveBeenCalled();
    });

    it('dims a writing control the host is refusing, and sends nothing', () => {
        const { onCommit } = draw({ ...catalogField('general.worktreeBasePath'), disabled: true });
        const input = screen.getByTestId('worktree-base-path-input') as HTMLInputElement;
        const dimmed = screen.getByTestId('worktree-base-path').parentElement;
        expect(dimmed?.getAttribute('data-disabled')).toBe('true');
        expect(dimmed?.getAttribute('aria-disabled')).toBe('true');
        fireEvent.change(input, { target: { value: 'anywhere' } });
        fireEvent.blur(input);
        expect(onCommit).not.toHaveBeenCalled();
    });

    /*
     * `busy` is deliberately NOT an inert control: a write has left and the daemon's broadcast is
     * what moves the switch, which is the no-local-echo rule every one of these rows has always
     * had. Greying the control for a round trip would make the second click land on nothing.
     */
    it('leaves a busy field usable', () => {
        const { onCommit } = draw({ ...catalogField('general.autoDetectRepos'), busy: true });
        const toggle = screen.getByTestId('auto-detect-repos-toggle') as HTMLInputElement;
        expect(toggle.disabled).toBe(false);
        fireEvent.click(toggle);
        expect(onCommit).toHaveBeenCalled();
    });
});

/*
 * ── the draft outranks the snapshot ─────────────────────────────────────────────────
 *
 * The draft lives in the surface keyed to the field, not inside whoever is painting it. That is
 * what makes a half-typed value survive a repaint - a section change, a re-render, and in phase 2
 * a presenter that failed and handed the section back to this panel. Only the three controls with
 * a typing phase draw it; a switch, a picker and a slider always draw the daemon's value, which is
 * the no-local-echo rule those rows have always had.
 */
describe('a held draft', () => {
    it('is what a text field shows, with its error under it', () => {
        draw({
            ...catalogField('general.worktreeBasePath'),
            draft: '<repo>/half-typed',
            error: 'Base path must be at most 1024 characters.'
        });
        expect((screen.getByTestId('worktree-base-path-input') as HTMLInputElement).value).toBe(
            '<repo>/half-typed'
        );
        expect(screen.getByTestId('worktree-base-path-error').textContent).toBe(
            'Base path must be at most 1024 characters.'
        );
    });

    it('is what a number field shows, rather than the value the daemon last sent', () => {
        draw({ ...catalogField('general.tcpPort'), draft: '205' });
        expect((screen.getByTestId('tcp-port-input') as HTMLInputElement).value).toBe('205');
    });

    it('is what a colour well shows', () => {
        draw({ ...COLOR, draft: '#aabbcc' });
        expect((screen.getByTestId('probe-color-input') as HTMLInputElement).value).toBe('#aabbcc');
    });

    it('is ignored by the controls with no typing phase', () => {
        draw({ ...catalogField('general.autoDetectRepos'), draft: 'false' });
        // The switch still reads the snapshot: the draft between a click and the broadcast is not
        // something to paint, or the row would echo locally.
        expect((screen.getByTestId('auto-detect-repos-toggle') as HTMLInputElement).checked).toBe(true);
    });
});
