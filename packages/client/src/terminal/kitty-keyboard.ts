/**
 * The kitty keyboard protocol, encoded in the PORT'S layer rather than the engine's.
 *
 * Why this file exists (../kelpi-docs/capabilities/01 §TERM-030): `ghostty-web 0.4.0-nex.2` registers
 * **one** `keydown` listener and **zero** `keyup` listeners, and its `setKittyFlags` has no call
 * site anywhere in the bundle. A protocol whose entire subject is press / repeat / **release**
 * cannot be implemented by a layer that never sees a release, so the port does what it did for
 * DEC mouse reporting two waves ago (`./mouse.ts`, §TERM-037): the daemon negotiates the flags
 * off the VT stream it already parses (`daemon/src/term/kitty-keyboard.ts`) and streams them as
 * pane state, the pane intercepts key events in the CAPTURE phase before the engine's own
 * listener can see them, and this module turns them into bytes. Nothing here knows which
 * renderer is underneath.
 *
 * **The legacy path must stay byte-identical.** With `flags === 0` — every pane, all the time,
 * until an application asks — `encodeKittyKey` returns `null` for every event and nothing is
 * intercepted at all. Even with flags set, a key whose kitty encoding *is* its legacy encoding
 * is deliberately left to the engine rather than re-encoded here: an unmodified `ArrowUp` is
 * `CSI A` in both protocols, but only the engine knows whether DECCKM is on and it should be
 * `SS3 A`. Handing those back is what makes "turn the protocol on and plain typing still works"
 * true by construction instead of by test.
 *
 * **What is encoded, per the spec** (sw.kovidgoyal.net/kitty/keyboard-protocol):
 *
 *   `CSI number ; modifiers : event u`   the CSI u form; trailing defaults omitted
 *   `CSI number ; modifiers : event ~`   functional keys with a legacy `~` form (Delete, PgUp…)
 *   `CSI number ; modifiers : event A`   functional keys with a legacy letter form (arrows, F1…)
 *
 * modifiers = 1 + bitfield (shift 1, alt 2, ctrl 4, super 8); event = 1 press, 2 repeat,
 * 3 release. `modifiers` is written as `1` when it is default but the event type is not, which
 * is what makes a release of an unmodified arrow `CSI 1;1:3A`.
 *
 * **Three deliberate limits, each because a browser cannot supply what the flag needs:**
 *
 *   - **`report alternate keys` (0b100) is not supported**, and the daemon does not advertise
 *     it. The form wants `unicode-key-code:shifted-key-code:base-layout-key-code` — the key's
 *     *unshifted* codepoint on the current layout, plus the codepoint the same physical key
 *     carries on a US layout. A `KeyboardEvent` gives exactly one produced `key` and a physical
 *     `code` whose meaning is layout-dependent; deriving the other two means hard-coding a US
 *     layout table, which is the assumption PLAN.md decision 14 exists to refuse.
 *   - **`report associated text` (0b10000) is not supported** for the same reason in reverse:
 *     the text a key produces is the browser's `key`, and under composition it is not produced
 *     by a key event at all (see the IME rule below).
 *   - **The lock modifiers (caps lock 64, num lock 128) are not reported.** The spec has bits
 *     for them, but the browser exposes lock *state*, not a modifier the user is holding, and
 *     folding state into the modifier field would change the bytes of every otherwise-unmodified
 *     key for anyone with caps lock on — including the ones this module hands back to the engine
 *     precisely because their encoding is unchanged. Applications mask the modifier field, so an
 *     unreported bit costs nothing; a wrongly-reported one costs the legacy guarantee.
 *
 * One divergence worth naming rather than burying: for a **shifted punctuation** key the
 * `unicode-key-code` this module reports is the *produced* glyph lowercased (`ctrl+@` → 64), not
 * the layout's unshifted key (kitty would say 50, the `2` under it). Letters are exact —
 * `ctrl+shift+A` is `CSI 97;6u` — because lowercasing a letter inverts shift. Punctuation is
 * not invertible without the layout table this module refuses to assume, and it is the same
 * missing identity that keeps `report alternate keys` unadvertised.
 *
 * **IME.** Composition must bypass this module completely: a composed string is committed by
 * `compositionend`, not by a key event, and encoding the keydowns that drive an IME would both
 * double-write the text and hand the application key codes for keystrokes that were never keys.
 * The guard lives at the call site (`TerminalPane`), which is where `isComposing` and the
 * `compositionstart`/`compositionend` window are observable.
 */

