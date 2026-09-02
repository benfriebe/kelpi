/**
 * Shared Settings primitives.
 *
 * Deliberately tiny and local: the chrome package owns the app's surfaces, and Settings is a
 * different kind of surface (form controls, not direct manipulation). Everything below paints
 * with the same `--kelpi-*` tokens, so a chrome theme change moves this window too.
 */

import {
    Children,
    useCallback,
    useLayoutEffect,
    useRef,
    useState,
    type CSSProperties,
    type MouseEvent as ReactMouseEvent,
    type ReactElement,
    type ReactNode,
    type Ref
} from 'react';

import { tokens, withAlpha } from '../chrome';

// ── the hover recipe (H11) ──────────────────────────────────────────────────────────

/**
 * The ONE fill a hovered Settings control takes.
 *
 * `selectionFill` rather than a Settings-local tint: it is the token `chrome/ContextMenu.tsx`
 * highlights a menu row with, the token `chrome/hover.ts`'s `hoverFill` washes the title bar
 * and footer with, and the token the repo picker paints a selected row with — so "the pointer
 * is over this" means the same thing, and paints the same colour, in Settings as it does
 * everywhere else in the chrome. A theme change moves all of them together.
 */
export const SETTINGS_HOVER_FILL = tokens.selectionFill;

/**
 * Pointer-over state, the way `ContextMenu.tsx` holds it.
 *
 * AppKit gives every `.bordered` button, every `List` row and every colour well a hover
 * response for free; a `<button>` in a browser gets one only if something writes it, and the
 * global reset in `styles.css` strips even the user-agent default. So every interactive thing
 * on a Settings tab runs through this hook and paints `SETTINGS_HOVER_FILL` — the rail's tabs,
 * the buttons, the swatches, the key-chip ✕, and the preset / repo / favourite rows.
 *
 * React state rather than a `hover:` class because the fill is a THEME TOKEN: a Tailwind
 * variant cannot read `var(--kelpi-selection-fill)` without a stylesheet rule per surface, and
 * the token is the whole point. `data-hovered` rides along so a test (and the audit harness)
 * can read the state without resolving a colour, exactly as `data-highlighted` does on a menu
 * row.
 *
 * `enabled: false` (a disabled control) reports `hovered: false` — a dimmed row that still lit
 * up would be telling the user it can be clicked.
 *
 * Sibling to `chrome/hover.ts`'s `useHoverKey`, which holds ONE slot per surface because the
 * title bar and footer render their controls inline. Settings' controls are already components,
 * so a hook per control is available and is the simpler shape; the FILL is the same token, which
 * is the half that has to agree.
 *
 * **`resyncKey` — for a list whose rows MOVE (§N33).** `onMouseEnter`/`onMouseLeave` are the only
 * inputs, and they are not enough for a control that can slide out from under a stationary
 * pointer: the reorder measurements caught a preset row keeping `over === true` for good, because
 * the row was moved in the tree and the `mouseleave` that would have cleared it went to a node
 * Chromium had already detached. The result is a second, ghost wash on a row nobody is pointing
 * at, which outlives the gesture. So a caller whose controls move may pass a key that changes
 * whenever they do, and attach `hoverRef` to the same element `hoverProps` goes on: the state is
 * then re-read from the live `:hover`, which is the browser's own answer to "is the pointer over
 * this", rather than from an event that never arrived. Callers that pass nothing (every other
 * Settings surface) are byte-identical to before — no ref, no effect, no behaviour change.
 */
export function useHover(
    enabled = true,
    resyncKey?: unknown
): {
    readonly hovered: boolean;
    readonly hoverProps: {
        readonly onMouseEnter: () => void;
        readonly onMouseLeave: () => void;
        readonly 'data-hovered': 'true' | 'false';
    };
    readonly hoverRef: (node: HTMLElement | null) => void;
} {
    const [over, setOver] = useState(false);
    const node = useRef<HTMLElement | null>(null);
    const hoverRef = useCallback((element: HTMLElement | null) => {
        node.current = element;
    }, []);
    useLayoutEffect(() => {
        if (resyncKey === undefined) return;
        const element = node.current;
        if (element === null || typeof element.matches !== 'function') return;
        try {
            // `:hover` is live and hierarchical: a row matches while the pointer is anywhere
            // inside it, a button only while it is directly over it — which is exactly what each
            // of them paints. Guarded because a DOM implementation may reject the pseudo-class.
            setOver(element.matches(':hover'));
        } catch {
            /* a DOM that cannot answer keeps whatever the events last said */
        }
    }, [resyncKey]);
    const hovered = over && enabled;
    return {
        hovered,
        hoverRef,
        hoverProps: {
            onMouseEnter: () => {
                setOver(true);
            },
            onMouseLeave: () => {
                setOver(false);
            },
            'data-hovered': hovered ? 'true' : 'false'
        }
    };
}

