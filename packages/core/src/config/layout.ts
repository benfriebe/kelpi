/**
 * Which physical key a chord is matched as, on any keyboard layout (#245).
 * Spec: docs/config-keybindings.md §3.1.
 *
 * Triggers name macOS key codes, which are PHYSICAL keys, and every client matches them against
 * `KeyboardEvent.code`. That is right for a letter, a digit or `[` / `]` (the pane-focus brackets
 * are about where the key is), and wrong for a chord a person reads as a punctuation character:
 * on a German layout `+` is the `BracketRight` key and `-` is the `Slash` key, so ⌘+ used to
 * focus the next pane and ⌘- opened Help.
 *
 * So a key in a punctuation position is matched by the CHARACTER it typed when that character is
 * one of the character keys' own, translated to the US keystroke that types it (`+` is ⇧=). The
 * map's vocabulary does not change: a German ⌘+ arrives as `shift+super+=`, which is the shipped
 * twin of `super+=`. Everything else keeps its physical key, which is also the answer whenever
 * the character and the position agree, so a US keyboard is matched exactly as before.
 *
 * Keyed by DOM `code` strings rather than macOS key codes because three places need it before
 * any trigger exists: the client's dispatcher, the shell's web-page relay (Electron `Input`) and
 * the ES5 script injected into a preview frame, which receives {@link CHARACTER_KEYSTROKES} and
 * {@link CHARACTER_CHORD_SOURCE_CODES} as JSON.
 */

/** Physical keys whose character decides the chord. Letters, digits and named keys never do. */
export const CHARACTER_CHORD_SOURCE_CODES: readonly string[] = [
    'Equal',
    'Minus',
    'BracketLeft',
    'BracketRight',
    'Semicolon',
    'Quote',
    'Backquote',
    'Comma',
    'Period',
    'Slash',
    'Backslash'
];

/**
 * Character → the US keystroke that types it, for the CHARACTER keys only.
 *
 * `[` `]` `{` `}` are absent on purpose: a bracket chord is positional (it names where the key
 * is, beside its pair), so a layout that types `[` somewhere else does not move it. Letters and
 * digits are absent for the reason above, and because the AZERTY digit row types `&` `é` `"`
 * and still has to switch workspaces.
 */
export const CHARACTER_KEYSTROKES: Readonly<Record<string, { readonly code: string; readonly shift: boolean }>> = {
    '=': { code: 'Equal', shift: false },
    '+': { code: 'Equal', shift: true },
    '-': { code: 'Minus', shift: false },
    _: { code: 'Minus', shift: true },
    ';': { code: 'Semicolon', shift: false },
    ':': { code: 'Semicolon', shift: true },
    "'": { code: 'Quote', shift: false },
    '"': { code: 'Quote', shift: true },
    '`': { code: 'Backquote', shift: false },
    '~': { code: 'Backquote', shift: true },
    ',': { code: 'Comma', shift: false },
    '<': { code: 'Comma', shift: true },
    '.': { code: 'Period', shift: false },
    '>': { code: 'Period', shift: true },
    '/': { code: 'Slash', shift: false },
    '?': { code: 'Slash', shift: true },
    '\\': { code: 'Backslash', shift: false },
    '|': { code: 'Backslash', shift: true }
};

const SOURCE_CODES: ReadonlySet<string> = new Set(CHARACTER_CHORD_SOURCE_CODES);

/** The part of a key event this module reads. `key` is optional: a replayed chord has none. */
export interface ChordKeyEventLike {
    readonly code: string;
    readonly key?: string | undefined;
    readonly altKey?: boolean | undefined;
    readonly shiftKey?: boolean | undefined;
}

/** The physical key and Shift state a chord is matched as. */
export interface ChordKeyIdentity {
    readonly code: string;
    readonly shiftKey: boolean;
}

/**
 * The US keystroke a character chord stands for, or null when the physical key decides.
 *
 * Null unless all of these hold: the key is in a punctuation position, ⌥ is not held (⌥, and
 * AltGr which is ⌃⌥ off mac, picks another character layer, so translating its character and
 * also keeping the held ⌥ would count the modifier twice), the key typed one character of
 * {@link CHARACTER_KEYSTROKES}, and that character's US key is a DIFFERENT key. The last rule is
 * what leaves a US keyboard alone, held Shift included.
 */
export function characterChordKeystroke(event: ChordKeyEventLike): { readonly code: string; readonly shift: boolean } | null {
    if (event.altKey === true) return null;
    if (!SOURCE_CODES.has(event.code)) return null;
    const key = event.key;
    if (typeof key !== 'string' || key.length !== 1) return null;
    const stroke = Object.prototype.hasOwnProperty.call(CHARACTER_KEYSTROKES, key) ? CHARACTER_KEYSTROKES[key] : undefined;
    if (stroke === undefined || stroke.code === event.code) return null;
    return stroke;
}

/**
 * The key a chord is matched as: the US keystroke for a character chord (with that keystroke's
 * own Shift, since the layout spent the held one choosing the character), else the physical key
 * with Shift as held.
 */
export function chordKeyIdentity(event: ChordKeyEventLike): ChordKeyIdentity {
    const stroke = characterChordKeystroke(event);
    if (stroke !== null) return { code: stroke.code, shiftKey: stroke.shift };
    return { code: event.code, shiftKey: event.shiftKey === true };
}
