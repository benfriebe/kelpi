/** Public surface of the config-file module (WP1.4). */

export type { ConfigLine } from './lines.js';
export {
    configLineKey,
    ensureTrailingNewline,
    parseConfigLine,
    parseConfigLines,
    splitConfigLines,
    stripTrailingBlankLines
} from './lines.js';
export {
    KEY_CODE_TO_CONFIG_NAME,
    KEY_CODE_TO_DISPLAY_NAME,
    KEY_NAME_TO_CODE,
    MODIFIER_DISPLAY_ORDER,
    MODIFIER_ORDER,
    MODIFIER_SYMBOLS,
    UNKNOWN_KEY_DISPLAY,
    UNKNOWN_KEY_NAME,
    keyTriggerConfigString,
    keyTriggerDisplayString,
    keyTriggerKey,
    keyTriggersEqual,
    makeKeyTrigger,
    parseKeyTrigger
} from './keys.js';
export type { KeyModifier, KeyTrigger } from './keys.js';
export { MENU_BAR_ACTIONS, NEX_ACTIONS, UNBIND_ACTION, isNexAction } from './actions.js';
export type { NexAction, UnbindAction } from './actions.js';
export {
    DEFAULT_KEYBINDINGS,
    DEFAULT_KEYBIND_LINES,
    actionForTrigger,
    applyKeybindOverrides,
    parseKeybindValue,
    removeAllBindings,
    removeBinding,
    resolveKeyBindings,
    setBinding,
    triggersForAction
} from './bindings.js';
export type { KeyBinding, KeyBindingMap, KeybindOverride } from './bindings.js';
export {
    DEFAULT_GENERAL_SETTINGS,
    DEFAULT_WORKTREE_BASE_PATH_TEMPLATE,
    parseGeneralSettings
} from './general.js';
export type { GeneralSettings } from './general.js';
export { parseKeybindOverrides } from './keybinds.js';
export { parseProfiles, serializeProfileLines } from './profiles.js';
export type { ParseProfilesOptions, Profile } from './profiles.js';
export { setGeneralSetting, writeKeybindings, writeProfiles } from './write.js';
export {
    DEFAULT_CHROME_SETTINGS,
    SYSTEM_STAT_IDS,
    parseChromeColors,
    parseChromeHex,
    parseChromeSettings,
    parseSystemStatIDs,
    serializeChromeColors,
    serializeSystemStatIDs
} from './chrome.js';
export type {
    ChromeAppearancePreference,
    ChromeSettings,
    SparklineStyle,
    SystemStatID
} from './chrome.js';
export { ghosttyColorValue, ghosttyFontFamilyValue, setGhosttySetting } from './ghostty-write.js';
