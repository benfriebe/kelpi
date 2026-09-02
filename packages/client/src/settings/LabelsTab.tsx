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
 * **The design surface (SET-058, SET-061, SET-062) — §N38, owner-directed.** A preset is still
 * designed FROM ITS ROW, but no longer IN it: the row carries a single swatch TRIGGER, and both
 * colours are edited in the anchored popover that trigger opens (`ColorFlyover.tsx`, where the
 * whole redesign is written up). §N32 removed the always-visible composer that used to carry a
 * second copy of the controls above the list — a preset is minted with a default name and colour
 * and then edited exactly like any other, which is the mint-with-rename shape the port already
 * uses for a group. That is an OWNER-DIRECTED divergence from the Swift, which does keep an
 * always-visible add row (`LabelPresetsSettingsView.swift:106-132`).
 *
 * What §N38 replaced, so the swap is on the record:
 *
 *   - the ten named colours were a SWATCH ROW in a 150 px track (`LabelCol.bgColor`) with a
 *     `Custom…` well — an `<input type="color">` over a swatch — at its end. They are now the
 *     popover's **Background** section: the same ten swatches, the same `aria-pressed` answer to
 *     "which one is set", and a bordered `✎ Custom` row where the OS well was;
 *   - the text colour was an Auto / Black / White `<select>` plus a second well in a 124 px track
 *     (`LabelCol.textColor`, §N36(3)'s collapse). It is now the popover's **Text** section: three
 *     explicit buttons — which is what the mockup draws, and what §N36(3) had collapsed only
 *     because 179.5 px would not fit a Swift-width track that no longer exists — over the same
 *     `Custom` row. Auto is still `null`: the daemon and `resolveLabelStyle` derive black-or-white
 *     from the background's luminance, which is the rule `LabelPreset.resolvedStyle` states;
 *   - the OS colour picker is gone entirely. Both `Custom` rows open a HAND-ROLLED HSV picker
 *     inside the same popover (a saturation/value square, a hue slider, a hex field), so the two
 *     colours are chosen on one surface instead of in a native window the app cannot style, place
 *     or read back. `controls.tsx`'s `ColorField` still uses the native well; this tab no longer
 *     does, and that is the one divergence between the two.
 *
 * **The colour MODEL is untouched.** `{kind:'named'}` / `{kind:'custom', hex}` for the background,
 * that-or-`null` for the text, written through the same `update-label-preset` verb with the same
 * one-string encoding (`tokenOf` / `textToken`, which now live in `ColorFlyover.tsx` beside the
 * editor that owns them). The popover is a new EDITOR over the same stored values.
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
 *   - every row is ONE grid line on `LabelCol`'s widths — §N38 collapses the background 150 and
 *     the text colour 124 into a single 24 px swatch-trigger column and hands the 260 px that
 *     frees to the name, and §N40 takes 80 of them back out as a fixed track for the in-use
 *     count, leaving swatch 24, usage 80, preview 80, reorder 44, action 40 with the name
 *     flexing between them (`:7-12`, `:204-245`) — not a two-line stacked card;
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
    resolveLabelStyle,
    tokens,
    withAlpha,
    type ChromeBucket,
    type ChromeLabelPreset,
    type ResolvedLabelStyle
} from '../chrome';
import {
    ColorFlyover,
    hexOf,
    labelPreviewStyle,
    textMode,
    textToken,
    tokenOf,
    type LabelColorValue,
    type LabelTextColorValue
} from './ColorFlyover';
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
 * `LabelCol` (`LabelPresetsSettingsView.swift:7-12`), to the point — as §N38 leaves it.
 *
 * The fixed widths are the whole reason that file has an opening comment: they are what makes
 * the colour control, the chip and the trash line up in columns down the tab. The name is the one
 * thing that flexes, exactly as `.frame(maxWidth: .infinity)` makes it in the Swift row.
 *
 * §N38 replaces the Swift's two colour tracks with ONE: `swatch`, 24 px, holding the trigger that
 * opens the flyover. Both of the Swift's colour controls live in that popover now, so the row has
 * one cell where it had two, and the widths those two spent are the name's (see `LABEL_NAME_MIN`).
 *
 * TWO columns are this port's own and are named as such:
 *
 *   - `reorder`, holding the ↑/↓ pair that stands in for the Swift `List`'s drag (SET-065's
 *     stated divergence). It sits between the preview and the action column so the Swift columns
 *     keep both their widths and their order;
 *   - `usage`, §N40's, holding the in-use count. It used to ride INSIDE the flexible name cell,
 *     which is the one thing on this row that made the widths a half-truth: a `shrink-0` caption
 *     beside a `flex-1` field moves the boundary between them by exactly its own string, so
 *     `unused` / `1 workspace` / `12 workspaces` drew three different name widths down a tab
 *     whose whole premise is that a row is a table line. Measured on the live stack before the
 *     fix (1280 × 820, dark): the field ended at **812.55 / 786.36 / 773.84** and the caption
 *     began at **820.55 / 794.36 / 781.84** — a 38.71 px rag over three rows.
 *
 * **80 px, and it is measured rather than chosen.** In the page, at the caption's own computed
 * font (`11px/15.4px ui-sans-serif, -apple-system, …` — the system UI face), `12 workspaces` —
 * the widest realistic string, per the owner — renders **77.16 px**. 78 would be its ceiling with
 * 0.84 px to spare, which is less than a pixel of protection against a machine that resolves a
 * different face; 80 keeps ~2.8 px and, usefully, covers the widest TWO-DIGIT count there is
 * (`99 workspaces`, 79.43 px), so the entire realistic range fits with nothing truncated. Above
 * it the cell ellipsises inside its own track and keeps its `title`, rather than pushing the
 * chip. (For the record, the other strings: `unused` 38.45 px, `1 workspace` 64.64 px.)
 */