/** Report `Esc`, `ctrl+key`, `alt+key` and the keypad unambiguously as `CSI … u`. */
export const KITTY_DISAMBIGUATE = 0b1;
/** Report press / repeat / release as the `:1` / `:2` / `:3` event-type sub-parameter. */
export const KITTY_REPORT_EVENT_TYPES = 0b10;
/** Report every key as an escape code, text-producing keys included. */
export const KITTY_REPORT_ALL_KEYS = 0b1000;

/** What this port implements exactly; the daemon masks to the same set before storing. */
export const SUPPORTED_KITTY_FLAGS =
    KITTY_DISAMBIGUATE | KITTY_REPORT_EVENT_TYPES | KITTY_REPORT_ALL_KEYS;

export const KITTY_MOD_SHIFT = 0b1;
export const KITTY_MOD_ALT = 0b10;
export const KITTY_MOD_CTRL = 0b100;
export const KITTY_MOD_SUPER = 0b1000;

/** 1 press, 2 repeat, 3 release. */
export type KittyEventType = 1 | 2 | 3;

/**
 * The surface of a `KeyboardEvent` this module reads — structural, so a test needs no DOM.
 *
 * `key` and `code` are the browser's own: `key` is what the key produced (layout applied),
 * `code` is the physical position. Both are needed — `key` carries the identity the protocol
 * reports, `code` is the only way to tell a keypad key from its main-block twin.
 */
export interface KittyKeyEventLike {
    readonly type: 'keydown' | 'keyup';
    readonly key: string;
    readonly code?: string | undefined;
    /** `KeyboardEvent.location`: 1 left, 2 right, 3 numpad. Anything else reads as left. */
    readonly location?: number | undefined;
    readonly repeat?: boolean | undefined;
    readonly shiftKey?: boolean | undefined;
    readonly altKey?: boolean | undefined;
    readonly ctrlKey?: boolean | undefined;
    readonly metaKey?: boolean | undefined;
}

/** A resolved key: the number the protocol puts in the first parameter, and the final byte. */
export interface KittyKeyForm {
    readonly number: number;
    /** `u` for CSI u keys, `~` or a letter for keys with a legacy CSI form. */
    readonly final: string;
}

const ESC = 0x1b;

/**
 * Functional keys, by `KeyboardEvent.key`, from the spec's own table.
 *
 * The `u`-final entries have no legacy encoding worth preserving (or, for Enter / Tab /
 * Backspace, one that this module hands back when there are no modifiers). The `~`- and
 * letter-final entries keep their legacy CSI forms, which is what the spec means by keeping
 * backwards compatibility for keys that were never ambiguous.
 */
export const KITTY_FUNCTIONAL_KEYS: ReadonlyMap<string, KittyKeyForm> = new Map<string, KittyKeyForm>([
    ['Escape', { number: 27, final: 'u' }],
    ['Enter', { number: 13, final: 'u' }],
    ['Tab', { number: 9, final: 'u' }],
    ['Backspace', { number: 127, final: 'u' }],
    ['Insert', { number: 2, final: '~' }],
    ['Delete', { number: 3, final: '~' }],
    ['ArrowLeft', { number: 1, final: 'D' }],
    ['ArrowRight', { number: 1, final: 'C' }],
    ['ArrowUp', { number: 1, final: 'A' }],
    ['ArrowDown', { number: 1, final: 'B' }],
    ['PageUp', { number: 5, final: '~' }],
    ['PageDown', { number: 6, final: '~' }],
    ['Home', { number: 1, final: 'H' }],
    ['End', { number: 1, final: 'F' }],
    ['CapsLock', { number: 57358, final: 'u' }],
    ['ScrollLock', { number: 57359, final: 'u' }],
    ['NumLock', { number: 57360, final: 'u' }],
    ['PrintScreen', { number: 57361, final: 'u' }],
    ['Pause', { number: 57362, final: 'u' }],
    ['ContextMenu', { number: 57363, final: 'u' }],
    // F3 is `CSI 13 ~` rather than `CSI R`, because `CSI R` is the cursor-position report.
    ['F1', { number: 1, final: 'P' }],
    ['F2', { number: 1, final: 'Q' }],
    ['F3', { number: 13, final: '~' }],
    ['F4', { number: 1, final: 'S' }],
    ['F5', { number: 15, final: '~' }],
    ['F6', { number: 17, final: '~' }],
    ['F7', { number: 18, final: '~' }],
    ['F8', { number: 19, final: '~' }],
    ['F9', { number: 20, final: '~' }],
    ['F10', { number: 21, final: '~' }],
    ['F11', { number: 23, final: '~' }],
    ['F12', { number: 24, final: '~' }]
]);

