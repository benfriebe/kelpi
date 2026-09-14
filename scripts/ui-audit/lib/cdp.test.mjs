import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { KEYS } from './cdp.mjs';

/**
 * Every key code the harness names has to resolve to a virtual key code (#207).
 *
 * `page.key(code, ...)` looks `code` up in `KEYS` and dispatches whatever it finds as both
 * `windowsVirtualKeyCode` and `nativeVirtualKeyCode`. A code that is not in the table is
 * dispatched as 0, and Chromium drops that: the press is a silent no-op, the scenario reads the
 * app as if the chord had been pressed and declined, and the run fails somewhere else entirely.
 * `KeyC` and `KeyV` were missing for as long as the clipboard chords have existed, so every
 * platform Copy and every platform paste in the suite went out with a zero code, and so did the
 * ⌘H and ⌘M of `terminal-leaves-platform-chords`.
 *
 * This is the check that cannot be forgotten next time: it reads the codes out of the harness's
 * own source rather than out of a list kept here, so a scenario that presses a new key fails this
 * test on the same commit that adds the press.
 */
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/** Every `.mjs` under `scripts/`, minus the tests themselves. */
function harnessSources(directory = path.join(repoRoot, 'scripts')) {
    const found = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) found.push(...harnessSources(full));
        else if (entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs')) found.push(full);
    }
    return found;
}

/**
 * The two shapes a key code is written in: the first argument of `page.key` / `view.key`, and the
 * `code:` field of a chord table a scenario then feeds to it. Both are literals, because a key
 * built at run time (`Key${character.toUpperCase()}`, `Digit${ordinal}`) can only be covered by
 * the table holding every letter and every digit, which the assertions below require directly.
 */
function keyCodesNamedIn(source) {
    const found = new Set();
    for (const match of source.matchAll(/\.key\(\s*(['"])([A-Za-z0-9]+)\1/g)) found.add(match[2]);
    for (const match of source.matchAll(/\bcode:\s*(['"])([A-Za-z0-9]+)\1/g)) found.add(match[2]);
    return found;
}

describe('the KEYS table', () => {
    const named = new Map();
    for (const file of harnessSources()) {
        for (const code of keyCodesNamedIn(fs.readFileSync(file, 'utf8'))) {
            if (!named.has(code)) named.set(code, path.relative(repoRoot, file));
        }
    }

    it('found the presses it is meant to be guarding', () => {
        // A regex that quietly stopped matching would make every assertion below vacuous.
        expect(named.has('KeyC')).toBe(true);
        expect(named.has('KeyV')).toBe(true);
        expect(named.size).toBeGreaterThan(20);
    });

    it('resolves every key code the harness presses to a non-zero virtual key code', () => {
        const unresolved = [...named]
            .filter(([code]) => !(Number.isInteger(KEYS[code]?.keyCode) && KEYS[code].keyCode > 0))
            .map(([code, file]) => `${code} (first named in ${file})`);
        expect(unresolved).toEqual([]);
    });

    it('holds the two clipboard chords at their US virtual key codes', () => {
        expect(KEYS.KeyC).toEqual({ key: 'c', keyCode: 67 });
        expect(KEYS.KeyV).toEqual({ key: 'v', keyCode: 86 });
    });

    it('holds every letter and every digit, so a code built at run time cannot miss', () => {
        for (let index = 0; index < 26; index += 1) {
            const letter = String.fromCharCode(0x41 + index);
            expect(KEYS[`Key${letter}`]).toEqual({ key: letter.toLowerCase(), keyCode: 0x41 + index });
        }
        for (let digit = 0; digit <= 9; digit += 1) {
            expect(KEYS[`Digit${String(digit)}`]).toEqual({ key: String(digit), keyCode: 0x30 + digit });
        }
    });
});
