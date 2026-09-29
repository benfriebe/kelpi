/**
 * The GUI routes to a markdown pane: ⌘O, drag-and-drop, and ⌘-clicking a path in a terminal
 * (CONT-120…122, TERM-052, APP-020/APP-103).
 *
 * Everything here is pure so the rules are testable without a window; `App.tsx` supplies the
 * DOM events and the command client.
 *
 * ## Why a drop cannot always be honoured — the honest version
 *
 * The daemon opens files **by path** (it reads and watches the file, and a second attached
 * client has to be able to see the same document), so a drop is only actionable when the page
 * can name a path.
 *
 *  - **In a plain browser** a `DataTransfer` file is a `File` object with a name and bytes and
 *    deliberately no path. There is nothing to send.
 *  - **In this Electron shell** the same is true, and for a specific reason worth recording:
 *    Electron ≥ 32 removed the non-standard `File.path`, and its replacement,
 *    `webUtils.getPathForFile`, is a **main-world API reachable only through a preload script**.
 *    This shell has no preload at all — that is a security posture the main process documents
 *    (`shell/src/main.ts`: no `contextBridge` surface for a compromised page to reach) — so the
 *    renderer cannot resolve a dropped file's path either.
 *
 * What DOES survive the crossing is a path *as text*: `text/uri-list` (a `file://` URL, which
 * Chromium sets for drags out of many apps) and `text/plain` (what a terminal, an editor, or a
 * "Copy as Pathname" drag puts on the pasteboard). Those are read here and are a real path.
 *
 * A drag out of **Finder** carries neither. Chromium deliberately leaves the files' paths out of
 * both (`content/browser/web_contents/web_drag_dest_mac.mm`, `PopulateDropDataFromPasteboard`:
 * "To avoid exposing file system paths to web content, filenames in the drag are not converted
 * to file URLs"), so the page sees `types: ["Files"]` and `File` objects and nothing else.
 *
 *  - Onto the **window**, such a drop is refused with a message that points at ⌘O rather than
 *    silently doing nothing (the one thing worse than a missing feature is one that looks like
 *    it worked).
 *  - Onto a **terminal** it is not refused (#288): the main process can read a `File`'s path over
 *    its own window's debugger, so the `File`s are handed to it through the daemon and the paths
 *    come back to be typed (`terminalDropPlan` below, `app/dropped-files.ts`,
 *    `shell/src/dropped-files.ts`). Only the desktop app can do that; a browser has no main
 *    process to ask, and says so.
 */

/** CONT-121 / APP-103: the drop path accepts a lowercased `.md` only — NOT `.markdown`. */
export const DROP_MARKDOWN_EXTENSION = '.md';

/** ⌘O's picker filter (CONT-120): `md` alone, matching the Swift `NSOpenPanel`. */
export const OPEN_PANEL_EXTENSIONS = ['md'] as const;
/** The `NSOpenPanel` message string, kept byte-for-byte (CONT-120). */
export const OPEN_PANEL_MESSAGE = 'Choose a Markdown file to open';

/** The subset of `DataTransfer` this module reads — so a test can hand it a literal. */
export interface DropData {
    getData(format: string): string;
    readonly types?: readonly string[] | undefined;
    /** A `FileList` in the browser; indexable so a terminal drop can hand the `File`s on (#288). */
    readonly files?: ArrayLike<unknown> | undefined;
}

export type DropDecision =
    | { readonly kind: 'open'; readonly path: string }
    | { readonly kind: 'reject'; readonly reason: string }
    | { readonly kind: 'ignore' };

function decodeFileUrl(raw: string): string | null {
    if (!raw.startsWith('file://')) return null;
    try {
        const url = new URL(raw);
        // `file://localhost/x` and `file:///x` both mean the local path.
        if (url.hostname !== '' && url.hostname !== 'localhost') return null;
        return decodeURIComponent(url.pathname);
    } catch {
        return null;
    }
}

/** True for a string that names a filesystem location rather than arbitrary dropped text. */
export function isPathLike(value: string): boolean {
    return (
        value.startsWith('/') ||
        value.startsWith('~/') ||
        value.startsWith('./') ||
        value.startsWith('../') ||
        value.startsWith('file://')
    );
}

/**
 * EVERY path a drop names, in order.
 *
 * The window-level markdown route takes only the first (`ContentView.swift:597-608` reads
 * `providers.first` and drops the rest); the terminal route types all of them, space-separated,
 * the way `SurfaceView.swift:660-701` did.
 */
export function pathsFromDrop(data: DropData): string[] {
    const paths: string[] = [];
    let uriList = '';
    try {
        uriList = data.getData('text/uri-list');
    } catch {
        uriList = '';
    }
    for (const line of uriList.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) continue;
        const decoded = decodeFileUrl(trimmed);
        if (decoded !== null) paths.push(decoded);
    }
    if (paths.length > 0) return paths;

    let plain = '';
    try {
        plain = data.getData('text/plain');
    } catch {
        plain = '';
    }
    for (const line of plain.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed === '' || !isPathLike(trimmed)) continue;
        paths.push(decodeFileUrl(trimmed) ?? trimmed);
    }
    return paths;
}

