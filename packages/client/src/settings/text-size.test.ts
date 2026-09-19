/**
 * Terminal text size (#175): the arithmetic, the clamp, the reset and the repeat.
 *
 * ⌘= / ⌘- / ⌘0 are not a feature of their own. They pick a number and hand it to the Appearance
 * tab's terminal Font size row, through the surface's ONE write path - the same re-resolve, the
 * same two validation funnels and the same at-most-once queue a dragged slider goes through. So
 * what is worth asserting is exactly the part that is new, and each claim below is a defect this
 * pair of methods exists to prevent:
 *
 *   - a step moves by the FIELD's own step and lands on the field's own grid, never off it;
 *   - a step at a bound is a NO-OP: nothing written, nothing refused, no error to toast;
 *   - a reset writes the shipped default - the value the row shows when the config says nothing;
 *   - **ten presses land ten steps.** This is the one that cannot be got right by reading the
 *     daemon's snapshot: between a press and the broadcast that answers it the snapshot still
 *     says the OLD number, so nine repeats computed from it would each ask for the same value
 *     the first one did, the queue would dedup them as the same ask, and a held-down ⌘= would
 *     move the size by one. The surface starts each step from the newest value ASKED for
 *     instead, which is what makes the repeats compose.
 */

import { DEFAULT_WS_SETTINGS, type WsSettingsSnapshot } from '@kelpi/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    steppedSettingsValue,
    type SettingsSliderFieldDescriptor,
    type SettingsNumberFieldDescriptor
} from './contract';
import { SETTINGS_TERMINAL_FONT_SIZE_DEFAULT, SETTINGS_TERMINAL_FONT_SIZE_FIELD_ID } from './sections';
import { DEFAULT_FONT_SIZE } from '../terminal/renderer';
import { createSettingsSurface, type SettingsSurface } from './surface';
import type { SettingsActions } from './types';

const FIELD = SETTINGS_TERMINAL_FONT_SIZE_FIELD_ID;
const GHOSTTY_KEY = 'font-size';

type Appearance = Partial<WsSettingsSnapshot['appearance']>;

const snapshot = (appearance: Appearance = {}): WsSettingsSnapshot => ({
    ...DEFAULT_WS_SETTINGS,
    appearance: { ...DEFAULT_WS_SETTINGS.appearance, ...appearance }
});

const surfaces: SettingsSurface[] = [];

function harness(initial: Appearance = {}) {
    let settings = snapshot(initial);
    const writes: { key: string; value: string | null }[] = [];
    const actions: SettingsActions = {
        setKeybinding: vi.fn(),
        resetKeybindings: vi.fn(),
        setGeneralSetting: (key, value) => writes.push({ key, value }),
        setGhosttySetting: (key, value) => writes.push({ key, value }),
        setProfiles: vi.fn(),
        addLabelPreset: vi.fn(),
        updateLabelPreset: vi.fn(),
        removeLabelPreset: vi.fn()
    };
    const surface = createSettingsSurface({
        settings: () => settings,
        actions: () => actions,
        section: { get: () => 'appearance' as const, set: () => undefined }
    });
    surfaces.push(surface);
    return {
        surface,
        writes,
        /** The daemon's answer: a new snapshot, then the reconciliation hook. */
        broadcast(appearance: Appearance): void {
            settings = snapshot(appearance);
            surface.settingsChanged();
        },
        /** The Appearance row as the tab (and a presenter) would draw it. */
        row(): SettingsSliderFieldDescriptor {
            const found = surface.getSnapshot().fields.find((field) => field.id === FIELD);
            if (found === undefined || found.kind !== 'slider') throw new Error('the font size row is not a slider');
            return found;
        }
    };
}

afterEach(() => {
    for (const created of surfaces.splice(0)) created.dispose();
});

// ── the two shipped 13s ─────────────────────────────────────────────────────────────

/**
 * One number, written twice, pinned here.
 *
 * `SETTINGS_TERMINAL_FONT_SIZE_DEFAULT` is what the Appearance row shows when the ghostty config
 * says nothing and what ⌘0 writes; `DEFAULT_FONT_SIZE` (`terminal/renderer.ts`) is what the
 * ENGINE renders when the value arrives null. If they drift, a person who pressed ⌘0 reads one
 * size on the slider and sees another in the pane, and nothing else in the app would say so.
 *
 * Restated rather than imported one from the other because the two modules are in different
 * layers on purpose: the settings catalog is free of React and of the terminal engine (it is
 * imported by daemon-side tests), and the engine does not depend on the settings catalog. That is
 * the same arrangement `SETTINGS_DEFAULT_TCP_PORT` has with `GeneralTab`, pinned the same way in
 * `sections.test.ts`.
 */
