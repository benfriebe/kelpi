/**
 * Settings ▸ Workspaces.
 *
 * The tab for the writable general settings that DO have a home in this port. §13's General tab
 * spreads them across Worktrees / Repositories / Workspaces / Panes / Quit / Network; most of
 * those live in the Swift app's UserDefaults with no config-file key and no daemon equivalent
 * yet, so only the two that write through `set-general-setting` are here:
 *
 *   - **Confirm before deleting a workspace with active agents** — `confirm-workspace-delete`.
 *     shell-ui.md's port note is explicit that the suppression settings must move into the
 *     daemon settings store "so Settings UI and dialogs stay in sync across clients", and the
 *     daemon's settings store is the config file. The CLI's `--force` is independent of it, as
 *     in the Swift app.
 *   - **Confirm before quitting with active agents** — `confirm-quit-when-active`, the other
 *     half of that same port note (§AGNT-117). It used to live in the Electron shell's
 *     `shell-settings.json`, so the ⌘Q dialog's "Don't ask again" checkbox wrote a value this
 *     window could not even read. Both now write this key; the shell learns about a change on
 *     its own status socket. A browser client has no ⌘Q, which is why the row says so.
 *   - **Focus follows mouse** + its delay — §10, already read by the pane grid. The slider range
 *     is §10's 0–500 in steps of 25, and it only appears while the toggle is on.
 *
 * Values are read straight off the daemon snapshot; a change is a verb, and the broadcast that
 * follows is what moves the control. There is no optimistic local state, so two windows cannot
 * disagree about what the file says.
 */

import type { WsSettingsSnapshot } from '@nex/protocol';
import type { ReactElement } from 'react';

import { tokens } from '../chrome';
import type { SettingsActions, SettingsPaths } from './types';
import { KeyChip, SettingsFooterNote, SettingsRow, SettingsSection, SettingsToggle } from './ui';

export interface WorkspacesTabProps {
    readonly settings: WsSettingsSnapshot;
    readonly actions: SettingsActions;
    readonly paths: SettingsPaths;
}

export const FOCUS_DELAY_STEP = 25;
export const FOCUS_DELAY_MAX = 500;

export function WorkspacesTab(props: WorkspacesTabProps): ReactElement {
    const general = props.settings.general;

    return (
        <div className="flex flex-col gap-4" data-testid="settings-tab-workspaces">
            <SettingsSection title="Workspaces" testID="workspaces-section">
                <SettingsRow
                    label="Confirm before deleting a workspace with active agents"
                    detail="Applies to this window and every other client. nex workspace delete --force bypasses it regardless."
                    testID="confirm-delete-row"
                >
                    <SettingsToggle
                        testID="confirm-delete-toggle"
                        label="Confirm before deleting a workspace with active agents"
                        checked={general.confirmWorkspaceDeleteWhenActive}
                        onChange={(next) => {
                            props.actions.setGeneralSetting('confirm-workspace-delete', next ? 'true' : 'false');
                        }}
                    />
                </SettingsRow>

                {/*
                 * §AGNT-117's missing half. The ⌘Q dialog's "Don't ask again" used to write the
                 * Electron shell's own `shell-settings.json`, which no Settings window could
                 * read — so the checkbox and this tab could not agree, and the tab said so. The
                 * flag is a daemon setting now (`confirm-quit-when-active`), both sides write
                 * the same key, and the shell picks a change up on its status socket's
                 * `settings-changed` without a restart.
                 */}
                <SettingsRow
                    label="Confirm before quitting with active agents"
                    detail="Desktop app only: ⌘Q asks first while agents are running. The dialog's “Don't ask again” checkbox writes this same setting."
                    testID="confirm-quit-row"
                >
                    <SettingsToggle
                        testID="confirm-quit-toggle"
                        label="Confirm before quitting with active agents"
                        checked={general.confirmQuitWhenActive}
                        onChange={(next) => {
                            props.actions.setGeneralSetting('confirm-quit-when-active', next ? 'true' : 'false');
                        }}
                    />
                </SettingsRow>
            </SettingsSection>

            <SettingsSection title="Panes" testID="panes-section">
                <SettingsRow
                    label="Focus follows mouse"
                    detail="Hovering a pane focuses it after the delay below."
                    testID="focus-follows-mouse-row"
                >
                    <SettingsToggle
                        testID="focus-follows-mouse-toggle"
                        label="Focus follows mouse"
                        checked={general.focusFollowsMouse}
                        onChange={(next) => {
                            props.actions.setGeneralSetting('focus-follows-mouse', next ? 'true' : 'false');
                        }}
                    />
                </SettingsRow>

                {general.focusFollowsMouse ? (
                    <SettingsRow
                        label="Focus delay"
                        detail="Moving across several panes within the delay focuses only the last one."
                        testID="focus-delay-row"
                    >
                        <input
                            type="range"
                            aria-label="Focus delay"
                            data-testid="focus-delay-slider"
                            min={0}
                            max={FOCUS_DELAY_MAX}
                            step={FOCUS_DELAY_STEP}
                            value={Math.min(general.focusFollowsMouseDelay, FOCUS_DELAY_MAX)}
                            onChange={(event) => {
                                props.actions.setGeneralSetting('focus-follows-mouse-delay', event.target.value);
                            }}
                        />
                        <KeyChip>{`${String(general.focusFollowsMouseDelay)} ms`}</KeyChip>
                    </SettingsRow>
                ) : null}
            </SettingsSection>

            <p className="text-[11px]" style={{ color: tokens.textTertiary }}>
                Worktree paths, repository auto-detection and sidebar placement are on the General tab.
            </p>

            <SettingsFooterNote>
                Config: <span className="font-mono">{props.paths.nexConfig}</span>
            </SettingsFooterNote>
        </div>
    );
}
