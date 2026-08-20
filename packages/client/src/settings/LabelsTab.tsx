/**
 * Settings ▸ Labels (app-state-core.md §6, SET-058…SET-068).
 *
 * The preset list is DAEMON STATE (`labelPresets` on the mirror, advanced by the
 * `label-presets-changed` delta), not settings: it lives in the database, not the config file.
 * So this tab renders the mirror and pushes `add-label-preset` / `update-label-preset` /
 * `move-label-preset` / `remove-label-preset`, and the list re-renders when the delta comes back.
 *
 * Two rules from §6.4 shape the UI:
 *
 *   - a preset applies to a workspace purely by NAME matching a string in `workspace.labels`,
 *     so renaming a preset silently unstyles every chip that used it. The rename field says so,
 *     and the row shows the in-use count that makes the consequence concrete.
 *   - deleting a preset "does NOT touch any workspace's labels — the label string keeps
 *     existing, its chip just renders neutral". Delete is therefore NOT gated on the preset
 *     being unused (that would contradict the spec); an in-use delete asks for confirmation and
 *     says exactly what will happen.
 *
 * The orphan section closes §6.5/§6.6's loop: any label applied somewhere with no preset gets a
 * one-click gray preset — the same back-fill the CLI's `workspace label` performs.
 *
 * **The design surface (SET-058, SET-061, SET-062).** A preset is *designed* here, not just
 * created: the add row carries a background colour, a text colour and a live chip preview
 * before anything is written, and every row carries the same three controls afterwards. Three
 * deliberate presentation divergences from the Swift sheet, each because a browser has no
 * `NSColorWell` + `Menu` pair:
 *
 *   - the eight (here ten) named colours are a SWATCH ROW with `aria-pressed` on the current
 *     one rather than a dropdown with a checkmark — same list, same "which one is set" answer,
 *     one click instead of two;
 *   - "Custom…" is a native `<input type="color">` sitting on a swatch, which is the only
 *     control that opens the OS picker (`controls.tsx`'s `ColorField` makes the same choice for
 *     the same reason). Picking through it switches the preset to `{kind:'custom', hex}`,
 *     exactly as dragging the Swift well did;
 *   - the text colour is an Auto / Black / White segmented triple plus that same custom well.
 *     Auto is `null` — the daemon and `resolveLabelStyle` derive black-or-white from the
 *     background's luminance, which is the rule `LabelPreset.resolvedStyle` states.
 *
 * Reordering (SET-065) is ↑/↓ buttons rather than drag, matching the Web tab's favourites list.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';

import {
    WORKSPACE_COLORS,
    normalizeHexColor,
    resolveLabelStyle,
    tokens,
    workspaceColorHex,
    withAlpha,
    type ChromeBucket,
    type ChromeLabelPreset,
    type ResolvedLabelStyle
} from '../chrome';
import { labelUsage, orphanLabels, type LabelledWorkspace } from './model';
import type { SettingsActions } from './types';
import { SettingsButton, SettingsSection } from './ui';

export interface LabelsTabProps {
    readonly presets: readonly ChromeLabelPreset[];
    readonly workspaces: readonly LabelledWorkspace[];
    readonly actions: SettingsActions;
    readonly bucket?: ChromeBucket | undefined;
}

/** A preset's colour, in whichever of §6.2's two shapes it is stored as. */
type LabelColorValue = ChromeLabelPreset['color'];
/** A preset's text colour: a colour, or `null` for AUTO (the luminance rule). */
type LabelTextColorValue = LabelColorValue | null;

const BLACK = '#000000';
const WHITE = '#ffffff';

/** §6.2's one-string encoding, read back off a preset so the palette can show the current pick. */
function colorToken(preset: ChromeLabelPreset): string {
    return preset.color.kind === 'named' ? preset.color.color : preset.color.hex;
}

/** The same encoding for a value that is not (yet) on a preset — the add row's draft. */
function tokenOf(color: LabelColorValue): string {
    return color.kind === 'named' ? color.color : color.hex;
}

