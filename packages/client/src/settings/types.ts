/**
 * The Settings surface's prop shapes.
 *
 * Same rule the chrome package follows: nothing under `settings/` reads the store or opens a
 * socket. State arrives as a `WsSettingsSnapshot` (plus the two pieces of DOMAIN state the tabs
 * need — label presets and the workspaces wearing labels) and intent leaves through
 * `SettingsActions`, whose method names mirror the verbs assembly binds them to. So every tab
 * renders from a fixture, and the Electron shell could host this window as-is.
 */

import type { NexAction } from '@nex/core/config';
import type { WsProfile } from '@nex/protocol';

import type { ChromeLabelPreset } from '../chrome';
import type { LabelledWorkspace } from './model';
import type { RepositoryEntry } from './RepositoriesTab';

export interface SettingsActions {
    /**
     * `set-keybinding`. `trigger` is a config-file string (`"super+d"`); `null` unbinds every
     * trigger the action has. The daemon writes the file and broadcasts; nothing is stored here.
     */
    setKeybinding(action: NexAction, trigger: string | null): void;
    /** `reset-keybindings`. `null` = the whole map back to the shipped defaults (§5.4). */
    resetKeybindings(action: NexAction | null): void;
    /** `set-general-setting` — one `key = value` line in `~/.config/nex/config` (§1.3). */
    setGeneralSetting(key: string, value: string): void;
    /**
     * `set-ghostty-setting` — one `key = value` in `~/.config/ghostty/config`, the file ghostty
     * owns. `null` removes the key. Only the five keys the daemon can read back are writable
     * (`background`, `background-opacity`, `font-family`, `font-size`, `theme`).
     */
    setGhosttySetting(key: string, value: string | null): void;
    /** `set-profiles` — the WHOLE profile set (§1.6's full-replacement write). */
    setProfiles(profiles: readonly WsProfile[]): void;
    /**
     * `add-label-preset`; `color` is §6.2's one-string encoding (`"blue"` / `"#ff8800"`).
     *
     * `textColor` is the same encoding plus `null` = AUTO (black/white by luminance). SET-059:
     * the daemon applies it only when the add really created a preset, so adding a name that
     * already exists cannot recolour the existing one.
     */
    addLabelPreset(input: {
        readonly name: string;
        readonly color: string;
        readonly textColor?: string | null | undefined;
    }): void;
    /** `update-label-preset`; `id` is the preset's current name. */
    updateLabelPreset(input: {
        readonly id: string;
        readonly name?: string | undefined;
        readonly color?: string | undefined;
        /** A colour token, `null` for AUTO, absent to leave the stored one alone (SET-062). */
        readonly textColor?: string | null | undefined;
    }): void;
    /** `remove-label-preset`. §6.4: workspaces keep the label string. */
    removeLabelPreset(id: string): void;
    /**
     * `move-label-preset` — SET-065's reorder, as a target index for one preset.
     *
     * Optional so a host with no reorder verb wired (a fixture, an embedder) still satisfies
     * `SettingsActions`; the tab hides the ↑/↓ controls rather than offering dead buttons.
     */
    moveLabelPreset?(input: { readonly id: string; readonly index: number }): void;

    // ── the repo registry (Settings ▸ Repositories, graft-git.md §GIT-065…§GIT-072) ─
    //
    // Optional, unlike everything above: a host that has no repo verbs wired (a fixture, an
    // embedder) still satisfies `SettingsActions`, and the tab disables the control rather than
    // offering a button that cannot do anything.

    /** `repo-add`. An auto-discovered path is PROMOTED to manual rather than duplicated. */
    addRepo?(input: { readonly path: string; readonly name?: string | undefined }): void;
    /** `repo-remove`. Cascades: associations, HEAD watchers and graft sessions all go. */
    removeRepo?(input: { readonly repoID: string }): void;
    /** `repo-rename` — the display name only; the path is identity. */
    renameRepo?(input: { readonly repoID: string; readonly name: string }): void;
    /** `repo-scan` — walk a directory (depth 3) and register the checkouts that are new. */
    scanRepos?(input: { readonly path: string }): void;
}

/** Where the daemon's two config files live, for the footer strips (§13.1). */
export interface SettingsPaths {
    readonly nexConfig: string;
    readonly ghosttyConfig: string;
}

export const DEFAULT_SETTINGS_PATHS: SettingsPaths = {
    nexConfig: '~/.config/nex/config',
    ghosttyConfig: '~/.config/ghostty/config'
};

/** The domain state the Labels and Repositories tabs read (mirror slices, from assembly). */
export interface SettingsDomainState {
    readonly labelPresets: readonly ChromeLabelPreset[];
    readonly workspaces: readonly LabelledWorkspace[];
    /** The repo registry (`daemon.state.repos`). Absent = the Repositories tab shows empty. */
    readonly repos?: readonly RepositoryEntry[] | undefined;
}
