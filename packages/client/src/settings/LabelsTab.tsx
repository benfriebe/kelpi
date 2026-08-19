/**
 * Settings ▸ Labels (app-state-core.md §6).
 *
 * The preset list is DAEMON STATE (`labelPresets` on the mirror, advanced by the
 * `label-presets-changed` delta), not settings: it lives in the database, not the config file.
 * So this tab renders the mirror and pushes `add-label-preset` / `update-label-preset` /
 * `remove-label-preset`, and the list re-renders when the delta comes back.
 *
 * Two rules from §6.4 shape the UI:
 *
 *   - a preset applies to a workspace purely by NAME matching a string in `workspace.labels`,
 *     so renaming a preset silently unstyles every chip that used it. The rename field says so,
 *     and the row shows the in-use count that makes the consequence concrete.
 *   - deleting a preset "does NOT touch any workspace's labels — the label string keeps
 *     existing, its chip just renders neutral". Delete is therefore NOT gated on the preset
 *     being unused (that would contradict the spec); an in-use delete asks for confirmation and
 *     says exactly what will happen.
 *
 * The orphan section closes §6.5/§6.6's loop: any label applied somewhere with no preset gets a
 * one-click gray preset — the same back-fill the CLI's `workspace label` performs.
 */

import { useState, type ReactElement } from 'react';

import {
    WORKSPACE_COLORS,
    resolveLabelStyle,
    tokens,
    workspaceColorHex,
    withAlpha,
    type ChromeBucket,
    type ChromeLabelPreset
} from '../chrome';
import { labelUsage, orphanLabels, type LabelledWorkspace } from './model';
import type { SettingsActions } from './types';
import { SettingsButton, SettingsSection } from './ui';

export interface LabelsTabProps {
    readonly presets: readonly ChromeLabelPreset[];
    readonly workspaces: readonly LabelledWorkspace[];
    readonly actions: SettingsActions;
    readonly bucket?: ChromeBucket | undefined;
}

/** §6.2's one-string encoding, read back off a preset so the palette can show the current pick. */
function colorToken(preset: ChromeLabelPreset): string {
    return preset.color.kind === 'named' ? preset.color.color : preset.color.hex;
}