const LABEL_COL = { swatch: 24, usage: 80, preview: 80, reorder: 44, action: 40 } as const;

/**
 * §N40 — the name floor is **330**, and it is §N38's 420 with the usage track taken out of it.
 *
 * The caption was never free: it rode in the name cell, so its width came out of the field's
 * every time. Giving it a track of its own does not change what the row costs, only WHERE the
 * cost is stated — so the floor pays for it, exactly as the flyover's 260 px went into the floor:
 *
 *   | what moves out of the name cell            |   px |
 *   |--------------------------------------------|-----:|
 *   | the `usage` track                          |   80 |
 *   | one 10 px column gap (five tracks → six)    |   10 |
 *   | **taken**                                   | **90** |
 *
 * 420 − 90 = **330**, so `LABEL_GRID_MIN_WIDTH` comes out **648 px** for the fourth redesign
 * running (see below), and the name FIELD stops changing width from row to row: at 1280 × 820 it
 * is 332 px in every row where §N38 drew 375.55 / 349.36 / 336.84.
 *
 * §N38 — the name floor was **420**, and every pixel of the rise is accounted for.
 *
 * §N36(3) put it at 160 by collapsing the Auto/Black/White triple into a `<select>`, which freed
 * 60 px out of the text-colour track; §S60 had recorded the debt that fix was paying down (at the
 * 880 px dialog the name track was 102 px and the field inside it rendered 49.6, so `Test` read
 * `Tes` and a minted `New label` read `New lal`). The flyover retires the whole question by
 * removing both colour tracks from the row:
 *
 *   | what the row loses                        |   px |
 *   |-------------------------------------------|-----:|
 *   | `bgColor` 150 → the 24 px swatch trigger   |  126 |
 *   | `textColor` 124 → gone entirely            |  124 |
 *   | one 10 px column gap (six tracks → five)   |   10 |
 *   | **freed**                                  | **260** |
 *
 * 160 + 260 = **420**, and it goes into the FLOOR rather than only into the flexible share, for
 * §S57's reason: the name is the only flexible track and every other one is a hard px, so a
 * narrowing window took it all (measured at a 760 × 700 window: a 14 × 28.2 px field, no room for
 * one character). A track with a floor gives the row a min-content width instead, so a too-narrow
 * panel scrolls sideways rather than emptying the one field you type into (`settings-panel` is
 * `overflow-y-auto`, and CSS resolves a scroll container's other axis to `auto` with it).
 *
 * And it costs nothing: `LABEL_GRID_MIN_WIDTH` comes out **648 px, exactly what it was** through
 * §S57, §S60, §N36(3), §N38 and now §N40 (24 + 330 + 80 + 80 + 44 + 40 + 5 × 10 = 648 = 24 + 420
 * + 80 + 44 + 40 + 4 × 10 = 150 + 160 + 124 + 80 + 44 + 40 + 5 × 10). Nothing that fitted before
 * stops fitting, and a panel narrow enough to scroll scrolls by the same amount it did.
 */
