/**
 * KeyTrigger parsing / serialization for `~/.config/kelpi/config`.
 * Spec: docs/config-keybindings.md §3.
 *
 * Key identity is the macOS virtual keyCode (physical key). The config file stays the
 * canonical storage format; clients match it against `KeyboardEvent.code`.
 */

export type KeyModifier = 'ctrl' | 'alt' | 'shift' | 'super';

/** Fixed serialization order (§3.3). */
export const MODIFIER_ORDER: readonly KeyModifier[] = ['ctrl', 'alt', 'shift', 'super'];

export interface KeyTrigger {
    readonly keyCode: number;
    /** Deduped, always in MODIFIER_ORDER. */
    readonly modifiers: readonly KeyModifier[];
}

const MODIFIER_ALIASES: ReadonlyMap<string, KeyModifier> = new Map([
    ['super', 'super'],
    ['cmd', 'super'],
    ['command', 'super'],
    ['ctrl', 'ctrl'],
    ['control', 'ctrl'],
    ['alt', 'alt'],
    ['opt', 'alt'],
    ['option', 'alt'],
    ['shift', 'shift']
]);

/** §3.4 - every spelling the parser accepts. */
export const KEY_NAME_TO_CODE: ReadonlyMap<string, number> = new Map([
    ['a', 0], ['b', 11], ['c', 8], ['d', 2], ['e', 14], ['f', 3], ['g', 5], ['h', 4],
    ['i', 34], ['j', 38], ['k', 40], ['l', 37], ['m', 46], ['n', 45], ['o', 31], ['p', 35],
    ['q', 12], ['r', 15], ['s', 1], ['t', 17], ['u', 32], ['v', 9], ['w', 13], ['x', 7],
    ['y', 16], ['z', 6],
    ['1', 18], ['one', 18], ['2', 19], ['two', 19], ['3', 20], ['three', 20],
    ['4', 21], ['four', 21], ['5', 23], ['five', 23], ['6', 22], ['six', 22],
    ['7', 26], ['seven', 26], ['8', 28], ['eight', 28], ['9', 25], ['nine', 25],
    ['0', 29], ['zero', 29],
    ['return', 36], ['enter', 36], ['tab', 48], ['escape', 53], ['esc', 53], ['space', 49],
    ['delete', 51], ['backspace', 51], ['forward_delete', 117],
    ['left', 123], ['right', 124], ['down', 125], ['up', 126],
    ['[', 33], ['open_bracket', 33], [']', 30], ['close_bracket', 30],
    ['semicolon', 41], ['quote', 39], ['backquote', 50], ['grave', 50],
    ['comma', 43], ['period', 47], ['slash', 44], ['backslash', 42],
    ['-', 27], ['minus', 27], ['=', 24], ['equal', 24], ['equals', 24],
    ['f1', 122], ['f2', 120], ['f3', 99], ['f4', 118], ['f5', 96], ['f6', 97],
    ['f7', 98], ['f8', 100], ['f9', 101], ['f10', 109], ['f11', 103], ['f12', 111]
]);

/**
 * §3.3 - the writer's canonical names. Note the deliberate asymmetry with the parse
 * table: `;` `'` `` ` `` `,` `.` `/` `\` serialize as characters the parser does NOT
 * accept (it only knows `semicolon`, `quote`, …), so those triggers do not survive a
 * write→read round-trip. Quirk preserved from the Swift app.
 */
export const KEY_CODE_TO_CONFIG_NAME: ReadonlyMap<number, string> = new Map([
    [0, 'a'], [11, 'b'], [8, 'c'], [2, 'd'], [14, 'e'], [3, 'f'], [5, 'g'], [4, 'h'],
    [34, 'i'], [38, 'j'], [40, 'k'], [37, 'l'], [46, 'm'], [45, 'n'], [31, 'o'], [35, 'p'],
    [12, 'q'], [15, 'r'], [1, 's'], [17, 't'], [32, 'u'], [9, 'v'], [13, 'w'], [7, 'x'],
    [16, 'y'], [6, 'z'],
    [18, '1'], [19, '2'], [20, '3'], [21, '4'], [23, '5'], [22, '6'], [26, '7'], [28, '8'],
    [25, '9'], [29, '0'],
    [36, 'return'], [48, 'tab'], [53, 'escape'], [51, 'delete'], [49, 'space'],
    [117, 'forward_delete'],
    [123, 'left'], [124, 'right'], [125, 'down'], [126, 'up'],
    [33, '['], [30, ']'], [41, ';'], [39, "'"], [50, '`'], [43, ','], [47, '.'],
    [44, '/'], [42, '\\'], [27, '-'], [24, '='],
    [122, 'f1'], [120, 'f2'], [99, 'f3'], [118, 'f4'], [96, 'f5'], [97, 'f6'],
    [98, 'f7'], [100, 'f8'], [101, 'f9'], [109, 'f10'], [103, 'f11'], [111, 'f12']
]);

