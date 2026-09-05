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
    DARK_WINDOW_GROUND,
    LIGHT_WINDOW_GROUND,
    readBackgroundOpacity,
    readSearchPalette,
    readWindowGround,
    resolveGhosttyConfigPath,
    resolveWindowGround,
    transparencyNeedsRelaunch,
    windowTransparency
} from './appearance.js';

const dirs: string[] = [];

function tempFile(name: string, contents: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-shell-appearance-'));
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
        expect(resolveGhosttyConfigPath({ KELPID_GHOSTTY_CONFIG: '~/alt/gc' }, '/Users/test')).toBe(
            '/Users/test/alt/gc'
        );
    });
});

describe('readBackgroundOpacity', () => {
    it('is 1 when there is no file, and 1 when the file sets nothing', () => {
        expect(readBackgroundOpacity({ KELPID_GHOSTTY_CONFIG: '/nope/does/not/exist' }, '/Users/test')).toBe(1);
        const file = tempFile('ghostty', '# nothing\nbackground = #101014\n');
        expect(readBackgroundOpacity({ KELPID_GHOSTTY_CONFIG: file }, '/Users/test')).toBe(1);
    });

    it('reads the value, lets a later line win, and clamps to 0…1', () => {
        const file = tempFile('ghostty', 'background-opacity = 0.5\nbackground-opacity = 0.85\n');
        expect(readBackgroundOpacity({ KELPID_GHOSTTY_CONFIG: file }, '/Users/test')).toBeCloseTo(0.85);
        const clamped = tempFile('ghostty', 'background-opacity = 4\n');
        expect(readBackgroundOpacity({ KELPID_GHOSTTY_CONFIG: clamped }, '/Users/test')).toBe(1);
    });

    it('keeps the previous value for a malformed line (ghostty’s own rule)', () => {
        const file = tempFile('ghostty', 'background-opacity = 0.7\nbackground-opacity = translucent\n');
        expect(readBackgroundOpacity({ KELPID_GHOSTTY_CONFIG: file }, '/Users/test')).toBeCloseTo(0.7);
    });
});

describe('windowTransparency (SET-049’s isOpaque = opacity >= 1)', () => {
    it('creates the window opaque at 1 and transparent below it', () => {
        const opaque = tempFile('ghostty', 'background-opacity = 1\n');
        expect(windowTransparency({ KELPID_GHOSTTY_CONFIG: opaque }, '/Users/test')).toEqual({
            opacity: 1,
            transparent: false
        });
        const translucent = tempFile('ghostty', 'background-opacity = 0.85\n');
        const decision = windowTransparency({ KELPID_GHOSTTY_CONFIG: translucent }, '/Users/test');
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

/**
 * §N31 — the window's own background is the theme's ground, not a constant.
 *
 * The value Chromium fills every unpainted pixel with was a hardcoded `#16161a`: 12 units off
 * the dark ground and a whole appearance away from the light one, so a light-chrome window's
 * resize edge — and its first frame — flashed near-black. These are the two columns of
 * shell-ui.md §2's `windowBackground`, resolved the way `resolveTrayStatusPalette` resolves the
 * status column, with the same "an unparseable override is ignored, never painted" rule.
 */
describe('resolveWindowGround (§N31)', () => {
    it('is the preset for the resolved bucket', () => {
        expect(resolveWindowGround({ appearance: 'dark' })).toBe(DARK_WINDOW_GROUND);
        expect(resolveWindowGround({ appearance: 'light' })).toBe(LIGHT_WINDOW_GROUND);
        expect(resolveWindowGround({ appearance: 'system', systemDark: true })).toBe(DARK_WINDOW_GROUND);
        expect(resolveWindowGround({ appearance: 'system', systemDark: false })).toBe(LIGHT_WINDOW_GROUND);
        // Anything unrecognised (including nothing at all) reads as `system`.
        expect(resolveWindowGround({ appearance: 'mauve', systemDark: true })).toBe(DARK_WINDOW_GROUND);
        expect(resolveWindowGround()).toBe(LIGHT_WINDOW_GROUND);
    });

    it('is neither the old hardcoded flash colour nor anything near it', () => {
        // The regression this closes, named: `#16161a` is in no palette the app resolves.
        expect(resolveWindowGround({ appearance: 'dark' })).not.toBe('#16161a');
        expect(resolveWindowGround({ appearance: 'light' })).not.toBe('#16161a');
    });

    it('takes the user’s `<bucket>:windowBackground` override, and ignores a broken one', () => {
        expect(
            resolveWindowGround({ appearance: 'dark', overrides: { 'dark:windowBackground': '123456' } })
        ).toBe('#123456');
        expect(
            resolveWindowGround({ appearance: 'dark', overrides: { 'dark:windowBackground': '#abcdef' } })
        ).toBe('#ABCDEF');
        // The other bucket's override is not this bucket's.
        expect(
            resolveWindowGround({ appearance: 'dark', overrides: { 'light:windowBackground': '#123456' } })
        ).toBe(DARK_WINDOW_GROUND);
        // A mistyped hex must not blank the window.
        for (const broken of ['', 'nope', '#12345', 'rgb(1,2,3)']) {
            expect(
                resolveWindowGround({ appearance: 'light', overrides: { 'light:windowBackground': broken } })
            ).toBe(LIGHT_WINDOW_GROUND);
        }
    });
});

describe('readWindowGround (§N31)', () => {
    it('is the system-bucket preset when the config names nothing', () => {
        expect(readWindowGround(true, { KELPID_CONFIG_PATH: '/nope/missing' }, '/Users/test')).toBe(
            DARK_WINDOW_GROUND
        );
        expect(readWindowGround(false, { KELPID_CONFIG_PATH: '/nope/missing' }, '/Users/test')).toBe(
            LIGHT_WINDOW_GROUND
        );
    });

    it('follows `chrome-appearance`, so an explicit choice beats the OS', () => {
        const file = tempFile('config', 'chrome-appearance = dark\n');
        expect(readWindowGround(false, { KELPID_CONFIG_PATH: file }, '/Users/test')).toBe(DARK_WINDOW_GROUND);
    });

    it('follows `chrome-colors`, so a recoloured chrome takes the window with it', () => {
        // `chrome-colors` is the one-line JSON map `parseChromeColors` reads.
        const file = tempFile(
            'config',
            'chrome-appearance = dark\nchrome-colors = {"dark:windowBackground":"101014"}\n'
        );
        expect(readWindowGround(true, { KELPID_CONFIG_PATH: file }, '/Users/test')).toBe('#101014');
    });
});

describe('readSearchPalette (SET-219)', () => {
    it('is the Swift NexGhosttyDefaults set when the config names none', () => {
        expect(readSearchPalette({ KELPID_CONFIG_PATH: '/nope/missing' }, '/Users/test')).toEqual({
            match: '#f2d027',
            matchText: '#000000',
            current: '#ff7a00',
            currentText: '#000000'
        });
    });

    it('takes the user’s overrides from ~/.config/kelpi/config', () => {
        const file = tempFile('config', 'search-match-color = #00ff00\nsearch-match-current-color = #0000ff\n');
        expect(readSearchPalette({ KELPID_CONFIG_PATH: file }, '/Users/test')).toEqual({
            match: '#00ff00',
            matchText: '#000000',
            current: '#0000ff',
            currentText: '#000000'
        });
    });
});