/** The wire token for a text colour: a colour, or the literal `auto` for the luminance rule. */
function textToken(color: LabelTextColorValue): string | null {
    return color === null ? null : tokenOf(color);
}

/** A concrete hex for any colour value, so a well and a chip can both paint it. */
function hexOf(color: LabelColorValue, bucket: ChromeBucket): string {
    if (color.kind === 'custom') return normalizeHexColor(color.hex) ?? '#808080';
    return workspaceColorHex(color.color, bucket);
}

/**
 * The colours a chip WOULD have, for a value that may not be a stored preset yet.
 *
 * Routed through the shared `resolveLabelStyle` rather than reimplementing the contrast rule:
 * the add row's preview and a rendered sidebar chip must agree, and the only way to guarantee
 * that is to ask the same function. A one-entry synthetic preset list is how a draft asks it.
 */
function previewStyle(
    color: LabelColorValue,
    textColor: LabelTextColorValue,
    bucket: ChromeBucket
): ResolvedLabelStyle {
    return resolveLabelStyle('preview', [{ name: 'preview', color, textColor }], bucket);
}

/** Which of the Auto / Black / White triple a text colour is (anything else is Custom). */
function textMode(color: LabelTextColorValue): 'auto' | 'black' | 'white' | 'custom' {
    if (color === null) return 'auto';
    if (color.kind === 'named') return 'custom';
    const hex = normalizeHexColor(color.hex)?.toLowerCase() ?? '';
    if (hex === BLACK) return 'black';
    if (hex === WHITE) return 'white';
    return 'custom';
}

interface ColorFieldProps {
    readonly idPrefix: string;
    readonly label: string;
    readonly value: LabelColorValue;
    readonly bucket: ChromeBucket;
    readonly onChange: (next: LabelColorValue) => void;
}

/** SET-061: the named palette, plus a Custom… well that writes a `#rrggbb`. */
function LabelColorField(props: ColorFieldProps): ReactElement {
    const custom = props.value.kind === 'custom';
    const hex = hexOf(props.value, props.bucket);
    return (
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label={props.label}>
            {WORKSPACE_COLORS.map((color) => {
                const selected = props.value.kind === 'named' && props.value.color === color;
                return (
                    <button
                        key={color}
                        type="button"
                        data-testid={`${props.idPrefix}-${color}`}
                        aria-label={`${color} for ${props.label}`}
                        aria-pressed={selected}
                        className="h-4 w-4 rounded-full"
                        style={{
                            background: workspaceColorHex(color, props.bucket),
                            outline: selected ? `2px solid ${tokens.accent}` : 'none',
                            outlineOffset: '1px'
                        }}
                        onClick={() => {
                            if (selected) return;
                            props.onChange({ kind: 'named', color });
                        }}
                    />
                );
            })}
            {/*
             * The Swift menu's "Custom…" entry and its colour well, as one control: the swatch
             * shows the value (a bare `<input type="color">` renders a dark colour as an empty
             * white rectangle in Chromium), the transparent input on top opens the OS picker.
             */}
            <span
                className="relative ml-1 inline-flex h-4 items-center gap-1 rounded px-1"
                style={{
                    background: custom ? withAlpha(tokens.accent, 0.16) : 'transparent',
                    outline: custom ? `2px solid ${tokens.accent}` : 'none',
                    outlineOffset: '1px'
                }}
            >
                <span className="text-[10px]" style={{ color: tokens.textTertiary }}>
                    Custom…
                </span>
                <span
                    className="relative inline-block h-3.5 w-5 overflow-hidden rounded"
                    style={{ background: hex, border: `1px solid ${tokens.divider}` }}
                >
                    <input
                        type="color"
                        aria-label={`Custom colour for ${props.label}`}
                        data-testid={`${props.idPrefix}-custom`}
                        value={hex.toLowerCase()}
                        className="absolute inset-0 h-full w-full cursor-pointer border-0 bg-transparent p-0 opacity-0"
                        onChange={(event) => {
                            const next = normalizeHexColor(event.target.value);
                            if (next === null) return;
                            props.onChange({ kind: 'custom', hex: next.toLowerCase() });
                        }}
                    />
                </span>
            </span>
        </div>
    );
}

