import { MAX_DROPPED_FILES } from '@kelpi/protocol';
import { describe, expect, it } from 'vitest';

import { parseFilenamesPlist, parseUriList, readClipboardFiles, type PasteboardReader } from './clipboard-files.js';

const plist = (...paths: string[]): string =>
    '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
    '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<array>\n' +
    paths.map((path) => `\t<string>${path}</string>\n`).join('') +
    '</array>\n</plist>\n';

const pasteboard = (formats: Record<string, string>): PasteboardReader => ({ read: (format) => formats[format] ?? '' });

describe('readClipboardFiles (#382)', () => {
    it('reads CleanShot’s Copy (one PNG item with a file link) as that file’s path', () => {
        // Exactly what Electron 43's main process answered for the issue's reproduction clipboard.
        const board = pasteboard({
            NSFilenamesPboardType: plist('/tmp/kelpi-repro.png'),
            'public.file-url': 'file:///tmp/kelpi-repro.png',
            'text/uri-list': 'file:///tmp/kelpi-repro.png'
        });
        expect(readClipboardFiles(board)).toEqual({ paths: ['/tmp/kelpi-repro.png'], unresolved: 0 });
    });

    it('lists every file of a multi-file copy, in order, with entities decoded', () => {
        const board = pasteboard({
            NSFilenamesPboardType: plist('/Users/me/Library/Application Support/CleanShot/media/a &amp; b.png', '/tmp/&lt;c&gt;', '/tmp/caf&#233;')
        });
        expect(readClipboardFiles(board).paths).toEqual([
            '/Users/me/Library/Application Support/CleanShot/media/a & b.png',
            '/tmp/<c>',
            '/tmp/café'
        ]);
    });

    it('keeps a path with a newline in it, encoded or not, for the page to refuse', () => {
        // The page's `isTypeablePath` is the one rule for drops and pastes alike; this module only
        // decodes faithfully, so a `&#10;` is the newline it names.
        expect(readClipboardFiles(pasteboard({ NSFilenamesPboardType: plist('/tmp/a&#10;rm -rf ~', '/tmp/b\nc') })).paths).toEqual([
            '/tmp/a\nrm -rf ~',
            '/tmp/b\nc'
        ]);
    });

    it('falls back to the first item’s file link, then to the uri-list', () => {
        expect(readClipboardFiles(pasteboard({ 'public.file-url': 'file:///tmp/with%20space.png' }))).toEqual({
            paths: ['/tmp/with space.png'],
            unresolved: 0
        });
        expect(
            readClipboardFiles(pasteboard({ 'text/uri-list': '# comment\r\nfile:///tmp/one\r\nhttps://example.com/x\r\nfile:///tmp/two\r\n' }))
        ).toEqual({ paths: ['/tmp/one', '/tmp/two'], unresolved: 1 });
    });

    it('leaves out a file reference URL, which names an inode rather than a path', () => {
        expect(readClipboardFiles(pasteboard({ 'public.file-url': 'file:///.file/id=6571367.8622049' }))).toEqual({ paths: [], unresolved: 1 });
    });

    it('counts what it leaves out: relative entries, and anything past the drop cap', () => {
        const many = Array.from({ length: MAX_DROPPED_FILES + 3 }, (_value, index) => `/f${String(index)}`);
        const result = readClipboardFiles(pasteboard({ NSFilenamesPboardType: plist('relative', ...many) }));
        expect(result.paths).toEqual(many.slice(0, MAX_DROPPED_FILES));
        expect(result.unresolved).toBe(4);
    });

    it('answers nothing for a clipboard with no file on it', () => {
        expect(readClipboardFiles(pasteboard({}))).toEqual({ paths: [], unresolved: 0 });
        expect(readClipboardFiles(pasteboard({ 'text/uri-list': 'https://example.com/' }))).toEqual({ paths: [], unresolved: 1 });
    });
});

describe('the format parsers', () => {
    it('reads nothing from a value that is not a property list', () => {
        expect(parseFilenamesPlist('')).toEqual([]);
        expect(parseFilenamesPlist('<string>/tmp/x</string>')).toEqual([]);
    });

    it('leaves a malformed file URL as the text it was, so it is counted rather than typed', () => {
        expect(parseUriList('file://remote-host/share/x')).toEqual(['file://remote-host/share/x']);
    });
});
