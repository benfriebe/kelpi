/**
 * Settings ▸ General (SET-002's first tab; SET-008, SET-010, SET-013, SET-014, SET-019…021).
 *
 * The tab was absent through M8 for an honest reason — the Swift General tab is almost entirely
 * `UserDefaults`, and a tab that could only *display* things would have been worse than none.
 * Every control here now has a real config key behind it (`@nex/core/config`'s `general.ts`),
 * the daemon reads each one through the settings service on every command rather than at boot,
 * and the write is the same `set-general-setting` verb the rest of Settings uses.
 *
 * One row stays read-only, and says so rather than pretending:
 *
 *   - **TCP port** — the control listener binds at daemon start. SET-022's Swift behaviour is
 *     stop → start → *then* write, so a failed bind writes nothing; a daemon cannot rebind a
 *     live control socket under a connected CLI, so the field writes the key and states that
 *     it takes effect on the next daemon start. Claiming a live rebind would be the lie.
 *
 *     What it no longer does is *guess the outcome*. §SET-021 asked for "Port N is unavailable"
 *     under the Network section, and the daemon now reports what its listener actually did
 *     (`welcome.transport`, backed by `daemon/src/control/server.ts`'s `tcpStatus`), so the row
 *     reads "Listening on 127.0.0.1:19400" or "Port 19400 unavailable: …" — the failed-bind
 *     case that used to be a daemon log line nobody saw while every `NEX_SOCKET=tcp:…` client
 *     timed out against nothing.
 *
 * Panes ▸ focus-follows-mouse and the two confirmation suppressions (workspace delete, quit)
 * live on the Workspaces tab, where this port put them before General existed; the note at the
 * bottom points there rather than duplicating a control in two places (two switches for one
 * value is how they drift).
 */

import type { WsSettingsSnapshot, WsTransportStatus } from '@nex/protocol';
import type { ReactElement } from 'react';

import { tokens } from '../chrome';
import { SegmentedField, TextField } from './controls';
import type { SettingsActions, SettingsPaths } from './types';
import { KeyChip, SettingsFooterNote, SettingsRow, SettingsSection, SettingsToggle } from './ui';

export interface GeneralTabProps {
    readonly settings: WsSettingsSnapshot;
    readonly actions: SettingsActions;
    readonly paths: SettingsPaths;
    /**
     * §SET-021: what the daemon's listeners actually did. `null`/absent means it did not say
     * (an older daemon, or not connected yet), which the row renders with the old "as of daemon
     * start" wording rather than claiming a bind either way.
     */
    readonly transport?: WsTransportStatus | null | undefined;
}

/**
 * §SET-021's Network detail line: the config's port is what was ASKED for, `transport` is what
 * happened. Exported so the copy can be asserted directly rather than through a DOM crawl.
 */
export function tcpListenerDetail(
    configuredPort: number,
    transport: WsTransportStatus | null | undefined
): string {
    const tcp = transport?.tcp;
    // What the listener DID outranks what the file asks for, in both directions: a daemon
    // started with `NEXD_TCP_PORT` (a dev container, the audit sandbox) is genuinely listening
    // even though this config file says nothing, and saying "Disabled" there would be false.
    if (tcp !== null && tcp !== undefined && tcp.bound !== null) {
        // When the file did not ask for it, say where the port came from — otherwise the switch
        // below (which reflects the FILE, i.e. what happens next start) reads as being out of
        // step with a listener that is plainly up.
        return configuredPort > 0
            ? `Listening on ${tcp.host}:${String(tcp.bound)}.`
            : `Listening on ${tcp.host}:${String(tcp.bound)} — this daemon was started with an explicit port, not from this config file.`;
    }
    if (tcp !== null && tcp !== undefined) {
        return `Port ${String(tcp.requested)} unavailable: ${tcp.error ?? 'the listener did not bind'}. Unix-socket clients are unaffected.`;
    }
    if (configuredPort <= 0) return 'Disabled — the Unix control socket is the only transport.';
    if (transport === null || transport === undefined) {
        return `Listening on 127.0.0.1:${String(configuredPort)} (as of daemon start).`;
    }
    // The daemon spoke and has no TCP listener at all: the config changed after it started.
    return `Port ${String(configuredPort)} takes effect on the next daemon start — this daemon started with no TCP listener.`;
}

/** The port the Swift Network toggle seeds when it is switched on (SET-019). */
export const DEFAULT_TCP_PORT = 19400;

/**
 * §SET-021's "in red". The same literal the sidebar's destructive Delete uses
 * (`chrome/Sidebar.tsx`) — there is no chrome token for it, and inventing one here would put
 * two spellings of "destructive" in the palette.
 */
const DESTRUCTIVE_TONE = '#E0655C';

/** The failed-bind line, or null when there is nothing to warn about. */
export function tcpBindError(
    _configuredPort: number,
    transport: WsTransportStatus | null | undefined
): string | null {
    const tcp = transport?.tcp;
    // Keyed off the FAILED LISTENER, not off the config value: a listener asked for by
    // `NEXD_TCP_PORT` fails just as loudly as one asked for by the file, and the user who has to
    // fix it is the same user either way.
    if (tcp === null || tcp === undefined || tcp.bound !== null) return null;
    return `Port ${String(tcp.requested)} is unavailable${tcp.error === null ? '' : ` — ${tcp.error}`}`;
}

const PLACEMENT_OPTIONS = [
    { value: 'near-selection' as const, label: 'Next to selection' },
    { value: 'end-of-list' as const, label: 'End of list' }
];

export function GeneralTab(props: GeneralTabProps): ReactElement {
    const general = props.settings.general;
    const actions = props.actions;
    const bindError = tcpBindError(general.tcpPort, props.transport);

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
                {/* SET-011. A CLIENT-side rule: ⌘N and the sidebar's New Workspace form read
                    it, the wire verb does not, so `nex workspace create` is unaffected. */}
                <SettingsRow
                    label="Inherit group when creating a new workspace"
                    detail="When the active workspace belongs to a group, new workspaces are created inside that same group. Disable to always create at the top level."
                    testID="inherit-group-row"
                >
                    <SettingsToggle
                        testID="inherit-group-toggle"
                        label="Inherit group when creating a new workspace"
                        checked={general.inheritGroupOnNewWorkspace}
                        onChange={(next) => {
                            actions.setGeneralSetting('inherit-group-on-new-workspace', next ? 'true' : 'false');
                        }}
                    />
                </SettingsRow>
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
                    detail={tcpListenerDetail(general.tcpPort, props.transport)}
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
                        // SET-020: the Swift field is 80 pt and right-aligned, with an Apply
                        // button that appears only while the typed text differs from the live
                        // port. Both reproduced; blur/Enter still commit.
                        narrow
                        apply
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
                {/*
                 * §SET-021: the failed bind, in the destructive tone, under the Network section
                 * — the one place a user goes looking when `NEX_SOCKET=tcp:…` stops answering.
                 */}
                {bindError === null ? null : (
                    <p
                        data-testid="tcp-bind-error"
                        className="text-[11px]"
                        style={{ color: DESTRUCTIVE_TONE }}
                    >
                        {bindError}
                    </p>
                )}
            </SettingsSection>

            <p className="text-[11px]" style={{ color: tokens.textTertiary }}>
                Focus-follows-mouse and the two confirmation dialogs (workspace delete, quit) are on the
                Workspaces tab.
            </p>

            <SettingsFooterNote>
                Config: <span className="font-mono">{props.paths.nexConfig}</span>. Every value here is a line in
                that file — edit it by hand and this window follows.
            </SettingsFooterNote>
        </div>
    );
}
