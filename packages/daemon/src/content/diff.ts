/**
 * Unified `git diff` → HTML, the port of `DiffHTMLRenderer` (content-panes.md §5.3–§5.4).
 *
 * Pure string work: line-prefix classification, per-file chunking into `<details class="file"
 * open>` with a sticky `<summary>`, GitHub-ish status badges and +/- counts. No parser and no
 * git knowledge beyond the prefixes `git diff --no-color` emits — exactly like the Swift
 * renderer, whose heuristics this reproduces (including their sharp edges, §11).
 */

import {
    DEFAULT_CONTENT_BACKGROUND,
    escapeHtml,
    htmlDocument,
    isDarkBackground,
    type ContentAppearance
} from './html.js';

/** The GUI passes the pane's markdown font size; diffs have no bindings of their own (§5.4). */
export const DEFAULT_DIFF_FONT_SIZE = 13;

export type DiffLineClass = 'file-header' | 'hunk' | 'add' | 'del' | 'context';

export type DiffFileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'binary' | 'mode';

/** Order matters: the `+++`/`---` file headers must win over the `+`/`-` line prefixes. */
const FILE_HEADER_PREFIXES: readonly string[] = [
    'diff --git ',
    'index ',
    '--- ',
    '+++ ',
    'new file mode',
    'deleted file mode',
    'similarity index',
    'rename ',
    'copy ',
    'Binary files',
    'old mode',
    'new mode'
];

export function classifyDiffLine(line: string): DiffLineClass {
    for (const prefix of FILE_HEADER_PREFIXES) {
        if (line.startsWith(prefix)) return 'file-header';
    }
    if (line.startsWith('@@')) return 'hunk';
    if (line.startsWith('+')) return 'add';
    if (line.startsWith('-')) return 'del';
    return 'context';
}

export interface DiffChunk {
    /** The `diff --git …` line, or null for the pre-first-file preamble. */
    readonly headerLine: string | null;
    /** Every line of the chunk, INCLUDING `headerLine` when there is one. */
    readonly lines: readonly string[];
}

/** Group lines into per-file chunks; anything before the first `diff --git ` is the preamble. */
export function chunkDiff(text: string): DiffChunk[] {
    const chunks: DiffChunk[] = [];
    let current: string[] = [];
    let header: string | null = null;
    let started = false;

    const flush = (): void => {
        if (!started && current.length === 0) return;
        chunks.push({ headerLine: header, lines: current });
    };

    for (const line of text.split('\n')) {
        if (line.startsWith('diff --git ')) {
            flush();
            started = true;
            header = line;
            current = [line];
            continue;
        }
        current.push(line);
    }
    flush();
    return chunks;
}

export interface DiffFileInfo {
    readonly status: DiffFileStatus;
    readonly renameFrom: string | null;
    readonly additions: number;
    readonly deletions: number;
    readonly path: string;
}

function afterPrefix(lines: readonly string[], prefix: string): string | null {
    for (const line of lines) {
        if (line.startsWith(prefix)) return line.slice(prefix.length);
    }
    return null;
}

function hasPrefix(lines: readonly string[], prefix: string): boolean {
    return lines.some((line) => line.startsWith(prefix));
}

/** §5.3 "Display path": everything after the LAST `" b/"` of the `diff --git` header line. */
export function displayPath(headerLine: string): string {
    const marker = ' b/';
    const index = headerLine.lastIndexOf(marker);
    return index < 0 ? headerLine : headerLine.slice(index + marker.length);
}

export function describeChunk(chunk: DiffChunk): DiffFileInfo {
    const lines = chunk.lines;
    const renameFrom = afterPrefix(lines, 'rename from ');
    const hasRenameTo = hasPrefix(lines, 'rename to ');
    const hasModeChange = hasPrefix(lines, 'old mode') || hasPrefix(lines, 'new mode');
    const hasContentChange = hasPrefix(lines, '@@');

    const status: DiffFileStatus = hasPrefix(lines, 'new file mode')
        ? 'added'
        : hasPrefix(lines, 'deleted file mode')
          ? 'deleted'
          : renameFrom !== null && hasRenameTo
            ? 'renamed'
            : hasPrefix(lines, 'Binary files')
              ? 'binary'
              : hasModeChange && !hasContentChange
                ? 'mode'
                : 'modified';

    let additions = 0;
    let deletions = 0;
    for (const line of lines) {
        // `+++`/`---` are file headers, never counted; the `diff --git` line matches neither.
        if (line.startsWith('+++') || line.startsWith('---')) continue;
        if (line.startsWith('+')) additions += 1;
        else if (line.startsWith('-')) deletions += 1;
    }

    const destination = chunk.headerLine === null ? '' : displayPath(chunk.headerLine);
    const path =
        status === 'renamed' && renameFrom !== null ? `${renameFrom} → ${destination}` : destination;

    return { status, renameFrom, additions, deletions, path };
}

function renderLine(line: string): string {
    return `<div class="line line-${classifyDiffLine(line)}">${escapeHtml(line)}</div>`;
}

function renderChunk(chunk: DiffChunk): string {
    if (chunk.headerLine === null) {
        // Preamble: loose lines, no <details> wrapper.
        return `${chunk.lines.map(renderLine).join('\n')}\n`;
    }
    const info = describeChunk(chunk);
    const stats =
        info.additions > 0 || info.deletions > 0
            ? '<span class="diff-stats">' +
              `<span class="stat-add">+${String(info.additions)}</span>` +
              `<span class="stat-del">-${String(info.deletions)}</span>` +
              '</span>'
            : '';
    return (
        '<details class="file" open>\n' +
        '<summary class="file-summary">' +
        '<span class="caret"></span>' +
        `<span class="file-path">${escapeHtml(info.path)}</span>` +
        `<span class="file-status status-${info.status}">${info.status}</span>` +
        stats +
        '</summary>\n' +
        '<div class="hunks"><div class="hunks-inner">\n' +
        chunk.lines.map(renderLine).join('\n') +
        '\n</div></div>\n' +
        '</details>\n'
    );
}

