/**
 * Where a URL found in running text ends.
 *
 * One rule for every place the daemon finds a link in prose, so they cannot drift apart: the
 * terminal's ⌘-click and hover underline (`tokenRangeAt`, `ws/desktop.ts`) and the markdown
 * preview's bare-URL autolinks (`autolinkText`, `content/markdown.ts`). The caller has found
 * where the URL starts (its scheme); this says where a reader would take it to stop.
 */

/** Bracket pairs a link sits inside or carries: ASCII, and the full-width and CJK ones prose uses. */
const PAIRS: ReadonlyArray<readonly [string, string]> = [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
    ['（', '）'],
    ['［', '］'],
    ['｛', '｝'],
    ['【', '】'],
    ['「', '」']
];
/** An opening bracket → its closer. */
export const OPENERS: ReadonlyMap<string, string> = new Map(PAIRS);
/** A closing bracket → its opener. */
export const CLOSERS: ReadonlyMap<string, string> = new Map(PAIRS.map(([open, close]) => [close, open]));

/** Prose punctuation no URL holds: curly quotes, an em dash, an ellipsis. It ends a link. */
export const PROSE_BREAK: ReadonlySet<string> = new Set(['‘', '’', '“', '”', '—', '…']);

/** Sentence punctuation trimmed off the end of a link, ASCII and full-width. */
export const TRAILING_PUNCTUATION: ReadonlySet<string> = new Set(['.', ',', ';', ':', '。', '、', '，', '；', '：', '！', '？']);

/**
 * The end (exclusive) of the URL that starts at `start` in `text`, reading no further than `limit`.
 *
 * - Brackets pair as the URL goes, and the first closer with no opener of its own inside the URL
 *   ends it: `(https://x/a).`, `[docs](https://x/a)` and `（https://x/a）を参照` all stop at the
 *   wrapper's closer, while `https://en.wikipedia.org/wiki/A_(b)` and `?q=(1)` keep theirs.
 * - `PROSE_BREAK` ends it: `“https://x/a”`, `https://x/a—see`, `https://x/a…`.
 * - `TRAILING_PUNCTUATION` comes off the end: `see https://x/a.`
 * - A `?` comes off only while it would open an empty query (`did you see https://x/a?`). In a
 *   query or a fragment it is data: `?q=why?`, `#why?`.
 * - A `!` stays: `https://en.wikipedia.org/wiki/Yahoo!` is a page of its own. One after a bracket
 *   is already outside the URL: `(https://x/a)!`.
 *
 * One pass, so a minified bundle's line costs no more than its length.
 */
export function urlEnd(text: string, start: number, limit: number = text.length): number {
    const closers: string[] = [];
    let query = -1;
    let fragment = -1;
    let end = start;
    for (; end < limit; end += 1) {
        const char = text[end] as string;
        if (PROSE_BREAK.has(char)) break;
        const close = OPENERS.get(char);
        if (close !== undefined) {
            closers.push(close);
        } else if (CLOSERS.has(char)) {
            if (closers[closers.length - 1] !== char) break;
            closers.pop();
        } else if (char === '?' && query < 0) {
            query = end;
        } else if (char === '#' && fragment < 0) {
            fragment = end;
        }
    }
    while (end > start) {
        const char = text[end - 1] as string;
        const emptyQuery = char === '?' && end - 1 === query && fragment < 0;
        if (!TRAILING_PUNCTUATION.has(char) && !emptyQuery) break;
        end -= 1;
    }
    return end;
}