/** `base` normally, the hover fill while the pointer is over — the recipe in one call. */
export function hoverBackground(hovered: boolean, base: string): string {
    return hovered ? SETTINGS_HOVER_FILL : base;
}

export interface SettingsSectionProps {
    readonly title: string;
    readonly hint?: string | undefined;
    readonly children: ReactNode;
    readonly testID?: string | undefined;
    /**
     * **This section is a heading over a LIST, not a grouped-form section** — so it draws no card
     * and bands nothing.
     *
     * Four of the eight tabs are not `Form`s in the shipped app: `RepoRegistryView.swift:12-55`,
     * `LabelPresetsSettingsView.swift:27-45`, `ProfilesSettingsView.swift` and
     * `SettingsView.swift:707-741` are each a `VStack` around a toolbar and a `List`, with no
     * `Section` and therefore no card anywhere on the tab. Their children here already carry
     * their own row chrome (`.listStyle(.inset)`'s stripes, the Labels add row's accent tint,
     * an explicit `Divider()`), so banding them would draw a second, contradictory grouping over
     * the first — which is L79's own defect pointing the other way.
     */
    readonly plain?: boolean | undefined;
    /**
     * The section's list is EMPTY and the placeholder is all there is (plain sections only).
     *
     * Two things follow. The section grows to take the tab's remaining height, handing it on
     * to its children, which is what lets the placeholder centre in the SPACE THE TAB ACTUALLY
     * HAS rather than in a fixed-height band near the top: the tab root asks for `min-h-full`,
     * the section asks for `empty`, and the placeholder's own `flex-1` + `justify-center` does
     * the rest. And the hint under it CENTRES: with the placeholder centred top to bottom, a
     * caption left-aligned at the foot of the tab was the one line out of step, and the owner
     * asked for it to line up (the shipped app has no caption under either empty list at all -
     * `SettingsView.swift:709-720`, `LabelPresetsSettingsView.swift:85-98` - so the alignment is
     * this port's to decide). Callers pass it only while the section is empty, so a populated
     * list still reads top-down with its caption left-aligned under the rows.
     */
    readonly empty?: boolean | undefined;
    /**
     * The whole section centres - heading, children, hint - because it stands under a centred
     * empty state and is the only other thing on the tab (the Labels tab's "not defined here"
     * section while the list is empty). A heading row that carries an `action` stays a toolbar,
     * title left and action right; no caller does both. Off by default: a section with rows
     * reads top-down, left-aligned, as every grouped form does.
     */
    readonly centred?: boolean | undefined;
    /**
     * §N36(1) — a control on the header's TRAILING edge, level with the title.
     *
     * Owner-directed, and it had no in-app precedent to inherit: the one header-trailing action
     * this port ever drew was the Keybindings tab's "Reset All to Defaults", and §M44 took it OUT
     * of a header row and put it back in the footer strip the shipped app has
     * (`KeybindingsSettingsView.swift:61-72`). So the anchor is §L79's own section recipe — the
     * heading row is the section's toolbar — rather than a shape copied from another tab.
     *
     * It lives on the SECTION rather than being hand-rolled in the tab for the reason L79 states
     * about the heading itself: two header recipes inside one window is what the uppercase
     * micro-label already looked like. A section with no `action` renders exactly the markup it
     * rendered before — the row is only introduced when there is something to put in it.
     */
    readonly action?: ReactNode;
}

/**
 * The **card** a `.formStyle(.grouped)` section draws, and the padding of the rows inside it.
 *
 * `SETTINGS_CARD_FILL` is the tone the port had been painting on every ROW; L79 is that it belongs
 * to the SECTION. `SETTINGS_ROW_PADDING` is a measurement the Swift source cannot give — AppKit
 * owns a grouped row's insets — so it is the shipped look read off the dialog at 10 × 6, and named
 * here rather than repeated as a class per control.
 */
export const SETTINGS_CARD_FILL = withAlpha('#808080', 0.06);
const SETTINGS_ROW_PADDING = '6px 10px';

