/**
 * Markdown → HTML, the daemon half of content-panes.md §3.
 *
 * Pipeline (§3.1):
 *
 *   file text → extractFrontMatter → (yaml | null, body)
 *             → markdown-it parse (CommonMark + GFM tables/strikethrough)
 *             → our own token walker (§3.3 emission contract)
 *             → htmlDocument(frontMatterHTML + bodyHTML)
 *
 * markdown-it only PARSES here: the HTML is emitted by `renderTokens` below so the class names
 * the client's copy-button JS, find JS and stylesheet depend on (`code-block`, `code-copy-btn`,
 * `task-list-item`, `task-list-item-checkbox`, `frontmatter*`) match the spec exactly. Two
 * deliberate divergences from markdown-it's defaults, both spec'd:
 *
 *   - **linkify is OFF.** Bare domains (`example.com`) and bare emails must stay plain text;
 *     only explicit `http|https|ftp|file://` and `mailto:` runs become links (§3.4). GFM's
 *     autolink extension semantics are explicitly NOT wanted (port note 2).
 *   - **`html: true`.** Raw HTML passes through unescaped (§3.3, §11) — the preview is expected
 *     to be isolated client-side (port note 3), which is the client's job, not ours.
 */

import MarkdownIt, { type Token } from 'markdown-it';
import { isAlias, isMap, isScalar, isSeq, parseDocument, stringify, type Node } from 'yaml';

import {
    DEFAULT_CONTENT_BACKGROUND,
    escapeHtml,
    htmlDocument,
    isDarkBackground,
    type ContentAppearance
} from './html.js';

/** `Pane.markdownFontSize` default (§1.1). */
export const DEFAULT_MARKDOWN_FONT_SIZE = 14;

/** §3.5: bytes of front matter scanned before the extractor gives up. */
export const FRONT_MATTER_BYTE_LIMIT = 64 * 1024;

// ---------------------------------------------------------------------------
// Front matter (§3.5)
// ---------------------------------------------------------------------------

export interface FrontMatterSplit {
    /** The text between the fences, or null when there is no front matter. */
    readonly yaml: string | null;
    /** The markdown body (the ORIGINAL string, BOM included, when yaml is null). */
    readonly body: string;
}

const BOM = '﻿';
const OPEN_FENCE = /^---[ \t]*$/;
const CLOSE_FENCE = /^(?:---|\.\.\.)[ \t]*$/;

interface ScannedLine {
    readonly text: string;
    /** Index of the line's first character. */
    readonly start: number;
    /** Index just past the line's terminator (== text end at EOF). */
    readonly end: number;
}

/** Split on `\n`, `\r\n` or `\r`, keeping offsets (§3.5 rule 3). */
function scanLines(source: string): ScannedLine[] {
    const lines: ScannedLine[] = [];
    let start = 0;
    let index = 0;
    while (index < source.length) {
        const char = source[index] as string;
        if (char === '\n' || char === '\r') {
            const isCrLf = char === '\r' && source[index + 1] === '\n';
            const end = index + (isCrLf ? 2 : 1);
            lines.push({ text: source.slice(start, index), start, end });
            index = end;
            start = end;
            continue;
        }
        index += 1;
    }
    if (start < source.length) lines.push({ text: source.slice(start), start, end: source.length });
    return lines;
}

/** Drop exactly one trailing line terminator grapheme (§3.5 rule 6). */
function dropTrailingNewline(text: string): string {
    if (text.endsWith('\r\n')) return text.slice(0, -2);
    if (text.endsWith('\n') || text.endsWith('\r')) return text.slice(0, -1);
    return text;
}

