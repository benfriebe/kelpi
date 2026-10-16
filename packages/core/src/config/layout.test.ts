import { describe, expect, it } from 'vitest';

import { CHARACTER_KEYSTROKES, characterChordKeystroke, chordKeyIdentity } from './layout.js';

const press = (code: string, key: string | undefined, extra: { shiftKey?: boolean; altKey?: boolean } = {}) =>
    chordKeyIdentity({ code, key, ...extra });

describe('chordKeyIdentity (#245)', () => {
    it('leaves every US punctuation key exactly as pressed, shifted or not', () => {
        for (const [character, stroke] of Object.entries(CHARACTER_KEYSTROKES)) {
            expect(press(stroke.code, character, { shiftKey: stroke.shift })).toEqual({ code: stroke.code, shiftKey: stroke.shift });
        }
        // An engine that reports the unshifted character under ⌘⇧ is the same key, Shift kept.
        expect(press('Equal', '=', { shiftKey: true })).toEqual({ code: 'Equal', shiftKey: true });
        expect(press('BracketLeft', '[', { shiftKey: true })).toEqual({ code: 'BracketLeft', shiftKey: true });
        expect(press('BracketRight', ']')).toEqual({ code: 'BracketRight', shiftKey: false });
    });

    it('matches German ⌘+ and ⌘- by the character they type', () => {
        expect(press('BracketRight', '+')).toEqual({ code: 'Equal', shiftKey: true });
        expect(press('Slash', '-')).toEqual({ code: 'Minus', shiftKey: false });
        // ⌘⇧ on the ß key, where the engine reports the shifted character.
        expect(press('Minus', '?', { shiftKey: true })).toEqual({ code: 'Slash', shiftKey: true });
    });

    it('matches Nordic ⌘+ and French Mac ⌘- by character', () => {
        expect(press('Minus', '+')).toEqual({ code: 'Equal', shiftKey: true });
        expect(press('Equal', '-')).toEqual({ code: 'Minus', shiftKey: false });
    });

    it('keeps a key that typed something outside the table on its position', () => {
        expect(press('BracketLeft', 'ü')).toEqual({ code: 'BracketLeft', shiftKey: false });
        expect(press('Minus', 'ß')).toEqual({ code: 'Minus', shiftKey: false });
        expect(press('Equal', 'Dead')).toEqual({ code: 'Equal', shiftKey: false });
        expect(press('Period', 'ю')).toEqual({ code: 'Period', shiftKey: false });
        expect(press('Equal', undefined, { shiftKey: true })).toEqual({ code: 'Equal', shiftKey: true });
        expect(press('BracketRight', '*', { shiftKey: true })).toEqual({ code: 'BracketRight', shiftKey: true });
    });

    it('never moves a chord onto or off a bracket, a letter or a digit', () => {
        // Brackets are not character targets: a layout typing `[` elsewhere does not move ⌘[.
        expect(characterChordKeystroke({ code: 'Minus', key: '[' })).toBeNull();
        // Letter and digit keys are not sources: AZERTY's digit row still switches workspaces.
        expect(press('Digit6', '-')).toEqual({ code: 'Digit6', shiftKey: false });
        expect(press('Digit1', '&')).toEqual({ code: 'Digit1', shiftKey: false });
        expect(press('KeyM', ',')).toEqual({ code: 'KeyM', shiftKey: false });
        // A punctuation key that typed a letter stays where it is.
        expect(press('Semicolon', 'm')).toEqual({ code: 'Semicolon', shiftKey: false });
    });

    it('stays positional while ⌥ is held (⌥ and AltGr choose the character layer)', () => {
        expect(press('Minus', '\\', { altKey: true })).toEqual({ code: 'Minus', shiftKey: false });
        expect(press('BracketRight', '+', { altKey: true })).toEqual({ code: 'BracketRight', shiftKey: false });
    });

    it('ignores an inherited object member typed as a key', () => {
        expect(characterChordKeystroke({ code: 'Slash', key: 'constructor' })).toBeNull();
    });
});
