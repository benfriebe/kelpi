/**
 * The two whole-document copy commands (content-panes.md §3.14).
 *
 * Both are client-side by construction: the daemon already hands every subscriber the raw
 * markdown (`state.text`) and the rendered document, and the clipboard only exists in a
 * browser. What lives here is the part with a contract:
 *
 *   - **Copy as Markdown** is the *source*, with front matter stripped. The split rule is the
 *     daemon's (`content/markdown.ts` `extractFrontMatter`) restated for the client, because the
 *     daemon's package publishes `./store` only. It is deliberately the same three rules —
 *     a leading `---` fence line, a `---`/`...` closing fence, a BOM tolerated in front — so the
 *     text a user copies matches the preview they are looking at, front-matter table and all.
 *   - **Copy as Rich Text** writes THREE flavors when the platform allows it: `text/html` (so a
 *     rich target keeps headings, lists and links) and `text/plain` (the flattened text, for
 *     everything else). RTF, the third flavor the Swift app wrote, has no web equivalent — the
 *     browser's own HTML→RTF conversion is what a paste target gets instead.
 *
 * Both bail on a document whose last load failed: §3.14 is explicit that you cannot copy the
 * synthetic error blockquote.
 */

const BOM = '﻿';
const OPEN_FENCE = /^---[ \t]*$/;
const CLOSE_FENCE = /^(?:---|\.\.\.)[ \t]*$/;

interface ScannedLine {
    readonly text: string;
    /** Offset just past this line's terminator — where the next line begins. */
    readonly end: number;
}

/** Split on `\n`, `\r\n` or `\r`, keeping offsets (the daemon's §3.5 rule 3). */
function scanLines(source: string): ScannedLine[] {
    const lines: ScannedLine[] = [];
    let start = 0;
    let index = 0;
    while (index < source.length) {
        const char = source[index] as string;
        if (char === '\n' || char === '\r') {
            const isCrLf = char === '\r' && source[index + 1] === '\n';
            const end = index + (isCrLf ? 2 : 1);
            lines.push({ text: source.slice(start, index), end });
            index = end;
            start = end;
            continue;
        }
        index += 1;
    }
    if (start < source.length) lines.push({ text: source.slice(start), end: source.length });
    return lines;
}

/**
 * The document body with a leading YAML front-matter block removed. No front matter (or an
 * unterminated fence) returns the input untouched, exactly as the daemon's renderer decides.
 */
export function stripFrontMatter(markdown: string): string {
    const working = markdown.startsWith(BOM) ? markdown.slice(1) : markdown;
    const lines = scanLines(working);
    const first = lines[0];
    if (first === undefined || !OPEN_FENCE.test(first.text)) return markdown;

    for (let index = 1; index < lines.length; index += 1) {
        const line = lines[index] as ScannedLine;
        if (CLOSE_FENCE.test(line.text)) return working.slice(line.end);
    }
    return markdown;
}

export interface RichTextPayload {
    readonly html: string;
    readonly text: string;
}

/** The `ClipboardItem` constructor + `navigator.clipboard.write`, as a seam tests can supply. */
export interface RichClipboardWriter {
    (payload: RichTextPayload): void | Promise<unknown>;
}

interface ClipboardItemLike {
    new (items: Record<string, Blob>): unknown;
}

/**
 * Writes both flavors through `ClipboardItem` when the platform has it (Firefox still does
 * not, and neither does jsdom), falling back to a plain-text write so the command never
 * silently does nothing. Returns false when there was nothing to write.
 */
export function writeRichText(payload: RichTextPayload, write?: RichClipboardWriter | undefined): boolean {
    if (payload.html.length === 0 && payload.text.length === 0) return false;
    if (write !== undefined) {
        const result = write(payload);
        if (result instanceof Promise) result.catch(() => undefined);
        return true;
    }

    const scope = globalThis as unknown as {
        ClipboardItem?: ClipboardItemLike;
        Blob?: typeof Blob;
        navigator?: Navigator & { clipboard?: Clipboard & { write?: (items: unknown[]) => Promise<void> } };
    };
    const clipboard = scope.navigator?.clipboard;
    const ClipboardItemCtor = scope.ClipboardItem;

    if (ClipboardItemCtor !== undefined && scope.Blob !== undefined && clipboard?.write !== undefined) {
        try {
            const item = new ClipboardItemCtor({
                'text/html': new scope.Blob([payload.html], { type: 'text/html' }),
                'text/plain': new scope.Blob([payload.text], { type: 'text/plain' })
            });
            void clipboard.write([item]).catch(() => {
                void clipboard.writeText?.(payload.text).catch(() => undefined);
            });
            return true;
        } catch {
            // Fall through: a refused `ClipboardItem` must still leave the user with the text.
        }
    }

    if (clipboard?.writeText === undefined) return false;
    void clipboard.writeText(payload.text).catch(() => undefined);
    return true;
}