export function LabelsTab(props: LabelsTabProps): ReactElement {
    const bucket = props.bucket ?? 'dark';
    const [draftName, setDraftName] = useState('');
    const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
    const [confirming, setConfirming] = useState<string | null>(null);
    const usage = labelUsage(props.workspaces);
    const orphans = orphanLabels(props.workspaces, props.presets);

    const create = (): void => {
        const name = draftName.trim();
        if (name === '') return;
        props.actions.addLabelPreset({ name, color: 'gray' });
        setDraftName('');
    };

    return (
        <div className="flex flex-col gap-4" data-testid="settings-tab-labels">
            <SettingsSection
                title="Presets"
                hint="A label wears a preset's colors when its text matches the preset name exactly."
                testID="label-presets"
            >
                {props.presets.length === 0 ? (
                    <p data-testid="labels-empty" className="text-[12px]" style={{ color: tokens.textTertiary }}>
                        No presets yet. Labels you apply from the CLI show up here in gray.
                    </p>
                ) : null}

                {props.presets.map((preset) => {
                    const style = resolveLabelStyle(preset.name, props.presets, bucket);
                    const inUse = usage.get(preset.name) ?? 0;
                    const isRenaming = renaming?.id === preset.name;
                    return (
                        <div
                            key={preset.name}
                            data-testid={`label-preset-${preset.name}`}
                            className="flex flex-col gap-2 rounded px-2 py-2"
                            style={{ background: withAlpha('#808080', 0.06) }}
                        >
                            <div className="flex items-center gap-2">
                                <span
                                    data-testid={`label-chip-${preset.name}`}
                                    data-color={colorToken(preset)}
                                    className="rounded px-1.5 py-0.5 text-[11px]"
                                    style={{ background: style.background, color: style.text }}
                                >
                                    {preset.name}
                                </span>
                                <span className="text-[11px]" style={{ color: tokens.textTertiary }}>
                                    {inUse === 0 ? 'unused' : `${String(inUse)} workspace${inUse === 1 ? '' : 's'}`}
                                </span>
                                <span className="ml-auto flex items-center gap-2">
                                    <SettingsButton
                                        testID={`label-rename-${preset.name}`}
                                        onClick={() => {
                                            setRenaming(isRenaming ? null : { id: preset.name, value: preset.name });
                                        }}
                                    >
                                        Rename
                                    </SettingsButton>
                                    <SettingsButton
                                        tone="danger"
                                        testID={`label-delete-${preset.name}`}
                                        onClick={() => {
                                            if (inUse === 0) {
                                                props.actions.removeLabelPreset(preset.name);
                                                return;
                                            }
                                            setConfirming(confirming === preset.name ? null : preset.name);
                                        }}
                                    >
                                        Delete
                                    </SettingsButton>
                                </span>
                            </div>

                            <div className="flex flex-wrap items-center gap-1" role="group" aria-label={`${preset.name} color`}>
                                {WORKSPACE_COLORS.map((color) => {
                                    const selected = preset.color.kind === 'named' && preset.color.color === color;
                                    return (
                                        <button
                                            key={color}
                                            type="button"
                                            data-testid={`label-color-${preset.name}-${color}`}
                                            aria-label={`${color} for ${preset.name}`}
                                            aria-pressed={selected}
                                            className="h-4 w-4 rounded-full"
                                            style={{
                                                background: workspaceColorHex(color, bucket),
                                                outline: selected ? `2px solid ${tokens.accent}` : 'none',
                                                outlineOffset: '1px'
                                            }}
                                            onClick={() => {
                                                if (selected) return;
                                                props.actions.updateLabelPreset({ id: preset.name, color });
                                            }}
                                        />
                                    );
                                })}
                            </div>

                            {isRenaming ? (
                                <div className="flex items-center gap-2">
                                    <input
                                        autoFocus
                                        aria-label={`New name for ${preset.name}`}
                                        data-testid={`label-rename-field-${preset.name}`}
                                        className="min-w-0 flex-1 rounded border bg-transparent px-1.5 py-1 text-[12px] outline-none"
                                        style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                                        value={renaming.value}
                                        onChange={(event) => {
                                            setRenaming({ id: preset.name, value: event.target.value });
                                        }}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Escape') {
                                                event.stopPropagation();
                                                setRenaming(null);
                                                return;
                                            }
                                            if (event.key !== 'Enter') return;
                                            const next = renaming.value.trim();
                                            setRenaming(null);
                                            if (next === '' || next === preset.name) return;
                                            props.actions.updateLabelPreset({ id: preset.name, name: next });
                                        }}
                                    />
                                    <span className="text-[11px]" style={{ color: tokens.textTertiary }}>
                                        {inUse === 0
                                            ? 'Press Enter to rename'
                                            : 'Renaming unstyles the chips already using this name'}
                                    </span>
                                </div>
                            ) : null}

                            {confirming === preset.name ? (
                                <div
                                    data-testid={`label-delete-confirm-${preset.name}`}
                                    className="flex items-center gap-2 text-[11px]"
                                    style={{ color: tokens.textSecondary }}
                                >
                                    <span>
                                        {`Delete the preset? The label stays on ${String(inUse)} workspace${
                                            inUse === 1 ? '' : 's'
                                        } and renders neutral.`}
                                    </span>
                                    <SettingsButton
                                        tone="danger"
                                        testID={`label-delete-confirm-yes-${preset.name}`}
                                        onClick={() => {
                                            setConfirming(null);
                                            props.actions.removeLabelPreset(preset.name);
                                        }}
                                    >
                                        Delete anyway
                                    </SettingsButton>
                                    <SettingsButton
                                        testID={`label-delete-cancel-${preset.name}`}
                                        onClick={() => {
                                            setConfirming(null);
                                        }}
                                    >
                                        Cancel
                                    </SettingsButton>
                                </div>
                            ) : null}
                        </div>
                    );
                })}

                <div className="flex items-center gap-2">
                    <input
                        aria-label="New preset name"
                        placeholder="New preset…"
                        data-testid="label-new-name"
                        className="min-w-0 flex-1 rounded border bg-transparent px-1.5 py-1 text-[12px] outline-none"
                        style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                        value={draftName}
                        onChange={(event) => {
                            setDraftName(event.target.value);
                        }}
                        onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                                event.stopPropagation();
                                setDraftName('');
                                return;
                            }
                            if (event.key === 'Enter') create();
                        }}
                    />
                    <SettingsButton testID="label-add" disabled={draftName.trim() === ''} onClick={create}>
                        Add Preset
                    </SettingsButton>
                </div>
            </SettingsSection>

            {orphans.length === 0 ? null : (
                <SettingsSection
                    title="Labels without a preset"
                    hint="Applied to a workspace but not managed here — they render neutral until you give them one."
                    testID="label-orphans"
                >
                    <div className="flex flex-wrap items-center gap-2">
                        {orphans.map((label) => (
                            <SettingsButton
                                key={label}
                                testID={`label-adopt-${label}`}
                                onClick={() => {
                                    props.actions.addLabelPreset({ name: label, color: 'gray' });
                                }}
                            >
                                {`Add “${label}”`}
                            </SettingsButton>
                        ))}
                    </div>
                </SettingsSection>
            )}
        </div>
    );
}