/**
 * A section's title: **sentence case at the body size** (L79).
 *
 * `Section("Worktrees")` in a grouped `Form`, and `Section("Global")` in the Keybindings `List`,
 * are both drawn by AppKit in the standard control font — the port's `11px uppercase
 * tracking-wide` tertiary micro-label is a shape the shipped window has nowhere. Exported so the
 * Keybindings tab's own category headings (`KeybindingsTab.tsx`, which builds its table rather
 * than using `SettingsSection`) cannot drift from it: two heading recipes inside one tab is what
 * the uppercase label already looked like against the Global section above it.
 */
export const SETTINGS_SECTION_HEADING = 'text-[13px] font-semibold';

/**
 * A `Section("…") { … }` from `SettingsView.swift`'s grouped `Form`.
 *
 * **One card per SECTION, with hairline separators between its rows** (L79). `SettingsView.swift:128`
 * and `:278` are `Form { Section("Worktrees") { … } … }.formStyle(.grouped)`, and macOS draws that
 * as a single rounded card per section: rows stacked flush, a hairline between each pair, and the
 * section's name in sentence case at the body size ABOVE the card. The port had inverted it — the
 * 6 % fill was on every individual row, so a section read as a stack of pills rather than as one
 * group, and the header was an 11 px uppercase tertiary label of a kind the shipped window has
 * nowhere. The fill, the separators and the row padding now live here, which is what makes every
 * tab inherit the same grouping instead of restating it.
 *
 * The children are wrapped one per row rather than being asked to pad themselves: a section's
 * children are rows by definition, and a padding class repeated across `controls.tsx`, six tabs
 * and the odd `<p>` is a rule that drifts. `Children.toArray` drops the `null`s a conditional row
 * renders, so a hidden row leaves no empty band and no stray hairline behind it.
 *
 * **The caption is LAST** (M46). Every Swift section that carries explanatory copy carries it as
 * the section's closing `Text(…).font(.caption).foregroundStyle(.secondary)` — read the
 * Worktrees section at `SettingsView.swift:129-137`: the `HStack { Text("Base path"); TextField }`
 * comes first and the paragraph explaining `<repo>` substitution comes after it. It sits OUTSIDE
 * the card, where the grouped form puts it.
 */
export function SettingsSection(props: SettingsSectionProps): ReactElement {
    const rows = Children.toArray(props.children);
    const empty = props.empty === true;
    const centred = props.centred === true;
    // The hint centres under a centred placeholder (`empty`) or as part of a centred section.
    const hintClass = empty || centred ? 'text-center text-[11px]' : 'text-[11px]';
    return (
        <section
            className={empty ? 'flex min-h-0 flex-1 flex-col gap-1.5' : 'flex flex-col gap-1.5'}
            {...(props.testID === undefined ? {} : { 'data-testid': props.testID })}
        >
            {props.action === undefined ? (
                <h3
                    className={centred ? `${SETTINGS_SECTION_HEADING} text-center` : SETTINGS_SECTION_HEADING}
                    style={{ color: tokens.textPrimary }}
                >
                    {props.title}
                </h3>
            ) : (
                // §N36(1): title left, action right, on ONE line. `min-h` is the button's own
                // height, so a section with an action and one without do not sit at different
                // heights when they are stacked on the same tab.
                <div className="flex min-h-[24px] items-center justify-between gap-3">
                    <h3 className={SETTINGS_SECTION_HEADING} style={{ color: tokens.textPrimary }}>
                        {props.title}
                    </h3>
                    <div data-settings-section-action="true" className="flex shrink-0 items-center gap-2">
                        {props.action}
                    </div>
                </div>
            )}
            {props.plain === true ? (
                <div
                    className={
                        empty
                            ? 'flex min-h-0 flex-1 flex-col gap-2'
                            : centred
                              ? 'flex flex-col items-center gap-2'
                              : 'flex flex-col gap-2'
                    }
                >
                    {props.children}
                </div>
            ) : (
                <div
                    data-settings-card="true"
                    {...(props.testID === undefined ? {} : { 'data-testid': `${props.testID}-card` })}
                    className="flex flex-col overflow-hidden rounded-md"
                    style={{ background: SETTINGS_CARD_FILL }}
                >
                    {rows.map((row, index) => (
                        // eslint-disable-next-line react/no-array-index-key -- a section's rows are
                        // a fixed list in source order; there is nothing else to key them by.
                        <div
                            key={index}
                            data-settings-row="true"
                            className="flex flex-col"
                            style={{
                                padding: SETTINGS_ROW_PADDING,
                                ...(index === 0 ? {} : { borderTop: `1px solid ${tokens.divider}` })
                            }}
                        >
                            {row}
                        </div>
                    ))}
                </div>
            )}
            {props.hint === undefined ? null : (
                <p className={hintClass} style={{ color: tokens.textTertiary }}>
                    {props.hint}
                </p>
            )}
        </section>
    );
}

