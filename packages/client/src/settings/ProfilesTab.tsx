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
 *
 * ## Deselection, and why this rail has a gesture the spec never names (§SET-080)
 *
 * The Swift pane shows "No profile selected" whenever its `List(selection:)` has none, and in
 * SwiftUI that state is reachable for free: clicking the list's empty space below the rows
 * deselects. This rail is a column of buttons, so the state existed with nothing able to enter
 * it — a placeholder no user could see. §9.5 of `config-keybindings.md` describes load, naming,
 * add, remove and write-through and says nothing at all about selection, so there is no spec
 * behaviour to match; what is matched instead is the *mechanism* the Swift gets it from:
 *
 *   - **Click the rail's empty space** — the same gesture as the SwiftUI list, guarded on the
 *     click landing on the rail itself rather than on a row (a click on a row selects it).
 *   - **Escape while the focus is in the rail** — the keyboard equivalent, because a mouse-only
 *     affordance is not one. It follows the overlay's own documented rule that Escape means
 *     "the innermost thing that is open": with a profile selected the rail consumes the key and
 *     clears it, and with nothing selected the key falls through and Settings closes.
 *
 * Recorded as a divergence in `docs/capabilities/09-settings-config.md` §SET-080 rather than
 * claimed as parity: it is the same end state as the Swift, reached by a gesture this port had
 * to choose.
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
import { PersonBadgeKeyGlyph } from './glyphs';
import {
    SettingsButton,
    SettingsEmptyState,
    SettingsFooterNote,
    SettingsSection,
    hoverBackground,
    useHover
} from './ui';

/**
 * One row in the profile rail. H11: a `List` row in AppKit lights under the pointer and this
 * one did not, so the rail read as a column of labels rather than a list you can pick from.
 * The selected fill wins, exactly as it does in the Settings tab rail.
 */
function ProfileRow(props: {
    readonly name: string;
    readonly selected: boolean;
    readonly onSelect: () => void;
}): ReactElement {
    const { hovered, hoverProps } = useHover(!props.selected);
    return (
        <button
            type="button"
            role="option"
            aria-selected={props.selected}
            data-testid={`profile-row-${props.name}`}
            className="flex items-center gap-1.5 truncate rounded px-2 py-1 text-left text-[12px] transition-colors duration-100"
            style={{
                background: props.selected
                    ? withAlpha(tokens.accent, 0.18)
                    : hoverBackground(hovered, 'transparent'),
                color: tokens.textPrimary
            }}
            {...hoverProps}
            onClick={props.onSelect}
        >
            {/* M47: `ProfilesSettingsView.swift:120-124` is `Label(name, systemImage:
                "person.badge.key")` — the rail rows carry the glyph, which is what makes the
                column read as a list of profiles rather than a list of words. */}
            <span aria-hidden className="flex shrink-0 items-center" style={{ color: tokens.textSecondary }}>
                <PersonBadgeKeyGlyph size={12} />
            </span>
            <span className="min-w-0 truncate">{props.name === '' ? '(unnamed)' : props.name}</span>
        </button>
    );
}

export interface ProfilesTabProps {
    readonly profiles: readonly WsProfile[];
    readonly actions: SettingsActions;
    readonly paths: SettingsPaths;
}