/** F13…F35 are a contiguous run in the protocol's private-use block. */
const F13_CODEPOINT = 57376;
const HIGHEST_FUNCTION_KEY = 35;

/**
 * Keypad keys, by `KeyboardEvent.code` — the whole point of the disambiguation flag's keypad
 * clause is that `Numpad5` is a DIFFERENT key from `Digit5`, and `code` is the only field that
 * says so.
 */
export const KITTY_KEYPAD_BY_CODE: ReadonlyMap<string, number> = new Map<string, number>([
    ['Numpad0', 57399],
    ['Numpad1', 57400],
    ['Numpad2', 57401],
    ['Numpad3', 57402],
    ['Numpad4', 57403],
    ['Numpad5', 57404],
    ['Numpad6', 57405],
    ['Numpad7', 57406],
    ['Numpad8', 57407],
    ['Numpad9', 57408],
    ['NumpadDecimal', 57409],
    ['NumpadDivide', 57410],
    ['NumpadMultiply', 57411],
    ['NumpadSubtract', 57412],
    ['NumpadAdd', 57413],
    ['NumpadEnter', 57414],
    ['NumpadEqual', 57415],
    ['NumpadComma', 57416]
]);

/**
 * The same physical keypad keys with num lock OFF, where the browser reports the NAVIGATION key
 * they produce. Keyed on `key` and only consulted for a `Numpad*` code, so `Home` on the main
 * block is unaffected.
 */
export const KITTY_KEYPAD_BY_KEY: ReadonlyMap<string, number> = new Map<string, number>([
    ['ArrowLeft', 57417],
    ['ArrowRight', 57418],
    ['ArrowUp', 57419],
    ['ArrowDown', 57420],
    ['PageUp', 57421],
    ['PageDown', 57422],
    ['Home', 57423],
    ['End', 57424],
    ['Insert', 57425],
    ['Delete', 57426],
    ['Clear', 57427]
]);

/**
 * Modifier keys themselves — the item this whole file exists for.
 *
 * §TERM-030's Swift counterpart is `flagsChanged`, which "maps caps/shift/ctrl/alt/super
 * keycodes to press/release and distinguishes left vs right via the device-side mask bits".
 * `KeyboardEvent.location` is the browser's device-side mask bit, and these are the codepoints
 * the protocol reserves for each side. (Caps lock is not here: the spec puts it in the
 * functional table at 57358, and so does `KITTY_FUNCTIONAL_KEYS` above.)
 */
export const KITTY_MODIFIER_KEYS: ReadonlyMap<string, readonly [number, number]> = new Map<
    string,
    readonly [number, number]
>([
    ['Shift', [57441, 57447]],
    ['Control', [57442, 57448]],
    ['Alt', [57443, 57449]],
    ['Meta', [57444, 57450]],
    ['Hyper', [57445, 57451]],
    ['AltGraph', [57453, 57453]]
]);

/** The modifier bitfield (NOT the `1 +` wire value). Lock modifiers are deliberately absent. */
export function kittyModifiers(event: KittyKeyEventLike): number {
    let mods = 0;
    if (event.shiftKey === true) mods |= KITTY_MOD_SHIFT;
    // Ghostty's "alt" is the Option key; the browser's `metaKey` is ⌘, which the protocol calls
    // super. A ⌘ chord only reaches this module when the app's own dispatcher declined it.
    if (event.altKey === true) mods |= KITTY_MOD_ALT;
    if (event.ctrlKey === true) mods |= KITTY_MOD_CTRL;
    if (event.metaKey === true) mods |= KITTY_MOD_SUPER;
    return mods;
}

