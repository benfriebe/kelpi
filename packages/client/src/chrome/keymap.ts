/**
 * The window's keyboard map as one read-only model: what Help draws and what the chrome snapshot
 * publishes (`docs/plugin-chrome.md`).
 *
 * Help used to read the binding map directly and knew nothing about plugins, so a plugin command
 * and its shortcut were in the palette and in Settings ▸ Plugins but never in Help. Both halves now
 * come from here. The native half is the same `KeyBindingMap` the dispatcher resolves; the plugin
 * half is the dispatcher's own chord resolution (`resolvePluginChords`, handed over by
 * `usePluginCommands`), so a rebind, an unbind or a collision reads here exactly as the keyboard
 * behaves. Every value is a string, a number or null: a view can be handed it, and nothing in it
 * can change a binding.
 *
 * Help is reference rather than a menu, so a command is listed whatever its `when` says, with the
 * shortcut it runs on while it applies. A plugin shortcut a native chord or an earlier plugin
 * command claims first is listed with what that chord runs instead, and one a later plugin command
 * holds while this command does not apply is listed with what it runs right now, because that is
 * what the user will see happen.
 */

import { canonicalTriggerForPlatform, parseKeyTrigger, type KeyBindingMap } from '@kelpi/core/config';

import { chordKeysForTrigger } from '../content/bridge';
import type { ChromeKeymap, ChromeKeymapCommand } from '../plugins/chrome';
import type { ResolvedPluginChord } from '../plugins/shortcuts';
import { ACTION_CATALOG, VISIBLE_CATEGORIES, actionLabel } from '../settings/catalog';
import { CLIENT_MAC_LIKE, displayKeyTrigger, shortcutForAction } from './keys';

/** The two chords Kelpi dispatches outside the binding map (`App.tsx`), yielding to it. */
const WINDOW_CHORDS: readonly (readonly [string, string])[] = [
    ['8/Comma', 'Settings'],
    ['8/Slash', 'Kelpi Help'],
    ['12/Slash', 'Kelpi Help']
];

/**
 * Every chord the window claims before a plugin can, with the name of what it runs.
 *
 * The keys are the set a plugin shortcut must never take (`usePluginCommands`' reserved chords);
 * the names are what Help says a shadowed plugin shortcut runs instead. The order is the order the
 * window honours them: the global hotkey first, because the dispatcher refuses a binding that
 * shadows it; then the binding map; then ⌘, and ⌘/, whose own listeners yield to the map.
 */
export function nativeChordOwners(
    bindings: KeyBindingMap,
    globalHotkey: string | null | undefined,
    macLike: boolean
): ReadonlyMap<string, string> {
    const owners = new Map<string, string>();
    const claim = (keys: readonly string[], name: string): void => {
        for (const key of keys) if (!owners.has(key)) owners.set(key, name);
    };
    const global = globalHotkey ? parseKeyTrigger(globalHotkey) : null;
    if (global) claim(chordKeysForTrigger(canonicalTriggerForPlatform(global, macLike)), 'Global hotkey');
    for (const binding of bindings.values()) claim(chordKeysForTrigger(binding.trigger), actionLabel(binding.action));
    for (const [key, name] of WINDOW_CHORDS) claim([key], name);
    return owners;
}

/** A plugin command as the model needs it; `usePluginCommands().commands` rows are this shape. */
export interface KeymapPluginCommand {
    readonly id: string;
    readonly title: string;
    readonly pluginID: string;
    readonly pluginName: string;
}

export interface KeymapInput {
    readonly bindings: KeyBindingMap;
    /** `nativeChordOwners` for the same map: what a shadowed plugin shortcut runs, by name. */
    readonly native: ReadonlyMap<string, string>;
    /** The dispatcher's resolution (`usePluginCommands().shortcuts`), in plugin and declaration order (the order that wins a collision). */
    readonly plugins: readonly ResolvedPluginChord<KeymapPluginCommand>[];
    readonly macLike?: boolean | undefined;
}

