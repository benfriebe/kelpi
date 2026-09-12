/**
 * The settings vocabulary: what parses, what is refused, and what is allowed out.
 *
 * Three claims, one per section below. The draft funnel keeps a half-typed value editable while
 * refusing to turn it into a write; the commit funnel re-checks the parsed value against the field
 * as it is NOW; and the projection copies named fields only, so nothing a descriptor happens to be
 * carrying can ride out to a replaceable presenter.
 */

import { describe, expect, it } from 'vitest';

import { INTERACTION_LIMITS } from '../interaction/contract';
import { SETTINGS_TABS } from './catalog';
import {
    SETTINGS_LIMITS,
    SETTINGS_SECTION_IDS,
    isSettingsSectionID,
    settingsFieldDescriptor,
    validateSettingsDraft,
    validateSettingsWrite,
    type SettingsFieldDescriptor,
    type SettingsNumberFieldDescriptor,
    type SettingsSelectFieldDescriptor,
    type SettingsSliderFieldDescriptor,
    type SettingsTextFieldDescriptor,
    type SettingsToggleFieldDescriptor
} from './contract';

const base = { sectionID: 'general' as const, groupID: 'general-network', detail: '', testID: 'row' };

const toggle: SettingsToggleFieldDescriptor = {
    ...base,
    id: 'general.tcpListener',
    kind: 'toggle',
    label: 'TCP listener',
    value: false,
    default: false
};

const text: SettingsTextFieldDescriptor = {
    ...base,
    id: 'general.worktreeBasePath',
    kind: 'text',
    label: 'Base path',
    value: '~/kelpi/worktrees/<repo>',
    default: '~/kelpi/worktrees/<repo>',
    maxLength: 8
};

const port: SettingsNumberFieldDescriptor = {
    ...base,
    id: 'general.tcpPort',
    kind: 'number',
    label: 'Port',
    value: 19400,
    default: 19400,
    min: 1,
    max: 65535
};

const choice: SettingsSelectFieldDescriptor = {
    ...base,
    id: 'general.newWorkspacePlacement',
    kind: 'select',
    label: 'New workspace placement',
    value: 'end-of-list',
    default: 'end-of-list',
    choices: [
        { value: 'near-selection', label: 'Next to selection' },
        { value: 'end-of-list', label: 'End of list' }
    ]
};

const slider: SettingsSliderFieldDescriptor = {
    ...base,
    id: 'workspaces.focusDelay',
    kind: 'slider',
    label: 'Focus delay',
    value: 100,
    default: 100,
    min: 0,
    max: 500,
    step: 25,
    valueLabel: '100 ms'
};

describe('the section vocabulary', () => {
    it('is the rail, in the rail’s order', () => {
        expect([...SETTINGS_SECTION_IDS]).toEqual(SETTINGS_TABS.map((tab) => tab.id));
        expect(isSettingsSectionID('general')).toBe(true);
        expect(isSettingsSectionID('plugins')).toBe(true);
        expect(isSettingsSectionID('nonesuch')).toBe(false);
    });
});

describe('the draft funnel', () => {
    it('parses each control kind', () => {
        expect(validateSettingsDraft(toggle, true)).toBe(true);
        expect(validateSettingsDraft(toggle, 'false')).toBe(false);
        expect(validateSettingsDraft(text, 'abc')).toBe('abc');
        expect(validateSettingsDraft(port, ' 19400 ')).toBe(19400);
        // `Number.parseInt(text, 10)` semantics, kept from the control this replaced.
        expect(validateSettingsDraft(port, '8080abc')).toBe(8080);
        expect(validateSettingsDraft(choice, 'near-selection')).toBe('near-selection');
        expect(validateSettingsDraft(slider, '250')).toBe(250);
    });

    it.each([
        ['a switch that is handed prose', toggle, 'yes'],
        ['text past the field’s own maximum', text, 'far too long to fit'],
        ['text past the shared ceiling', text, 'x'.repeat(SETTINGS_LIMITS.valueChars + 1)],
        ['a port that is not a number at all', port, 'seventy'],
        // parseInt(_, 10) reads this as 0, not as 8080: below the floor, so it is refused here and
        // the field's own `fallbackToDefault` decides what a COMMIT does with it.
        ['a hexadecimal port', port, '0x1F90'],
        ['a port below the floor', port, '0'],
        ['a port above the ceiling', port, '65536'],
        ['an option the field does not have', choice, 'wherever'],
        ['a delay past the track', slider, '900']
    ])('refuses %s', (_why, field: SettingsFieldDescriptor, raw: string) => {
        expect(() => validateSettingsDraft(field, raw)).toThrow();
    });

    // The reason the caller keeps the draft when this throws: these are values on their way
    // somewhere, and discarding them would rewrite the field under the user's cursor.
    it.each(['', '-', '+'])('refuses the intermediate %o without rewriting it', (raw) => {
        expect(() => validateSettingsDraft(port, raw)).toThrow('Enter a valid number.');
    });

    // A slider is dragged, never typed into, so it keeps the strict decimal rule: `2 5` is a bug,
    // not a number on its way somewhere.
    it('parses a slider strictly, where a number field is lenient', () => {
        expect(() => validateSettingsDraft(slider, '250abc')).toThrow('Enter a valid number.');
        expect(validateSettingsDraft(slider, '250')).toBe(250);
    });
});

