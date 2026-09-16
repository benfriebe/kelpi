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
 * **A fourth limit, and this one is a product decision rather than a browser one:** the five
 * macOS system-editing chords (⌘V, ⌘C, ⌘X, ⌘A, ⌘Z) are never encoded, at any flags. See
 * `isSystemEditingChord` for why, and for the trade Ghostty makes identically (#80).
 *
 * **A fifth, and it is a SETTING rather than a rule:** on macOS the ⌥ key either composes a
 * character or is the Alt modifier, and it cannot be both for one keystroke. `macos-option-as-alt`
 * decides which, defaulting to ghostty's own answer (compose). See {@link KittyOptionRule} for the
 * whole of it, and #171 for the report: ⌥⇧- reached Codex as `CSI 8212;4u` instead of an em dash.
 *
 * **A sixth, of the same kind as the fourth:** the five chords the PLATFORM owns (⌘H, ⌥⌘H,
 * ⌃⌘F, ⌘M, ⌘Q) are never encoded either. They are stated once, in `@kelpi/core/config` ▸
 * `PLATFORM_CHORDS`, so the shell's application menu and this encoder cannot disagree about the
 * set; see that module for what is in it and why, and `TerminalPane`'s interceptor for the other
 * half of handing them back, which is keeping the ENGINE from preventing their default (#95).
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

import { isPlatformChord } from '@kelpi/core/config';

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
    // Whether ⌥ is a modifier AT ALL is the caller's to say on macOS: see {@link KittyOptionRule}.
    if (event.altKey === true) mods |= KITTY_MOD_ALT;
    if (event.ctrlKey === true) mods |= KITTY_MOD_CTRL;
    if (event.metaKey === true) mods |= KITTY_MOD_SUPER;
    return mods;
}

/**
 * Who owns the ⌥ key on macOS: the LAYOUT or this encoder (`macos-option-as-alt`, #171).
 *
 * macOS composes a character from ⌥ the way no other platform does: ⌥⇧- is an em dash, ⌥8 is a
 * bullet, ⌥l is `@` on the German layout, and the browser hands that composed character over as
 * `KeyboardEvent.key` with `altKey` still true. There is no second reading of the key available
 * to a web client: Cocoa can re-translate the keystroke WITHOUT the option modifier and recover
 * the `b` under ⌥b, and a `KeyboardEvent` cannot. What arrives is the glyph, and the only
 * decision left is whether alt is reported alongside it.
 *
 * So this is a genuine either/or, which is why ghostty makes it a setting and why Kelpi copies
 * both the name and the default:
 *
 *   - **`optionAsAlt: false`** (the shipped default, ghostty's own): ⌥ alone is the layout's.
 *     A text key loses the alt bit, so the composed character is what the terminal receives.
 *     ⌥b / ⌥f / ⌥d stop being readline's meta-word chords.
 *   - **`optionAsAlt: true`**: alt is reported, beside whatever glyph the layout produced, and
 *     nothing is typed. That is what this module did before #171 and what every fixture written
 *     before it still asserts; it is NOT ghostty's `true`, which gets the unmodified letter back
 *     from Cocoa. All it promises is today's bytes.
 *
 * `macLike` is the platform read, passed in rather than sniffed here (`chrome/keys.ts` owns the
 * one read of `navigator.platform`). Off macOS the rule never applies: no layout composes from
 * Alt there, so an Alt bit that arrived is one the user meant.
 */
export interface KittyOptionRule {
    /** True: ⌥ is Alt (pre-#171 behaviour). False: ⌥ composes, and a text key drops the bit. */
    readonly optionAsAlt: boolean;
    /** Is this client mac-like? The rule is macOS-only. */
    readonly macLike: boolean;
}

/**
 * The rule an omitted argument means: ⌥ is Alt, exactly as this module read it before #171.
 *
 * Deliberately NOT the setting's default. The setting ships `false`, and the pane passes the
 * user's value on every call; this constant is what keeps a call that says nothing about ⌥
 * byte-identical to the one it was before the parameter existed.
 */
export const KITTY_OPTION_IS_ALT: KittyOptionRule = { optionAsAlt: true, macLike: false };

/**
 * Did the LAYOUT produce this key rather than the user reaching for a modifier? (#171)
 *
 * Four conditions, and each one is load-bearing:
 *
 *   - the rule says ⌥ composes, on a mac-like client;
 *   - alt is held, and **neither ctrl nor super is**. ⌃⌥ and ⌥⌘ chords are not composition on
 *     any layout, they are the chords they look like, and `isSystemEditingChord` /
 *     `isPlatformChord` upstream already depend on ⌥⌘H reaching them intact;
 *   - `key` is a single Unicode scalar. That is what "the layout produced a character" MEANS
 *     here: ⌥ArrowLeft is `'ArrowLeft'`, ⌥e is `'Dead'` mid-composition, and neither is text,
 *     so both keep their alt bit and their encoding. Arrow-key word motion under ⌥ is
 *     unaffected by this setting, which is a deliberate narrowing of ghostty's own rule.
 */
function optionComposed(event: KittyKeyEventLike, rule: KittyOptionRule): boolean {
    if (rule.optionAsAlt || !rule.macLike) return false;
    if (event.altKey !== true || event.ctrlKey === true || event.metaKey === true) return false;
    return singleCodepoint(event.key) !== null;
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
 * The five system-editing letters (#80). Lowercase, matched against the lowercased `key`.
 *
 * ⌘V, ⌘C, ⌘X, ⌘A, ⌘Z: paste, copy, cut, select-all, undo. Not ⌘W, ⌘Q, ⌘N or any other chord the
 * app or the OS already claims, because those never reach this encoder: the app's dispatcher
 * consumes a BOUND chord in the window capture phase long before the pane's listeners run
 * (`chrome/keys.ts` `installKeyDispatcher`, `TerminalPane.tsx`'s interceptor comment). This set
 * is exactly the chords that are bound nowhere and therefore arrive here every time.
 */
export const KITTY_SYSTEM_EDITING_KEYS: ReadonlySet<string> = new Set(['v', 'c', 'x', 'a', 'z']);

/**
 * Is this one of the chords Kelpi keeps for the layers below the interceptor (#80)?
 *
 * The kitty protocol has a super bit, so `⌘V` under `disambiguate` is a perfectly legal
 * `CSI 118;9u` and this module used to encode it. Encoding it is also the end of paste: the
 * interceptor `preventDefault()`s a consumed event, which kills BOTH fallbacks the port relies
 * on. The engine passes ⌘V and ⌘C through un-prevented so the browser's own `paste` / `copy`
 * fire (`vendor/ghostty-web-patched/source/lib/input-handler.ts:373-386`), and the shell's
 * `{ role: 'editMenu' }` is downstream of the page (`shell/src/main.ts`, `shell/src/menu.ts`).
 * The observable symptom is #80's: start Claude Code, which negotiates the protocol, and ⌘V
 * stops pasting until you exit it.
 *
 * So super chords in this set are handed back, and the cost is named rather than hidden: an
 * application that legitimately wants `CSI 118;9u` does not get it. Ghostty makes the same
 * trade on macOS: `super+v` / `super+c` are `paste_from_clipboard` / `copy_to_clipboard` in
 * its shipped macOS defaults (`src/config/Config.zig`, the `Keybinds.init` darwin block), and a
 * binding is consumed before the key encoder ever runs.
 *
 * **Only super.** A ctrl or alt chord is never exempt (`ctrl+c` is the interrupt, and
 * disambiguating `ctrl+i` from Tab is the flag's entire purpose). Shift is tolerated, since a
 * shifted system chord is still a system chord (⌘⇧Z is Redo), and the platform, not this
 * module, decides what it means.
 */
export function isSystemEditingChord(event: KittyKeyEventLike): boolean {
    if (event.metaKey !== true) return false;
    if (event.ctrlKey === true || event.altKey === true) return false;
    const key = event.key;
    // Single scalars only: `Meta`, `Dead` and every functional key are longer than one unit, and
    // an astral glyph is not in the set anyway.
    if (key.length !== 1) return false;
    return KITTY_SYSTEM_EDITING_KEYS.has(key.toLowerCase());
}

/**
 * One key event → the bytes a kitty-protocol application expects, or **null** when this event
 * is not ours: the protocol is off, the flags do not cover it, or its legacy encoding is
 * already correct and the engine should produce it.
 *
 * `null` is not a failure. It is the byte-identity guarantee: every `null` leaves the event
 * untouched, so the engine encodes it exactly as it did before this file existed.
 *
 * `option` is the ⌥ rule (#171); omitted, it is {@link KITTY_OPTION_IS_ALT}, the answer this
 * function gave before the parameter existed. The pane passes the user's setting.
 */
export function encodeKittyKey(
    event: KittyKeyEventLike,
    rawFlags: number,
    option: KittyOptionRule = KITTY_OPTION_IS_ALT
): Uint8Array | null {
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

    // ── the chords that are not this encoder's, before any table is consulted ───────
    //
    // Deliberately FIRST, so both rules cover every branch below rather than only the text-key
    // one: whatever either set grows to hold, the answer is the same null.
    //
    // Two sets, two owners. `isSystemEditingChord` (#80) is the editing family, handed to
    // fallbacks that live INSIDE the page. `isPlatformChord` (#95) is the five macOS
    // application- and window-level chords, handed to the native menu accelerator that answers
    // them - which only fires for a key the page did not consume, so an encoded ⌘H was the end
    // of Hide exactly as an encoded ⌘V was the end of paste.
    if (isSystemEditingChord(event)) return null;
    if (isPlatformChord(event)) return null;

    /** Any modifier at all — what decides whether Enter / Tab / Backspace keep their C0 byte. */
    const chorded = mods !== 0;
    /**
     * The modifiers a TEXT key is left holding (#171).
     *
     * Identical to `mods` except on macOS with `macos-option-as-alt` off, where a ⌥ that
     * composed a character was spent by the layout and is not a modifier any more. The narrowing
     * to text keys is why this is a second value rather than a change to `kittyModifiers`: the
     * modifier-key, keypad and functional branches below all keep the bit, so ⌥ArrowLeft is
     * still `CSI 1;3D` and ⌥Numpad5 is still `CSI 57404;3u` whatever this setting says.
     */
    const textMods = optionComposed(event, option) ? mods & ~KITTY_MOD_ALT : mods;
    /** ctrl / alt / super — the modifiers that stop a key from producing text. */
    const nonText = (textMods & (KITTY_MOD_ALT | KITTY_MOD_CTRL | KITTY_MOD_SUPER)) !== 0;

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
        // Plain typing (and shift+typing, and #171's ⌥-composed character, which is plain typing
        // the moment the layout rather than the encoder owns the ⌥). The engine writes the text;
        // under `report all keys` there is no text, only the escape code, and the ⌥ that was
        // spent composing is not reported there either.
        if (!allKeys) return null;
        return kittySequence({ number: codepoint, final: 'u' }, textMods, eventType);
    }
    // ctrl+key / alt+key / super+key — the ambiguity the protocol exists to remove. `ctrl+i` is
    // `CSI 105;5u` here and 0x09 (indistinguishable from Tab) in the legacy encoding.
    if (!disambiguate) return null;
    return kittySequence({ number: codepoint, final: 'u' }, textMods, eventType);
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
    /**
     * The ⌥ rule (#171), read through a getter for the same reason the flags are: a Settings
     * toggle must govern the very next keystroke, not the next pane. Omitted leaves ⌥ as Alt
     * ({@link KITTY_OPTION_IS_ALT}), which is what every caller written before #171 meant.
     */
    readonly option?: (() => KittyOptionRule) | undefined;
    /**
     * `release` is true for a `keyup` encoding (`CSI …:3u`). terminal-surface.md §8.2 mirrors
     * only the press that carries the input into sync siblings, so the pane host routes a
     * release down the un-mirrored path and everything else down the mirrored one (#51).
     */
    readonly write: (bytes: Uint8Array, release: boolean) => void;
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
            const bytes = encodeKittyKey(event, options.flags(), options.option?.() ?? KITTY_OPTION_IS_ALT);
            if (bytes === null) return false;
            options.write(bytes, event.type === 'keyup');
            return true;
        }
    };
}
