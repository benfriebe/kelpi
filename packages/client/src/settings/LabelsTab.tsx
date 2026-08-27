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
 *
 * **The shape of the tab is the Swift sheet's** (H25/H26/H27), and it is not decoration:
 * `LabelPresetsSettingsView.swift:4-12` opens by saying the fixed column widths exist so "the
 * colour controls, text-colour control, and preview line up vertically across the add row and
 * every preset row". So:
 *
 *   - the ADD ROW is first, above a divider, then the list (`:27-31`) — not below a list that
 *     can be longer than the window;
 *   - every row (add row included) is ONE grid line on `LabelCol`'s widths — background 150,
 *     text colour 124, preview 80, action 40, with the name field flexing between them
 *     (`:7-12`, `:106-132`, `:204-245`) — not a two-line stacked card;
 *   - the NAME is a live `TextField` in every row (`:214-222`), committed on Return or focus
 *     loss. There is no "Rename" button in the shipped app and there is none here: click into
 *     any name and type.
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
import { TagGlyph } from './glyphs';
import { labelUsage, orphanLabels, type LabelledWorkspace } from './model';
import type { SettingsActions } from './types';
import {
    SettingsButton,
    SettingsEmptyState,
    SettingsIconButton,
    SettingsSection,
    hoverBackground,
    useHover
} from './ui';

/**
 * `LabelCol` (`LabelPresetsSettingsView.swift:7-12`), to the point.
 *
 * The four fixed widths are the whole reason that file has an opening comment: they are what
 * makes the wells, the "Aa" sample, the chip and the trash line up in columns down the tab AND
 * with the add row. The name is the one thing that flexes, exactly as `.frame(maxWidth:
 * .infinity)` makes it in the Swift row.
 *
 * One column is this port's own and is named as such: `reorder`, holding the ↑/↓ pair that
 * stands in for the Swift `List`'s drag (SET-065's stated divergence). It sits between the
 * preview and the action column so the Swift four keep both their widths and their order.
 */
const LABEL_COL = { bgColor: 150, textColor: 184, preview: 80, reorder: 44, action: 40 } as const;

/**
 * S60 — `textColor` is **184**, not the Swift's 124.
 *
 * `LabelPresetsSettingsView.swift:9`'s 124 pt was sized for what the Swift puts in that column:
 * ONE compact `Menu` ("Aa <mode> ⌄") plus a `ColorPicker` well (`:224-233`, `:356-399`). This
 * port draws the mode as three explicit choices instead (§H26/§L93's shape, so the current mode
 * is readable without opening anything), which is five controls: 21.07 (Aa) + 36.27 (Auto) +
 * 40.23 (Black) + 41.89 (White) + 24 (the S25 well) + 4 gaps × 4 px = **179.5 px**. In a 124 px
 * track that wrapped on EVERY row at EVERY window width — a 44.4 px two-line group where a
 * single-line control is 20 px — and the wrapped line drew over the row's usage caption. A track
 * inherited from a control the port no longer draws.
 *
 * The register suggested 176, which was arithmetic on the pre-S1 chip widths; 176 still wraps.
 * The width comes out of the name column, which is where the register put it ("the grid
 * currently leaves the name column 166 px of slack"): at the 880 px dialog that track is 102 px
 * rather than 166.
 *
 * **The residual, measured and stated rather than hidden.** A PRESET row's name cell holds the
 * rename field *and* the port-only usage caption ("unused" / "N workspaces", `shrink-0`), so at
 * 102 px the field itself renders 49.6 px where it used to render ~114. The add row's field
 * keeps the whole 102. Nothing here can give it back without taking width from a Swift column:
 * the way to recover it is the register's own second option for this row — collapse Auto /
 * Black / White into ONE control, the way `LabelPresetsSettingsView.swift:365-394` collapses
 * them into a `Menu`, which would return ~24 px to the name track. That is a shape change, so
 * it is the owner's to take.
 */
const LABEL_NAME_MIN = 100;

