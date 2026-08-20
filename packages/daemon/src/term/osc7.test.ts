/**
 * OSC 7 — the pwd producer (terminal-panes.md §TERM-048, graft-git.md §GIT-075).
 *
 * The emulator already sees every PTY byte, so the shell's working-directory report is parsed
 * there; boot turns each one into a `pane-directory-changed` dispatch plus an auto-detect
 * trigger. Both halves matter: the parse (shells spell this several ways) and the fact that a
 * report actually reaches a subscriber through a real `feed()`.
 */

import { describe, expect, it } from 'vitest';

import { createTerminalStateService, parseOsc7 } from './service.js';

const PANE = 'dddddddd-0000-4000-8000-000000000001';

describe('parseOsc7', () => {
    it('reads the hostname form every shell actually emits', () => {
        expect(parseOsc7('file://mac.local/Users/me/code')).toBe('/Users/me/code');
    });

    it('reads the hostname-less form', () => {
        expect(parseOsc7('file:///Users/me/code')).toBe('/Users/me/code');
    });

    it('accepts a bare absolute path', () => {
        expect(parseOsc7('/Users/me/code')).toBe('/Users/me/code');
    });

    it('decodes percent escapes, so a path with a space survives', () => {
        expect(parseOsc7('file://host/Users/me/My%20Code')).toBe('/Users/me/My Code');
    });

    it('keeps the raw text when an escape is malformed rather than throwing', () => {
        expect(parseOsc7('file://host/Users/me/100%bad')).toBe('/Users/me/100%bad');
    });

    it('ignores a report that could never be a working directory', () => {
        expect(parseOsc7('')).toBeNull();
        expect(parseOsc7('   ')).toBeNull();
        expect(parseOsc7('relative/path')).toBeNull();
        expect(parseOsc7('file://host')).toBeNull();
        expect(parseOsc7('http://example.com/x')).toBeNull();
    });
});

describe('the terminal state service reports OSC 7 for the right pane', () => {
    it('fires the callback with the pane id and the decoded path', async () => {
        const seen: { paneID: string; directory: string }[] = [];
        const term = createTerminalStateService({
            onDirectoryChange: (paneID, directory) => {
                seen.push({ paneID, directory });
            }
        });
        term.attach(PANE, 80, 24);
        term.feed(PANE, ']7;file://mac.local/Users/me/code');
        await term.flush(PANE);
        expect(seen).toEqual([{ paneID: PANE, directory: '/Users/me/code' }]);
        term.disposeAll();
    });

    it('reports for a pane created lazily by `feed` before any attach', async () => {
        const seen: string[] = [];
        const term = createTerminalStateService({
            onDirectoryChange: (_paneID, directory) => {
                seen.push(directory);
            }
        });
        term.feed(PANE, ']7;file:///work/wt');
        await term.flush(PANE);
        expect(seen).toEqual(['/work/wt']);
        term.disposeAll();
    });

    it('leaves the screen alone — the sequence is consumed, never printed', async () => {
        const term = createTerminalStateService({ onDirectoryChange: () => {} });
        term.attach(PANE, 80, 24);
        term.feed(PANE, 'before\r\n]7;file:///workafter');
        const text = await term.captureAsync(PANE, { scrollback: false });
        expect(text).toContain('before');
        expect(text).toContain('after');
        expect(text).not.toContain('file://');
        term.disposeAll();
    });

    it('costs nothing when nobody subscribed', async () => {
        const term = createTerminalStateService();
        term.attach(PANE, 80, 24);
        term.feed(PANE, ']7;file:///workready');
        expect(await term.captureAsync(PANE, { scrollback: false })).toContain('ready');
        term.disposeAll();
    });
});
