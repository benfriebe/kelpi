/**
 * The kitty keyboard encoder, as a byte matrix (§TERM-030).
 *
 * Shaped like `mouse.test.ts` on purpose: key + modifiers + event type → the EXACT bytes, never
 * a pattern. Two properties get as much attention as the encodings themselves, because they are
 * what a regression would actually cost a user:
 *
 *   1. **`null` means the engine keeps the key.** With the protocol off, and for every key whose
 *      kitty form is its legacy form, the encoder must decline — that is what keeps plain typing
 *      byte-identical and DECCKM working.
 *   2. **Unsupported flags are inert.** A bit the daemon would never store must not change one
 *      byte if it arrives anyway.
 */

import { describe, expect, it } from 'vitest';

import {
    KITTY_DISAMBIGUATE,
    KITTY_REPORT_ALL_KEYS,
    KITTY_REPORT_EVENT_TYPES,
    createKittyKeyboard,
    encodeKittyKey,
    kittyModifiers,
    kittyTextCodepoint,
    sanitizeKittyFlags,
    type KittyKeyEventLike
} from './kitty-keyboard';

/** The three flag sets an application realistically negotiates. */
const DISAMBIGUATE = KITTY_DISAMBIGUATE; // 1
const WITH_EVENTS = KITTY_DISAMBIGUATE | KITTY_REPORT_EVENT_TYPES; // 3
const EVERYTHING = KITTY_DISAMBIGUATE | KITTY_REPORT_EVENT_TYPES | KITTY_REPORT_ALL_KEYS; // 11

const decoder = new TextDecoder();

interface Mods {
    readonly shift?: boolean;
    readonly alt?: boolean;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
}

function event(
    type: 'keydown' | 'keyup',
    key: string,
    mods: Mods & { code?: string; location?: number; repeat?: boolean } = {}
): KittyKeyEventLike {
    return {
        type,
        key,
        ...(mods.code === undefined ? {} : { code: mods.code }),
        ...(mods.location === undefined ? {} : { location: mods.location }),
        ...(mods.repeat === undefined ? {} : { repeat: mods.repeat }),
        shiftKey: mods.shift ?? false,
        altKey: mods.alt ?? false,
        ctrlKey: mods.ctrl ?? false,
        metaKey: mods.meta ?? false
    };
}

/** Encode a press and read the answer as text, or `null` when the engine keeps the key. */
function press(key: string, flags: number, mods: Parameters<typeof event>[2] = {}): string | null {
    const bytes = encodeKittyKey(event('keydown', key, mods), flags);
    return bytes === null ? null : decoder.decode(bytes);
}

function release(key: string, flags: number, mods: Parameters<typeof event>[2] = {}): string | null {
    const bytes = encodeKittyKey(event('keyup', key, mods), flags);
    return bytes === null ? null : decoder.decode(bytes);
}

describe('kittyModifiers', () => {
    it('is 1 + the shift/alt/ctrl/super bitfield, and nothing else', () => {
        expect(kittyModifiers(event('keydown', 'a'))).toBe(0);
        expect(kittyModifiers(event('keydown', 'A', { shift: true }))).toBe(0b1);
        expect(kittyModifiers(event('keydown', 'a', { alt: true }))).toBe(0b10);
        expect(kittyModifiers(event('keydown', 'a', { ctrl: true }))).toBe(0b100);
        expect(kittyModifiers(event('keydown', 'a', { meta: true }))).toBe(0b1000);
        expect(
            kittyModifiers(event('keydown', 'a', { shift: true, alt: true, ctrl: true, meta: true }))
        ).toBe(0b1111);
    });
});

describe('kittyTextCodepoint', () => {
    it('lowercases, so shift+A is `a` plus the shift bit rather than a second identity', () => {
        expect(kittyTextCodepoint('a')).toBe(97);
        expect(kittyTextCodepoint('A')).toBe(97);
        expect(kittyTextCodepoint(' ')).toBe(32);
        expect(kittyTextCodepoint('Enter')).toBeNull();
        // Astral scalars are one codepoint and pass straight through.
        expect(kittyTextCodepoint('😀')).toBe(0x1f600);
    });
});