/**
 * S57 — the name track has a FLOOR (`minmax(100px,1fr)`), not `minmax(0,1fr)`.
 *
 * It is the only flexible track and every other one is a hard px, so a narrowing window took it
 * all: at a 760 × 700 window the field measured **14 × 28.2 px** — no room for one character —
 * while `bgColor`, `textColor`, `preview`, `reorder` and `action` each held their width. A track
 * with a floor gives the row a min-content width instead, so a too-narrow panel scrolls sideways
 * rather than emptying the one field you type into (`settings-panel` is `overflow-y-auto`, and
 * CSS resolves a scroll container's other axis to `auto` with it). 96 px is exactly what the
 * track gets at the dialog's own full width, so the default window is unchanged and nothing
 * overflows there.
 */
const LABEL_GRID = `${String(LABEL_COL.bgColor)}px minmax(${String(LABEL_NAME_MIN)}px,1fr) ${String(
    LABEL_COL.textColor
)}px ${String(LABEL_COL.preview)}px ${String(LABEL_COL.reorder)}px ${String(LABEL_COL.action)}px`;

/** The width the tracks + gaps need; below it the list scrolls rather than the name collapsing. */
export const LABEL_GRID_MIN_WIDTH =
    LABEL_COL.bgColor + LABEL_NAME_MIN + LABEL_COL.textColor + LABEL_COL.preview + LABEL_COL.reorder + LABEL_COL.action + 5 * 10;

/** `HStack(spacing: 10)` — the gap between those columns. */
const LABEL_GRID_GAP = '10px';

/**
 * `alternatesRowBackgrounds`' two tones (M41), even → clear and odd → a faint wash, which is the
 * parity AppKit paints. The add row keeps its own accent tint: it is not a list row.
 */
const LABEL_ROW_STRIPE = { base: 'transparent', alternate: withAlpha('#808080', 0.06) } as const;

/**
 * `Image(systemName: "trash")` at this file's own scale.
 *
 * Hand-rolled rather than imported: no icon dependency may be added to the client, and the
 * action column is 40 px wide because the shipped app puts a trash GLYPH there — a bordered
 * "Delete" would not fit the column the alignment depends on.
 */
function TrashGlyph(): ReactElement {
    return (
        <svg
            aria-hidden
            viewBox="0 0 12 12"
            width="11"
            height="11"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M2 3.2h8" />
            <path d="M4.6 3.2V2.1h2.8v1.1" />
            <path d="M3.1 3.2 3.6 10h4.8l.5-6.8" />
            <path d="M5 5.1v3.2M7 5.1v3.2" />
        </svg>
    );
}

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

/**
 * What the colour controls ANNOUNCE (L93).
 *
 * `LabelPresetsSettingsView.swift:330` and `:395` label their menus `"Colour: \(name)"` and
 * `"Text colour: \(currentLabel)"` — the field's name AND the value in it, so a screen reader
 * says which colour is set without the user walking ten swatch buttons to find the pressed one.
 * The port's groups carried the field name alone. Capitalised the way `WorkspaceColor.displayName`
 * capitalises (`WorkspaceColor.swift:36`), and "Custom" / "Auto" for the two unnamed cases —
 * `currentLabel` at `:402-409` verbatim.
 */
export function colorAnnouncement(color: LabelColorValue): string {
    if (color.kind === 'custom') return 'Custom';
    return color.color.charAt(0).toUpperCase() + color.color.slice(1);
}

