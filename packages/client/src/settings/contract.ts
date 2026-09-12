/**
 * What a Settings section IS, what a Settings field IS, and what may be said about either.
 *
 * The sibling of `interaction/contract.ts`, written to the same three rules:
 *
 *   1. **No React, no store, no socket.** Everything here is data or a pure function over data, so
 *      the rules can be asserted without mounting a window. `surface.ts` owns the behaviour,
 *      `sections.ts` owns the catalog data, this owns the vocabulary.
 *   2. **Descriptors out, ids in.** A descriptor carries a field's id, its control kind, its label,
 *      its constraints and its current value. It does NOT carry the config key it writes, the verb
 *      that writes it, the file that key lives in, or any closure. The write target is a private
 *      table in `sections.ts` keyed by field id, exactly as `features/palette-source.ts` keeps a
 *      row's `run` private and takes an id back (`interaction/contract.ts`'s
 *      `interactionPaletteItem` is the same projection, by name).
 *   3. **Two validation layers, independently.** `validateSettingsDraft` parses what the user is
 *      typing; `validateSettingsWrite` re-checks the parsed value at commit against a FRESH read of
 *      the catalog. The daemon's `WS_WRITABLE_GENERAL_KEYS` / `WS_WRITABLE_GHOSTTY_KEYS` allowlist
 *      stays the outer layer that neither of these can talk its way past.
 *
 * Phase 1 introduces no plugin API and no protocol change: nothing here is on the wire, and the
 * presenter budgets below are copied forward from `interaction/contract.ts` so phase 2 adds a
 * placement rather than a second set of numbers.
 */

import { SETTINGS_TABS, type SettingsTabID, type SettingsTabIcon } from './catalog';

// ── sections ────────────────────────────────────────────────────────────────────────

/**
 * A section id IS a tab id. `catalog.ts`'s `SETTINGS_TABS` is the single source for both the ids
 * and their order (it is what draws the rail, in both form factors), so this module names the
 * vocabulary rather than restating the list - a section that only existed here would be a section
 * with no way in.
 */
export type SettingsSectionID = SettingsTabID;

export const SETTINGS_SECTION_IDS: readonly SettingsSectionID[] = Object.freeze(
    SETTINGS_TABS.map((tab) => tab.id)
);

export function isSettingsSectionID(value: string): value is SettingsSectionID {
    return (SETTINGS_SECTION_IDS as readonly string[]).includes(value);
}

/**
 * `fields` = the section is a list of descriptors and can be projected.
 * `native` = the bundled panel draws it whatever is selected (Plugins, Remote, Profiles, the two
 * recorders, the Labels colour flyover and every destructive confirmation). A native section is
 * still DESCRIBED - it has a rail entry, a title and an icon - it is simply never projected, which
 * is the structural sibling of `prompt: null` for a password input.
 */
export type SettingsSectionKind = 'fields' | 'native';

export interface SettingsSectionDescriptor {
    readonly id: SettingsSectionID;
    readonly title: string;
    /** The SF Symbol name `SettingsOverlay` maps to a drawing in `./glyphs.tsx`. */
    readonly icon: SettingsTabIcon;
    /** Rail order, which is `SETTINGS_TABS` order. */
    readonly order: number;
    readonly kind: SettingsSectionKind;
}

/**
 * One card inside a fields section - `SettingsSection`'s title, hint and `testID`, as data.
 *
 * The tabs already group their rows into cards, and the fidelity metrics measure those cards, so a
 * projection that lost the grouping could not redraw the tab it replaced.
 */
export interface SettingsGroupDescriptor {
    readonly id: string;
    readonly sectionID: SettingsSectionID;
    readonly title: string;
    readonly hint: string | null;
    /** The existing `data-testid` of the card, so a rewired tab keeps its audit selectors. */
    readonly testID: string;
}

// ── fields ──────────────────────────────────────────────────────────────────────────

export const SETTINGS_CONTROL_KINDS = [
    'toggle',
    'text',
    'number',
    'select',
    'segmented',
    'slider',
    'color'
] as const;

export type SettingsControlKind = (typeof SETTINGS_CONTROL_KINDS)[number];

/** Everything a control can hold. Primitives only: no object crosses this boundary. */
export type SettingsFieldValue = string | number | boolean;

/** A draft as a control hands it over: the raw text of an input, or a switch's new position. */
export type SettingsDraftValue = string | boolean;

