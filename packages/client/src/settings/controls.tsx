/**
 * Settings controls that WRITE — the colour picker, the slider and the segmented picker.
 *
 * Everything in `./ui.tsx` renders a value; everything here changes one, and the difference
 * that matters is **debouncing**. A colour picker drags at 60 Hz and a slider fires on every
 * pointer move; each of those events would otherwise be a socket round-trip and a config-file
 * rewrite. SET-041 is explicit that the Swift app funnels both through a single
 * cancel-in-flight effect id, and this is that: local state drives the control so it tracks the
 * finger with no lag, and the write fires once the user stops moving.
 *
 * The other half of the rule is that the DAEMON is still the authority. When the value arrives
 * back on the `settings-changed` broadcast, the local state steps aside — so a hand-edit to the
 * config file, or a change made in a second window, moves this control too. That is why the
 * pending value is dropped whenever the incoming prop changes to something the user did not
 * just type, rather than being held forever.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';

import { normalizeHexColor, tokens, withAlpha } from '../chrome';
import { SettingsDetail, hoverBackground, useHover } from './ui';

/**
 * L79: a control is a ROW INSIDE its section's card, so it draws no card of its own.
 *
 * Every one of the five below used to open with `rounded px-2 py-1.5` over a 6 % gray — the
 * grouped-form fill, applied one level too low, which turned a `Section` into a stack of pills.
 * `SettingsSection` now owns the fill, the row padding and the hairline between rows; what is
 * left here is the row's own vertical layout (the control line, then M46's caption under it).
 */
const ROW = 'flex flex-col gap-1';

export const SETTINGS_WRITE_DEBOUNCE_MS = 250;

/**
 * A value the user drags and the daemon owns.
 *
 * Returns the value to RENDER (the pending one while dragging, the authoritative one
 * otherwise) and a setter that schedules the write.
 */
export function useDebouncedValue<T>(
    value: T,
    commit: (next: T) => void,
    delayMs = SETTINGS_WRITE_DEBOUNCE_MS
): [T, (next: T) => void] {
    const [pending, setPending] = useState<T | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const commitRef = useRef(commit);
    commitRef.current = commit;

    // The authoritative value moved: whatever the user was dragging is now stale (either it
    // landed, or somebody else changed it). Either way the prop wins.
    useEffect(() => {
        setPending(null);
    }, [value]);

    useEffect(
        () => () => {
            if (timer.current !== null) clearTimeout(timer.current);
        },
        []
    );

    const set = (next: T): void => {
        setPending(next);
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
            timer.current = null;
            commitRef.current(next);
        }, delayMs);
    };

    return [pending === null ? value : pending, set];
}

export interface ColorFieldProps {
    readonly label: string;
    readonly value: string;
    readonly onChange: (hex: string) => void;
    readonly testID?: string | undefined;
    readonly detail?: string | undefined;
}

/**
 * One overridable chrome colour. A native `<input type="color">` because it is the only
 * control that opens the OS picker the Swift `ColorPicker` opens; the hex is shown beside it
 * so a value can be read (and copied) without opening anything.
 */
export function ColorField(props: ColorFieldProps): ReactElement {
    const normalized = normalizeHexColor(props.value) ?? '#000000';
    const [shown, setShown] = useDebouncedValue(normalized, props.onChange);
    return (
        <div
            className={ROW}
            {...(props.testID === undefined ? {} : { 'data-testid': props.testID })}
        >
            <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col">
                <span className="truncate text-[12px]" style={{ color: tokens.textPrimary }}>
                    {props.label}
                </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
                <span className="font-mono text-[11px]" style={{ color: tokens.textTertiary }}>
                    {shown.toUpperCase()}
                </span>
                {/*
                 * The swatch is a SPAN painted with the value, and the native picker sits on top
                 * of it at zero opacity as the click target.
                 *
                 * A bare `<input type="color">` looked right for a bright colour and wrong for a
                 * dark one: Chromium insets its own swatch inside a light chrome border, so
                 * `#0A0A0C` on the dark palette rendered as an empty white rectangle — the audit
                 * photographed a column of them next to "Window gaps" and "Sidebar". Painting the
                 * colour ourselves means every value reads the same way, and the input keeps
                 * doing the one thing only it can do: open the OS picker.
                 */}
                <span
                    className="relative inline-block h-6 w-10 overflow-hidden rounded"
                    style={{ background: shown, border: `1px solid ${tokens.divider}` }}
                >
                    <input
                        type="color"
                        aria-label={props.label}
                        value={shown.toLowerCase()}
                        {...(props.testID === undefined ? {} : { 'data-testid': `${props.testID}-input` })}
                        className="absolute inset-0 h-full w-full border-0 bg-transparent p-0 opacity-0"
                        onChange={(event) => {
                            setShown(event.target.value);
                        }}
                    />
                </span>
            </div>
            </div>
            {/* M46: the caption is a row of its own, under the control, not a second line in the
                label column. */}
            {props.detail === undefined ? null : <SettingsDetail>{props.detail}</SettingsDetail>}
        </div>
    );
}

