/**
 * The keybinding map: defaults, override application, lookups.
 * Spec: docs/config-keybindings.md §1.4, §5.1, §5.2.
 */

import { isKelpiAction, UNBIND_ACTION } from './actions.js';
import type { KelpiAction, UnbindAction } from './actions.js';
import {
    canonicalTriggerForPlatform,
    triggerExpressibleOnPlatform,
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
 * bound: `super+==increase_terminal_font_size`), then validate both halves.
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

/** §5.2 - the 47 shipped default triggers, in `<trigger>=<action>` form. */
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
    /*
     * #175: ⌘= / ⌘- / ⌘0 are TERMINAL text size, and step the daemon-wide ghostty `font-size`.
     *
     * They were `increase/decrease/reset_markdown_font_size` before this, and those three actions
     * are still in the vocabulary and still rebindable; what moved is which action the three
     * shipped chords resolve to. Nothing a person can see changed for a markdown preview: the
     * terminal handlers offer a focused preview pane its own font size FIRST and only then step
     * the daemon's, which is the same precedence `toggle_search` uses to route ⌘F by pane type
     * (`App.tsx`). Two triggers for increase because ⌘+ on a US layout is a shifted `=`, exactly
     * as the web pane's own zoom layer reads it (`webpane/priority.ts`).
     */
    'super+==increase_terminal_font_size',
    'shift+super+==increase_terminal_font_size',
    'super+-=decrease_terminal_font_size',
    'super+0=reset_terminal_font_size',
    'shift+super+return=toggle_zoom',
    // Zen Mode is pane zoom's window-level sibling: ⇧⌘↩ gives one pane the grid, ⌃⌘↩ gives the
    // grid the window. Not ⌃⌘F, which is the platform's Toggle Full Screen (`platform-chords.ts`).
    'ctrl+super+return=toggle_zen_mode',
    'shift+super+t=reopen_closed_pane',
    'super+f=toggle_search',
    'escape=close_search',
    // #81. Binding them is also what keeps the kitty interceptor from ever seeing them: the
    // app's dispatcher is a window capture listener and runs first (§7.2).
    'super+c=copy',
    'super+v=paste',
    // #82: Ghostty's macOS natural-text-editing defaults, byte for byte
    // (`src/config/Config.zig:7315-7334`: super+backspace -> text \x15, super+left -> \x01,
    // super+right -> \x05). Bindings rather than an encoder rule, so `unbind` restores the
    // fixterm encoding exactly as Ghostty's own comment promises.
    'super+backspace=kill_line_backward',
    'super+left=move_to_line_start',
    'super+right=move_to_line_end',
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

/**
 * Default triggers that are two SPELLINGS of one chord: `super+=` and `shift+super+=` (#175).
 *
 * The distinction this encodes, and it is the whole of the rule: `focus_next_pane`'s `super+]`
 * and `alt+super+right` are two SHORTCUTS for one action, and unbinding one must leave the other
 * alone. `super+=` and `shift+super+=` are not two shortcuts. They are the same chord typed on
 * the same physical key, split in two only because ⌘+ on a US layout is a shifted `=` and the
 * map matches on the physical key. A user who writes `keybind = super+==unbind`, or who binds
 * ⌘= back to the markdown preview's own font size, has said what ⌘+ should do, and would
 * otherwise still have ⇧⌘= resizing every terminal on the daemon: the same chord doing the very
 * thing they just took away.
 *
 * Derived rather than listed, so a later pair inherits the rule: two DEFAULT bindings pair when
 * they carry the same key code and the same action and their modifier sets differ by exactly
 * `shift`. Keyed both ways, trigger identity to the twin's binding.
 */
function buildShiftTwins(): ReadonlyMap<string, KeyBinding> {
    const twins = new Map<string, KeyBinding>();
    const bindings = [...DEFAULT_KEYBINDINGS.values()];
    for (const one of bindings) {
        for (const other of bindings) {
            if (one === other) continue;
            if (one.trigger.keyCode !== other.trigger.keyCode || one.action !== other.action) continue;
            if (!differByShiftAlone(one.trigger, other.trigger)) continue;
            twins.set(keyTriggerKey(one.trigger), other);
        }
    }
    return twins;
}

