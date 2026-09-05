/**
 * Line syntax shared by every `~/.config/nex/config` parser and writer.
 * Spec: docs/config-keybindings.md §1.1.
 */

export interface ConfigLine {
    readonly key: string;
    readonly value: string;
}

/** Split preserving empty lines (writers keep unrelated lines byte-for-byte). */
export function splitConfigLines(contents: string): string[] {
    return contents.split('\n');
}

/**
 * Trim, skip empties and whole-line `#` comments, split at the FIRST `=`.
 * There is no inline-comment support: `focus-follows-mouse = true # hi` parses the value
 * as `true # hi` (and therefore does NOT enable the setting).
 */
export function parseConfigLine(line: string): ConfigLine | null {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return null;
    const separator = trimmed.indexOf('=');
    if (separator < 0) return null;
    return {
        key: trimmed.slice(0, separator).trim(),
        value: trimmed.slice(separator + 1).trim()
    };
}

/** The key a raw line declares, for writers that rewrite or drop lines by key. */
export function configLineKey(line: string): string | null {
    return parseConfigLine(line)?.key ?? null;
}

/** Every parsed setting line, in file order. */
export function parseConfigLines(contents: string): ConfigLine[] {
    const parsed: ConfigLine[] = [];
    for (const line of splitConfigLines(contents)) {
        const entry = parseConfigLine(line);
        if (entry !== null) parsed.push(entry);
    }
    return parsed;
}

/** Drop trailing blank/whitespace-only lines (mutates the array, writer-internal). */
export function stripTrailingBlankLines(lines: string[]): string[] {
    while (lines.length > 0 && (lines.at(-1) ?? '').trim() === '') {
        lines.pop();
    }
    return lines;
}

export function ensureTrailingNewline(contents: string): string {
    if (contents === '') return '';
    return contents.endsWith('\n') ? contents : `${contents}\n`;
}
