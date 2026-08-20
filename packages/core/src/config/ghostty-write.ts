/**
 * A surgical writer for `~/.config/ghostty/config`.
 *
 * The daemon READS five ghostty keys (`daemon/src/settings/ghostty.ts`) and now writes those
 * same five, because Settings ▸ Appearance has to be able to change a background, an opacity
 * and a font — and ghostty, not Nex, owns that file.
 *
 * The bar this has to clear is **preservation**: a user's ghostty config is a large, personal,
 * hand-maintained file full of keys this codebase deliberately does not understand. So the
 * transform is textual and minimal, exactly like `setGeneralSetting` in `./write.ts`:
 *
 *   - every line that is not the key being written survives **byte-for-byte** — comments,
 *     blanks, `config-file` includes, keybinds, palette entries, indentation, CRLF-less
 *     trailing whitespace, all of it;
 *   - the FIRST line declaring the key is rewritten in place, so the value keeps its position
 *     in the file (a key that lived under a `# fonts` comment stays under it);
 *   - **later duplicate lines for that key are removed.** This is the one behavioural
 *     difference from `setGeneralSetting`, and ghostty's own semantics force it: repeated
 *     `font-family` lines ACCUMULATE into a fallback stack rather than the last one winning
 *     (`parseGhosttyAppearance`), so leaving the old lines behind would mean "set the font"
 *     silently appended a font instead. Collapsing to one line is the only write that means
 *     what the caller asked for, and it is harmless for the four last-one-wins keys;
 *   - a key that is absent is APPENDED after the existing content;
 *   - `value === null` deletes every line for the key and appends nothing — how "no explicit
 *     background, inherit the theme" is expressed.
 *
 * Comment lines are never touched: `# background = #ff0000` starts with `#`, so
 * `configLineKey` returns null for it and it is preserved as the comment it is.
 */

import { configLineKey, ensureTrailingNewline, splitConfigLines, stripTrailingBlankLines } from './lines.js';

/**
 * Replace / append / delete one `key = value` line in a ghostty-syntax config.
 *
 * Returns the new contents. Unlike `writeKeybindings` this never returns null: the daemon does
 * not own the ghostty file's existence, so it must not delete it — a file emptied of every key
 * we understand still belongs to the user.
 */
export function setGhosttySetting(contents: string | null, key: string, value: string | null): string {
    const lines = splitConfigLines(contents ?? '');
    const canonical = `${key} = ${value ?? ''}`;
    const kept: string[] = [];
    let written = false;

    for (const line of lines) {
        if (configLineKey(line) !== key) {
            kept.push(line);
            continue;
        }
        if (value === null) continue; // delete: drop every line for this key
        if (written) continue; // collapse the accumulating duplicates
        kept.push(canonical);
        written = true;
    }

    if (value !== null && !written) {
        stripTrailingBlankLines(kept);
        kept.push(canonical);
    }

    const output = kept.join('\n');
    // A delete that empties the file leaves an empty file rather than a lone newline.
    return output.trim() === '' ? '' : ensureTrailingNewline(output);
}

/**
 * A `font-family` value ghostty will read back as exactly one family.
 *
 * Bare is the idiomatic spelling and ghostty accepts spaces in it (`font-family = JetBrains
 * Mono`), so the writer leaves a plain name plain — a config full of gratuitous quotes is a
 * config a user stops recognising as their own. Quoting is reserved for the names that would
 * otherwise change the *line's* meaning: a `#` starts a comment, and a leading quote would be
 * stripped by `unquote` on the way back in. Both halves agree, so the value round-trips.
 */
export function ghosttyFontFamilyValue(family: string): string {
    const name = family.trim();
    if (name === '') return '';
    const needsQuotes = name.includes('#') || name.startsWith('"') || name.startsWith("'");
    return needsQuotes ? `"${name.replace(/["#]/g, '')}"` : name;
}

/** `#RRGGBB` lowercase — the spelling `parseGhosttyColor` normalizes to on read. */
export function ghosttyColorValue(hex: string): string | null {
    const value = hex.trim().replace(/^#/, '').toLowerCase();
    if (/^[0-9a-f]{6}$/.test(value)) return `#${value}`;
    if (/^[0-9a-f]{3}$/.test(value)) {
        const [r, g, b] = [value[0] as string, value[1] as string, value[2] as string];
        return `#${r}${r}${g}${g}${b}${b}`;
    }
    return null;
}
