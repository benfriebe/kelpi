/**
 * General settings parsing.
 * Spec: docs/current/config-keybindings.md §1.2, §10, §11, §12, §8.1.
 */

import { parseConfigLines } from './lines.js';
import { parseKeyTrigger } from './keys.js';
import type { KeyTrigger } from './keys.js';

export interface GeneralSettings {
    readonly focusFollowsMouse: boolean;
    readonly focusFollowsMouseDelay: number;
    /** Original case preserved - theme names are case-sensitive filenames. */
    readonly theme: string | null;
    /** 0 = the TCP listener is disabled. */
    readonly tcpPort: number;
    readonly globalHotkey: KeyTrigger | null;
    readonly globalHotkeyHideOnRepress: boolean;
    /**
     * §13's "Confirm before deleting a workspace with active agents", default true.
     *
     * NOT a Swift config key: the app stores it in UserDefaults. shell-ui.md's port note
     * ("Suppression settings … port them into the daemon settings store") makes the config
     * file its home here, so every attached client agrees. Same lenient rule as
     * `global-hotkey-hide-on-repress`: only the literal `false` turns it off.
     */
    readonly confirmWorkspaceDeleteWhenActive: boolean;
}

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
    focusFollowsMouse: false,
    focusFollowsMouseDelay: 100,
    theme: null,
    tcpPort: 0,
    globalHotkey: null,
    globalHotkeyHideOnRepress: true,
    confirmWorkspaceDeleteWhenActive: true
};

const INTEGER = /^[+-]?\d+$/;

function parseInteger(raw: string): number | null {
    return INTEGER.test(raw) ? Number.parseInt(raw, 10) : null;
}

/**
 * Later lines win for the same key (the loop keeps overwriting). Unknown keys are
 * silently ignored, and a value that fails its per-key rule keeps the prior/default
 * value rather than resetting it.
 */
export function parseGeneralSettings(contents: string): GeneralSettings {
    let settings: GeneralSettings = DEFAULT_GENERAL_SETTINGS;
    for (const { key, value } of parseConfigLines(contents)) {
        const lowered = value.toLowerCase();
        switch (key) {
            case 'focus-follows-mouse':
                settings = { ...settings, focusFollowsMouse: lowered === 'true' };
                break;
            case 'focus-follows-mouse-delay': {
                const parsed = parseInteger(value);
                if (parsed !== null) {
                    settings = { ...settings, focusFollowsMouseDelay: Math.max(0, parsed) };
                }
                break;
            }
            case 'theme':
                settings = { ...settings, theme: value };
                break;
            case 'tcp-port': {
                const parsed = parseInteger(value);
                if (parsed !== null && parsed >= 1 && parsed <= 65535) {
                    settings = { ...settings, tcpPort: parsed };
                }
                break;
            }
            case 'global-hotkey': {
                if (lowered === 'none' || lowered === 'unbind' || value === '') {
                    settings = { ...settings, globalHotkey: null };
                    break;
                }
                const trigger = parseKeyTrigger(value);
                if (trigger !== null) settings = { ...settings, globalHotkey: trigger };
                break;
            }
            case 'global-hotkey-hide-on-repress':
                // Only the literal `false` disables it; any other value (incl. garbage)
                // means true.
                settings = { ...settings, globalHotkeyHideOnRepress: lowered !== 'false' };
                break;
            case 'confirm-workspace-delete':
                settings = { ...settings, confirmWorkspaceDeleteWhenActive: lowered !== 'false' };
                break;
            default:
                break;
        }
    }
    return settings;
}
