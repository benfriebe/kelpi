/**
 * Config writers as pure text transforms: take the current file contents (null when the
 * file does not exist) and return the new contents. The daemon owns mkdir + atomic write.
 * Spec: docs/current/config-keybindings.md §1.3, §1.6.
 */

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
