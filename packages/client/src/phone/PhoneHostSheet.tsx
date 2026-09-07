/**
 * "Add host": a name and a pasted pairing URL (`phone/hosts.ts` explains why the list is the
 * phone's own). The URL field is the whole gesture; Paste reads the clipboard inside the tap so
 * the person does not have to long-press into the field.
 */

import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';

import { tokens } from '../chrome/tokens';
import { parsePairingURL, suggestedHostName } from './hosts';
import { PHONE_ROW_MIN_PX, PhoneButton, PhoneSheet, PhoneSheetHeader } from './ui';

export interface PhoneHostSheetProps {
    readonly open: boolean;
    readonly existingNames: readonly string[];
    readonly onAdd: (name: string, url: string) => void;
    readonly onClose: () => void;
    /** Injected for tests; the app reads `navigator.clipboard`. */
    readonly readClipboard?: (() => Promise<string>) | undefined;
}

async function defaultReadClipboard(): Promise<string> {
    const clipboard = (globalThis as { navigator?: { clipboard?: { readText?: () => Promise<string> } } }).navigator?.clipboard;
    if (clipboard?.readText === undefined) throw new Error('clipboard unavailable');
    return clipboard.readText();
}

const FIELD_CLASS = 'min-w-0 w-full rounded border px-3 text-[16px] outline-none';

export function PhoneHostSheet(props: PhoneHostSheetProps): ReactElement | null {
    const [name, setName] = useState('');
    const [url, setUrl] = useState('');
    const [error, setError] = useState<string | null>(null);
    const urlRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        if (!props.open) return;
        setName('');
        setUrl('');
        setError(null);
        const frame = requestAnimationFrame(() => urlRef.current?.focus());
        return () => cancelAnimationFrame(frame);
    }, [props.open]);

    const fieldStyle = {
        minHeight: `${String(PHONE_ROW_MIN_PX)}px`,
        background: tokens.windowBackground,
        borderColor: tokens.divider,
        color: tokens.textPrimary
    } as const;

    const submit = (event: FormEvent): void => {
        event.preventDefault();
        const parsed = parsePairingURL(url);
        if (!parsed.ok) {
            setError(parsed.error);
            return;
        }
        const label = name.trim().length > 0 ? name.trim() : suggestedHostName(parsed.hostname, props.existingNames);
        props.onAdd(label, parsed.url);
        props.onClose();
    };

    const paste = (): void => {
        const read = props.readClipboard ?? defaultReadClipboard;
        read().then(
            (text) => {
                setUrl(text.trim());
                setError(null);
            },
            () => {
                setError('the clipboard could not be read - long-press the field to paste');
            }
        );
    };

    return (
        <PhoneSheet open={props.open} side="bottom" label="Add host" testID="phone-host-sheet" onClose={props.onClose}>
            <PhoneSheetHeader title="Add host" testID="phone-host-sheet-header" onClose={props.onClose} />
            <form className="flex flex-col gap-3 px-3 py-3" onSubmit={submit} data-testid="phone-host-form">
                <label className="flex flex-col gap-1 text-[13px]" style={{ color: tokens.textSecondary }}>
                    Pairing URL
                    <span className="flex items-center gap-2">
                        <input
                            ref={urlRef}
                            data-testid="phone-host-url"
                            className={FIELD_CLASS}
                            style={fieldStyle}
                            value={url}
                            placeholder="https://mac.tailnet.ts.net/?token=kd_…"
                            inputMode="url"
                            autoCapitalize="off"
                            autoCorrect="off"
                            spellCheck={false}
                            onChange={(event) => {
                                setUrl(event.target.value);
                                setError(null);
                            }}
                        />
                        <PhoneButton testID="phone-host-paste" onClick={paste}>
                            Paste
                        </PhoneButton>
                    </span>
                </label>
                <label className="flex flex-col gap-1 text-[13px]" style={{ color: tokens.textSecondary }}>
                    Name (optional)
                    <input
                        data-testid="phone-host-name"
                        className={FIELD_CLASS}
                        style={fieldStyle}
                        value={name}
                        placeholder="the machine's name"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        onChange={(event) => setName(event.target.value)}
                    />
                </label>
                <span className="text-[12px]" style={{ color: tokens.textTertiary }}>
                    On that Mac: Settings ▸ Remote ▸ Pair a device, then copy the link here. The token stays on this phone.
                </span>
                {error === null ? null : (
                    <span data-testid="phone-host-error" role="alert" className="text-[13px]" style={{ color: '#E5484D' }}>
                        {error}
                    </span>
                )}
                <button
                    type="submit"
                    data-testid="phone-host-add"
                    className="flex items-center justify-center rounded text-[15px] font-semibold"
                    style={{ minHeight: `${String(PHONE_ROW_MIN_PX)}px`, background: tokens.accent, color: '#fff' }}
                >
                    Add host
                </button>
            </form>
        </PhoneSheet>
    );
}