export interface SettingsRowProps {
    readonly label: string;
    readonly detail?: ReactNode;
    readonly children?: ReactNode;
    readonly testID?: string | undefined;
    /**
     * A glyph before the label, for the rows the Swift builds with `Label(_:systemImage:)`
     * rather than a bare `Text` (M51's six system-stat rows,
     * `SettingsView.swift:444-447`).
     */
    readonly icon?: ReactNode;
}

/**
 * Label on the left, control on the right, and the explanatory copy on its OWN ROW under both.
 *
 * That last clause is M46 and it is the shape the shipped app has: a grouped `Form` section is a
 * vertical stack of rows, and a caption is a row of its own —
 * `SettingsView.swift:141-148` is `Toggle(…)` followed by
 * `Text(…).font(.caption).foregroundStyle(.secondary)` as the next child of the same `Section`,
 * spanning the section's full width. The port had folded it into the label column beside the
 * control, which cost the copy ~40% of the row and floated the control level with its first line.
 *
 * Deliberately NOT hover-lit: this is a `.formStyle(.grouped)` row, and a grouped form row in
 * AppKit does not highlight either — only the CONTROL inside it responds. The hover recipe
 * belongs to the things you can click (H11's list: buttons, swatches, rail tabs, list rows).
 *
 * It carries no fill and no padding of its own (L79): a grouped row is a band INSIDE its
 * section's card, and `SettingsSection` is what pads it and rules a hairline above it.
 */
export function SettingsRow(props: SettingsRowProps): ReactElement {
    return (
        <div
            className="flex flex-col gap-1"
            {...(props.testID === undefined ? {} : { 'data-testid': props.testID })}
        >
            <div className="flex items-center justify-between gap-4">
                <span className="flex min-w-0 items-center gap-1.5 text-[12px]" style={{ color: tokens.textPrimary }}>
                    {props.icon === undefined ? null : (
                        <span aria-hidden className="flex shrink-0 items-center" style={{ color: tokens.textSecondary }}>
                            {props.icon}
                        </span>
                    )}
                    {props.label}
                </span>
                <div className="flex shrink-0 items-center gap-2">{props.children}</div>
            </div>
            {props.detail === undefined ? null : (
                <span className="text-[11px]" style={{ color: tokens.textTertiary }}>
                    {props.detail}
                </span>
            )}
        </div>
    );
}

/**
 * The full-width caption row a `Form` field carries under it (M46), for the controls in
 * `controls.tsx` that lay their own first line out.
 */
export function SettingsDetail(props: { readonly children: ReactNode }): ReactElement {
    return (
        <span className="text-[11px]" style={{ color: tokens.textTertiary }}>
            {props.children}
        </span>
    );
}

export type SettingsButtonTone = 'default' | 'accent' | 'danger';

export interface SettingsButtonProps {
    readonly children: ReactNode;
    readonly onClick: () => void;
    readonly disabled?: boolean | undefined;
    readonly tone?: SettingsButtonTone | undefined;
    readonly title?: string | undefined;
    readonly testID?: string | undefined;
    readonly ariaLabel?: string | undefined;
    /**
     * A handle on the underlying element, for the one thing a parent genuinely cannot express
     * declaratively: moving focus here after a sibling control removes itself from the DOM
     * (`GlobalHotkeySection`'s ✕, which unmounts along with the chip it clears).
     */
    readonly buttonRef?: Ref<HTMLButtonElement> | undefined;
    /**
     * A floor under the button's width, for a label that CHANGES (L90's Record → "Press a key…" →
     * the captured chord). Without it the control resizes under the pointer and every sibling
     * after it slides.
     */
    readonly minWidth?: number | undefined;
}

const TONE_COLOR: Readonly<Record<SettingsButtonTone, string>> = {
    default: tokens.textSecondary,
    accent: tokens.accent,
    danger: '#E0685F'
};

