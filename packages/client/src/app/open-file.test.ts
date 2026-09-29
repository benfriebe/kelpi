import { describe, expect, it } from 'vitest';

import {
    BROWSER_FILE_DROP_NOTICE,
    DROP_MARKDOWN_EXTENSION,
    SHELL_ESCAPE_CHARACTERS,
    isTypeablePath,
    pathsFromDrop,
    resolvedDropOutcome,
    shellEscapePath,
    terminalDropPathsText,
    terminalDropPlan,
    terminalDropText,
    OPEN_PANEL_MESSAGE,
    cellFromPoint,
    dragCarriesFile,
    dropDecision,
    isMarkdownDropPath,
    isPathLike,
    pathFromDrop,
    type DropData
} from './open-file.js';

function transfer(
    entries: Record<string, string>,
    files = 0,
    types?: readonly string[]
): DropData {
    return {
        getData: (format: string) => entries[format] ?? '',
        types: types ?? Object.keys(entries),
        files: { length: files }
    };
}

describe('pathFromDrop', () => {
    it('reads a file:// URL out of text/uri-list and percent-decodes it', () => {
        expect(pathFromDrop(transfer({ 'text/uri-list': 'file:///Users/x/my%20notes.md' }))).toBe(
            '/Users/x/my notes.md'
        );
    });

    it('skips uri-list comment lines and takes the first entry only', () => {
        const data = transfer({
            'text/uri-list': '# a comment\nfile:///a.md\nfile:///b.md'
        });
        expect(pathFromDrop(data)).toBe('/a.md');
    });

    it('accepts file://localhost/ as local', () => {
        expect(pathFromDrop(transfer({ 'text/uri-list': 'file://localhost/a.md' }))).toBe('/a.md');
        expect(pathFromDrop(transfer({ 'text/uri-list': 'file://other-host/a.md' }))).toBeNull();
    });

    it('falls back to a path-shaped text/plain (a drag from a terminal or editor)', () => {
        expect(pathFromDrop(transfer({ 'text/plain': '/Users/x/notes.md' }))).toBe('/Users/x/notes.md');
        expect(pathFromDrop(transfer({ 'text/plain': '~/notes.md' }))).toBe('~/notes.md');
        expect(pathFromDrop(transfer({ 'text/plain': './notes.md' }))).toBe('./notes.md');
    });

    it('ignores plain text that is not a path', () => {
        expect(pathFromDrop(transfer({ 'text/plain': 'hello world' }))).toBeNull();
        expect(pathFromDrop(transfer({ 'text/plain': 'notes.md' }))).toBeNull();
    });

    it('never throws when getData does', () => {
        const hostile: DropData = {
            getData: () => {
                throw new Error('blocked');
            }
        };
        expect(pathFromDrop(hostile)).toBeNull();
    });
});

describe('isPathLike / isMarkdownDropPath (CONT-121)', () => {
    it('accepts .md case-insensitively on the extension', () => {
        expect(DROP_MARKDOWN_EXTENSION).toBe('.md');
        expect(isMarkdownDropPath('/a/notes.md')).toBe(true);
        expect(isMarkdownDropPath('/a/NOTES.MD')).toBe(true);
    });

    it('rejects .markdown, matching the Swift drop path exactly', () => {
        // `ContentView.swift:598-607` compares `pathExtension.lowercased() == "md"`, so
        // `.markdown` is NOT a drop target even though `kelpi md` opens one happily.
        expect(isMarkdownDropPath('/a/notes.markdown')).toBe(false);
        expect(isMarkdownDropPath('/a/notes')).toBe(false);
        expect(isMarkdownDropPath('/a/.md')).toBe(false);
    });

    it('knows a path from a sentence', () => {
        expect(isPathLike('/a')).toBe(true);
        expect(isPathLike('file:///a')).toBe(true);
        expect(isPathLike('../a')).toBe(true);
        expect(isPathLike('a')).toBe(false);
    });
});

describe('dropDecision', () => {
    it('opens a dropped .md path', () => {
        expect(dropDecision(transfer({ 'text/uri-list': 'file:///a/notes.md' }))).toEqual({
            kind: 'open',
            path: '/a/notes.md'
        });
    });

    it('explains a non-markdown path rather than silently ignoring it', () => {
        const decision = dropDecision(transfer({ 'text/uri-list': 'file:///a/photo.png' }));
        expect(decision.kind).toBe('reject');
        expect(decision.kind === 'reject' ? decision.reason : '').toContain('not a .md file');
    });

    it('explains a pathless File — the honest degrade for a sandboxed renderer', () => {
        const decision = dropDecision(transfer({}, 1, ['Files']));
        expect(decision.kind).toBe('reject');
        expect(decision.kind === 'reject' ? decision.reason : '').toContain('⌘O');
    });

    it('ignores a drag that carries nothing file-shaped (TERM-041)', () => {
        expect(dropDecision(transfer({ 'application/x-kelpi-pane': 'pane-1' })).kind).toBe('ignore');
    });
});