describe('sanitizeKittyFlags', () => {
    it('drops the bits this port does not implement', () => {
        expect(sanitizeKittyFlags(31)).toBe(11);
        expect(sanitizeKittyFlags(0b100)).toBe(0); // report alternate keys, alone
        expect(sanitizeKittyFlags(0b10000)).toBe(0); // report associated text, alone
        expect(sanitizeKittyFlags(undefined)).toBe(0);
        expect(sanitizeKittyFlags(Number.NaN)).toBe(0);
    });
});

describe('encodeKittyKey — the protocol is off', () => {
    it('declines EVERY key when flags are zero, which is the legacy guarantee', () => {
        for (const key of ['a', 'A', 'Enter', 'Tab', 'Escape', 'ArrowUp', 'F5', 'Shift', 'Delete']) {
            expect(press(key, 0)).toBeNull();
            expect(release(key, 0)).toBeNull();
            expect(press(key, 0, { ctrl: true })).toBeNull();
        }
    });

    it('declines every key when only unsupported flags were somehow set', () => {
        // The daemon masks before storing, so this can only arrive from a hand-rolled client —
        // and it must still behave as "protocol off" rather than half-on.
        expect(press('Escape', 0b100)).toBeNull();
        expect(press('a', 0b10100, { ctrl: true })).toBeNull();
    });
});

