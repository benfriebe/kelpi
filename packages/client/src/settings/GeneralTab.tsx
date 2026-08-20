/**
 * Settings ▸ General (SET-002's first tab; SET-008, SET-010, SET-013, SET-014, SET-019…021).
 *
 * The tab was absent through M8 for an honest reason — the Swift General tab is almost entirely
 * `UserDefaults`, and a tab that could only *display* things would have been worse than none.
 * Every control here now has a real config key behind it (`@nex/core/config`'s `general.ts`),
 * the daemon reads each one through the settings service on every command rather than at boot,
 * and the write is the same `set-general-setting` verb the rest of Settings uses.
 *
 * Two rows are deliberately read-only, and say so rather than pretending:
 *
 *   - **TCP port** — the control listener binds at daemon start. SET-022's Swift behaviour is
 *     stop → start → *then* write, so a failed bind writes nothing; a daemon cannot rebind a
 *     live control socket under a connected CLI, so the field writes the key and states that
 *     it takes effect on the next daemon start. Claiming a live rebind would be the lie.
 *   - **Confirm before quitting** — quit belongs to the Electron shell, whose own
 *     `shell-settings.json` holds the flag and whose dialog checkbox flips it. A control here
 *     would write a key nothing reads.
 *
 * Panes ▸ focus-follows-mouse and the workspace-delete confirmation live on the Workspaces
 * tab, where this port put them before General existed; the note at the bottom points there
 * rather than duplicating a control in two places (two switches for one value is how they
 * drift).
 */

import type { WsSettingsSnapshot } from '@nex/protocol';
import type { ReactElement } from 'react';

import { tokens } from '../chrome';
import { SegmentedField, TextField } from './controls';
import type { SettingsActions, SettingsPaths } from './types';
import { KeyChip, SettingsFooterNote, SettingsRow, SettingsSection, SettingsToggle } from './ui';

export interface GeneralTabProps {
    readonly settings: WsSettingsSnapshot;
    readonly actions: SettingsActions;
    readonly paths: SettingsPaths;
}

/** The port the Swift Network toggle seeds when it is switched on (SET-019). */
export const DEFAULT_TCP_PORT = 19400;

const PLACEMENT_OPTIONS = [
    { value: 'near-selection' as const, label: 'Next to selection' },
    { value: 'end-of-list' as const, label: 'End of list' }
];

export function GeneralTab(props: GeneralTabProps): ReactElement {
    const general = props.settings.general;
    const actions = props.actions;

    return (
        <div className="flex flex-col gap-4" data-testid="settings-tab-general">
            <SettingsSection
                title="Worktrees"
                hint="Worktrees are created at <base path>/<name>. Use <repo> in the base path to substitute the repository: at the start it resolves to the full repo path (e.g. <repo>/.claude/worktrees), elsewhere it resolves to the repository's directory name (e.g. ~/nex/worktrees/<repo>)."
                testID="general-worktrees"
            >
                <TextField
                    label="Base path"
                    testID="worktree-base-path"
                    value={general.worktreeBasePath}
                    placeholder="~/nex/worktrees/<repo>"
                    onCommit={(next) => {
                        // A blank field means "the default"; the parser treats an empty value
                        // that way too, so the two ends agree without a special case here.
                        actions.setGeneralSetting('worktree-base-path', next.trim());
                    }}
                />
            </SettingsSection>

            <SettingsSection title="Repositories" testID="general-repositories">
                <SettingsRow
                    label="Auto-detect from pane directories"
                    detail="When a pane's working directory is inside a Git repository, associate that repo (or worktree) with the workspace. Removed a few seconds after no pane remains in it; manually added repos are never auto-removed."
                    testID="auto-detect-repos-row"
                >
                    <SettingsToggle
                        testID="auto-detect-repos-toggle"
                        label="Auto-detect from pane directories"
                        checked={general.autoDetectRepos}
                        onChange={(next) => {
                            actions.setGeneralSetting('auto-detect-repos', next ? 'true' : 'false');
                        }}
                    />
                </SettingsRow>
            </SettingsSection>

            <SettingsSection title="Workspaces" testID="general-workspaces">
                <SegmentedField
                    label="New workspace placement"
                    testID="new-workspace-placement"
                    detail="Where a newly created workspace is inserted. “Next to selection” places it immediately after the active workspace's slot; “End of list” always appends."
                    value={general.newWorkspacePlacement}
                    options={PLACEMENT_OPTIONS}
                    onChange={(next) => {
                        actions.setGeneralSetting('new-workspace-placement', next);
                    }}
                />
                <SegmentedField
                    label="New group placement"
                    testID="new-group-placement"
                    detail="The same choice for a newly created group."
                    value={general.newGroupPlacement}
                    options={PLACEMENT_OPTIONS}
                    onChange={(next) => {
                        actions.setGeneralSetting('new-group-placement', next);
                    }}
                />
            </SettingsSection>

            <SettingsSection
                title="Network"
                hint="The control socket's optional TCP listener on 127.0.0.1, for dev containers and SSH tunnels. It binds when the daemon starts, so a change here applies on the next daemon start."
                testID="general-network"
            >
                <SettingsRow
                    label="TCP listener"
                    detail={
                        general.tcpPort > 0
                            ? `Listening on 127.0.0.1:${String(general.tcpPort)} (as of daemon start).`
                            : 'Disabled — the Unix control socket is the only transport.'
                    }
                    testID="tcp-listener-row"
                >
                    <SettingsToggle
                        testID="tcp-listener-toggle"
                        label="TCP listener"
                        checked={general.tcpPort > 0}
                        onChange={(next) => {
                            actions.setGeneralSetting('tcp-port', next ? String(DEFAULT_TCP_PORT) : '0');
                        }}
                    />
                </SettingsRow>
                {general.tcpPort > 0 ? (
                    <TextField
                        label="Port"
                        testID="tcp-port"
                        value={String(general.tcpPort)}
                        onCommit={(next) => {
                            const parsed = Number.parseInt(next.trim(), 10);
                            // SET-020: a non-numeric entry falls back to the default port
                            // rather than writing a value the parser will silently ignore.
                            const port =
                                Number.isFinite(parsed) && parsed >= 1 && parsed <= 65535
                                    ? parsed
                                    : DEFAULT_TCP_PORT;
                            actions.setGeneralSetting('tcp-port', String(port));
                        }}
                    />
                ) : null}
            </SettingsSection>

            <SettingsSection title="Quit" testID="general-quit">
                <SettingsRow
                    label="Confirm before quitting"
                    detail="Owned by the desktop app, not the daemon: the ⌘Q dialog's “Don't ask again” checkbox is what changes it, and a browser tab has no quit to confirm."
                    testID="confirm-quit-row"
                >
                    <KeyChip>desktop app</KeyChip>
                </SettingsRow>
            </SettingsSection>

            <p className="text-[11px]" style={{ color: tokens.textTertiary }}>
                Focus-follows-mouse and the workspace-delete confirmation are on the Workspaces tab.
            </p>

            <SettingsFooterNote>
                Config: <span className="font-mono">{props.paths.nexConfig}</span>. Every value here is a line in
                that file — edit it by hand and this window follows.
            </SettingsFooterNote>
        </div>
    );
}