export interface SettingsChoice {
    readonly value: string;
    readonly label: string;
}

/**
 * What the daemon's TCP listener actually DID, as a shape with no room for an OS error.
 *
 * `welcome.transport` is the only live state a field caption depends on, and `WsTcpTransportStatus`
 * carries `error` - the raw `listen EADDRINUSE: address already in use 127.0.0.1:19400` the bind
 * threw. That string has a home already: the host's own `tcp-bind-error` row, drawn natively beside
 * the field. It must not reach a projection, so the host maps its transport status down to these
 * three states and the surface writes the sentence (`settingsTransportCaption` in `sections.ts`).
 *
 *   `listening` - a listener is bound, on this host and port.
 *   `failed`    - it asked for this port and did not get it. WHY stays host-side.
 *   `none`      - the daemon spoke and has no TCP listener at all.
 *
 * `null` (rather than a member) is "the daemon has not said": an older daemon, or not connected
 * yet, which is a different sentence again.
 */
export type SettingsTransportStatus =
    | { readonly state: 'listening'; readonly host: string; readonly port: number }
    | { readonly state: 'failed'; readonly host: string; readonly port: number }
    | { readonly state: 'none' };

interface SettingsFieldBase {
    /** Stable, window-local, and deliberately NOT the config key it writes. */
    readonly id: string;
    readonly sectionID: SettingsSectionID;
    readonly groupID: string;
    readonly label: string;
    /**
     * The row's caption: catalog copy, or a sentence the SURFACE composed.
     *
     * Never a string the host wrote at the call site. The one row whose caption depends on live
     * state - the TCP listener, which reports what the daemon's listener actually did - would
     * otherwise be the arm a raw OS bind error arrives through. The host passes
     * `SettingsTransportStatus` instead, which has nowhere to put one.
     */
    readonly detail: string;
    /** The control's existing `data-testid`, so a rewired tab keeps its audit selectors. */
    readonly testID: string;
    /** The enclosing `SettingsRow`'s `data-testid`, where the row has one. */
    readonly rowTestID?: string | undefined;
    /** True while the host refuses writes for this field (never true in phase 1). */
    readonly disabled?: boolean | undefined;
    /** A write for this field has been dispatched and the broadcast has not arrived yet. */
    readonly busy?: boolean | undefined;
    /** The last refusal for this field, already a sentence. */
    readonly error?: string | undefined;
    /**
     * The uncommitted draft, as text, or null.
     *
     * Drafts live in the surface keyed to the field rather than inside whoever is drawing it: a
     * presenter that crashes, a section change and a reload all change only who paints, so the
     * bundled panel must be able to show the same half-typed value and the same error.
     */
    readonly draft?: string | undefined;
}

export interface SettingsToggleFieldDescriptor extends SettingsFieldBase {
    readonly kind: 'toggle';
    readonly value: boolean;
    readonly default: boolean;
}

export interface SettingsTextFieldDescriptor extends SettingsFieldBase {
    readonly kind: 'text';
    readonly value: string;
    readonly default: string;
    readonly placeholder?: string | undefined;
    readonly maxLength: number;
}

export interface SettingsNumberFieldDescriptor extends SettingsFieldBase {
    readonly kind: 'number';
    readonly value: number;
    readonly default: number;
    readonly min: number;
    readonly max: number;
    readonly step?: number | undefined;
}

export interface SettingsSelectFieldDescriptor extends SettingsFieldBase {
    readonly kind: 'select';
    readonly value: string;
    readonly default: string;
    readonly choices: readonly SettingsChoice[];
}

export interface SettingsSegmentedFieldDescriptor extends SettingsFieldBase {
    readonly kind: 'segmented';
    readonly value: string;
    readonly default: string;
    readonly choices: readonly SettingsChoice[];
}

export interface SettingsSliderFieldDescriptor extends SettingsFieldBase {
    readonly kind: 'slider';
    readonly value: number;
    readonly default: number;
    readonly min: number;
    readonly max: number;
    readonly step: number;
    /** The right-aligned readout beside the track (`"250 ms"`), already formatted. */
    readonly valueLabel: string;
}

export interface SettingsColorFieldDescriptor extends SettingsFieldBase {
    readonly kind: 'color';
    readonly value: string;
    readonly default: string;
}