describe('encodeKittyKey — disambiguate escape codes (0b1)', () => {
    it('reports Escape as CSI 27 u, which is the whole point of the flag', () => {
        expect(press('Escape', DISAMBIGUATE)).toBe('\x1b[27u');
    });

    it('separates ctrl+i from Tab — the ambiguity that names the flag', () => {
        // Legacy: both are 0x09 and no application can tell them apart.
        expect(press('i', DISAMBIGUATE, { ctrl: true, code: 'KeyI' })).toBe('\x1b[105;5u');
        expect(press('Tab', DISAMBIGUATE, { code: 'Tab' })).toBeNull();
    });

    it('separates ctrl+m from Enter, and ctrl+[ from Escape', () => {
        expect(press('m', DISAMBIGUATE, { ctrl: true })).toBe('\x1b[109;5u');
        expect(press('Enter', DISAMBIGUATE)).toBeNull();
        expect(press('[', DISAMBIGUATE, { ctrl: true })).toBe('\x1b[91;5u');
    });

    it('encodes the ctrl / alt / super chords with 1 + the bitfield', () => {
        expect(press('a', DISAMBIGUATE, { ctrl: true })).toBe('\x1b[97;5u');
        expect(press('a', DISAMBIGUATE, { alt: true })).toBe('\x1b[97;3u');
        expect(press('a', DISAMBIGUATE, { meta: true })).toBe('\x1b[97;9u');
        expect(press('a', DISAMBIGUATE, { ctrl: true, alt: true })).toBe('\x1b[97;7u');
        // Shift lowercases the key rather than becoming a second identity for it.
        expect(press('A', DISAMBIGUATE, { ctrl: true, shift: true })).toBe('\x1b[97;6u');
    });

    it('leaves plain and shifted typing to the engine', () => {
        expect(press('a', DISAMBIGUATE)).toBeNull();
        expect(press('A', DISAMBIGUATE, { shift: true })).toBeNull();
        expect(press(' ', DISAMBIGUATE, { code: 'Space' })).toBeNull();
        expect(press('1', DISAMBIGUATE, { code: 'Digit1' })).toBeNull();
    });

    it('keeps Enter / Tab / Backspace legacy unmodified, and reports them when chorded', () => {
        expect(press('Enter', DISAMBIGUATE)).toBeNull();
        expect(press('Tab', DISAMBIGUATE)).toBeNull();
        expect(press('Backspace', DISAMBIGUATE)).toBeNull();
        expect(press('Enter', DISAMBIGUATE, { shift: true })).toBe('\x1b[13;2u');
        expect(press('Enter', DISAMBIGUATE, { ctrl: true })).toBe('\x1b[13;5u');
        expect(press('Tab', DISAMBIGUATE, { shift: true })).toBe('\x1b[9;2u');
        expect(press('Backspace', DISAMBIGUATE, { alt: true })).toBe('\x1b[127;3u');
    });

    it('hands unmodified functional keys back so DECCKM keeps working', () => {
        // `CSI A` in both protocols — but only the engine knows whether the application asked
        // for `SS3 A` instead, so encoding it here would break arrows inside `less`.
        expect(press('ArrowUp', DISAMBIGUATE)).toBeNull();
        expect(press('Home', DISAMBIGUATE)).toBeNull();
        expect(press('Delete', DISAMBIGUATE)).toBeNull();
        expect(press('F1', DISAMBIGUATE)).toBeNull();
        expect(press('F5', DISAMBIGUATE)).toBeNull();
    });

    it('encodes functional keys once a modifier makes them unambiguous', () => {
        expect(press('ArrowUp', DISAMBIGUATE, { ctrl: true })).toBe('\x1b[1;5A');
        expect(press('ArrowDown', DISAMBIGUATE, { shift: true })).toBe('\x1b[1;2B');
        expect(press('ArrowRight', DISAMBIGUATE, { alt: true })).toBe('\x1b[1;3C');
        expect(press('ArrowLeft', DISAMBIGUATE, { meta: true })).toBe('\x1b[1;9D');
        expect(press('Home', DISAMBIGUATE, { ctrl: true })).toBe('\x1b[1;5H');
        expect(press('End', DISAMBIGUATE, { ctrl: true })).toBe('\x1b[1;5F');
        expect(press('Delete', DISAMBIGUATE, { shift: true })).toBe('\x1b[3;2~');
        expect(press('PageUp', DISAMBIGUATE, { ctrl: true })).toBe('\x1b[5;5~');
        expect(press('F1', DISAMBIGUATE, { shift: true })).toBe('\x1b[1;2P');
        // F3 is `13 ~`, not `CSI R` — `CSI R` is the cursor-position report.
        expect(press('F3', DISAMBIGUATE, { shift: true })).toBe('\x1b[13;2~');
        expect(press('F5', DISAMBIGUATE, { ctrl: true })).toBe('\x1b[15;5~');
    });

    it('reports F13 and up in the protocol private-use block', () => {
        expect(press('F13', DISAMBIGUATE)).toBe('\x1b[57376u');
        expect(press('F24', DISAMBIGUATE)).toBe('\x1b[57387u');
        // F36 is not a key the protocol names; it falls through rather than being invented.
        expect(press('F36', DISAMBIGUATE)).toBeNull();
    });

    it('splits the keypad from the main block, num lock either way', () => {
        expect(press('5', DISAMBIGUATE, { code: 'Numpad5', location: 3 })).toBe('\x1b[57404u');
        expect(press('5', DISAMBIGUATE, { code: 'Digit5' })).toBeNull();
        expect(press('Enter', DISAMBIGUATE, { code: 'NumpadEnter', location: 3 })).toBe('\x1b[57414u');
        expect(press('+', DISAMBIGUATE, { code: 'NumpadAdd', location: 3 })).toBe('\x1b[57413u');
        // Num lock off: the browser reports the navigation key the keypad produced.
        expect(press('ArrowLeft', DISAMBIGUATE, { code: 'Numpad4', location: 3 })).toBe('\x1b[57417u');
        expect(press('Home', DISAMBIGUATE, { code: 'Numpad7', location: 3 })).toBe('\x1b[57423u');
    });

    it('says nothing about the modifier keys themselves — those need report-all-keys', () => {
        expect(press('Shift', DISAMBIGUATE, { shift: true, location: 1 })).toBeNull();
        expect(press('Control', DISAMBIGUATE, { ctrl: true, location: 1 })).toBeNull();
        expect(release('Shift', DISAMBIGUATE, { location: 1 })).toBeNull();
    });

    it('drops releases entirely, because event types were not negotiated', () => {
        expect(release('Escape', DISAMBIGUATE)).toBeNull();
        expect(release('a', DISAMBIGUATE, { ctrl: true })).toBeNull();
        expect(release('ArrowUp', DISAMBIGUATE, { ctrl: true })).toBeNull();
    });

    it('reports an auto-repeat as an ordinary press', () => {
        expect(press('a', DISAMBIGUATE, { ctrl: true, repeat: true })).toBe('\x1b[97;5u');
    });
});

