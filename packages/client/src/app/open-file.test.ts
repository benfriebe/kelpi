import { describe, expect, it } from 'vitest';

import {
    DROP_MARKDOWN_EXTENSION,
    SHELL_ESCAPE_CHARACTERS,
    pathsFromDrop,
    shellEscapePath,
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
        // `.markdown` is NOT a drop target even though `nex md` opens one happily.
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
        expect(dropDecision(transfer({ 'application/x-nex-pane': 'pane-1' })).kind).toBe('ignore');
    });
});

describe('dragCarriesFile (TERM-041)', () => {
    it('is true only for the accepted flavours', () => {
        expect(dragCarriesFile(['Files'])).toBe(true);
        expect(dragCarriesFile(['text/uri-list'])).toBe(true);
        expect(dragCarriesFile(['text/plain'])).toBe(true);
        expect(dragCarriesFile(['application/x-nex-pane'])).toBe(false);
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