/** The whole map, unbounded: Help's rows. The snapshot carries `boundKeymap` of the same value. */
export function buildKeymap(input: KeymapInput): ChromeKeymap {
    const macLike = input.macLike ?? CLIENT_MAC_LIKE;
    const sections = VISIBLE_CATEGORIES.map((category) => ({
        category,
        actions: ACTION_CATALOG.filter((entry) => entry.category === category).map((entry) => ({
            action: entry.action,
            title: entry.label,
            shortcut: shortcutForAction(input.bindings, entry.action, macLike) ?? null
        }))
    })).filter((section) => section.actions.length > 0);
    // Grouped by plugin identity, labelled by display name: two plugins may share a name.
    const groups = new Map<string, { name: string; commands: ChromeKeymapCommand[] }>();
    for (const { command, trigger, keys, takenBy, heldBy } of input.plugins) {
        let group = groups.get(command.pluginID);
        if (group === undefined) groups.set(command.pluginID, (group = { name: command.pluginName, commands: [] }));
        const chord = trigger === null ? null : displayKeyTrigger(trigger, macLike);
        const owner = takenBy?.command ?? null;
        group.commands.push({
            id: command.id,
            title: command.title,
            shortcut: keys.length > 0 ? chord : null,
            shadowed:
                takenBy === null || chord === null
                    ? null
                    : {
                          shortcut: chord,
                          by: owner === null ? input.native.get(takenBy.chord) ?? 'Kelpi' : owner.title,
                          plugin: owner === null ? null : owner.pluginName
                      },
            currently: heldBy === null ? null : { by: heldBy.title, plugin: heldBy.pluginName }
        });
    }
    return { sections, plugins: [...groups.values()], withheld: 0 };
}

/**
 * The whole keymap's share of the 256 KiB chrome frame.
 *
 * The native half is a few KiB and fixed. The plugin half is not: a hundred plugins may each
 * declare a hundred commands, and an oversized snapshot is undeliverable, which would fail every
 * replacement toolbar over somebody else's command titles. A quarter of the frame leaves room for
 * several hundred commands after the native half.
 */
export const KEYMAP_SNAPSHOT_BYTES = 64 * 1024;

const encoder = new TextEncoder();
const bytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength;

/**
 * The keymap cut to a byte budget, measured as `pluginJSON` measures it. The carried plugin
 * commands are always a prefix of the list, so `withheld` means "everything after these", the
 * same rule the pane chrome frame keeps for its panes. The native sections are always carried.
 */
export function boundKeymap(keymap: ChromeKeymap, budget: number = KEYMAP_SNAPSHOT_BYTES): ChromeKeymap {
    // The envelope is measured with the largest `withheld` this cut could report, so the count's
    // digits can never push the result past the budget.
    const total = keymap.plugins.reduce((sum, group) => sum + group.commands.length, 0);
    let used = bytes({ ...keymap, plugins: [], withheld: total + keymap.withheld });
    let withheld = 0;
    const plugins: ChromeKeymap['plugins'][number][] = [];
    for (const group of keymap.plugins) {
        if (withheld > 0) {
            withheld += group.commands.length;
            continue;
        }
        // `+ 1` for each joining comma, keeping the sum an over-estimate.
        let cost = bytes({ name: group.name, commands: [] }) + 1;
        const commands: ChromeKeymapCommand[] = [];
        for (const [index, command] of group.commands.entries()) {
            const next = bytes(command) + 1;
            if (used + cost + next > budget) {
                withheld = group.commands.length - index;
                break;
            }
            cost += next;
            commands.push(command);
        }
        if (commands.length > 0) {
            plugins.push({ name: group.name, commands });
            used += cost;
        }
    }
    return { sections: keymap.sections, plugins, withheld: withheld + keymap.withheld };
}