describe('the shipped terminal font size', () => {
    it('is the same number in the settings catalog and in the engine', () => {
        expect(SETTINGS_TERMINAL_FONT_SIZE_DEFAULT).toBe(DEFAULT_FONT_SIZE);
    });
});

// ── the arithmetic, with no surface at all ──────────────────────────────────────────

const slider = (over: Partial<SettingsSliderFieldDescriptor> = {}): SettingsSliderFieldDescriptor => ({
    kind: 'slider',
    id: 'appearance.fontSize',
    sectionID: 'appearance',
    groupID: 'appearance-terminal',
    label: 'Font size',
    detail: '',
    testID: 'terminal-font-size',
    value: 13,
    default: 13,
    min: 8,
    max: 32,
    step: 1,
    valueLabel: '13px',
    ...over
});

describe('steppedSettingsValue', () => {
    it('moves by the field’s own step, in both directions', () => {
        expect(steppedSettingsValue(slider(), 13, 1)).toBe(14);
        expect(steppedSettingsValue(slider(), 13, -1)).toBe(12);
        expect(steppedSettingsValue(slider(), 13, 4)).toBe(17);
    });

    it('clamps at both bounds rather than running past them', () => {
        expect(steppedSettingsValue(slider(), 32, 1)).toBe(32);
        expect(steppedSettingsValue(slider(), 8, -1)).toBe(8);
        expect(steppedSettingsValue(slider(), 31, 40)).toBe(32);
        expect(steppedSettingsValue(slider(), 9, -40)).toBe(8);
    });

    /*
     * A hand-edited ghostty config can hold a number the slider cannot represent. Snapping first
     * is what stops a step from carrying that number forward: `validateSettingsWrite` refuses a
     * value off the grid, so a step that did not snap would turn ⌘= into an error message.
     */
    it('snaps a value from outside the field’s range or off its grid', () => {
        expect(steppedSettingsValue(slider(), 7, 1)).toBe(9);
        expect(steppedSettingsValue(slider(), 99, -1)).toBe(31);
        expect(steppedSettingsValue(slider(), 13.4, 1)).toBe(14);
        expect(steppedSettingsValue(slider(), Number.NaN, 1)).toBe(9);
    });

    /*
     * The other slider shapes in the catalog, so the method is the field's arithmetic and not the
     * font size's. 0.1 + n * 0.05 is 0.8500000000000001 in binary; the grid's own spelling is
     * what rounds it back.
     */
    it('keeps a fractional step on its grid exactly', () => {
        const opacity = slider({ id: 'appearance.backgroundOpacity', min: 0.1, max: 1, step: 0.05, default: 1 });
        expect(steppedSettingsValue(opacity, 0.8, 1)).toBe(0.85);
        expect(steppedSettingsValue(opacity, 0.85, 1)).toBe(0.9);
        expect(steppedSettingsValue(opacity, 1, 1)).toBe(1);
        expect(steppedSettingsValue(opacity, 0.1, -1)).toBe(0.1);
        const width = slider({ id: 'appearance.sparklineWidth', min: 16, max: 80, step: 2, default: 28 });
        expect(steppedSettingsValue(width, 28, 1)).toBe(30);
    });

    it('treats a number field with no declared step as a step of one', () => {
        const port: SettingsNumberFieldDescriptor = {
            kind: 'number',
            id: 'general.tcpPort',
            sectionID: 'general',
            groupID: 'general-tcp',
            label: 'Port',
            detail: '',
            testID: 'tcp-port',
            value: 19_400,
            default: 19_400,
            min: 0,
            max: 65_535
        };
        expect(steppedSettingsValue(port, 19_400, 1)).toBe(19_401);
    });
});

// ── through the surface, which is where the write happens ───────────────────────────

