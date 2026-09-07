/**
 * The chords macOS owns (#95).
 *
 * Two properties matter more than the table itself, because they are what a regression costs:
 *
 *   1. **The set is exactly five.** Every other ⌘ chord must still be the app's or the pane's,
 *      so the negative cases outnumber the positive ones here on purpose.
 *   2. **Modifiers are exact.** ⌥⌘H is Hide Others and ⌘H is Hide; neither answers the other,
 *      and a shifted form is nobody's.
 */

import { describe, expect, it } from 'vitest';

import { keyTriggerConfigString } from './keys.js';
import {
    PLATFORM_CHORDS,
    isPlatformChord,
    platformChordForEvent,
    platformChordsForRoles
} from './platform-chords.js';

interface Mods {
    readonly shift?: boolean;
    readonly alt?: boolean;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
}

function event(code: string, key: string, mods: Mods = {}): Record<string, unknown> {
    return {
        code,
        key,
        shiftKey: mods.shift ?? false,
        altKey: mods.alt ?? false,
        ctrlKey: mods.ctrl ?? false,
        metaKey: mods.meta ?? false
    };
}

describe('PLATFORM_CHORDS', () => {
    it('is the five application- and window-level chords, with the roles that answer them', () => {
        expect(
            PLATFORM_CHORDS.map((chord) => [chord.display, chord.role, chord.accelerator])
        ).toEqual([
            ['⌘H', 'hide', 'Command+H'],
            ['⌥⌘H', 'hideOthers', 'Command+Alt+H'],
            ['⌃⌘F', 'togglefullscreen', 'Control+Command+F'],
            ['⌘M', 'minimize', 'CommandOrControl+M'],
            ['⌘Q', 'quit', 'CommandOrControl+Q']
        ]);
    });

    it('carries a config-file trigger for each, so the binding layer can name them', () => {
        expect(PLATFORM_CHORDS.map((chord) => keyTriggerConfigString(chord.trigger))).toEqual([
            'super+h',
            'alt+super+h',
            'ctrl+super+f',
            'super+m',
            'super+q'
        ]);
    });

    it('filters by role in list order, for the shell menu that builds rows from it', () => {
        expect(platformChordsForRoles(['quit', 'hide']).map((chord) => chord.role)).toEqual([
            'hide',
            'quit'
        ]);
        expect(platformChordsForRoles([])).toEqual([]);
    });
});

describe('platformChordForEvent', () => {
    it('matches each of the five on its physical key', () => {
        expect(platformChordForEvent(event('KeyH', 'h', { meta: true }))?.role).toBe('hide');
        expect(platformChordForEvent(event('KeyH', 'h', { meta: true, alt: true }))?.role).toBe(
            'hideOthers'
        );
        expect(platformChordForEvent(event('KeyF', 'f', { meta: true, ctrl: true }))?.role).toBe(
            'togglefullscreen'
        );
        expect(platformChordForEvent(event('KeyM', 'm', { meta: true }))?.role).toBe('minimize');
        expect(platformChordForEvent(event('KeyQ', 'q', { meta: true }))?.role).toBe('quit');
    });

    it('needs ⌘: the same keys without it are nobody special', () => {
        expect(isPlatformChord(event('KeyH', 'h'))).toBe(false);
        expect(isPlatformChord(event('KeyM', 'm', { ctrl: true }))).toBe(false);
        expect(isPlatformChord(event('KeyF', 'f', { ctrl: true }))).toBe(false);
        expect(isPlatformChord(event('KeyQ', 'q', { alt: true }))).toBe(false);
    });

    it('is exact about ⌥ and ⌃, so the two ⌘H chords never answer for each other', () => {
        // ⌃⌘H and ⌥⌘M are no role's accelerator: a terminal keeps encoding them.
        expect(isPlatformChord(event('KeyH', 'h', { meta: true, ctrl: true }))).toBe(false);
        expect(isPlatformChord(event('KeyM', 'm', { meta: true, alt: true }))).toBe(false);
        expect(isPlatformChord(event('KeyF', 'f', { meta: true }))).toBe(false);
        expect(isPlatformChord(event('KeyF', 'f', { meta: true, alt: true }))).toBe(false);
        expect(isPlatformChord(event('KeyQ', 'q', { meta: true, ctrl: true }))).toBe(false);
    });

    it('never tolerates ⇧, unlike the system-editing family (⇧⌘Z is still Redo, ⇧⌘M is not Minimize)', () => {
        expect(isPlatformChord(event('KeyH', 'h', { meta: true, shift: true }))).toBe(false);
        expect(isPlatformChord(event('KeyM', 'm', { meta: true, shift: true }))).toBe(false);
        expect(isPlatformChord(event('KeyQ', 'q', { meta: true, shift: true }))).toBe(false);
    });

    it('leaves every other ⌘ chord alone, including the ones Kelpi and the Edit menu own', () => {
        for (const [code, key] of [
            ['KeyB', 'b'],
            ['KeyD', 'd'],
            ['KeyW', 'w'],
            ['KeyV', 'v'],
            ['KeyC', 'c'],
            ['KeyR', 'r'],
            ['KeyI', 'i'],
            ['Comma', ','],
            ['Slash', '/'],
            ['MetaLeft', 'Meta']
        ] as const) {
            expect(isPlatformChord(event(code, key, { meta: true }))).toBe(false);
        }
    });

    it('matches on `code`, so a layout that moves the letter keeps the chord on the H key', () => {
        // Dvorak: the physical H key produces "d". The chord follows the key, exactly as every
        // Kelpi binding does (config-keybindings.md §3).
        expect(platformChordForEvent(event('KeyH', 'd', { meta: true }))?.role).toBe('hide');
        // And the converse: the key that PRODUCES "h" there is not Hide.
        expect(isPlatformChord(event('KeyJ', 'h', { meta: true }))).toBe(false);
    });

    it('falls back to the produced key only when there is no `code` at all', () => {
        expect(platformChordForEvent({ key: 'h', metaKey: true })?.role).toBe('hide');
        expect(platformChordForEvent({ key: 'H', metaKey: true })?.role).toBe('hide');
        expect(platformChordForEvent({ key: 'm', metaKey: true, altKey: true })).toBeNull();
        expect(platformChordForEvent({ metaKey: true })).toBeNull();
    });
});
