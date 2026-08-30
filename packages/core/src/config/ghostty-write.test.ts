/**
 * `setGhosttySetting` — the surgical ghostty-config writer.
 *
 * The bar this has to clear is preservation. A user's `~/.config/ghostty/config` is large,
 * personal, and full of keys this codebase deliberately does not understand; a colour picker
 * must not be able to lose any of it. So most of these assertions are about the lines the
 * writer did NOT touch.
 */

import { describe, expect, it } from 'vitest';

import { ghosttyColorValue, ghosttyFontFamilyValue, setGhosttySetting } from './ghostty-write.js';
import { parseConfigLines } from './lines.js';

const REAL_WORLD = [
    '# my ghostty config',
    '',
    'theme = Catppuccin Mocha',
    'font-size = 13',
    '',
    '# keybinds I care about',
    'keybind = super+shift+enter=new_split:right',
    'window-padding-x = 8',
    'macos-option-as-alt = true',
    'config-file = ?themes/extra',
    ''
].join('\n');

describe('setGhosttySetting', () => {
    it('rewrites the key IN PLACE, keeping every other line byte-for-byte', () => {
        const next = setGhosttySetting(REAL_WORLD, 'font-size', '15');
        expect(next).toContain('font-size = 15');
        expect(next).not.toContain('font-size = 13');
        // Position preserved: the key stays where the user put it, not appended at the end.
        const lines = next.split('\n');
        expect(lines[3]).toBe('font-size = 15');
        for (const preserved of [
            '# my ghostty config',
            'theme = Catppuccin Mocha',
            '# keybinds I care about',
            'keybind = super+shift+enter=new_split:right',
            'window-padding-x = 8',
            'macos-option-as-alt = true',
            'config-file = ?themes/extra'
        ]) {
            expect(next).toContain(preserved);
        }
    });

    it('appends a key the file does not have, after the existing content', () => {
        const next = setGhosttySetting(REAL_WORLD, 'background', '#1a1b26');
        expect(next.trimEnd().endsWith('background = #1a1b26')).toBe(true);
        expect(next).toContain('theme = Catppuccin Mocha');
    });

    it('creates the content from nothing when there is no file', () => {
        expect(setGhosttySetting(null, 'background', '#000000')).toBe('background = #000000\n');
    });

    /**
     * The one behavioural difference from `setGeneralSetting`, and ghostty's own semantics
     * force it: repeated `font-family` lines ACCUMULATE into a fallback stack. Leaving the old
     * lines in place would mean "set the font" silently appended a font instead.
     */
    it('collapses an accumulating key to a single line', () => {
        const contents = ['font-family = JetBrains Mono', 'font-family = Symbols Nerd Font', 'font-size = 12'].join(
            '\n'
        );
        const next = setGhosttySetting(contents, 'font-family', 'Menlo');
        expect(next.match(/font-family/g)?.length).toBe(1);
        expect(next).toContain('font-family = Menlo');
        expect(next).toContain('font-size = 12');
    });

    it('deletes every line for a key when the value is null', () => {
        const next = setGhosttySetting(REAL_WORLD, 'theme', null);
        expect(next).not.toContain('theme = ');
        expect(next).toContain('font-size = 13');
        expect(next).toContain('# my ghostty config');
    });

    it('never touches a commented-out line for the same key', () => {
        const contents = ['# background = #ff0000', 'background = #111111'].join('\n');
        const next = setGhosttySetting(contents, 'background', '#222222');
        expect(next).toContain('# background = #ff0000');
        expect(next).toContain('background = #222222');
    });

    it('leaves an empty file behind rather than a lone newline', () => {
        expect(setGhosttySetting('theme = Nord\n', 'theme', null)).toBe('');
    });

    /**
     * Five writes in a row, then read the file back with the SAME line parser the daemon's
     * ghostty reader uses. (The reader itself lives in `@kelpi/daemon`, which core must not
     * depend on — `daemon/src/settings/ghostty.test.ts` closes that half of the loop against
     * the real parser.)
     */
    it('survives a sequence of writes with every key readable and nothing lost', () => {
        let contents = REAL_WORLD;
        contents = setGhosttySetting(contents, 'background', '#1a1b26');
        contents = setGhosttySetting(contents, 'background-opacity', '0.85');
        contents = setGhosttySetting(contents, 'font-family', ghosttyFontFamilyValue('JetBrains Mono'));
        contents = setGhosttySetting(contents, 'font-size', '15');
        contents = setGhosttySetting(contents, 'theme', 'Nord');

        const parsed = new Map(parseConfigLines(contents).map((line) => [line.key, line.value]));
        expect(parsed.get('background')).toBe('#1a1b26');
        expect(parsed.get('background-opacity')).toBe('0.85');
        expect(parsed.get('font-family')).toBe('JetBrains Mono');
        expect(parsed.get('font-size')).toBe('15');
        expect(parsed.get('theme')).toBe('Nord');
        // And the user's own lines are all still there after five writes.
        expect(contents).toContain('keybind = super+shift+enter=new_split:right');
        expect(contents).toContain('config-file = ?themes/extra');
        expect(contents).toContain('window-padding-x = 8');
        expect(contents).toContain('# my ghostty config');
    });
});

describe('ghosttyFontFamilyValue', () => {
    // Bare is idiomatic and ghostty accepts spaces; quoting is only for the characters that
    // would change what the LINE means.
    it('leaves a plain name plain, including one with spaces', () => {
        expect(ghosttyFontFamilyValue('Menlo')).toBe('Menlo');
        expect(ghosttyFontFamilyValue('JetBrains Mono')).toBe('JetBrains Mono');
        expect(ghosttyFontFamilyValue('  Menlo  ')).toBe('Menlo');
        expect(ghosttyFontFamilyValue('')).toBe('');
    });

    it('quotes a name that would otherwise become a comment or be unquoted away', () => {
        expect(ghosttyFontFamilyValue('Weird#Font')).toBe('"WeirdFont"');
        expect(ghosttyFontFamilyValue('"Already Quoted"')).toBe('"Already Quoted"');
    });
});

describe('ghosttyColorValue', () => {
    it('normalizes both hex forms and refuses anything else', () => {
        expect(ghosttyColorValue('#1A1B26')).toBe('#1a1b26');
        expect(ghosttyColorValue('1a1b26')).toBe('#1a1b26');
        expect(ghosttyColorValue('#abc')).toBe('#aabbcc');
        expect(ghosttyColorValue('black')).toBeNull();
        expect(ghosttyColorValue('')).toBeNull();
    });
});
