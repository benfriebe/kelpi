/**
 * Config writers as pure text transforms: take the current file contents (null when the
 * file does not exist) and return the new contents. The daemon owns mkdir + atomic write.
 * Spec: docs/current/config-keybindings.md §1.3, §1.6.
 */

import { KELPI_ACTIONS, UNBIND_ACTION } from './actions.js';
import { DEFAULT_KEYBINDINGS, actionForTrigger, triggersForAction } from './bindings.js';
import type { KeyBindingMap } from './bindings.js';
import { keyTriggerConfigString } from './keys.js';
import {
    configLineKey,
    ensureTrailingNewline,
    splitConfigLines,
    stripTrailingBlankLines
} from './lines.js';
import { serializeProfileLines } from './profiles.js';
import type { Profile } from './profiles.js';

/**
 * Replace (or append) one `key = value` line, keeping every other line byte-for-byte -
 * comments, blanks, keybinds and profiles all survive.
 *
 * Quirk preserved: when the key appears on MULTIPLE lines, every one of them is replaced
 * with the same new line (duplicates persist as duplicates).
 */
export function setGeneralSetting(contents: string | null, key: string, value: string): string {
    const canonical = `${key} = ${value}`;
    const lines = splitConfigLines(contents ?? '');
    let matched = false;
    const rewritten = lines.map((line) => {
        if (configLineKey(line) !== key) return line;
        matched = true;
        return canonical;
    });
    if (!matched) {
        stripTrailingBlankLines(rewritten);
        rewritten.push(canonical);
    }
    return ensureTrailingNewline(rewritten.join('\n'));
}

/**
 * Full-replacement write of the profile section: drop every `profile` line, keep all
 * other lines verbatim, then append the serialized profiles after one blank separator
 * (only when something was preserved). Writing zero profiles into a file that holds
 * nothing else yields an empty file.
 */
export function writeProfiles(contents: string | null, profiles: readonly Profile[]): string {
    const preserved = stripTrailingBlankLines(
        splitConfigLines(contents ?? '').filter((line) => configLineKey(line) !== 'profile')
    );
    const profileLines = serializeProfileLines(profiles);
    if (preserved.length === 0 && profileLines.length === 0) return '';
    const output = [...preserved];
    if (profileLines.length > 0 && preserved.length > 0) output.push('');
    output.push(...profileLines);
    return ensureTrailingNewline(output.join('\n'));
}

/**
 * §5.3's preserved-line filter: a raw line is a keybind line when its TRIMMED text starts
 * with `keybind` and contains an `=`.
 *
 * Deliberately a prefix test rather than `configLineKey(line) === 'keybind'`, because that
 * is what the Swift writer does — so `keybindx = split_right` (which the *parser* skips as
 * an unknown key, §1.4 step 1) is nonetheless dropped by the *writer*. Quirk preserved: the
 * two halves disagree, and matching the shipped app matters more than matching each other.
 * A commented-out `# keybind = …` starts with `#` and therefore survives.
 */
function isKeybindLine(line: string): boolean {
    const trimmed = line.trim();
    return trimmed.startsWith('keybind') && trimmed.includes('=');
}

function keybindLine(trigger: string, action: string): string {
    return `keybind = ${trigger}=${action}`;
}

/**
 * §5.3 — write the keybinding map as the DIFF from the shipped defaults, preserving every
 * non-keybind line byte-for-byte.
 *
 * Returns the new file contents, or **`null` meaning "delete the file"**: §5.3 ends with
 * "if lines empty and preserved empty: DELETE the file", which is how "reset everything to
 * defaults on a config that held nothing else" leaves no file behind. (`writeProfiles` writes
 * an empty file in the same situation — the two writers genuinely differ; §14 spells the
 * keybinding half out as "empty file gets deleted by the keybinding writer".)
 *
 * Emission order is deterministic across launches: actions in `KELPI_ACTIONS` order, and each
 * action's triggers in `triggersForAction` order (sorted by `configString`).
 */
export function writeKeybindings(contents: string | null, map: KeyBindingMap): string | null {
    const preserved = stripTrailingBlankLines(
        splitConfigLines(contents ?? '').filter((line) => !isKeybindLine(line))
    );

    const lines: string[] = [];
    /** Trigger config strings already emitted — pass 2's dedupe key. */
    const written = new Set<string>();

    // Pass 1: what the user changed about each action.
    for (const action of KELPI_ACTIONS) {
        // (a) triggers now bound to this action that the defaults did not map to it.
        for (const trigger of triggersForAction(map, action)) {
            if (actionForTrigger(DEFAULT_KEYBINDINGS, trigger) === action) continue;
            const config = keyTriggerConfigString(trigger);
            lines.push(keybindLine(config, action));
            written.add(config);
        }
        // (b) default triggers of this action that are no longer bound to anything.
        for (const trigger of triggersForAction(DEFAULT_KEYBINDINGS, action)) {
            if (actionForTrigger(map, trigger) !== null) continue;
            const config = keyTriggerConfigString(trigger);
            lines.push(keybindLine(config, UNBIND_ACTION));
            written.add(config);
        }
    }

    // Pass 2: a default trigger rebound to a different action. Pass 1(a) already emitted it
    // while walking the NEW action, so this is a belt-and-braces sweep the spec spells out —
    // it only fires for a trigger pass 1 could not reach.
    for (const action of KELPI_ACTIONS) {
        for (const trigger of triggersForAction(DEFAULT_KEYBINDINGS, action)) {
            const now = actionForTrigger(map, trigger);
            if (now === null || now === action) continue;
            const config = keyTriggerConfigString(trigger);
            if (written.has(config)) continue;
            lines.push(keybindLine(config, now));
            written.add(config);
        }
    }

    if (lines.length === 0 && preserved.length === 0) return null;

    const output = [...preserved];
    if (lines.length > 0 && preserved.length > 0) output.push('');
    output.push(...lines);
    return ensureTrailingNewline(output.join('\n'));
}
