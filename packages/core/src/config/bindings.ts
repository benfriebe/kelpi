/**
 * The keybinding map: defaults, override application, lookups.
 * Spec: docs/config-keybindings.md §1.4, §5.1, §5.2.
 */

import { isKelpiAction, UNBIND_ACTION } from './actions.js';
import type { KelpiAction, UnbindAction } from './actions.js';
import {
    canonicalTriggerForPlatform,
    keyTriggerConfigString,
    keyTriggerKey,
    parseKeyTrigger
} from './keys.js';
import type { KeyTrigger } from './keys.js';

export interface KeyBinding {
    readonly trigger: KeyTrigger;
    readonly action: KelpiAction;
}

/** trigger identity (`keyTriggerKey`) → binding. One action per trigger. */
export type KeyBindingMap = ReadonlyMap<string, KeyBinding>;

export interface KeybindOverride {
    readonly trigger: KeyTrigger;
    readonly action: KelpiAction | UnbindAction;
}

/**
 * Split a `keybind` value at its LAST `=` (that is what lets the `=` key itself be
 * bound: `super+==increase_markdown_font_size`), then validate both halves.
 * Returns null for the "warn + skip line" cases.
 */
export function parseKeybindValue(value: string): KeybindOverride | null {
    const separator = value.lastIndexOf('=');
    if (separator < 0) return null;
    const triggerString = value.slice(0, separator);
    const actionString = value.slice(separator + 1);
    const trigger = parseKeyTrigger(triggerString);
    if (trigger === null) return null;
    if (actionString === UNBIND_ACTION) return { trigger, action: UNBIND_ACTION };
    if (!isKelpiAction(actionString)) return null;
    return { trigger, action: actionString };
}

/** §5.2 - the 40 shipped default triggers, in `<trigger>=<action>` form. */
export const DEFAULT_KEYBIND_LINES: readonly string[] = [
    'super+n=new_workspace',
    'super+o=open_file',
    'shift+super+o=open_web_pane',
    'super+1=switch_to_workspace_1',
    'super+2=switch_to_workspace_2',
    'super+3=switch_to_workspace_3',
    'super+4=switch_to_workspace_4',
    'super+5=switch_to_workspace_5',
    'super+6=switch_to_workspace_6',
    'super+7=switch_to_workspace_7',
    'super+8=switch_to_workspace_8',
    'super+9=switch_to_workspace_9',
    'shift+super+s=toggle_sidebar',
    'super+i=toggle_inspector',
    'super+d=split_right',
    'shift+super+d=split_down',
    'super+w=close_pane',
    'super+]=focus_next_pane',
    'alt+super+right=focus_next_pane',
    'super+[=focus_previous_pane',
    'alt+super+left=focus_previous_pane',
    'alt+super+down=next_workspace',
    'alt+super+up=previous_workspace',
    'shift+super+r=rename_workspace',
    'super+e=toggle_markdown_edit',
    'super+==increase_markdown_font_size',
    'super+-=decrease_markdown_font_size',
    'super+0=reset_markdown_font_size',
    'shift+super+return=toggle_zoom',
    'shift+super+t=reopen_closed_pane',
    'super+f=toggle_search',
    'escape=close_search',
    'shift+super+space=cycle_layout',
    'super+p=command_palette',
    'shift+super+n=create_scratchpad',
    'shift+super+g=new_group',
    'ctrl+shift+left=move_pane_left',
    'ctrl+shift+right=move_pane_right',
    'ctrl+shift+down=move_pane_down',
    'ctrl+shift+up=move_pane_up'
];

function buildDefaults(): KeyBindingMap {
    const map = new Map<string, KeyBinding>();
    for (const line of DEFAULT_KEYBIND_LINES) {
        const override = parseKeybindValue(line);
        if (override === null || override.action === UNBIND_ACTION) {
            throw new Error(`default keybinding line is not parseable: ${line}`);
        }
        map.set(keyTriggerKey(override.trigger), {
            trigger: override.trigger,
            action: override.action
        });
    }
    return map;
}

export const DEFAULT_KEYBINDINGS: KeyBindingMap = buildDefaults();

export function actionForTrigger(map: KeyBindingMap, trigger: KeyTrigger): KelpiAction | null {
    return map.get(keyTriggerKey(trigger))?.action ?? null;
}

/** All triggers bound to an action, sorted by `configString` (deterministic across launches). */
export function triggersForAction(map: KeyBindingMap, action: KelpiAction): KeyTrigger[] {
    return [...map.values()]
        .filter((binding) => binding.action === action)
        .map((binding) => binding.trigger)
        .sort((a, b) => {
            const left = keyTriggerConfigString(a);
            const right = keyTriggerConfigString(b);
            return left < right ? -1 : left > right ? 1 : 0;
        });
}

/** Upsert; steals the trigger from whatever action held it. */
export function setBinding(
    map: KeyBindingMap,
    trigger: KeyTrigger,
    action: KelpiAction
): KeyBindingMap {
    const next = new Map(map);
    next.set(keyTriggerKey(trigger), { trigger, action });
    return next;
}

export function removeBinding(map: KeyBindingMap, trigger: KeyTrigger): KeyBindingMap {
    const next = new Map(map);
    next.delete(keyTriggerKey(trigger));
    return next;
}

export function removeAllBindings(map: KeyBindingMap, action: KelpiAction): KeyBindingMap {
    const next = new Map(map);
    for (const [key, binding] of next) {
        if (binding.action === action) next.delete(key);
    }
    return next;
}

/**
 * §1.4 - overrides apply ON TOP of the defaults in file order: `unbind` removes the
 * trigger, anything else replaces/adds it. Later lines win for the same trigger.
 */
export function applyKeybindOverrides(
    map: KeyBindingMap,
    overrides: readonly KeybindOverride[]
): KeyBindingMap {
    let next = map;
    for (const override of overrides) {
        next =
            override.action === UNBIND_ACTION
                ? removeBinding(next, override.trigger)
                : setBinding(next, override.trigger, override.action);
    }
    return next;
}

/**
 * `KeybindingService.loadFromDisk` semantics: no overrides (missing file, unreadable, or
 * zero valid `keybind` lines) → the untouched defaults.
 */
export function resolveKeyBindings(overrides: readonly KeybindOverride[]): KeyBindingMap {
    if (overrides.length === 0) return DEFAULT_KEYBINDINGS;
    return applyKeybindOverrides(DEFAULT_KEYBINDINGS, overrides);
}

/**
 * Re-key a resolved map for the running platform (§3.5): every trigger canonicalized through
 * `canonicalTriggerForPlatform`, so on a Ctrl-primary platform the `super+*` lines fire on
 * Ctrl chords. macLike returns the map untouched. When canonicalization makes two triggers
 * identical (both `super+x` and `ctrl+x` bound), the LAST one in map order wins — overrides
 * are applied after defaults, so a user's line beats a shipped default deterministically.
 */
export function canonicalKeyBindingsForPlatform(map: KeyBindingMap, macLike: boolean): KeyBindingMap {
    if (macLike) return map;
    const next = new Map<string, KeyBinding>();
    for (const binding of map.values()) {
        const trigger = canonicalTriggerForPlatform(binding.trigger, macLike);
        next.set(keyTriggerKey(trigger), { trigger, action: binding.action });
    }
    return next;
}
