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
 *   - **Let programs write the clipboard** — `clipboard-write`, §TERM-046's OSC 52 gate. The one
 *     control on this tab that is a SECURITY posture rather than a preference: it ships OFF,
 *     which is stricter than the shipped app (ghostty's own `clipboard-write` defaults to
 *     `allow`, and `GhosttyApp.swift:114-123` honours every write it is handed), and the row
 *     states the half no toggle governs — clipboard *reads* are refused outright.
 *
 * Values are read straight off the daemon snapshot; a change is a verb, and the broadcast that
 * follows is what moves the control. There is no optimistic local state, so two windows cannot
 * disagree about what the file says.
 *
 * The purest value-and-verb tab in the window, and now the shortest: every row is a descriptor in
 * `sections.ts`, `FieldRenderer` draws it, and the surface is the only thing that turns a field id
 * into a config key. Same rows, same order, same test ids as the hand-written version it
 * replaces. The only thing that is gone is the copy of each key spelled beside its control.
 */

import type { WsSettingsSnapshot } from '@kelpi/protocol';
import type { ReactElement } from 'react';

import { tokens } from '../chrome';
import type { SettingsDraftValue, SettingsFieldDescriptor } from './contract';
import { FieldRenderer } from './FieldRenderer';
import { SETTINGS_FOCUS_DELAY_MAX, SETTINGS_FOCUS_DELAY_STEP } from './sections';
import type { SettingsSurface } from './surface';
import type { SettingsActions, SettingsPaths } from './types';
import { SettingsFooterNote, SettingsSection } from './ui';
import { useSectionSurface, useSettingsSnapshot } from './use-settings';

export interface WorkspacesTabProps {
    readonly settings: WsSettingsSnapshot;
    readonly actions: SettingsActions;
    readonly paths: SettingsPaths;
    /**
     * The window's settings surface, when the host has one; otherwise the tab builds its own,
     * pinned to this section. One funnel either way: see `GeneralTab`'s note.
     */
    readonly surface?: SettingsSurface | undefined;
}

/**
 * §10's slider range.
 *
 * The catalog's `SETTINGS_FOCUS_DELAY_STEP` / `_MAX` are the same numbers (they are what the
 * field's descriptor carries), and `sections.test.ts` asserts the two cannot drift. These names
 * stay because the tab's tests and `index.ts` export them.
 */
export const FOCUS_DELAY_STEP = SETTINGS_FOCUS_DELAY_STEP;
export const FOCUS_DELAY_MAX = SETTINGS_FOCUS_DELAY_MAX;

export function WorkspacesTab(props: WorkspacesTabProps): ReactElement {
    /*
     * One surface, one write path (`GeneralTab`'s note applies verbatim). The focus delay is
     * ABSENT rather than hidden while focus-follows-mouse is off, because the catalog's own
     * visibility rule says so and a section draws a padded, hairlined band per rendered row.
     */
    const surface = useSectionSurface({
        sectionID: 'workspaces',
        ...(props.surface === undefined ? {} : { surface: props.surface }),
        config: { settings: () => props.settings, actions: () => props.actions }
    });
    const snapshot = useSettingsSnapshot(surface);
    const commit = (field: SettingsFieldDescriptor, value: SettingsDraftValue): void => {
        try {
            surface.setDraft(field.id, value);
            surface.commitField(field.id, value);
        } catch {
            // Refused by the surface, which is the authority on that.
        }
    };

    return (
        <div className="flex flex-col gap-4" data-testid="settings-tab-workspaces">
            {snapshot.groups.map((group) => (
                <SettingsSection key={group.id} title={group.title} testID={group.testID}>
                    {snapshot.fields
                        .filter((field) => field.groupID === group.id)
                        .map((field) => (
                            <FieldRenderer key={field.id} field={field} onCommit={commit} />
                        ))}
                </SettingsSection>
            ))}

            <p className="text-[11px]" style={{ color: tokens.textTertiary }}>
                Worktree paths, repository auto-detection and sidebar placement are on the General tab.
            </p>

            <SettingsFooterNote>
                Config: <span className="font-mono">{props.paths.kelpiConfig}</span>
            </SettingsFooterNote>
        </div>
    );
}
