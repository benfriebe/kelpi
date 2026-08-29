/**
 * §N38 (owner-directed, 2026-08-29) — the Labels row's colour controls, as ONE anchored flyover.
 *
 * The tab used to carry the whole colour model inline: ten swatches plus a `Custom…` well in a
 * 150 px track, and an Auto/Black/White `<select>` plus a second well in a 124 px track, in every
 * row. That is 274 px of controls per row spent on two values that are looked at far more often
 * than they are changed, and it left the NAME — the thing every row is actually identified by —
 * on a 160 px floor that clipped `New label` at the default window (§N36(4)'s residual, closed
 * by measurement rather than by design).
 *
 * The owner's mockup replaces both tracks with a single swatch TRIGGER per row that opens this
 * popover. One popover serves both values:
 *
 *   · a chip preview of the label at the top, drawn with the row's CURRENT choices, and a close ×;
 *   · a **Background** section — the ten named swatches in a grid, plus a bordered `✎ Custom` row;
 *   · a **Text** section — Auto / Black / White, plus a `Custom` row showing the current swatch
 *     and its hex;
 *   · and, from either `Custom`, a **custom view**: a saturation/value gradient square with a
 *     circular cursor, a hue slider beneath it, and a `✎` + hex input row.
 *
 * **The data model does not change.** This is an EDITOR over the same two stored values a row
 * always held — `{kind:'named'|'custom'}` for the background and that-or-`null` (Auto, the
 * luminance rule) for the text — written through the same `updateLabelPreset` verb, on the same
 * daemon round trip. Nothing here knows what a preset is beyond those two fields.
 *
 * ── the campaign's laws, applied ────────────────────────────────────────────────────
 *
 * **§N26 — it enrols in modal presence, by RECT.** A web pane's page is a native
 * `WebContentsView` the shell composites over this document, so a popover that does not register
 * where it is gets sliced by the page. `useOverlayPresence` is the same call `ContextMenu`,
 * `SystemStatGauge` and the footer's bucket popover make, and it registers the union of this
 * panel and everything inside it — so the panes it covers park and the panes beside it do not.
 * (Settings is a whole-window modal today, so every page is already parked while this is up;
 * the registration is what keeps that true if the overlay ever stops owning the window, and it
 * is what the N26 census reads.)
 *
 * **§N33 — focus discipline.** The popover opens FROM the trigger and hands focus back TO it:
 * Escape, the ×, and an outside click all return the caret to the swatch that opened it, so a
 * keyboard user is never dropped at the top of the dialog. Inside, Tab cycles (the popover is a
 * trap, like the dialog that hosts it), the swatch grid walks with the arrows, and the picker's
 * two controls nudge with them. What this deliberately does NOT touch is the reorder-intent
 * arbiter: opening the popover moves focus to a non-arrow element, which is exactly the signal
 * §N33's `focusin` listener already reads as "the user has moved on", so a live reorder intent
 * dies at the source rather than through a second rule written here.
 *
 * **The picker is hand-rolled and has no dependencies.** CSS gradients for the two surfaces,
 * pointer capture for the drags, and `hsvFromHex`/`hexFromHsv` below for the arithmetic. The
 * round trip is exact: `hexFromHsv(hsvFromHex(x)) === x` for every 6-digit hex (the hue is
 * derived from the same difference the reconstruction divides by), and — the stronger guarantee —
 * merely OPENING the custom view writes nothing at all, so a stored value survives being looked
 * at byte for byte.
 *
 * **§S50 — the hit-target discipline moves in with the swatches.** Every swatch paints a 16 px
 * disc and hit-tests as a 20 px square, through the same transparent inset overlay the row's
 * palette used; the gap between them is 8 px, so neighbouring targets stay 4 px apart rather
 * than abutting.
 *
 * **§N32 — the mint flow is untouched.** A minted row is an ordinary row: its trigger opens this
 * popover exactly like any other, and the mint's own focus handoff (to the name field) is not
 * competed with, because nothing here takes focus until the trigger is pressed.
 *
 * One affordance the mockup does not draw and the popover cannot do without: a way BACK from the
 * custom view. It is the `‹` at the header's leading edge — the same place a navigation stack
 * puts one — and it is the only control here with no counterpart in the two frames.
 */

import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
    type PointerEvent as ReactPointerEvent,
    type ReactElement,
    type RefObject
} from 'react';
import { createPortal } from 'react-dom';

import { useDismissable } from '../chrome/dismissable';
import { useOverlayPresence } from '../chrome/modal-presence';
import {
    WORKSPACE_COLORS,
    normalizeHexColor,
    parseHexColor,
    resolveLabelStyle,
    tokens,
    withAlpha,
    workspaceColorHex,
    type ChromeBucket,
    type ChromeLabelPreset,
    type ResolvedLabelStyle
} from '../chrome';
import { hoverBackground, useHover } from './ui';

/** Five per row, so the ten named colours are two tidy rows (the mockup's grid). */
const PALETTE_COLUMNS = 5;

// ── the colour model, unchanged (§6.2) ──────────────────────────────────────────────

/** A preset's colour, in whichever of §6.2's two shapes it is stored as. */
export type LabelColorValue = ChromeLabelPreset['color'];
/** A preset's text colour: a colour, or `null` for AUTO (the luminance rule). */
export type LabelTextColorValue = LabelColorValue | null;

export const BLACK = '#000000';
export const WHITE = '#ffffff';

/** §6.2's one-string encoding — what `update-label-preset` carries on the wire. */
export function tokenOf(color: LabelColorValue): string {
    return color.kind === 'named' ? color.color : color.hex;
}

/** The wire token for a text colour: a colour, or the literal `null` for the luminance rule. */
export function textToken(color: LabelTextColorValue): string | null {
    return color === null ? null : tokenOf(color);
}