const LABEL_NAME_MIN = 330;

/** §N40: six tracks, `[swatch trigger · name · usage · chip · reorder · trash]`. */
const LABEL_GRID = `${String(LABEL_COL.swatch)}px minmax(${String(LABEL_NAME_MIN)}px,1fr) ${String(
    LABEL_COL.usage
)}px ${String(LABEL_COL.preview)}px ${String(LABEL_COL.reorder)}px ${String(LABEL_COL.action)}px`;

/** The width the tracks + gaps need; below it the list scrolls rather than the name collapsing. */
export const LABEL_GRID_MIN_WIDTH =
    LABEL_COL.swatch +
    LABEL_NAME_MIN +
    LABEL_COL.usage +
    LABEL_COL.preview +
    LABEL_COL.reorder +
    LABEL_COL.action +
    5 * 10;

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
 * Swift's own `KelpiCommands.defaultGroupName`): a mint has to produce something the daemon will
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

/**
 * §6.2's one-string encoding, read back off a preset so the trigger and the chip agree.
 *
 * §N38: the colour MODEL — `LabelColorValue`, `LabelTextColorValue`, `tokenOf`, `textToken`,
 * `hexOf`, `textMode` and the preview's `labelPreviewStyle` — moved into `ColorFlyover.tsx`,
 * which is the editor that owns it now. Nothing about the values changed; only where the
 * functions that read them live, so the popover and this row cannot drift apart.
 */
