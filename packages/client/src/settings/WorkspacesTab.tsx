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
                Worktree paths, repository auto-detection, sidebar placement and the quit confirmation are not
                editable here yet — they have no daemon-side key, so this window would only be able to show
                them, not change them.
            </p>

            <SettingsFooterNote>
                Config: <span className="font-mono">{props.paths.nexConfig}</span>
            </SettingsFooterNote>
        </div>
    );
}
