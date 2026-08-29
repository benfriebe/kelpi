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
 * **The design surface (SET-058, SET-061, SET-062).** A preset is designed IN ITS ROW: a
 * background colour, a text colour and a live chip preview, all editable in place. §N32 removed
 * the always-visible composer that used to carry a second copy of those three controls above the
 * list — a preset is minted with a default name and colour and then edited exactly like any
 * other, which is the mint-with-rename shape the port already uses for a group. That is an
 * OWNER-DIRECTED divergence from the Swift, which does keep an always-visible add row
 * (`LabelPresetsSettingsView.swift:106-132`). Three further presentation divergences, each
 * because a browser has no `NSColorWell` + `Menu` pair:
 *
 *   - the eight (here ten) named colours are a SWATCH ROW with `aria-pressed` on the current
 *     one rather than a dropdown with a checkmark — same list, same "which one is set" answer,
 *     one click instead of two;
 *   - "Custom…" is a native `<input type="color">` sitting on a swatch, which is the only
 *     control that opens the OS picker (`controls.tsx`'s `ColorField` makes the same choice for
 *     the same reason). Picking through it switches the preset to `{kind:'custom', hex}`,
 *     exactly as dragging the Swift well did;
 *   - the text colour is an Auto / Black / White `<select>` plus that same custom well — one
 *     control, as `:365-394`'s `Menu` is (§N36(3) collapsed the three explicit buttons the port
 *     drew here, which is what returns `LabelCol.textColor` to the Swift's 124). Auto is `null`
 *     — the daemon and `resolveLabelStyle` derive black-or-white from the background's
 *     luminance, which is the rule `LabelPreset.resolvedStyle` states.
 *
 * Reordering (SET-065) is ↑/↓ buttons rather than drag, matching the Web tab's favourites list.
 *
 * **The words on it are LABELS** (§N36(2)). The daemon's object is a "preset" and stays one in
 * every identifier here; nothing a person reads says so. See the `SettingsSection` title below
 * for where that boundary is drawn.
 *
 * **The shape of the tab is the Swift sheet's** (H25/H26/H27), and it is not decoration:
 * `LabelPresetsSettingsView.swift:4-12` opens by saying the fixed column widths exist so "the
 * colour controls, text-colour control, and preview line up vertically across the add row and
 * every preset row". The add row is gone (§N32), so the alignment is now row-to-row — which is
 * the half of that sentence that was ever about the list. So:
 *
 *   - the ADD control is first, above a divider, then the list (`:27-31`) — not below a list
 *     that can be longer than the window. §N36(1) put it on the section header's trailing edge,
 *     which is still above that divider;
 *   - every row is ONE grid line on `LabelCol`'s widths — background 150, text colour 124,
 *     preview 80, action 40, with the name field flexing between them (`:7-12`, `:204-245`) —
 *     not a two-line stacked card;
 *   - the NAME is a live `TextField` in every row (`:214-222`), committed on Return or focus
 *     loss. There is no "Rename" button in the shipped app and there is none here: click into
 *     any name and type.
 */

import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type MouseEvent as ReactMouseEvent,
    type ReactElement
} from 'react';

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
const LABEL_COL = { bgColor: 150, textColor: 124, preview: 80, reorder: 44, action: 40 } as const;

/**
 * §N36(3) — `textColor` is back to the SWIFT's own **124** (`LabelPresetsSettingsView.swift:9`),
 * and §S60's divergence is retired rather than restated.
 *
 * S60 widened this track to 184 because the port drew the text-colour MODE as three explicit
 * buttons where the Swift draws one `Menu` — 21.07 (Aa) + 36.27 (Auto) + 40.23 (Black) + 41.89
 * (White) + 24 (the S25 well) + 4 gaps × 4 px = **179.5 px**, which wrapped on every row inside
 * 124. The width came out of the name column, and S60 recorded the debt in the same breath: at
 * the 880 px dialog the name track was 102 px and the field inside it rendered **49.6 px**, so a
 * preset called `Test` read `Tes` and a freshly minted `New label` read `New lal`.
 *
 * The owner has now directed S60's own recorded option: **collapse Auto / Black / White into ONE
 * control**, the way `:365-394` collapses them into a `Menu`. Measured on the live stack at the
 * default window (1280 × 820 → the 880 px dialog) before choosing, with each candidate rendered
 * in a real row and read off `getBoundingClientRect()`:
 *
 *   | candidate for the mode control      | control | the cluster it makes | track |
 *   |-------------------------------------|--------:|---------------------:|------:|
 *   | three buttons (what was there)       |  126.39 |               179.50 |   184 |
 *   | a compact 3-segment control          |  102.39 |               155.46 |   156 |
 *   | `<select>`, SelectField's 11 px      |   74.50 |               127.57 |   132 |
 *   | `<select>`, this row's 10 px scale   |   67.50 |               120.57 |   124 |
 *
 * (the cluster is `Aa 21.07 + 4 + control + 4 + well 24`). Only the last lands inside a SWIFT
 * width, which is why it is the one taken: the segmented candidate frees 28 px, the `<select>`
 * frees 60, and 60 is exactly what returns the track to `LabelCol.textColor`.
 */
const LABEL_NAME_MIN = 160;