/** The same, for a text colour — where `null` is the luminance rule rather than a colour. */
export function textColorAnnouncement(color: LabelTextColorValue): string {
    const mode = textMode(color);
    if (mode === 'auto') return 'Auto';
    if (mode === 'black') return 'Black';
    if (mode === 'white') return 'White';
    return 'Custom';
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

interface SwatchProps {
    readonly color: string;
    readonly testID: string;
    readonly ariaLabel: string;
    readonly selected: boolean;
    readonly onClick: () => void;
}

/**
 * One palette swatch. H11: the Swift menu's rows light under the pointer and these did not, so
 * a hovered swatch takes the same selection ring the selected one wears, one shade quieter —
 * "this is the one that is set" and "this is the one you are about to set" have to be
 * distinguishable, so the hover ring is the selection STROKE and the selected ring is accent.
 */
function ColorSwatch(props: SwatchProps): ReactElement {
    const { hovered, hoverProps } = useHover();
    const ring = props.selected ? tokens.accent : hovered ? tokens.selectionStroke : null;
    return (
        <button
            type="button"
            data-testid={props.testID}
            aria-label={props.ariaLabel}
            aria-pressed={props.selected}
            className="h-4 w-4 shrink-0 rounded-full"
            style={{
                background: props.color,
                outline: ring === null ? 'none' : `2px solid ${ring}`,
                outlineOffset: '1px'
            }}
            {...hoverProps}
            onClick={props.onClick}
        />
    );
}

/** SET-061: the named palette, plus a Custom… well that writes a `#rrggbb`. */
function LabelColorField(props: ColorFieldProps): ReactElement {
    const custom = props.value.kind === 'custom';
    const hex = hexOf(props.value, props.bucket);
    return (
        /*
         * H26: the fixed `LabelCol.bgColor` column. The palette WRAPS inside it rather than
         * being allowed to set the row's width — every row holds the same ten swatches and the
         * same well, so every row wraps at the same point and the columns after it still line
         * up, which is the property the Swift widths exist to guarantee.
         */
        <div
            className="flex flex-wrap items-center gap-1"
            style={{ width: `${String(LABEL_COL.bgColor)}px` }}
            role="group"
            // L93: the field's name AND its value — `"Colour: Blue"`, not `"work color"`.
            aria-label={`${props.label}: ${colorAnnouncement(props.value)}`}
        >
            {WORKSPACE_COLORS.map((color) => {
                const selected = props.value.kind === 'named' && props.value.color === color;
                return (
                    <ColorSwatch
                        key={color}
                        testID={`${props.idPrefix}-${color}`}
                        ariaLabel={`${color} for ${props.label}`}
                        color={workspaceColorHex(color, props.bucket)}
                        selected={selected}
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
                // S25: `h-[22px]`, because the well inside it is now 20 px tall.
                className="relative ml-1 inline-flex h-[22px] items-center gap-1 rounded px-1"
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
                    /*
                     * S25: `h-5 w-6` — 24 × 20. `LabelPresetsSettingsView.swift:289` (the
                     * background well) and `:361` (the text one) are both `ColorPicker`s, i.e.
                     * `NSColorWell`s with their own bezel at ~22-24 pt square minimum. At
                     * `h-3.5 w-5` the painted well was 20 × 14 over an 18 × 12 `<input
                     * type="color">` — the smallest hit target anywhere in Settings, while the
                     * SAME control one tab away (Appearance's `ColorField`, `controls.tsx:119`
                     * `h-6 w-10`) measures 38 × 22.
                     *
                     * **Deviation from the register, measured.** It asks for `h-5 w-8` (20 × 32)
                     * "at minimum", which is a reading of the 20 px pointer floor rather than of
                     * this column: at 32 px the `Custom…` chip measures 89.22 px and, with its
                     * `ml-1`, needs 153.2 px beside the last three swatches — 3.2 px more than
                     * `LabelCol.bgColor`, which is a SWIFT width (`:8`). The palette therefore
                     * wrapped to a THIRD line and every row on the tab grew 18 px (add row 60 →
                     * 78, preset row → 74), which is the opposite of what a density fix is for.
                     * At 24 px the chip is 85.22, the line lands at 145.2 ≤ 150, and the well
                     * still clears 20 px in both axes.
                     */
                    className="relative inline-block h-5 w-6 overflow-hidden rounded"
                    style={{ background: hex, border: `1px solid ${tokens.divider}` }}
                >
                    {/*
                     * L80: `.help("Pick a custom colour")` (`LabelPresetsSettingsView.swift:290`).
                     * The port had the accessible name and no hover tooltip, so the well was the
                     * one control in the row that said nothing to a pointer.
                     */}
                    <input
                        type="color"
                        aria-label={`Custom colour for ${props.label}`}
                        title="Pick a custom colour"
                        data-testid={`${props.idPrefix}-custom`}
                        value={hex.toLowerCase()}
                        className="absolute inset-0 h-full w-full border-0 bg-transparent p-0 opacity-0"
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

interface TextChoiceProps {
    readonly testID: string;
    readonly label: string;
    readonly selected: boolean;
    readonly onClick: () => void;
}

/** One of the Auto / Black / White triple — hover-lit like every other Settings control (H11). */
function TextChoice(props: TextChoiceProps): ReactElement {
    const { hovered, hoverProps } = useHover();
    return (
        <button
            type="button"
            data-testid={props.testID}
            aria-pressed={props.selected}
            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] transition-colors duration-100"
            style={{
                background: props.selected
                    ? withAlpha(tokens.accent, 0.2)
                    : hoverBackground(hovered, 'transparent'),
                color: props.selected || hovered ? tokens.textPrimary : tokens.textTertiary,
                border: `1px solid ${
                    props.selected ? tokens.accent : hovered ? tokens.selectionStroke : tokens.divider
                }`
            }}
            {...hoverProps}
            onClick={props.onClick}
        >
            {props.label}
        </button>
    );
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
            <TextChoice
                key={key}
                testID={`${props.idPrefix}-${key}`}
                label={label}
                selected={selected}
                onClick={() => {
                    props.onChange(next);
                }}
            />
        );
    };
    return (
        // H26: the fixed `LabelCol.textColor` column, wrapping inside it for the same reason
        // the palette does — identical content in every row means an identical wrap.
        <div
            className="flex flex-wrap items-center gap-1"
            style={{ width: `${String(LABEL_COL.textColor)}px` }}
            role="group"
            // L93: `"…text color: Auto"` — the mode the "Aa" sample is drawn in, said out loud.
            aria-label={`${props.label}: ${textColorAnnouncement(props.value)}`}
        >
            <span
                data-testid={`${props.idPrefix}-sample`}
                data-color={normalizeHexColor(resolved)}
                className="shrink-0 rounded px-1 text-[10px] font-semibold"
                style={{ background: props.background, color: resolved }}
            >
                Aa
            </span>
            {choice('auto', 'Auto', null)}
            {choice('black', 'Black', { kind: 'custom', hex: BLACK })}
            {choice('white', 'White', { kind: 'custom', hex: WHITE })}
            <span
                // S25: the text well takes the same 24 × 20 box as the background well above
                // it, so one row does not draw two sizes of the same control.
                className="relative inline-block h-5 w-6 shrink-0 overflow-hidden rounded"
                style={{
                    background: resolved,
                    border: `1px solid ${mode === 'custom' ? tokens.accent : tokens.divider}`
                }}
            >
                {/* L80: `.help("Pick a text colour")` (`LabelPresetsSettingsView.swift:362`). */}
                <input
                    type="color"
                    aria-label={`Custom text colour for ${props.label}`}
                    title="Pick a text colour"
                    data-testid={`${props.idPrefix}-custom`}
                    value={(normalizeHexColor(resolved) ?? BLACK).toLowerCase()}
                    className="absolute inset-0 h-full w-full border-0 bg-transparent p-0 opacity-0"
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

/**
 * SET-058's live chip: the placeholder reads "label" at 50 % opacity while the name is empty.
 *
 * **It is the chip it previews** (M40). `WorkspaceLabelViews.swift:7-31`'s `LabelChip` — the view
 * this preview column exists to show — is a `Capsule` around `.font(.system(size: 10, weight:
 * .medium))` with 6/2 padding, and its sibling `RowLabelChip` (the sidebar row's, `:37-56`) is
 * the same capsule one point down. The port drew a THIRD thing here: a 4 px-radius rectangle at
 * 11 px regular, so the one control whose job is "this is what the label will look like" showed a
 * shape no label anywhere in the app has.
 */
function ChipPreview(props: ChipPreviewProps): ReactElement {
    return (
        <span
            data-testid={props.testID}
            {...(props.colorToken === undefined ? {} : { 'data-color': props.colorToken })}
            data-placeholder={props.placeholder === true ? 'true' : 'false'}
            // `truncate`: the chip lives in the fixed 80 px preview column (`LabelCol.preview`),
            // leading-aligned like the Swift `.frame(width:alignment:.leading)`, so a long name
            // ellipsises inside its column instead of pushing the trash button out of line.
            // (`.lineLimit(1)` is on the Swift chip too.)
            className="block max-w-full truncate rounded-full px-1.5 py-0.5 text-[10px] font-medium"
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
    // H27: there is no `renaming` row any more. Every row's name field is live, so the only
    // cross-row state left is the message a REFUSED rename leaves behind.
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
            {/*
             * L79's `plain`: `LabelPresetsSettingsView.swift:27-45` is a `VStack { addRow;
             * Divider(); List }`, not a `Form` — there is no grouped card anywhere on this tab,
             * and the rows below carry their own chrome (the add row's accent tint, the list's
             * `alternatesRowBackgrounds` stripe, an explicit `Divider()`).
             */}
            <SettingsSection
                plain
                title="Presets"
                hint="A label wears a preset's colors when its text matches the preset name exactly."
                testID="label-presets"
            >
                {/*
                 * M45: `LabelPresetsSettingsView.swift:85-87`'s `Image(systemName: "tag")` at
                 * 28 pt over a `.secondary` headline and a `.caption`/`.tertiary` explanation,
                 * centred in the space. The port had an inline `🏷` at body size on one wrapped
                 * paragraph.
                 */}
                {props.presets.length === 0 ? (
                    <SettingsEmptyState
                        testID="labels-empty"
                        glyph={<TagGlyph size={28} />}
                        title="No label presets yet"
                        detail="Define reusable labels with colours, then assign them from a workspace's right-click menu — or apply a label from the CLI and adopt it here."
                    />
                ) : null}

                {/*
                 * H25: the add row is FIRST, above a divider, then the list —
                 * `LabelPresetsSettingsView.swift:27-31`'s `VStack(spacing: 0) { addRow;
                 * Divider(); List }`. It had drifted to the bottom of the presets, which on a
                 * tab with more than a screen of them puts the only way to add one below the
                 * fold.
                 */}
                <div
                    data-testid="label-add-row"
                    // S64: `px-2.5` — one horizontal row inset for the whole window.
                    // `SETTINGS_ROW_PADDING` is 10 px on every carded tab (General, Workspaces,
                    // Appearance, Keybindings-Global); the four `plain` tabs' own rows were at 8,
                    // so the eye read a 2 px step moving from General to Labels. The 6/8 px
                    // VERTICAL values stay — §L79 measured those off the shipped dialog.
                    className="grid items-center rounded px-2.5 py-2"
                    style={{
                        display: 'grid',
                        gridTemplateColumns: LABEL_GRID,
                        columnGap: LABEL_GRID_GAP,
                        rowGap: '6px',
                        background: withAlpha(tokens.accent, 0.07)
                    }}
                >
                    <LabelColorField
                        idPrefix="label-new-color"
                        label="new preset color"
                        value={draftColor}
                        bucket={bucket}
                        onChange={setDraftColor}
                    />
                    <input
                        aria-label="New preset name"
                        placeholder="New label name"
                        data-testid="label-new-name"
                        className="min-w-0 rounded border bg-transparent px-1.5 py-1 text-[12px] outline-none"
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
                    <LabelTextColorField
                        idPrefix="label-new-text"
                        label="new preset text color"
                        value={draftTextColor}
                        background={hexOf(draftColor, bucket)}
                        bucket={bucket}
                        onChange={setDraftTextColor}
                    />
                    <span className="flex min-w-0 justify-start">
                        <ChipPreview
                            testID="label-new-preview"
                            colorToken={tokenOf(draftColor)}
                            text={trimmedDraft === '' ? 'label' : trimmedDraft}
                            placeholder={trimmedDraft === ''}
                            style={draftStyle}
                        />
                    </span>
                    {/*
                     * The Swift add row lets "Add" size to its own text and only pins the column
                     * to `LabelCol.action` as a MINIMUM, because a bordered text button clipped
                     * to 40 px reads as "A…" (`:122-128`). Here it spans the reorder and action
                     * columns for the same reason, right-aligned so its trailing edge still
                     * lands on the trash buttons below it.
                     */}
                    <span className="flex justify-end" style={{ gridColumn: 'span 2' }}>
                        <SettingsButton testID="label-add" disabled={trimmedDraft === ''} onClick={create}>
                            Add
                        </SettingsButton>
                    </span>
                </div>

                {/* `Divider()` — the add row is a header for the list, not the last row of it. */}
                <div
                    data-testid="label-add-divider"
                    className="h-px"
                    style={{ background: tokens.divider }}
                />

                {props.presets.map((preset, index) => (
                    <PresetRow
                        key={preset.name}
                        preset={preset}
                        presets={props.presets}
                        index={index}
                        bucket={bucket}
                        inUse={usage.get(preset.name) ?? 0}
                        actions={props.actions}
                        error={renameError?.id === preset.name ? renameError.message : null}
                        confirming={confirming === preset.name}
                        onConfirmChange={(open) => {
                            setConfirming(open ? preset.name : null);
                        }}
                        onRenameRefused={(message) => {
                            setRenameError(message === null ? null : { id: preset.name, message });
                        }}
                    />
                ))}
            </SettingsSection>

            {orphans.length === 0 ? null : (
                <SettingsSection
                    plain
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

interface PresetRowProps {
    readonly preset: ChromeLabelPreset;
    readonly presets: readonly ChromeLabelPreset[];
    readonly index: number;
    readonly bucket: ChromeBucket;
    readonly inUse: number;
    readonly actions: SettingsActions;
    /** A refused rename's message, owned by the tab so it survives this row re-rendering. */
    readonly error: string | null;
    readonly confirming: boolean;
    readonly onConfirmChange: (open: boolean) => void;
    readonly onRenameRefused: (message: string | null) => void;
}

/**
 * One preset, as ONE grid line on `LABEL_COL`'s widths (H26).
 *
 * `LabelPresetsSettingsView.swift:204-245` is a single `HStack(spacing: 10)`: colour well,
 * name field, text-colour well, chip, trash — every one of them in a fixed column so the tab
 * reads as a table rather than a stack of cards. That is what this is. The two port-only
 * affordances that have no Swift column (the in-use count and the ↑/↓ pair) do not get to
 * break the grid: the count rides in the flexible NAME cell, and the reorder pair has its own
 * fixed column of the same width in every row.
 *
 * The name is live (H27). `LabelPresetsSettingsView.swift:214-222` binds a `TextField` in every
 * row, focus-committed and Return-committed — there is no Rename button in the shipped app, so
 * there is none here. SET-063's three refusals are unchanged: an empty, unchanged, or colliding
 * name snaps the field back to the stored name, and a collision says why.
 */
function PresetRow(props: PresetRowProps): ReactElement {
    const { preset, presets, bucket } = props;
    const [draft, setDraft] = useState(preset.name);
    const [focused, setFocused] = useState(false);
    const { hovered, hoverProps } = useHover();
    const textColor = preset.textColor ?? null;

    /*
     * `LabelPresetRow`'s `.onChange(of: preset.name)` guard (`:249-251`): the store rewriting
     * this row moves the field, EXCEPT while the user is typing in it.
     *
     * A preset's identity IS its name (SET-066), in both apps — so a committed rename replaces
     * the row rather than moving it, and the branch that matters in practice is the guard: a
     * `label-presets-changed` delta from this row's OWN colour controls must not yank a
     * half-typed name away mid-edit.
     */
    useEffect(() => {
        if (!focused) setDraft(preset.name);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- `focused` is the GUARD, not an
        // input: re-running when focus changes is exactly what must not happen (it would
        // overwrite the draft on blur, before the commit has been read).
    }, [preset.name]);

    /** Swift `previewText`: the chip follows what is typed, falling back to the stored name. */
    const previewText = draft.trim() === '' ? preset.name : draft.trim();
    const live = draft.trim() !== '' && draft.trim() !== preset.name;

    const commit = (): void => {
        const next = draft.trim();
        // SET-063: empty, unchanged, or a name another preset already holds — the reducer would
        // refuse it, so the field SNAPS BACK to the stored name rather than leaving rejected
        // text on screen, and a collision says why.
        if (next === '' || next === preset.name) {
            setDraft(preset.name);
            props.onRenameRefused(null);
            return;
        }
        if (presets.some((candidate) => candidate.name === next)) {
            setDraft(preset.name);
            props.onRenameRefused(`“${next}” is already a preset — the name is unchanged.`);
            return;
        }
        props.onRenameRefused(null);
        props.actions.updateLabelPreset({ id: preset.name, name: next });
    };

    return (
        <div
            data-testid={`label-preset-${preset.name}`}
            data-stripe={props.index % 2 === 1 ? 'alternate' : 'base'}
            // S64: `px-2.5`, matching `SETTINGS_ROW_PADDING`'s 10 px. Vertical untouched.
            className="grid items-center rounded px-2.5 py-1.5 transition-colors duration-100"
            style={{
                display: 'grid',
                gridTemplateColumns: LABEL_GRID,
                columnGap: LABEL_GRID_GAP,
                rowGap: '6px',
                // M41: `.listStyle(.inset(alternatesRowBackgrounds: true))`
                // (`LabelPresetsSettingsView.swift:74`) — the same stripe the Keybindings table
                // takes, and for the same reason: rows of wells and swatches need something
                // holding the eye across five columns. Hover still wins over the stripe.
                background: hoverBackground(
                    hovered,
                    props.index % 2 === 1 ? LABEL_ROW_STRIPE.alternate : LABEL_ROW_STRIPE.base
                )
            }}
            {...hoverProps}
        >
            <LabelColorField
                idPrefix={`label-color-${preset.name}`}
                label={`${preset.name} color`}
                value={preset.color}
                bucket={bucket}
                onChange={(next) => {
                    props.actions.updateLabelPreset({ id: preset.name, color: tokenOf(next) });
                }}
            />

            <span className="flex min-w-0 items-center gap-2">
                <input
                    aria-label={`New name for ${preset.name}`}
                    data-testid={`label-rename-field-${preset.name}`}
                    className="min-w-0 flex-1 rounded border bg-transparent px-1.5 py-1 text-[12px] font-medium outline-none"
                    style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                    value={draft}
                    onChange={(event) => {
                        setDraft(event.target.value);
                    }}
                    onFocus={() => {
                        setFocused(true);
                    }}
                    onBlur={() => {
                        setFocused(false);
                        commit();
                    }}
                    onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                            // The overlay's Escape closes the window; a field mid-edit means
                            // "cancel this edit" first, so the event stops here.
                            event.stopPropagation();
                            setDraft(preset.name);
                            props.onRenameRefused(null);
                            return;
                        }
                        if (event.key !== 'Enter') return;
                        commit();
                    }}
                />
                {/*
                 * §6.4's consequence, made concrete: the count of workspaces wearing this label,
                 * and — while the field holds a name that WOULD be committed — what renaming
                 * does to them. Port-only, so it rides in the flexible column rather than
                 * claiming one of the Swift widths.
                 */}
                <span
                    data-testid={`label-usage-${preset.name}`}
                    className="shrink-0 whitespace-nowrap text-[11px]"
                    style={{ color: tokens.textTertiary }}
                >
                    {live && props.inUse > 0
                        ? 'Renaming unstyles the chips already using this name'
                        : props.inUse === 0
                          ? 'unused'
                          : `${String(props.inUse)} workspace${props.inUse === 1 ? '' : 's'}`}
                </span>
            </span>

            <LabelTextColorField
                idPrefix={`label-text-${preset.name}`}
                label={`${preset.name} text color`}
                value={textColor}
                background={hexOf(preset.color, bucket)}
                bucket={bucket}
                onChange={(next) => {
                    props.actions.updateLabelPreset({ id: preset.name, textColor: textToken(next) });
                }}
            />

            <span className="flex min-w-0 justify-start">
                <ChipPreview
                    testID={`label-chip-${preset.name}`}
                    colorToken={colorToken(preset)}
                    text={previewText}
                    style={
                        live
                            ? previewStyle(preset.color, textColor, bucket)
                            : resolveLabelStyle(preset.name, presets, bucket)
                    }
                />
            </span>

            <span className="flex items-center justify-end gap-1">
                {props.actions.moveLabelPreset === undefined ? null : (
                    <>
                        <SettingsIconButton
                            testID={`label-move-up-${preset.name}`}
                            ariaLabel={`Move ${preset.name} up`}
                            disabled={props.index === 0}
                            onClick={() => {
                                props.actions.moveLabelPreset?.({ id: preset.name, index: props.index - 1 });
                            }}
                        >
                            ↑
                        </SettingsIconButton>
                        <SettingsIconButton
                            testID={`label-move-down-${preset.name}`}
                            ariaLabel={`Move ${preset.name} down`}
                            disabled={props.index === presets.length - 1}
                            onClick={() => {
                                props.actions.moveLabelPreset?.({ id: preset.name, index: props.index + 1 });
                            }}
                        >
                            ↓
                        </SettingsIconButton>
                    </>
                )}
            </span>

            {/* `Button { Image(systemName: "trash") }.frame(width: LabelCol.action, .trailing)`. */}
            <span className="flex justify-end">
                {/*
                 * `.foregroundStyle(.secondary)` — the Swift trash is a QUIET glyph, not a red
                 * one; the destructive colour would make it the loudest thing in a row whose
                 * job is to show colours. It brightens on hover like every other glyph button.
                 */}
                <SettingsIconButton
                    testID={`label-delete-${preset.name}`}
                    ariaLabel={`Remove the ${preset.name} preset`}
                    title="Remove preset"
                    onClick={() => {
                        if (props.inUse === 0) {
                            props.actions.removeLabelPreset(preset.name);
                            return;
                        }
                        props.onConfirmChange(!props.confirming);
                    }}
                >
                    <TrashGlyph />
                </SettingsIconButton>
            </span>

            {props.error === null ? null : (
                <span
                    data-testid={`label-rename-error-${preset.name}`}
                    className="text-[11px]"
                    style={{ gridColumn: '1 / -1', color: '#E0685F' }}
                >
                    {props.error}
                </span>
            )}

            {props.confirming ? (
                <div
                    data-testid={`label-delete-confirm-${preset.name}`}
                    className="flex flex-wrap items-center gap-2 text-[11px]"
                    style={{ gridColumn: '1 / -1', color: tokens.textSecondary }}
                >
                    <span>
                        {`Delete the preset? The label stays on ${String(props.inUse)} workspace${
                            props.inUse === 1 ? '' : 's'
                        } and renders neutral.`}
                    </span>
                    <SettingsButton
                        tone="danger"
                        testID={`label-delete-confirm-yes-${preset.name}`}
                        onClick={() => {
                            props.onConfirmChange(false);
                            props.actions.removeLabelPreset(preset.name);
                        }}
                    >
                        Delete anyway
                    </SettingsButton>
                    <SettingsButton
                        testID={`label-delete-cancel-${preset.name}`}
                        onClick={() => {
                            props.onConfirmChange(false);
                        }}
                    >
                        Cancel
                    </SettingsButton>
                </div>
            ) : null}
        </div>
    );
}