export interface SliderFieldProps {
    readonly label: string;
    readonly value: number;
    readonly min: number;
    readonly max: number;
    readonly step: number;
    readonly onChange: (next: number) => void;
    /** How the number reads beside the slider; defaults to a percentage. */
    readonly format?: ((value: number) => string) | undefined;
    readonly detail?: string | undefined;
    readonly testID?: string | undefined;
    /**
     * L82: `sliderRow`'s readout is `.frame(width: 44)`, but the one ad-hoc slider in the Swift
     * Appearance tab — Graph width (`SettingsView.swift:466-474`) — writes its own row and gives
     * the readout **32**, because an integer 16…80 needs half the room a percentage does.
     */
    readonly readoutWidth?: number | undefined;
}

/** `sliderRow`'s two fixed frames (`SettingsView.swift:506-515`): the label, then the readout. */
export const SLIDER_LABEL_WIDTH = 140;
export const SLIDER_READOUT_WIDTH = 44;

/**
 * `sliderRow` — a fixed-width label, the slider, and a fixed-width readout, so every slider on
 * the tab is the same length and the numbers line up in a column.
 *
 * The three metrics are `SettingsView.swift:506-515` verbatim (L82): `HStack(spacing: 10)`, a
 * `.frame(width: 140, alignment: .leading)` label and a `.frame(width: 44, alignment: .trailing)`
 * readout. The port had 12 / 150 / 52, which is a wider label column and a readout with a
 * percentage's worth of slack in it — visible as a slider track ~18 px shorter than the shipped
 * one on every row of the Appearance tab.
 */
export function SliderField(props: SliderFieldProps): ReactElement {
    const [shown, setShown] = useDebouncedValue(props.value, props.onChange);
    const format = props.format ?? ((value: number) => `${String(Math.round(value * 100))}%`);
    return (
        <div
            className={ROW}
            {...(props.testID === undefined ? {} : { 'data-testid': props.testID })}
        >
            <div className="flex items-center gap-2.5">
            <div
                className="flex shrink-0 flex-col"
                style={{ width: `${String(SLIDER_LABEL_WIDTH)}px` }}
            >
                <span className="text-[12px]" style={{ color: tokens.textPrimary }}>
                    {props.label}
                </span>
            </div>
            <input
                type="range"
                aria-label={props.label}
                min={props.min}
                max={props.max}
                step={props.step}
                value={shown}
                {...(props.testID === undefined ? {} : { 'data-testid': `${props.testID}-slider` })}
                className="min-w-0 flex-1"
                // `accentColor` is the one line that makes a native range follow the chrome
                // palette. Without it a Gruvbox-orange window renders a system-blue slider,
                // which the audit photographed as the only blue thing on the page.
                //
                // S33: `height` is the drag target. `SettingsView.swift:506-515` is a macOS
                // `Slider`, ~20 pt tall with a 20 pt knob; Chromium's default range box is 16,
                // which made the seven Appearance sliders the one control on the tab under the
                // 20 px line. §L82's row metrics (columnGap 10, 140 px label track, 44 px
                // readout) are untouched — only the input's own box grows.
                style={{ accentColor: tokens.accent, height: 20 }}
                onChange={(event) => {
                    setShown(Number.parseFloat(event.target.value));
                }}
            />
            {/*
              * `.monospacedDigit()` is the UI face with TABULAR FIGURES, not a monospaced
              * family — the readout has to hold still as the number changes, which `tabular-nums`
              * does, without changing typeface mid-row.
              */}
            <span
                className="shrink-0 text-right text-[12px] tabular-nums"
                style={{
                    width: `${String(props.readoutWidth ?? SLIDER_READOUT_WIDTH)}px`,
                    color: tokens.textSecondary
                }}
                {...(props.testID === undefined ? {} : { 'data-testid': `${props.testID}-value` })}
            >
                {format(shown)}
            </span>
            </div>
            {props.detail === undefined ? null : <SettingsDetail>{props.detail}</SettingsDetail>}
        </div>
    );
}

