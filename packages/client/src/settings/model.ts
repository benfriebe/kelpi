/**
 * Pure models behind the Settings tabs: the keybinding table, the profile editor's
 * load/write transforms, and label-preset usage.
 *
 * Everything here is a total function over data the daemon already sent. Keeping it out of the
 * components is what lets the awkward rules — §9.5's `default` synthesis, the `NEX_PROFILE`
 * marker round-trip, §5.4's "differs from its default list" reset predicate — be tested
 * directly rather than through a click.
 */

import {
    DEFAULT_KEYBINDINGS,
    keyTriggerConfigString,
    keyTriggerDisplayString,
    triggersForAction,
    type KeyBindingMap,
    type KelpiAction
} from '@kelpi/core/config';
import type { WsProfile } from '@kelpi/protocol';

import { actionLabel, actionsInCategory, VISIBLE_CATEGORIES, type SettingsCategory } from './catalog';

// ── keybinding table (§13.1) ────────────────────────────────────────────────────────

export interface TriggerChip {
    /** The config-file spelling — what `set-keybinding` sends. */
    readonly config: string;
    /** `⌘⇧D`-style, for the chip's face. */
    readonly display: string;
}

export interface KeybindingRow {
    readonly action: KelpiAction;
    readonly label: string;
    /** ALL bound triggers, `configString`-sorted (§13.1). */
    readonly triggers: readonly TriggerChip[];
    /** §13.1: Reset is enabled only when the trigger list differs from the default list. */
    readonly isDefault: boolean;
}

export interface KeybindingSection {
    readonly category: SettingsCategory;
    readonly rows: readonly KeybindingRow[];
}

function chips(bindings: KeyBindingMap, action: KelpiAction): TriggerChip[] {
    return triggersForAction(bindings, action).map((trigger) => ({
        config: keyTriggerConfigString(trigger),
        display: keyTriggerDisplayString(trigger)
    }));
}

/** True when the action's trigger set is exactly its shipped default set. */
export function isDefaultBinding(bindings: KeyBindingMap, action: KelpiAction): boolean {
    const current = triggersForAction(bindings, action).map(keyTriggerConfigString);
    const shipped = triggersForAction(DEFAULT_KEYBINDINGS, action).map(keyTriggerConfigString);
    return current.length === shipped.length && current.every((value, index) => value === shipped[index]);
}

/** The table: §13.1's six visible sections in fixed order, each in catalog order. */
export function keybindingSections(bindings: KeyBindingMap): KeybindingSection[] {
    return VISIBLE_CATEGORIES.map((category) => ({
        category,
        rows: actionsInCategory(category).map((action) => ({
            action,
            label: actionLabel(action),
            triggers: chips(bindings, action),
            isDefault: isDefaultBinding(bindings, action)
        }))
    }));
}

/** True when ANY action's bindings differ from the shipped map (drives "Reset All"). */
export function hasCustomBindings(bindings: KeyBindingMap): boolean {
    return VISIBLE_CATEGORIES.some((category) =>
        actionsInCategory(category).some((action) => !isDefaultBinding(bindings, action))
    );
}

// ── profiles (§9.5) ─────────────────────────────────────────────────────────────────

/** Reserved name; always exists, pinned first, never renamed or removed. */
export const DEFAULT_PROFILE_NAME = 'default';
/** The derived marker var: rendered locked, never editable, re-added on write. */
export const PROFILE_MARKER_VAR = 'NEX_PROFILE';

export interface ProfileVarDraft {
    readonly key: string;
    readonly value: string;
}

export interface ProfileDraft {
    readonly name: string;
    /** Editable vars only — the `NEX_PROFILE` marker is stripped on load, re-added on write. */
    readonly vars: readonly ProfileVarDraft[];
}

/** §9.5: `:` and `=` would break the line format, so they are stripped as typed. */
export function sanitizeProfileName(raw: string): string {
    return raw.replace(/[:=]/g, '');
}

/** §9.5: a var key may not contain `=`. */
export function sanitizeVarKey(raw: string): string {
    return raw.replace(/=/g, '');
}

