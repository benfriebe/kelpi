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
    /** `set-profiles` — the WHOLE profile set (§1.6's full-replacement write). */
    setProfiles(profiles: readonly WsProfile[]): void;
    /** `add-label-preset`; `color` is §6.2's one-string encoding (`"blue"` / `"#ff8800"`). */
    addLabelPreset(input: { readonly name: string; readonly color: string }): void;
    /** `update-label-preset`; `id` is the preset's current name. */
    updateLabelPreset(input: {
        readonly id: string;
        readonly name?: string | undefined;
        readonly color?: string | undefined;
    }): void;
    /** `remove-label-preset`. §6.4: workspaces keep the label string. */
    removeLabelPreset(id: string): void;
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

/** The domain state the Labels tab reads (mirror slices, passed in by assembly). */
export interface SettingsDomainState {
    readonly labelPresets: readonly ChromeLabelPreset[];
    readonly workspaces: readonly LabelledWorkspace[];
}