/** §5.1: an empty (or whitespace-only) diff is a centered placeholder, not an empty page. */
export const EMPTY_DIFF_HTML = '<div class="empty">No changes</div>\n';

export function renderDiffBody(diffText: string): string {
    if (diffText.trim() === '') return EMPTY_DIFF_HTML;
    // Every chunk already ends with a newline, so the join adds nothing.
    const rendered = chunkDiff(diffText).map(renderChunk).join('');
    return `<div class="diff">\n${rendered}</div>\n`;
}

/** §5.1: a git failure renders THROUGH the normal renderer, as loose context lines. */
export function gitFailureText(repoPath: string, message: string): string {
    return `Failed to run git diff in ${repoPath}:\n${message}`;
}

/** §5.4 verbatim, with `BASE` = base font size. */
export function diffStylesheet(baseFontSize: number): string {
    return `html, body { margin: 0; padding: 0; }
body {
    font-family: 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
    font-size: ${baseFontSize}px;
    line-height: 1.45;
    color: #1f2328;
    background-color: transparent;
    overflow-y: auto;
    overflow-x: hidden;
}
.dark body { color: #e6edf3; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(128, 128, 128, 0.4); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: rgba(128, 128, 128, 0.6); }
::-webkit-scrollbar-corner { background: transparent; }
.diff { padding-bottom: 8px; }
details.file { display: block; }
.hunks { overflow-x: auto; }
.hunks-inner { display: inline-block; min-width: 100%; }
details.file > summary {
    position: sticky;
    top: 0;
    z-index: 2;
    list-style: none;
    cursor: pointer;
    user-select: none;
    font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
    font-weight: 600;
    color: #1f2328;
    background: #f6f8fa;
    border-top: 1px solid #d1d9e0;
    border-bottom: 1px solid #d1d9e0;
    padding: 6px 16px;
    display: flex;
    align-items: center;
    gap: 8px;
}
details.file > summary::-webkit-details-marker { display: none; }
details.file:first-child > summary { border-top: none; }
.dark details.file > summary {
    background: #161b22; color: #e6edf3;
    border-top-color: #3d444d; border-bottom-color: #3d444d;
}
.caret { display: inline-block; width: 10px; color: #8b949e; transition: transform 0.12s ease; }
.caret::before { content: "\\25B6"; font-size: 9px; }   /* ▶ */
details[open] > summary .caret { transform: rotate(90deg); }
.file-path { font-family: 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace; font-weight: 500; }
.file-status {
    font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
    font-size: 10px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.04em; padding: 1px 6px; border-radius: 3px;
}
.status-added    { background: rgba(46,160,67,0.18);  color: #1a7f37; }
.dark .status-added    { color: #4ac26b; background: rgba(46,160,67,0.22); }
.status-deleted  { background: rgba(248,81,73,0.18);  color: #cf222e; }
.dark .status-deleted  { color: #ff7b72; background: rgba(248,81,73,0.22); }
.status-modified { background: rgba(56,139,253,0.18); color: #0969da; }
.dark .status-modified { color: #58a6ff; background: rgba(56,139,253,0.22); }
.status-renamed  { background: rgba(163,113,247,0.18); color: #8250df; }
.dark .status-renamed  { color: #d2a8ff; background: rgba(163,113,247,0.22); }
.status-binary, .status-mode { background: rgba(101,109,118,0.18); color: #57606a; }
.dark .status-binary, .dark .status-mode { color: #8b949e; background: rgba(139,148,158,0.18); }
.diff-stats {
    margin-left: auto;
    font-family: 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px; display: inline-flex; gap: 8px;
}
.stat-add { color: #1a7f37; font-weight: 600; }   .dark .stat-add { color: #4ac26b; }
.stat-del { color: #cf222e; font-weight: 600; }   .dark .stat-del { color: #ff7b72; }
.line { display: block; padding: 0 16px; white-space: pre; }
.line:empty::before { content: "\\00a0"; }          /* keep empty lines 1 line tall */
.line-add  { background: #e6ffec; color: #1a7f37; }
.dark .line-add { background: rgba(46,160,67,0.15); color: #4ac26b; }
.line-del  { background: #ffebe9; color: #cf222e; }
.dark .line-del { background: rgba(248,81,73,0.15); color: #ff7b72; }
.line-hunk { background: #ddf4ff; color: #57606a; }
.dark .line-hunk { background: rgba(56,139,253,0.15); color: #8b949e; }
.line-file-header { color: #57606a; font-size: 0.92em; padding-top: 2px; padding-bottom: 2px; }
.dark .line-file-header { color: #8b949e; }
.empty {
    text-align: center; color: #57606a;
    font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
    font-size: 14px; padding: 80px 20px;
}
.dark .empty { color: #8b949e; }
`;
}

export interface DiffRenderOptions extends ContentAppearance {
    readonly baseFontSize?: number | undefined;
}

/** Diff HTML in the §3.7 document wrapper (no `#content` div — §5.4). */
export function renderDiffDocument(diffText: string, options: DiffRenderOptions = {}): string {
    return htmlDocument({
        isDark: isDarkBackground(options.backgroundColor ?? DEFAULT_CONTENT_BACKGROUND),
        style: diffStylesheet(options.baseFontSize ?? DEFAULT_DIFF_FONT_SIZE),
        body: renderDiffBody(diffText)
    });
}
