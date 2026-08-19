/**
 * Shared Settings primitives.
 *
 * Deliberately tiny and local: the chrome package owns the app's surfaces, and Settings is a
 * different kind of surface (form controls, not direct manipulation). Everything below paints
 * with the same `--nex-*` tokens, so a chrome theme change moves this window too.
 */

import type { CSSProperties, ReactElement, ReactNode } from 'react';

import { tokens, withAlpha } from '../chrome';

export interface SettingsSectionProps {
    readonly title: string;
    readonly hint?: string | undefined;
    readonly children: ReactNode;
    readonly testID?: string | undefined;
}

export function SettingsSection(props: SettingsSectionProps): ReactElement {
    return (
        <section className="flex flex-col gap-2" {...(props.testID === undefined ? {} : { 'data-testid': props.testID })}>
            <div className="flex flex-col gap-0.5">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: tokens.textTertiary }}>
                    {props.title}
                </h3>
                {props.hint === undefined ? null : (
                    <p className="text-[11px]" style={{ color: tokens.textTertiary }}>
                        {props.hint}
                    </p>
                )}
            </div>
            {props.children}
        </section>
    );
}

export interface SettingsRowProps {
    readonly label: string;
    readonly detail?: ReactNode;
    readonly children?: ReactNode;
    readonly testID?: string | undefined;
}

/** Label on the left, control on the right — the shape every form row in here takes. */
export function SettingsRow(props: SettingsRowProps): ReactElement {
    return (
        <div
            className="flex items-start justify-between gap-4 rounded px-2 py-2"
            style={{ background: withAlpha('#808080', 0.06) }}
            {...(props.testID === undefined ? {} : { 'data-testid': props.testID })}
        >
            <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[12px]" style={{ color: tokens.textPrimary }}>
                    {props.label}
                </span>
                {props.detail === undefined ? null : (
                    <span className="text-[11px]" style={{ color: tokens.textTertiary }}>
                        {props.detail}
                    </span>
                )}
            </div>
            <div className="flex shrink-0 items-center gap-2">{props.children}</div>
        </div>
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
}

const TONE_COLOR: Readonly<Record<SettingsButtonTone, string>> = {
    default: tokens.textSecondary,
    accent: tokens.accent,
    danger: '#E0685F'
};

export function SettingsButton(props: SettingsButtonProps): ReactElement {
    const tone = props.tone ?? 'default';
    const disabled = props.disabled === true;
    // `whitespace-nowrap`: a button label is a name, not prose. "Reset All to Defaults" wrapped
    // onto two lines in the Keybindings header (run-B's nit list), which reads as a paragraph
    // rather than a control; the copy beside it wraps instead.
    return (
        <button
            type="button"
            disabled={disabled}
            title={props.title ?? undefined}
            aria-label={props.ariaLabel ?? undefined}
            {...(props.testID === undefined ? {} : { 'data-testid': props.testID })}
            className="whitespace-nowrap rounded border px-2 py-1 text-[11px] disabled:opacity-40"
            style={{
                borderColor: tokens.divider,
                color: TONE_COLOR[tone],
                background: 'transparent',
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
}

/** A real checkbox: the accessible name is the row's label, so tests query it by role. */
export function SettingsToggle(props: ToggleProps): ReactElement {
    return (
        <input
            type="checkbox"
            role="switch"
            aria-label={props.label}
            checked={props.checked}
            {...(props.testID === undefined ? {} : { 'data-testid': props.testID })}
            onChange={(event) => {
                props.onChange(event.target.checked);
            }}
        />
    );
}

export interface KeyChipProps {
    readonly children: ReactNode;
    readonly style?: CSSProperties | undefined;
}

/** The `⌘⇧D` face used by trigger chips and the appearance read-outs. */
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
