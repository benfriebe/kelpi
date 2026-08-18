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
    KEY_NAME_TO_CODE,
    MODIFIER_ORDER,
    UNKNOWN_KEY_NAME,
    keyTriggerConfigString,
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
export { DEFAULT_GENERAL_SETTINGS, parseGeneralSettings } from './general.js';
export type { GeneralSettings } from './general.js';
export { parseKeybindOverrides } from './keybinds.js';
export { parseProfiles, serializeProfileLines } from './profiles.js';
export type { ParseProfilesOptions, Profile } from './profiles.js';
export { setGeneralSetting, writeProfiles } from './write.js';