/** A concrete hex for any colour value, so a swatch and a chip can both paint it. */
export function hexOf(color: LabelColorValue, bucket: ChromeBucket): string {
    if (color.kind === 'custom') return normalizeHexColor(color.hex) ?? '#808080';
    return workspaceColorHex(color.color, bucket);
}

/** Which of the Auto / Black / White triple a text colour is (anything else is Custom). */
export function textMode(color: LabelTextColorValue): 'auto' | 'black' | 'white' | 'custom' {
    if (color === null) return 'auto';
    if (color.kind === 'named') return 'custom';
    const hex = normalizeHexColor(color.hex)?.toLowerCase() ?? '';
    if (hex === BLACK) return 'black';
    if (hex === WHITE) return 'white';
    return 'custom';
}

/** What each mode writes back. `custom` is the picker's business, not this table's. */
export const TEXT_MODE_VALUE: Readonly<Record<'auto' | 'black' | 'white', LabelTextColorValue>> = {
    auto: null,
    black: { kind: 'custom', hex: BLACK },
    white: { kind: 'custom', hex: WHITE }
};

/**
 * The colours a chip WOULD have for a pair of values.
 *
 * Routed through the shared `resolveLabelStyle` rather than reimplementing the contrast rule:
 * this preview and a rendered sidebar chip must agree, and the only way to guarantee that is to
 * ask the same function. A one-entry synthetic preset list is how a value that is not (yet) a
 * stored preset asks it.
 */
export function labelPreviewStyle(
    color: LabelColorValue,
    textColor: LabelTextColorValue,
    bucket: ChromeBucket
): ResolvedLabelStyle {
    return resolveLabelStyle('preview', [{ name: 'preview', color, textColor }], bucket);
}

// ── hex ↔ HSV, hand-rolled ──────────────────────────────────────────────────────────

export interface Hsv {
    /** 0..360 */
    readonly h: number;
    /** 0..1 */
    readonly s: number;
    /** 0..1 */
    readonly v: number;
}

function clamp01(value: number): number {
    return Math.min(1, Math.max(0, value));
}

/**
 * `#abc` / `abc` / `#aabbcc` / `aabbcc` → a lowercase `#rrggbb`; anything else is `null`.
 *
 * Three-digit input is expanded the way CSS expands it (each nibble doubled), because a person
 * typing a colour types `#f80` at least as often as `#ff8800` — and the field has to accept
 * what it is offered without rewriting the keystrokes underneath it (see `HexField`).
 */