describe('the commit funnel', () => {
    it('re-checks the parsed value against the field as it is now', () => {
        expect(validateSettingsWrite(port, 19400)).toBe(19400);
        expect(() => validateSettingsWrite(port, 70000)).toThrow('between 1 and 65535');
        expect(() => validateSettingsWrite(choice, 'wherever')).toThrow('no option');
        expect(() => validateSettingsWrite(toggle, 'true' as unknown as boolean)).toThrow('switch');
        expect(() => validateSettingsWrite(text, 'far too long to fit')).toThrow('at most 8');
        expect(() => validateSettingsWrite(slider, 900)).toThrow('between 0 and 500');
    });

    it('refuses a disabled field outright', () => {
        expect(() => validateSettingsWrite({ ...toggle, disabled: true }, true)).toThrow('cannot be changed');
    });

    it('carries the presenter budgets forward verbatim from the interaction contract', () => {
        expect(SETTINGS_LIMITS.payloadBytes).toBe(INTERACTION_LIMITS.payloadBytes);
        expect(SETTINGS_LIMITS.presenterCalls).toBe(INTERACTION_LIMITS.presenterCalls);
        expect(SETTINGS_LIMITS.presenterCallWindowMs).toBe(INTERACTION_LIMITS.presenterCallWindowMs);
        expect(SETTINGS_LIMITS.presenterQueryChars).toBe(INTERACTION_LIMITS.presenterQueryChars);
        expect(SETTINGS_LIMITS.presenterReadyMs).toBe(INTERACTION_LIMITS.presenterReadyMs);
        expect(SETTINGS_LIMITS.presenterAckMs).toBe(INTERACTION_LIMITS.presenterAckMs);
        expect(Object.isFrozen(SETTINGS_LIMITS)).toBe(true);
    });
});

describe('the descriptor projection', () => {
    it('copies named fields only, so nothing else can ride out', () => {
        const smuggled = {
            ...choice,
            error: 'Nope.',
            draft: 'near-selection',
            // The three things a field descriptor must never carry, planted on the source object.
            target: { file: 'kelpi', key: 'new-workspace-placement' },
            verb: 'set-general-setting',
            run: () => 'called'
        } as unknown as SettingsFieldDescriptor;
        const projected = settingsFieldDescriptor(smuggled) as unknown as Record<string, unknown>;
        expect(projected['target']).toBeUndefined();
        expect(projected['verb']).toBeUndefined();
        expect(projected['run']).toBeUndefined();
        expect(Object.values(projected).some((value) => typeof value === 'function')).toBe(false);
        expect(JSON.stringify(projected)).not.toContain('new-workspace-placement');
        expect(JSON.stringify(projected)).not.toContain('set-general-setting');
        // …while everything a renderer needs survives.
        expect(projected['id']).toBe('general.newWorkspacePlacement');
        expect(projected['error']).toBe('Nope.');
        expect(projected['draft']).toBe('near-selection');
    });

    it('freezes the copy and its choices', () => {
        const projected = settingsFieldDescriptor(choice) as SettingsSelectFieldDescriptor;
        expect(Object.isFrozen(projected)).toBe(true);
        expect(Object.isFrozen(projected.choices)).toBe(true);
        expect(Object.isFrozen(projected.choices[0])).toBe(true);
    });

    it('keeps each control kind’s own constraints', () => {
        expect(settingsFieldDescriptor(port)).toMatchObject({ kind: 'number', min: 1, max: 65535 });
        expect(settingsFieldDescriptor(slider)).toMatchObject({ kind: 'slider', step: 25, valueLabel: '100 ms' });
        expect(settingsFieldDescriptor(text)).toMatchObject({ kind: 'text', maxLength: 8 });
        expect(settingsFieldDescriptor(toggle)).toMatchObject({ kind: 'toggle', value: false });
    });

    it('omits an absent optional rather than spelling it undefined', () => {
        expect(Object.hasOwn(settingsFieldDescriptor(toggle), 'error')).toBe(false);
        expect(Object.hasOwn(settingsFieldDescriptor(toggle), 'draft')).toBe(false);
        expect(Object.hasOwn(settingsFieldDescriptor(toggle), 'rowTestID')).toBe(false);
    });
});
