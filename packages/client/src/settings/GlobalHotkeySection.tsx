/**
 * Settings ▸ Keybindings ▸ Global (SET-081…SET-084, SET-093).
 *
 * The system-wide hotkey was readable from the config file and registered by the Electron shell
 * from the day the shell landed — but there was no way to *set* it except editing the file by
 * hand, which is the gap SET-081 records. This is the recorder for it.
 *
 * Four rules from `KeybindingsSettingsView.swift`, each visible here:
 *
 *   1. **The chip / em-dash row** (SET-081): the current hotkey as a chip with an ✕ that clears
 *      it, or an em-dash when unset, plus a Record button. The subtitle keeps the Swift promise
 *      that this needs no Accessibility permission.
 *   2. **"Press again to hide"** (SET-082) sits under the row and is DISABLED while no hotkey
 *      is set — a repress rule with nothing to repress is not a meaningful choice.
 *   3. **Registration failure** (SET-083, §APP-014) is an inline error carrying the OS's own
 *      reason. In the Swift app that came from Carbon's `OSStatus`; here the shell registers
 *      through Electron's `globalShortcut` and reports through the same wording ("This
 *      shortcut is already claimed by another app."), so the string a user reads is unchanged.
 *      **Its tone is destructive, deliberately unlike rule 4's amber.** The Swift view paints
 *      both warnings the same orange, and the two mean opposite things: a *failure* means the
 *      hotkey does not work at all and needs a different chord, while the *advisory* below
 *      means it works and something else will not. The row is `role="alert"`, because a
 *      registration failure is the one state here a screen reader has to be told about — it is
 *      reported asynchronously by another process, not in response to a keystroke.
 *      It comes off the `hotkey-status` broadcast (§SET-200/§SET-201): a report with `ok: true`
 *      — which is what CLEARING the hotkey and re-recording a working chord both produce —
 *      leaves `registrationError` null, so the error disappears with no state of its own.
 *   4. **The in-app collision advisory** (SET-084): a global hotkey that also matches an in-app
 *      binding wins while Nex is frontmost, so the in-app shortcut silently stops working. That
 *      is worth an advisory, not a refusal — the combination is legal and sometimes wanted.
 *
 * SET-093 is the recorder's own rule and the reason this does not simply reuse the row
 * recorder: recording the hotkey must **ignore a collision with the CURRENT global hotkey**
 * (re-recording what you already have is a no-op, not a conflict) while still rejecting a
 * collision with any in-app binding. `recordKeyEvent` takes an in-app binding map; the global
 * hotkey is not in it, so passing the map unchanged gives exactly that behaviour — the
 * `ignoreGlobalHotkey: true` flag is structural here rather than a parameter.
 */

import { keyTriggerDisplayString, parseKeyTrigger, type KeyBindingMap } from '@nex/core/config';
import { useEffect, useRef, useState, type ReactElement } from 'react';

import { actionForTrigger, tokens, withAlpha } from '../chrome';
import { actionLabel } from './catalog';
import { recordKeyEvent, type RecorderOutcome } from './recorder';
import type { SettingsActions } from './types';
import { KeyChip, SettingsButton, SettingsIconButton, SettingsRow, SettingsSection, SettingsToggle } from './ui';

/** The advisory colour the Swift view uses for its warnings (SET-084's shadow notice). */
export const WARNING_COLOR = '#D08A28';

/**
 * The destructive colour for a registration FAILURE (SET-083) — the same red the recorder's
 * own rejection message uses, so "this did not work" reads the same everywhere in Settings.
 */
export const FAILURE_COLOR = '#E0685F';

export interface GlobalHotkeySectionProps {
    /** The config-file trigger string (`"ctrl+alt+space"`), or null when unset. */
    readonly hotkey: string | null;
    readonly hideOnRepress: boolean;
    readonly bindings: KeyBindingMap;
    readonly actions: SettingsActions;
    /**
     * A registration failure reported by the shell, if any (SET-083). The web client has no
     * registrar of its own, so this is `undefined` in a browser and the row simply has no
     * warning — which is correct: nothing tried to register anything.
     */
    readonly registrationError?: string | null | undefined;
}

/**
 * §APP-014 / §SET-200 — the `hotkey-status` broadcast, as the row's error state.
 *
 * One rule, in one place, because the alternative (an inline ternary at the call site) is how
 * "the shell reported a failure and nothing rendered" happens: a report that is absent or `ok`
 * is NO error — which is what makes clearing the hotkey, or re-recording a chord that works,
 * take the message away without anything having to remember it was there — and a report that
 * failed always yields a sentence, even when the OS gave no reason. A silent `ok: false` is
 * the one outcome a user cannot act on.
 */
export function globalHotkeyErrorFrom(
    status: { readonly ok: boolean; readonly error: string | null } | null | undefined
): string | null {
    if (status === null || status === undefined || status.ok) return null;
    const reason = status.error?.trim() ?? '';
    return reason === '' ? 'The global hotkey could not be registered.' : reason;
}

/**
 * SET-084: does the global hotkey also belong to an in-app action?
 *
 * Exported because it is the whole of `globalHotkeyConflictWithInApp` and worth testing on its
 * own — a wrong answer here either nags about a combination that is fine or stays quiet about
 * one that will confuse the user for a week.
 */
export function inAppConflict(hotkey: string | null, bindings: KeyBindingMap): string | null {
    if (hotkey === null) return null;
    const trigger = parseKeyTrigger(hotkey);
    if (trigger === null) return null;
    const owner = actionForTrigger(bindings, trigger);
    return owner === null ? null : actionLabel(owner);
}