describe('encodeKittyKey — report event types (0b10)', () => {
    it('adds the :3 release form, with the modifier field written even when default', () => {
        expect(release('Escape', WITH_EVENTS)).toBe('\x1b[27;1:3u');
        expect(release('a', WITH_EVENTS, { ctrl: true })).toBe('\x1b[97;5:3u');
    });

    it('gives an unmodified arrow a release even though its press stays legacy', () => {
        // The press is `CSI A` in both protocols and is left to the engine; the release has no
        // legacy form at all, so it is ours.
        expect(press('ArrowUp', WITH_EVENTS)).toBeNull();
        expect(release('ArrowUp', WITH_EVENTS)).toBe('\x1b[1;1:3A');
        expect(release('ArrowUp', WITH_EVENTS, { shift: true })).toBe('\x1b[1;2:3A');
        expect(release('Delete', WITH_EVENTS)).toBe('\x1b[3;1:3~');
    });

    it('marks an auto-repeat :2', () => {
        expect(press('a', WITH_EVENTS, { ctrl: true, repeat: true })).toBe('\x1b[97;5:2u');
        expect(press('Escape', WITH_EVENTS, { repeat: true })).toBe('\x1b[27;1:2u');
    });

    it('still says nothing for a text key, in either direction', () => {
        // Its press is text and its release has no representation that is not report-all-keys.
        expect(press('a', WITH_EVENTS)).toBeNull();
        expect(release('a', WITH_EVENTS)).toBeNull();
        // Same rule for the three keys that keep their legacy control byte: a key whose PRESS
        // stayed legacy has no release either, or an application that asked only for
        // disambiguation would start seeing escape codes for keys it is handling as `\r`.
        expect(press('Enter', WITH_EVENTS)).toBeNull();
        expect(release('Enter', WITH_EVENTS)).toBeNull();
        expect(press('Tab', WITH_EVENTS)).toBeNull();
        expect(release('Tab', WITH_EVENTS)).toBeNull();
        expect(release('Backspace', WITH_EVENTS)).toBeNull();
        // Chorded, though, they are ours in both directions.
        expect(press('Tab', WITH_EVENTS, { shift: true })).toBe('\x1b[9;2u');
        expect(release('Tab', WITH_EVENTS, { shift: true })).toBe('\x1b[9;2:3u');
    });

    it('without disambiguation there is no CSI u identity to hang an event type on', () => {
        // flags = 0b10 alone: arrows gain releases (they have a CSI form already), Escape does
        // not (its CSI form is exactly what disambiguation buys).
        expect(release('ArrowUp', KITTY_REPORT_EVENT_TYPES)).toBe('\x1b[1;1:3A');
        expect(press('Escape', KITTY_REPORT_EVENT_TYPES)).toBeNull();
        expect(release('Escape', KITTY_REPORT_EVENT_TYPES)).toBeNull();
    });
});

