/**
 * A one-field prompt as a bottom sheet: the phone's stand-in for the inline rename field a pane
 * header offers under a mouse. The field sits at the top of the sheet, above the keyboard.
 */

import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';

import { tokens } from '../chrome/tokens';
import { PHONE_ROW_MIN_PX, PhoneSheet, PhoneSheetHeader } from './ui';

export interface PhonePromptSheetProps {
    readonly open: boolean;
    readonly title: string;
    readonly initial: string;
    readonly placeholder?: string | undefined;
    readonly submitLabel?: string | undefined;
    readonly onSubmit: (value: string) => void;
    readonly onClose: () => void;
}

export function PhonePromptSheet(props: PhonePromptSheetProps): ReactElement | null {
    const [value, setValue] = useState(props.initial);
    const inputRef = useRef<HTMLInputElement | null>(null);

    // Re-seed on every open: a rename prompt shows the CURRENT name, not the last one typed.
    useEffect(() => {
        if (props.open) setValue(props.initial);
    }, [props.open, props.initial]);

    // The field takes the caret after the sheet's own focus lands, so the keyboard comes up for
    // the thing the person opened the sheet to type into.
    useEffect(() => {
        if (!props.open) return;
        const frame = requestAnimationFrame(() => inputRef.current?.focus());
        return () => cancelAnimationFrame(frame);
    }, [props.open]);

    const submit = (event: FormEvent): void => {
        event.preventDefault();
        const trimmed = value.trim();
        if (trimmed.length === 0) return;
        props.onSubmit(trimmed);
        props.onClose();
    };

    return (
        <PhoneSheet open={props.open} side="bottom" label={props.title} testID="phone-prompt" onClose={props.onClose}>
            <PhoneSheetHeader title={props.title} testID="phone-prompt-header" onClose={props.onClose} />
            <form className="flex items-center gap-2 px-3 py-2" onSubmit={submit}>
                <input
                    ref={inputRef}
                    data-testid="phone-prompt-field"
                    className="min-w-0 flex-1 rounded border px-3 text-[16px] outline-none"
                    style={{
                        minHeight: `${String(PHONE_ROW_MIN_PX)}px`,
                        background: tokens.windowBackground,
                        borderColor: tokens.divider,
                        color: tokens.textPrimary
                    }}
                    value={value}
                    placeholder={props.placeholder ?? ''}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    enterKeyHint="done"
                    onChange={(event) => setValue(event.target.value)}
                />
                <button
                    type="submit"
                    data-testid="phone-prompt-submit"
                    disabled={value.trim().length === 0}
                    className="flex shrink-0 items-center justify-center rounded px-3 text-[15px] font-semibold"
                    style={{
                        color: tokens.accent,
                        minHeight: `${String(PHONE_ROW_MIN_PX)}px`,
                        opacity: value.trim().length === 0 ? 0.4 : 1
                    }}
                >
                    {props.submitLabel ?? 'Save'}
                </button>
            </form>
        </PhoneSheet>
    );
}