/**
 * The first path a drop names, or null.
 *
 * `text/uri-list` first (the standard drag format; its comment lines start with `#`), then
 * `text/plain` when it is path-shaped. A multi-file drop consults **only the first entry** —
 * `ContentView.swift:597-608` reads `providers.first` and drops the rest.
 */
export function pathFromDrop(data: DropData): string | null {
    let uriList = '';
    try {
        uriList = data.getData('text/uri-list');
    } catch {
        uriList = '';
    }
    for (const line of uriList.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) continue;
        const decoded = decodeFileUrl(trimmed);
        if (decoded !== null) return decoded;
        break;
    }

    let plain = '';
    try {
        plain = data.getData('text/plain');
    } catch {
        plain = '';
    }
    const candidate = plain.split(/\r?\n/)[0]?.trim() ?? '';
    if (candidate === '' || !isPathLike(candidate)) return null;
    return decodeFileUrl(candidate) ?? candidate;
}

/** CONT-121: a lowercased `.md` suffix, case-insensitively matched on the extension. */
export function isMarkdownDropPath(path: string): boolean {
    const name = path.split('/').pop() ?? path;
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return false;
    return name.slice(dot).toLowerCase() === DROP_MARKDOWN_EXTENSION;
}

/**
 * What to do with a drop. Three outcomes, all of them something the user can see:
 * open it, say why it cannot be opened, or ignore a drag that carries nothing file-shaped
 * (TERM-041's "a drag offering none of the accepted types is refused").
 */
export function dropDecision(data: DropData): DropDecision {
    const path = pathFromDrop(data);
    if (path !== null) {
        if (!isMarkdownDropPath(path)) {
            return { kind: 'reject', reason: `${path} is not a .md file` };
        }
        return { kind: 'open', path };
    }
    const fileCount = data.files?.length ?? 0;
    if (fileCount > 0) {
        return {
            kind: 'reject',
            reason:
                'a dropped file carries no path in this window (Electron removed File.path and ' +
                'this shell runs without a preload) - use ⌘O to pick the file instead'
        };
    }
    return { kind: 'ignore' };
}

/** True when a dragged item is worth showing a drop highlight for (TERM-041). */
export function dragCarriesFile(types: readonly string[] | undefined): boolean {
    if (types === undefined) return false;
    return types.includes('Files') || types.includes('text/uri-list') || types.includes('text/plain');
}

// ---------------------------------------------------------------------------
// ⌘-click on a terminal (CONT-122 / TERM-052)
// ---------------------------------------------------------------------------

export interface TerminalCell {
    readonly row: number;
    readonly col: number;
}

export interface CellHitTest {
    /** The terminal HOST element's box — the element whose width IS the column arithmetic. */
    readonly rect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
    /** The grid the pane is currently rendered at (the client already tracks this per pane). */
    readonly cols: number;
    readonly rows: number;
    readonly clientX: number;
    readonly clientY: number;
}

/**
 * Which cell a click landed on.
 *
 * Deliberately geometric rather than engine-specific: neither renderer exposes a
 * point-to-cell API, and both draw a uniform grid into the host element, so
 * `floor(offset / cellSize)` is exact for the monospace faces this app ships. The daemon reads
 * the token at the cell (`ws/desktop.ts`), which is the same division of labour scrollback
 * search already uses.
 */
export function cellFromPoint(hit: CellHitTest): TerminalCell | null {
    if (hit.cols <= 0 || hit.rows <= 0 || hit.rect.width <= 0 || hit.rect.height <= 0) return null;
    const x = hit.clientX - hit.rect.left;
    const y = hit.clientY - hit.rect.top;
    if (x < 0 || y < 0 || x >= hit.rect.width || y >= hit.rect.height) return null;
    const col = Math.min(hit.cols - 1, Math.floor((x / hit.rect.width) * hit.cols));
    const row = Math.min(hit.rows - 1, Math.floor((y / hit.rect.height) * hit.rows));
    return { row, col };
}

// ---------------------------------------------------------------------------
// Dropping onto a TERMINAL pane (TERM-040 / TERM-041)
// ---------------------------------------------------------------------------

/**
 * The characters `SurfaceView.swift:29-33` backslash-escapes before typing a dropped path:
 * `` \()[]{}<>"'`!#$&;|*? `` plus space and tab. Verbatim, because a path that round-trips
 * through one app and not the other is a paste that silently runs the wrong command.
 */
export const SHELL_ESCAPE_CHARACTERS = ' \t\\()[]{}<>"\'`!#$&;|*?';

/** Backslash-escape a path so a shell reads it as one word (TERM-040). */
export function shellEscapePath(path: string): string {
    let out = '';
    for (const character of path) {
        if (SHELL_ESCAPE_CHARACTERS.includes(character)) out += '\\';
        out += character;
    }
    return out;
}