/** Serialized name for an unmapped keyCode; will not re-parse (§3.3). */
export const UNKNOWN_KEY_NAME = 'unknown';

/**
 * §3.3 display half: the macOS symbol per modifier, in **display** order `⌃ ⌥ ⇧ ⌘`. That
 * is a different contract from `MODIFIER_ORDER` (the config-file serialization order) even
 * though the two sequences happen to coincide, so it is spelled separately rather than
 * aliased — a change to one must not silently move the other.
 */
export const MODIFIER_DISPLAY_ORDER: readonly KeyModifier[] = ['ctrl', 'alt', 'shift', 'super'];

export const MODIFIER_SYMBOLS: Readonly<Record<KeyModifier, string>> = {
    ctrl: '⌃',
    alt: '⌥',
    shift: '⇧',
    super: '⌘'
};

/** Shown for a keyCode with no display name (§3.3). */
export const UNKNOWN_KEY_DISPLAY = '?';

/**
 * §3.3 — keyCode → the string a menu or hint shows. Letters/digits/punctuation are the
 * config name uppercased (so `a` → `A`, `[` → `[`); the non-printing keys get the doc's
 * verbatim names (`Return`, `Tab`, `Esc`, `Delete`, `Space`, `Fwd Del`, the arrow glyphs,
 * `F1`…`F12`), which is why they are listed AFTER the derived rows and win the collision.
 */
export const KEY_CODE_TO_DISPLAY_NAME: ReadonlyMap<number, string> = new Map<number, string>([
    ...[...KEY_CODE_TO_CONFIG_NAME].map(([code, name]): [number, string] => [code, name.toUpperCase()]),
    [36, 'Return'], [48, 'Tab'], [53, 'Esc'], [51, 'Delete'], [49, 'Space'],
    [117, 'Fwd Del'],
    [123, '←'], [124, '→'], [125, '↓'], [126, '↑'],
    [122, 'F1'], [120, 'F2'], [99, 'F3'], [118, 'F4'], [96, 'F5'], [97, 'F6'],
    [98, 'F7'], [100, 'F8'], [101, 'F9'], [109, 'F10'], [103, 'F11'], [111, 'F12']
]);

/**
 * `displayString` (§3.3): modifier symbols concatenated in `⌃⌥⇧⌘` order with no separator,
 * then the key's display name — `⌘⇧D`, `⌃⌥Space`. An unmapped keyCode renders `?`.
 */
export function keyTriggerDisplayString(trigger: KeyTrigger): string {
    const present = new Set(trigger.modifiers);
    const symbols = MODIFIER_DISPLAY_ORDER.filter((mod) => present.has(mod))
        .map((mod) => MODIFIER_SYMBOLS[mod])
        .join('');
    return symbols + (KEY_CODE_TO_DISPLAY_NAME.get(trigger.keyCode) ?? UNKNOWN_KEY_DISPLAY);
}

export function makeKeyTrigger(keyCode: number, modifiers: Iterable<KeyModifier>): KeyTrigger {
    const present = new Set(modifiers);
    return { keyCode, modifiers: MODIFIER_ORDER.filter((mod) => present.has(mod)) };
}

// ── platform semantics (§3.5) ───────────────────────────────────────────────────────

/**
 * Whether a client platform string names a mac-shaped platform. Only the platforms known to
 * chord on Ctrl (Windows, Linux, the BSDs) answer false; the empty and unknown strings a
 * test DOM reports keep the mac semantics every existing fixture was written against.
 */
