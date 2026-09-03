/**
 * The chord relay's key-code bridge (`./key-codes.ts`).
 *
 * Two obligations, and the module is only useful if both hold:
 *
 *   1. **Coverage** — every key code a `keybind` line can name has a `KeyboardEvent.code`, or a
 *      user's binding would be silently unreachable from a page, which is the exact class of
 *      defect issue #33 is about.
 *   2. **Agreement** — the code it emits is one the client's dispatcher maps back to the SAME
 *      key code. The client owns that direction (`client/src/chrome/keys.ts` ▸
 *      `CODE_TO_KEY_CODE`) and cannot be imported here (no package edge, deliberately), so the
 *      test reads it off disk. A duplicated table that nothing compares is a table that drifts.
 */

import { KEY_CODE_TO_CONFIG_NAME, KEY_NAME_TO_CODE } from '@kelpi/core/config';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { configurableKeyCodes, domCodeForKeyCode } from './key-codes.js';

const CLIENT_KEYS = new URL('../../../client/src/chrome/keys.ts', import.meta.url);

/** `['KeyD', 2]` … out of the client's `CODE_TO_KEY_CODE` literal. */
function clientCodeToKeyCode(): ReadonlyMap<string, number> {
    const source = readFileSync(CLIENT_KEYS, 'utf8');
    const start = source.indexOf('CODE_TO_KEY_CODE');
    const end = source.indexOf(']);', start);
    expect(start, `CODE_TO_KEY_CODE not found in ${CLIENT_KEYS.pathname}`).toBeGreaterThan(-1);
    const pairs = new Map<string, number>();
    for (const [, code, keyCode] of source.slice(start, end).matchAll(/\['([A-Za-z0-9]+)',\s*(\d+)\]/g)) {
        pairs.set(code as string, Number(keyCode));
    }
    return pairs;
}

describe('the key-code bridge', () => {
    it('names a browser key for every key code a config file can', () => {
        const missing = [...configurableKeyCodes()].filter((keyCode) => domCodeForKeyCode(keyCode) === null);
        expect(missing).toEqual([]);
        // …and `configurableKeyCodes` really is the config file's whole vocabulary.
        expect(configurableKeyCodes().size).toBe(new Set(KEY_NAME_TO_CODE.values()).size);
    });

    it('emits codes the client maps straight back to the same key code', () => {
        const client = clientCodeToKeyCode();
        expect(client.size).toBeGreaterThan(60);
        const disagreements: string[] = [];
        for (const keyCode of configurableKeyCodes()) {
            const code = domCodeForKeyCode(keyCode);
            if (code === null) continue;
            if (client.get(code) !== keyCode) {
                disagreements.push(`${String(keyCode)} → ${code} → ${String(client.get(code))}`);
            }
        }
        expect(disagreements).toEqual([]);
    });

    it('resolves the two ambiguous codes the way the wire needs', () => {
        // 36 is Enter and NumpadEnter in the client's table; either decodes, so the plain one
        // is emitted. 51/117 are macOS's ⌫ and ⌦, which the DOM calls the other way round from
        // the config file's `delete` / `forward_delete`.
        expect(domCodeForKeyCode(36)).toBe('Enter');
        expect(domCodeForKeyCode(51)).toBe('Backspace');
        expect(domCodeForKeyCode(117)).toBe('Delete');
        expect(KEY_NAME_TO_CODE.get('delete')).toBe(51);
        expect(KEY_NAME_TO_CODE.get('forward_delete')).toBe(117);
    });

    it('agrees with the config file on the keys the relay actually carries', () => {
        expect(domCodeForKeyCode(KEY_NAME_TO_CODE.get('d') ?? -1)).toBe('KeyD');
        expect(domCodeForKeyCode(KEY_NAME_TO_CODE.get('p') ?? -1)).toBe('KeyP');
        expect(domCodeForKeyCode(KEY_NAME_TO_CODE.get(']') ?? -1)).toBe('BracketRight');
        expect(domCodeForKeyCode(KEY_NAME_TO_CODE.get('=') ?? -1)).toBe('Equal');
        expect(domCodeForKeyCode(KEY_NAME_TO_CODE.get('return') ?? -1)).toBe('Enter');
        expect(domCodeForKeyCode(KEY_NAME_TO_CODE.get('space') ?? -1)).toBe('Space');
        // The writer's canonical names round-trip too, which is what a Settings-recorded
        // binding arrives as.
        expect(domCodeForKeyCode(43)).toBe('Comma');
        expect(KEY_CODE_TO_CONFIG_NAME.get(43)).toBe(',');
    });

    it('says null for a key code no browser names', () => {
        expect(domCodeForKeyCode(999)).toBeNull();
    });
});