export function ProfilesTab(props: ProfilesTabProps): ReactElement {
    const incoming = useMemo(() => profileDrafts(props.profiles), [props.profiles]);
    const [drafts, setDrafts] = useState<readonly ProfileDraft[]>(incoming);
    /** `null` is "no profile selected" — the state the detail placeholder renders (§SET-080). */
    const [selected, setSelected] = useState<number | null>(0);
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

    const index = selected === null ? -1 : Math.min(selected, Math.max(drafts.length - 1, 0));
    const current = index < 0 ? undefined : drafts[index];
    const nameError = current === undefined ? null : profileNameError(drafts, index, current.name);

    const patch = (position: number, next: ProfileDraft): readonly ProfileDraft[] =>
        drafts.map((draft, at) => (at === position ? next : draft));

    return (
        <div className="flex flex-col gap-4" data-testid="settings-tab-profiles">
            {/*
             * L79's `plain`: `ProfilesSettingsView.swift` is a master–detail split, not a `Form`
             * — its one child here is that whole split, which a grouped card would box twice.
             */}
            <SettingsSection
                plain
                title="Profiles"
                hint="Named environment sets, injected when a pane's shell starts. One workspace per Claude account is the flagship use."
                testID="profiles-list-section"
            >
                <div className="flex gap-3">
                    <div
                        role="listbox"
                        aria-label="Profiles"
                        data-testid="profiles-list"
                        title="Click empty space, or press Escape, to clear the selection"
                        className="flex w-40 shrink-0 flex-col gap-0.5 overflow-hidden rounded border p-1"
                        style={{ borderColor: tokens.divider }}
                        /*
                         * §SET-080's two deselect gestures (see the module note). The click is
                         * guarded on the rail ITSELF being the target — a click that landed on a
                         * row or on Add Profile bubbles up here too, and those select rather
                         * than clear.
                         */
                        onClick={(event) => {
                            if (event.target !== event.currentTarget) return;
                            setSelected(null);
                        }}
                        onKeyDown={(event) => {
                            if (event.key !== 'Escape' || selected === null) return;
                            // Consumed only when there IS a selection, so a second Escape (or
                            // one pressed with nothing selected) still closes Settings.
                            event.stopPropagation();
                            event.preventDefault();
                            setSelected(null);
                        }}
                    >
                        {drafts.map((draft, position) => (
                            <ProfileRow
                                key={`${draft.name}-${String(position)}`}
                                name={draft.name}
                                selected={position === index}
                                onSelect={() => {
                                    setSelected(position);
                                }}
                            />
                        ))}
                        {/* L80: `.help("Add profile")` (`ProfilesSettingsView.swift:101`). */}
                        <SettingsButton
                            testID="profile-add"
                            title="Add profile"
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

                    {/*
                     * SET-080's detail placeholder. The Swift pane distinguished "No workspace
                     * profiles" (with an inline Add Profile) from "No profile selected", and
                     * explained what a profile IS in the empty case. The first state is
                     * unreachable in BOTH apps — the built-in `default` baseline is always
                     * synthesized, in the Swift too — so the placeholder covers the second, and
                     * says what the Swift copy said. It is reached by deselecting in the rail
                     * (click its empty space, or Escape — see the module note), and also when a
                     * selection goes away under a concurrent write.
                     */}
                    {current === undefined ? (
                        // M45: `ProfilesSettingsView.swift:125-141` opens this placeholder with
                        // `Image(systemName: "person.badge.key").font(.system(size: 34))` in
                        // `.tertiary`, centred in the whole detail column with no card behind it.
                        <div className="flex min-w-0 flex-1 flex-col">
                            <SettingsEmptyState
                                testID="profile-detail-placeholder"
                                glyph={<PersonBadgeKeyGlyph size={34} />}
                                // L92: `.font(.headline)` (`ProfilesSettingsView.swift:128`) — the
                                // one empty state of the four whose title is a HEADING (body size,
                                // semibold, primary) rather than a `.secondary` line. The
                                // explanation's `.frame(maxWidth: 360)` is the shared recipe's.
                                headline
                                title="No profile selected"
                                detail="A profile is a named set of environment variables injected into every pane that starts in a workspace assigned to it."
                            >
                                <SettingsButton
                                    testID="profile-add-empty"
                                    onClick={() => {
                                        const next = [...drafts, { name: nextProfileName(drafts), vars: [] }];
                                        setSelected(next.length - 1);
                                        commit(next);
                                    }}
                                >
                                    + Add Profile
                                </SettingsButton>
                            </SettingsEmptyState>
                        </div>
                    ) : (
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
                                {/* The built-in baseline cannot be removed (§9.5) — and a 40%
                                    opacity red button does not say that, which is why the audit
                                    read it as an offer (run-B m5). Still disabled, now in the
                                    tone of an unavailable control rather than a destructive one,
                                    and with a tooltip that gives the reason. */}
                                <SettingsButton
                                    tone={index === 0 ? 'default' : 'danger'}
                                    testID="profile-remove"
                                    disabled={index === 0}
                                    title={
                                        index === 0
                                            ? `The built-in "${DEFAULT_PROFILE_NAME}" profile can't be removed`
                                            : 'Remove this profile'
                                    }
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

                            {/*
                             * SET-080's "No workspace profiles" state, in the only shape it can
                             * take here. The Swift pane could show an EMPTY list; this one never
                             * can, because the built-in `default` baseline is always synthesized
                             * (§9.5). The reachable equivalent is "default is all there is": say
                             * what a profile is for, and offer the same inline Add the Swift
                             * placeholder carried, so the tab is not a dead end on a fresh config.
                             */}
                            {drafts.length === 1 && current.vars.length === 0 ? (
                                <div
                                    data-testid="profiles-none-yet"
                                    className="flex flex-col items-start gap-1 rounded px-2 py-2"
                                    style={{ background: withAlpha('#808080', 0.06) }}
                                >
                                    <span className="text-[11px]" style={{ color: tokens.textSecondary }}>
                                        No workspace profiles yet.
                                    </span>
                                    <span className="text-[11px]" style={{ color: tokens.textTertiary }}>
                                        A profile is a named set of environment variables injected into every
                                        pane that starts in a workspace assigned to it — one per Claude
                                        account is the flagship use.
                                    </span>
                                    <SettingsButton
                                        testID="profile-add-inline"
                                        onClick={() => {
                                            const next = [
                                                ...drafts,
                                                { name: nextProfileName(drafts), vars: [] }
                                            ];
                                            setSelected(next.length - 1);
                                            commit(next);
                                        }}
                                    >
                                        + Add Profile
                                    </SettingsButton>
                                </div>
                            ) : null}

                            {/*
                             * M47: `ProfilesSettingsView.swift:178-180` —
                             * `Text("Environment Variables").font(.subheadline.weight(.semibold))
                             * .foregroundStyle(.secondary)`. Without it the variable rows start
                             * straight after the name field with nothing naming what they are.
                             */}
                            <span
                                data-testid="profile-vars-heading"
                                className="pt-1 text-[12px] font-semibold"
                                style={{ color: tokens.textSecondary }}
                            >
                                Environment Variables
                            </span>

                            {/*
                             * M47: the locked marker is a FAKE VAR ROW, which is the whole reason
                             * `ProfilesSettingsView.swift:208-228` models it as two disabled
                             * `TextField`s with a `Text("=")` between them rather than as a label:
                             * it lines up, column for column, with the editable rows under it. The
                             * port had flattened it to one tinted mono strip, which lined up with
                             * nothing.
                             */}
                            <div
                                data-testid="profile-marker-row"
                                className="flex items-center gap-1.5"
                                title="Injected automatically — always matches the profile name"
                            >
                                <input
                                    readOnly
                                    disabled
                                    aria-label="Marker variable key"
                                    data-testid="profile-marker-key"
                                    className="w-40 rounded border bg-transparent px-1.5 py-1 font-mono text-[12px] outline-none disabled:opacity-60"
                                    style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                                    value={PROFILE_MARKER_VAR}
                                />
                                <span aria-hidden className="text-[12px]" style={{ color: tokens.textTertiary }}>
                                    =
                                </span>
                                <input
                                    readOnly
                                    disabled
                                    aria-label="Marker variable value"
                                    data-testid="profile-marker-value"
                                    className="min-w-0 flex-1 rounded border bg-transparent px-1.5 py-1 font-mono text-[12px] outline-none disabled:opacity-60"
                                    style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                                    value={current.name}
                                />
                                <span
                                    aria-hidden
                                    className="shrink-0 text-[11px]"
                                    style={{ color: tokens.textTertiary }}
                                >
                                    🔒
                                </span>
                            </div>

                            {current.vars.map((entry, position) => (
                                <div key={String(position)} className="flex items-center gap-1.5">
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
                                    {/* `Text("=")` (`ProfilesSettingsView.swift:249-250`) — and
                                        the reason the marker row above lines up with this one. */}
                                    <span aria-hidden className="text-[12px]" style={{ color: tokens.textTertiary }}>
                                        =
                                    </span>
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
                                    {/* L80: `.help("Remove variable")`
                                        (`ProfilesSettingsView.swift:262`). */}
                                    <SettingsButton
                                        testID={`profile-var-remove-${String(position)}`}
                                        ariaLabel={`Remove variable ${entry.key}`}
                                        title="Remove variable"
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
