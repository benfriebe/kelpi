/**
 * The Settings surface (M8): the window behind the gear, ⌘, and the palette's "Settings…".
 *
 *   `SettingsOverlay.tsx` — the modal shell: tab rail, focus trap, Escape, focus hand-back
 *   `GeneralTab.tsx`      — §13's General tab: worktree base path, repo auto-detect, placement,
 *                           the TCP listener
 *   `KeybindingsTab.tsx`  — §13.1's table + §13.2's recorder, over `set-keybinding`
 *   `GlobalHotkeySection.tsx` — §8's system-wide hotkey recorder, inside the Keybindings tab
 *   `AppearanceTab.tsx`   — the chrome palette + presets/share codes (nex config) and the
 *                           terminal theme/background/font (ghostty config)
 *   `LabelsTab.tsx`       — label presets, over the WS-only preset verbs
 *   `ColorFlyover.tsx`    — §N38's anchored colour popover: the Background/Text sections and the
 *                           hand-rolled HSV picker both of their Custom rows open
 *   `ProfilesTab.tsx`     — §9.5's config-file editor, over `set-profiles`
 *   `WorkspacesTab.tsx`   — the writable general settings (`set-general-setting`)
 *   `controls.tsx`        — the WRITING controls (debounced colour/slider, segmented, select)
 *   `catalog.ts` / `model.ts` / `recorder.ts` — the pure rules the tabs render
 *
 * Nothing here reads the store or opens a socket: state arrives as props (the daemon's settings
 * snapshot plus two mirror slices) and intent leaves through `SettingsActions`.
 */

export { SettingsOverlay, type SettingsOverlayProps } from './SettingsOverlay';
export { GeneralTab, DEFAULT_TCP_PORT, type GeneralTabProps } from './GeneralTab';
export { KeybindingsTab, type KeybindingsTabProps } from './KeybindingsTab';
export {
    FAILURE_COLOR,
    GlobalHotkeySection,
    WARNING_COLOR,
    globalHotkeyErrorFrom,
    inAppConflict,
    type GlobalHotkeySectionProps
} from './GlobalHotkeySection';
export {
    AppearanceTab,
    BUILT_IN_TERMINAL_THEMES,
    THEME_NOTE_WARNING_COLOR,
    TerminalThemeNote,
    appearancePercentLabel,
    type AppearanceTabProps
} from './AppearanceTab';
export {
    ColorField,
    SegmentedField,
    SelectField,
    SETTINGS_WRITE_DEBOUNCE_MS,
    SliderField,
    TextField,
    useDebouncedValue
} from './controls';
export { LabelsTab, type LabelsTabProps } from './LabelsTab';
export {
    COLOR_FLYOVER_WIDTH,
    ColorFlyover,
    colorFlyoverPlacement,
    hexFromHsv,
    hsvFromHex,
    parseFlexibleHex,
    type ColorFlyoverProps,
    type FlyoverPlacement,
    type Hsv
} from './ColorFlyover';
export { WebTab, DEFAULT_FAVOURITES_PATH, type WebTabActions, type WebTabProps } from './WebTab';
export { ProfilesTab, type ProfilesTabProps } from './ProfilesTab';
export {
    RepositoriesTab,
    filterRepos,
    type RepositoriesTabProps,
    type RepositoryEntry
} from './RepositoriesTab';
export { WorkspacesTab, FOCUS_DELAY_MAX, FOCUS_DELAY_STEP, type WorkspacesTabProps } from './WorkspacesTab';

export {
    ACTION_CATALOG,
    CATALOGUED_ACTIONS,
    DEFAULT_SETTINGS_TAB,
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

export {
    SETTINGS_HOVER_FILL,
    SettingsButton,
    SettingsIconButton,
    SettingsToggle,
    hoverBackground,
    useHover
} from './ui';
