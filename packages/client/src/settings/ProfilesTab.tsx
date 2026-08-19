/**
 * Settings ▸ Profiles (config-keybindings.md §9.5).
 *
 * A master–detail editor over the config file's `profile` lines. The file is the source of
 * truth in both directions: the drafts are seeded from the daemon's parsed (UNEXPANDED, so `~`
 * round-trips) profiles, every commit sends the WHOLE set through `set-profiles`, and the
 * broadcast that follows re-seeds the drafts. Nothing is stored client-side.
 *
 * The §9.5 rules that are easy to lose and are therefore enforced in `model.ts` rather than in
 * a handler: `default` is pinned first, synthesized when absent, its name locked and its lines
 * omitted from the file while it has no vars; every other profile carries a `NEX_PROFILE`
 * marker var so a name-only profile survives the round-trip; `:` and `=` are stripped from
 * names as typed and `=` from var keys, because either would break the line format.
 *
 * One deliberate divergence: the Swift editor writes through on EVERY keystroke. Here a commit
 * is a blur / Enter / structural change (add or remove a profile or a var). The file ends up
 * identical, but a rename does not produce one daemon write, one file write and one broadcast
 * per character typed.
 */

import type { WsProfile } from '@nex/protocol';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import { tokens, withAlpha } from '../chrome';
import {
    DEFAULT_PROFILE_NAME,
    PROFILE_MARKER_VAR,
    nextProfileName,
    profileDrafts,
    profileNameError,
    profilesForWrite,
    sanitizeProfileName,
    sanitizeVarKey,
    type ProfileDraft
} from './model';
import type { SettingsActions, SettingsPaths } from './types';
import { SettingsButton, SettingsFooterNote, SettingsSection } from './ui';

export interface ProfilesTabProps {
    readonly profiles: readonly WsProfile[];
    readonly actions: SettingsActions;
    readonly paths: SettingsPaths;
}