export function SettingsButton(props: SettingsButtonProps): ReactElement {
    const tone = props.tone ?? 'default';
    const disabled = props.disabled === true;
    // H11: a `.buttonStyle(.bordered)` button gets its hover and press response from AppKit for
    // free; this one has to draw it. Fill on hover, and lift the border to the selection stroke
    // so the outline moves with it — the text colour is untouched so a `danger` button keeps
    // the red that is the only thing marking it destructive.
    //
    // **No `cursor`** (L89). macOS never swaps the arrow for a hand over a control — the pointer
    // is a link affordance on the web and nothing else — and `styles.css`'s `button { cursor:
    // default }` already says so for the whole app. An inline `cursor: pointer` here beat that
    // rule and made the bordered buttons the one hand in a window of arrows; the hover FILL is
    // the "this is clickable" signal, which is the signal the shipped app gives.
    const { hovered, hoverProps } = useHover(!disabled);
    // `whitespace-nowrap`: a button label is a name, not prose. "Reset All to Defaults" wrapped
    // onto two lines in the Keybindings header (run-B's nit list), which reads as a paragraph
    // rather than a control; the copy beside it wraps instead.
    return (
        <button
            ref={props.buttonRef ?? null}
            type="button"
            disabled={disabled}
            title={props.title ?? undefined}
            aria-label={props.ariaLabel ?? undefined}
            {...hoverProps}
            {...(props.testID === undefined ? {} : { 'data-testid': props.testID })}
            className="whitespace-nowrap rounded border px-2 py-1 text-center text-[11px] transition-colors duration-100 disabled:opacity-40"
            style={{
                borderColor: hovered ? tokens.selectionStroke : tokens.divider,
                color: TONE_COLOR[tone],
                background: hoverBackground(hovered, 'transparent'),
                ...(props.minWidth === undefined ? {} : { minWidth: `${String(props.minWidth)}px` })
            }}
            onClick={props.onClick}
        >
            {props.children}
        </button>
    );
}

export interface IconButtonProps {
    readonly children: ReactNode;
    /**
     * The click event is passed through so a caller can tell a MOUSE press from a keyboard one
     * (`event.detail === 0`) and read where the pointer was — which is what §N33's parked
     * highlight needs, and what nothing else in Settings looks at. Widening the signature is
     * source-compatible: every existing `() => void` handler still satisfies it.
     */
    readonly onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
    readonly ariaLabel: string;
    readonly title?: string | undefined;
    readonly testID?: string | undefined;
    readonly disabled?: boolean | undefined;
    readonly tone?: SettingsButtonTone | undefined;
    readonly buttonRef?: Ref<HTMLButtonElement> | undefined;
    /**
     * §N33 — paint the highlight from the CALLER rather than from this button's own pointer
     * state, for the one case where the pointer's state is a lie: a list that re-orders under a
     * stationary cursor. Chromium re-evaluates `:hover` after the DOM moves, so the row that
     * slid under the pointer lights up and the row the user actually moved goes dark, with no
     * input at all. `undefined` (the default, and every other caller) keeps the button's own
     * hover state; `true`/`false` overrides it, including the `data-hovered` an instrument reads.
     */
    readonly highlight?: boolean | undefined;
    /**
     * §N33 — pass a value that changes whenever this button MOVES in the tree, and its hover
     * state is re-read from the live `:hover` on that commit instead of waiting for a
     * `mouseleave` the browser will never send. See `useHover`.
     */
    readonly hoverEpoch?: unknown;
}

/**
 * A `.buttonStyle(.plain)` glyph button at a real 20 px target that OCCUPIES 16 px.
 *
 * The Swift plain buttons this stands in for (the trigger chip's `xmark.circle.fill`, the label
 * row's `trash`) are glyphs with no chrome until the pointer arrives. So is this: transparent
 * at rest, `SETTINGS_HOVER_FILL` in a rounded box under the pointer, and a hit box that is a
 * square rather than the glyph's own ink.
 *
 * SPACING-REVIEW S50 (OWNER-DIRECTED) — `h-5 w-5` with a `-m-0.5` bleed, where §M43 settled on
 * `h-4 w-4`. The negative margin is the whole trick: it hands the extra 4 px back to the layout,
 * so every consumer's margin box is still 16 × 16 and the glyph inside stays centred on exactly
 * the pixel it was on. Measured live across all three consumers — `keybinding-remove-*` (×27 on
 * the default map), `label-move-up/down-*` (4 px apart in a 44 px column) and `label-delete-*`:
 * hit box 15.5 × 15.5 → 19.5 × 19.5, glyph rects byte-identical, and 148 060 px of the
 * keybindings row plus 477 040 px of the Labels tab pixel-identical at rest.
 *
 * Two consequences, both stated rather than discovered later:
 *
 *   · the arrows' 4 px gap is now exactly spent by the two 2 px bleeds, so the up/down hit boxes
 *     ABUT. They do not overlap — 4 px is the most the gap admits — so there is no strip where
 *     one arrow silently fires the other;
 *   · the hover wash is drawn on the border box, so it grows 16 → 20 px WITH the target. That is
 *     the one thing about this that is visible, and only under the pointer. It is deliberate: a
 *     16 px wash on a 20 px target would leave 2 px of live button that gives no feedback.
 *
 * Owner-directed: do not re-report. The parity value is `h-4 w-4` with no margin.
 */