describe('dragCarriesFile (TERM-041)', () => {
    it('is true only for the accepted flavours', () => {
        expect(dragCarriesFile(['Files'])).toBe(true);
        expect(dragCarriesFile(['text/uri-list'])).toBe(true);
        expect(dragCarriesFile(['text/plain'])).toBe(true);
        expect(dragCarriesFile(['application/x-kelpi-pane'])).toBe(false);
        expect(dragCarriesFile(undefined)).toBe(false);
    });
});

describe('cellFromPoint (CONT-122)', () => {
    const rect = { left: 100, top: 50, width: 800, height: 480 };

    it('maps a point to a cell on the uniform grid', () => {
        // 80 cols over 800px = 10px per cell; 24 rows over 480px = 20px per row.
        expect(cellFromPoint({ rect, cols: 80, rows: 24, clientX: 100, clientY: 50 })).toEqual({
            row: 0,
            col: 0
        });
        expect(cellFromPoint({ rect, cols: 80, rows: 24, clientX: 145, clientY: 111 })).toEqual({
            row: 3,
            col: 4
        });
    });

    it('clamps to the last cell rather than reporting one past the edge', () => {
        expect(cellFromPoint({ rect, cols: 80, rows: 24, clientX: 899.9, clientY: 529.9 })).toEqual({
            row: 23,
            col: 79
        });
    });

    it('answers null outside the box and for a degenerate grid', () => {
        expect(cellFromPoint({ rect, cols: 80, rows: 24, clientX: 99, clientY: 60 })).toBeNull();
        expect(cellFromPoint({ rect, cols: 80, rows: 24, clientX: 900, clientY: 60 })).toBeNull();
        expect(cellFromPoint({ rect, cols: 0, rows: 24, clientX: 200, clientY: 60 })).toBeNull();
        expect(
            cellFromPoint({ rect: { ...rect, width: 0 }, cols: 80, rows: 24, clientX: 100, clientY: 50 })
        ).toBeNull();
    });
});

describe('the ⌘O panel copy', () => {
    it('is the Swift NSOpenPanel message, byte for byte (CONT-120)', () => {
        expect(OPEN_PANEL_MESSAGE).toBe('Choose a Markdown file to open');
    });
});

describe('dropping onto a TERMINAL (TERM-040 / TERM-041)', () => {
    it('escapes exactly the Swift character set', () => {
        // `SurfaceView.swift:29-33`, verbatim.
        expect([...SHELL_ESCAPE_CHARACTERS].sort().join('')).toBe(
            [...' \t\\()[]{}<>"\'`!#$&;|*?'].sort().join('')
        );
        expect(shellEscapePath('/a/My Notes (final).md')).toBe('/a/My\\ Notes\\ \\(final\\).md');
        expect(shellEscapePath('/plain/path.txt')).toBe('/plain/path.txt');
    });

    it('types EVERY dropped path, space-separated', () => {
        const data = transfer({ 'text/uri-list': 'file:///a/one.txt\nfile:///a/two%20three.md' });
        expect(pathsFromDrop(data)).toEqual(['/a/one.txt', '/a/two three.md']);
        expect(terminalDropText(data)).toBe('/a/one.txt /a/two\\ three.md');
    });

    it('accepts a non-markdown path — a shell can do something with any file', () => {
        expect(terminalDropText(transfer({ 'text/uri-list': 'file:///a/photo.png' }))).toBe('/a/photo.png');
    });

    it('refuses a drag carrying no path at all (TERM-041)', () => {
        expect(terminalDropText(transfer({ 'text/plain': 'just some words' }))).toBeNull();
        expect(terminalDropText(transfer({}, 1, ['Files']))).toBeNull();
    });
});