export function ProfilesTab(props: ProfilesTabProps): ReactElement {
    const incoming = useMemo(() => profileDrafts(props.profiles), [props.profiles]);
    const [drafts, setDrafts] = useState<readonly ProfileDraft[]>(incoming);
    const [selected, setSelected] = useState(0);
    /** The shape we expect the daemon to echo back, so our own write does not clobber typing. */
    const expected = useRef<string | null>(null);

    useEffect(() => {
        const signature = JSON.stringify(incoming);
        if (signature === expected.current) return;
        expected.current = signature;
        setDrafts(incoming);
    }, [incoming]);

    const commit = (next: readonly ProfileDraft[]): void => {
        setDrafts(next);
        const profiles = profilesForWrite(next);
        expected.current = JSON.stringify(profileDrafts(profiles));
        props.actions.setProfiles(profiles);
    };

    const index = Math.min(selected, Math.max(drafts.length - 1, 0));
    const current = drafts[index];
    const nameError = current === undefined ? null : profileNameError(drafts, index, current.name);

    const patch = (position: number, next: ProfileDraft): readonly ProfileDraft[] =>
        drafts.map((draft, at) => (at === position ? next : draft));

    return (
        <div className="flex flex-col gap-4" data-testid="settings-tab-profiles">
            <SettingsSection
                title="Profiles"
                hint="Named environment sets, injected when a pane's shell starts. One workspace per Claude account is the flagship use."
                testID="profiles-list-section"
            >
                <div className="flex gap-3">
                    <div
                        role="listbox"
                        aria-label="Profiles"
                        data-testid="profiles-list"
                        className="flex w-40 shrink-0 flex-col gap-0.5 overflow-hidden rounded border p-1"
                        style={{ borderColor: tokens.divider }}
                    >
                        {drafts.map((draft, position) => (
                            <button
                                key={`${draft.name}-${String(position)}`}
                                type="button"
                                role="option"
                                aria-selected={position === index}
                                data-testid={`profile-row-${draft.name}`}
                                className="truncate rounded px-2 py-1 text-left text-[12px]"
                                style={{
                                    background: position === index ? withAlpha(tokens.accent, 0.18) : 'transparent',
                                    color: tokens.textPrimary
                                }}
                                onClick={() => {
                                    setSelected(position);
                                }}
                            >
                                {draft.name === '' ? '(unnamed)' : draft.name}
                            </button>
                        ))}
                        <SettingsButton
                            testID="profile-add"
                            onClick={() => {
                                const next = [...drafts, { name: nextProfileName(drafts), vars: [] }];
                                setSelected(next.length - 1);
                                // A brand-new profile has no vars, so §9.5's writer would drop
                                // it — the marker var is what gives it a line. `profilesForWrite`
                                // adds it, so this commit really does create the profile.
                                commit(next);
                            }}
                        >
                            + Add Profile
                        </SettingsButton>
                    </div>

                    {current === undefined ? null : (
                        <div className="flex min-w-0 flex-1 flex-col gap-2" data-testid="profile-detail">
                            <div className="flex items-center gap-2">
                                <input
                                    aria-label="Profile name"
                                    data-testid="profile-name"
                                    disabled={index === 0}
                                    className="min-w-0 flex-1 rounded border bg-transparent px-1.5 py-1 text-[12px] outline-none disabled:opacity-60"
                                    style={{
                                        borderColor: nameError === null ? tokens.divider : '#E0685F',
                                        color: tokens.textPrimary
                                    }}
                                    value={current.name}
                                    onChange={(event) => {
                                        setDrafts(patch(index, { ...current, name: sanitizeProfileName(event.target.value) }));
                                    }}
                                    onBlur={() => {
                                        if (nameError !== null) {
                                            setDrafts(incoming);
                                            return;
                                        }
                                        commit(patch(index, { ...current, name: current.name.trim() }));
                                    }}
                                    onKeyDown={(event) => {
                                        if (event.key === 'Enter') event.currentTarget.blur();
                                        if (event.key === 'Escape') {
                                            event.stopPropagation();
                                            setDrafts(incoming);
                                        }
                                    }}
                                />
                                <SettingsButton
                                    tone="danger"
                                    testID="profile-remove"
                                    disabled={index === 0}
                                    onClick={() => {
                                        const next = drafts.filter((_, at) => at !== index);
                                        setSelected(Math.max(index - 1, 0));
                                        commit(next);
                                    }}
                                >
                                    Remove Profile
                                </SettingsButton>
                            </div>

                            {nameError === null ? null : (
                                <p data-testid="profile-name-error" className="text-[11px]" style={{ color: '#E0685F' }}>
                                    {nameError}
                                </p>
                            )}

                            {index === 0 ? (
                                <p className="text-[11px]" style={{ color: tokens.textTertiary }}>
                                    Built-in baseline — applies to every workspace without an explicit profile.
                                </p>
                            ) : null}

                            <div
                                data-testid="profile-marker-row"
                                className="flex items-center gap-2 rounded px-2 py-1 text-[11px]"
                                style={{ background: withAlpha('#808080', 0.1), color: tokens.textTertiary }}
                                title="Injected automatically — always matches the profile name"
                            >
                                <span aria-hidden>🔒</span>
                                <span className="font-mono">{`${PROFILE_MARKER_VAR} = ${current.name}`}</span>
                            </div>

                            {current.vars.map((entry, position) => (
                                <div key={String(position)} className="flex items-center gap-2">
                                    <input
                                        aria-label={`Variable ${String(position + 1)} key`}
                                        data-testid={`profile-var-key-${String(position)}`}
                                        className="w-40 rounded border bg-transparent px-1.5 py-1 font-mono text-[12px] outline-none"
                                        style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                                        value={entry.key}
                                        onChange={(event) => {
                                            const vars = current.vars.map((existing, at) =>
                                                at === position
                                                    ? { ...existing, key: sanitizeVarKey(event.target.value) }
                                                    : existing
                                            );
                                            setDrafts(patch(index, { ...current, vars }));
                                        }}
                                        onBlur={() => {
                                            commit(drafts);
                                        }}
                                    />
                                    <input
                                        aria-label={`Variable ${String(position + 1)} value`}
                                        data-testid={`profile-var-value-${String(position)}`}
                                        placeholder="leading ~ expands at spawn"
                                        className="min-w-0 flex-1 rounded border bg-transparent px-1.5 py-1 font-mono text-[12px] outline-none"
                                        style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                                        value={entry.value}
                                        onChange={(event) => {
                                            const vars = current.vars.map((existing, at) =>
                                                at === position ? { ...existing, value: event.target.value } : existing
                                            );
                                            setDrafts(patch(index, { ...current, vars }));
                                        }}
                                        onBlur={() => {
                                            commit(drafts);
                                        }}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter') event.currentTarget.blur();
                                        }}
                                    />
                                    <SettingsButton
                                        testID={`profile-var-remove-${String(position)}`}
                                        ariaLabel={`Remove variable ${entry.key}`}
                                        onClick={() => {
                                            commit(
                                                patch(index, {
                                                    ...current,
                                                    vars: current.vars.filter((_, at) => at !== position)
                                                })
                                            );
                                        }}
                                    >
                                        −
                                    </SettingsButton>
                                </div>
                            ))}

                            <div>
                                <SettingsButton
                                    testID="profile-var-add"
                                    onClick={() => {
                                        // An empty row is a UI-only state: the writer drops blank
                                        // keys, so nothing reaches the file until it is filled in.
                                        setDrafts(patch(index, { ...current, vars: [...current.vars, { key: '', value: '' }] }));
                                    }}
                                >
                                    + Add Variable
                                </SettingsButton>
                            </div>
                        </div>
                    )}
                </div>
            </SettingsSection>

            <SettingsFooterNote>
                Config: <span className="font-mono">{props.paths.nexConfig}</span>. Changes apply to panes opened
                afterwards — live panes keep the environment they were born with. A workspace with no explicit
                profile uses <span className="font-mono">{DEFAULT_PROFILE_NAME}</span>.
            </SettingsFooterNote>
        </div>
    );
}
