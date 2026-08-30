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
    /**
     * §10 step 2's "Confirm before quitting while agents are active", default true — the twin
     * of `confirm-workspace-delete` and, until now, the one suppression flag that was NOT here.
     *
     * It lived in the Electron shell's own `shell-settings.json`, which meant the ⌘Q dialog's
     * "Don't ask again" checkbox and Settings could never agree (Settings could not even show
     * it: §AGNT-117's missing half). shell-ui.md's port note is explicit that BOTH suppression
     * settings belong in the daemon store, so this is the second one. Same lenient rule as its
     * twin: only the literal `false` turns it off, and the shell migrates its old local flag
     * once on first read.
     */
    readonly confirmQuitWhenActive: boolean;
    /**
     * §13's Settings ▸ General ▸ Repositories "Auto-detect from pane directories", default
     * **true** (`SettingsFeature.State.autoDetectRepos`). It gates BOTH halves of the
     * auto-detect subsystem: the 500 ms auto-link after a pane's pwd changes and the 5 s
     * auto-unlink sweep (graft-git.md §GIT-074).
     *
     * NOT a Swift config key either — the app keeps it in UserDefaults. Same reasoning as
     * `confirm-workspace-delete`: a multi-client daemon has no UserDefaults, so the config
     * file is its home and every attached client reads the same value. Lenient in the same
     * way: only the literal `false` turns it off.
     */
    readonly autoDetectRepos: boolean;
    /**
     * §13's Settings ▸ General ▸ Worktrees "Base path" (SET-008), default
     * `~/kelpi/worktrees/<repo>`. `<repo>` expands to the full repo path at the START of the
     * template and to the repo's directory NAME elsewhere; `~` expands too
     * (`@kelpi/daemon`'s `git/names.ts`, SET-009 — already implemented and tested there).
     *
     * UserDefaults in the Swift app; a config key here for the same multi-client reason as
     * the flags above. A blank value falls back to the shipped default rather than producing
     * worktrees at the filesystem root.
     */
    readonly worktreeBasePath: string;
    /**
     * §13's "New workspace placement" (SET-013) and "New group placement" (SET-014), default
     * `end-of-list` for both. `near-selection` inserts after the active workspace's slot.
     */
    readonly newWorkspacePlacement: 'end-of-list' | 'near-selection';
    readonly newGroupPlacement: 'end-of-list' | 'near-selection';
    /**
     * §13's Workspaces ▸ "Inherit group when creating a new workspace" (SET-011), default
     * **true** (`SettingsFeature.State.inheritGroupOnNewWorkspace`). When the active workspace
     * belongs to a group, a new workspace created without an explicit group joins that group;
     * with it off, every such create lands at top level.
     *
     * UserDefaults in the Swift app, a config key here for the same multi-client reason as the
     * flags above, and lenient in the same way: only the literal `false` turns it off.
     *
     * It gates the CLIENT's create gestures — ⌘N, and the New Workspace form's preselected
     * group — not the wire verb: the Swift app reads it in `NewWorkspaceSheet`, never in the
     * socket path, so `kelpi workspace create` without `--group` still lands at top level.
     */
    readonly inheritGroupOnNewWorkspace: boolean;
    /**
     * §13's Workspaces ▸ "Expand group when a workspace is dropped into it" (SET-012), default
     * **true** (`SettingsFeature.State.expandGroupOnWorkspaceDrop`). When a workspace is dropped
     * onto a COLLAPSED group the group opens so the row it just swallowed is visible; with it
     * off the group stays shut and the row is filed away out of sight.
     *
     * UserDefaults in the Swift app, a config key here for the same multi-client reason as the
     * flags above, and lenient in the same way: only the literal `false` turns it off.
     *
     * Like SET-011 it gates the CLIENT's gesture, not the wire verb: the drop sends the value on
     * `workspace-move` (`expand_on_drop`), and a `workspace-move` that says nothing — every CLI
     * one — keeps the always-expand behaviour it has always had.
     */
    readonly expandGroupOnWorkspaceDrop: boolean;
    /**
     * `clipboard-write` (terminal-panes.md §TERM-046), default **false**.
     *
     * May a program running in a pane put text on the clipboard with OSC 52? ghostty's own key
     * of the same name defaults to `allow`, and the shipped Swift app honours every write
     * unconditionally (`GhosttyApp.swift:114-123`). This port ships it OFF, and it is the one
     * place the port is deliberately *stricter* than the baseline rather than merely different:
     * here the clipboard belongs to the machine running the CLIENT, the pane may be an agent or
     * an `ssh` session on someone else's box, and a silent cross-machine clipboard write is not
     * something to opt users into by default.
     *
     * Strict parsing, like `focus-follows-mouse` and unlike the default-true flags above: only
     * the literal `true` enables it, so a typo fails closed.
     *
     * There is no `clipboard-read` twin. OSC 52 reads are refused outright and no key turns
     * them on (`daemon/src/term/osc52.ts` says why).
     */
    readonly clipboardWrite: boolean;
}

/** `SettingsFeature.State.worktreeBasePath`'s shipped default. */
export const DEFAULT_WORKTREE_BASE_PATH_TEMPLATE = '~/kelpi/worktrees/<repo>';

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
    focusFollowsMouse: false,
    focusFollowsMouseDelay: 100,
    theme: null,
    tcpPort: 0,
    globalHotkey: null,
    globalHotkeyHideOnRepress: true,
    confirmWorkspaceDeleteWhenActive: true,
    confirmQuitWhenActive: true,
    autoDetectRepos: true,
    worktreeBasePath: DEFAULT_WORKTREE_BASE_PATH_TEMPLATE,
    newWorkspacePlacement: 'end-of-list',
    newGroupPlacement: 'end-of-list',
    inheritGroupOnNewWorkspace: true,
    expandGroupOnWorkspaceDrop: true,
    clipboardWrite: false
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
            case 'confirm-quit-when-active':
                settings = { ...settings, confirmQuitWhenActive: lowered !== 'false' };
                break;
            case 'auto-detect-repos':
                settings = { ...settings, autoDetectRepos: lowered !== 'false' };
                break;
            case 'worktree-base-path':
                // A blank value means "the default", not "the filesystem root".
                if (value !== '') settings = { ...settings, worktreeBasePath: value };
                break;
            case 'new-workspace-placement':
                if (lowered === 'end-of-list' || lowered === 'near-selection') {
                    settings = { ...settings, newWorkspacePlacement: lowered };
                }
                break;
            case 'new-group-placement':
                if (lowered === 'end-of-list' || lowered === 'near-selection') {
                    settings = { ...settings, newGroupPlacement: lowered };
                }
                break;
            case 'inherit-group-on-new-workspace':
                settings = { ...settings, inheritGroupOnNewWorkspace: lowered !== 'false' };
                break;
            case 'expand-group-on-workspace-drop':
                settings = { ...settings, expandGroupOnWorkspaceDrop: lowered !== 'false' };
                break;
            case 'clipboard-write':
                // §TERM-046: default OFF, so only the literal `true` opens it — the opposite
                // rule from the default-true flags above, and the right way round for a gate.
                settings = { ...settings, clipboardWrite: lowered === 'true' };
                break;
            default:
                break;
        }
    }
    return settings;
}
