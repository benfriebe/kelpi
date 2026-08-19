/**
 * The Settings surface (M8): the window behind the gear, ⌘, and the palette's "Settings…".
 *
 *   `SettingsOverlay.tsx` — the modal shell: tab rail, focus trap, Escape, focus hand-back
 *   `KeybindingsTab.tsx`  — §13.1's table + §13.2's recorder, over `set-keybinding`
 *   `AppearanceTab.tsx`   — the resolved ghostty appearance (read-only, and why)
 *   `LabelsTab.tsx`       — label presets, over the WS-only preset verbs
 *   `ProfilesTab.tsx`     — §9.5's config-file editor, over `set-profiles`
 *   `WorkspacesTab.tsx`   — the writable general settings (`set-general-setting`)
 *   `catalog.ts` / `model.ts` / `recorder.ts` — the pure rules the tabs render
 *
 * Nothing here reads the store or opens a socket: state arrives as props (the daemon's settings
 * snapshot plus two mirror slices) and intent leaves through `SettingsActions`.
 */

export { SettingsOverlay, type SettingsOverlayProps } from './SettingsOverlay';
export { KeybindingsTab, type KeybindingsTabProps } from './KeybindingsTab';
export { AppearanceTab, type AppearanceTabProps } from './AppearanceTab';
export { LabelsTab, type LabelsTabProps } from './LabelsTab';
export { ProfilesTab, type ProfilesTabProps } from './ProfilesTab';
export { WorkspacesTab, FOCUS_DELAY_MAX, FOCUS_DELAY_STEP, type WorkspacesTabProps } from './WorkspacesTab';

export {
    ACTION_CATALOG,
    CATALOGUED_ACTIONS,
    SETTINGS_CATEGORIES,
    SETTINGS_TABS,
    VISIBLE_CATEGORIES,
    actionEntry,
    actionLabel,
    actionsInCategory,
    isSettingsTabID,
    type ActionEntry,
    type SettingsCategory,
    type SettingsTabID
} from './catalog';

export {
    DEFAULT_PROFILE_NAME,
    PROFILE_MARKER_VAR,
    hasCustomBindings,
    isDefaultBinding,
    keybindingSections,
    labelUsage,
    nextProfileName,
    orphanLabels,
    profileDrafts,
    profileNameError,
    profilesForWrite,
    sanitizeProfileName,
    sanitizeVarKey,
    type KeybindingRow,
    type KeybindingSection,
    type LabelledWorkspace,
    type ProfileDraft,
    type ProfileVarDraft,
    type TriggerChip
} from './model';

export {
    NEEDS_MODIFIER_MESSAGE,
    conflictMessage,
    recordKeyEvent,
    type RecorderOptions,
    type RecorderOutcome
} from './recorder';

export {
    DEFAULT_SETTINGS_PATHS,
    type SettingsActions,
    type SettingsDomainState,
    type SettingsPaths
} from './types';