interface SegmentButtonProps {
    readonly label: string;
    readonly selected: boolean;
    readonly first: boolean;
    readonly testID: string | undefined;
    readonly onSelect: () => void;
}

/**
 * One segment of the picker. H11: a `.pickerStyle(.segmented)` control tracks the pointer in
 * AppKit and this one did not, so the unselected halves read as labels rather than as choices.
 */
function SegmentButton(props: SegmentButtonProps): ReactElement {
    const { hovered, hoverProps } = useHover(!props.selected);
    return (
        <button
            type="button"
            role="radio"
            aria-checked={props.selected}
            data-testid={props.testID}
            className="px-2.5 py-1 text-[11px] transition-colors duration-100"
            style={{
                background: props.selected
                    ? withAlpha(tokens.accent, 0.22)
                    : hoverBackground(hovered, 'transparent'),
                color: props.selected || hovered ? tokens.textPrimary : tokens.textSecondary,
                // A divider between segments, not around them. Without it the labels run
                // together and read as one word — the audit caught "SystemLightDark" and
                // "LineStacked dots" rendering as prose rather than as a choice between three
                // things. Mixed from the TEXT colour rather than the divider token: the divider
                // is tuned for a flat surface and disappears against a tinted row (the
                // placement pickers on the General tab were the case).
                borderLeft: props.first ? 'none' : `1px solid ${withAlpha(tokens.textPrimary, 0.18)}`
            }}
            {...hoverProps}
            onClick={props.onSelect}
        >
            {props.label}
        </button>
    );
}

export interface SegmentedFieldProps<T extends string> {
    readonly label: string;
    readonly value: T;
    readonly options: readonly { readonly value: T; readonly label: string }[];
    readonly onChange: (next: T) => void;
    readonly detail?: string | undefined;
    readonly testID?: string | undefined;
}

/** The `.pickerStyle(.segmented)` equivalent: a radiogroup of adjacent buttons. */
export function SegmentedField<T extends string>(props: SegmentedFieldProps<T>): ReactElement {
    return (
        <div
            className={ROW}
            {...(props.testID === undefined ? {} : { 'data-testid': props.testID })}
        >
            <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col">
                <span className="text-[12px]" style={{ color: tokens.textPrimary }}>
                    {props.label}
                </span>
            </div>
            <div
                role="radiogroup"
                aria-label={props.label}
                className="flex shrink-0 overflow-hidden rounded border"
                style={{ borderColor: tokens.divider }}
            >
                {props.options.map((option, index) => {
                    const selected = option.value === props.value;
                    return (
                        <SegmentButton
                            key={option.value}
                            label={option.label}
                            selected={selected}
                            first={index === 0}
                            testID={
                                props.testID === undefined ? undefined : `${props.testID}-${option.value}`
                            }
                            onSelect={() => {
                                props.onChange(option.value);
                            }}
                        />
                    );
                })}
            </div>
            </div>
            {props.detail === undefined ? null : <SettingsDetail>{props.detail}</SettingsDetail>}
        </div>
    );
}

export interface SelectFieldProps {
    readonly label: string;
    readonly value: string;
    readonly options: readonly { readonly value: string; readonly label: string }[];
    readonly onChange: (next: string) => void;
    readonly detail?: string | undefined;
    readonly testID?: string | undefined;
}