interface TextColorFieldProps {
    readonly idPrefix: string;
    readonly label: string;
    readonly value: LabelTextColorValue;
    /** The chip background the "Aa" sample is drawn on. */
    readonly background: string;
    readonly bucket: ChromeBucket;
    readonly onChange: (next: LabelTextColorValue) => void;
}

/** SET-062: Auto (luminance) / Black / White, a custom well, and the "Aa" preview. */
function LabelTextColorField(props: TextColorFieldProps): ReactElement {
    const mode = textMode(props.value);
    const resolved =
        props.value === null
            ? previewStyle({ kind: 'custom', hex: props.background }, null, props.bucket).text
            : hexOf(props.value, props.bucket);
    const choice = (
        key: 'auto' | 'black' | 'white',
        label: string,
        next: LabelTextColorValue
    ): ReactElement => {
        const selected = mode === key;
        return (
            <button
                key={key}
                type="button"
                data-testid={`${props.idPrefix}-${key}`}
                aria-pressed={selected}
                className="rounded px-1.5 py-0.5 text-[10px]"
                style={{
                    background: selected ? withAlpha(tokens.accent, 0.2) : 'transparent',
                    color: selected ? tokens.textPrimary : tokens.textTertiary,
                    border: `1px solid ${selected ? tokens.accent : tokens.divider}`
                }}
                onClick={() => {
                    props.onChange(next);
                }}
            >
                {label}
            </button>
        );
    };
    return (
        <div className="flex items-center gap-1" role="group" aria-label={props.label}>
            <span
                data-testid={`${props.idPrefix}-sample`}
                data-color={normalizeHexColor(resolved)}
                className="rounded px-1 text-[10px] font-semibold"
                style={{ background: props.background, color: resolved }}
            >
                Aa
            </span>
            {choice('auto', 'Auto', null)}
            {choice('black', 'Black', { kind: 'custom', hex: BLACK })}
            {choice('white', 'White', { kind: 'custom', hex: WHITE })}
            <span
                className="relative inline-block h-3.5 w-5 overflow-hidden rounded"
                style={{
                    background: resolved,
                    border: `1px solid ${mode === 'custom' ? tokens.accent : tokens.divider}`
                }}
            >
                <input
                    type="color"
                    aria-label={`Custom text colour for ${props.label}`}
                    data-testid={`${props.idPrefix}-custom`}
                    value={(normalizeHexColor(resolved) ?? BLACK).toLowerCase()}
                    className="absolute inset-0 h-full w-full cursor-pointer border-0 bg-transparent p-0 opacity-0"
                    onChange={(event) => {
                        const next = normalizeHexColor(event.target.value);
                        if (next === null) return;
                        props.onChange({ kind: 'custom', hex: next.toLowerCase() });
                    }}
                />
            </span>
        </div>
    );
}

interface ChipPreviewProps {
    readonly testID: string;
    readonly text: string;
    readonly placeholder?: boolean | undefined;
    readonly style: ResolvedLabelStyle;
    readonly colorToken?: string | undefined;
}

/** SET-058's live chip: the placeholder reads "label" at 50 % opacity while the name is empty. */
function ChipPreview(props: ChipPreviewProps): ReactElement {
    return (
        <span
            data-testid={props.testID}
            {...(props.colorToken === undefined ? {} : { 'data-color': props.colorToken })}
            data-placeholder={props.placeholder === true ? 'true' : 'false'}
            className="rounded px-1.5 py-0.5 text-[11px]"
            style={{
                background: props.style.background,
                color: props.style.text,
                opacity: props.placeholder === true ? 0.5 : 1
            }}
        >
            {props.text}
        </span>
    );
}

