/**
 * One settings descriptor, drawn as one control.
 *
 * The value-and-verb tabs used to be hand-written JSX per row: a `SettingsRow` here, a
 * `SettingsToggle` there, and the config key spelled out inline beside each one. That shape cannot
 * be projected - a presenter would have to be handed the JSX, or the verb, or both. So the row is
 * DATA now (`sections.ts` declares it, `contract.ts` types it, `surface.ts` folds the daemon's
 * snapshot and the live drafts into it) and this module is the seam back to pixels.
 *
 * Three rules it exists to keep:
 *
 *   1. **The test ids are the row's, not the renderer's.** Every descriptor carries the `testID`
 *      its control already had and, where it sits in one, the `rowTestID` of its `SettingsRow`.
 *      The suffixes are the primitives' own (`-input`, `-apply`, `-select`), so nothing in the
 *      audit and nothing in the fidelity suites has to learn a new name.
 *   2. **No verb, no config key and no closure is in a descriptor, and none is needed here.** The
 *      renderer hands a value back with the field it came from and the surface owns the mapping;
 *      this module could not write a setting if it wanted to.
 *   3. **The primitives are the ones `controls.tsx` and `ui.tsx` already ship.** This module adds
 *      no chrome of its own beyond the error line, so the medium-fidelity metrics (M46's caption
 *      row, L82's readout, L83's plain field) stay the primitives' own, unchanged.
 */

import type { ReactElement, ReactNode } from 'react';

import { tokens } from '../chrome';
import type { SettingsDraftValue, SettingsFieldDescriptor } from './contract';
import { ColorField, SegmentedField, SelectField, TextField } from './controls';
import { SettingsRow, SettingsToggle } from './ui';

/**
 * §SET-021's "in red", shared.
 *
 * The same literal the sidebar's destructive Delete uses (`chrome/Sidebar.tsx`): there is no
 * chrome token for it, and a second spelling of "destructive" in the palette is how two reds
 * happen. Exported so the hand-built rows that report a failure (General's TCP bind line) and the
 * descriptor-driven ones use one value.
 */
export const SETTINGS_DESTRUCTIVE_TONE = '#E0655C';

/**
 * The two text rows whose FRAME is a fidelity metric rather than a default.
 *
 * `controls.tsx`'s `TextField` ships one shape and takes flags for the other two, and those flags
 * are presentation: they say how wide the box is, not what the value means. Keeping them here
 * rather than in the descriptor is what lets `contract.ts` stay a vocabulary - a presenter draws
 * its own controls and has no use for "80 pt, right-aligned" - while the bundled panel still
 * redraws the two rows the metrics measure:
 *
 *   - **L83** `SettingsView.swift:130-134` - the worktree base path is `.textFieldStyle(.plain)`
 *     inside a bare `HStack`: no border, no fixed width, the field takes the rest of the row. The
 *     port's bordered `w-[180px]` clipped a long `<repo>`-substituted path.
 *   - **SET-020** - the Swift port field is 80 pt and right-aligned, with an Apply button that
 *     appears only while the typed text differs from the live port, because a port is something
 *     you deliberately apply rather than something that happens as you type.
 */
const TEXT_PRESENTATION: Readonly<
    Record<string, { readonly plain?: true; readonly narrow?: true; readonly apply?: true }>
> = {
    'general.worktreeBasePath': { plain: true },
    'general.tcpPort': { narrow: true, apply: true }
};

export interface FieldRendererProps {
    readonly field: SettingsFieldDescriptor;
    /**
     * The new value, with the field it came from.
     *
     * A switch hands over a boolean, every other control the text it is showing; both are a
     * `SettingsDraftValue`, which is what the surface's `setDraft`/`commitField` and
     * `commitSettingsField` below both take.
     */
    readonly onCommit: (field: SettingsFieldDescriptor, value: SettingsDraftValue) => void;
}

/** A caption the catalog left empty is no caption, not an empty one. */
function caption(field: SettingsFieldDescriptor): { detail?: string } {
    return field.detail === '' ? {} : { detail: field.detail };
}

/**
 * The rejected-draft line.
 *
 * A row of its own under the control, in the same place M46 puts a caption, because that is where
 * a reader has just looked to find out what the control does.
 */
function FieldError(props: { readonly field: SettingsFieldDescriptor }): ReactElement | null {
    const error = props.field.error;
    if (error === undefined || error === '') return null;
    return (
        <p
            data-testid={`${props.field.testID}-error`}
            className="text-[11px]"
            style={{ color: SETTINGS_DESTRUCTIVE_TONE }}
        >
            {error}
        </p>
    );
}

/**
 * The dimmer for the controls `controls.tsx` has no `disabled` prop for.
 *
 * `SettingsToggle` takes one (SET-082's "press again to hide" needs it), the writing controls do
 * not, and growing them one is a change to a module six other tabs share. A wrapper that dims and
 * swallows the pointer is the same *state* without touching them, and it is only ever in the tree
 * for a field the host is actually refusing - never in phase 1, where nothing is disabled.
 */
function Inert(props: { readonly on: boolean; readonly children: ReactNode }): ReactElement {
    if (!props.on) return <>{props.children}</>;
    return (
        <span
            data-disabled="true"
            aria-disabled="true"
            className="flex flex-col"
            style={{ opacity: 0.4, pointerEvents: 'none' }}
        >
            {props.children}
        </span>
    );
}