export type SettingsFieldDescriptor =
    | SettingsToggleFieldDescriptor
    | SettingsTextFieldDescriptor
    | SettingsNumberFieldDescriptor
    | SettingsSelectFieldDescriptor
    | SettingsSegmentedFieldDescriptor
    | SettingsSliderFieldDescriptor
    | SettingsColorFieldDescriptor;

// ── limits ──────────────────────────────────────────────────────────────────────────

export const SETTINGS_LIMITS = Object.freeze({
    /** Sections the catalog may hold. The rail is a fixed list; this is the assertion, not a quota. */
    sections: 32,
    /** Fields one section may project in a frame. */
    fieldsPerSection: 64,
    /** The longest value any text field may carry, whatever its own `maxLength` says. */
    valueChars: 4_096,
    /** How long a dispatched write may stay in flight before the queue stops waiting for it. */
    writeSettleMs: 5_000,
    /*
     * The presenter half, copied VERBATIM from `interaction/contract.ts` rather than re-derived:
     * phase 2 adds a placement, and a second set of numbers for the same budgets is how two
     * replaceable surfaces come to disagree about what a wedged presenter is.
     */
    payloadBytes: 256 * 1024,
    presenterCalls: 240,
    presenterCallWindowMs: 1_000,
    presenterQueryChars: 1_024,
    presenterReadyMs: 5_000,
    presenterAckMs: 5_000
});

// ── validation ──────────────────────────────────────────────────────────────────────

/**
 * The draft funnel: what the user is typing, parsed against the field it is being typed into.
 *
 * Throws with a sentence the row can render. The caller KEEPS the draft when this throws - an
 * intermediate `"-"`, `"1e"` or an empty port is a value on its way somewhere, not a value to
 * discard under the user's cursor (`plugins/settings.ts`'s `edit` makes the same allowance).
 *
 * Values are primitives, so the copy-and-freeze `validateInteractionOptions` performs on author
 * objects is inherent here: nothing returned can be mutated behind the surface's back.
 */
export function validateSettingsDraft(
    field: SettingsFieldDescriptor,
    raw: SettingsDraftValue
): SettingsFieldValue {
    if (field.kind === 'toggle') {
        if (typeof raw === 'boolean') return raw;
        if (raw === 'true') return true;
        if (raw === 'false') return false;
        throw new Error(`${field.label} is a switch: it is either on or off.`);
    }
    if (typeof raw !== 'string') throw new Error(`${field.label} takes text, not a switch position.`);
    if (raw.length > SETTINGS_LIMITS.valueChars)
        throw new Error(`${field.label} must be at most ${String(SETTINGS_LIMITS.valueChars)} characters.`);

    if (field.kind === 'text') {
        if (raw.length > field.maxLength)
            throw new Error(`${field.label} must be at most ${String(field.maxLength)} characters.`);
        return raw;
    }
    if (field.kind === 'number') {
        /*
         * `Number.parseInt(text, 10)` semantics, deliberately, because that is what the row this
         * replaced did (`GeneralTab.tsx`'s TCP port): a leading integer is taken and trailing junk
         * is ignored, so `"8080abc"` is 8080 and `"0x1F90"` is 0 - which then fails the bounds
         * check and, for a field that says so, commits the shipped default (SET-020). Number()
         * would read `"0x1F90"` as 8080 and `"8080abc"` as NaN: both different from the shipped
         * behaviour, in opposite directions.
         */
        const match = /^[+-]?\d+/.exec(raw.trim());
        if (match === null) throw new Error('Enter a valid number.');
        return bounded(field, Number(match[0]));
    }
    if (field.kind === 'slider') {
        const text = raw.trim();
        if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) throw new Error('Enter a valid number.');
        return bounded(field, Number(text));
    }
    if (field.kind === 'color') {
        const text = raw.trim();
        if (!/^#[0-9a-f]{6}$/i.test(text)) throw new Error(`${field.label} must be a #rrggbb colour.`);
        return text.toLowerCase();
    }
    if (!field.choices.some((choice) => choice.value === raw))
        throw new Error(`${field.label} has no option "${raw}".`);
    return raw;
}

/**
 * The commit funnel: the parsed value, re-checked against a FRESH read of the field.
 *
 * Separate from the draft parse on purpose, and called with a descriptor the surface has just
 * rebuilt: between typing and committing, the field may have gone (the TCP port row disappears
 * when the listener is switched off), gone disabled, or had its bounds moved by another window.
 * `presenter.ts` argues the general case - two layers, independently - and this is the second.
 */