export function parseFlexibleHex(value: string): string | null {
    const raw = value.trim().replace(/^#/, '');
    const expanded =
        raw.length === 3 && /^[0-9a-fA-F]{3}$/.test(raw)
            ? `${raw[0] ?? ''}${raw[0] ?? ''}${raw[1] ?? ''}${raw[1] ?? ''}${raw[2] ?? ''}${raw[2] ?? ''}`
            : raw;
    const normalized = normalizeHexColor(`#${expanded}`);
    return normalized === null ? null : normalized.toLowerCase();
}

/** `#rrggbb` → HSV. `null` for anything that is not a 6-digit hex. */
export function hsvFromHex(hex: string): Hsv | null {
    const rgb = parseHexColor(hex);
    if (rgb === null) return null;
    const r = rgb.r / 255;
    const g = rgb.g / 255;
    const b = rgb.b / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let h = 0;
    if (delta !== 0) {
        if (max === r) h = ((g - b) / delta) % 6;
        else if (max === g) h = (b - r) / delta + 2;
        else h = (r - g) / delta + 4;
        h *= 60;
        if (h < 0) h += 360;
    }
    return { h, s: max === 0 ? 0 : delta / max, v: max };
}

/**
 * HSV → a lowercase `#rrggbb`.
 *
 * The inverse of `hsvFromHex` exactly, not approximately: `hsvFromHex` derives the hue from the
 * same `delta` this divides the middle component by, so the reconstruction lands on the original
 * byte and `hexFromHsv(hsvFromHex(x)) === x` for every input. That is the property the hex field
 * and the stored value both depend on.
 */
export function hexFromHsv(hsv: Hsv): string {
    const h = ((hsv.h % 360) + 360) % 360;
    const s = clamp01(hsv.s);
    const v = clamp01(hsv.v);
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    const sector = Math.floor(h / 60) % 6;
    const table: readonly (readonly [number, number, number])[] = [
        [c, x, 0],
        [x, c, 0],
        [0, c, x],
        [0, x, c],
        [x, 0, c],
        [c, 0, x]
    ];
    const [r, g, b] = table[sector] ?? [c, x, 0];
    const part = (component: number): string =>
        Math.round((component + m) * 255)
            .toString(16)
            .padStart(2, '0');
    return `#${part(r)}${part(g)}${part(b)}`;
}

// ── placement ───────────────────────────────────────────────────────────────────────

/** The trigger's box, in the viewport space `getBoundingClientRect` reports in. */
export interface FlyoverAnchor {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}

export interface FlyoverPlacement {
    readonly left: number;
    readonly top: number;
    /** Which side of the trigger the panel ended up on — `data-side`, and what a test reads. */
    readonly side: 'below' | 'above';
}

/** The panel's fixed width. Everything inside it is sized against this one number. */
export const COLOR_FLYOVER_WIDTH = 232;
/** The height the FIRST placement assumes, before the panel has been measured (see the effect). */
export const COLOR_FLYOVER_ESTIMATED_HEIGHT = 288;
/** How far the panel stands off its trigger. */
const FLYOVER_GAP = 6;
/** How close to a window edge the panel may come. */
const FLYOVER_MARGIN = 8;

/**
 * Where the panel sits: under its trigger, flipped above it when there is no room below.
 *
 * The same rule the footer's popovers and `ContextMenu`'s submenu follow — `useSubmenuFlip`
 * measures and flips sideways, `menuAnchorFromEvent` drops below its avoid-rect and rises above
 * it when the drop would go off-screen. Pure and separately tested, because the measurement it
 * works from does not exist in jsdom: a zero viewport still returns a deterministic box rather
 * than a NaN.
 */
export function colorFlyoverPlacement(
    anchor: FlyoverAnchor,
    size: { readonly width: number; readonly height: number },
    viewport: { readonly width: number; readonly height: number }
): FlyoverPlacement {
    const below = anchor.top + anchor.height + FLYOVER_GAP;
    const above = anchor.top - FLYOVER_GAP - size.height;
    const fitsBelow = below + size.height <= viewport.height - FLYOVER_MARGIN;
    // Below unless it does not fit AND above does — a flip that lands off the TOP edge is worse
    // than a drop that is clamped at the bottom one, because the header is what gets cut.
    const side: 'below' | 'above' = fitsBelow || above < FLYOVER_MARGIN ? 'below' : 'above';
    const rawTop = side === 'below' ? below : above;
    const maxTop = Math.max(FLYOVER_MARGIN, viewport.height - size.height - FLYOVER_MARGIN);
    const maxLeft = Math.max(FLYOVER_MARGIN, viewport.width - size.width - FLYOVER_MARGIN);
    return {
        left: Math.round(Math.min(Math.max(anchor.left, FLYOVER_MARGIN), maxLeft)),
        top: Math.round(Math.min(Math.max(rawTop, FLYOVER_MARGIN), maxTop)),
        side
    };
}

// ── the pieces ──────────────────────────────────────────────────────────────────────

interface SwatchProps {
    readonly color: string;
    readonly testID: string;
    readonly ariaLabel: string;
    readonly selected: boolean;
    /** §N33: the control the caret lands on when the popover opens — see the open-edge effect. */
    readonly initial?: boolean | undefined;
    readonly onClick: () => void;
}

/**
 * One palette swatch: a 16 px disc in a 20 px target (§S50), with the selection ring the row's
 * palette wore — accent for the one that is set, the selection stroke for the one under the
 * pointer, so "this is set" and "this is what you are about to set" stay distinguishable.
 */
function FlyoverSwatch(props: SwatchProps): ReactElement {
    const { hovered, hoverProps } = useHover();
    const ring = props.selected ? tokens.accent : hovered ? tokens.selectionStroke : null;
    return (
        <button
            type="button"
            data-testid={props.testID}
            aria-label={props.ariaLabel}
            aria-pressed={props.selected}
            {...(props.initial === true ? { 'data-flyover-initial': 'true' } : {})}
            className="relative h-4 w-4 shrink-0 rounded-full"
            style={{
                background: props.color,
                outline: ring === null ? 'none' : `2px solid ${ring}`,
                outlineOffset: '1px'
            }}
            {...hoverProps}
            onClick={props.onClick}
        >
            {/* §S50's 20 px target: 2 px of transparent bleed, hit-tested through to the button
                that owns it. It paints nothing and is out of flow, so the disc, the grid's 8 px
                gap and the panel's width are all untouched — and half the gap on each side means
                two neighbouring targets stay 4 px apart rather than abutting. */}
            <span aria-hidden style={{ position: 'absolute', inset: -2, borderRadius: '9999px' }} />
        </button>
    );
}

/** A section heading — "Background" / "Text", the two words the mockup puts over its groups. */
function SectionHeading(props: { readonly children: string; readonly testID: string }): ReactElement {
    return (
        <div
            data-testid={props.testID}
            className="text-[10px] font-semibold uppercase tracking-wide"
            style={{ color: tokens.textTertiary }}
        >
            {props.children}
        </div>
    );
}

interface CustomRowProps {
    readonly testID: string;
    readonly label: string;
    readonly ariaLabel: string;
    /** The swatch the row shows, or `null` when this section is not on a custom colour. */
    readonly swatch: string | null;
    /** The hex beside that swatch — the mockup's "current swatch and its hex". */
    readonly hex: string | null;
    readonly selected: boolean;
    readonly initial?: boolean | undefined;
    readonly onClick: () => void;
}

/**
 * The bordered `✎ Custom` row both sections carry.
 *
 * It is a row rather than a well because it does not SET a colour — it navigates to the view
 * that does. (That is the one behavioural difference from the `<input type="color">` it
 * replaces: the OS picker set a colour the moment it closed, and this opens a picker that is
 * part of the same surface.)
 */
function CustomRow(props: CustomRowProps): ReactElement {
    const { hovered, hoverProps } = useHover();
    return (
        <button
            type="button"
            data-testid={props.testID}
            aria-label={props.ariaLabel}
            aria-pressed={props.selected}
            {...(props.initial === true ? { 'data-flyover-initial': 'true' } : {})}
            {...hoverProps}
            className="flex h-6 w-full items-center gap-1.5 rounded border px-1.5 text-[10px] transition-colors duration-100"
            style={{
                borderColor: props.selected ? tokens.accent : hovered ? tokens.selectionStroke : tokens.divider,
                background: props.selected ? withAlpha(tokens.accent, 0.16) : hoverBackground(hovered, 'transparent'),
                color: tokens.textSecondary
            }}
            onClick={props.onClick}
        >
            <span aria-hidden>✎</span>
            <span className="flex-1 text-left">{props.label}</span>
            {props.swatch === null ? null : (
                <span
                    aria-hidden
                    data-testid={`${props.testID}-swatch`}
                    data-color={props.swatch}
                    className="h-3 w-3 shrink-0 rounded-full"
                    style={{ background: props.swatch, border: `1px solid ${tokens.divider}` }}
                />
            )}
            {props.hex === null ? null : (
                <span
                    data-testid={`${props.testID}-hex`}
                    className="shrink-0 font-mono text-[10px]"
                    style={{ color: tokens.textTertiary }}
                >
                    {props.hex}
                </span>
            )}
        </button>
    );
}

interface ModeButtonProps {
    readonly testID: string;
    readonly label: string;
    readonly selected: boolean;
    readonly onClick: () => void;
}

/** One of Auto / Black / White. Three explicit buttons, which is what the mockup draws. */
function ModeButton(props: ModeButtonProps): ReactElement {
    const { hovered, hoverProps } = useHover();
    return (
        <button
            type="button"
            data-testid={props.testID}
            aria-pressed={props.selected}
            {...hoverProps}
            // h-6: a 24 px control, over §S50's 20 px floor without the bleed a swatch needs.
            className="h-6 rounded border text-[10px] transition-colors duration-100"
            style={{
                borderColor: props.selected ? tokens.accent : hovered ? tokens.selectionStroke : tokens.divider,
                background: props.selected ? withAlpha(tokens.accent, 0.16) : hoverBackground(hovered, 'transparent'),
                color: props.selected ? tokens.textPrimary : tokens.textSecondary
            }}
            onClick={props.onClick}
        >
            {props.label}
        </button>
    );
}

// ── the picker ──────────────────────────────────────────────────────────────────────

/** The SV square's height. Its width is the panel's content box. */
const SV_HEIGHT = 132;
/** The hue slider's height, and the diameter of its knob. */
const HUE_HEIGHT = 14;
/** How far one arrow press moves the cursor; Shift multiplies it by ten. */
const NUDGE_S = 0.01;
const NUDGE_H = 1;

interface PickerProps {
    readonly hsv: Hsv;
    readonly onChange: (next: Hsv) => void;
}

/**
 * The saturation/value square: a pure-hue ground under a white→transparent wash and a
 * transparent→black one, which is the standard two-gradient construction and needs no canvas.
 *
 * The pointer is CAPTURED on press, so a drag that leaves the square keeps steering it (and a
 * release outside still ends the drag) — the behaviour every native picker has and the reason
 * this is not just three mouse listeners. Guarded, because jsdom implements neither
 * `setPointerCapture` nor a non-zero `getBoundingClientRect`: with no measurable box the drag is
 * a no-op and the keyboard path below is what the component tests drive.
 */
function SaturationValueSquare(props: PickerProps): ReactElement {
    const ref = useRef<HTMLDivElement | null>(null);
    const dragging = useRef(false);
    const { hsv, onChange } = props;

    const applyFromPoint = useCallback(
        (clientX: number, clientY: number): void => {
            const node = ref.current;
            if (node === null) return;
            const box = node.getBoundingClientRect();
            if (box.width <= 0 || box.height <= 0) return;
            onChange({
                h: hsv.h,
                s: clamp01((clientX - box.left) / box.width),
                v: clamp01(1 - (clientY - box.top) / box.height)
            });
        },
        [hsv.h, onChange]
    );

    const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
        dragging.current = true;
        const node = event.currentTarget;
        if (typeof node.setPointerCapture === 'function') {
            try {
                node.setPointerCapture(event.pointerId);
            } catch {
                /* a DOM that cannot capture still drags through the move handler */
            }
        }
        node.focus({ preventScroll: true });
        applyFromPoint(event.clientX, event.clientY);
    };

    return (
        <div
            ref={ref}
            data-testid="label-flyover-sv"
            data-hsv={`${hsv.h.toFixed(1)},${hsv.s.toFixed(3)},${hsv.v.toFixed(3)}`}
            role="slider"
            tabIndex={0}
            aria-label="Saturation and brightness"
            aria-valuetext={`saturation ${String(Math.round(hsv.s * 100))}%, brightness ${String(
                Math.round(hsv.v * 100)
            )}%`}
            aria-valuenow={Math.round(hsv.v * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="relative w-full rounded outline-none"
            style={{
                height: `${String(SV_HEIGHT)}px`,
                background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), hsl(${String(
                    hsv.h
                )}, 100%, 50%)`,
                border: `1px solid ${tokens.divider}`,
                touchAction: 'none'
            }}
            onPointerDown={onPointerDown}
            onPointerMove={(event) => {
                if (!dragging.current) return;
                applyFromPoint(event.clientX, event.clientY);
            }}
            onPointerUp={() => {
                dragging.current = false;
            }}
            onPointerCancel={() => {
                dragging.current = false;
            }}
            onKeyDown={(event) => {
                const step = (event.shiftKey ? 10 : 1) * NUDGE_S;
                if (event.key === 'ArrowLeft') onChange({ ...hsv, s: clamp01(hsv.s - step) });
                else if (event.key === 'ArrowRight') onChange({ ...hsv, s: clamp01(hsv.s + step) });
                else if (event.key === 'ArrowUp') onChange({ ...hsv, v: clamp01(hsv.v + step) });
                else if (event.key === 'ArrowDown') onChange({ ...hsv, v: clamp01(hsv.v - step) });
                else return;
                event.preventDefault();
                event.stopPropagation();
            }}
        >
            {/* The circular cursor. `translate(-50%,-50%)` so it is centred on the value rather
                than hanging off it, and a white ring over a black one so it stays visible on
                both a white corner and a black one. */}
            <span
                aria-hidden
                data-testid="label-flyover-sv-cursor"
                data-left={`${String(Math.round(hsv.s * 1000) / 10)}%`}
                data-top={`${String(Math.round((1 - hsv.v) * 1000) / 10)}%`}
                className="pointer-events-none absolute h-3 w-3 rounded-full"
                style={{
                    left: `${String(hsv.s * 100)}%`,
                    top: `${String((1 - hsv.v) * 100)}%`,
                    transform: 'translate(-50%, -50%)',
                    border: '2px solid #fff',
                    boxShadow: '0 0 0 1px rgba(0,0,0,0.55)'
                }}
            />
        </div>
    );
}

/** The hue rail beneath it — one gradient, one knob, the same capture/nudge contract. */
function HueSlider(props: PickerProps): ReactElement {
    const ref = useRef<HTMLDivElement | null>(null);
    const dragging = useRef(false);
    const { hsv, onChange } = props;

    const applyFromPoint = useCallback(
        (clientX: number): void => {
            const node = ref.current;
            if (node === null) return;
            const box = node.getBoundingClientRect();
            if (box.width <= 0) return;
            onChange({ ...hsv, h: clamp01((clientX - box.left) / box.width) * 360 });
        },
        [hsv, onChange]
    );

    return (
        <div
            ref={ref}
            data-testid="label-flyover-hue"
            data-hue={hsv.h.toFixed(1)}
            role="slider"
            tabIndex={0}
            aria-label="Hue"
            aria-valuenow={Math.round(hsv.h)}
            aria-valuemin={0}
            aria-valuemax={360}
            className="relative w-full rounded-full outline-none"
            style={{
                height: `${String(HUE_HEIGHT)}px`,
                background:
                    'linear-gradient(to right, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)',
                border: `1px solid ${tokens.divider}`,
                touchAction: 'none'
            }}
            onPointerDown={(event) => {
                dragging.current = true;
                const node = event.currentTarget;
                if (typeof node.setPointerCapture === 'function') {
                    try {
                        node.setPointerCapture(event.pointerId);
                    } catch {
                        /* see the square */
                    }
                }
                node.focus({ preventScroll: true });
                applyFromPoint(event.clientX);
            }}
            onPointerMove={(event) => {
                if (!dragging.current) return;
                applyFromPoint(event.clientX);
            }}
            onPointerUp={() => {
                dragging.current = false;
            }}
            onPointerCancel={() => {
                dragging.current = false;
            }}
            onKeyDown={(event) => {
                const step = (event.shiftKey ? 10 : 1) * NUDGE_H;
                if (event.key === 'ArrowLeft') onChange({ ...hsv, h: (hsv.h - step + 360) % 360 });
                else if (event.key === 'ArrowRight') onChange({ ...hsv, h: (hsv.h + step) % 360 });
                else return;
                event.preventDefault();
                event.stopPropagation();
            }}
        >
            <span
                aria-hidden
                data-testid="label-flyover-hue-knob"
                className="pointer-events-none absolute top-1/2 rounded-full"
                style={{
                    left: `${String((hsv.h / 360) * 100)}%`,
                    height: `${String(HUE_HEIGHT)}px`,
                    width: `${String(HUE_HEIGHT)}px`,
                    transform: 'translate(-50%, -50%)',
                    border: '2px solid #fff',
                    boxShadow: '0 0 0 1px rgba(0,0,0,0.55)'
                }}
            />
        </div>
    );
}

interface HexFieldProps {
    readonly value: string;
    readonly onCommit: (hex: string) => void;
}

/**
 * The `✎` + hex row.
 *
 * **Validating without clobbering keystrokes** is the whole contract: the field holds a DRAFT
 * string that is never rewritten while it has focus, so typing `#f` (not yet a colour) leaves
 * `#f` on screen rather than snapping to the last valid value mid-word. Every keystroke is
 * parsed; a parse that succeeds applies immediately, a parse that fails simply does not write.
 * On blur — and whenever the value changes from outside, e.g. a drag in the square — the draft
 * is re-synced to the canonical value.
 */
function HexField(props: HexFieldProps): ReactElement {
    const [draft, setDraft] = useState(props.value);
    const [focused, setFocused] = useState(false);
    const { value, onCommit } = props;
    useEffect(() => {
        if (!focused) setDraft(value);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- `focused` is the GUARD, not an
        // input: re-running on a focus change would overwrite the draft the moment the field is
        // entered, which is exactly the clobber this exists to prevent.
    }, [value]);
    const parsed = parseFlexibleHex(draft);
    return (
        <label className="flex items-center gap-1.5">
            <span aria-hidden style={{ color: tokens.textTertiary }} className="text-[11px]">
                ✎
            </span>
            <input
                data-testid="label-flyover-hex"
                data-valid={parsed === null ? 'false' : 'true'}
                aria-label="Hex colour"
                aria-invalid={parsed === null}
                spellCheck={false}
                autoComplete="off"
                value={draft}
                className="min-w-0 flex-1 rounded border bg-transparent px-1.5 py-1 font-mono text-[11px] outline-none"
                style={{
                    borderColor: parsed === null ? '#E0685F' : tokens.divider,
                    color: tokens.textPrimary
                }}
                onChange={(event) => {
                    setDraft(event.target.value);
                    const next = parseFlexibleHex(event.target.value);
                    if (next !== null) onCommit(next);
                }}
                onFocus={() => {
                    setFocused(true);
                }}
                onBlur={() => {
                    setFocused(false);
                    setDraft(value);
                }}
                onKeyDown={(event) => {
                    // A field mid-edit owns Escape — but this popover's Escape is what closes it,
                    // so the key is left alone deliberately and only Enter is consumed (there is
                    // nothing to submit: every valid keystroke has already been applied).
                    if (event.key === 'Enter') event.preventDefault();
                }}
            />
        </label>
    );
}

// ── the flyover ─────────────────────────────────────────────────────────────────────

/** Which value the custom view is editing. */
export type CustomTarget = 'background' | 'text';

export interface ColorFlyoverProps {
    /** The label this popover is designing — the chip preview's text and every announcement. */
    readonly name: string;
    readonly color: LabelColorValue;
    readonly textColor: LabelTextColorValue;
    readonly bucket: ChromeBucket;
    /** The trigger the popover is anchored to, and the element focus returns to. */
    readonly anchorRef: RefObject<HTMLElement | null>;
    readonly onColorChange: (next: LabelColorValue) => void;
    readonly onTextColorChange: (next: LabelTextColorValue) => void;
    readonly onClose: () => void;
    /** Test seam: where the portal mounts (defaults to `document.body`). */
    readonly container?: Element | undefined;
}

/** The focusables a Tab cycle walks, in DOM order. */
const FLYOVER_FOCUSABLE =
    'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ColorFlyover(props: ColorFlyoverProps): ReactElement | null {
    const { anchorRef, onClose, onColorChange, onTextColorChange, bucket, name } = props;
    const panelRef = useRef<HTMLDivElement | null>(null);
    const [view, setView] = useState<'palette' | 'custom'>('palette');
    const [target, setTarget] = useState<CustomTarget>('background');
    /**
     * The picker's live position.
     *
     * Seeded when the custom view is ENTERED and owned from then on, rather than derived from the
     * stored hex on every render: HSV is lossy at the extremes (every value at v=0 is black, and
     * a hue has no meaning there), so re-deriving would snap the hue rail back to red the instant
     * a drag reached the bottom edge. `null` while the palette view is showing.
     */
    const [hsv, setHsv] = useState<Hsv | null>(null);
    /**
     * Whether this visit to the custom view has WRITTEN anything yet.
     *
     * It is what makes the byte-exact round trip observable rather than merely arithmetical: an
     * untouched view shows the STORED string (`#FF8800` stays `#FF8800`), not a re-derived copy
     * of it, and no `updateLabelPreset` has been sent. The first nudge, drag or valid keystroke
     * flips it, and from then on the field shows what the picker holds.
     */
    const [touched, setTouched] = useState(false);

    const backgroundHex = hexOf(props.color, bucket).toLowerCase();
    const mode = textMode(props.textColor);
    const resolvedTextHex = (
        props.textColor === null
            ? labelPreviewStyle(props.color, null, bucket).text
            : hexOf(props.textColor, bucket)
    ).toLowerCase();
    /**
     * The hex the custom view starts from — and, for a value already STORED as custom, the
     * stored string itself rather than a normalized copy of it, so opening the view and closing
     * it again cannot rewrite a byte.
     */
    const storedCustomHex =
        target === 'background'
            ? props.color.kind === 'custom'
                ? props.color.hex
                : null
            : props.textColor !== null && props.textColor.kind === 'custom'
              ? props.textColor.hex
              : null;
    const targetHex = storedCustomHex ?? (target === 'background' ? backgroundHex : resolvedTextHex);

    const chipStyle = labelPreviewStyle(props.color, props.textColor, bucket);

    /*
     * §N26 — the rect registration. The same call `ContextMenu` makes, and the reason a web pane
     * under this panel parks while the panes beside it stay live. It measures the union of the
     * panel and everything inside it after every render, so the custom view's taller box is
     * reported the moment it is on screen.
     */
    useOverlayPresence(panelRef);

    /*
     * §N33 — the caret goes back where it came from.
     *
     * `close` is what every exit runs through: the ×, Escape, an outside click. It hands focus to
     * the trigger only when the popover still HAS it (or when nothing does, which is the blur a
     * dismissal can leave behind) — an outside click that lands on a real field must be allowed
     * to keep it, and yanking the caret back would be the same theft §N33 spent three runs
     * removing from the reorder arbiter.
     */
    const close = useCallback((): void => {
        const active = globalThis.document?.activeElement ?? null;
        const inside = panelRef.current !== null && active !== null && panelRef.current.contains(active);
        const nowhere = active === null || active === globalThis.document?.body;
        onClose();
        if (inside || nowhere) anchorRef.current?.focus({ preventScroll: true });
    }, [onClose, anchorRef]);

    // §H15's shared contract: an outside click or Escape dismisses, and the TRIGGER is in the
    // keep-list so clicking it closes the popover through its own toggle rather than being
    // "outside" on mousedown and re-opening on click.
    useDismissable(true, close, [panelRef, anchorRef]);

    // ── placement, measured ─────────────────────────────────────────────────────────
    const [placement, setPlacement] = useState<FlyoverPlacement>(() =>
        colorFlyoverPlacement(
            anchorRect(anchorRef.current),
            { width: COLOR_FLYOVER_WIDTH, height: COLOR_FLYOVER_ESTIMATED_HEIGHT },
            viewportSize()
        )
    );
    /*
     * Re-placed in a LAYOUT effect, from the panel's real height, so the flip decision is made
     * with the box that is actually about to be painted — a popover that jumps after opening
     * would be its own defect (`useSubmenuFlip` says the same thing about the sideways flip).
     * It runs on every render because `view` changes the height by ~40 px: switching to the
     * custom view near the bottom of the window has to be able to flip.
     */
    useLayoutEffect(() => {
        const panel = panelRef.current;
        const anchor = anchorRect(anchorRef.current);
        const height = panel?.getBoundingClientRect().height ?? 0;
        const next = colorFlyoverPlacement(
            anchor,
            { width: COLOR_FLYOVER_WIDTH, height: height > 0 ? height : COLOR_FLYOVER_ESTIMATED_HEIGHT },
            viewportSize()
        );
        setPlacement((current) =>
            current.left === next.left && current.top === next.top && current.side === next.side ? current : next
        );
    });

    // ── focus: in on open, cycling inside, back out on close ────────────────────────
    /*
     * On open the caret lands on the control that represents the CURRENT background — the
     * selected swatch, or the `✎ Custom` row when the background is a custom colour — so the
     * arrows start walking from where the value already is rather than from the corner.
     */
    useEffect(() => {
        const panel = panelRef.current;
        if (panel === null) return;
        const selected = panel.querySelector<HTMLElement>('[data-flyover-initial="true"]');
        (selected ?? panel.querySelector<HTMLElement>(FLYOVER_FOCUSABLE))?.focus({ preventScroll: true });
        // Open-edge only: re-running on a re-render would fight the arrow walk.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /** Entering the custom view puts the caret on the square, which is the thing you came for. */
    const enterCustom = useCallback((next: CustomTarget): void => {
        setTarget(next);
        setView('custom');
        setHsv(null);
        setTouched(false);
    }, []);
    useLayoutEffect(() => {
        if (view !== 'custom') return;
        if (hsv !== null) return;
        setHsv(hsvFromHex(targetHex) ?? { h: 0, s: 0, v: 0 });
    }, [view, hsv, targetHex]);
    const pickerFocused = useRef(false);
    useEffect(() => {
        if (view !== 'custom') {
            pickerFocused.current = false;
            return;
        }
        if (pickerFocused.current) return;
        pickerFocused.current = true;
        panelRef.current?.querySelector<HTMLElement>('[data-testid="label-flyover-sv"]')?.focus({
            preventScroll: true
        });
    }, [view]);

    /*
     * The Tab cycle. The popover is a trap for the same reason the Settings dialog around it is:
     * it is the surface that owns the keyboard while it is up, and a Tab that walked out of it
     * would land on a control the user cannot see behind the panel. Escape is `useDismissable`'s.
     */
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== 'Tab') return;
            const panel = panelRef.current;
            if (panel === null) return;
            const nodes = [...panel.querySelectorAll<HTMLElement>(FLYOVER_FOCUSABLE)];
            if (nodes.length === 0) return;
            const first = nodes[0];
            const last = nodes[nodes.length - 1];
            if (first === undefined || last === undefined) return;
            const active = globalThis.document.activeElement;
            if (!panel.contains(active)) {
                event.preventDefault();
                first.focus({ preventScroll: true });
                return;
            }
            if (!event.shiftKey && active === last) {
                event.preventDefault();
                first.focus({ preventScroll: true });
            } else if (event.shiftKey && active === first) {
                event.preventDefault();
                last.focus({ preventScroll: true });
            }
        };
        const doc = globalThis.document;
        doc.addEventListener('keydown', onKeyDown, true);
        return () => {
            doc.removeEventListener('keydown', onKeyDown, true);
        };
    }, []);

    /** The swatch grid walks with the arrows — five per row, wrapping at both ends. */
    const onGridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
        const key = event.key;
        if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'ArrowUp' && key !== 'ArrowDown') return;
        const grid = event.currentTarget;
        const cells = [...grid.querySelectorAll<HTMLElement>('button')];
        const at = cells.indexOf(globalThis.document.activeElement as HTMLElement);
        if (at === -1) return;
        const delta = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : key === 'ArrowUp' ? -PALETTE_COLUMNS : PALETTE_COLUMNS;
        const next = (at + delta + cells.length) % cells.length;
        event.preventDefault();
        event.stopPropagation();
        cells[next]?.focus({ preventScroll: true });
    };

    /*
     * IMMEDIATE APPLY, exactly as the inline swatches were: there is no OK button, the × and
     * Escape only CLOSE, and every movement in the picker is a write. The two entry points differ
     * only in where the value comes from — a drag/nudge carries HSV, the field carries a hex —
     * and both keep the picker's own state and the stored value in step.
     */
    const applyHsv = (next: Hsv): void => {
        setHsv(next);
        setTouched(true);
        const hex = hexFromHsv(next);
        if (target === 'background') onColorChange({ kind: 'custom', hex });
        else onTextColorChange({ kind: 'custom', hex });
    };
    const applyHex = (hex: string): void => {
        setHsv(hsvFromHex(hex) ?? { h: 0, s: 0, v: 0 });
        setTouched(true);
        if (target === 'background') onColorChange({ kind: 'custom', hex });
        else onTextColorChange({ kind: 'custom', hex });
    };

    const container = props.container ?? globalThis.document?.body;
    if (container === undefined || container === null) return null;

    const backgroundIsCustom = props.color.kind === 'custom';
    const textIsCustom = mode === 'custom';

    const panel = (
        <div
            ref={panelRef}
            role="dialog"
            aria-modal={false}
            aria-label={`Colours for ${name}`}
            data-testid="label-color-flyover"
            data-label={name}
            data-view={view}
            data-side={placement.side}
            {...(view === 'custom' ? { 'data-custom-target': target } : {})}
            className="fixed z-[60] flex flex-col gap-2 rounded-lg p-3 text-[11px]"
            style={{
                left: placement.left,
                top: placement.top,
                width: `${String(COLOR_FLYOVER_WIDTH)}px`,
                background: tokens.surfaceBackground,
                border: `1px solid ${tokens.divider}`,
                color: tokens.textPrimary,
                boxShadow: '0 12px 32px rgba(0, 0, 0, 0.38)'
            }}
        >
            {/* ── the header: the chip as it will look, and the way out ── */}
            <div className="flex items-center gap-1.5">
                {view === 'custom' ? (
                    <button
                        type="button"
                        data-testid="label-flyover-back"
                        aria-label="Back to the palette"
                        title="Back"
                        className="-m-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[12px] leading-none"
                        style={{ color: tokens.textSecondary }}
                        onClick={() => {
                            setView('palette');
                            setHsv(null);
                        }}
                    >
                        ‹
                    </button>
                ) : null}
                {/*
                 * The chip sits in a flexible CELL and takes its own content's width inside it —
                 * a capsule stretched to the panel reads as a text field, which is the one thing
                 * a preview of a chip must not look like. It still truncates, so a long label
                 * ellipsises rather than pushing the × off the edge.
                 */}
                <span className="flex min-w-0 flex-1 items-center">
                    <span
                        data-testid="label-flyover-chip"
                        data-background={normalizeHexColor(chipStyle.background)?.toLowerCase() ?? chipStyle.background}
                        data-text={normalizeHexColor(chipStyle.text)?.toLowerCase() ?? chipStyle.text}
                        // The chip the sidebar will wear (`WorkspaceLabelViews.swift`'s capsule),
                        // at the same 10 px medium the row's preview column draws.
                        className="max-w-full truncate rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                        style={{ background: chipStyle.background, color: chipStyle.text }}
                    >
                        {name}
                    </span>
                </span>
                <button
                    type="button"
                    data-testid="label-flyover-close"
                    aria-label="Close the colour picker"
                    title="Close"
                    className="-m-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[12px] leading-none"
                    style={{ color: tokens.textSecondary }}
                    onClick={close}
                >
                    ×
                </button>
            </div>

            {view === 'palette' ? (
                <>
                    <SectionHeading testID="label-flyover-background-heading">Background</SectionHeading>
                    <div
                        data-testid="label-flyover-background-grid"
                        role="group"
                        aria-label={`Background colour for ${name}`}
                        className="grid gap-2"
                        style={{
                            gridTemplateColumns: `repeat(${String(PALETTE_COLUMNS)}, minmax(0, 1fr))`,
                            justifyItems: 'center'
                        }}
                        onKeyDown={onGridKeyDown}
                    >
                        {WORKSPACE_COLORS.map((color) => {
                            const selected = props.color.kind === 'named' && props.color.color === color;
                            return (
                                <FlyoverSwatch
                                    key={color}
                                    testID={`label-flyover-bg-${color}`}
                                    ariaLabel={`${color} background for ${name}`}
                                    color={workspaceColorHex(color, bucket)}
                                    selected={selected}
                                    initial={selected}
                                    onClick={() => {
                                        if (selected) return;
                                        onColorChange({ kind: 'named', color });
                                    }}
                                />
                            );
                        })}
                    </div>
                    <CustomRow
                        testID="label-flyover-bg-custom"
                        label="Custom"
                        ariaLabel={`Custom background colour for ${name}`}
                        swatch={backgroundIsCustom ? backgroundHex : null}
                        hex={backgroundIsCustom ? backgroundHex : null}
                        selected={backgroundIsCustom}
                        initial={backgroundIsCustom}
                        onClick={() => {
                            enterCustom('background');
                        }}
                    />

                    <div className="h-px" style={{ background: tokens.divider }} />

                    <SectionHeading testID="label-flyover-text-heading">Text</SectionHeading>
                    <div
                        role="group"
                        aria-label={`Text colour for ${name}`}
                        data-testid="label-flyover-text-modes"
                        className="grid grid-cols-3 gap-1.5"
                    >
                        <ModeButton
                            testID="label-flyover-text-auto"
                            label="Auto"
                            selected={mode === 'auto'}
                            onClick={() => {
                                onTextColorChange(TEXT_MODE_VALUE.auto);
                            }}
                        />
                        <ModeButton
                            testID="label-flyover-text-black"
                            label="Black"
                            selected={mode === 'black'}
                            onClick={() => {
                                onTextColorChange(TEXT_MODE_VALUE.black);
                            }}
                        />
                        <ModeButton
                            testID="label-flyover-text-white"
                            label="White"
                            selected={mode === 'white'}
                            onClick={() => {
                                onTextColorChange(TEXT_MODE_VALUE.white);
                            }}
                        />
                    </div>
                    {/* The mockup's Text ▸ Custom row shows the CURRENT swatch and hex whatever the
                        mode is — on Auto that is the luminance rule's own answer, which is the one
                        place in the app that says out loud what "Auto" resolved to. */}
                    <CustomRow
                        testID="label-flyover-text-custom"
                        label="Custom"
                        ariaLabel={`Custom text colour for ${name}`}
                        swatch={resolvedTextHex}
                        hex={resolvedTextHex}
                        selected={textIsCustom}
                        onClick={() => {
                            enterCustom('text');
                        }}
                    />
                </>
            ) : (
                <div data-testid="label-flyover-custom" data-target={target} className="flex flex-col gap-2">
                    <SectionHeading testID="label-flyover-custom-heading">
                        {target === 'background' ? 'Background' : 'Text'}
                    </SectionHeading>
                    <SaturationValueSquare hsv={hsv ?? { h: 0, s: 0, v: 0 }} onChange={applyHsv} />
                    <HueSlider hsv={hsv ?? { h: 0, s: 0, v: 0 }} onChange={applyHsv} />
                    {/* Untouched, the field shows the STORED string verbatim (see `touched`). */}
                    <HexField value={touched && hsv !== null ? hexFromHsv(hsv) : targetHex} onCommit={applyHex} />
                </div>
            )}
        </div>
    );

    return createPortal(panel, container);
}

/** The trigger's box, or a zero box when there is nothing to measure (jsdom, a pre-layout open). */
function anchorRect(node: HTMLElement | null): FlyoverAnchor {
    if (node === null || typeof node.getBoundingClientRect !== 'function') {
        return { left: 0, top: 0, width: 0, height: 0 };
    }
    const box = node.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
}

function viewportSize(): { readonly width: number; readonly height: number } {
    return {
        width: globalThis.innerWidth ?? 0,
        height: globalThis.innerHeight ?? 0
    };
}