function colorToken(preset: ChromeLabelPreset): string {
    return preset.color.kind === 'named' ? preset.color.color : preset.color.hex;
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

interface SwatchTriggerProps {
    readonly testID: string;
    readonly ariaLabel: string;
    readonly title: string;
    /** The label's current BACKGROUND — the trigger paints the value it opens an editor for. */
    readonly color: string;
    /** §6.2's token for that value (`purple` / `#ff8800`), so a test reads it without a colour. */
    readonly token: string;
    readonly open: boolean;
    readonly buttonRef: (node: HTMLButtonElement | null) => void;
    readonly onClick: () => void;
}

/**
 * §N38 — the row's whole colour surface: ONE swatch that opens the flyover.
 *
 * It paints the label's background, because that is the value a person scans a list of labels
 * for, and it is the control the popover is anchored to. What it replaces is 274 px of inline
 * controls (`LabelColorField`'s ten swatches + `Custom…` well in `LabelCol.bgColor`, and
 * `LabelTextColorField`'s "Aa" sample + mode `<select>` + well in `LabelCol.textColor`), all of
 * which now live in `ColorFlyover.tsx`.
 *
 * **§S50's hit treatment comes with it, unchanged in kind.** A swatch is a case where the box IS
 * the picture, so `SettingsIconButton`'s `h-5 w-5` + `-m-0.5` recipe cannot be used as-is — a
 * 20 px box would draw a 20 px disc. The paint is a 16 px disc and the target is grown to 20 px
 * by the transparent inset overlay, exactly as the row's palette swatches did; the 24 px column
 * leaves 2 px either side, so the target sits inside its own track and cannot reach the name.
 *
 * `aria-haspopup="dialog"` + `aria-expanded` is the pair a screen reader needs to know this is a
 * disclosure rather than a colour that toggles, and it is what the audit reads to prove the row
 * carries a TRIGGER rather than a swatch that sets a colour on click.
 */
function SwatchTrigger(props: SwatchTriggerProps): ReactElement {
    const { hovered, hoverProps } = useHover();
    const ring = props.open ? tokens.accent : hovered ? tokens.selectionStroke : null;
    return (
        <button
            ref={props.buttonRef}
            type="button"
            data-testid={props.testID}
            data-color={props.token}
            aria-label={props.ariaLabel}
            aria-haspopup="dialog"
            aria-expanded={props.open}
            title={props.title}
            className="relative h-4 w-4 shrink-0 rounded-full"
            style={{
                background: props.color,
                outline: ring === null ? 'none' : `2px solid ${ring}`,
                outlineOffset: '1px'
            }}
            {...hoverProps}
            onClick={props.onClick}
        >
            {/* §S50's 20 px target: 2 px of transparent bleed on every side, hit-tested and
                clicked through to the button that owns it. It paints nothing and is out of flow,
                so the disc, the 24 px column and every column after it are untouched. */}
            <span aria-hidden style={{ position: 'absolute', inset: -2, borderRadius: '9999px' }} />
        </button>
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
    /**
     * §N38 — WHICH row's flyover is open, held by the TAB rather than by the row.
     *
     * The same lifetime argument `ContextMenu`'s header makes out loud: a popover whose open state
     * lives in the row it hangs off is destroyed by anything that re-creates that row, and this
     * list re-creates rows for a living (a rename changes the key — §SET-066 — and every colour
     * write comes back as a fresh `labelPresets` array). Held here, the popover survives its own
     * writes, which is the minimum for a surface whose whole job is to apply them immediately.
     *
     * It is also what makes "one at a time" true without any row knowing about any other.
     */
    const [flyover, setFlyover] = useState<string | null>(null);
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
        // and the KELPIT commit that changes the order would take the caret out of the name field
        // this mint is about to hand it to.
        focusIntent.current = null;
        // …and so does an open flyover (§N38). The mint's handoff is to the NEW row's name field;
        // leaving a popover up over another row would put the caret behind it.
        setFlyover(null);
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

    /*
     * §N38 — an open flyover whose row has GONE closes itself.
     *
     * A preset's identity is its name (§SET-066), so a rename from anywhere (another client, the
     * CLI's `workspace label`, this row's own field) unmounts the row the popover is anchored to,
     * and a delete does the same. Left standing, the popover would be attached to a trigger that
     * no longer exists — `anchorRef.current` null, focus with nowhere to go home to. Keyed on the
     * ORDER string rather than on the array, for §N33's reason: the mirror hands this tab a fresh
     * `labelPresets` on every delta, a recolour's included, and this must not fire on those.
     */
    useEffect(() => {
        setFlyover((current) =>
            current !== null && !props.presets.some((preset) => preset.name === current) ? null : current
        );
    }, [order, props.presets]);

    const empty = props.presets.length === 0;
    /*
     * The port-only adoption section (§6.5/§6.6). Populated, it is the tab's second section;
     * empty, it rides in the list section's balanced column as `trailing`, so it settles at the
     * foot of the tab instead of pushing the placeholder's centre up by half its own height.
     */
    const adoption = orphans.length === 0 ? null : (
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
            hint="Applied to a workspace but not in the list above - they render neutral until you add them."
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
    );
    return (
        <div className="flex min-h-full flex-col gap-4" data-testid="settings-tab-labels" ref={rootRef}>
            {/*
             * L79's `plain`: `LabelPresetsSettingsView.swift:27-45` is a `VStack { addRow;
             * Divider(); List }`, not a `Form` — there is no grouped card anywhere on this tab,
             * and the rows below carry their own chrome (the list's `alternatesRowBackgrounds`
             * stripe, an explicit `Divider()`).
             */}
            <SettingsSection
                plain
                /*
                 * M45: `LabelPresetsSettingsView.swift:85-97`'s `Image(systemName: "tag")` at
                 * 28 pt over a `.secondary` headline and a `.caption`/`.tertiary` explanation,
                 * centred in the space. The port had an inline `🏷` at body size on one wrapped
                 * paragraph. It stands BELOW the divider, where the Swift's `if` puts it (the
                 * section renders `empty` after its children), because it is the list's empty
                 * state, not the tab's (N32(a)); and it is centred against the whole tab below
                 * the header, with the caption and the adoption section settled under it
                 * (`SettingsSection`'s `empty`).
                 *
                 * §N36(2): the Swift's own headline is "No label presets yet" (`:88`). The detail
                 * beneath it was already written in labels, so only the headline moves.
                 */
                empty={
                    empty ? (
                        <SettingsEmptyState
                            testID="labels-empty"
                            glyph={<TagGlyph size={28} />}
                            title="No labels yet"
                            detail="Define reusable labels with colours, then assign them from a workspace's right-click menu - or apply a label from the CLI and adopt it here."
                        />
                    ) : undefined
                }
                trailing={empty ? adoption : undefined}
                /*
                 * §N36(2) — "Labels", not "Presets".
                 *
                 * The user-facing concept in this app is a LABEL: the sidebar's submenu applies
                 * labels, `kelpi workspace label` writes labels, a workspace WEARS labels. "Preset"
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
                hint="A workspace's label wears the colours set here when its text matches the name exactly."
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
                        flyoverOpen={flyover === preset.name}
                        onFlyoverChange={(open) => {
                            setFlyover(open ? preset.name : null);
                        }}
                        onConfirmChange={(open) => {
                            setConfirming(open ? preset.name : null);
                        }}
                        onRenameRefused={(message) => {
                            setRenameError(message === null ? null : { id: preset.name, message });
                        }}
                    />
                ))}
            </SettingsSection>

            {empty ? null : adoption}
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
    /** §N38: is THIS row's colour flyover the one that is up? (One at a time, owned by the tab.) */
    readonly flyoverOpen: boolean;
    readonly onFlyoverChange: (open: boolean) => void;
    readonly onConfirmChange: (open: boolean) => void;
    readonly onRenameRefused: (message: string | null) => void;
}

/**
 * One preset, as ONE grid line on `LABEL_COL`'s widths (H26) — §N40's six cells.
 *
 * `LabelPresetsSettingsView.swift:204-245` is a single `HStack(spacing: 10)`: colour well,
 * name field, text-colour well, chip, trash — every one of them in a fixed column so the tab
 * reads as a table rather than a stack of cards. §N38 collapses the Swift's two colour cells into
 * ONE — a swatch trigger that opens the flyover carrying both — and §N40 gives the in-use count
 * a fixed cell of its own, so the line is `[swatch · name · usage · chip · reorder · trash]`.
 * BOTH port-only affordances that have no Swift column (the in-use count and the ↑/↓ pair) now
 * have their own fixed column in every row, which is what §N40 is: while the count rode in the
 * flexible NAME cell it moved the name/usage boundary by its own string, so the one cell whose
 * width the eye can actually see redrew itself per row.
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
    /** §N38: the trigger, which is both the flyover's anchor and where its Escape hands focus. */
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const setTriggerRef = useCallback((node: HTMLButtonElement | null) => {
        triggerRef.current = node;
    }, []);

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

    /**
     * §6.4's in-use count, and §N40's whole subject: it is the ONLY thing the usage track ever
     * says, whatever else the row is doing, so the column's width is a function of the count and
     * not of what the user happens to be typing.
     *
     * Singular at one (§N40): `1 workspace`, `12 workspaces`, and `unused` unchanged for none —
     * "unused" is a state rather than a count of zero, which is why it is not `0 workspaces`.
     */
    const usageText =
        props.inUse === 0 ? 'unused' : `${String(props.inUse)} workspace${props.inUse === 1 ? '' : 's'}`;
    /** …and the consequence of renaming, which only exists while a committable name is in the field. */
    const renameWarning = live && props.inUse > 0;

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
            props.onRenameRefused(`“${next}” is already a label - the name is unchanged.`);
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
                // holding the eye across six columns. Hover still wins over the stripe.
                background: hoverBackground(
                    lit,
                    props.index % 2 === 1 ? LABEL_ROW_STRIPE.alternate : LABEL_ROW_STRIPE.base
                )
            }}
            {...hoverProps}
            data-hovered={lit ? 'true' : 'false'}
            ref={hoverRef}
        >
            {/*
             * §N38 — cell 1: the swatch trigger, and the popover it owns.
             *
             * L93's announcement rule survives the redesign intact: the Swift menus are labelled
             * `"Colour: \(name)"` / `"Text colour: \(currentLabel)"` — the field's name AND the
             * value in it — so ONE control that carries both values says both, and a screen
             * reader still answers "which colours are set" without opening anything.
             */}
            <span className="flex items-center justify-start">
                <SwatchTrigger
                    testID={`label-color-${preset.name}-trigger`}
                    ariaLabel={`${preset.name} colours: ${colorAnnouncement(preset.color)} background, ${textColorAnnouncement(
                        textColor
                    )} text`}
                    title="Edit colours"
                    color={hexOf(preset.color, bucket)}
                    token={colorToken(preset)}
                    open={props.flyoverOpen}
                    buttonRef={setTriggerRef}
                    onClick={() => {
                        props.onFlyoverChange(!props.flyoverOpen);
                    }}
                />
                {props.flyoverOpen ? (
                    <ColorFlyover
                        name={preset.name}
                        color={preset.color}
                        textColor={textColor}
                        bucket={bucket}
                        anchorRef={triggerRef}
                        onColorChange={(next) => {
                            props.actions.updateLabelPreset({ id: preset.name, color: tokenOf(next) });
                        }}
                        onTextColorChange={(next) => {
                            props.actions.updateLabelPreset({ id: preset.name, textColor: textToken(next) });
                        }}
                        onClose={() => {
                            props.onFlyoverChange(false);
                        }}
                    />
                ) : null}
            </span>

            <span className="flex min-w-0 items-center">
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
            </span>

            {/*
             * §6.4's consequence, made concrete: the count of workspaces wearing this label.
             *
             * §N40 (owner-directed) — its OWN fixed track, `LabelCol.usage`, where it used to be
             * a `shrink-0` caption sharing the flexible name cell with the field. The column is
             * port-only, like `reorder`, and it is measured rather than picked: see `LABEL_COL`
             * for the 77.16 px `12 workspaces` renders at and why the track is 80.
             *
             * LEFT-aligned, which is the reading direction it already had — the sentence carries
             * on from the name field to its left, and a left edge is the one a fixed track can
             * hold still (a right-aligned count would pin the wrong end and leave the ragged edge
             * facing the name, which is the edge the owner was reading). `truncate` + `title`
             * because a track sized to the widest REALISTIC string is not sized to every string:
             * a three-digit count ellipsises inside its own column instead of pushing the chip.
             *
             * What is NOT here any more is the rename warning. It used to REPLACE this count
             * while the field held a committable name, and at 50 characters it is not a caption —
             * in an 80 px track it would read `Renaming unst…`. It moves to the row's full-width
             * note line below, beside the refusal message, which is the other sentence this row
             * says to the person typing in it.
             */}
            <span className="flex min-w-0 items-center justify-start">
                <span
                    data-testid={`label-usage-${preset.name}`}
                    className="min-w-0 truncate text-[11px]"
                    title={usageText}
                    style={{ color: tokens.textTertiary }}
                >
                    {usageText}
                </span>
            </span>

            {/*
             * §N38: the text-colour cell is GONE from the row — `LabelTextColorField`'s "Aa"
             * sample, its mode `<select>` and its well are the flyover's Text section now. The
             * chip is what is left saying what the text colour resolved to, which it always did.
             */}
            <span className="flex min-w-0 justify-start">
                <ChipPreview
                    testID={`label-chip-${preset.name}`}
                    colorToken={colorToken(preset)}
                    text={previewText}
                    style={
                        live
                            ? labelPreviewStyle(preset.color, textColor, bucket)
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

            {/*
             * §N40 — the rename CONSEQUENCE, on the row's own full-width note line.
             *
             * §6.4 makes a preset's name its identity, so committing a new one silently unstyles
             * every chip already wearing the old one; this is the sentence that says so, and it
             * appears only while the field holds a name that WOULD commit and something is
             * actually wearing it. It used to live in the usage caption, replacing the count —
             * which is what made that caption's width a function of what was being typed. It is
             * a sentence, not a caption, so it goes where the row's other sentence goes: the
             * `1 / -1` line under the cells, next to the refusal message it is the counterpart of
             * (that one says a rename was refused; this one says what an accepted rename costs).
             * The count stays visible in its own column while it is up.
             */}
            {renameWarning ? (
                <span
                    data-testid={`label-rename-warning-${preset.name}`}
                    className="text-[11px]"
                    style={{ gridColumn: '1 / -1', color: tokens.textTertiary }}
                >
                    Renaming unstyles the chips already using this name
                </span>
            ) : null}

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