export function LabelsTab(props: LabelsTabProps): ReactElement {
    const bucket = props.bucket ?? 'dark';
    const [draftName, setDraftName] = useState('');
    // Gray rather than the Swift sheet's blue: it is the colour the CLI back-fill and the orphan
    // adoption below both create with, so every route into this list starts from one default.
    const [draftColor, setDraftColor] = useState<LabelColorValue>({ kind: 'named', color: 'gray' });
    const [draftTextColor, setDraftTextColor] = useState<LabelTextColorValue>(null);
    const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
    const [renameError, setRenameError] = useState<{ id: string; message: string } | null>(null);
    const [confirming, setConfirming] = useState<string | null>(null);
    const usage = labelUsage(props.workspaces);
    const orphans = orphanLabels(props.workspaces, props.presets);

    const trimmedDraft = draftName.trim();
    const draftStyle = previewStyle(draftColor, draftTextColor, bucket);

    const create = (): void => {
        const name = trimmedDraft;
        if (name === '') return;
        props.actions.addLabelPreset({
            name,
            color: tokenOf(draftColor),
            // Only sent when the user chose one: SET-059's rule is that the text colour is
            // applied ONLY when the add really creates a preset, and "auto" is the daemon's
            // own default for a new one — so the common add stays a two-field command.
            ...(draftTextColor === null ? {} : { textColor: textToken(draftTextColor) })
        });
        setDraftName('');
        setDraftTextColor(null);
    };

    return (
        <div className="flex flex-col gap-4" data-testid="settings-tab-labels">
            <SettingsSection
                title="Presets"
                hint="A label wears a preset's colors when its text matches the preset name exactly."
                testID="label-presets"
            >
                {props.presets.length === 0 ? (
                    <p data-testid="labels-empty" className="text-[12px]" style={{ color: tokens.textTertiary }}>
                        <span aria-hidden className="mr-1">
                            🏷
                        </span>
                        No label presets yet. Define one below, then assign it from a workspace&rsquo;s context
                        menu — or apply a label from the CLI and adopt it here.
                    </p>
                ) : null}

                {props.presets.map((preset, index) => {
                    const style = resolveLabelStyle(preset.name, props.presets, bucket);
                    const inUse = usage.get(preset.name) ?? 0;
                    const isRenaming = renaming?.id === preset.name;
                    const textColor = preset.textColor ?? null;
                    return (
                        <div
                            key={preset.name}
                            data-testid={`label-preset-${preset.name}`}
                            className="flex flex-col gap-2 rounded px-2 py-2"
                            style={{ background: withAlpha('#808080', 0.06) }}
                        >
                            <div className="flex items-center gap-2">
                                <ChipPreview
                                    testID={`label-chip-${preset.name}`}
                                    colorToken={colorToken(preset)}
                                    text={isRenaming && renaming.value.trim() !== '' ? renaming.value.trim() : preset.name}
                                    style={
                                        isRenaming
                                            ? previewStyle(preset.color, textColor, bucket)
                                            : style
                                    }
                                />
                                <span className="text-[11px]" style={{ color: tokens.textTertiary }}>
                                    {inUse === 0 ? 'unused' : `${String(inUse)} workspace${inUse === 1 ? '' : 's'}`}
                                </span>
                                <span className="ml-auto flex items-center gap-2">
                                    {props.actions.moveLabelPreset === undefined ? null : (
                                        <>
                                            <SettingsButton
                                                testID={`label-move-up-${preset.name}`}
                                                disabled={index === 0}
                                                onClick={() => {
                                                    props.actions.moveLabelPreset?.({
                                                        id: preset.name,
                                                        index: index - 1
                                                    });
                                                }}
                                            >
                                                ↑
                                            </SettingsButton>
                                            <SettingsButton
                                                testID={`label-move-down-${preset.name}`}
                                                disabled={index === props.presets.length - 1}
                                                onClick={() => {
                                                    props.actions.moveLabelPreset?.({
                                                        id: preset.name,
                                                        index: index + 1
                                                    });
                                                }}
                                            >
                                                ↓
                                            </SettingsButton>
                                        </>
                                    )}
                                    <SettingsButton
                                        testID={`label-rename-${preset.name}`}
                                        onClick={() => {
                                            setRenameError(null);
                                            setRenaming(isRenaming ? null : { id: preset.name, value: preset.name });
                                        }}
                                    >
                                        Rename
                                    </SettingsButton>
                                    <SettingsButton
                                        tone="danger"
                                        testID={`label-delete-${preset.name}`}
                                        onClick={() => {
                                            if (inUse === 0) {
                                                props.actions.removeLabelPreset(preset.name);
                                                return;
                                            }
                                            setConfirming(confirming === preset.name ? null : preset.name);
                                        }}
                                    >
                                        Delete
                                    </SettingsButton>
                                </span>
                            </div>

                            <div className="flex flex-wrap items-center gap-3">
                                <LabelColorField
                                    idPrefix={`label-color-${preset.name}`}
                                    label={`${preset.name} color`}
                                    value={preset.color}
                                    bucket={bucket}
                                    onChange={(next) => {
                                        props.actions.updateLabelPreset({
                                            id: preset.name,
                                            color: tokenOf(next)
                                        });
                                    }}
                                />
                                <LabelTextColorField
                                    idPrefix={`label-text-${preset.name}`}
                                    label={`${preset.name} text color`}
                                    value={textColor}
                                    background={hexOf(preset.color, bucket)}
                                    bucket={bucket}
                                    onChange={(next) => {
                                        props.actions.updateLabelPreset({
                                            id: preset.name,
                                            textColor: textToken(next)
                                        });
                                    }}
                                />
                            </div>

                            {isRenaming ? (
                                <RenameField
                                    preset={preset}
                                    value={renaming.value}
                                    inUse={inUse}
                                    onChange={(value) => {
                                        setRenaming({ id: preset.name, value });
                                    }}
                                    onCancel={() => {
                                        setRenaming(null);
                                        setRenameError(null);
                                    }}
                                    onCommit={(value) => {
                                        const next = value.trim();
                                        // SET-063: empty, unchanged, or a name another preset
                                        // already holds — the reducer would refuse it, so the
                                        // field SNAPS BACK to the stored name and says why
                                        // rather than leaving rejected text on screen.
                                        if (next === '' || next === preset.name) {
                                            setRenaming(null);
                                            setRenameError(null);
                                            return;
                                        }
                                        if (props.presets.some((candidate) => candidate.name === next)) {
                                            setRenaming(null);
                                            setRenameError({
                                                id: preset.name,
                                                message: `“${next}” is already a preset — the name is unchanged.`
                                            });
                                            return;
                                        }
                                        setRenaming(null);
                                        setRenameError(null);
                                        props.actions.updateLabelPreset({ id: preset.name, name: next });
                                    }}
                                />
                            ) : null}

                            {renameError?.id === preset.name ? (
                                <span
                                    data-testid={`label-rename-error-${preset.name}`}
                                    className="text-[11px]"
                                    style={{ color: '#E0685F' }}
                                >
                                    {renameError.message}
                                </span>
                            ) : null}

                            {confirming === preset.name ? (
                                <div
                                    data-testid={`label-delete-confirm-${preset.name}`}
                                    className="flex items-center gap-2 text-[11px]"
                                    style={{ color: tokens.textSecondary }}
                                >
                                    <span>
                                        {`Delete the preset? The label stays on ${String(inUse)} workspace${
                                            inUse === 1 ? '' : 's'
                                        } and renders neutral.`}
                                    </span>
                                    <SettingsButton
                                        tone="danger"
                                        testID={`label-delete-confirm-yes-${preset.name}`}
                                        onClick={() => {
                                            setConfirming(null);
                                            props.actions.removeLabelPreset(preset.name);
                                        }}
                                    >
                                        Delete anyway
                                    </SettingsButton>
                                    <SettingsButton
                                        testID={`label-delete-cancel-${preset.name}`}
                                        onClick={() => {
                                            setConfirming(null);
                                        }}
                                    >
                                        Cancel
                                    </SettingsButton>
                                </div>
                            ) : null}
                        </div>
                    );
                })}

                {/* SET-058's always-visible add row: colour, name, text colour, live preview, Add. */}
                <div
                    data-testid="label-add-row"
                    className="flex flex-col gap-2 rounded px-2 py-2"
                    style={{ background: withAlpha(tokens.accent, 0.07) }}
                >
                    <div className="flex items-center gap-2">
                        <ChipPreview
                            testID="label-new-preview"
                            colorToken={tokenOf(draftColor)}
                            text={trimmedDraft === '' ? 'label' : trimmedDraft}
                            placeholder={trimmedDraft === ''}
                            style={draftStyle}
                        />
                        <input
                            aria-label="New preset name"
                            placeholder="New preset…"
                            data-testid="label-new-name"
                            className="min-w-0 flex-1 rounded border bg-transparent px-1.5 py-1 text-[12px] outline-none"
                            style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                            value={draftName}
                            onChange={(event) => {
                                setDraftName(event.target.value);
                            }}
                            onKeyDown={(event) => {
                                if (event.key === 'Escape') {
                                    event.stopPropagation();
                                    setDraftName('');
                                    return;
                                }
                                if (event.key === 'Enter') create();
                            }}
                        />
                        <SettingsButton testID="label-add" disabled={trimmedDraft === ''} onClick={create}>
                            Add Preset
                        </SettingsButton>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                        <LabelColorField
                            idPrefix="label-new-color"
                            label="new preset color"
                            value={draftColor}
                            bucket={bucket}
                            onChange={setDraftColor}
                        />
                        <LabelTextColorField
                            idPrefix="label-new-text"
                            label="new preset text color"
                            value={draftTextColor}
                            background={hexOf(draftColor, bucket)}
                            bucket={bucket}
                            onChange={setDraftTextColor}
                        />
                    </div>
                </div>
            </SettingsSection>

            {orphans.length === 0 ? null : (
                <SettingsSection
                    title="Labels without a preset"
                    hint="Applied to a workspace but not managed here — they render neutral until you give them one."
                    testID="label-orphans"
                >
                    <div className="flex flex-wrap items-center gap-2">
                        {orphans.map((label) => (
                            <SettingsButton
                                key={label}
                                testID={`label-adopt-${label}`}
                                onClick={() => {
                                    props.actions.addLabelPreset({ name: label, color: 'gray' });
                                }}
                            >
                                {`Add “${label}”`}
                            </SettingsButton>
                        ))}
                    </div>
                </SettingsSection>
            )}
        </div>
    );
}