export function SettingsIconButton(props: IconButtonProps): ReactElement {
    const disabled = props.disabled === true;
    const { hovered, hoverProps, hoverRef } = useHover(!disabled, props.hoverEpoch);
    const lit = (props.highlight ?? hovered) && !disabled;
    // Two refs on one node: the caller's (§N33's arrow map) and the hook's resync handle.
    const buttonRef = props.buttonRef;
    const setRef = useCallback(
        (node: HTMLButtonElement | null) => {
            hoverRef(node);
            if (typeof buttonRef === 'function') buttonRef(node);
            else if (buttonRef !== null && buttonRef !== undefined) buttonRef.current = node;
        },
        [hoverRef, buttonRef]
    );
    return (
        <button
            ref={setRef}
            type="button"
            disabled={disabled}
            aria-label={props.ariaLabel}
            title={props.title ?? props.ariaLabel}
            {...hoverProps}
            {...(props.testID === undefined ? {} : { 'data-testid': props.testID })}
            // After the spread, so an overridden highlight is what a test and the audit read.
            data-hovered={lit ? 'true' : 'false'}
            className="-m-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] leading-none transition-colors duration-100 disabled:opacity-40"
            style={{
                color: lit ? tokens.textPrimary : TONE_COLOR[props.tone ?? 'default'],
                background: hoverBackground(lit, 'transparent')
            }}
            onClick={props.onClick}
        >
            {props.children}
        </button>
    );
}

export interface ToggleProps {
    readonly checked: boolean;
    readonly onChange: (next: boolean) => void;
    readonly label: string;
    readonly testID?: string | undefined;
    /**
     * A toggle whose value would mean nothing (SET-082's "Press again to hide" with no hotkey
     * set). Disabled rather than hidden: the option still exists, it just has no subject yet.
     */
    readonly disabled?: boolean | undefined;
}

/**
 * The macOS switch metrics at the **regular** control size: a 38×22 track with an 18 px thumb.
 *
 * S24 — this comment used to name `.controlSize(.small)` (a 26×15 track), and the Swift never
 * sets one: `grep -rn controlSize SettingsView.swift` returns nothing, so every one of these
 * rows (`SettingsView.swift:141, 151, 159, 189, 199, 226, 236, 435, 440-441`) is a plain
 * `Toggle` inside `.formStyle(.grouped)` — AppKit's regular-size switch. At 26×15 the port
 * shipped a 15 px hit target on 19 rows: the shortest interactive control in Settings after the
 * colour wells, and 10 px shorter than the `<select>` stacked directly under it in the same card.
 */
const SWITCH = { width: 38, height: 22, thumb: 18, inset: 2 } as const;

/**
 * A macOS **switch**, not a checkbox (H14).
 *
 * Every one of these rows is a SwiftUI `Toggle` inside `.formStyle(.grouped)`, and macOS draws
 * that as a trailing-edge switch — a filled track with a sliding thumb. The port shipped a bare
 * `<input type="checkbox" role="switch">` with only `accentColor` set, so the user agent drew a
 * square tick box: `role="switch"` had fixed the accessible NAME and nothing else, and ~20 rows
 * read as checkboxes against chrome that mimics macOS everywhere else.
 *
 * The input is still the whole control — `appearance: none` turns it into the TRACK, so it
 * keeps its own hit box, its focus ring and the native checked semantics, and every test that
 * clicks it by test id or queries it by `role="switch"` is untouched. The thumb is an
 * `aria-hidden` sibling positioned over it; both the track colour and the thumb's offset are
 * transitioned, which is the animation the real control has. No dependency: this is two inline
 * styles and a `left`.
 */