export function extractFrontMatter(markdown: string): FrontMatterSplit {
    const working = markdown.startsWith(BOM) ? markdown.slice(1) : markdown;
    const lines = scanLines(working);
    const first = lines[0];
    if (first === undefined || !OPEN_FENCE.test(first.text)) {
        return { yaml: null, body: markdown };
    }

    let scanned = 0;
    for (let index = 1; index < lines.length; index += 1) {
        const line = lines[index] as ScannedLine;
        if (CLOSE_FENCE.test(line.text)) {
            const bodyStart = line.end;
            const between = working.slice((lines[1] ?? line).start, line.start);
            return {
                yaml: index === 1 ? '' : dropTrailingNewline(between),
                body: working.slice(bodyStart)
            };
        }
        // The guard runs on the way past each YAML line, BEFORE the text is materialized, so a
        // YAML bomb costs a scan and nothing else (§3.5 rule 5).
        scanned += Buffer.byteLength(line.text, 'utf8') + 1;
        if (scanned > FRONT_MATTER_BYTE_LIMIT) return { yaml: null, body: markdown };
    }
    return { yaml: null, body: markdown };
}

// ---------------------------------------------------------------------------
// Front-matter rendering (§3.6)
// ---------------------------------------------------------------------------

/** A scalar's text: strings verbatim, other scalars stringified, an empty value → "". */
function scalarText(node: unknown): string {
    if (isScalar(node)) {
        const value = node.value;
        if (typeof value === 'string') return value;
        if (value === null || value === undefined) return '';
        return String(value);
    }
    return String(node);
}

function isSingleLineScalar(node: unknown): boolean {
    return isScalar(node) && !scalarText(node).includes('\n');
}

/** Re-serialize a node to YAML text (unresolved aliases and cycles fall back to ""). */
function serializeNode(node: Node): string {
    try {
        return stringify(node);
    } catch {
        return '';
    }
}

function nestedPre(node: Node): string {
    return `<pre class="frontmatter-nested">${escapeHtml(serializeNode(node).trim())}</pre>`;
}

function renderFrontMatterValue(node: unknown): string {
    if (node === null || node === undefined) return '';
    if (isAlias(node)) return escapeHtml(`*${node.source}`);
    if (isScalar(node)) {
        const text = scalarText(node);
        return text.includes('\n') ? nestedPre(node) : escapeHtml(text);
    }
    if (isSeq(node)) {
        const items = node.items;
        // §L41: `every` over an EMPTY sequence is vacuously true, and that IS the Swift's answer.
        // `MarkdownFrontMatter.swift:123-133` uses `allSatisfy`, so `tags: []` comma-joins to the
        // empty string and shows as a blank cell. The `length > 0` guard that used to stand here
        // routed it to `nestedPre` instead, drawing a `<pre>[]</pre>` block the shipped app never
        // shows for an empty list.
        if (items.every((item) => isSingleLineScalar(item))) {
            return items.map((item) => escapeHtml(scalarText(item))).join(', ');
        }
        return nestedPre(node);
    }
    if (isMap(node)) return nestedPre(node);
    return escapeHtml(String(node));
}

/** §3.6: a two-column table, or the raw fallback when the YAML will not compose to a mapping. */
export function renderFrontMatter(yaml: string): string {
    if (yaml.trim() === '') return '';

    const raw = (): string => `<pre class="frontmatter-raw">${escapeHtml(yaml)}</pre>\n`;

    let document: ReturnType<typeof parseDocument>;
    try {
        document = parseDocument(yaml);
    } catch {
        return raw();
    }
    if (document.errors.length > 0) return raw();

    const root = document.contents;
    if (!isMap(root)) return raw();
    if (root.items.length === 0) return '';

    const rows = root.items
        .map((item) => {
            const key = escapeHtml(scalarText(item.key));
            const value = renderFrontMatterValue(item.value);
            return `<tr><th scope="row">${key}</th><td>${value}</td></tr>`;
        })
        .join('\n');
    return `<table class="frontmatter">\n<tbody>\n${rows}\n</tbody>\n</table>\n`;
}

// ---------------------------------------------------------------------------
// Bare-URL autolinking (§3.4)
// ---------------------------------------------------------------------------