/**
 * One descriptor, one control.
 *
 * Always a fragment: the control the descriptor asks for, then its error line if it has one, so a
 * `SettingsSection` still counts the field as exactly one row (`Children.toArray` does not flatten
 * a fragment) and a section's hairlines land where they always did.
 *
 * `busy` is deliberately NOT drawn as an inert control. A write leaves and the daemon's broadcast
 * is what moves the switch back - that is the no-local-echo rule every one of these rows has
 * always had - and greying the control for the length of a round trip would make a second click
 * land on a disabled input rather than on a switch that simply has not moved yet.
 *
 * **A held DRAFT outranks the snapshot** for the three controls that have a typing phase (text,
 * number, colour). The draft lives in the surface keyed to the field, not inside whoever is
 * painting it, so a repaint - a section change, a re-render, a presenter that failed and handed
 * the section back to this panel - redraws the half-typed value and its error rather than
 * reverting to the value the daemon last broadcast. The controls with no typing phase (a switch,
 * a picker, a slider) always draw the snapshot: their draft only exists between the gesture and
 * the broadcast, and painting it there would be the local echo every one of these rows refuses.
 */
export function FieldRenderer(props: FieldRendererProps): ReactElement {
    const field = props.field;
    const locked = field.disabled === true;
    const commit = (value: SettingsDraftValue): void => {
        if (locked) return;
        props.onCommit(field, value);
    };

    if (field.kind === 'toggle') {
        return (
            <>
                <SettingsRow
                    label={field.label}
                    {...caption(field)}
                    {...(field.rowTestID === undefined ? {} : { testID: field.rowTestID })}
                >
                    <SettingsToggle
                        testID={field.testID}
                        label={field.label}
                        checked={field.value}
                        disabled={locked}
                        onChange={commit}
                    />
                </SettingsRow>
                <FieldError field={field} />
            </>
        );
    }

    if (field.kind === 'slider') {
        return (
            <>
                <SettingsRow
                    label={field.label}
                    {...caption(field)}
                    {...(field.rowTestID === undefined ? {} : { testID: field.rowTestID })}
                >
                    {/*
                     * A RAW range input, not `controls.tsx`'s `SliderField`: that one debounces by
                     * 250 ms because an Appearance drag is a config-file rewrite per pointer move,
                     * and it draws its own 140 px label track. This row's label is the
                     * `SettingsRow`'s, and its write is the one the tab has always sent on every
                     * change.
                     *
                     * The TRACK is clamped into the field's range; the READOUT is `valueLabel`,
                     * which the catalog formats from the raw value - so a hand-edited 900 ms says
                     * 900 ms rather than being quietly rounded down by the control drawn over it.
                     */}
                    <input
                        type="range"
                        aria-label={field.label}
                        data-testid={field.testID}
                        min={field.min}
                        max={field.max}
                        step={field.step}
                        disabled={locked}
                        value={Math.min(Math.max(field.value, field.min), field.max)}
                        onChange={(event) => {
                            commit(event.target.value);
                        }}
                    />
                    {/*
                     * L82: a plain right-aligned readout in the UI face with tabular figures
                     * (`Text("\(delay) ms").monospacedDigit().frame(width: 55, alignment:
                     * .trailing)`), not a `KeyChip` - a chord's face on a number of milliseconds.
                     */}
                    <span
                        data-testid={sliderReadoutTestID(field.testID)}
                        className="w-[55px] shrink-0 text-right text-[12px] tabular-nums"
                        style={{ color: tokens.textSecondary }}
                    >
                        {field.valueLabel}
                    </span>
                </SettingsRow>
                <FieldError field={field} />
            </>
        );
    }

    if (field.kind === 'select') {
        return (
            <>
                <Inert on={locked}>
                    <SelectField
                        label={field.label}
                        testID={field.testID}
                        {...caption(field)}
                        value={field.value}
                        options={field.choices}
                        onChange={commit}
                    />
                </Inert>
                <FieldError field={field} />
            </>
        );
    }

    if (field.kind === 'segmented') {
        return (
            <>
                <Inert on={locked}>
                    <SegmentedField
                        label={field.label}
                        testID={field.testID}
                        {...caption(field)}
                        value={field.value}
                        options={field.choices}
                        onChange={commit}
                    />
                </Inert>
                <FieldError field={field} />
            </>
        );
    }

    if (field.kind === 'color') {
        return (
            <>
                <Inert on={locked}>
                    <ColorField
                        label={field.label}
                        testID={field.testID}
                        {...caption(field)}
                        value={field.draft ?? field.value}
                        onChange={commit}
                    />
                </Inert>
                <FieldError field={field} />
            </>
        );
    }

    // `text` and `number` are the same control: a value committed on blur or Enter. The difference
    // is the bounds the funnel checks it against, which is not the input's business.
    const presentation = TEXT_PRESENTATION[field.id] ?? {};
    return (
        <>
            <Inert on={locked}>
                <TextField
                    label={field.label}
                    testID={field.testID}
                    {...caption(field)}
                    value={field.draft ?? (field.kind === 'number' ? String(field.value) : field.value)}
                    {...(field.kind === 'text' && field.placeholder !== undefined
                        ? { placeholder: field.placeholder }
                        : {})}
                    {...presentation}
                    onCommit={commit}
                />
            </Inert>
            <FieldError field={field} />
        </>
    );
}

/**
 * L82's readout id.
 *
 * The slider's own `data-testid` is the INPUT's (`focus-delay-slider`), because that is the
 * element every existing test and audit step reaches for; the readout beside it is the row's stem
 * plus `-value`, which is the name it has always had.
 */
function sliderReadoutTestID(sliderTestID: string): string {
    return `${sliderTestID.replace(/-slider$/, '')}-value`;
}