export function GlobalHotkeySection(props: GlobalHotkeySectionProps): ReactElement {
    const [recording, setRecording] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const recordRef = useRef<HTMLButtonElement | null>(null);
    const bindingsRef = useRef(props.bindings);
    bindingsRef.current = props.bindings;
    const commit = props.actions.setGeneralSetting;
    const commitRef = useRef(commit);
    commitRef.current = commit;

    useEffect(() => {
        if (!recording) return;
        const onKeyDown = (event: KeyboardEvent): void => {
            // Capture phase + preventDefault: the browser's own ⌘W/⌘D never fire and the app's
            // dispatcher (already gated by the overlay) cannot see the combo either.
            event.preventDefault();
            event.stopPropagation();
            // SET-093: the in-app map is the ONLY conflict source. The current global hotkey is
            // not in it, so re-recording the hotkey you already have commits silently.
            const outcome: RecorderOutcome = recordKeyEvent(event, { bindings: bindingsRef.current });
            if (outcome.kind === 'ignored') return;
            if (outcome.kind === 'cancelled') {
                setRecording(false);
                setMessage(null);
                return;
            }
            if (outcome.kind === 'rejected' || outcome.kind === 'conflict') {
                setMessage(outcome.reason);
                return;
            }
            setRecording(false);
            setMessage(null);
            commitRef.current('global-hotkey', outcome.config);
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
            window.removeEventListener('keydown', onKeyDown, true);
        };
    }, [recording]);

    const trigger = props.hotkey === null ? null : parseKeyTrigger(props.hotkey);
    const display = trigger === null ? null : keyTriggerDisplayString(trigger);
    const conflict = inAppConflict(props.hotkey, props.bindings);
    const failure = props.registrationError ?? null;

    return (
        <SettingsSection title="Global" testID="global-hotkey-section">
            <SettingsRow
                label="Global hotkey"
                detail="Works from any app. No Accessibility permission required."
                testID="global-hotkey-row"
            >
                {display === null ? (
                    <span data-testid="global-hotkey-empty" className="text-[11px]" style={{ color: tokens.textTertiary }}>
                        —
                    </span>
                ) : (
                    <span className="flex items-center gap-0.5">
                        <KeyChip>
                            <span data-testid="global-hotkey-chip">{display}</span>
                        </KeyChip>
                        {/* H11 / M43: the shared 16 px glyph target, hover-lit like the rest. */}
                        <SettingsIconButton
                            testID="global-hotkey-clear"
                            ariaLabel="Clear the global hotkey"
                            onClick={() => {
                                // `none` rather than an empty value: the parser accepts both,
                                // and the explicit word survives a human reading the file.
                                commit('global-hotkey', 'none');
                                // This button UNMOUNTS ITSELF: the chip it sits beside is gone
                                // once the hotkey is cleared. Leaving focus on a removed node
                                // drops it to `<body>`, outside the modal — and the Settings
                                // dialog listens for Escape on its own container, so Escape
                                // would silently stop closing the window. Hand focus to the
                                // Record button, which is the control the user reaches for next
                                // anyway. (The audit caught this as `settings-close` failing.)
                                recordRef.current?.focus();
                            }}
                        >
                            ×
                        </SettingsIconButton>
                    </span>
                )}
                <SettingsButton
                    testID="global-hotkey-record"
                    buttonRef={recordRef}
                    tone={recording ? 'accent' : 'default'}
                    onClick={() => {
                        setMessage(null);
                        setRecording(!recording);
                    }}
                >
                    {recording ? 'Press a key…' : 'Record'}
                </SettingsButton>
                {/* SET-094: the Swift sheet's Cancel, which shared `.cancelAction` with Escape. */}
                {recording ? (
                    <SettingsButton
                        testID="global-hotkey-cancel"
                        onClick={() => {
                            setRecording(false);
                            setMessage(null);
                            recordRef.current?.focus();
                        }}
                    >
                        Cancel
                    </SettingsButton>
                ) : null}
            </SettingsRow>

            {message === null ? null : (
                <span data-testid="global-hotkey-message" className="px-2 text-[11px]" style={{ color: '#E0685F' }}>
                    {message}
                </span>
            )}

            <SettingsRow
                label="Press again to hide"
                detail="A second press hides Nex when it is already frontmost, instead of re-raising it."
                testID="global-hotkey-repress-row"
            >
                <SettingsToggle
                    testID="global-hotkey-repress-toggle"
                    label="Press again to hide"
                    checked={props.hideOnRepress}
                    // SET-082: meaningless without a hotkey, so it is disabled rather than
                    // silently writing a key nothing will read.
                    disabled={props.hotkey === null}
                    onChange={(next) => {
                        commit('global-hotkey-hide-on-repress', next ? 'true' : 'false');
                    }}
                />
            </SettingsRow>

            {failure === null ? null : (
                <span
                    data-testid="global-hotkey-failure"
                    role="alert"
                    data-tone="destructive"
                    className="rounded px-2 py-1 text-[11px]"
                    style={{ color: FAILURE_COLOR, background: withAlpha(FAILURE_COLOR, 0.1) }}
                >
                    {/* The Swift row is a `Label(…, systemImage: "exclamationmark.triangle.fill")`;
                        the glyph is `aria-hidden` because the sentence beside it already says it. */}
                    <span aria-hidden>⚠ </span>
                    {failure}
                </span>
            )}

            {conflict === null ? null : (
                <span
                    data-testid="global-hotkey-conflict"
                    className="rounded px-2 py-1 text-[11px]"
                    style={{ color: WARNING_COLOR, background: withAlpha(WARNING_COLOR, 0.1) }}
                >
                    This is also bound to “{conflict}” in the app. While Nex is frontmost the global hotkey wins and
                    the in-app shortcut won&rsquo;t fire.
                </span>
            )}
        </SettingsSection>
    );
}
