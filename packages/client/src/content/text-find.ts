/**
 * Find in the built-in editor (content-panes.md §4.4): the match model.
 *
 * The preview's find walks a rendered document's text nodes inside a sandboxed frame (§3.13);
 * the editor's buffer is one string the host already holds, so its find is a scan of that string
 * and nothing else. The RULES are §3.13's, restated for a string so ⌘F means the same thing on
 * both sides of ⌘E:
 *
 *   - a literal substring, case-folded by the regex engine: the needle's metacharacters are
 *     escaped and the pattern runs under `gi`, so a character whose case change alters its length
 *     (Turkish dotted I, eszett) cannot drift the offsets the way lowercasing the haystack would;
 *   - zero-length matches are skipped by advancing `lastIndex`;
 *   - stepping wraps around modulo the match count.
 *
 * Everything here is pure and framework-free so it can be tested without a DOM. The editor turns
 * a match into a selection, a scroll and a highlight (`PlainTextEditor.tsx`).
 */

/** One match, as UTF-16 offsets into the buffer: `start` inclusive, `end` exclusive. */
export interface TextMatch {
    readonly start: number;
    readonly end: number;
}

/** A run of the highlight layer: plain text, a match, or THE match the bar is on. */
export interface FindSegment {
    readonly text: string;
    readonly kind: 'text' | 'match' | 'current';
}

/** The same escape the injected `__kelpiFind` applies before it builds its pattern. */
function escapeNeedle(needle: string): string {
    return needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every match of `needle` in `text`, in document order. An empty needle matches nothing. */
export function findTextMatches(text: string, needle: string): TextMatch[] {
    if (needle.length === 0 || text.length === 0) return [];
    const pattern = new RegExp(escapeNeedle(needle), 'gi');
    const matches: TextMatch[] = [];
    let match = pattern.exec(text);
    while (match !== null) {
        if (match[0].length === 0) pattern.lastIndex += 1;
        else matches.push({ start: match.index, end: match.index + match[0].length });
        match = pattern.exec(text);
    }
    return matches;
}

/**
 * The next selection after a Return (`delta` 1) or a ⇧Return (`delta` -1): `(current ± 1 +
 * total) % total`, §3.13's wrap-around. No matches is -1; a bar that has nothing selected yet
 * lands on the first match going forward and the last going back.
 */
export function stepMatch(current: number, total: number, delta: 1 | -1): number {
    if (total <= 0) return -1;
    if (current < 0 || current >= total) return delta > 0 ? 0 : total - 1;
    return (current + delta + total) % total;
}

/**
 * The offset a `<textarea>` holding `text` uses for `offset` into it.
 *
 * A textarea's API value normalizes every CRLF to LF (HTML's newline normalization), so a buffer
 * that still carries a file's CRLFs (nothing has been typed into it yet) is one character longer
 * per line ending than the field it fills, and `setSelectionRange` with a raw offset lands that
 * many characters late. A buffer with no CR maps to itself without a scan.
 */
export function fieldOffset(text: string, offset: number): number {
    let index = text.indexOf('\r');
    if (index === -1) return offset;
    let removed = 0;
    while (index !== -1 && index < offset) {
        if (text.charCodeAt(index + 1) === 10) removed += 1;
        index = text.indexOf('\r', index + 1);
    }
    return offset - removed;
}

/**
 * A run as the highlight layer draws it: a CR that ends a line is dropped, because the textarea
 * shows that line ending as one LF and the layer has to lay out exactly what the field does.
 */
export function shownRun(text: string): string {
    return text.indexOf('\r') === -1 ? text : text.replace(/\r(?=\n|$)/g, '');
}

/** The index of the first match that ends after `offset` (binary search; `matches.length` if none). */
function firstMatchEndingAfter(matches: readonly TextMatch[], offset: number): number {
    let low = 0;
    let high = matches.length;
    while (low < high) {
        const mid = (low + high) >> 1;
        if ((matches[mid] as TextMatch).end <= offset) low = mid + 1;
        else high = mid;
    }
    return low;
}

/**
 * The highlight layer's runs for the slice `[from, to)` of the buffer.
 *
 * The layer only draws the lines over the viewport (the gutter's window, CONT-078's bounded node
 * count), so this starts with a binary search for the first match in reach rather than a walk
 * from the top of the document, and clips a match that straddles either edge.
 */
export function findSegments(
    text: string,
    from: number,
    to: number,
    matches: readonly TextMatch[],
    current: number
): FindSegment[] {
    const segments: FindSegment[] = [];
    const end = Math.min(Math.max(to, from), text.length);
    let cursor = Math.max(0, from);
    for (let index = firstMatchEndingAfter(matches, cursor); index < matches.length; index += 1) {
        const match = matches[index] as TextMatch;
        if (match.start >= end) break;
        const start = Math.max(match.start, cursor);
        if (start > cursor) segments.push({ text: text.slice(cursor, start), kind: 'text' });
        const stop = Math.min(match.end, end);
        segments.push({ text: text.slice(start, stop), kind: index === current ? 'current' : 'match' });
        cursor = stop;
    }
    if (cursor < end) segments.push({ text: text.slice(cursor, end), kind: 'text' });
    return segments;
}
