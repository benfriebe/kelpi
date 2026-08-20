/**
 * APP-012 / SET-049 (window transparency) and SET-219 (the search palette the injected web-find
 * script paints with), as the shell reads them.
 *
 * Every read goes through an explicit env + home, never `process.env`, so a test can never touch
 * the developer's real `~/.config`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    readBackgroundOpacity,
    readSearchPalette,
    resolveGhosttyConfigPath,
    transparencyNeedsRelaunch,
    windowTransparency
} from './appearance.js';

const dirs: string[] = [];

function tempFile(name: string, contents: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nex-shell-appearance-'));
    dirs.push(dir);
    const file = path.join(dir, name);
    fs.writeFileSync(file, contents);
    return file;
}

afterEach(() => {
    while (dirs.length > 0) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('resolveGhosttyConfigPath', () => {
    it('defaults to ~/.config/ghostty/config and honours the daemon’s override', () => {
        expect(resolveGhosttyConfigPath({}, '/Users/test')).toBe('/Users/test/.config/ghostty/config');
        expect(resolveGhosttyConfigPath({ NEXD_GHOSTTY_CONFIG: '~/alt/gc' }, '/Users/test')).toBe(
            '/Users/test/alt/gc'
        );
    });
});

describe('readBackgroundOpacity', () => {
    it('is 1 when there is no file, and 1 when the file sets nothing', () => {
        expect(readBackgroundOpacity({ NEXD_GHOSTTY_CONFIG: '/nope/does/not/exist' }, '/Users/test')).toBe(1);
        const file = tempFile('ghostty', '# nothing\nbackground = #101014\n');
        expect(readBackgroundOpacity({ NEXD_GHOSTTY_CONFIG: file }, '/Users/test')).toBe(1);
    });

    it('reads the value, lets a later line win, and clamps to 0…1', () => {
        const file = tempFile('ghostty', 'background-opacity = 0.5\nbackground-opacity = 0.85\n');
        expect(readBackgroundOpacity({ NEXD_GHOSTTY_CONFIG: file }, '/Users/test')).toBeCloseTo(0.85);
        const clamped = tempFile('ghostty', 'background-opacity = 4\n');
        expect(readBackgroundOpacity({ NEXD_GHOSTTY_CONFIG: clamped }, '/Users/test')).toBe(1);
    });

    it('keeps the previous value for a malformed line (ghostty’s own rule)', () => {
        const file = tempFile('ghostty', 'background-opacity = 0.7\nbackground-opacity = translucent\n');
        expect(readBackgroundOpacity({ NEXD_GHOSTTY_CONFIG: file }, '/Users/test')).toBeCloseTo(0.7);
    });
});

describe('windowTransparency (SET-049’s isOpaque = opacity >= 1)', () => {
    it('creates the window opaque at 1 and transparent below it', () => {
        const opaque = tempFile('ghostty', 'background-opacity = 1\n');
        expect(windowTransparency({ NEXD_GHOSTTY_CONFIG: opaque }, '/Users/test')).toEqual({
            opacity: 1,
            transparent: false
        });
        const translucent = tempFile('ghostty', 'background-opacity = 0.85\n');
        const decision = windowTransparency({ NEXD_GHOSTTY_CONFIG: translucent }, '/Users/test');
        expect(decision.transparent).toBe(true);
        expect(decision.opacity).toBeCloseTo(0.85);
    });

    it('only a change that CROSSES 1.0 needs a relaunch', () => {
        // Already transparent: any sub-1 value is just a repaint the page does.
        expect(transparencyNeedsRelaunch(true, 0.7)).toBe(false);
        expect(transparencyNeedsRelaunch(true, 0.95)).toBe(false);
        // Crossing in either direction cannot be applied to a live BrowserWindow.
        expect(transparencyNeedsRelaunch(true, 1)).toBe(true);
        expect(transparencyNeedsRelaunch(false, 0.85)).toBe(true);
        expect(transparencyNeedsRelaunch(false, 1)).toBe(false);
    });
});

describe('readSearchPalette (SET-219)', () => {
    it('is the Swift NexGhosttyDefaults set when the config names none', () => {
        expect(readSearchPalette({ NEXD_CONFIG_PATH: '/nope/missing' }, '/Users/test')).toEqual({
            match: '#f2d027',
            matchText: '#000000',
            current: '#ff7a00',
            currentText: '#000000'
        });
    });

    it('takes the user’s overrides from ~/.config/nex/config', () => {
        const file = tempFile('config', 'search-match-color = #00ff00\nsearch-match-current-color = #0000ff\n');
        expect(readSearchPalette({ NEXD_CONFIG_PATH: file }, '/Users/test')).toEqual({
            match: '#00ff00',
            matchText: '#000000',
            current: '#0000ff',
            currentText: '#000000'
        });
    });
});