/**
 * S57 — the name track has a FLOOR (`minmax(…,1fr)`), not `minmax(0,1fr)` — and §N36(3) is where
 * the 60 px the collapse freed went: the floor is **160**, not 100.
 *
 * It is the only flexible track and every other one is a hard px, so a narrowing window took it
 * all: at a 760 × 700 window the field measured **14 × 28.2 px** — no room for one character —
 * while `bgColor`, `textColor`, `preview`, `reorder` and `action` each held their width. A track
 * with a floor gives the row a min-content width instead, so a too-narrow panel scrolls sideways
 * rather than emptying the one field you type into (`settings-panel` is `overflow-y-auto`, and
 * CSS resolves a scroll container's other axis to `auto` with it).
 *
 * Putting the freed width into the FLOOR rather than only into the flexible share is what makes
 * the name readable at every width instead of only at the default one — and it costs nothing,
 * because `LABEL_GRID_MIN_WIDTH` comes out **648 px, exactly what it was** (150 + 100 + 184 +
 * … = 150 + 160 + 124 + …). Nothing that fitted before stops fitting, and a panel narrow enough
 * to scroll scrolls by the same amount it did.
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
 * parity AppKit paints. Every row on the tab is a list row now (N32), so there is no third tone.
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

/** Which of a preset row's two reorder arrows a gesture came from (N33). */
type ArrowControl = 'up' | 'down';

/** A reorder's subject: the preset (SET-066: its NAME is its id) and the arrow that was pressed. */
interface ArrowIntent {
    readonly name: string;
    readonly control: ArrowControl;
}

/**
 * The live reorder gesture: an `ArrowIntent` plus whether a commit has already HONOURED it.
 *
 * N33 (run-AH) — the flag is the whole fix, and one field on one object rather than a second ref
 * so the two can never drift: the intent is armed un-honoured by a press, honoured by the first
 * order-changing commit that follows, and from then on may only be RE-asserted while the user is
 * still standing on the row's own arrows. See the layout effect for why "still standing" is not
 * read off `document.activeElement` alone.
 *
 * N33 (run-AH2) — the whole gesture is also DROPPED, honoured or not, the moment a non-arrow
 * element takes focus after the press: that free first honour must not be owed to a user who has
 * moved on. The `focusin` listener does it, because only an event can answer it in time.
 */
interface ArrowGesture extends ArrowIntent {
    honoured: boolean;
}

/**
 * N33 (reopened) — how far the pointer must travel before the list is allowed to re-decide what
 * is hovered.
 *
 * Zero would be wrong, and wrong in exactly the way the first fix was: a hand resting on a mouse
 * emits sub-pixel moves constantly, so "unpark on any movement" is "unpark immediately" on real
 * hardware while looking perfect under a synthetic click. 4 px is smaller than the 16 px arrow
 * it protects, so a deliberate move to a different control always clears the park.
 */
const POINTER_PARK_SLOP = 4;

/**
 * N32 — the name a MINTED preset is born with: `New label`, then `New label 2`, `New label 3`, …
 *
 * The shape, and the reason for it, are `sidebar-model.ts`'s `defaultGroupName` (§WS-083, the
 * Swift's own `NexCommands.defaultGroupName`): a mint has to produce something the daemon will
 * accept on the first try, and §6.4 makes a preset's NAME its identity — a duplicate is refused
 * outright, so the uniquifier is not a nicety, it is what makes the button work twice in a row.
 * Matching against the list this tab is rendering is enough: it IS the daemon's list.
 */
export function defaultLabelPresetName(existing: readonly string[]): string {
    const base = 'New label';
    const taken = new Set(existing);
    if (!taken.has(base)) return base;
    let suffix = 2;
    while (taken.has(`${base} ${String(suffix)}`)) suffix += 1;
    return `${base} ${String(suffix)}`;
}

/**
 * Where a reorder press came from, for that threshold.
 *
 * `event.detail === 0` is a KEYBOARD activation (Enter or Space on a focused button); Chromium
 * reports `clientX/Y` as 0,0 for it, which is a real coordinate and would anchor the park to the
 * top-left corner of the window. A keyboard press has no pointer origin at all, so it returns
 * `null` and any pointer movement at all releases the park — which is right: nothing moved under
 * the cursor because of the cursor.
 */
