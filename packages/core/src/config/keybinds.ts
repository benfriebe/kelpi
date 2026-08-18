/**
 * `keybind = <trigger>=<action>` line parsing.
 * Spec: docs/current/config-keybindings.md §1.4.
 */

import { parseKeybindValue } from './bindings.js';
import type { KeybindOverride } from './bindings.js';
import { parseConfigLines } from './lines.js';

/**
 * Ordered override list in file order. A line whose key is not exactly `keybind`
 * (`keybindx = …`), whose value has no `=`, whose trigger has an unknown key/modifier,
 * or whose action is not a known raw value (or `unbind`) is skipped.
 */
export function parseKeybindOverrides(contents: string): KeybindOverride[] {
    const overrides: KeybindOverride[] = [];
    for (const { key, value } of parseConfigLines(contents)) {
        if (key !== 'keybind') continue;
        const override = parseKeybindValue(value);
        if (override !== null) overrides.push(override);
    }
    return overrides;
}
