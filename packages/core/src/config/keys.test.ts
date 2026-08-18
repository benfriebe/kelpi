import { describe, expect, it } from 'vitest';
import {
    KEY_NAME_TO_CODE,
    keyTriggerConfigString,
    keyTriggerKey,
    keyTriggersEqual,
    makeKeyTrigger,
    parseKeyTrigger
} from './keys.js';

describe('parseKeyTrigger', () => {
    it('parses modifiers and the trailing key, case-insensitively', () => {
        expect(parseKeyTrigger('super+shift+d')).toEqual({ keyCode: 2, modifiers: ['shift', 'super'] });
        expect(parseKeyTrigger('SUPER+SHIFT+D')).toEqual({ keyCode: 2, modifiers: ['shift', 'super'] });
        expect(parseKeyTrigger('ctrl+alt+space')).toEqual({
            keyCode: 49,
            modifiers: ['ctrl', 'alt']
        });
    });

    it('accepts zero-modifier triggers', () => {
        expect(parseKeyTrigger('escape')).toEqual({ keyCode: 53, modifiers: [] });
    });

    it('accepts every modifier alias', () => {
        for (const alias of ['super', 'cmd', 'command']) {
            expect(parseKeyTrigger(`${alias}+d`)?.modifiers).toEqual(['super']);
        }
        for (const alias of ['alt', 'opt', 'option']) {
            expect(parseKeyTrigger(`${alias}+d`)?.modifiers).toEqual(['alt']);
        }
        for (const alias of ['ctrl', 'control']) {
            expect(parseKeyTrigger(`${alias}+d`)?.modifiers).toEqual(['ctrl']);
        }
    });

    it('accepts the punctuation keys that split cleanly on +', () => {
        expect(parseKeyTrigger('super+=')?.keyCode).toBe(24);
        expect(parseKeyTrigger('super+equals')?.keyCode).toBe(24);
        expect(parseKeyTrigger('super+-')?.keyCode).toBe(27);
        expect(parseKeyTrigger('super+[')?.keyCode).toBe(33);
        expect(parseKeyTrigger('super+]')?.keyCode).toBe(30);
    });

    it('accepts the alias spellings for digits and named keys', () => {
        expect(parseKeyTrigger('super+one')?.keyCode).toBe(KEY_NAME_TO_CODE.get('1'));
        expect(parseKeyTrigger('super+enter')?.keyCode).toBe(36);
        expect(parseKeyTrigger('esc')?.keyCode).toBe(53);
        expect(parseKeyTrigger('super+backspace')?.keyCode).toBe(51);
    });

    it('rejects unknown keys, unknown modifiers and the unrepresentable + key', () => {
        expect(parseKeyTrigger('super+nope')).toBeNull();
        expect(parseKeyTrigger('hyper+d')).toBeNull();
        expect(parseKeyTrigger('+')).toBeNull();
        expect(parseKeyTrigger('')).toBeNull();
        expect(parseKeyTrigger('super + d')).toBeNull();
    });
});

describe('keyTriggerConfigString', () => {
    it('emits modifiers in ctrl, alt, shift, super order', () => {
        const trigger = makeKeyTrigger(2, ['super', 'shift']);
        expect(keyTriggerConfigString(trigger)).toBe('shift+super+d');
        expect(keyTriggerConfigString(makeKeyTrigger(49, ['alt', 'ctrl']))).toBe('ctrl+alt+space');
    });

    it('round-trips the canonical spellings', () => {
        for (const config of ['shift+super+d', 'ctrl+alt+space', 'escape', 'super+=', 'alt+super+left']) {
            const trigger = parseKeyTrigger(config);
            expect(trigger).not.toBeNull();
            expect(keyTriggerConfigString(trigger!)).toBe(config);
        }
    });

    it('normalizes alias spellings on the way out', () => {
        expect(keyTriggerConfigString(parseKeyTrigger('cmd+opt+enter')!)).toBe('alt+super+return');
        expect(keyTriggerConfigString(parseKeyTrigger('super+one')!)).toBe('super+1');
    });

    it('serializes an unmapped key code as "unknown" (lost on round-trip)', () => {
        expect(keyTriggerConfigString(makeKeyTrigger(999, ['super']))).toBe('super+unknown');
        expect(parseKeyTrigger('super+unknown')).toBeNull();
    });

    it('keeps the punctuation asymmetry the app ships: `;` writes but does not re-parse', () => {
        const semicolon = parseKeyTrigger('ctrl+semicolon');
        expect(semicolon?.keyCode).toBe(41);
        expect(keyTriggerConfigString(semicolon!)).toBe('ctrl+;');
        expect(parseKeyTrigger('ctrl+;')).toBeNull();
    });
});

describe('trigger identity', () => {
    it('is exact modifier-set + key-code equality', () => {
        expect(keyTriggersEqual(parseKeyTrigger('super+d')!, parseKeyTrigger('cmd+d')!)).toBe(true);
        expect(keyTriggersEqual(parseKeyTrigger('super+d')!, parseKeyTrigger('super+shift+d')!)).toBe(
            false
        );
        expect(keyTriggerKey(parseKeyTrigger('shift+super+d')!)).toBe(
            keyTriggerKey(makeKeyTrigger(2, ['super', 'shift']))
        );
    });

    it('does not collide for distinct unmapped key codes', () => {
        expect(keyTriggerKey(makeKeyTrigger(998, []))).not.toBe(keyTriggerKey(makeKeyTrigger(999, [])));
    });
});