/**
 * Scheme-anchored only: `http://`, `https://`, `ftp://`, `file://`, `mailto:` (case-insensitive).
 * A schemeless domain or a bare email is deliberately left as plain text — this is
 * "terminal-style pasted-URL clickability", not GitHub fuzzy linkification.
 */
const AUTOLINK_PATTERN = /(?:https?|ftp|file):\/\/[^\s<>"'`]+|mailto:[^\s<>"'`]+/gi;

/** Trailing punctuation is sentence punctuation, not URL (matches NSDataDetector's behavior). */
function trimUrlTail(match: string): string {
    let end = match.length;
    while (end > 0) {
        const char = match[end - 1] as string;
        if ('.,;:!?'.includes(char)) {
            end -= 1;
            continue;
        }
        if (char === ')' || char === ']' || char === '}') {
            const open = char === ')' ? '(' : char === ']' ? '[' : '{';
            const slice = match.slice(0, end);
            const opens = slice.split(open).length - 1;
            const closes = slice.split(char).length - 1;
            if (closes > opens) {
                end -= 1;
                continue;
            }
        }
        break;
    }
    return match.slice(0, end);
}

/**
 * `<a href="ESCAPED_URL">ESCAPED_TEXT</a>` per match, surrounding text escaped normally.
 * The href is the matched text itself: every match is already an absolute URL, and
 * re-canonicalizing (e.g. `new URL()`) would append slashes the source never had.
 */
export function autolinkText(text: string): string {
    AUTOLINK_PATTERN.lastIndex = 0;
    let out = '';
    let cursor = 0;
    for (;;) {
        const match = AUTOLINK_PATTERN.exec(text);
        if (match === null) break;
        const url = trimUrlTail(match[0]);
        if (url.length === 0) continue;
        const start = match.index;
        out += escapeHtml(text.slice(cursor, start));
        out += `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
        cursor = start + url.length;
        AUTOLINK_PATTERN.lastIndex = cursor;
    }
    out += escapeHtml(text.slice(cursor));
    return out;
}

// ---------------------------------------------------------------------------
// Markdown → HTML (§3.3)
// ---------------------------------------------------------------------------

const parser = new MarkdownIt({
    html: true, // raw HTML passthrough (§3.3)
    linkify: false, // §3.4 does the linking, with a scheme allowlist
    typographer: false,
    breaks: false
});

const TASK_MARKER = /^\[([ xX])\][ \t]+/;

function attr(token: Token, name: string): string | null {
    const value = token.attrGet(name);
    // markdown-it types attribute values as `string | number` (the `start` attr is numeric).
    return value === null || value === undefined ? null : String(value);
}

interface InlineOptions {
    /** Autolinking is disabled inside explicit links and image alt text (§3.4). */
    readonly suppressAutolink: boolean;
}

function renderInline(tokens: readonly Token[] | null, options: InlineOptions): string {
    if (tokens === null) return '';
    let out = '';
    let linkDepth = 0;
    for (const token of tokens) {
        const suppress = options.suppressAutolink || linkDepth > 0;
        switch (token.type) {
            case 'text':
                out += suppress ? escapeHtml(token.content) : autolinkText(token.content);
                break;
            case 'code_inline':
                out += `<code>${escapeHtml(token.content)}</code>`;
                break;
            case 'em_open':
                out += '<em>';
                break;
            case 'em_close':
                out += '</em>';
                break;
            case 'strong_open':
                out += '<strong>';
                break;
            case 'strong_close':
                out += '</strong>';
                break;
            case 's_open':
                out += '<del>';
                break;
            case 's_close':
                out += '</del>';
                break;
            case 'link_open': {
                linkDepth += 1;
                out += `<a href="${escapeHtml(attr(token, 'href') ?? '')}">`;
                break;
            }
            case 'link_close':
                linkDepth = Math.max(0, linkDepth - 1);
                out += '</a>';
                break;
            case 'image': {
                const alt = renderInline(token.children, { suppressAutolink: true });
                const title = attr(token, 'title');
                out +=
                    `<img src="${escapeHtml(attr(token, 'src') ?? '')}" alt="${alt}"` +
                    (title === null ? '' : ` title="${escapeHtml(title)}"`) +
                    '>';
                break;
            }
            case 'softbreak':
                out += '\n';
                break;
            case 'hardbreak':
                out += '<br>\n';
                break;
            case 'html_inline':
                out += token.content;
                break;
            default:
                // Unknown inline nodes render their children (swift-markdown's default visit).
                out += renderInline(token.children, options);
                break;
        }
    }
    return out;
}

function renderCodeBlock(content: string, info: string): string {
    const language = info.trim();
    const open =
        language === ''
            ? '<pre><code>'
            : `<pre><code class="language-${escapeHtml(language)}">`;
    return (
        '<div class="code-block">' +
        open +
        escapeHtml(content) +
        '</code></pre>' +
        '<button class="code-copy-btn" type="button" aria-label="Copy code"></button>' +
        '</div>\n'
    );
}

/** `[ ] `/`[x] ` at the head of a list item's first paragraph → GFM task item. */
function takeTaskMarker(tokens: readonly Token[], itemIndex: number): boolean | null {
    const paragraph = tokens[itemIndex + 1];
    const inline = tokens[itemIndex + 2];
    if (paragraph === undefined || inline === undefined) return null;
    if (paragraph.type !== 'paragraph_open' || inline.type !== 'inline') return null;
    const first = inline.children?.[0];
    if (first === undefined || first.type !== 'text') return null;
    const match = TASK_MARKER.exec(first.content);
    if (match === null) return null;
    const rest = first.content.slice(match[0].length);
    first.content = rest;
    inline.content = inline.content.slice(match[0].length);
    return (match[1] as string).toLowerCase() === 'x';
}

export function renderMarkdownBody(source: string): string {
    const tokens = parser.parse(source, {});
    let out = '';
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index] as Token;
        switch (token.type) {
            case 'inline':
                out += renderInline(token.children, { suppressAutolink: false });
                break;
            case 'heading_open':
                out += `<${token.tag}>`;
                break;
            case 'heading_close':
                out += `</${token.tag}>\n`;
                break;
            case 'paragraph_open':
                // `hidden` marks a tight-list paragraph; the Swift renderer emits <p> there too
                // (the stylesheet's `li.task-list-item > p:first-of-type` depends on it).
                out += '<p>';
                break;
            case 'paragraph_close':
                out += '</p>\n';
                break;
            case 'fence':
            case 'code_block':
                out += renderCodeBlock(token.content, token.info);
                break;
            case 'bullet_list_open':
                out += '<ul>\n';
                break;
            case 'bullet_list_close':
                out += '</ul>\n';
                break;
            case 'ordered_list_open': {
                const start = attr(token, 'start');
                out += start === null ? '<ol>\n' : `<ol start="${escapeHtml(start)}">\n`;
                break;
            }
            case 'ordered_list_close':
                out += '</ol>\n';
                break;
            case 'list_item_open': {
                const checked = takeTaskMarker(tokens, index);
                if (checked === null) {
                    out += '<li>';
                    break;
                }
                out +=
                    '<li class="task-list-item">' +
                    '<input type="checkbox" class="task-list-item-checkbox"' +
                    (checked ? ' checked' : '') +
                    ' disabled> ';
                break;
            }
            case 'list_item_close':
                out += '</li>\n';
                break;
            case 'blockquote_open':
                out += '<blockquote>\n';
                break;
            case 'blockquote_close':
                out += '</blockquote>\n';
                break;
            case 'hr':
                out += '<hr>\n';
                break;
            case 'table_open':
                out += '<table>\n';
                break;
            case 'table_close':
                out += '</table>\n';
                break;
            case 'thead_open':
                out += '<thead>\n';
                break;
            case 'thead_close':
                out += '</thead>\n';
                break;
            case 'tbody_open':
                out += '<tbody>\n';
                break;
            case 'tbody_close':
                out += '</tbody>\n';
                break;
            case 'tr_open':
                out += '<tr>';
                break;
            case 'tr_close':
                out += '</tr>\n';
                break;
            case 'th_open':
                out += '<th>';
                break;
            case 'th_close':
                out += '</th>';
                break;
            case 'td_open':
                out += '<td>';
                break;
            case 'td_close':
                out += '</td>';
                break;
            case 'html_block':
                out += token.content;
                break;
            default:
                break;
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Stylesheet (§3.9) + document
// ---------------------------------------------------------------------------

/**
 * §3.9 verbatim, with `BASE` = base font size and `CODE = max(BASE - 1, 6)`.
 *
 * TWO OWNER-DIRECTED divergences live in this sheet — S42 and S51. Each is marked at the rule
 * it changes as well as here; do not re-report either as drift.
 *
 * S42 — from `MarkdownHTMLRenderer.swift:300`, which is a flat `padding: 20px 28px`. The port
 * transcribed it byte for byte and it is correct against the shipped app; it is also the wrong
 * metric for a multiplexer, where a preview usually lives in a split. Measured: a 130.75 px pane
 * gives the document a 123 px client width, and 28 + 28 leaves a **67 px** text column — four or
 * five characters a line, with a fenced block's own 16 px each side taking it to 35.
 * `clamp(12px, 6%, 28px)` is identical to the Swift above ~470 px of pane (28 px is the clamp's
 * own ceiling and 6% reaches it there) and gives the column back in a narrow split. The 20 px
 * vertical is untouched. The parity value is `20px 28px`.
 *
 * S51 — from `MarkdownHTMLRenderer.swift:444-452`, whose shared rule pads BOTH front-matter
 * blocks `8px 10px`. The parity value is that padding on `pre.frontmatter-nested` as well as on
 * `pre.frontmatter-raw`; the port transcribed it byte for byte. Inside a cell that already pads
 * `6px 12px` (`:421-423`, transcribed below and untouched) that second box gave the value column
 * two left edges. Measured on a fixture of three scalars and one single-key nested map: the
 * scalar rows are **33.16 px** tall with their values at **x 107.25** (cell 95.25 + 12), while
 * the nested row was **42.74 px — 9.58 px taller** with its text a further 10 px in at 117.25.
 * With `padding: 0` the nested value shares the cell's box — one left edge at 107.25, and the row
 * falls to 32.16, which is a scalar row's own height less the 1 px `border-bottom` that
 * `tr:last-child` drops; the `<th>`'s line box sets it, as it does on every other row. The
 * control settles that last clause rather than assuming it: measured with the same nested map
 * moved OFF the last row, the nested row is **33.16 px — a scalar row exactly** — and the row
 * that inherits last place is the 32.16 one.
 *
 * `margin` stays 0 rather than taking the register's optional `margin: 2px 0`: measured live, 2px
 * is inert on a single-line map (the `<th>` line box is still the taller cell), it would
 * re-introduce a second inset on a multi-line one, and 3px overshoots a scalar row by 0.58 px.
 * The RAW block keeps the Swift's `8px 10px` — it is the malformed-YAML fallback, it stands
 * outside any cell, and the padding is what makes it read as a styled block.
 */
export function markdownStylesheet(baseFontSize: number): string {
    const base = baseFontSize;
    const code = Math.max(baseFontSize - 1, 6);
    return `body {
    font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
    font-size: ${base}px;
    line-height: 1.6;
    padding: 20px clamp(12px, 6%, 28px);
    margin: 0;
    color: #1f2328;
    background-color: transparent;
}
.dark body { color: #e6edf3; }
/* Thin scrollbar matching the sidebar's overlay scroller. */
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(128, 128, 128, 0.4); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: rgba(128, 128, 128, 0.6); }
::-webkit-scrollbar-corner { background: transparent; }
h1, h2, h3, h4, h5, h6 { margin-top: 1.5em; margin-bottom: 0.5em; font-weight: 600; }
h1 { font-size: 2em; border-bottom: 1px solid #d1d9e0; padding-bottom: 0.3em; }
h2 { font-size: 1.5em; border-bottom: 1px solid #d1d9e0; padding-bottom: 0.3em; }
h3 { font-size: 1.25em; }
.dark h1, .dark h2 { border-bottom-color: #3d444d; }
p { margin: 0.5em 0 1em; }
a { color: #0969da; text-decoration: none; }
a:hover { text-decoration: underline; }
.dark a { color: #58a6ff; }
pre {
    background: #f6f8fa;
    padding: 16px;
    border-radius: 6px;
    overflow-x: auto;
    font-size: ${code}px;
    line-height: 1.45;
}
.dark pre { background: #161b22; }
code {
    font-family: 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.9em;
}
:not(pre) > code { background: #eff1f3; padding: 2px 6px; border-radius: 4px; }
.dark :not(pre) > code { background: #262c36; }
blockquote {
    border-left: 4px solid #d1d9e0;
    padding: 0 16px;
    color: #656d76;
    margin: 0.5em 0 1em;
}
.dark blockquote { border-left-color: #3d444d; color: #9198a1; }
table { border-collapse: collapse; width: 100%; margin: 0.5em 0 1em; }
th, td { border: 1px solid #d1d9e0; padding: 8px 12px; text-align: left; }
th { font-weight: 600; background: #f6f8fa; }
.dark th, .dark td { border-color: #3d444d; }
.dark th { background: #161b22; }
ul, ol { padding-left: 2em; margin: 0.5em 0; }
li { margin: 0.25em 0; }
li.task-list-item { list-style-type: none; }
/* -1.4em pulls the checkbox into the bullet column. Assumes ul/ol padding-left: 2em.
   Native disabled checkboxes render very faintly, so a GitHub-style box is drawn. */
li.task-list-item > input.task-list-item-checkbox {
    appearance: none;
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    border: 1.5px solid #8c959f;
    border-radius: 3px;
    background: transparent;
    margin: 0 0.4em 0.15em -1.4em;
    vertical-align: middle;
    cursor: default;
}
.dark li.task-list-item > input.task-list-item-checkbox { border-color: #7d8590; }
li.task-list-item > input.task-list-item-checkbox:checked {
    background-color: #1f6feb;
    border-color: #1f6feb;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3 8l3 3 7-7' stroke='white' stroke-width='2' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: center;
    background-size: 12px 12px;
}
/* Inline the leading paragraph so it sits beside the checkbox. */
li.task-list-item > p:first-of-type { display: inline; }
hr { border: none; border-top: 1px solid #d1d9e0; margin: 2em 0; }
.dark hr { border-top-color: #3d444d; }
img { max-width: 100%; border-radius: 4px; }
del { color: #656d76; }
.dark del { color: #9198a1; }
table.frontmatter {
    margin: 0 0 1.5em;
    border: 1px solid #d1d9e0;
    border-radius: 6px;
    border-collapse: separate;
    border-spacing: 0;
    width: auto;
    min-width: 40%;
    max-width: 100%;
    font-size: 0.9em;
    overflow: hidden;
}
.dark table.frontmatter { border-color: #3d444d; }
table.frontmatter th, table.frontmatter td {
    border: none;
    border-bottom: 1px solid #d1d9e0;
    padding: 6px 12px;
    text-align: start;
    vertical-align: top;
}
.dark table.frontmatter th, .dark table.frontmatter td { border-bottom-color: #3d444d; }
table.frontmatter tr:last-child th, table.frontmatter tr:last-child td { border-bottom: none; }
table.frontmatter th {
    font-weight: 600;
    color: #656d76;
    background: #f6f8fa;
    white-space: nowrap;
    width: 1%;
}
.dark table.frontmatter th { background: #161b22; color: #9198a1; }
table.frontmatter td {
    font-family: 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.95em;
    word-break: break-word;
}
pre.frontmatter-raw, pre.frontmatter-nested {
    margin: 0;
    background: transparent;
    border: none;
    font-size: 0.85em;
    white-space: pre-wrap;
}
/* S51 (owner-directed): the nested value sits in the cell's own 6/12 box, not a second one. */
pre.frontmatter-nested { padding: 0; }
/* The malformed-YAML fallback keeps the Swift's 8/10 — it is a styled block, not a cell value. */
pre.frontmatter-raw { padding: 8px 10px; border-left: 3px solid #d1d9e0; padding-left: 10px; margin: 0 0 1.5em; }
.dark pre.frontmatter-raw { border-left-color: #3d444d; }
.code-block { position: relative; }
/* Margin on the wrapper, not the <pre>, so stacking matches a bare <pre>. */
.code-block > pre { margin: 0; }
.code-block { margin: 1em 0; }
.code-copy-btn {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 28px;
    height: 24px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.85);
    border: 1px solid #d1d9e0;
    border-radius: 4px;
    color: #1f2328;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s ease, color 0.15s ease;
}
.code-block:hover .code-copy-btn,
.code-block:focus-within .code-copy-btn,
.code-copy-btn:focus { opacity: 1; }
.code-copy-btn:focus-visible { outline: 2px solid #0969da; outline-offset: 1px; }
.code-copy-btn:hover { background: #f6f8fa; }
.code-copy-btn.copied { color: #1a7f37; }
.dark .code-copy-btn { background: rgba(22, 27, 34, 0.85); border-color: #3d444d; color: #e6edf3; }
.dark .code-copy-btn:hover { background: #21262d; }
.dark .code-copy-btn.copied { color: #3fb950; }
.dark .code-copy-btn:focus-visible { outline-color: #58a6ff; }
/* Icon via mask so it inherits currentColor (grey normally, green when .copied). */
.code-copy-btn::before {
    content: "";
    display: block;
    width: 14px;
    height: 14px;
    background-color: currentColor;
    -webkit-mask-repeat: no-repeat;
    -webkit-mask-position: center;
    -webkit-mask-size: 14px 14px;
    -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z'/%3E%3Cpath d='M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z'/%3E%3C/svg%3E");
}
.code-copy-btn.copied::before {
    -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z'/%3E%3C/svg%3E");
}
`;
}

export interface MarkdownRenderOptions extends ContentAppearance {
    /** `pane.markdownFontSize`; default 14. */
    readonly baseFontSize?: number | undefined;
    /** `<base href>` for relative images (the daemon's `/pane-assets/<paneID>/` route). */
    readonly baseHref?: string | undefined;
}

/** The whole §3.1 pipeline: source markdown → a complete HTML document. */
export function renderMarkdownDocument(source: string, options: MarkdownRenderOptions = {}): string {
    const { yaml, body } = extractFrontMatter(source);
    const content = (yaml === null ? '' : renderFrontMatter(yaml)) + renderMarkdownBody(body);
    return htmlDocument({
        isDark: isDarkBackground(options.backgroundColor ?? DEFAULT_CONTENT_BACKGROUND),
        style: markdownStylesheet(options.baseFontSize ?? DEFAULT_MARKDOWN_FONT_SIZE),
        body: `<div id="content">\n${content}</div>\n`,
        ...(options.baseHref !== undefined ? { baseHref: options.baseHref } : {})
    });
}

/** §3.11: a read failure is rendered AS markdown — a blockquote, not an error page. */
export function fileLoadErrorMarkdown(filePath: string, message: string): string {
    return `> Failed to load file: ${filePath}\n>\n> ${message}`;
}