export function SettingsToggle(props: ToggleProps): ReactElement {
    const disabled = props.disabled === true;
    const { hovered, hoverProps } = useHover(!disabled);
    const track = props.checked
        ? tokens.accent
        : withAlpha('#808080', hovered ? 0.5 : 0.34);
    return (
        <span
            className="relative inline-flex shrink-0 items-center"
            style={{
                width: `${String(SWITCH.width)}px`,
                height: `${String(SWITCH.height)}px`,
                ...(disabled ? { opacity: 0.4 } : {})
            }}
            {...hoverProps}
        >
            <input
                type="checkbox"
                role="switch"
                aria-label={props.label}
                checked={props.checked}
                disabled={disabled}
                className="m-0 block rounded-full"
                style={{
                    appearance: 'none',
                    WebkitAppearance: 'none',
                    width: `${String(SWITCH.width)}px`,
                    height: `${String(SWITCH.height)}px`,
                    background: track,
                    border: `1px solid ${props.checked ? tokens.accent : withAlpha('#808080', 0.55)}`,
                    transition: 'background-color 160ms ease, border-color 160ms ease',
                    // L89: the arrow, like every other control in the window.
                    cursor: 'default'
                }}
                {...(props.testID === undefined ? {} : { 'data-testid': props.testID })}
                onChange={(event) => {
                    props.onChange(event.target.checked);
                }}
            />
            <span
                aria-hidden
                data-testid={props.testID === undefined ? undefined : `${props.testID}-thumb`}
                className="pointer-events-none absolute rounded-full"
                style={{
                    width: `${String(SWITCH.thumb)}px`,
                    height: `${String(SWITCH.thumb)}px`,
                    top: `${String(SWITCH.inset)}px`,
                    left: props.checked
                        ? `${String(SWITCH.width - SWITCH.thumb - SWITCH.inset)}px`
                        : `${String(SWITCH.inset)}px`,
                    background: '#FFFFFF',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.35)',
                    transition: 'left 160ms ease'
                }}
            />
        </span>
    );
}

export interface KeyChipProps {
    readonly children: ReactNode;
    readonly style?: CSSProperties | undefined;
}

/** The value read-out face — a `123 ms` / `dark` chip, where monospaced digits are the point. */
export function KeyChip(props: KeyChipProps): ReactElement {
    return (
        <span
            className="rounded px-1.5 py-0.5 font-mono text-[11px]"
            style={{
                background: withAlpha('#808080', 0.16),
                color: tokens.textPrimary,
                ...(props.style ?? {})
            }}
        >
            {props.children}
        </span>
    );
}

/**
 * The **SF Rounded** face `ui-rounded` names, with the stack a Chromium build falls back through.
 *
 * `ui-rounded` is the CSS Fonts 4 generic for exactly `.font(.system(…, design: .rounded))`;
 * WebKit resolves it, Chromium does not, so the named face follows it and `system-ui` catches
 * anything that has neither. No dependency and no web font: the family is on the machine.
 */
export const ROUNDED_UI_FONT =
    'ui-rounded, "SF Pro Rounded", -apple-system, BlinkMacSystemFont, system-ui, sans-serif';

/**
 * A key TRIGGER chip — `⌥⌘→` on the Keybindings table and the Global hotkey row (M42).
 *
 * `KeybindingsSettingsView.swift:112-120` (and `:161-169`, the identical per-row chip) draws the
 * chord as `Text(trigger.displayString).font(.system(.body, design: .rounded))` on a
 * `RoundedRectangle(cornerRadius: 4).fill(.quaternary)`. The fill, the radius and both paddings
 * were already right here; the TYPE was not — 11 px monospace, two points down and a different
 * family, on the one surface whose whole job is reading a chord at a glance.
 *
 * The `.quaternary` MATERIAL is not reproducible (it is `NSVisualEffectView` vibrancy, ledgered
 * as a class), so the flat 16% gray stands in for it unchanged.
 */
export function TriggerChip(props: KeyChipProps): ReactElement {
    return (
        <span
            data-chip="trigger"
            className="rounded px-1.5 py-0.5"
            style={{
                background: withAlpha('#808080', 0.16),
                color: tokens.textPrimary,
                fontFamily: ROUNDED_UI_FONT,
                fontSize: '13px',
                ...(props.style ?? {})
            }}
        >
            {props.children}
        </span>
    );
}

/**
 * `Image(systemName: "xmark.circle.fill")` — the remove-trigger / clear-hotkey glyph (M43).
 *
 * A filled disc with the ✕ knocked out of it, which is what makes the control read as a REMOVE
 * button rather than as a stray character sitting between two chips. Hand-rolled on the same
 * 12×12 grid `chrome/icons.tsx` uses (SF Symbols → hand-rolled SVG is the ledgered class); the
 * 16 px hit target and the hover fill are `SettingsIconButton`'s.
 */
