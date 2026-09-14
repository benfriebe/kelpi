import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { KEYS } from './cdp.mjs';

/**
 * Every key code the harness names, and every physical key the client knows, resolves in `KEYS`.
 *
 * WHAT A MISSING ENTRY COSTS. `page.key(code, ...)` looks `code` up in `KEYS` and dispatches
 * whatever it finds as both `windowsVirtualKeyCode` and `nativeVirtualKeyCode`. A code that is not
 * in the table goes out as 0, which is wrong on the wire and invisible to anything that reads it.
 * It is NOT a dropped press for this client: `packages/client/src/chrome/keys.ts` matches
 * `KeyboardEvent.code` and never the virtual code, which is why `terminal-copy-paste-chords` and
 * `plugin-terminal-features` were both passing with `KeyC` and `KeyV` absent from the table for as
 * long as they have existed. So this test does not close #207 and nothing here should be read as
 * doing so. What it closes is a table that had been growing one flow at a time, and a `text` field
 * that a rewrite can delete without a single test noticing.
 *
 * The guard is deliberately two-sided, because neither side is sufficient:
 *
 *   1. a scan of the harness's own source, which catches a key a scenario presses that nobody
 *      thought to add, and which cannot see a code built at run time or passed through a variable;
 *   2. the client's whole physical-key vocabulary (`CODE_TO_KEY_CODE`), which does not depend on
 *      how a call site is written and therefore covers the four `page.key(bound.key.code, ...)`
 *      sites that press whatever the live binding map happens to hold.
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
 * The `KeyboardEvent.code` vocabulary, spelled out.
 *
 * The first argument of `.key(` is a key code by definition and needs no filter. The other two
 * shapes below are string literals in ordinary data, so they do need one: `code: 'ENOENT'` and the
 * CLI argument array `['workspace', 'delete', ...]` must not be reported as keys nobody added.
 * The filter is this explicit vocabulary rather than a `KEYS`-membership pre-check, because
 * membership in the table under test is exactly what the assertions are for: pre-checking it would
 * make the scan report nothing, for ever, by construction.
 */
const KEY_CODE_SHAPE =
    /^(?:Key[A-Z]|Digit[0-9]|F[1-9][0-9]?|Arrow(?:Up|Down|Left|Right)|Page(?:Up|Down)|Numpad[A-Z][A-Za-z0-9]*|Enter|Tab|Escape|Space|Backspace|Delete|Insert|Home|End|Comma|Period|Slash|Semicolon|Quote|Backquote|Backslash|Minus|Equal|Bracket(?:Left|Right)|CapsLock|(?:Shift|Control|Alt|Meta)(?:Left|Right))$/;

/**
 * The three shapes a key code is written in under `scripts/`:
 *
 *   - the first argument of `page.key` / `view.key`, taken unfiltered;
 *   - the `code:` field of a chord table a scenario then feeds to it;
 *   - the first element of a positional tuple table, which is how `audit.mjs` presses the ten
 *     ctrl+letter control codes and the four Home/End/PageUp/PageDown navigation keys. Neither of
 *     the first two regexes sees those, and `PageUp` and `PageDown` are named nowhere else in the
 *     tree, which is how they stayed missing while the audit pressed them on every run.
 *
 * A code built at run time (`Key${character.toUpperCase()}`, `Digit${ordinal}`) is invisible to all
 * three, which is why the generated alphabet and digit row are asserted directly below.
 */