export function validateSettingsWrite(
    field: SettingsFieldDescriptor,
    value: SettingsFieldValue
): SettingsFieldValue {
    if (field.disabled === true) throw new Error(`${field.label} cannot be changed right now.`);
    switch (field.kind) {
        case 'toggle':
            if (typeof value !== 'boolean') throw new Error(`${field.label} is a switch.`);
            return value;
        case 'text':
            if (typeof value !== 'string') throw new Error(`${field.label} takes text.`);
            if (value.length > Math.min(field.maxLength, SETTINGS_LIMITS.valueChars))
                throw new Error(`${field.label} must be at most ${String(field.maxLength)} characters.`);
            return value;
        case 'number':
        case 'slider':
            if (typeof value !== 'number') throw new Error(`${field.label} takes a number.`);
            return bounded(field, value);
        case 'color':
            if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value))
                throw new Error(`${field.label} must be a #rrggbb colour.`);
            return value.toLowerCase();
        default:
            if (typeof value !== 'string' || !field.choices.some((choice) => choice.value === value))
                throw new Error(`${field.label} has no option "${String(value)}".`);
            return value;
    }
}

function bounded(
    field: SettingsNumberFieldDescriptor | SettingsSliderFieldDescriptor,
    value: number
): number {
    if (!Number.isFinite(value)) throw new Error('Enter a valid number.');
    if (value < field.min || value > field.max)
        throw new Error(`${field.label} must be between ${String(field.min)} and ${String(field.max)}.`);
    return value;
}

// ── projection ──────────────────────────────────────────────────────────────────────

/**
 * The field-by-field copy, and the ONLY way a descriptor leaves the surface.
 *
 * Never a spread: a spread copies whatever the source object happens to carry, which is how a
 * write target, a verb name or a closure eventually rides out to a replaceable presenter. Adding a
 * field to a descriptor has to be a deliberate line in this function, and `redaction.test.ts`
 * walks the result of a snapshot stuffed with secrets to prove it.
 */
export function settingsFieldDescriptor(field: SettingsFieldDescriptor): SettingsFieldDescriptor {
    const base = {
        id: field.id,
        sectionID: field.sectionID,
        groupID: field.groupID,
        label: field.label,
        detail: field.detail,
        testID: field.testID,
        ...(field.rowTestID === undefined ? {} : { rowTestID: field.rowTestID }),
        ...(field.disabled === undefined ? {} : { disabled: field.disabled }),
        ...(field.busy === undefined ? {} : { busy: field.busy }),
        ...(field.error === undefined ? {} : { error: field.error }),
        ...(field.draft === undefined ? {} : { draft: field.draft })
    };
    switch (field.kind) {
        case 'toggle':
            return Object.freeze({ ...base, kind: 'toggle' as const, value: field.value, default: field.default });
        case 'text':
            return Object.freeze({
                ...base,
                kind: 'text' as const,
                value: field.value,
                default: field.default,
                maxLength: field.maxLength,
                ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder })
            });
        case 'number':
            return Object.freeze({
                ...base,
                kind: 'number' as const,
                value: field.value,
                default: field.default,
                min: field.min,
                max: field.max,
                ...(field.step === undefined ? {} : { step: field.step })
            });
        case 'select':
        case 'segmented':
            return Object.freeze({
                ...base,
                kind: field.kind,
                value: field.value,
                default: field.default,
                choices: Object.freeze(
                    field.choices.map((choice) => Object.freeze({ value: choice.value, label: choice.label }))
                )
            });
        case 'slider':
            return Object.freeze({
                ...base,
                kind: 'slider' as const,
                value: field.value,
                default: field.default,
                min: field.min,
                max: field.max,
                step: field.step,
                valueLabel: field.valueLabel
            });
        default:
            return Object.freeze({ ...base, kind: 'color' as const, value: field.value, default: field.default });
    }
}

/** The section projection, on the same terms: named fields, frozen, no spread of the source. */
export function settingsSectionDescriptor(section: SettingsSectionDescriptor): SettingsSectionDescriptor {
    return Object.freeze({
        id: section.id,
        title: section.title,
        icon: section.icon,
        order: section.order,
        kind: section.kind
    });
}

export function settingsGroupDescriptor(group: SettingsGroupDescriptor): SettingsGroupDescriptor {
    return Object.freeze({
        id: group.id,
        sectionID: group.sectionID,
        title: group.title,
        hint: group.hint,
        testID: group.testID
    });
}
