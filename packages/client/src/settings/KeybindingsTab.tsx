/**
 * Settings ▸ Keybindings (config-keybindings.md §13.1, §13.2).
 *
 * The table is a **view of the config file**: rows come from the daemon's `keybindLines`
 * resolved through `@nex/core/config`, and every gesture is a `set-keybinding` /
 * `reset-keybindings` verb whose result arrives back as a `settings-changed` broadcast. There
 * is no local copy of the map to fall out of sync — a hand-edit and a click land in the same
 * place, which is the whole point of the daemon owning the file.
 *
 * Per §13.1 each row shows ALL of an action's triggers (configString-sorted) with an "×" that
 * removes just that one, a Record button, and a Reset enabled only when the row differs from
 * its shipped default. The recorder is `recorder.ts`'s pure rule set driven by a
 * capture-phase window listener, so a combo the browser would otherwise eat (⌘D, ⌘W…) is
 * intercepted before it reaches anything.
 */

import { keyTriggerConfigString, type KeyBindingMap, type NexAction } from '@nex/core/config';
import { useEffect, useRef, useState, type ReactElement } from 'react';

import { tokens, withAlpha } from '../chrome';
import { GlobalHotkeySection } from './GlobalHotkeySection';
import { hasCustomBindings, keybindingSections } from './model';
import { recordKeyEvent, type RecorderOutcome } from './recorder';
import type { SettingsActions } from './types';
import { KeyChip, SettingsButton, SettingsFooterNote } from './ui';

export interface KeybindingsTabProps {
    readonly bindings: KeyBindingMap;
    readonly actions: SettingsActions;
    readonly configPath: string;
    /**
     * §8's system-wide hotkey (SET-081…084, SET-093). Absent = the caller has no settings
     * snapshot to render it from, and the Global section is simply not shown — the rest of the
     * table still works, which is what a fixture-driven test needs.
     */
    readonly globalHotkey?: string | null | undefined;
    readonly globalHotkeyHideOnRepress?: boolean | undefined;
    /** A registration failure the Electron shell reported (SET-083). */
    readonly globalHotkeyError?: string | null | undefined;
}

interface RecordingState {
    readonly action: NexAction;
    readonly message: string | null;
    /**
     * SET-091's other half: which action holds the combo that was refused, so the message can
     * be clicked through to that row's own recorder. `null` for a refusal with no owner (no
     * modifier) or when the holder is the global hotkey, which has no row.
     */
    readonly conflictWith?: NexAction | null | undefined;
    /**
     * SET-090: the captured combo, shown for a beat before the row closes.
     *
     * The Swift sheet swapped its label to the chord (15 pt medium, primary colour) at the
     * moment of capture and then committed, so the user saw WHAT was captured rather than only
     * its consequence. A web row commits and re-renders in the same tick, so the feedback is
     * held explicitly: the button reads the chord, the write is already in flight, and the row
     * disarms when the timer fires (or immediately, when the daemon's broadcast lands first).
     */
    readonly captured?: string | undefined;
}

/** How long the captured chord is shown in the row before it disarms (SET-090). */
export const CAPTURED_FEEDBACK_MS = 700;

