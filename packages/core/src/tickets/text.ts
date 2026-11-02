/**
 * Untrusted text: whatever a ticket's author typed, on its way into a workspace name, a branch, an
 * agent prompt or a line of the ticket file (docs/integrations.md "Untrusted text").
 *
 * Anyone who can open an issue or a pull request writes these strings, so they are treated the way
 * a terminal treats bytes from a remote host:
 *
 *   - characters that are invisible or reorder what is shown are dropped everywhere: C0 controls
 *     other than TAB and LF, DEL, the C1 block, soft hyphen, the bidi embeddings, overrides and
 *     isolates (`invoice` + U+202E + `gpj.exe` displays as `invoiceexe.jpg`), the zero-width
 *     space, joiners and BOM, variation selectors, and the Unicode tag block, which can spell out
 *     ASCII that a model reads and a human never sees;
 *   - a one-line field (a title, a label, a login, a branch) becomes one line, its whitespace runs
 *     one space, and is capped with an ellipsis, never splitting a surrogate pair;
 *   - in a one-line field that reaches an agent prompt, `@` becomes `＠` (U+FF20, FULLWIDTH
 *     COMMERCIAL AT): both Claude Code and Codex read `@<path>` in a prompt as "attach this file",
 *     so a title such as `Fix @~/.aws/credentials` would otherwise ask the agent to read the
 *     user's credentials. The fullwidth form reads the same to a person and to the model, and is
 *     no mention to either tool.
 *
 * Pure string work, no Node imports: the daemon, the client and the CLI all take it.
 */

/**
 * Invisible or reordering characters (module note). TAB (U+0009), LF (U+000A) and CR (U+000D) are
 * not in it: the callers decide what a line break means for their field.
 */
const INVISIBLE_PATTERN =
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFE00-\uFE0F\uFEFF\uFFF9-\uFFFB\u{E0000}-\u{E01EF}]/gu;

/** CRLF, a lone CR, and the Unicode line and paragraph separators: all one LF. */
const LINE_BREAK_PATTERN = /\r\n?|[\u2028\u2029]/g;

/**
 * Multi-line untrusted text (a body, a comment): line breaks become LF, every invisible or
 * reordering character is dropped, TAB and LF are kept. Nothing else changes.
 */
export function cleanUntrustedText(text: string): string {
    return text.replace(LINE_BREAK_PATTERN, '\n').replace(INVISIBLE_PATTERN, '');
}

/** True when the text holds any character `cleanUntrustedText` would drop (a branch must not). */
export function hasInvisibleCharacters(text: string): boolean {
    INVISIBLE_PATTERN.lastIndex = 0;
    const found = INVISIBLE_PATTERN.test(text);
    INVISIBLE_PATTERN.lastIndex = 0;
    return found;
}

/**
 * Cut `text` to at most `maxLength` UTF-16 units, ending in `…` when anything was cut, never
 * splitting a surrogate pair. UTF-16 units rather than code points so a caller's length budget
 * (`prompt.length < 800`) holds for a title made entirely of emoji too.
 */
export function capText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    if (maxLength <= 0) return '';
    let end = maxLength - 1;
    // Never leave a lone high surrogate at the cut.
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    return `${text.slice(0, end).trimEnd()}…`;
}

/**
 * One line of untrusted text: cleaned, every whitespace run (TAB and LF included) one space,
 * trimmed, then capped at `maxLength` UTF-16 units with an ellipsis.
 */
export function untrustedLine(text: string, maxLength: number): string {
    return capText(cleanUntrustedText(text).replace(/\s+/g, ' ').trim(), maxLength);
}

/** `@` → `＠` (U+FF20), so the text can never be read as a file mention (module note). */
export function neutralizeMentions(text: string): string {
    return text.replace(/@/g, '\uFF20');
}

/** The UTF-8 length of `text`, without a TextEncoder (core stays free of platform globals). */
export function utf8ByteLength(text: string): number {
    let bytes = 0;
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    }
    return bytes;
}

export interface CappedText {
    readonly text: string;
    /** How many UTF-8 bytes were cut off the end; 0 when the text fit. */
    readonly droppedBytes: number;
}

/** Cut `text` to at most `maxBytes` UTF-8 bytes, at a code point boundary. */
export function capUtf8(text: string, maxBytes: number): CappedText {
    const total = utf8ByteLength(text);
    if (total <= maxBytes) return { text, droppedBytes: 0 };
    let bytes = 0;
    let end = 0;
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
        if (bytes + size > maxBytes) break;
        bytes += size;
        end += char.length;
    }
    return { text: text.slice(0, end), droppedBytes: total - bytes };
}