describe('encodeKittyKey — report all keys as escape codes (0b1000)', () => {
    it('turns ordinary typing into CSI u codes', () => {
        expect(press('a', EVERYTHING)).toBe('\x1b[97u');
        expect(press('A', EVERYTHING, { shift: true })).toBe('\x1b[97;2u');
        expect(press(' ', EVERYTHING, { code: 'Space' })).toBe('\x1b[32u');
        expect(release('a', EVERYTHING)).toBe('\x1b[97;1:3u');
    });

    it('overrides the Enter / Tab / Backspace legacy clause', () => {
        expect(press('Enter', EVERYTHING)).toBe('\x1b[13u');
        expect(press('Tab', EVERYTHING)).toBe('\x1b[9u');
        expect(press('Backspace', EVERYTHING)).toBe('\x1b[127u');
        expect(release('Enter', EVERYTHING)).toBe('\x1b[13;1:3u');
    });

    it('reports the MODIFIER keys, left and right apart — §TERM-030 s own subject', () => {
        // `KeyboardEvent.location` is the browser's device-side mask bit: 1 left, 2 right.
        // The press carries the modifier it just turned on; the release does not, because by
        // then the browser says it is up.
        expect(press('Shift', EVERYTHING, { shift: true, location: 1 })).toBe('\x1b[57441;2u');
        expect(release('Shift', EVERYTHING, { location: 1 })).toBe('\x1b[57441;1:3u');
        expect(press('Shift', EVERYTHING, { shift: true, location: 2 })).toBe('\x1b[57447;2u');
        expect(press('Control', EVERYTHING, { ctrl: true, location: 1 })).toBe('\x1b[57442;5u');
        expect(release('Control', EVERYTHING, { location: 2 })).toBe('\x1b[57448;1:3u');
        expect(press('Alt', EVERYTHING, { alt: true, location: 1 })).toBe('\x1b[57443;3u');
        expect(release('Alt', EVERYTHING, { location: 2 })).toBe('\x1b[57449;1:3u');
        expect(press('Meta', EVERYTHING, { meta: true, location: 1 })).toBe('\x1b[57444;9u');
        expect(release('Meta', EVERYTHING, { location: 2 })).toBe('\x1b[57450;1:3u');
        // Caps lock is a functional key in the spec's table, not one of the six sided ones.
        expect(press('CapsLock', EVERYTHING)).toBe('\x1b[57358u');
    });

    it('reports modifier keys without event types too, as bare presses', () => {
        const allKeysOnly = KITTY_DISAMBIGUATE | KITTY_REPORT_ALL_KEYS;
        expect(press('Control', allKeysOnly, { ctrl: true, location: 1 })).toBe('\x1b[57442;5u');
        expect(release('Control', allKeysOnly, { location: 1 })).toBeNull();
    });

    it('still hands an unmodified arrow back, because DECCKM is the engine s to know', () => {
        expect(press('ArrowUp', EVERYTHING)).toBeNull();
        expect(press('ArrowUp', EVERYTHING, { ctrl: true })).toBe('\x1b[1;5A');
    });

    it('declines keys with no identity at all rather than inventing one', () => {
        expect(press('Dead', EVERYTHING)).toBeNull();
        expect(press('Unidentified', EVERYTHING)).toBeNull();
        expect(press('Process', EVERYTHING)).toBeNull();
        expect(press('MediaPlayPause', EVERYTHING)).toBeNull();
    });
});

describe('createKittyKeyboard', () => {
    it('writes the encoded bytes and reports whether the engine still owns the key', () => {
        const written: string[] = [];
        let flags = 0;
        const keyboard = createKittyKeyboard({
            flags: () => flags,
            write: (bytes) => written.push(decoder.decode(bytes))
        });

        expect(keyboard.active).toBe(false);
        expect(keyboard.key(event('keydown', 'Escape'))).toBe(false);
        expect(written).toEqual([]);

        flags = WITH_EVENTS;
        expect(keyboard.active).toBe(true);
        expect(keyboard.key(event('keydown', 'Escape'))).toBe(true);
        expect(keyboard.key(event('keyup', 'Escape'))).toBe(true);
        // Plain typing is still the engine's, even with the protocol on.
        expect(keyboard.key(event('keydown', 'a'))).toBe(false);
        expect(written).toEqual(['\x1b[27u', '\x1b[27;1:3u']);

        // The getter is read per event, so a pop mid-session takes effect immediately.
        flags = 0;
        expect(keyboard.active).toBe(false);
        expect(keyboard.key(event('keydown', 'Escape'))).toBe(false);
        expect(written).toHaveLength(2);
    });
});