/**
 * §9.5 load: `default` pinned FIRST (moved there if present, synthesized empty if not), the
 * `NEX_PROFILE` marker filtered out of the editable rows, vars sorted by key.
 */
export function profileDrafts(profiles: readonly WsProfile[]): ProfileDraft[] {
    const drafts: ProfileDraft[] = [];
    let defaultDraft: ProfileDraft = { name: DEFAULT_PROFILE_NAME, vars: [] };

    for (const profile of profiles) {
        const vars = Object.entries(profile.env)
            .filter(([key]) => key !== PROFILE_MARKER_VAR)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, value]) => ({ key, value }));
        if (profile.name === DEFAULT_PROFILE_NAME) {
            defaultDraft = { name: DEFAULT_PROFILE_NAME, vars };
            continue;
        }
        drafts.push({ name: profile.name, vars });
    }

    return [defaultDraft, ...drafts];
}

/**
 * §9.5 write-through: trim keys, drop blank ones, last duplicate wins; omit `default` while it
 * has no vars (it is re-synthesized on load, which keeps the file free of a marker-only line);
 * give every other profile its `NEX_PROFILE = <trimmed name>` so a name-only profile still has
 * a line and survives the round-trip.
 */
export function profilesForWrite(drafts: readonly ProfileDraft[]): WsProfile[] {
    const profiles: WsProfile[] = [];
    for (const draft of drafts) {
        const name = draft.name.trim();
        if (name === '') continue;
        const env: Record<string, string> = {};
        for (const entry of draft.vars) {
            const key = entry.key.trim();
            if (key === '' || key === PROFILE_MARKER_VAR) continue;
            env[key] = entry.value;
        }
        const isDefault = name === DEFAULT_PROFILE_NAME;
        if (isDefault && Object.keys(env).length === 0) continue;
        profiles.push({ name, env: isDefault ? env : { ...env, [PROFILE_MARKER_VAR]: name } });
    }
    return profiles;
}

/** §9.5 "Add profile": `profile-<n>`, n starting at count+1 and bumped past collisions. */
export function nextProfileName(drafts: readonly ProfileDraft[]): string {
    const taken = new Set(drafts.map((draft) => draft.name.trim()));
    let index = drafts.length + 1;
    let candidate = `profile-${String(index)}`;
    while (taken.has(candidate)) {
        index += 1;
        candidate = `profile-${String(index)}`;
    }
    return candidate;
}

/**
 * Why a draft cannot be committed, or null when it can. §9.5 refuses renaming any profile TO
 * `default`, and a duplicate name would silently merge in the file (repeated `profile` lines
 * with the same name are one profile), so both are refused at the field.
 */
export function profileNameError(drafts: readonly ProfileDraft[], index: number, raw: string): string | null {
    const name = raw.trim();
    if (index === 0) return null; // the built-in baseline: the field is disabled anyway
    if (name === '') return 'A profile needs a name';
    if (name === DEFAULT_PROFILE_NAME) return '“default” is the built-in baseline';
    const clash = drafts.some((draft, position) => position !== index && draft.name.trim() === name);
    return clash ? `“${name}” already exists` : null;
}

// ── labels (app-state-core.md §6) ───────────────────────────────────────────────────

export interface LabelledWorkspace {
    readonly labels: readonly string[];
}

/** How many workspaces wear each label — the Labels tab's "in use" count. */
export function labelUsage(workspaces: readonly LabelledWorkspace[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const workspace of workspaces) {
        for (const label of workspace.labels) {
            counts.set(label, (counts.get(label) ?? 0) + 1);
        }
    }
    return counts;
}

/**
 * Labels applied somewhere that have no preset. §6.5's migration and §6.6's CLI back-fill are
 * supposed to make this empty; when it is not, the tab offers a one-click "add preset" so the
 * orphan is visible rather than silently rendering neutral forever.
 */
export function orphanLabels(
    workspaces: readonly LabelledWorkspace[],
    presets: readonly { readonly name: string }[]
): string[] {
    const known = new Set(presets.map((preset) => preset.name));
    const seen: string[] = [];
    for (const workspace of workspaces) {
        for (const label of workspace.labels) {
            if (known.has(label) || seen.includes(label)) continue;
            seen.push(label);
        }
    }
    return seen;
}