/**
 * Whether a path can be typed into a terminal at all.
 *
 * The escape set above has no answer for a control character, and a newline in a filename (legal
 * on macOS, and one `%0A` away in a `file://` URL) is the dangerous one: the paste pipeline turns
 * it into a carriage return, so in a program without bracketed paste the rest of the name would
 * run as a command. Such a path is left out and the user is told, never typed.
 */
export function isTypeablePath(path: string): boolean {
    return !/[\u0000-\u001f\u007f]/.test(path);
}

/**
 * Paths as a terminal drop types them: each escaped, space-separated, no trailing newline (the
 * user is composing a command around them and presses Enter themselves, as in Terminal.app).
 */
export function terminalDropPathsText(paths: readonly string[]): string {
    return paths.map(shellEscapePath).join(' ');
}

/**
 * What a drop onto a terminal pane types: every path it names AS TEXT, escaped, space-separated.
 *
 * Returns null when the drag names no path as text. A Finder drag never does (see the header), so
 * null is not a refusal on its own: `terminalDropPlan` decides what happens next.
 */
export function terminalDropText(data: DropData): string | null {
    const paths = pathsFromDrop(data).filter(isTypeablePath);
    if (paths.length === 0) return null;
    return terminalDropPathsText(paths);
}

/**
 * TERM-040 / TERM-041 / #288: what a drop onto a terminal pane does.
 *
 *  - `type`: the drag named its paths as text (`text/uri-list`, a path-shaped `text/plain`), so
 *    they are typed at once. Preferred when present because it is synchronous and exact, and it
 *    is the only route a browser has.
 *  - `resolve`: no path as text, but the drag carries `File`s: a drop from Finder. The paths have
 *    to be read by the main process (`app/dropped-files.ts`), and then they are typed the same way.
 *  - `ignore`: neither, e.g. a plain text drag. TERM-041's "a drag offering none of the accepted
 *    types is refused": nothing is typed and the window-level markdown route is not consulted.
 *
 * Every file type goes the same way, `.md` included: a terminal types what is dropped on it,
 * which is what an agent user dropping a spec onto Claude Code wants. Only a drop OUTSIDE a
 * terminal opens a markdown pane (CONT-121).
 */
export type TerminalDropPlan =
    | { readonly kind: 'type'; readonly text: string }
    | { readonly kind: 'resolve'; readonly files: readonly unknown[] }
    | { readonly kind: 'ignore' };

export function terminalDropPlan(data: DropData): TerminalDropPlan {
    const text = terminalDropText(data);
    if (text !== null) return { kind: 'type', text };
    const files = Array.from(data.files ?? { length: 0 }).filter((file) => file !== undefined && file !== null);
    if (files.length > 0) return { kind: 'resolve', files };
    return { kind: 'ignore' };
}

/** #288: the shell's answer, as the page holds it (`app/dropped-files.ts`). */
export interface DroppedFilesAnswer {
    readonly paths: readonly string[];
    readonly unresolved: number;
    readonly error: string | null;
}

/**
 * #288: what a resolved drop types, and what to tell the user about it.
 *
 * `text` is null when there is nothing to type. `notice` is null when the typing says it all; a
 * drop that typed nothing is never silent, because silence is the bug this route exists to fix.
 * Items with no path on disk (a `File` made of bytes) and paths that cannot be typed
 * (`isTypeablePath`) are left out and counted in the notice.
 */
export function resolvedDropOutcome(answer: DroppedFilesAnswer): { readonly text: string | null; readonly notice: string | null } {
    const typeable = answer.paths.filter(isTypeablePath);
    const untypeable = answer.paths.length - typeable.length;
    const leftOut = answer.unresolved + untypeable;
    const text = typeable.length === 0 ? null : terminalDropPathsText(typeable);
    const items = (count: number): string => (count === 1 ? '1 dropped item' : `${String(count)} dropped items`);
    if (text === null) {
        if (answer.error !== null && answer.paths.length === 0) {
            return { text, notice: `could not read the dropped file's path: ${answer.error}` };
        }
        if (untypeable > 0) return { text, notice: `${items(leftOut)} had no path that can be typed safely, so nothing was typed` };
        return {
            text,
            notice:
                leftOut === 1
                    ? 'the dropped item is not a file on disk, so there is no path to type'
                    : 'the dropped items are not files on disk, so there is no path to type'
        };
    }
    if (leftOut === 0) return { text, notice: null };
    return { text, notice: `${items(leftOut)} had no path that can be typed and ${leftOut === 1 ? 'was' : 'were'} left out` };
}

/** #288: the browser's answer. It has no main process to read a path, and says so. */
export const BROWSER_FILE_DROP_NOTICE =
    'a browser does not reveal where a dropped file lives, so there is no path to type; ' +
    'drop it in the Kelpi desktop app, or type the path';