export function XmarkCircleFillGlyph(props: { readonly size?: number | undefined }): ReactElement {
    const size = props.size ?? 12;
    return (
        <svg aria-hidden viewBox="0 0 12 12" width={size} height={size} fill="none">
            <circle cx="6" cy="6" r="4.6" fill="currentColor" />
            <path
                d="M4.4 4.4 7.6 7.6M7.6 4.4 4.4 7.6"
                stroke={tokens.surfaceBackground}
                strokeWidth="1.3"
                strokeLinecap="round"
            />
        </svg>
    );
}

export interface SettingsEmptyStateProps {
    /** The large glyph, already sized by the caller (the Swift sizes differ per tab). */
    readonly glyph: ReactNode;
    readonly title: string;
    readonly detail?: ReactNode;
    readonly children?: ReactNode;
    readonly testID?: string | undefined;
    /** `.quaternary` for the repo registry, `.tertiary` for the other three. */
    readonly glyphTone?: 'tertiary' | 'quaternary' | undefined;
    /**
     * L92: the Profiles placeholder — and only that one — sets its title `.font(.headline)`
     * (`ProfilesSettingsView.swift:128`), which is the body size SEMIBOLD in the primary label
     * colour. The other three (`RepoRegistryView.swift:36`, `LabelPresetsSettingsView.swift:86`,
     * `SettingsView.swift:713`) are a plain `Text` in `.secondary`, which is the default here.
     */
    readonly headline?: boolean | undefined;
}

/**
 * The four Settings empty states (M45).
 *
 * `RepoRegistryView.swift:33-35`, `LabelPresetsSettingsView.swift:85-87`,
 * `ProfilesSettingsView.swift:127-129` and `SettingsView.swift:710-712` are the same view four
 * times: a large glyph over a `.secondary` headline over a `.caption`/`.tertiary` explanation,
 * in a `VStack(spacing: 8)` (10 for Profiles) that CENTRES ITSELF IN THE WHOLE SPACE
 * (`.frame(maxWidth: .infinity, maxHeight: .infinity)`). The port had four different boxes, three
 * of them dashed-bordered cards and none of them carrying the glyph — Repositories and Profiles
 * had no glyph at all, Labels had an inline `🏷` at body size and Web an 18 px `☆`.
 *
 * No border: a `VStack` in a fill has no chrome of its own, and the dashed card was the port's
 * invention.
 */
export function SettingsEmptyState(props: SettingsEmptyStateProps): ReactElement {
    return (
        <div
            {...(props.testID === undefined ? {} : { 'data-testid': props.testID })}
            className="flex min-h-[180px] flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
        >
            <span
                aria-hidden
                data-testid={props.testID === undefined ? undefined : `${props.testID}-glyph`}
                className="flex items-center justify-center"
                style={{
                    // `.tertiary` / `.quaternary` are AppKit's two faintest label tones; the
                    // chrome palette stops at tertiary, so quaternary is that token at 60%.
                    color: tokens.textTertiary,
                    opacity: props.glyphTone === 'quaternary' ? 0.6 : 1
                }}
            >
                {props.glyph}
            </span>
            <span
                data-testid={props.testID === undefined ? undefined : `${props.testID}-title`}
                className={`text-[13px]${props.headline === true ? ' font-semibold' : ''}`}
                style={{ color: props.headline === true ? tokens.textPrimary : tokens.textSecondary }}
            >
                {props.title}
            </span>
            {props.detail === undefined ? null : (
                <span className="max-w-[360px] text-[11px]" style={{ color: tokens.textTertiary }}>
                    {props.detail}
                </span>
            )}
            {props.children}
        </div>
    );
}

/**
 * The "Config: ~/.config/nex/config" strip every file-backed tab ends with (§13.1).
 *
 * `centred` is for the tab whose only content above it is a centred empty placeholder: the
 * note then lines up with it rather than being the one left-aligned line at the foot of an
 * otherwise centred tab. A tab with rows keeps it left, under the list, as before.
 */
export function SettingsFooterNote(props: {
    readonly children: ReactNode;
    readonly centred?: boolean | undefined;
}): ReactElement {
    return (
        <p
            data-testid="settings-footer-note"
            className={props.centred === true ? 'pt-1 text-center text-[11px] leading-relaxed' : 'pt-1 text-[11px] leading-relaxed'}
            style={{ color: tokens.textTertiary }}
        >
            {props.children}
        </p>
    );
}