describe('stepField', () => {
    it('commits one step of the Appearance row, as the row’s own ghostty key', () => {
        const { surface, writes, row } = harness();
        expect(row().value).toBe(SETTINGS_TERMINAL_FONT_SIZE_DEFAULT);
        surface.stepField(FIELD, 1);
        expect(writes).toEqual([{ key: GHOSTTY_KEY, value: '14' }]);
    });

    it('steps down too, from whatever the daemon last said', () => {
        const { surface, writes } = harness({ fontSize: 20 });
        surface.stepField(FIELD, -1);
        expect(writes).toEqual([{ key: GHOSTTY_KEY, value: '19' }]);
    });

    /*
     * The bound is a no-op, NOT a refusal. `commitField`'s unchanged rule already says that
     * committing the value the file holds is not a write; the point here is that the row is left
     * with no error to render, so a ⌘- at the minimum cannot raise a toast.
     */
    it('writes nothing and reports nothing at a bound', () => {
        const { surface, writes, row } = harness({ fontSize: 8 });
        surface.stepField(FIELD, -1);
        expect(writes).toEqual([]);
        expect(row().error).toBeUndefined();
        expect(row().value).toBe(8);

        const top = harness({ fontSize: 32 });
        top.surface.stepField(FIELD, 1);
        expect(top.writes).toEqual([]);
        expect(top.row().error).toBeUndefined();
    });

    it('refuses a field that does not step, and one the catalog does not have', () => {
        const { surface, writes } = harness();
        expect(() => surface.stepField('appearance.fontFamily', 1)).toThrow(/does not step/);
        expect(() => surface.stepField('appearance.nothing', 1)).toThrow(/Unknown settings field/);
        expect(writes).toEqual([]);
    });

    /**
     * The repeat, which is the whole reason `stepField` exists rather than a read plus a commit.
     *
     * Nothing has acknowledged the first write when the second press arrives, so the daemon's
     * snapshot still says 13 for all ten of them. Each step starts from the newest value ASKED
     * for instead: the first goes out as 14 and the other nine queue behind it, coalescing into
     * one 23 that is sent the moment the broadcast for 14 lands. Ten presses, ten steps, and the
     * config file is written twice rather than ten times.
     */
    it('lands ten steps for ten presses, with no stale value overwriting a newer one', () => {
        const { surface, writes, broadcast, row } = harness();
        for (let press = 0; press < 10; press += 1) surface.stepField(FIELD, 1);
        expect(writes).toEqual([{ key: GHOSTTY_KEY, value: '14' }]);

        broadcast({ fontSize: 14 });
        expect(writes).toEqual([
            { key: GHOSTTY_KEY, value: '14' },
            { key: GHOSTTY_KEY, value: '23' }
        ]);
        broadcast({ fontSize: 23 });
        expect(row().value).toBe(23);
        expect(SETTINGS_TERMINAL_FONT_SIZE_DEFAULT + 10).toBe(23);
    });

    it('clamps a burst that runs past the maximum instead of queueing an illegal value', () => {
        const { surface, writes, broadcast } = harness({ fontSize: 30 });
        for (let press = 0; press < 8; press += 1) surface.stepField(FIELD, 1);
        expect(writes).toEqual([{ key: GHOSTTY_KEY, value: '31' }]);
        broadcast({ fontSize: 31 });
        expect(writes.at(-1)).toEqual({ key: GHOSTTY_KEY, value: '32' });
        broadcast({ fontSize: 32 });
        // …and the ninth press on a clamped burst has nothing left to ask for.
        surface.stepField(FIELD, 1);
        expect(writes).toHaveLength(2);
    });

    it('does not let a down-step be answered by the up-step still in flight', () => {
        const { surface, writes, broadcast } = harness();
        surface.stepField(FIELD, 1);
        surface.stepField(FIELD, -1);
        // The second press starts from 14 (the value asked for), so it asks for 13 - and 13 is
        // where the daemon still is, which is exactly why it must be SENT rather than dropped as
        // "unchanged": the write for 14 is out and the file would otherwise be left at 14.
        broadcast({ fontSize: 14 });
        expect(writes).toEqual([
            { key: GHOSTTY_KEY, value: '14' },
            { key: GHOSTTY_KEY, value: '13' }
        ]);
    });
});

describe('restoreFieldDefault', () => {
    it('writes the shipped default - the value the row shows when the config says nothing', () => {
        const { surface, writes, broadcast, row } = harness({ fontSize: 22 });
        expect(row().default).toBe(SETTINGS_TERMINAL_FONT_SIZE_DEFAULT);
        surface.restoreFieldDefault(FIELD);
        expect(writes).toEqual([{ key: GHOSTTY_KEY, value: String(SETTINGS_TERMINAL_FONT_SIZE_DEFAULT) }]);
        broadcast({ fontSize: null });
        // An absent key reads back as the same number, which is what makes the reset stable:
        // pressing ⌘0 twice cannot move anything.
        expect(row().value).toBe(SETTINGS_TERMINAL_FONT_SIZE_DEFAULT);
        surface.restoreFieldDefault(FIELD);
        expect(writes).toHaveLength(1);
    });

    it('resets out of a burst that has not settled yet', () => {
        const { surface, writes, broadcast } = harness();
        surface.stepField(FIELD, 1);
        surface.stepField(FIELD, 1);
        surface.restoreFieldDefault(FIELD);
        broadcast({ fontSize: 14 });
        expect(writes.at(-1)).toEqual({ key: GHOSTTY_KEY, value: String(SETTINGS_TERMINAL_FONT_SIZE_DEFAULT) });
    });

    it('refuses an id the catalog does not have', () => {
        const { surface, writes } = harness();
        expect(() => surface.restoreFieldDefault('appearance.nothing')).toThrow(/Unknown settings field/);
        expect(writes).toEqual([]);
    });
});