/** F13…F35 → its codepoint, or null for anything else. */
function highFunctionKey(key: string): number | null {
    if (key.length < 2 || key[0] !== 'F') return null;
    const index = Number(key.slice(1));
    if (!Number.isInteger(index) || index < 13 || index > HIGHEST_FUNCTION_KEY) return null;
    return F13_CODEPOINT + (index - 13);
}

/** One Unicode scalar, or null — `'a'` yes, `'Enter'` no, an astral glyph yes. */
function singleCodepoint(key: string): number | null {
    const points = [...key];
    if (points.length !== 1) return null;
    return points[0]?.codePointAt(0) ?? null;
}

/**
 * The codepoint the protocol reports for a text key: the key lowercased, so `shift+A` is
 * `a` + the shift bit rather than a second identity for the same physical key.
 *
 * A lowercase mapping that expands to more than one scalar (there are a few) keeps the
 * original, because a multi-scalar "codepoint" is not a thing the protocol can carry.
 */
export function kittyTextCodepoint(key: string): number | null {
    const direct = singleCodepoint(key);
    if (direct === null) return null;
    const lowered = singleCodepoint(key.toLowerCase());
    return lowered ?? direct;
}

function isKeypadEvent(event: KittyKeyEventLike): boolean {
    return event.location === 3 || (event.code ?? '').startsWith('Numpad');
}

/** Serialise a resolved key. Trailing default parameters are omitted, as the spec requires. */
export function kittySequence(form: KittyKeyForm, mods: number, eventType: KittyEventType): Uint8Array {
    const modParam = mods + 1;
    const needsSuffix = modParam !== 1 || eventType !== 1;
    const params: string[] = [];
    // A letter-final key with no second parameter collapses to `CSI A`; every other form keeps
    // its number, because `CSI ~` and `CSI u` mean nothing without one.
    if (needsSuffix || form.final === 'u' || form.final === '~') params.push(String(form.number));
    if (needsSuffix) {
        params.push(eventType === 1 ? String(modParam) : `${String(modParam)}:${String(eventType)}`);
    }
    const text = `[${params.join(';')}${form.final}`;
    const out = new Uint8Array(text.length + 1);
    out[0] = ESC;
    for (let index = 0; index < text.length; index += 1) out[index + 1] = text.charCodeAt(index) & 0xff;
    return out;
}

/**
 * One key event → the bytes a kitty-protocol application expects, or **null** when this event
 * is not ours: the protocol is off, the flags do not cover it, or its legacy encoding is
 * already correct and the engine should produce it.
 *
 * `null` is not a failure. It is the byte-identity guarantee: every `null` leaves the event
 * untouched, so the engine encodes it exactly as it did before this file existed.
 */