export function KeybindingsTab(props: KeybindingsTabProps): ReactElement {
    const [recording, setRecording] = useState<RecordingState | null>(null);
    const sections = keybindingSections(props.bindings);
    const bindingsRef = useRef(props.bindings);
    bindingsRef.current = props.bindings;
    const commit = props.actions.setKeybinding;
    const globalHotkeyRef = useRef(props.globalHotkey);
    globalHotkeyRef.current = props.globalHotkey;
    const rowsRef = useRef(new Map<NexAction, HTMLElement>());

    // The recorder owns the keyboard while it is open: capture phase + preventDefault, so the
    // browser's own ⌘D/⌘W never fire and the app's dispatcher (already gated by the overlay)
    // cannot see the combo either.
    useEffect(() => {
        if (recording === null || recording.captured !== undefined) return;
        const action = recording.action;
        const onKeyDown = (event: KeyboardEvent): void => {
            event.preventDefault();
            event.stopPropagation();
            const outcome: RecorderOutcome = recordKeyEvent(event, {
                bindings: bindingsRef.current,
                excluding: action,
                // SET-091: a combo the OS already consumes for the global hotkey is refused
                // with its own message rather than bound to something that will never fire.
                globalHotkey: globalHotkeyRef.current
            });
            if (outcome.kind === 'ignored') return;
            if (outcome.kind === 'cancelled') {
                setRecording(null);
                return;
            }
            if (outcome.kind === 'rejected' || outcome.kind === 'conflict') {
                setRecording({
                    action,
                    message: outcome.reason,
                    conflictWith: outcome.kind === 'conflict' ? outcome.action : null
                });
                return;
            }
            // §13.2: re-recording the action's own combo is a silent no-op commit.
            if (!outcome.unchanged) commit(action, outcome.config);
            // SET-090: show WHAT was captured before the row goes back to "Record".
            setRecording({ action, message: null, captured: outcome.display });
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [recording, commit]);

    // The captured-combo beat. Its own effect so the listener above is torn down the instant a
    // capture lands — a second keystroke during the feedback window must not record again.
    useEffect(() => {
        if (recording?.captured === undefined) return;
        const timer = setTimeout(() => {
            setRecording(null);
        }, CAPTURED_FEEDBACK_MS);
        return () => {
            clearTimeout(timer);
        };
    }, [recording]);

    return (
        <div className="flex flex-col gap-4" data-testid="settings-tab-keybindings">
            <div className="flex items-center justify-between gap-3">
                <p className="text-[11px]" style={{ color: tokens.textTertiary }}>
                    One trigger belongs to one action; an action can have several. Recording a combo that
                    is already taken is refused rather than stealing it.
                </p>
                <SettingsButton
                    testID="reset-all-keybindings"
                    disabled={!hasCustomBindings(props.bindings)}
                    onClick={() => {
                        props.actions.resetKeybindings(null);
                    }}
                >
                    Reset All to Defaults
                </SettingsButton>
            </div>

            {props.globalHotkey === undefined ? null : (
                <GlobalHotkeySection
                    hotkey={props.globalHotkey}
                    hideOnRepress={props.globalHotkeyHideOnRepress ?? true}
                    bindings={props.bindings}
                    actions={props.actions}
                    registrationError={props.globalHotkeyError}
                />
            )}

            {sections.map((section) => (
                <div key={section.category} className="flex flex-col gap-1">
                    <h3
                        className="text-[11px] font-semibold uppercase tracking-wide"
                        style={{ color: tokens.textTertiary }}
                    >
                        {section.category}
                    </h3>
                    <div
                        role="table"
                        aria-label={`${section.category} keybindings`}
                        className="flex flex-col overflow-hidden rounded border"
                        style={{ borderColor: tokens.divider }}
                    >
                        {section.rows.map((row) => {
                            const isRecording = recording?.action === row.action;
                            return (
                                <div
                                    key={row.action}
                                    role="row"
                                    data-testid={`keybinding-row-${row.action}`}
                                    ref={(element) => {
                                        // The conflict message's click-through needs to scroll
                                        // the OWNING row into view, which means knowing where
                                        // it is; a ref map is the smallest way to know.
                                        if (element === null) rowsRef.current.delete(row.action);
                                        else rowsRef.current.set(row.action, element);
                                    }}
                                    className="flex items-center gap-2 border-b px-2 py-1.5 last:border-b-0"
                                    style={{
                                        borderColor: tokens.divider,
                                        background: isRecording ? withAlpha(tokens.accent, 0.12) : 'transparent'
                                    }}
                                >
                                    <span role="cell" className="flex min-w-0 flex-1 flex-col">
                                        <span className="text-[12px]" style={{ color: tokens.textPrimary }}>
                                            {row.label}
                                        </span>
                                        {/* Refusals belong next to the row that was refused, not in a
                                            footer the user has to go looking for. */}
                                        {isRecording && recording.message !== null ? (
                                            <span className="flex items-center gap-2">
                                                <span
                                                    data-testid="recorder-message"
                                                    className="text-[11px]"
                                                    style={{ color: '#E0685F' }}
                                                >
                                                    {recording.message}
                                                </span>
                                                {/*
                                                 * SET-091's click-through. The Swift sheet named
                                                 * the holder and left the user to find it; the
                                                 * name is a link here, because the next thing a
                                                 * user wants after "Already bound to X" is to
                                                 * go and change X.
                                                 */}
                                                {recording.conflictWith === null ||
                                                recording.conflictWith === undefined ? null : (
                                                    <button
                                                        type="button"
                                                        data-testid="recorder-conflict-jump"
                                                        className="text-[11px] underline"
                                                        style={{ color: tokens.accent }}
                                                        onClick={() => {
                                                            const owner = recording.conflictWith;
                                                            if (owner === null || owner === undefined) return;
                                                            // `?.` on the METHOD too: jsdom
                                                            // (and any embedder without a
                                                            // layout) has no scrollIntoView,
                                                            // and jumping is a nicety — the
                                                            // arm below is the actual point.
                                                            rowsRef.current
                                                                .get(owner)
                                                                ?.scrollIntoView?.({ block: 'center' });
                                                            setRecording({ action: owner, message: null });
                                                        }}
                                                    >
                                                        Rebind it
                                                    </button>
                                                )}
                                            </span>
                                        ) : null}
                                    </span>

                                    <span role="cell" className="flex flex-wrap items-center gap-1">
                                        {row.triggers.length === 0 ? (
                                            <span
                                                data-testid={`keybinding-empty-${row.action}`}
                                                className="text-[11px]"
                                                style={{ color: tokens.textTertiary }}
                                            >
                                                —
                                            </span>
                                        ) : (
                                            row.triggers.map((chip) => (
                                                <span key={chip.config} className="flex items-center gap-0.5">
                                                    <KeyChip>{chip.display}</KeyChip>
                                                    <button
                                                        type="button"
                                                        data-testid={`keybinding-remove-${row.action}-${chip.config}`}
                                                        aria-label={`Remove ${chip.display} from ${row.label}`}
                                                        className="px-0.5 text-[11px]"
                                                        style={{ color: tokens.textTertiary }}
                                                        onClick={() => {
                                                            removeTrigger(props, row.action, chip.config);
                                                        }}
                                                    >
                                                        ×
                                                    </button>
                                                </span>
                                            ))
                                        )}
                                    </span>

                                    <span role="cell" className="flex items-center gap-2">
                                        <SettingsButton
                                            testID={`keybinding-record-${row.action}`}
                                            tone={isRecording ? 'accent' : 'default'}
                                            onClick={() => {
                                                setRecording(
                                                    isRecording ? null : { action: row.action, message: null }
                                                );
                                            }}
                                        >
                                            {isRecording
                                                ? (recording.captured ?? 'Press a key…')
                                                : 'Record'}
                                        </SettingsButton>
                                        {/*
                                         * SET-094: the sheet's Cancel button, which was bound to
                                         * `.cancelAction` — so Escape and a click do the same
                                         * thing. Escape already did; this is the click.
                                         */}
                                        {isRecording && recording.captured === undefined ? (
                                            <SettingsButton
                                                testID={`keybinding-cancel-${row.action}`}
                                                onClick={() => {
                                                    setRecording(null);
                                                }}
                                            >
                                                Cancel
                                            </SettingsButton>
                                        ) : null}
                                        <SettingsButton
                                            testID={`keybinding-reset-${row.action}`}
                                            disabled={row.isDefault}
                                            onClick={() => {
                                                props.actions.resetKeybindings(row.action);
                                            }}
                                        >
                                            Reset
                                        </SettingsButton>
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            ))}

            <SettingsFooterNote>
                Config: <span className="font-mono">{props.configPath}</span>. Escape cancels a recording;
                a combo needs a modifier unless it is Escape or F1–F12.
            </SettingsFooterNote>
        </div>
    );
}

/**
 * "×" on one chip. There is no "unbind this one trigger" verb — `set-keybinding` with a null
 * trigger drops them ALL — so the removal is expressed as: unbind the action, then re-bind the
 * triggers it keeps. Two writes, one visible result, and the file ends up with exactly the
 * `unbind` lines §5.3 would have produced.
 */
function removeTrigger(props: KeybindingsTabProps, action: NexAction, config: string): void {
    const remaining = [...props.bindings.values()]
        .filter((binding) => binding.action === action)
        .map((binding) => keyTriggerConfigString(binding.trigger))
        .filter((value) => value !== config);
    props.actions.setKeybinding(action, null);
    for (const trigger of remaining) props.actions.setKeybinding(action, trigger);
}