/** A plain `<select>` — the right control for a ten-entry list a segmented picker cannot hold. */
export function SelectField(props: SelectFieldProps): ReactElement {
    return (
        <div
            className={ROW}
            {...(props.testID === undefined ? {} : { 'data-testid': props.testID })}
        >
            <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col">
                <span className="text-[12px]" style={{ color: tokens.textPrimary }}>
                    {props.label}
                </span>
            </div>
            <select
                aria-label={props.label}
                value={props.value}
                {...(props.testID === undefined ? {} : { 'data-testid': `${props.testID}-select` })}
                className="shrink-0 rounded border px-1.5 py-1 text-[11px]"
                style={{
                    borderColor: tokens.divider,
                    background: tokens.surfaceBackground,
                    color: tokens.textPrimary
                }}
                onChange={(event) => {
                    props.onChange(event.target.value);
                }}
            >
                {props.options.map((option) => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </select>
            </div>
            {props.detail === undefined ? null : <SettingsDetail>{props.detail}</SettingsDetail>}
        </div>
    );
}

export interface TextFieldProps {
    readonly label: string;
    readonly value: string;
    readonly placeholder?: string | undefined;
    readonly onCommit: (next: string) => void;
    readonly detail?: string | undefined;
    readonly testID?: string | undefined;
    /**
     * SET-020: show an "Apply" button, and show it ONLY while the typed text differs from the
     * committed value — the Swift Network row's affordance, which exists because a port is
     * something you deliberately apply rather than something that happens as you type.
     * Blur/Enter still commit, so the button is a second route, not the only one.
     */
    readonly apply?: boolean | undefined;
    /** A narrower, right-aligned input (the Swift port field is 80 pt, right-aligned). */
    readonly narrow?: boolean | undefined;
    /**
     * L83: `.textFieldStyle(.plain)` inside a bare `HStack` — no border, no fixed width, the
     * field simply takes the rest of the row (`SettingsView.swift:130-134`, the Worktrees base
     * path). The port's default is the bordered fixed `w-[180px]`, which clipped a long custom
     * path where the shipped field lets it run.
     */
    readonly plain?: boolean | undefined;
}

/**
 * A text value committed on blur or Enter, never per keystroke — a font family written on
 * every character would rewrite the ghostty config a dozen times for one edit.
 */
export function TextField(props: TextFieldProps): ReactElement {
    const [draft, setDraft] = useState<string | null>(null);
    useEffect(() => {
        setDraft(null);
    }, [props.value]);
    const shown = draft ?? props.value;
    const commit = (): void => {
        if (draft === null || draft === props.value) return;
        props.onCommit(draft);
    };
    return (
        <div
            className={ROW}
            {...(props.testID === undefined ? {} : { 'data-testid': props.testID })}
        >
            <div className="flex items-center justify-between gap-3">
            <div className="flex shrink-0 flex-col">
                <span className="text-[12px]" style={{ color: tokens.textPrimary }}>
                    {props.label}
                </span>
            </div>
            <span className={`flex items-center gap-2 ${props.plain === true ? 'min-w-0 flex-1' : 'shrink-0'}`}>
            <input
                type="text"
                aria-label={props.label}
                value={shown}
                placeholder={props.placeholder}
                {...(props.testID === undefined ? {} : { 'data-testid': `${props.testID}-input` })}
                className={
                    props.plain === true
                        ? // L83: no border and no width — `.textFieldStyle(.plain)` in an `HStack`
                          // is a field that ends where the row ends.
                          'min-w-0 flex-1 border-0 bg-transparent px-0 py-1 font-mono text-[11px] outline-none'
                        : `${props.narrow === true ? 'w-[80px] text-right' : 'w-[180px]'} shrink-0 rounded border px-1.5 py-1 font-mono text-[11px]`
                }
                style={{
                    ...(props.plain === true ? {} : { borderColor: tokens.divider }),
                    background: 'transparent',
                    color: tokens.textPrimary
                }}
                onChange={(event) => {
                    setDraft(event.target.value);
                }}
                onBlur={commit}
                onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        commit();
                    }
                    if (event.key === 'Escape') {
                        // The overlay's Escape closes the window; a field mid-edit means
                        // "cancel this edit" first, so the event stops here.
                        event.stopPropagation();
                        setDraft(null);
                    }
                }}
            />
            {props.apply === true && draft !== null && draft !== props.value ? (
                <button
                    type="button"
                    {...(props.testID === undefined ? {} : { 'data-testid': `${props.testID}-apply` })}
                    className="rounded border px-2 py-1 text-[11px]"
                    style={{
                        borderColor: tokens.accent,
                        color: tokens.textPrimary,
                        background: withAlpha(tokens.accent, 0.16)
                    }}
                    // `onMouseDown`: a click would blur the field first, which commits and
                    // removes this button before the click lands on it.
                    onMouseDown={(event) => {
                        event.preventDefault();
                        commit();
                        setDraft(null);
                    }}
                >
                    Apply
                </button>
            ) : null}
            </span>
            </div>
            {props.detail === undefined ? null : <SettingsDetail>{props.detail}</SettingsDetail>}
        </div>
    );
}