function keyCodesNamedIn(source) {
    const found = new Set();
    for (const match of source.matchAll(/\.key\(\s*(['"])([A-Za-z0-9]+)\1/g)) found.add(match[2]);
    for (const match of source.matchAll(/\bcode:\s*(['"])([A-Za-z0-9]+)\1/g)) {
        if (KEY_CODE_SHAPE.test(match[2])) found.add(match[2]);
    }
    for (const match of source.matchAll(/\[\s*(['"])([A-Za-z][A-Za-z0-9]*)\1\s*,/g)) {
        if (KEY_CODE_SHAPE.test(match[2])) found.add(match[2]);
    }
    return found;
}

/**
 * Every `KeyboardEvent.code` the client's own physical-key table names, read out of the product.
 *
 * `CODE_TO_KEY_CODE` (`packages/client/src/chrome/keys.ts`) is the complete set a config binding
 * can legally carry, and `audit.mjs` presses `bound.key.code` straight out of the live binding map
 * in four places. Reading the product's list rather than restating it here is the half of this
 * test that cannot fall behind a call site.
 */
function clientPhysicalKeyCodes() {
    const source = fs.readFileSync(path.join(repoRoot, 'packages/client/src/chrome/keys.ts'), 'utf8');
    const start = source.indexOf('export const CODE_TO_KEY_CODE');
    expect(start).toBeGreaterThan(-1);
    const table = source.slice(start, source.indexOf(']);', start));
    return [...table.matchAll(/\[\s*'([A-Za-z0-9]+)'\s*,\s*\d+\s*\]/g)].map((match) => match[1]);
}

const resolves = (code) => Number.isInteger(KEYS[code]?.keyCode) && KEYS[code].keyCode > 0;

describe('the KEYS table', () => {
    const named = new Map();
    for (const file of harnessSources()) {
        for (const code of keyCodesNamedIn(fs.readFileSync(file, 'utf8'))) {
            if (!named.has(code)) named.set(code, path.relative(repoRoot, file));
        }
    }

    it('found the presses it is meant to be guarding', () => {
        // A regex that quietly stopped matching would make the assertions below vacuous.
        expect(named.has('KeyC')).toBe(true);
        expect(named.has('KeyV')).toBe(true);
        // Only the positional tuple table names these two, so this is the third regex's own proof.
        expect(named.get('PageUp')).toBe('scripts/ui-audit/audit.mjs');
        expect(named.get('PageDown')).toBe('scripts/ui-audit/audit.mjs');
        expect(named.size).toBeGreaterThan(20);
    });

    it('resolves every key code the harness presses to a non-zero virtual key code', () => {
        const unresolved = [...named]
            .filter(([code]) => !resolves(code))
            .map(([code, file]) => `${code} (first named in ${file})`);
        expect(unresolved).toEqual([]);
    });

    it("covers every physical key the client's own CODE_TO_KEY_CODE names", () => {
        const codes = clientPhysicalKeyCodes();
        expect(codes.length).toBeGreaterThan(60);
        expect(codes.filter((code) => !resolves(code))).toEqual([]);
    });

    it('ignores string literals that are not key codes', () => {
        for (const noise of ['ENOENT', 'ETIMEDOUT', 'abc123', 'workspace', 'delete', 'json', 'Unidentified']) {
            expect(KEY_CODE_SHAPE.test(noise)).toBe(false);
        }
        for (const real of ['KeyC', 'Digit0', 'PageUp', 'Home', 'F12', 'BracketRight', 'NumpadEnter']) {
            expect(KEY_CODE_SHAPE.test(real)).toBe(true);
        }
    });

    it('holds the two clipboard chords at their US virtual key codes', () => {
        expect(KEYS.KeyC).toEqual({ key: 'c', keyCode: 67 });
        expect(KEYS.KeyV).toEqual({ key: 'v', keyCode: 86 });
    });

    it('still sends the raw ESC byte as the text of an unmodified Escape', () => {
        // `audit.mjs` presses Escape into `cat -v` and asserts `^[` reaches the PTY (TERM-155).
        // The byte is one invisible character in the source, so only an assertion can hold it down.
        expect(KEYS.Escape.text).toBe('\u001b');
        expect(KEYS.Escape.text.charCodeAt(0)).toBe(27);
        expect(KEYS.Enter.text).toBe('\r');
        expect(KEYS.Tab.text).toBe('\t');
        expect(KEYS.Backspace.text).toBe('\b');
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

    it('gives no letter or digit a `text`, so an unmodified press stays a press', () => {
        // `key()` sends `spec.text` whenever `modifiers === 0`. A `text` on `KeyC` would turn every
        // unmodified letter press in the suite into a typed character.
        for (const code of Object.keys(KEYS).filter((name) => /^(?:Key[A-Z]|Digit[0-9])$/.test(name))) {
            expect(KEYS[code].text).toBeUndefined();
        }
    });
});