interface RenameFieldProps {
    readonly preset: ChromeLabelPreset;
    readonly value: string;
    readonly inUse: number;
    readonly onChange: (value: string) => void;
    readonly onCommit: (value: string) => void;
    readonly onCancel: () => void;
}

/**
 * SET-063's inline rename: commits on Return **or focus loss**, cancels on Escape.
 *
 * The blur commit is why this is its own component — the handler has to be able to tell a blur
 * caused by Escape/Return (already handled, and the field is about to unmount) from a blur
 * caused by the user clicking elsewhere, and a ref is the honest way to hold that bit.
 */
function RenameField(props: RenameFieldProps): ReactElement {
    const settled = useRef(false);
    const inputRef = useRef<HTMLInputElement | null>(null);
    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, []);
    return (
        <div className="flex items-center gap-2">
            <input
                ref={inputRef}
                aria-label={`New name for ${props.preset.name}`}
                data-testid={`label-rename-field-${props.preset.name}`}
                className="min-w-0 flex-1 rounded border bg-transparent px-1.5 py-1 text-[12px] outline-none"
                style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                value={props.value}
                onChange={(event) => {
                    props.onChange(event.target.value);
                }}
                onBlur={() => {
                    if (settled.current) return;
                    settled.current = true;
                    props.onCommit(props.value);
                }}
                onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                        event.stopPropagation();
                        settled.current = true;
                        props.onCancel();
                        return;
                    }
                    if (event.key !== 'Enter') return;
                    settled.current = true;
                    props.onCommit(props.value);
                }}
            />
            <span className="text-[11px]" style={{ color: tokens.textTertiary }}>
                {props.inUse === 0
                    ? 'Press Enter to rename'
                    : 'Renaming unstyles the chips already using this name'}
            </span>
        </div>
    );
}