export function macLikePlatform(platform: string): boolean {
    return !/^(win|linux|freebsd|openbsd|netbsd)/i.test(platform);
}

/**
 * `super` is the PRIMARY chord modifier, not a physical key: ⌘ on macOS, Ctrl on Windows and
 * Linux — the rule the shell's Electron accelerators have always applied
 * (`acceleratorForTrigger` spells `super` as `CommandOrControl`). Matching gets the same rule
 * through this canonicalization: off-mac a trigger's `super` is rewritten to `ctrl` before
 * the map is keyed, so `super+d=split_right` fires on Ctrl+D there, one config file works on
 * every platform, and the physical Super/Win key (which the OS largely owns) matches nothing.
 */
export function canonicalTriggerForPlatform(trigger: KeyTrigger, macLike: boolean): KeyTrigger {
    if (macLike || !trigger.modifiers.includes('super')) return trigger;
    return makeKeyTrigger(
        trigger.keyCode,
        trigger.modifiers.map((mod) => (mod === 'super' ? 'ctrl' : mod))
    );
}

/** §3.5 display half: the text names Ctrl-primary platforms spell chords with. */
export const MODIFIER_TEXT_NAMES: Readonly<Record<KeyModifier, string>> = {
    ctrl: 'Ctrl',
    alt: 'Alt',
    shift: 'Shift',
    super: 'Super'
};

/**
 * `displayString`, per platform: the mac glyph form (`⌘⇧D`) on macLike, the text form
 * Ctrl-primary platforms expect (`Ctrl+Shift+D`, `+`-joined in `MODIFIER_DISPLAY_ORDER`)
 * otherwise.
 */
export function keyTriggerDisplayStringForPlatform(trigger: KeyTrigger, macLike: boolean): string {
    if (macLike) return keyTriggerDisplayString(trigger);
    const present = new Set(trigger.modifiers);
    const parts = MODIFIER_DISPLAY_ORDER.filter((mod) => present.has(mod)).map(
        (mod) => MODIFIER_TEXT_NAMES[mod]
    );
    parts.push(KEY_CODE_TO_DISPLAY_NAME.get(trigger.keyCode) ?? UNKNOWN_KEY_DISPLAY);
    return parts.join('+');
}

/**
 * `KeyTrigger.parse` (§3.2): lowercase, split on `+` dropping empty parts, last part is
 * the key, the rest are modifiers. Unknown key or modifier → null. Zero-modifier
 * triggers are legal from the file (`escape=close_search` is a shipped default).
 */
export function parseKeyTrigger(input: string): KeyTrigger | null {
    const parts = input.toLowerCase().split('+').filter((part) => part.length > 0);
    const keyName = parts.at(-1);
    if (keyName === undefined) return null;
    const keyCode = KEY_NAME_TO_CODE.get(keyName);
    if (keyCode === undefined) return null;
    const modifiers: KeyModifier[] = [];
    for (const name of parts.slice(0, -1)) {
        const modifier = MODIFIER_ALIASES.get(name);
        if (modifier === undefined) return null;
        modifiers.push(modifier);
    }
    return makeKeyTrigger(keyCode, modifiers);
}

/** `configString` (§3.3): modifiers in ctrl, alt, shift, super order, then the key name. */
export function keyTriggerConfigString(trigger: KeyTrigger): string {
    const present = new Set(trigger.modifiers);
    const parts = MODIFIER_ORDER.filter((mod) => present.has(mod)) as string[];
    parts.push(KEY_CODE_TO_CONFIG_NAME.get(trigger.keyCode) ?? UNKNOWN_KEY_NAME);
    return parts.join('+');
}

/**
 * Stable map identity: `(keyCode, modifier bits)`. Unlike `configString` it never
 * collides for unmapped key codes.
 */
export function keyTriggerKey(trigger: KeyTrigger): string {
    const present = new Set(trigger.modifiers);
    const bits = MODIFIER_ORDER.reduce(
        (acc, mod, index) => (present.has(mod) ? acc | (1 << index) : acc),
        0
    );
    return `${trigger.keyCode}/${bits}`;
}

export function keyTriggersEqual(a: KeyTrigger, b: KeyTrigger): boolean {
    return keyTriggerKey(a) === keyTriggerKey(b);
}
