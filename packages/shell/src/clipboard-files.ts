/**
 * #382: the paths of the files on the pasteboard, for a ⌘V into a terminal pane.
 *
 * ## Why the main process has to do this
 *
 * CleanShot's Copy puts ONE pasteboard item with two types on the clipboard: `public.png` and
 * `public.file-url`. A Finder Copy puts the file link there too, beside the file's icon. Chromium's
 * async clipboard hides both from the page once a file link is present (`clipboard.read()` answers
 * one item with `types: []`, measured on Electron 43), since pasting a Finder file's icon as the
 * file would be wrong. So the page has nothing to paste, and ⌘V used to do nothing at all.
 *
 * Electron's main process reads its own pasteboard without that filter (measured, the same
 * clipboard): `NSFilenamesPboardType` is a property list of every file's path, and macOS
 * synthesises it from the items' `public.file-url`s, so a multi-file Finder Copy lists them all;
 * `public.file-url` is the first item's link; and `availableFormats()` names `text/uri-list`,
 * Chromium's own view, which is what a platform without the macOS types has. The page then types
 * the paths exactly as a drop of the same files (terminal-surface.md section 12.2).
 *
 * Pure, so the parsing has tests: `main.ts` hands in a reader over Electron's `clipboard`.
 */

import { fileURLToPath } from 'node:url';

import { MAX_DROPPED_FILES } from '@kelpi/protocol';

/** The pasteboard reads this module needs, one per format, each answering `''` for none. */
export interface PasteboardReader {
    read(format: string): string;
}

export interface ClipboardFilesResult {
    /** Absolute paths, in pasteboard order. */
    readonly paths: string[];
    /** Entries that were not a usable absolute path, plus any past the cap. */
    readonly unresolved: number;
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML character data, decoded: the five named entities and numeric references. */
function decodeXML(value: string): string {
    return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, name: string) => {
        if (name.startsWith('#x')) return codePoint(Number.parseInt(name.slice(2), 16)) ?? whole;
        if (name.startsWith('#')) return codePoint(Number.parseInt(name.slice(1), 10)) ?? whole;
        return ENTITIES[name] ?? whole;
    });
}

function codePoint(value: number): string | null {
    return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : null;
}

/** The `<string>` entries of an `NSFilenamesPboardType` property list, decoded, in order. */
export function parseFilenamesPlist(plist: string): string[] {
    if (!plist.includes('<plist')) return [];
    const entries: string[] = [];
    for (const match of plist.matchAll(/<string>([\s\S]*?)<\/string>/g)) entries.push(decodeXML(match[1] ?? ''));
    return entries;
}

/** A `file://` URL's path, or null for anything else (a web URL, a malformed one). */
function filePath(url: string): string | null {
    const trimmed = url.trim();
    if (!trimmed.toLowerCase().startsWith('file://')) return null;
    try {
        return fileURLToPath(trimmed);
    } catch {
        return null;
    }
}

/** The lines of a `text/uri-list` that are `file://` URLs, as paths (comments skipped). */
export function parseUriList(list: string): string[] {
    return list
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'))
        .map((line) => filePath(line) ?? line);
}

/**
 * Every file on the pasteboard, as absolute paths.
 *
 * The richest source that answers wins: the macOS filename list (every item), else the first
 * item's `public.file-url`, else `text/uri-list`. An entry that is not an absolute path (a web URL
 * in a uri-list, a relative name, a file reference URL) is left out and counted, and so is anything past the drop cap,
 * so the page can say how many it could not type. Control characters are the page's to refuse
 * (`isTypeablePath`), as they are for a drop, since the page is what types.
 */
export function readClipboardFiles(pasteboard: PasteboardReader): ClipboardFilesResult {
    let entries = parseFilenamesPlist(pasteboard.read('NSFilenamesPboardType'));
    if (entries.length === 0) {
        const link = pasteboard.read('public.file-url');
        if (link !== '') entries = [filePath(link) ?? link];
    }
    if (entries.length === 0) entries = parseUriList(pasteboard.read('text/uri-list'));
    // A file REFERENCE URL (`file:///.file/id=…`, which `public.file-url` can carry) names an inode,
    // not a path: typed, it would point at nothing.
    const absolute = entries.filter((entry) => entry.startsWith('/') && !entry.startsWith('/.file/id='));
    const paths = absolute.slice(0, MAX_DROPPED_FILES);
    return { paths, unresolved: entries.length - paths.length };
}