function differByShiftAlone(a: KeyTrigger, b: KeyTrigger): boolean {
    const without = (trigger: KeyTrigger): string =>
        [...trigger.modifiers].filter((modifier) => modifier !== 'shift').sort().join('+');
    if (without(a) !== without(b)) return false;
    return a.modifiers.includes('shift') !== b.modifiers.includes('shift');
}

const DEFAULT_SHIFT_TWINS: ReadonlyMap<string, KeyBinding> = buildShiftTwins();

/**
 * The other spelling of a default chord, when this trigger has one and the map still holds it
 * as the shipped default. Exported for the client's display rule (`chrome/keys.ts`).
 */
export function shiftTwinBinding(map: KeyBindingMap, trigger: KeyTrigger): KeyBinding | null {
    const twin = DEFAULT_SHIFT_TWINS.get(keyTriggerKey(trigger));
    if (twin === undefined) return null;
    // Only while the twin is still the SHIPPED binding. A user who spelled out both lines has
    // bound two chords deliberately, and neither may take the other down.
    return map.get(keyTriggerKey(twin.trigger))?.action === twin.action ? twin : null;
}

/**
 * The ONE trigger a hint names for an action: §7.1's "first trigger in configString order", with
 * a display-only preference for the unshifted half of a two-spelling chord (#175).
 *
 * Declared here so the Help overlay, the palette hints and the shell's menu accelerators all read
 * the same answer. `shift+super+=` sorts before `super+=`, so without this Increase Terminal Text
 * Size is hinted ⇧⌘= - true, but the wrong half of a pair whose other half is on the keycap. The
 * preference is scoped to {@link shiftTwinBinding}'s same-key ±shift relation, so an action whose
 * triggers are genuinely different shortcuts (`focus_next_pane`'s ⌘] and ⌥⌘→) is untouched, and
 * the full trigger LIST is untouched too: Settings ▸ Keybindings still shows every chip.
 */
export function displayTriggerForAction(map: KeyBindingMap, action: KelpiAction): KeyTrigger | null {
    const triggers = triggersForAction(map, action);
    const unshiftedTwinPresent = (candidate: KeyTrigger): boolean =>
        candidate.modifiers.includes('shift') &&
        triggers.some(
            (sibling) =>
                !sibling.modifiers.includes('shift') &&
                shiftTwinBinding(map, sibling)?.trigger.keyCode === candidate.keyCode
        );
    const preferred = triggers.filter((candidate) => !unshiftedTwinPresent(candidate));
    return (preferred.length > 0 ? preferred : triggers)[0] ?? null;
}

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
 *
 * One addition (#175): a line that claims either spelling of a two-spelling default chord takes
 * the OTHER spelling's default with it, so `super+==unbind` really does take ⌘+ away rather than
 * leaving ⇧⌘= doing the thing that was just unbound. {@link shiftTwinBinding} states the rule and
 * why it is not the same as `focus_next_pane`'s two genuinely different shortcuts.
 */
export function applyKeybindOverrides(
    map: KeyBindingMap,
    overrides: readonly KeybindOverride[]
): KeyBindingMap {
    let next = map;
    for (const override of overrides) {
        const twin = shiftTwinBinding(next, override.trigger);
        if (twin !== null) next = removeBinding(next, twin.trigger);
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
 * A trigger naming both `ctrl` and `super` is dropped off-mac rather than collapsed onto the
 * plain Ctrl chord (`triggerExpressibleOnPlatform`).
 */
export function canonicalKeyBindingsForPlatform(map: KeyBindingMap, macLike: boolean): KeyBindingMap {
    if (macLike) return map;
    const next = new Map<string, KeyBinding>();
    for (const binding of map.values()) {
        // A ctrl+super chord has no Ctrl-primary spelling of its own; see the function's comment.
        if (!triggerExpressibleOnPlatform(binding.trigger, macLike)) continue;
        const trigger = canonicalTriggerForPlatform(binding.trigger, macLike);
        next.set(keyTriggerKey(trigger), { trigger, action: binding.action });
    }
    return next;
}
