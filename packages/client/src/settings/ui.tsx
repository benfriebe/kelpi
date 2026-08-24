/**
 * Shared Settings primitives.
 *
 * Deliberately tiny and local: the chrome package owns the app's surfaces, and Settings is a
 * different kind of surface (form controls, not direct manipulation). Everything below paints
 * with the same `--nex-*` tokens, so a chrome theme change moves this window too.
 */

import { useState, type CSSProperties, type ReactElement, type ReactNode, type Ref } from 'react';

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
 * variant cannot read `var(--nex-selection-fill)` without a stylesheet rule per surface, and
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
 */
export function useHover(enabled = true): {
    readonly hovered: boolean;
    readonly hoverProps: {
        readonly onMouseEnter: () => void;
        readonly onMouseLeave: () => void;
        readonly 'data-hovered': 'true' | 'false';
    };
} {
    const [over, setOver] = useState(false);
    const hovered = over && enabled;
    return {
        hovered,
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
}

/**
 * A `Section("…") { … }` from `SettingsView.swift`'s grouped `Form`.
 *
 * **The caption is LAST** (M46). Every Swift section that carries explanatory copy carries it as
 * the section's closing `Text(…).font(.caption).foregroundStyle(.secondary)` — read the
 * Worktrees section at `SettingsView.swift:129-137`: the `HStack { Text("Base path"); TextField }`
 * comes first and the paragraph explaining `<repo>` substitution comes after it. The port
 * rendered `hint` between the heading and the children, which turns a footnote into a preamble
 * and pushes the control the section is *about* below a paragraph.
 */
export function SettingsSection(props: SettingsSectionProps): ReactElement {
    return (
        <section className="flex flex-col gap-2" {...(props.testID === undefined ? {} : { 'data-testid': props.testID })}>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: tokens.textTertiary }}>
                {props.title}
            </h3>
            {props.children}
            {props.hint === undefined ? null : (
                <p className="text-[11px]" style={{ color: tokens.textTertiary }}>
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
 */
export function SettingsRow(props: SettingsRowProps): ReactElement {
    return (
        <div
            className="flex flex-col gap-1 rounded px-2 py-2"
            style={{ background: withAlpha('#808080', 0.06) }}
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
            className="whitespace-nowrap rounded border px-2 py-1 text-[11px] transition-colors duration-100 disabled:opacity-40"
            style={{
                borderColor: hovered ? tokens.selectionStroke : tokens.divider,
                color: TONE_COLOR[tone],
                background: hoverBackground(hovered, 'transparent'),
                cursor: disabled ? 'default' : 'pointer'
            }}
            onClick={props.onClick}
        >
            {props.children}
        </button>
    );
}

export interface IconButtonProps {
    readonly children: ReactNode;
    readonly onClick: () => void;
    readonly ariaLabel: string;
    readonly title?: string | undefined;
    readonly testID?: string | undefined;
    readonly disabled?: boolean | undefined;
    readonly tone?: SettingsButtonTone | undefined;
    readonly buttonRef?: Ref<HTMLButtonElement> | undefined;
}

/**
 * A `.buttonStyle(.plain)` glyph button at a real 16 px target.
 *
 * The Swift plain buttons this stands in for (the trigger chip's `xmark.circle.fill`, the label
 * row's `trash`) are glyphs with no chrome until the pointer arrives. So is this: transparent
 * at rest, `SETTINGS_HOVER_FILL` in a rounded box under the pointer, and a hit box that is a
 * square rather than the glyph's own ink.
 */
export function SettingsIconButton(props: IconButtonProps): ReactElement {
    const disabled = props.disabled === true;
    const { hovered, hoverProps } = useHover(!disabled);
    return (
        <button
            ref={props.buttonRef ?? null}
            type="button"
            disabled={disabled}
            aria-label={props.ariaLabel}
            title={props.title ?? props.ariaLabel}
            {...hoverProps}
            {...(props.testID === undefined ? {} : { 'data-testid': props.testID })}
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[11px] leading-none transition-colors duration-100 disabled:opacity-40"
            style={{
                color: hovered ? tokens.textPrimary : TONE_COLOR[props.tone ?? 'default'],
                background: hoverBackground(hovered, 'transparent'),
                cursor: disabled ? 'default' : 'pointer'
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

/** The macOS switch metrics at `.controlSize(.small)`: a 26×15 track with an 11 px thumb. */
const SWITCH = { width: 26, height: 15, thumb: 11, inset: 2 } as const;

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
                    cursor: disabled ? 'default' : 'pointer'
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
            <span className="text-[13px]" style={{ color: tokens.textSecondary }}>
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

/** The "Config: ~/.config/nex/config" strip every file-backed tab ends with (§13.1). */
export function SettingsFooterNote(props: { readonly children: ReactNode }): ReactElement {
    return (
        <p
            data-testid="settings-footer-note"
            className="pt-1 text-[11px] leading-relaxed"
            style={{ color: tokens.textTertiary }}
        >
            {props.children}
        </p>
    );
}