describe('terminal drop escaping (#288)', () => {
    it('escapes spaces and parentheses the way the shipped app (and Ghostty) did', () => {
        expect(terminalDropPathsText(['/Users/me/Screen Shot 2026-09-30 at 9.41.12 am.png'])).toBe(
            '/Users/me/Screen\\ Shot\\ 2026-09-30\\ at\\ 9.41.12\\ am.png'
        );
        expect(terminalDropPathsText(['/tmp/drop me (1).txt'])).toBe('/tmp/drop\\ me\\ \\(1\\).txt');
    });

    it('escapes quotes, dollar signs, backticks and the other shell metacharacters', () => {
        expect(shellEscapePath(`/a/it's "quoted".md`)).toBe(`/a/it\\'s\\ \\"quoted\\".md`);
        expect(shellEscapePath('/a/$HOME and `whoami`')).toBe('/a/\\$HOME\\ and\\ \\`whoami\\`');
        expect(shellEscapePath('/a/x;rm -rf ~|y&z*?!#<>[]{}')).toBe(
            '/a/x\\;rm\\ -rf\\ ~\\|y\\&z\\*\\?\\!\\#\\<\\>\\[\\]\\{\\}'
        );
        expect(shellEscapePath('/a/back\\slash')).toBe('/a/back\\\\slash');
    });

    it('leaves unicode alone: it is not a shell metacharacter, and escaping it would corrupt it', () => {
        expect(shellEscapePath('/Users/me/Café/日本語 ファイル 🎉.png')).toBe('/Users/me/Café/日本語\\ ファイル\\ 🎉.png');
    });

    it('joins several files with single spaces and adds no trailing newline', () => {
        const text = terminalDropPathsText(['/a/one.png', '/b/two three', '/c/dir']);
        expect(text).toBe('/a/one.png /b/two\\ three /c/dir');
        expect(text.endsWith('\n')).toBe(false);
        expect(text.endsWith('\r')).toBe(false);
    });

    it('refuses a path with a control character (a newline would submit the rest as a command)', () => {
        expect(isTypeablePath('/a/fine name.png')).toBe(true);
        expect(isTypeablePath('/a/evil\nrm -rf ~')).toBe(false);
        expect(isTypeablePath('/a/tab\there')).toBe(false);
        expect(isTypeablePath('/a/del\u007f')).toBe(false);
        // One `%0A` in a file URL is all it takes, so the text route checks too.
        expect(terminalDropText(transfer({ 'text/uri-list': 'file:///a/evil%0Arm%20-rf%20~' }))).toBeNull();
    });
});

/** A `DataTransfer` shaped like a Finder drop: `Files` and nothing readable as a path. */
function finderDrop(files: readonly unknown[], entries: Record<string, string> = {}): DropData {
    const list: Record<number, unknown> & { length: number } = { length: files.length };
    files.forEach((file, index) => {
        list[index] = file;
    });
    return {
        getData: (format: string) => entries[format] ?? '',
        types: [...Object.keys(entries), 'Files'],
        files: list
    };
}

describe('terminalDropPlan (TERM-040 / TERM-041 / #288)', () => {
    it('types a path the drag names as text, at once', () => {
        expect(terminalDropPlan(transfer({ 'text/uri-list': 'file:///a/b%20c.md' }))).toEqual({
            kind: 'type',
            text: '/a/b\\ c.md'
        });
    });

    it('hands a Finder drop (Files, no path as text) to the shell to resolve, every file in order', () => {
        const one = { name: 'one.png' };
        const two = { name: 'two' };
        expect(terminalDropPlan(finderDrop([one, two]))).toEqual({ kind: 'resolve', files: [one, two] });
        // Finder may put the bare NAME on text/plain; a name is not a path, so it still resolves.
        expect(terminalDropPlan(finderDrop([one], { 'text/plain': 'one.png' }))).toEqual({ kind: 'resolve', files: [one] });
    });

    it('prefers the text path when a drag carries both', () => {
        expect(terminalDropPlan(finderDrop([{}], { 'text/uri-list': 'file:///x/y' }))).toEqual({ kind: 'type', text: '/x/y' });
    });

    it('ignores a drag with neither a path nor a file (plain text, TERM-041)', () => {
        expect(terminalDropPlan(transfer({ 'text/plain': 'just some words' }))).toEqual({ kind: 'ignore' });
        expect(terminalDropPlan(transfer({}))).toEqual({ kind: 'ignore' });
        // A FileList-alike that claims a length but holds nothing is not a drop of files.
        expect(terminalDropPlan(transfer({}, 2, ['Files']))).toEqual({ kind: 'ignore' });
    });
});

describe('resolvedDropOutcome (#288)', () => {
    it('types every resolved path, escaped, and says nothing more', () => {
        expect(resolvedDropOutcome({ paths: ['/a b.png', '/c'], unresolved: 0, error: null })).toEqual({
            text: '/a\\ b.png /c',
            notice: null
        });
    });

    it('types what it can and says how many were left out', () => {
        const outcome = resolvedDropOutcome({ paths: ['/a', '/evil\nx'], unresolved: 1, error: null });
        expect(outcome.text).toBe('/a');
        expect(outcome.notice).toBe('2 dropped items had no path that can be typed and were left out');
    });

    it('never types nothing silently', () => {
        expect(resolvedDropOutcome({ paths: [], unresolved: 1, error: null })).toEqual({
            text: null,
            notice: 'the dropped item is not a file on disk, so there is no path to type'
        });
        expect(resolvedDropOutcome({ paths: [], unresolved: 0, error: 'the window is gone' }).notice).toBe(
            "could not read the dropped file's path: the window is gone"
        );
        expect(resolvedDropOutcome({ paths: ['/evil\n'], unresolved: 0, error: null }).notice).toContain('nothing was typed');
    });

    it('explains the browser case rather than pointing at a feature it does not have', () => {
        expect(BROWSER_FILE_DROP_NOTICE).toContain('desktop app');
    });
});