export function pointerOrigin(event: ReactMouseEvent<HTMLButtonElement>): { x: number; y: number } | null {
    return event.detail === 0 ? null : { x: event.clientX, y: event.clientY };
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

/**
 * §N36(3) — the width the collapsed mode control is pinned to.
 *
 * Pinned rather than intrinsic, and that is the point of pinning it: a `<select>` sizes itself to
 * the option currently SHOWING, so a row on Auto and a row on Custom would draw two different
 * widths and slide the "Aa" sample and the well out of line with each other down the tab — the
 * exact property §H26's fixed columns exist to hold. 68 px is the widest of the four labels
 * measured in place at this scale (`Custom`, 67.5 px), so nothing is clipped either.
 */
const LABEL_TEXT_MODE_WIDTH = 68;

/** The Auto / Black / White triple, as the one value a `<select>` carries. */
type TextModeOption = 'auto' | 'black' | 'white' | 'custom';

/** What each mode writes back. `custom` is display-only — the well is what sets a custom colour. */
const TEXT_MODE_VALUE: Readonly<Record<'auto' | 'black' | 'white', LabelTextColorValue>> = {
    auto: null,
    black: { kind: 'custom', hex: BLACK },
    white: { kind: 'custom', hex: WHITE }
};

/** SET-062: Auto (luminance) / Black / White, a custom well, and the "Aa" preview. */
function LabelTextColorField(props: TextColorFieldProps): ReactElement {
    const mode = textMode(props.value);
    const resolved =
        props.value === null
            ? previewStyle({ kind: 'custom', hex: props.background }, null, props.bucket).text
            : hexOf(props.value, props.bucket);
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
            {/*
             * §N36(3) — ONE control where three buttons stood, which is what gives the name
             * column its width back (see `LABEL_COL`). It is `controls.tsx`'s `SelectField`
             * recipe — a plain `<select>`, `rounded border`, the divider stroke, the surface
             * ground — at this row's own 10 px scale rather than a Settings row's 11 px, because
             * every other control in the row (the `Custom…` label, the "Aa" sample, the chip) is
             * 10 px and because 11 px does not fit a Swift-width track.
             *
             * It is also the shape the shipped app has: `LabelPresetsSettingsView.swift:365-394`
             * is a `Menu` of exactly these three, labelled with the "Aa" sample and the current
             * mode's name. `Custom` is offered only when it is what the well has already made —
             * the Swift menu has no Custom entry either, but its `currentLabel` (`:398-409`) does
             * read "Custom", and a `<select>` cannot display a value that is not one of its
             * options.
             */}
            <select
                data-testid={`${props.idPrefix}-mode`}
                data-mode={mode}
                aria-label={props.label}
                value={mode}
                className="shrink-0 rounded border px-1 py-0.5 text-[10px]"
                style={{
                    width: `${String(LABEL_TEXT_MODE_WIDTH)}px`,
                    borderColor: tokens.divider,
                    background: tokens.surfaceBackground,
                    color: tokens.textPrimary
                }}
                onChange={(event) => {
                    const next = event.target.value as TextModeOption;
                    if (next === 'custom') return;
                    props.onChange(TEXT_MODE_VALUE[next]);
                }}
            >
                <option value="auto">Auto</option>
                <option value="black">Black</option>
                <option value="white">White</option>
                {mode === 'custom' ? <option value="custom">Custom</option> : null}
            </select>
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
    readonly style: ResolvedLabelStyle;
    readonly colorToken?: string | undefined;
}

/**
 * SET-058's live chip — one per preset row, following the name as it is typed (N32: there is no
 * composer draft to preview any more, so there is no dimmed placeholder either).
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
            // `truncate`: the chip lives in the fixed 80 px preview column (`LabelCol.preview`),
            // leading-aligned like the Swift `.frame(width:alignment:.leading)`, so a long name
            // ellipsises inside its column instead of pushing the trash button out of line.
            // (`.lineLimit(1)` is on the Swift chip too.)
            className="block max-w-full truncate rounded-full px-1.5 py-0.5 text-[10px] font-medium"
            style={{ background: props.style.background, color: props.style.text }}
        >
            {props.text}
        </span>
    );
}

export function LabelsTab(props: LabelsTabProps): ReactElement {
    const bucket = props.bucket ?? 'dark';
    // H27: there is no `renaming` row any more. Every row's name field is live, so the only
    // cross-row state left is the message a REFUSED rename leaves behind.
    const [renameError, setRenameError] = useState<{ id: string; message: string } | null>(null);
    const [confirming, setConfirming] = useState<string | null>(null);
    const usage = labelUsage(props.workspaces);
    const orphans = orphanLabels(props.workspaces, props.presets);

    /*
     * N33 — where the ring is after a reorder, and it is TWO channels, not one.
     *
     * Measured on the real stack (Electron/Chromium over CDP, driving a LIVE daemon round trip:
     * `docs/audit/n33-reorder-focus/echo-probe.mjs`, and the film beside it), because jsdom can
     * see none of it: it neither blurs a node that is MOVED in the tree, nor blurs a focused
     * element that becomes `disabled`, nor re-evaluates `:hover` when the DOM moves under a
     * stationary pointer.
     *
     * **Channel 1 — `document.activeElement`.** A reorder carries an INTENT (which preset, which
     * arrow), recorded on the press and RE-ASSERTED by every commit in which the order changes
     * while that preset still exists. A layout effect (before paint, so nothing flashes) puts
     * focus on that arrow, or on the row’s OTHER arrow when the pressed one has just disabled
     * itself at an end — a row can only be at one end at a time, so with two or more presets the
     * fallback is always enabled. Keyed on the ORDER rather than on the array’s identity: the
     * mirror hands this tab a fresh `labelPresets` on every `label-presets-changed` delta, a
     * recolour’s included, so identity would fire a commit early. RE-asserted rather than
     * consumed once, because one gesture is not always one commit: the daemon may answer with
     * more than one, another client can reorder the same list, and a second press inside one
     * round trip (the echo measures ~170 ms; a double tap is ~150) leaves the earlier intent for
     * the later echo to finish. Re-asserting costs nothing — `focus()` on the already-focused
     * node fires no events.
     *
     * But re-asserted only while the gesture is still under the user’s hand, which is what the
     * `honoured` flag on `ArrowGesture` decides: the order key is the NAMES joined, so a rename
     * is an order change too (SET-066), and an intent that never stops being re-asserted replays
     * a finished gesture into the middle of the next thing the user does. The condition, and the
     * three failures it closes, are stated at the layout effect below.
     *
     * **Channel 2 — the highlight the user can actually SEE, which is what the report was
     * about.** A mouse click on a `<button>` never matches `:focus-visible` in Chromium, so a
     * mouse-driven reorder paints no focus ring at all (`ring=no` on every frame of the probe):
     * what the eye follows is the hover fill on the arrow and the wash on its row. Chromium
     * re-evaluates `:hover` after the DOM moves and fires `mouseout`/`mouseover` at the reorder
     * commit — so with the pointer perfectly still, the highlight jumps off the row the user
     * just moved and onto the row that slid into the pressed slot. That is the owner’s report
     * exactly: on ↑ the highlight travels one slot up with the row and then bounces straight
     * back down, photographed at +230 ms and +302 ms in `docs/audit/n33-reorder-focus/film/`.
     *
     * AppKit does not do this — a SwiftUI `.onHover` does not re-fire when a view slides under a
     * still cursor — so the port had invented a signal the reference app cannot send. So the
     * pointer-driven paint is PARKED at a reorder commit: until the pointer really moves
     * (`POINTER_PARK_SLOP`), the list paints the highlight on the arrow focus landed on and on no
     * other row. Hit-testing is untouched — the pointer still points where it points — and the
     * moment it moves, hover is the pointer’s business again.
     */
    const arrows = useRef(new Map<string, { up: HTMLButtonElement | null; down: HTMLButtonElement | null }>());
    const focusIntent = useRef<ArrowGesture | null>(null);
    /** Where the pointer was when a reorder was pressed. `null` for a keyboard press. */
    const pressOrigin = useRef<{ x: number; y: number } | null>(null);
    /**
     * N33 (run-AH) — the last element that actually HELD focus, which is the anchor a RE-assert is
     * judged against, because `document.activeElement` at layout-effect time cannot answer the
     * question on its own.
     *
     * A commit that reorders the list MOVES DOM nodes, and a commit that renames a preset UNMOUNTS
     * the row (SET-066: the name IS the id, so the key changes) — Chromium blurs the focused
     * element in both cases and `document.activeElement` reads `<body>` by the time this tab gets
     * to look. So "the user is still on the row's arrow" and "the user had moved on to a name
     * field that this very commit destroyed" are indistinguishable AFTER the fact; the difference
     * has to be captured BEFORE it, which is what this listener does. Kept as the last focus
     * rather than cleared on `focusout`, because the transient `<body>` is exactly what must not
     * count as moving on.
     */
    const lastFocused = useRef<Element | null>(null);
    useEffect(() => {
        /** Is this node one of the list's reorder arrows — any row's, not only the intent's? */
        const isReorderArrow = (node: Element): boolean => {
            for (const entry of arrows.current.values()) {
                if (entry.up === node || entry.down === node) return true;
            }
            return false;
        };
        const remember = (event: FocusEvent): void => {
            if (!(event.target instanceof Element)) return;
            lastFocused.current = event.target;
            /*
             * N33 (run-AH2) — the residual the `honoured` flag leaves, closed at its source.
             *
             * The first honour is UNCONDITIONAL, so an intent armed by a press whose commit has
             * not come back yet is still owed one, and it is paid into whatever the user is doing
             * when an order-changing commit finally arrives. The verifier bounded that window
             * live (`docs/audit/n32-33-verify-ah2/`: the commit is on screen 14-15 ms after the
             * press on a local stack) and proved the mechanism at level 1 — but a bound is not a
             * closure: a daemon across a real network, or a `move-label-preset` that is refused or
             * dropped across a reconnect, widens it without limit.
             *
             * This closes it DETERMINISTICALLY, and without a timer. The record proposed judging
             * the first honour by the same ANCHOR the re-assert uses; that reads `activeElement`
             * (or its last-known stand-in) at COMMIT time, which is exactly the reading that
             * cannot tell a transient `<body>` from the user moving on — the original §N33 dead
             * end. The question is answerable BEFORE the commit instead: an intent is dead the
             * moment a NON-ARROW element takes focus after the press, because that is the user
             * moving on, and it is an EVENT rather than a state so a blur to `<body>` (which
             * fires no `focusin`) can never be mistaken for one.
             *
             * Any row's arrow keeps it alive, not just the intent's own: a burst of presses
             * inside one echo focuses arrows and nothing else (Chromium focuses a `<button>` on
             * mousedown), and a press on ANOTHER row arms its own gesture a moment later at the
             * click — neither is the user leaving the reorder. The three failures the `honoured`
             * flag closed all move to a name field, which is not an arrow.
             */
            if (focusIntent.current !== null && !isReorderArrow(event.target)) focusIntent.current = null;
        };
        document.addEventListener('focusin', remember, true);
        return () => {
            document.removeEventListener('focusin', remember, true);
        };
    }, []);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const [parked, setParked] = useState(false);
    const [parkedArrow, setParkedArrow] = useState<ArrowIntent | null>(null);
    /**
     * N33 — bumped whenever the rows MOVE, and again when the park is released, so every control
     * in the list re-reads its own hover state from the live `:hover` (see `useHover`). Without
     * it a row that slides out from under the pointer keeps its wash for ever: the `mouseleave`
     * that would clear it goes to a node Chromium has already detached, and the tab paints TWO
     * hovered rows at once (measured on the pre-fix bundle, `docs/audit/n33-reorder-focus/`).
     */
    const [hoverEpoch, setHoverEpoch] = useState(0);

    const registerArrow = useCallback(
        (name: string, control: ArrowControl, node: HTMLButtonElement | null): void => {
            const entry = arrows.current.get(name) ?? { up: null, down: null };
            entry[control] = node;
            if (entry.up === null && entry.down === null) arrows.current.delete(name);
            else arrows.current.set(name, entry);
        },
        []
    );

    const reorder = useCallback(
        (name: string, control: ArrowControl, index: number, origin: { x: number; y: number } | null): void => {
            // A press arms a FRESH gesture, un-honoured: every press gets its own first honour,
            // which is what keeps a burst of them (three inside one echo) landing on this row.
            focusIntent.current = { name, control, honoured: false };
            pressOrigin.current = origin;
            props.actions.moveLabelPreset?.({ id: name, index });
        },
        [props.actions]
    );

    // A NUL separator, not a space: a preset name may contain spaces, and two different orders
    // must never collapse to the same key.
    const order = props.presets.map((preset) => preset.name).join('\u0000');
    const settledOrder = useRef(order);
    useLayoutEffect(() => {
        // The mount run is not a reorder: nothing moved, so nothing is parked and there is no
        // intent to re-assert.
        if (settledOrder.current === order) return;
        settledOrder.current = order;
        const intent = focusIntent.current;
        let landed: ArrowIntent | null = null;
        const entry = intent === null ? undefined : arrows.current.get(intent.name);
        const active = document.activeElement;
        /*
         * Never STEAL focus back. The intent survives the transient `<body>` that a moved or
         * disabled arrow leaves behind, and survives focus sitting on another control in this
         * list; but once something OUTSIDE the tab holds it (the terminal taking the caret when
         * the window activates, another window), the reorder is no longer what the user is
         * doing, and the intent is dropped rather than the caret being yanked back.
         */
        const foreign =
            active !== null &&
            active !== document.body &&
            active !== entry?.up &&
            active !== entry?.down &&
            rootRef.current !== null &&
            !rootRef.current.contains(active);
        /*
         * N33 (run-AH) — ONE free honour, then the gesture has to still be under the user's hand.
         *
         * The re-assert exists because one gesture is not always one commit (a burst inside one
         * echo, a daemon answering twice, a second client moving the same list). What it must not
         * be is a recording: a preset's identity IS its name (SET-066), so the `order` key this
         * effect is keyed on changes on a RENAME too — and an intent that is re-asserted forever
         * replays a finished gesture into the middle of someone typing. Measured on the live
         * stack (`docs/audit/n32-33-verify-ah/`): the caret left the field the user had just
         * clicked into, the SPACE in what they typed next pressed the focused arrow and reordered
         * the list, and Escape reached the overlay and closed Settings.
         *
         * So the FIRST honour may come from anywhere — including the `<body>` a moved or disabled
         * arrow leaves behind, which is the common case and the reason the intent exists at all.
         * A RE-assert may only fire while the user is still standing on one of that row's own two
         * arrows; anywhere else means they have moved on, and the gesture is dropped instead. The
         * cases that must keep working all re-assert from the row's own arrow (a burst re-arms on
         * every press, and a second client's move leaves focus where this window put it); the
         * three failures all re-assert from somewhere else — a name field, another row's arrow.
         *
         * The first honour is unconditional HERE and bounded ELSEWHERE (run-AH2): an intent whose
         * press has been followed by a non-arrow `focusin` is already null by the time this runs,
         * dropped at the event rather than judged at the commit — see the `focusin` listener. So
         * "from anywhere" now means "from anywhere the user has not visibly left", and the
         * transient `<body>` this effect must tolerate still costs nothing, because a blur fires
         * no `focusin` at all.
         *
         * `anchor`, not `active`: the commit being handled may itself have destroyed whatever held
         * focus (see `lastFocused`), and a transient `<body>` is not the user moving on.
         */
        const anchor = active === null || active === document.body ? lastFocused.current : active;
        const stale =
            intent !== null &&
            intent.honoured &&
            (anchor === null || (anchor !== entry?.up && anchor !== entry?.down));
        if (intent === null || entry === undefined || foreign || stale) {
            if (intent !== null) focusIntent.current = null;
            setParked(true);
            setParkedArrow(null);
            setHoverEpoch((epoch) => epoch + 1);
            return;
        }
        // Consumed: from here on this gesture is a RE-assert, judged against the anchor above.
        // Marked before the focus rather than after it, so a row whose arrows are both gone (a
        // one-preset list) spends its honour too instead of staying armed for a later commit.
        intent.honoured = true;
        const pressed = entry[intent.control];
        const other: ArrowControl = intent.control === 'up' ? 'down' : 'up';
        const sibling = entry[other];
        // The arrow that was pressed, unless the move disabled it — then the row's other one,
        // which the move necessarily enabled. Never `<body>`.
        const target =
            pressed !== null && !pressed.disabled ? pressed : sibling !== null && !sibling.disabled ? sibling : null;
        if (target !== null) {
            target.focus({ preventScroll: true });
            // `nearest` and not the default: the row moved ONE slot and was on screen when it was
            // pressed, so a centring scroll would be a jump of its own. Guarded because jsdom does
            // not implement `scrollIntoView` at all.
            if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'nearest' });
            landed = { name: intent.name, control: target === pressed ? intent.control : other };
        }
        // Park the pointer-driven paint on EVERY order change, including one this window did not
        // cause: a preset moved by another client slides rows under a still pointer just the same.
        setParked(true);
        setParkedArrow(landed);
        setHoverEpoch((epoch) => epoch + 1);
    }, [order]);

    /*
     * The park ends when the pointer really moves, and `POINTER_PARK_SLOP` is what makes that
     * sentence true on hardware rather than only under a synthetic click: a hand resting on a
     * mouse emits sub-pixel motion continuously, so a zero-threshold release would fire in the
     * same millisecond as the reorder and the highlight would bounce exactly as before.
     */
    useEffect(() => {
        if (!parked) return;
        const origin = pressOrigin.current;
        const release = (event: PointerEvent): void => {
            if (
                origin !== null &&
                Math.abs(event.clientX - origin.x) <= POINTER_PARK_SLOP &&
                Math.abs(event.clientY - origin.y) <= POINTER_PARK_SLOP
            ) {
                return;
            }
            setParked(false);
            setParkedArrow(null);
            setHoverEpoch((epoch) => epoch + 1);
        };
        window.addEventListener('pointermove', release, true);
        return () => {
            window.removeEventListener('pointermove', release, true);
        };
    }, [parked]);

    /*
     * N32 — the mint, and the handoff that makes it a rename rather than a riddle.
     *
     * `addLabelPreset` is fire-and-forget here (every Settings verb is: the daemon's
     * `label-presets-changed` delta is the only truth, §SET-058's own note), so the new row does
     * not exist when the click returns — it arrives a round trip later, ~170 ms on this machine.
     * The name is therefore recorded as an INTENT, exactly like §N33's arrow, and the first
     * commit that actually contains it hands the field focus and selects it, so the default name
     * is typed OVER rather than edited around. If that commit never comes (the daemon refused
     * the name because another client took it in the meantime), the intent is dropped on the
     * next preset change rather than left armed to grab focus at some unrelated moment later.
     */
    const nameFields = useRef(new Map<string, HTMLInputElement | null>());
    const pendingMint = useRef<string | null>(null);
    /** The order the pending mint was last measured against, so "not yet" and "never" differ. */
    const mintOrder = useRef(order);

    const registerNameField = useCallback((name: string, node: HTMLInputElement | null): void => {
        if (node === null) nameFields.current.delete(name);
        else nameFields.current.set(name, node);
    }, []);

    const mint = useCallback((): void => {
        const name = defaultLabelPresetName(props.presets.map((preset) => preset.name));
        pendingMint.current = name;
        // A new gesture supersedes the last reorder's: without this, §N33's intent stays armed
        // and the NEXT commit that changes the order would take the caret out of the name field
        // this mint is about to hand it to.
        focusIntent.current = null;
        // The SAME two-field command the composer sent, and the same one the orphan adoption
        // below and the CLI's `workspace label` back-fill send: a gray preset with a name. No
        // new wire surface, and a GUI-minted preset is indistinguishable from a back-filled one.
        props.actions.addLabelPreset({ name, color: 'gray' });
    }, [props.actions, props.presets]);

    useLayoutEffect(() => {
        const pending = pendingMint.current;
        if (pending === null) return;
        if (!props.presets.some((preset) => preset.name === pending)) {
            // A preset change that is not the one we asked for: stop waiting.
            if (mintOrder.current !== order) pendingMint.current = null;
            mintOrder.current = order;
            return;
        }
        pendingMint.current = null;
        mintOrder.current = order;
        const field = nameFields.current.get(pending);
        if (field === undefined || field === null) return;
        if (typeof field.scrollIntoView === 'function') field.scrollIntoView({ block: 'nearest' });
        field.focus({ preventScroll: true });
        // Selected, not just focused: the row is born with a placeholder NAME rather than an
        // empty field, so "ready to type" means the default is already highlighted.
        field.select();
    }, [order, props.presets]);

    return (
        <div className="flex flex-col gap-4" data-testid="settings-tab-labels" ref={rootRef}>
            {/*
             * L79's `plain`: `LabelPresetsSettingsView.swift:27-45` is a `VStack { addRow;
             * Divider(); List }`, not a `Form` — there is no grouped card anywhere on this tab,
             * and the rows below carry their own chrome (the list's `alternatesRowBackgrounds`
             * stripe, an explicit `Divider()`).
             */}
            <SettingsSection
                plain
                /*
                 * §N36(2) — "Labels", not "Presets".
                 *
                 * The user-facing concept in this app is a LABEL: the sidebar's submenu applies
                 * labels, `nex workspace label` writes labels, a workspace WEARS labels. "Preset"
                 * is what the daemon calls the stored row (`labelPresets`, `add-label-preset`,
                 * §SET-058…§SET-068) and it stays there — in the wire verbs, the props, the
                 * test ids and these comments — but no copy on this tab says it any more. The
                 * boundary is exactly: anything a person reads or a screen reader speaks (titles,
                 * hints, button text, `title` tooltips, `aria-label`s, the empty state, the
                 * refusal and confirmation sentences) says "label"; every identifier keeps
                 * "preset". Where the Swift has the same string it is quoted in the comment and
                 * the divergence noted, because this is a deliberate one: `:88` really does say
                 * "No label presets yet" and `:244` really does say "Remove preset".
                 */
                title="Labels"
                hint="A workspace's label wears the colors set here when its text matches the name exactly."
                testID="label-presets"
                /*
                 * §N36(1) — the New Label button moves to the header's TOP RIGHT.
                 *
                 * Owner-directed, from the frame where it sat under the title looking like the
                 * first item of the list it heads. In the header it reads as the section's
                 * toolbar, which is what `LabelPresetsSettingsView.swift:27-31` makes the add
                 * affordance: the thing above the `Divider()`, not a row of the `List`. The
                 * divider below is unchanged and still separates it from the list.
                 */
                action={
                    <SettingsButton testID="label-add" title="Add a label and name it" onClick={mint}>
                        New Label
                    </SettingsButton>
                }
            >
                {/*
                 * N32 (owner-directed) — the composer is GONE, and in its place is one button.
                 *
                 * What stood here was an always-visible design surface: a heading, ten swatches,
                 * a name field, an Auto/Black/White cluster, a chip preview and an Add button —
                 * a whole preset's worth of controls, on the same `LabelCol` grid as the rows
                 * (§H26 requires that, so the wells line up), which is exactly why the owner kept
                 * reading it as a fourth preset with an empty name. Two rounds of treatment (a
                 * name, then a ground) made it discernible without making it right: the tab was
                 * asking for a design BEFORE the thing existed, and then repeating every one of
                 * those controls in the row it created.
                 *
                 * So a preset is now MINTED and then edited in place, which is the pattern this
                 * port already uses for a group (`App.tsx`'s `newGroupWithRename` → `New Group` /
                 * `New Group 2` / …, straight into inline rename) and which the Swift uses for
                 * every one of its four group routes. One button, where the composer's row was;
                 * pressing it writes a gray preset with a unique default name through the SAME
                 * `add-label-preset` verb the composer used — no new wire surface — and the row
                 * the daemon echoes back opens with its name field focused and selected, ready
                 * to be typed over. Every property of it is then edited exactly where every other
                 * preset's is.
                 *
                 * §N36(1) moved that one button out of the list's own left column and up into the
                 * section header's trailing edge (see the `action` prop above). The verb it
                 * sends, the mint and the focus handoff are untouched; only where it stands moved.
                 */}

                {/* `Divider()` — the add control heads the list, it is not a row of it. */}
                <div
                    data-testid="label-add-divider"
                    className="h-px"
                    style={{ background: tokens.divider }}
                />

                {/*
                 * M45: `LabelPresetsSettingsView.swift:85-97`'s `Image(systemName: "tag")` at
                 * 28 pt over a `.secondary` headline and a `.caption`/`.tertiary` explanation,
                 * centred in the space. The port had an inline `🏷` at body size on one wrapped
                 * paragraph. It stands BELOW the divider, where the Swift's `if` puts it — it is
                 * the list's empty state, not the tab's (N32(a)).
                 *
                 * §N36(2): the Swift's own headline is "No label presets yet" (`:88`). The detail
                 * beneath it was already written in labels, so only the headline moves.
                 */}
                {props.presets.length === 0 ? (
                    <SettingsEmptyState
                        testID="labels-empty"
                        glyph={<TagGlyph size={28} />}
                        title="No labels yet"
                        detail="Define reusable labels with colours, then assign them from a workspace's right-click menu — or apply a label from the CLI and adopt it here."
                    />
                ) : null}

                {props.presets.map((preset, index) => (
                    <PresetRow
                        /*
                         * N33: the key is the PRESET ID (SET-066 — a preset's identity IS its
                         * name), so a reorder MOVES each row's nodes instead of recreating them,
                         * and the arrow the focus intent points at is the same DOM node before
                         * and after the daemon's echo. Nothing here may key on the index.
                         */
                        key={preset.name}
                        preset={preset}
                        presets={props.presets}
                        index={index}
                        bucket={bucket}
                        inUse={usage.get(preset.name) ?? 0}
                        actions={props.actions}
                        error={renameError?.id === preset.name ? renameError.message : null}
                        confirming={confirming === preset.name}
                        onReorder={reorder}
                        registerArrow={registerArrow}
                        registerNameField={registerNameField}
                        parked={parked}
                        parkedArrow={parked && parkedArrow?.name === preset.name ? parkedArrow.control : null}
                        hoverEpoch={hoverEpoch}
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
                    /*
                     * §N36(2): "without a preset" and "give them one" both named the internal
                     * object. The section is port-only (§6.5/§6.6 — the Swift has no orphan
                     * list), so there is no shipped string to weigh it against; what it has to
                     * say is that these labels are worn somewhere but not DEFINED in the list
                     * above, and that adding them here is what colours them.
                     */
                    title="Labels not defined here"
                    hint="Applied to a workspace but not in the list above — they render neutral until you add them."
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
    /**
     * N33: dispatch the move, record which arrow should hold focus once it lands, and say where
     * the pointer was (`null` for a keyboard press) so the park can tell jitter from a real move.
     */
    readonly onReorder: (
        name: string,
        control: ArrowControl,
        index: number,
        origin: { x: number; y: number } | null
    ) => void;
    /** N33: hand the tab this row's two arrow nodes, so it can put focus back on one of them. */
    readonly registerArrow: (name: string, control: ArrowControl, node: HTMLButtonElement | null) => void;
    /** N32: hand the tab this row's name field, so a freshly minted preset opens ready to type. */
    readonly registerNameField: (name: string, node: HTMLInputElement | null) => void;
    /**
     * N33: the list has re-ordered and the pointer has not moved since, so `:hover` is a lie —
     * paint from the reorder rather than from the pointer until it moves.
     */
    readonly parked: boolean;
    /** Which of THIS row's arrows the reorder left focus on, or `null` when it is not the subject. */
    readonly parkedArrow: ArrowControl | null;
    /** N33: changes whenever the rows move, so hover states are re-read rather than trusted. */
    readonly hoverEpoch: number;
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
    const { hovered, hoverProps, hoverRef } = useHover(true, props.hoverEpoch);
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

    /*
     * N33: STABLE ref callbacks, one per arrow.
     *
     * Stability is the point, not tidiness. A fresh closure each render makes React detach the
     * old ref (`node = null`) and attach the new one on every commit — including the reorder
     * commit, whose layout effect reads this map immediately afterwards. Keyed on the preset's
     * name and on `registerArrow` (itself a `useCallback` in the tab), these are called exactly
     * twice per row in its lifetime: once with the node, once with `null` when the row unmounts,
     * which is what evicts a deleted preset from the map.
     */
    const registerArrow = props.registerArrow;
    const upRef = useCallback(
        (node: HTMLButtonElement | null) => {
            registerArrow(preset.name, 'up', node);
        },
        [registerArrow, preset.name]
    );
    const downRef = useCallback(
        (node: HTMLButtonElement | null) => {
            registerArrow(preset.name, 'down', node);
        },
        [registerArrow, preset.name]
    );
    /** N32: the same shape for the name field, for the mint's focus handoff. */
    const registerNameField = props.registerNameField;
    const nameRef = useCallback(
        (node: HTMLInputElement | null) => {
            registerNameField(preset.name, node);
        },
        [registerNameField, preset.name]
    );

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
            // §N36(2): "…is already a preset" named the internal object at the one moment the
            // user is being told why their edit was refused, which is the worst place for it.
            props.onRenameRefused(`“${next}” is already a label — the name is unchanged.`);
            return;
        }
        props.onRenameRefused(null);
        props.actions.updateLabelPreset({ id: preset.name, name: next });
    };

    /*
     * N33: what this row PAINTS as hovered. While the list is parked the pointer's own state is
     * a lie — the rows moved under a stationary cursor — so the wash goes to the row the reorder
     * was about (`parkedArrow !== null`) and to no other, until the pointer really moves.
     */
    const lit = props.parked ? props.parkedArrow !== null : hovered;

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
                    lit,
                    props.index % 2 === 1 ? LABEL_ROW_STRIPE.alternate : LABEL_ROW_STRIPE.base
                )
            }}
            {...hoverProps}
            data-hovered={lit ? 'true' : 'false'}
            ref={hoverRef}
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
                    ref={nameRef}
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
                        {/*
                         * N33: both arrows hand their node up to the tab and route the move
                         * through `onReorder`, which records the focus intent alongside the
                         * dispatch, so focus can follow the MOVED row rather than being left
                         * wherever Chromium's own bookkeeping drops it.
                         */}
                        <SettingsIconButton
                            testID={`label-move-up-${preset.name}`}
                            ariaLabel={`Move ${preset.name} up`}
                            buttonRef={upRef}
                            disabled={props.index === 0}
                            highlight={props.parked ? props.parkedArrow === 'up' : undefined}
                            hoverEpoch={props.hoverEpoch}
                            onClick={(event) => {
                                props.onReorder(preset.name, 'up', props.index - 1, pointerOrigin(event));
                            }}
                        >
                            ↑
                        </SettingsIconButton>
                        <SettingsIconButton
                            testID={`label-move-down-${preset.name}`}
                            ariaLabel={`Move ${preset.name} down`}
                            buttonRef={downRef}
                            disabled={props.index === presets.length - 1}
                            highlight={props.parked ? props.parkedArrow === 'down' : undefined}
                            hoverEpoch={props.hoverEpoch}
                            onClick={(event) => {
                                props.onReorder(preset.name, 'down', props.index + 1, pointerOrigin(event));
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
                    // §N36(2): the Swift's own help text is "Remove preset" (`:244`).
                    ariaLabel={`Remove the ${preset.name} label`}
                    title="Remove label"
                    // Parked: the pointer is over an arrow, not over this — and while the list is
                    // parked no control may light from a hover the pointer never performed.
                    highlight={props.parked ? false : undefined}
                    hoverEpoch={props.hoverEpoch}
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
                        {/*
                         * §N36(2): the sentence used to lean on the preset/label distinction to
                         * say what survives a delete ("the PRESET goes, the LABEL stays"). With
                         * one word for both, it has to name the two things plainly: the name
                         * stays applied, the colours are what go.
                         */}
                        {`Delete this label? The name stays on ${String(props.inUse)} workspace${
                            props.inUse === 1 ? '' : 's'
                        } and those chips render neutral.`}
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
