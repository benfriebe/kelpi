/**
 * `keyTriggerDisplayString` — config-keybindings.md §3.3's display half.
 *
 * The rule the doc states is exact ("macOS symbol order ⌃ ⌥ ⇧ ⌘ concatenated (no separator),
 * then the key: uppercased character, or display name … or `?` for unknown"), so these are
 * conformance assertions rather than examples: a change to the tables has to break one.
 */

import { describe, expect, it } from 'vitest';

import {
    KEY_CODE_TO_CONFIG_NAME,
    keyTriggerDisplayString,
    makeKeyTrigger,
    parseKeyTrigger,
    UNKNOWN_KEY_DISPLAY,
    type KeyTrigger
} from './index.js';
import { DEFAULT_KEYBINDINGS } from './bindings.js';

function display(spelling: string): string {
    const trigger = parseKeyTrigger(spelling);
    if (trigger === null) throw new Error(`unparseable trigger: ${spelling}`);
    return keyTriggerDisplayString(trigger);
}

describe('keyTriggerDisplayString', () => {
    it('renders the doc’s worked examples', () => {
        expect(display('shift+super+d')).toBe('⇧⌘D');
        expect(display('ctrl+alt+space')).toBe('⌃⌥Space');
    });

    it('uses the ⌃⌥⇧⌘ symbol order regardless of how the trigger was spelled', () => {
        const trigger: KeyTrigger = makeKeyTrigger(2, ['super', 'shift', 'alt', 'ctrl']);
        expect(keyTriggerDisplayString(trigger)).toBe('⌃⌥⇧⌘D');
    });

    it('names the non-printing keys the way the doc does', () => {
        expect(display('return')).toBe('Return');
        expect(display('tab')).toBe('Tab');
        expect(display('escape')).toBe('Esc');
        expect(display('space')).toBe('Space');
        expect(display('delete')).toBe('Delete');
        expect(display('forward_delete')).toBe('Fwd Del');
        expect(display('left')).toBe('←');
        expect(display('right')).toBe('→');
        expect(display('down')).toBe('↓');
        expect(display('up')).toBe('↑');
        expect(display('f7')).toBe('F7');
    });

    it('uppercases letters and passes digits and punctuation through', () => {
        expect(display('a')).toBe('A');
        expect(display('super+9')).toBe('⌘9');
        expect(display('super+=')).toBe('⌘=');
        expect(display('super+-')).toBe('⌘-');
        expect(display('super+[')).toBe('⌘[');
    });

    it('falls back to ? for a keyCode with no name', () => {
        expect(keyTriggerDisplayString(makeKeyTrigger(9999, ['super']))).toBe(`⌘${UNKNOWN_KEY_DISPLAY}`);
    });

    it('covers every keyCode the config writer can emit', () => {
        for (const keyCode of KEY_CODE_TO_CONFIG_NAME.keys()) {
            expect(keyTriggerDisplayString(makeKeyTrigger(keyCode, []))).not.toBe(UNKNOWN_KEY_DISPLAY);
        }
    });

    it('renders every shipped default binding without falling back', () => {
        for (const binding of DEFAULT_KEYBINDINGS.values()) {
            expect(keyTriggerDisplayString(binding.trigger)).not.toContain(UNKNOWN_KEY_DISPLAY);
        }
    });
});