export function encodeKittyKey(event: KittyKeyEventLike, rawFlags: number): Uint8Array | null {
    const flags = sanitizeKittyFlags(rawFlags);
    if (flags === 0) return null;

    const reportEvents = (flags & KITTY_REPORT_EVENT_TYPES) !== 0;
    const allKeys = (flags & KITTY_REPORT_ALL_KEYS) !== 0;
    // `report all keys` implies disambiguation: if every key is an escape code, none of them
    // can still be an ambiguous legacy byte.
    const disambiguate = (flags & KITTY_DISAMBIGUATE) !== 0 || allKeys;

    const release = event.type === 'keyup';
    // Without `report event types` there is no release event in the protocol at all, and a
    // repeat is indistinguishable from a press.
    if (release && !reportEvents) return null;
    const eventType: KittyEventType = release ? 3 : event.repeat === true && reportEvents ? 2 : 1;

    const mods = kittyModifiers(event);
    /** Any modifier at all — what decides whether Enter / Tab / Backspace keep their C0 byte. */
    const chorded = mods !== 0;
    /** ctrl / alt / super — the modifiers that stop a key from producing text. */
    const nonText = (mods & (KITTY_MOD_ALT | KITTY_MOD_CTRL | KITTY_MOD_SUPER)) !== 0;

    // ── the modifier keys themselves (§TERM-030's subject) ──────────────────────────
    const sides = KITTY_MODIFIER_KEYS.get(event.key);
    if (sides !== undefined) {
        // Only `report all keys` asks for these: they produce no text and have no legacy
        // encoding, so an application that merely wanted disambiguation would be surprised by a
        // burst of escape codes every time the user reached for ctrl.
        if (!allKeys) return null;
        const number = event.location === 2 ? sides[1] : sides[0];
        return kittySequence({ number, final: 'u' }, mods, eventType);
    }

    // ── the keypad, which disambiguation splits from the main block ─────────────────
    if (isKeypadEvent(event)) {
        const byCode = KITTY_KEYPAD_BY_CODE.get(event.code ?? '');
        const byKey = KITTY_KEYPAD_BY_KEY.get(event.key);
        const number = byKey ?? byCode;
        if (number !== undefined) {
            if (!disambiguate) return null;
            return kittySequence({ number, final: 'u' }, mods, eventType);
        }
        // An unknown keypad code falls through to the tables below rather than being dropped.
    }

    // ── functional keys ─────────────────────────────────────────────────────────────
    const high = highFunctionKey(event.key);
    const form = high === null ? KITTY_FUNCTIONAL_KEYS.get(event.key) : { number: high, final: 'u' };
    if (form !== undefined) {
        if (form.final === 'u') {
            // Escape, Enter, Tab, Backspace, the lock keys and F13+. All of these are the CSI u
            // form only once the protocol says escape codes are unambiguous.
            if (!disambiguate) return null;
            // Enter / Tab / Backspace keep their C0 bytes when nothing is held: that is the
            // spec's backwards-compatibility clause, and it is why turning on disambiguation
            // does not break every line-oriented program in existence. `report all keys`
            // overrides it, because that flag's whole point is that nothing stays legacy.
            if (!allKeys && !chorded && LEGACY_CONTROL_KEYS.has(event.key)) return null;
            return kittySequence(form, mods, eventType);
        }
        // A legacy-form key (arrows, F1–F12, Home/End, Insert/Delete, PgUp/PgDn) with no
        // modifiers and no event type to report encodes IDENTICALLY in both protocols — except
        // that only the engine knows whether DECCKM is on and `ArrowUp` should be `SS3 A`. Hand
        // it back rather than guessing.
        if (mods === 0 && eventType === 1) return null;
        return kittySequence(form, mods, eventType);
    }

    // ── text-producing keys, and the chords that stop them producing text ───────────
    const codepoint = kittyTextCodepoint(event.key);
    if (codepoint === null) return null; // 'Dead', 'Process', 'Unidentified', media keys…
    if (!nonText) {
        // Plain typing (and shift+typing). The engine writes the text; under `report all keys`
        // there is no text, only the escape code.
        if (!allKeys) return null;
        return kittySequence({ number: codepoint, final: 'u' }, mods, eventType);
    }
    // ctrl+key / alt+key / super+key — the ambiguity the protocol exists to remove. `ctrl+i` is
    // `CSI 105;5u` here and 0x09 (indistinguishable from Tab) in the legacy encoding.
    if (!disambiguate) return null;
    return kittySequence({ number: codepoint, final: 'u' }, mods, eventType);
}

/** Keys whose unmodified legacy byte the spec keeps: Enter `\r`, Tab `\t`, Backspace `\x7f`. */
const LEGACY_CONTROL_KEYS: ReadonlySet<string> = new Set(['Enter', 'Tab', 'Backspace']);

/** Mask + guard, mirroring the daemon's. A malformed value reads as "protocol off". */
export function sanitizeKittyFlags(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value) || value < 0) return 0;
    return Math.trunc(value) & SUPPORTED_KITTY_FLAGS;
}

// ── the stateful side: one encoder per pane ─────────────────────────────────────────

export interface KittyKeyboardOptions {
    /** The pane's live flags, read through a getter so the handlers never go stale. */
    readonly flags: () => number;
    readonly write: (bytes: Uint8Array) => void;
}

export interface KittyKeyboard {
    /** True while an application has negotiated the protocol for this pane. */
    readonly active: boolean;
    /** Returns true when the event was CONSUMED — the engine must not also see it. */
    key(event: KittyKeyEventLike): boolean;
}

export function createKittyKeyboard(options: KittyKeyboardOptions): KittyKeyboard {
    return {
        get active(): boolean {
            return sanitizeKittyFlags(options.flags()) !== 0;
        },
        key(event: KittyKeyEventLike): boolean {
            const bytes = encodeKittyKey(event, options.flags());
            if (bytes === null) return false;
            options.write(bytes);
            return true;
        }
    };
}
