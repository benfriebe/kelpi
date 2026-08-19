/**
 * The routing tables and their two oracles (cli.md §13, port note 12) — table-driven, with a
 * synthetic filesystem so the cases that depend on "does this file exist in the cwd" are
 * deterministic on any machine.
 *
 * The pairs matter as much as the individual answers: `localFileURL` and
 * `webTargetForOpenArg` are mirror images, and every argument must be exactly one of
 * "local file" or "web target" (or neither, which falls through to the extension router).
 */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    localFileURL,
    markdownOpenExtensions,
    pathExtensionLower,
    webOpenCommonTLDs,
    webOpenExtensions,
    webTargetForOpenArg,
    type RoutingContext
} from './routing.js';

const CWD = '/work/site';
const HOME = '/Users/tester';

/** A tiny fake tree: regular files, plus one directory that collides with a dev hostname. */
const FILES = new Map<string, { isDirectory: boolean }>([
    [`${CWD}/page one.html`, { isDirectory: false }],
    [`${CWD}/report.pdf`, { isDirectory: false }],
    [`${CWD}/notes.md`, { isDirectory: false }],
    [`${CWD}/README`, { isDirectory: false }],
    [`${CWD}/google.com`, { isDirectory: false }],
    [`${CWD}/app`, { isDirectory: true }],
    [`${HOME}/deck.pdf`, { isDirectory: false }]
]);

const context: RoutingContext = {
    cwd: CWD,
    home: HOME,
    stat: (target) => FILES.get(target) ?? null
};

describe('localFileURL', () => {
    it.each([
        ['./relative.html', `file://${CWD}/relative.html`],
        ['../sibling.html', 'file:///work/sibling.html'],
        ['/absolute/file.html', 'file:///absolute/file.html'],
        ['~/deck.pdf', `file://${HOME}/deck.pdf`],
        // A bare name only when a REGULAR file with an extension exists in the cwd.
        ['page one.html', `file://${CWD}/page%20one.html`],
        ['report.pdf', `file://${CWD}/report.pdf`]
    ])('resolves %j', (input, expected) => {
        expect(localFileURL(input, context)).toBe(expected);
    });

    it.each([
        ['https://example.com'],
        ['file:///already/a/url.html'],
        ['data:text/html,<h1>hi</h1>'],
        ['mailto:someone@example.com'],
        ['about:blank'],
        ['example.com'],
        ['localhost:3000'],
        // A directory that shares its name with a dev hostname is NOT hijacked…
        ['app'],
        // …nor is an extensionless file.
        ['README'],
        ['missing.html']
    ])('leaves %j for the app to interpret', (input) => {
        expect(localFileURL(input, context)).toBeNull();
    });

    it('treats `host:port` as a host, but `scheme:opaque` as a scheme', () => {
        expect(localFileURL('example.com:8080', context)).toBeNull();
        expect(localFileURL('vscode:extension/foo', context)).toBeNull();
    });

    it('honours an explicit path even when nothing is there', () => {
        expect(localFileURL('./nothing-here.html', context)).toBe(`file://${CWD}/nothing-here.html`);
    });

    it('percent-encodes and standardizes', () => {
        expect(localFileURL('./a/../b c.html', context)).toBe(`file://${CWD}/b%20c.html`);
    });

    it('appends a trailing slash for an existing directory path', () => {
        expect(localFileURL('./app', context)).toBe(`file://${CWD}/app/`);
    });
});

describe('webTargetForOpenArg', () => {
    it.each([
        ['https://example.com/docs'],
        ['http://example.com'],
        ['ftp://files.example.com'],
        ['example.com'],
        ['example.co.uk'],
        ['localhost'],
        ['localhost:3000'],
        ['127.0.0.1'],
        ['192.168.1.10:8080'],
        ['example.com/path?q=1'],
        ['dev.example.io']
    ])('routes %j to a web pane', (input) => {
        expect(webTargetForOpenArg(input, context)).toBe(input);
    });

    it.each([
        // Explicit paths and existing files stay local — `./google.com` is a FILE.
        ['./google.com'],
        ['google.com'], // exists in the fake cwd as a regular file
        ['/tmp/thing.html'],
        ['~/deck.pdf'],
        // Bare words, numeric suffixes and file-shaped or unknown TLDs are not hosts.
        ['README'],
        ['backup.1'],
        ['notes.txt'],
        ['foo.museum'],
        ['run.sh'],
        ['model.pt']
    ])('leaves %j to the file router', (input) => {
        expect(webTargetForOpenArg(input, context)).toBeNull();
    });

    it('never claims an argument that localFileURL already claimed', () => {
        for (const argument of ['./x.html', '/x.html', '~/deck.pdf', 'report.pdf', 'page one.html']) {
            expect(localFileURL(argument, context)).not.toBeNull();
            expect(webTargetForOpenArg(argument, context)).toBeNull();
        }
    });

    it('rejects a host whose port is not numeric', () => {
        // `example:notaport` is a scheme-shaped token, not a host:port.
        expect(webTargetForOpenArg('example:notaport', context)).toBeNull();
    });
});

describe('routing tables', () => {
    it('routes markdown extensions to a preview pane', () => {
        for (const extension of ['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdwn', 'markdn']) {
            expect(markdownOpenExtensions.has(extension)).toBe(true);
        }
        expect(markdownOpenExtensions.size).toBe(7);
    });

    it('routes renderable file types to a web pane', () => {
        expect([...webOpenExtensions].sort()).toEqual(
            ['gif', 'htm', 'html', 'jpeg', 'jpg', 'pdf', 'png', 'svg', 'webp'].sort()
        );
    });

    it('excludes TLDs that collide with file extensions', () => {
        for (const collision of ['sh', 'ai', 'app', 'pl', 'rs', 'so', 'cc', 'zip', 'mov', 'md', 'pt']) {
            expect(webOpenCommonTLDs.has(collision)).toBe(false);
        }
        for (const known of ['com', 'org', 'io', 'dev', 'uk', 'jp']) {
            expect(webOpenCommonTLDs.has(known)).toBe(true);
        }
    });

    it('lowercases the extension it routes on', () => {
        expect(pathExtensionLower(path.join(CWD, 'READ.MD'))).toBe('md');
        expect(pathExtensionLower(path.join(CWD, 'noext'))).toBe('');
    });
});
